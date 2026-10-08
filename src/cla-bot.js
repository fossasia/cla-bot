/**
 *
 * A GitHub Action that checks every pull request for a signed CLA. Signatures
 * live in one shared private repo (fossasia/cla-signatures). There are no npm
 * dependencies, only Node's built-in `fetch` and `crypto`.
 *
 * Security properties. Read these before changing anything:
 *
 *  1. Writes to the signatures repo use a short-lived GitHub App token. It is
 *     minted on demand, never stored, refreshed shortly before it expires and
 *     once more after a 401. See getSignaturesToken().
 *  2. Comments and statuses use the job's own GITHUB_TOKEN, which cannot reach
 *     the signatures repo.
 *  3. A PR counts as signed only when every real commit author is in the
 *     store. Authors come from the API, not from whoever left the sign
 *     comment, so nobody can sign for someone else.
 *  4. The allowlist holds numeric account ids only. No logins and no
 *     wildcards, so a renamed or released login can never inherit an
 *     exemption. See parseAllowlist() and isAllowlisted().
 *  5. Signature writes retry with a fresh read on HTTP 409, and on the
 *     first-write 422, for when several repos write the same file at once.
 *  6. Every request has a timeout.
 *  7. Signatures are keyed by numeric id, not login, for the same reason as
 *     point 4. See isSigned(). Lookups go through SignatureIndex, a hash set
 *     of ids built in the same pass that parses the file, so each check is
 *     O(1) instead of a scan of the whole store.
 *  8. An email that cannot be resolved to an account is never shown in a
 *     comment or a log because it may be personal data. Only the commit SHA
 *     is shown. See listPRCommitAuthors() and checkPR().
 *  9. GitHub picks a commit's author from its email, which anyone can forge,
 *     and it verifies only the committer. REQUIRE_VERIFIED_COMMITS=true trusts
 *     the author only when the same account is the verified committer. See
 *     listPRCommitAuthors().
 * 10. A Co-authored-by trailer is free text. The bot reads the id from it but
 *     looks up the real login on GitHub, so every (id, login) pair belongs to
 *     one real account. It cannot check that the person agreed to be credited.
 * 11. Allowlist ids are matched against the id GitHub reports for the author,
 *     never against what a commit or trailer claims. A non-numeric entry fails
 *     validateConfig().
 */

"use strict";

const fs = require("fs");
const crypto = require("crypto");
const { AsyncLocalStorage } = require("node:async_hooks");

// Node 18 and 20 are past end of life. Fail here with a clear message instead
// of a confusing "fetch is not defined" later.
const [NODE_MAJOR] = process.versions.node.split(".").map(Number);
if (NODE_MAJOR < 22 || typeof fetch !== "function") {
  console.error(
    `::error::cla-bot requires Node.js >= 22 with global fetch (Node 18/20 are past End-of-Life). Detected ${process.version}.`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Config (all values come from env vars set by action.yml)
// ---------------------------------------------------------------------------
const GITHUB_API = process.env.GITHUB_API_URL || "https://api.github.com";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const SIG_APP_ID = process.env.SIG_APP_ID || "";
const SIG_APP_PRIVATE_KEY = process.env.SIG_APP_PRIVATE_KEY || "";
const SIG_OWNER = process.env.SIG_OWNER;
const SIG_REPO = process.env.SIG_REPO;
// Normalized once so validation, URL building and log messages all see the
// same value. See normalizeSigPath().
const SIG_PATH_RAW = process.env.SIG_PATH;
const SIG_PATH = normalizeSigPath(SIG_PATH_RAW);
const CLA_DOCUMENT_URL = process.env.CLA_DOCUMENT_URL;

// The allowlist is numeric GitHub account ids separated by commas and/or
// whitespace, so a multi-line YAML value works. Anything that is not a plain
// positive integer ("id:5", "0", "1e3", "012", a username, a value past
// Number.MAX_SAFE_INTEGER) goes into `invalid` and validateConfig() fails the
// run. Ignoring a bad entry would ask for a signature from the account the
// maintainer meant to exempt.
const ALLOWLIST_ID_RE = /^[1-9][0-9]*$/;
function parseAllowlist(raw) {
  const ids = new Set();
  const invalid = [];
  for (const entry of String(raw || "")
    .split(/[,\s]+/)
    .filter(Boolean)) {
    const id = Number(entry);
    if (ALLOWLIST_ID_RE.test(entry) && Number.isSafeInteger(id)) {
      ids.add(id);
    } else {
      invalid.push(entry);
    }
  }
  return { ids, invalid };
}
const ALLOWLIST = parseAllowlist(process.env.ALLOWLIST);
const SIGN_PHRASE = "I have read the CLA Document and I hereby sign the CLA";
const STATUS_CONTEXT = "cla/fossasia";

// Every comment the bot posts starts with BOT_MARKER. The other markers and
// fragments below let classifyBotComment() tell a comment that blocked a PR
// from one that announced success, so checkPR() can stay quiet when nothing
// has changed.
const BOT_MARKER = "<!-- fossasia-cla-bot:v1 -->";
const PENDING_MARKER = "<!-- fossasia-cla-bot:pending -->";
// Wording shared by the "please sign" and "needs manual review" comments and
// by classifyBotComment(), so the two cannot drift apart. They also match
// comments from older versions of the bot that had no PENDING_MARKER.
const NEEDS_SIGN_FRAGMENT = "need to sign our";
const NEEDS_REVIEW_FRAGMENT = "could not be automatically attributed";
// Exact text of the success comment from older versions of the bot. It is
// matched by equality, not substring, so an unrelated comment that quotes the
// phrase is not mistaken for it.
const LEGACY_SUCCESS_TEXT = "All contributors have signed the CLA. ✅";
const LEGACY_SUCCESS_COMMENT = `${BOT_MARKER}\n${LEGACY_SUCCESS_TEXT}`;
// Every success comment carries this marker. SUCCESS_MESSAGE and
// personalSuccessMessage() both build on it, so changing their wording cannot
// break classifyBotComment().
const SUCCESS_MARKER = "<!-- fossasia-cla-bot:success -->";
// Used when there is no specific signer to thank: automatic checks and the
// `recheck` command.
const SUCCESS_MESSAGE = `${SUCCESS_MARKER}\n${LEGACY_SUCCESS_TEXT}`;
// Used when the person who just signed is the one who completed the PR. See
// signerCompletedRequirement().
function personalSuccessMessage(login) {
  return `${SUCCESS_MARKER}\n@${login} Thank you for signing the CLA! We look forward to your contributions.`;
}

// Optional hardening, off by default so unsigned-commit workflows keep
// working. See security property 9 and listPRCommitAuthors().
const REQUIRE_VERIFIED_COMMITS =
  (process.env.REQUIRE_VERIFIED_COMMITS || "false").toLowerCase() === "true";
// The login GITHUB_TOKEN comments appear under. resolveBotLogin() tries to
// detect the real identity (a consumer may pass a PAT or an App token) and
// falls back to this.
const DEFAULT_BOT_LOGIN = "github-actions[bot]";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
// Each Co-authored-by trailer costs an API call, so cap them per commit.
// Trailers past the cap flag the commit for manual review. See
// extractCoAuthors().
const MAX_COAUTHOR_TRAILERS_PER_COMMIT = 20;

const [REPO_OWNER, REPO_NAME] = (process.env.GITHUB_REPOSITORY || "/").split(
  "/",
);
const EVENT_NAME = process.env.GITHUB_EVENT_NAME;
const EVENT_PATH = process.env.GITHUB_EVENT_PATH;

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

// GitHub user/org names: letters, digits and single hyphens, no leading or
// trailing hyphen, at most 39 characters.
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
// Repo names: letters, digits, ".", "-", "_", up to 100 characters.
const GITHUB_REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

// ---------------------------------------------------------------------------
// Payload validators
//
// The event file is written by GitHub, but it is still external data. PR
// numbers, user ids and SHAs from it end up in request URLs and in the
// signature store, so they are checked where they are first read.
//
// Number.isSafeInteger is used instead of Number.isInteger because JSON.parse
// silently rounds integer literals beyond 2^53, and isInteger accepts values
// like 1e100 that turn into garbage in a URL.
// ---------------------------------------------------------------------------
function assertValidPRNumber(value, context) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `${context}: expected a positive integer issue/PR number, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

// Its own function so NaN and Infinity can be tested directly. They cannot
// survive a JSON round trip, so a mocked fetch could never produce them.
function assertValidInstallationId(value, context) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `${context} is missing a usable "id" field (got ${JSON.stringify(value)}) - cannot mint a signatures-repo token.`,
    );
  }
  return value;
}

// This id is written to the signature store, and isSigned() matches by id
// only when both sides are numbers. A bad id would not be rejected later, it
// would just never match, and JSON.stringify drops an undefined id without
// any sign. So fail before anything is written.
function assertValidUserId(value, context) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `${context}: expected a positive integer GitHub user id, got ${JSON.stringify(value)} (${typeof value}) - refusing to record a signature that could only be matched by login.`,
    );
  }
  return value;
}

// Real SHAs are lowercase hex, but tests use placeholder strings, so this does
// not require hex. It rejects what is dangerous in a URL path segment:
// slashes, "..", "?", "#", whitespace, control characters and "%" (which
// would allow a percent-encoded bypass).
const UNSAFE_URL_SEGMENT_RE = /[/\\?#%\s\x00-\x1f]|\.\./;
function assertValidSha(value, context) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 64 ||
    UNSAFE_URL_SEGMENT_RE.test(value)
  ) {
    throw new Error(
      `${context}: expected a valid commit SHA, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// SIG_PATH, SIG_OWNER and SIG_REPO in request URLs
//
// These values go straight into the path of every signature-store request.
// They are maintainer config, but a mistake is quiet: fetch() parses the URL
// with the WHATWG algorithm, so
//   - "#" and "?" silently cut the path short,
//   - "%2e%2e" becomes ".." and can climb out of /contents/,
//   - tabs, newlines and a trailing space are stripped,
//   - "." and ".." as a repo name are dot-segments.
// readSignatures() treats a 404 as "no signatures yet", so a truncated path
// looks like an empty store and the bot would use the wrong file.
//
// Three layers, all needed:
//   1. normalizeSigPath() keeps the two slips that always worked (trailing
//      whitespace and a leading "./") and touches nothing else.
//   2. findSigPathProblem() rejects anything ambiguous or unsafe, with a
//      message that names the problem.
//   3. encodeRepoPath() percent-encodes each segment.
// Encoding alone is not enough, since encodeURIComponent("..") is still "..".
// The URL builders therefore validate again, because readSignatures() and
// writeSignatures() are exported and can run without validateConfig().
//
// Spaces and non-ASCII characters are allowed in the file name and are sent
// as percent-escapes, exactly as before. "%" is rejected: encoding it again
// would silently address a different file ("my%20file.json" would become a
// file literally named that), and decoding it would reopen double-decode bugs.
// ---------------------------------------------------------------------------
// Never allowed in SIG_PATH: backslash, "?", "#", "%" and control characters.
// Control characters are blocked because the URL parser strips some of them
// and because the value is echoed into "::error::" log lines.
const SIG_PATH_UNSAFE_CHAR_RE = /[\\?#%\x00-\x1f\x7f-\x9f]/;

// Reproduces exactly what the file name used to be when the raw value went
// straight into fetch(): trailing characters U+0000..U+0020 (a trailing space,
// or the newline a YAML `|` block adds) never reached the server, and a
// leading "./" was collapsed. Leading whitespace stays part of the name. A
// plain trim() would also strip leading and Unicode whitespace, and no
// normalization at all would turn a trailing space into "cla.json%20".
// validateConfig() warns when the value changed.
//
// An empty value falls back to the default. A whitespace-only value becomes ""
// and findSigPathProblem() rejects it. A char-code loop is used instead of a
// regex to stay linear-time on odd input.
function normalizeSigPath(raw) {
  let p = raw || "signatures/cla.json";
  let end = p.length;
  while (end > 0 && p.charCodeAt(end - 1) <= 0x20) end -= 1;
  p = p.slice(0, end);
  while (p.startsWith("./")) p = p.slice(2);
  return p;
}

// Returns a short reason why a path is unusable, or null when it is fine.
// Pure: no I/O and it never throws.
function findSigPathProblem(path) {
  if (typeof path !== "string" || path.trim().length === 0) {
    return "it must not be empty";
  }
  if (path.startsWith("/")) {
    return 'it must be relative (no leading "/")';
  }
  if (path.endsWith("/")) {
    return 'it must name a file, not a directory (no trailing "/")';
  }
  const bad = path.match(SIG_PATH_UNSAFE_CHAR_RE);
  if (bad && bad[0] === "%") {
    return 'it contains "%" - percent-encoded input is not supported, because encoding it again would silently address a different file; write the literal character instead (a space, not "%20"), encoding is done for you';
  }
  if (bad) {
    return `it contains the disallowed character ${JSON.stringify(bad[0])} (backslash, "?", "#", "%" and control characters are not allowed; spaces are fine, and are encoded automatically)`;
  }
  for (const segment of path.split("/")) {
    if (segment.length === 0) {
      return 'it contains an empty segment ("//")';
    }
    if (segment === "." || segment === "..") {
      return `it contains the "${segment}" path segment`;
    }
    // Git refuses a ".git" path component, so the Contents API cannot
    // address one.
    if (segment.toLowerCase() === ".git") {
      return 'it contains a ".git" path segment, which git does not allow';
    }
  }
  try {
    encodeURIComponent(path);
  } catch {
    // A lone UTF-16 surrogate makes encodeURIComponent throw. Report it as a
    // config problem instead of crashing mid-run.
    return "it is not valid Unicode text";
  }
  return null;
}

// Percent-encodes each "/"-separated segment and keeps the "/" literal, which
// is the shape /contents/{path} expects. Throws on anything
// findSigPathProblem() rejects.
function encodeRepoPath(path) {
  const problem = findSigPathProblem(path);
  if (problem) {
    throw new Error(
      `Refusing to build a request URL from path ${JSON.stringify(path)}: ${problem}.`,
    );
  }
  return path.split("/").map(encodeURIComponent).join("/");
}

// "/repos/{owner}/{repo}" for the signatures repo. Not exported and takes no
// suffix on purpose: callers use one of the two functions below, each of which
// encodes its own tail. Only an empty value and a dot-segment are checked
// here. Whether the name is a real GitHub name is validateConfig()'s job, and
// repeating those regexes here would make the encoding unreachable.
function sigRepoBasePath() {
  for (const [name, value] of [
    ["SIG_OWNER", SIG_OWNER],
    ["SIG_REPO", SIG_REPO],
  ]) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `Refusing to build a request URL: ${name} is missing or empty.`,
      );
    }
    if (value === "." || value === "..") {
      throw new Error(
        `Refusing to build a request URL: ${name} ${JSON.stringify(value)} is a dot-segment.`,
      );
    }
  }
  return `/repos/${encodeURIComponent(SIG_OWNER)}/${encodeURIComponent(SIG_REPO)}`;
}

// GitHub App installation lookup for the signatures repo.
function sigInstallationApiPath() {
  return `${sigRepoBasePath()}/installation`;
}

// Contents API path of the signature file.
function sigContentsApiPath() {
  return `${sigRepoBasePath()}/contents/${encodeRepoPath(SIG_PATH)}`;
}

function validateConfig() {
  for (const [name, val] of [
    ["GITHUB_TOKEN", GITHUB_TOKEN],
    ["SIG_OWNER", SIG_OWNER],
    ["SIG_REPO", SIG_REPO],
    ["CLA_DOCUMENT_URL", CLA_DOCUMENT_URL],
  ]) {
    if (!val) fail(`Missing required input/env: ${name}`);
  }

  // Fail fast on config typos instead of a vague API error later.
  if (!GITHUB_LOGIN_RE.test(SIG_OWNER)) {
    fail(
      `SIG_OWNER ${JSON.stringify(SIG_OWNER)} doesn't look like a valid GitHub user/org name.`,
    );
  }
  // "." and ".." pass the repo-name regex but are URL dot-segments, and GitHub
  // never allows them as repo names.
  if (
    !GITHUB_REPO_NAME_RE.test(SIG_REPO) ||
    SIG_REPO === "." ||
    SIG_REPO === ".."
  ) {
    fail(
      `SIG_REPO ${JSON.stringify(SIG_REPO)} doesn't look like a valid GitHub repository name.`,
    );
  }
  // JSON.stringify keeps control characters from injecting log lines.
  const sigPathProblem = findSigPathProblem(SIG_PATH);
  if (sigPathProblem) {
    fail(
      `SIG_PATH ${JSON.stringify(SIG_PATH)} is not a valid path within the signatures repo: ${sigPathProblem}.`,
    );
  }
  try {
    const parsed = new URL(CLA_DOCUMENT_URL);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      fail(
        `CLA_DOCUMENT_URL ${JSON.stringify(CLA_DOCUMENT_URL)} must be an http(s) URL.`,
      );
    }
  } catch {
    fail(
      `CLA_DOCUMENT_URL ${JSON.stringify(CLA_DOCUMENT_URL)} is not a valid URL.`,
    );
  }
  // Say so when normalization changed the value.
  if (SIG_PATH_RAW && SIG_PATH_RAW !== SIG_PATH) {
    console.warn(
      `::warning::SIG_PATH ${JSON.stringify(SIG_PATH_RAW)} was normalized to ${JSON.stringify(SIG_PATH)} (trailing whitespace/control characters and a leading "./" are ignored). Update the "signatures-path" input to the normalized value to silence this.`,
    );
  }
  if (ALLOWLIST.invalid.length) {
    fail(
      `ALLOWLIST entries must be numeric GitHub account ids (usernames are not supported - they can be renamed and reclaimed by someone else); invalid: ${ALLOWLIST.invalid.map((e) => JSON.stringify(e)).join(", ")}. Look an id up with: gh api users/NAME --jq .id`,
    );
  }
  // App auth is optional (getSignaturesToken falls back to GITHUB_TOKEN), but
  // a key that is set must look like a PEM, so a mis-pasted secret fails
  // clearly instead of deep inside crypto.sign().
  if (SIG_APP_PRIVATE_KEY && !SIG_APP_PRIVATE_KEY.includes("-----BEGIN")) {
    fail(
      'SIG_APP_PRIVATE_KEY is set but does not look like a PEM-encoded private key (missing a "-----BEGIN" header).',
    );
  }
}

// ---------------------------------------------------------------------------
// HTTP helper: timeout, JSON handling and a retry for transient failures
// (rate limits, brief 5xx). 409 conflicts on writes are handled in
// writeSignatures(), since they need a re-read, not a blind retry.
// ---------------------------------------------------------------------------
async function ghRaw(path, token, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${GITHUB_API}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "fossasia-cla-bot",
        // fetch() does not set this for a plain string body.
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });
    const text = await res.text();
    if (!res.ok) {
      // A proxy can return an HTML error page on a 502/503/504. Parse
      // defensively so that does not hide the real status.
      let body = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = null; // The raw text is still in the Error message below.
        }
      }
      const err = new Error(
        `GitHub API ${options.method || "GET"} ${path} -> ${res.status}: ${text}`,
      );
      err.status = res.status;
      err.body = body;
      err.retryAfter = Number(res.headers.get("retry-after")) || null;
      throw err;
    }
    // Raw media-type requests (see readSignatures) return plain text.
    if (options.raw) return text;
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timeout);
  }
}

async function gh(path, token, options = {}, attempt = 1) {
  try {
    return await ghRaw(path, token, options);
  } catch (e) {
    // Retry only what is safe to repeat. GET is. PUT is, because GitHub's sha
    // check makes a repeat either apply once or fail with 409. DELETE is,
    // because repeating it just gives 404. Creating POSTs (comments, tokens)
    // are not, since a retry could duplicate them, unless the caller passes
    // `idempotent: true`.
    const method = (options.method || "GET").toUpperCase();
    const safeToRetry =
      options.idempotent === true ||
      method === "GET" ||
      method === "PUT" ||
      method === "DELETE";
    const transient =
      safeToRetry &&
      (e.status === 429 ||
        (e.status === 403 && e.retryAfter) || // secondary rate limit
        (e.status >= 500 && e.status <= 599) ||
        e.name === "AbortError");
    if (transient && attempt < MAX_RETRIES) {
      const delayMs = e.retryAfter ? e.retryAfter * 1000 : attempt * 1000;
      await new Promise((r) => setTimeout(r, delayMs));
      return gh(path, token, options, attempt + 1);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// GitHub App: mint a short-lived installation token
// ---------------------------------------------------------------------------
function base64url(buf) {
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function createAppJWT(appId, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  // iat is 60s in the past to allow for clock drift. GitHub requires exp to
  // be at most 10 minutes ahead.
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId };
  const unsigned = `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(Buffer.from(JSON.stringify(payload)))}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${base64url(signer.sign(privateKeyPem))}`;
}

// ---------------------------------------------------------------------------
// Signatures-repo token lifecycle
//
// An installation token lives about an hour, and the access_tokens response
// carries its `expires_at`. The sign flow mints a token first, then reads the
// store again at the end of checkPR(), after paging through every commit and
// co-author. On a huge PR or a slow runner that gap can outlast the token and
// the final read would fail with a 401 after the signature was already saved.
// So:
//   1. The cache remembers the expiry and re-mints within
//      SIG_TOKEN_REFRESH_SKEW_MS of it.
//   2. withSignaturesToken() also recovers from a 401 by minting a fresh token
//      and retrying once.
//   3. Concurrent callers share one in-flight mint.
// ---------------------------------------------------------------------------
// GitHub documents one hour. It is also the ceiling for any `expires_at` we
// are told about.
const SIG_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
// Refresh this long before the real expiry, so a token never dies mid-request
// and small clock drift is absorbed.
const SIG_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

let _sigTokenCache = null; // { token, expiresAtMs, viaApp } | null
let _sigTokenMint = null; // in-flight mint promise shared by concurrent callers

function usesAppAuth() {
  return Boolean(SIG_APP_ID && SIG_APP_PRIVATE_KEY);
}

// When a fresh token should be considered dead: the response's `expires_at`,
// but never later than one hour after the mint request started. A missing or
// unparseable value falls back to that ceiling, because caching NaN would make
// every freshness check false and re-mint on every call.
function resolveSigTokenExpiry(expiresAt, mintStartedAtMs) {
  const ceiling = mintStartedAtMs + SIG_TOKEN_LIFETIME_MS;
  if (typeof expiresAt !== "string") return ceiling;
  const parsed = Date.parse(expiresAt);
  if (!Number.isFinite(parsed)) return ceiling;
  return Math.min(parsed, ceiling);
}

function isSigTokenFresh(entry) {
  return (
    entry !== null && Date.now() < entry.expiresAtMs - SIG_TOKEN_REFRESH_SKEW_MS
  );
}

async function mintSignaturesToken() {
  if (!usesAppAuth()) {
    console.warn(
      "::warning::SIG_APP_ID/SIG_APP_PRIVATE_KEY not set - falling back to GITHUB_TOKEN. Cross-repo writes will only work if the signatures repo equals the current repo.",
    );
    // GITHUB_TOKEN lives for the whole job, so this entry never goes stale.
    return { token: GITHUB_TOKEN, expiresAtMs: Infinity, viaApp: false };
  }

  // Taken before any request, see resolveSigTokenExpiry().
  const mintStartedAtMs = Date.now();
  const jwt = createAppJWT(SIG_APP_ID, SIG_APP_PRIVATE_KEY);
  // The repo-scoped lookup works for user and org owners. The
  // /orgs/{org}/installation endpoint 404s for a user account.
  const installation = await gh(sigInstallationApiPath(), jwt);
  // A 200 does not guarantee a usable id. Check it here so a bad lookup
  // response is reported as that, not as a misleading 404 on the next request.
  assertValidInstallationId(
    installation?.id,
    `GitHub App installation lookup for /repos/${SIG_OWNER}/${SIG_REPO}/installation`,
  );
  const tokenResp = await gh(
    `/app/installations/${installation.id}/access_tokens`,
    jwt,
    // A retried mint only produces an extra unused short-lived token.
    { method: "POST", idempotent: true },
  );
  // Same for the token: an empty 200 body (ghRaw() returns null) or a
  // whitespace-only token must fail here, not later as a confusing "Bad
  // credentials" on an unrelated request.
  if (
    !tokenResp ||
    typeof tokenResp.token !== "string" ||
    tokenResp.token.trim().length === 0
  ) {
    throw new Error(
      `GitHub App access_tokens response for /app/installations/${installation.id}/access_tokens is missing a usable "token" field (got ${typeof tokenResp?.token}) - cannot mint a signatures-repo token.`,
    );
  }
  return {
    token: tokenResp.token.trim(),
    expiresAtMs: resolveSigTokenExpiry(tokenResp.expires_at, mintStartedAtMs),
    viaApp: true,
  };
}

async function getSignaturesToken() {
  if (isSigTokenFresh(_sigTokenCache)) return _sigTokenCache.token;
  // Join a mint that is already running instead of starting a second one.
  if (_sigTokenMint) return _sigTokenMint;

  const mint = mintSignaturesToken()
    .then((entry) => {
      _sigTokenCache = entry;
      return entry.token;
    })
    .finally(() => {
      // Cleared on success and failure, so a failed mint never blocks later
      // calls. Only clear our own promise.
      if (_sigTokenMint === mint) _sigTokenMint = null;
    });
  _sigTokenMint = mint;
  return mint;
}

// Forget `rejectedToken`, but only if it is still the cached one. A newer
// token from another refresh must survive.
function invalidateSignaturesToken(rejectedToken) {
  if (
    _sigTokenCache &&
    _sigTokenCache.viaApp &&
    _sigTokenCache.token === rejectedToken
  ) {
    _sigTokenCache = null;
  }
}

// Runs `fn(token)` and, on a 401, mints a fresh token and runs `fn` once more.
// Only one retry, so bad credentials never loop. Only for App tokens, since
// the GITHUB_TOKEN fallback cannot be re-minted. Mint failures happen outside
// `fn` and propagate unchanged. Re-running `fn` is safe: a 401 means the
// request was rejected before doing anything, and every `fn` used here
// tolerates a re-run.
async function withSignaturesToken(fn) {
  const token = await getSignaturesToken();
  try {
    return await fn(token);
  } catch (e) {
    if (!e || e.status !== 401 || !usesAppAuth()) throw e;
    console.warn(
      "::warning::The signatures-repo installation token was rejected (HTTP 401) - minting a fresh one and retrying once.",
    );
    invalidateSignaturesToken(token);
    const freshToken = await getSignaturesToken();
    if (freshToken === token) throw e; // nothing new to try
    return await fn(freshToken);
  }
}

// ---------------------------------------------------------------------------
// Signature index: O(1) "has this account id signed?" lookups
//
// The store is a JSON array, and scanning it per question made every check
// O(n): checkPR() asked once per commit author (O(authors x signatures)), and
// mergeSignatures() compared every known entry with every fresh entry
// (O(known x fresh), which is O(n^2) because the sign flow hands it the whole
// file). Parsing the file is O(n) and unavoidable, so the index is built in
// that same single pass (see readSignatures()) and every lookup after it is a
// hash probe.
//
// The index holds numeric ids only, under exactly the rule isSigned() always
// had: an entry counts only if it is an object whose `id` is a number. A
// missing, string, null or NaN id is never indexed, so such an entry fails
// closed, and Set.has() uses SameValueZero, so a string "555" never matches
// the number 555. Logins are not stored, so they can never be matched.
//
// An index is a snapshot. It is built from one array and does not follow later
// changes to it, so build a new one for new data instead of reusing it.
// ---------------------------------------------------------------------------
function signatureEntryId(entry) {
  if (entry === null || typeof entry !== "object") return null;
  const id = entry.id;
  return typeof id === "number" && !Number.isNaN(id) ? id : null;
}

class SignatureIndex {
  #ids = new Set();

  // `signatures` must be an array. A non-array throws a TypeError, as the
  // linear scan it replaces did.
  constructor(signatures) {
    for (const entry of signatures) this.add(entry);
  }

  // Takes a stored entry, not an id. Entries without a usable id are skipped.
  add(entry) {
    const id = signatureEntryId(entry);
    if (id !== null) this.#ids.add(id);
  }

  has(id) {
    return this.#ids.has(id);
  }
}

// ---------------------------------------------------------------------------
// Signature store (a JSON file in the central private repo)
// ---------------------------------------------------------------------------
async function readSignatures(token) {
  // Built and validated outside the try on purpose, so an invalid SIG_PATH
  // surfaces as a config error and is never mistaken for the 404 below.
  const contentsPath = sigContentsApiPath();
  try {
    // The 'object' media type works up to 100 MB (the default format is only
    // reliable under 1 MB) and still returns the sha needed for
    // compare-and-swap writes. Files up to 1 MB come with their content.
    // Larger ones come back empty and are fetched with the 'raw' media type.
    const meta = await gh(contentsPath, token, {
      headers: { Accept: "application/vnd.github.object+json" },
    });

    let text;
    if (meta.content && meta.encoding === "base64") {
      text = Buffer.from(meta.content, "base64").toString("utf8");
    } else {
      text = await gh(contentsPath, token, {
        headers: { Accept: "application/vnd.github.raw+json" },
        raw: true,
      });
    }

    const data = JSON.parse(text);
    if (!Array.isArray(data.signatures))
      throw new Error(
        'signatures file is malformed: "signatures" is not an array',
      );

    // One pass over the entries does two jobs, so the index costs nothing
    // extra on top of the O(n) parse. It warns about a malformed entry but
    // keeps it: the data is written straight back on the next write, and
    // dropping an entry could delete a real signature from before a schema
    // change. isSigned() handles such entries safely. The warning prints only
    // the position, because the Actions log can be public and entries can
    // contain personal data. It also indexes every entry by numeric id (see
    // SignatureIndex), whether or not its login is valid, as isSigned()
    // always matched on the id alone.
    const index = new SignatureIndex([]);
    data.signatures.forEach((entry, position) => {
      if (
        !entry ||
        typeof entry.login !== "string" ||
        entry.login.length === 0
      ) {
        console.warn(
          `::warning::Signature entry at index ${position} is missing/has an invalid "login" field (kept as-is, not treated as a match) - check ${SIG_OWNER}/${SIG_REPO}/${SIG_PATH}`,
        );
      }
      index.add(entry);
    });
    // `index` describes this `data` snapshot only.
    return { sha: meta.sha, data, index };
  } catch (e) {
    if (e.status === 404)
      return {
        sha: null,
        data: { version: 1, signatures: [] },
        index: new SignatureIndex([]),
      };
    throw e;
  }
}

async function writeSignatures(token, mutate, message, attempt = 1) {
  // Re-read right before writing so the sha we PUT with is fresh. That is
  // what makes the retry loop below correct.
  // `mutate` also gets the SignatureIndex of `data`, for O(1) "already
  // there?" checks. The index describes `data`, not what mutate() returns.
  const { sha, data, index } = await readSignatures(token);
  const updated = mutate(data, index);
  if (updated === null) return data; // nothing to change, e.g. already signed
  const content = Buffer.from(JSON.stringify(updated, null, 2)).toString(
    "base64",
  );
  try {
    await gh(sigContentsApiPath(), token, {
      method: "PUT",
      body: JSON.stringify({ message, content, sha: sha || undefined }),
    });
    return updated;
  } catch (e) {
    // Two races mean "the file changed under us, re-read and reapply":
    //  1. A 409: someone updated the existing file between our read and write.
    //  2. A first-write race: we saw no file (sha null) but another writer
    //     created it first. GitHub answers 422 asking for a sha, not 409.
    //     Several repos can race to create the file for the first time.
    const isExistingFileConflict = e.status === 409;
    const isFirstWriteRace =
      sha === null &&
      e.status === 422 &&
      /sha/i.test((e.body && e.body.message) || "");
    if ((isExistingFileConflict || isFirstWriteRace) && attempt < 4) {
      await new Promise((r) => setTimeout(r, attempt * 800));
      return writeSignatures(token, mutate, message, attempt + 1);
    }
    throw e;
  }
}

// `author` is an { id, login } pair. Matching is on the numeric id only. A
// login can be released and claimed by someone else, who would then inherit
// the old signature. An author or stored entry without a numeric id never
// matches, so it fails closed. Tests call this directly and readSignatures()
// keeps malformed entries, so garbage entries return false instead of
// throwing.
//
// `source` is a SignatureIndex (O(1), what the bot's own code passes) or a
// plain `{ signatures: [...] }` object. The plain form builds a throwaway
// index, which costs O(n) per call, so use an index when asking more than
// once about the same data.
function isSigned(source, author) {
  if (author == null || typeof author !== "object") return false;
  const id = author.id;
  if (typeof id !== "number") return false;
  const index =
    source instanceof SignatureIndex
      ? source
      : new SignatureIndex(source.signatures);
  return index.has(id);
}

// Same rule for the allowlist: only the numeric id counts, and a missing or
// malformed id is not allowlisted.
function isAllowlisted(author) {
  if (author == null || typeof author !== "object") return false;
  return typeof author.id === "number" && ALLOWLIST.ids.has(author.id);
}

// Id-only identity check, like isSigned(), but answering a different
// question: is this identity one of this PR's own commit authors? checkPR()
// uses it to tell a real required signer from a bystander.
function isSameContributor(a, b) {
  if (!a || !b) return false;
  return typeof a.id === "number" && typeof b.id === "number" && a.id === b.id;
}

// Combines a snapshot the caller already knows (what writeSignatures() just
// returned) with a fresh read, so neither side's staleness hides a signature:
//  - The fresh read may still show the old file, because GitHub's Contents API
//    does not guarantee read-after-write. `known` covers that.
//  - `known` was taken before listPRCommitAuthors() ran and cannot contain a
//    signature that another run wrote in the meantime. `fresh` covers that.
// When both have the same identity, the fresh entry wins. `known` is null for
// every caller except handleIssueComment(), and then `fresh` is returned as is.
//
// Linear in known + fresh: the fresh ids are indexed once, and each known entry
// is one probe. (The nested scan this replaced was O(known x fresh), and since
// `known` is the whole file that was O(n^2).) The rule is the same as
// isSameContributor(): numeric ids only, so a known entry without a usable id
// has nothing to match and is kept.
function mergeSignatures(known, fresh) {
  if (!known) return fresh;
  const freshIds = new SignatureIndex(fresh.signatures);
  const keptFromKnown = known.signatures.filter(
    (k) => !freshIds.has(signatureEntryId(k)),
  );
  return {
    version: fresh.version,
    signatures: [...keptFromKnown, ...fresh.signatures],
  };
}

// Was `signer` one of the required (non-allowlisted) commit authors in
// `authors`? checkPR() calls this only when the PR is now fully signed, and
// handleIssueComment() passes a `signer` only after recording a new signature.
// So if the signer is a required author here, their signature is what moved
// the PR forward. An allowlisted account or someone with no commit on the PR
// gets no credit.
function signerCompletedRequirement(authors, signer) {
  return (
    !!signer &&
    !isAllowlisted(signer) &&
    authors.some((a) => isSameContributor(a, signer))
  );
}

// Classifies one of the bot's own comments as "pending" (it blocked the PR:
// someone must sign or a commit needs review), "success" (the all-signed
// announcement) or "other" (for example the "you already signed" reply).
// checkPR() uses this to tell a real block from unrelated bot chatter.
function classifyBotComment(body) {
  if (
    body.includes(PENDING_MARKER) ||
    body.includes(NEEDS_SIGN_FRAGMENT) ||
    body.includes(NEEDS_REVIEW_FRAGMENT)
  ) {
    return "pending";
  }
  // SUCCESS_MARKER covers the generic and the per-signer messages. The exact
  // match is only for comments from before the marker existed.
  if (body.includes(SUCCESS_MARKER) || body === LEGACY_SUCCESS_COMMENT) {
    return "success";
  }
  return "other";
}

// ---------------------------------------------------------------------------
// Repo-local helpers (comments, status, lock). These always use GITHUB_TOKEN,
// never the signatures token.
// ---------------------------------------------------------------------------
// GitHub has two noreply email formats:
//   - ID+USERNAME@users.noreply.github.com (accounts created after 18 Jul
//     2017): the id is in the address.
//   - USERNAME@users.noreply.github.com (older accounts): needs one lookup.
const NEW_NOREPLY = /^(\d+)\+([^@]+)@users\.noreply\.github\.com$/i;
const OLD_NOREPLY = /^([^@+]+)@users\.noreply\.github\.com$/i;

// ---------------------------------------------------------------------------
// Identity lookups (login to id, id to login, and the bot's own login)
//
// The caches hold the promise, not the finished value, and it is stored
// synchronously before the request is awaited. A caller that asks while a
// lookup is running gets the same promise, so each key costs exactly one
// request per run. Nothing calls these concurrently today, but this keeps it
// safe if listPRCommitAuthors() is ever parallelized.
//
// The fetchers never reject. They catch every failure and resolve to a
// fallback (null, or the default bot login). Failed lookups are cached on
// purpose: an unresolvable co-author costs one request per run, and an
// unresolved id is flagged for manual review, so it fails closed. A fetcher
// that can reject must also evict its own cache entry.
// ---------------------------------------------------------------------------
const _userIdLookups = new Map(); // login (lowercased) -> Promise<id | null>
async function resolveUserIdByLogin(login) {
  const key = login.toLowerCase();
  let lookup = _userIdLookups.get(key);
  if (lookup === undefined) {
    lookup = fetchUserIdByLogin(login);
    _userIdLookups.set(key, lookup);
  }
  return lookup;
}

async function fetchUserIdByLogin(login) {
  try {
    const user = await gh(`/users/${encodeURIComponent(login)}`, GITHUB_TOKEN);
    if (user && typeof user.id === "number") return user.id;
  } catch {
    // 404 or a transient failure: the caller treats it as unresolved.
  }
  return null;
}

const _loginByIdLookups = new Map(); // id -> Promise<login | null>
// GET /user/{account_id} returns the current, GitHub-verified login for an
// id. A trailer is free text, so the login next to an id in it proves nothing.
async function resolveLoginById(id) {
  let lookup = _loginByIdLookups.get(id);
  if (lookup === undefined) {
    lookup = fetchLoginById(id);
    _loginByIdLookups.set(id, lookup);
  }
  return lookup;
}

async function fetchLoginById(id) {
  try {
    const user = await gh(`/user/${encodeURIComponent(id)}`, GITHUB_TOKEN);
    if (user && typeof user.login === "string" && user.login.length > 0) {
      return user.login;
    }
  } catch {
    // 404 (deleted account or unknown id) or a transient failure: unresolved.
  }
  return null;
}

// Reads the Co-authored-by trailers of a commit message. A trailer is free
// text that GitHub never authenticates, so for the new noreply format the
// login is looked up by id instead of trusted (see security property 10).
// Other email formats cannot be resolved reliably and are flagged for manual
// review, like an unresolved primary author. The raw email is never returned,
// because it can be personal data and the result ends up in PR comments and
// logs.
async function extractCoAuthors(commitMessage) {
  const authors = [];
  let hasUnresolved = false;
  const trailerRegex = /^co-authored-by:\s*.+?<([^>]+)>\s*$/gim;
  const seen = new Set();
  let match;
  while ((match = trailerRegex.exec(commitMessage || "")) !== null) {
    const email = match[1].trim();
    const key = email.toLowerCase();
    if (seen.has(key)) continue; // repeated trailer, skip the second lookup
    if (seen.size >= MAX_COAUTHOR_TRAILERS_PER_COMMIT) {
      // Past the cap: stop looking up and flag the commit for a human.
      hasUnresolved = true;
      break;
    }
    seen.add(key);

    const newStyle = email.match(NEW_NOREPLY);
    if (newStyle) {
      const claimedId = Number(newStyle[1]);
      // Ignore the login text in the trailer and ask GitHub for the real one.
      const authoritativeLogin = await resolveLoginById(claimedId);
      if (authoritativeLogin !== null) {
        authors.push({ id: claimedId, login: authoritativeLogin });
        continue;
      }
      // The id matches no current account, so fall through.
    }

    const oldStyle = email.match(OLD_NOREPLY);
    if (oldStyle) {
      const login = oldStyle[1];
      const id = await resolveUserIdByLogin(login);
      if (id !== null) {
        authors.push({ id, login });
        continue;
      }
      // The lookup failed (for example a deleted account), so fall through.
    }

    hasUnresolved = true;
  }
  return { authors, hasUnresolved };
}

async function listPRCommitAuthors(prNumber) {
  // Keyed by numeric id, so someone who is author on one commit and co-author
  // on another counts once.
  const authors = new Map();
  // Commits flagged for manual review, by SHA only. A SHA is already public on
  // the PR's Commits tab and holds no personal data, unlike an email.
  const unresolvedShas = new Set();
  let page = 1;
  for (;;) {
    const commits = await gh(
      `/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${encodeURIComponent(prNumber)}/commits?per_page=100&page=${page}`,
      GITHUB_TOKEN,
    );
    if (!commits.length) break;
    for (const c of commits) {
      // Skip merge commits. Whoever merged did not write the change.
      if (Array.isArray(c.parents) && c.parents.length > 1) continue;

      if (c.author && c.author.login && typeof c.author.id === "number") {
        const verified = !!(
          c.commit &&
          c.commit.verification &&
          c.commit.verification.verified
        );
        // `verified` says nothing about the author, because GitHub verifies
        // only the committer (see security property 9). Trust the author only
        // when the same account is also the verified committer.
        const committerIsSameAccount =
          c.committer &&
          typeof c.committer.id === "number" &&
          c.committer.id === c.author.id;
        const authorAttributionTrusted =
          !REQUIRE_VERIFIED_COMMITS || (verified && committerIsSameAccount);
        if (!authorAttributionTrusted) {
          unresolvedShas.add(c.sha);
        } else {
          authors.set(c.author.id, { id: c.author.id, login: c.author.login });
        }
      } else {
        // The commit email is not linked to a GitHub account. Flag it.
        unresolvedShas.add(c.sha);
      }

      // Co-authors have to sign too.
      const { authors: coAuthors, hasUnresolved } = await extractCoAuthors(
        c.commit?.message,
      );
      coAuthors.forEach((a) => authors.set(a.id, a));
      if (hasUnresolved) unresolvedShas.add(c.sha);
    }
    if (commits.length < 100) break;
    page += 1;
  }
  return { authors: [...authors.values()], unresolved: [...unresolvedShas] };
}

// One lookup per run, shared by every caller. Same promise caching as the
// identity lookups above, and it never rejects.
let _botLoginLookup = null; // Promise<string> | null
async function resolveBotLogin() {
  if (_botLoginLookup === null) _botLoginLookup = fetchBotLogin();
  return _botLoginLookup;
}

// Any failure resolves to DEFAULT_BOT_LOGIN.
async function fetchBotLogin() {
  try {
    // Works for a PAT or a user-scoped token. The standard GITHUB_TOKEN is
    // neither, so this normally fails and the default is used. It matters
    // only when a consumer passes another kind of token.
    const me = await gh("/user", GITHUB_TOKEN);
    if (me && me.login) return me.login;
  } catch {
    // Expected for the standard GITHUB_TOKEN.
  }
  return DEFAULT_BOT_LOGIN;
}

// ---------------------------------------------------------------------------
// Per-run cache for a PR's raw comment list, used by getExistingBotComments().
//
// One checkPR() run can ask "what did the bot already say on this PR?"
// several times: its own history check, postComment()'s dedupe check
// (sometimes twice, for the thank-you and the pending list), and the cleanup
// re-fetch after posting. They all page through the exact same comments -
// only the local filter (which identity counts as "the bot") differs - so
// the raw fetch itself happens at most once per PR per run instead of being
// repeated.
//
// checkPR() opens one AsyncLocalStorage run with a fresh Map and everything
// it calls - postComment(), getExistingBotComments(), the cleanup - picks
// that same Map up automatically through commentsCacheStorage.getStore(),
// with no cache argument threaded through any of their signatures. This is
// what AsyncLocalStorage is for: request-scoped state that many functions
// down a call tree need, without every one of them taking and forwarding an
// extra parameter just to pass it along (easy to forget at some future call
// site, which would silently turn caching off there). A call made outside
// any checkPR() run - postComment() used on its own, or a direct call in
// tests - simply finds no store, so it gets no caching: the original,
// always-fresh behavior for a one-off call.
//
// Like the identity lookups above, a cache entry holds the in-flight fetch,
// so callers that overlap share one fetch, and a failed fetch evicts itself
// so the next caller gets a real retry instead of a cached error.
//
// `fresh: true` always hits GitHub and replaces the cache entry. Only the
// post-write duplicate cleanup uses it: that check exists specifically to
// catch a comment a DIFFERENT, concurrent run posted at the same time, so it
// must see GitHub's real state right now, not a snapshot a write could have
// made stale. The fresh result then becomes the new cache entry, so later
// reads in the same run (e.g. a second postComment() call) still get a hit.
// This only orders a stale fetch's own FAILURE against a newer one's success
// (see the eviction guard below) - two fresh:true fetches for the same PR
// that both succeed settle on whichever happens to finish last, same as any
// cache with concurrent writers. That is fine for the one real caller:
// checkPR()'s own AsyncLocalStorage scope never reads a PR's comments twice
// in parallel, so this never actually arises there - `cache` is exposed as
// a plain parameter mainly so tests can exercise the caching on its own,
// without a whole checkPR() run.
// ---------------------------------------------------------------------------
const commentsCacheStorage = new AsyncLocalStorage();

async function fetchAllIssueComments(
  prNumber,
  { fresh = false, cache, botLoginPromise },
) {
  if (!cache) return fetchAllIssueCommentsUncached(prNumber, botLoginPromise);
  if (!fresh) {
    const entry = cache.get(prNumber);
    if (entry !== undefined) return entry.promise;
  }
  // `entry` (a plain object), not the fetch promise itself, is what goes in
  // the cache and what the eviction check below compares by reference. A
  // static analyzer reasonably assumes a bare Promise sitting in a `===`
  // check was meant to be awaited; wrapping it sidesteps that false read
  // without changing what's actually being asked: "is this still MY fetch,
  // or did a newer one already replace it?"
  const entry = {
    promise: fetchAllIssueCommentsUncached(prNumber, botLoginPromise),
  };
  cache.set(prNumber, entry);
  try {
    return await entry.promise;
  } catch (e) {
    // Don't leave a failed page load cached - the next caller should get a
    // real retry, not the same error forever. Guarded by identity: `cache`
    // is a plain exported parameter, not something only checkPR() ever
    // touches, so a concurrent `fresh: true` call sharing this same cache
    // may already have replaced this entry with a newer (and possibly
    // already-succeeded) fetch by the time this older one rejects. Only
    // remove the entry if it's still the one this call itself set.
    if (cache.get(prNumber) === entry) cache.delete(prNumber);
    throw e;
  }
}

// Whether a comment's AUTHENTICATED identity - GitHub's own user.login /
// user.type on the comment - could possibly be a bot comment, under either
// `anyBotIdentity` value. Deliberately the union of both: this is also the
// cache-admission gate below, and admitting anything broader than this union
// would let an attacker's comment BODY (fully attacker-controlled on a
// public PR, unlike user.login/user.type) decide what sits in this run's
// memory.
//
// `anyBotIdentity` itself is a broader match, used only for checkPR()'s
// history check and never for postComment()'s dedupe, which stays strict to
// the current identity. Without it, switching GITHUB_TOKEN to a PAT or
// another App token would hide comments posted under the old identity, and
// a PR that was blocked before the switch would look as if it never was.
//
// `type === "Bot"` is set by GitHub and an ordinary account cannot fake it.
// The DEFAULT_BOT_LOGIN check is a fallback for the common plain
// GITHUB_TOKEN case in case `type` is missing. Neither covers a switch from
// one PAT-owned account to another, since both look like ordinary users.
// That limit is documented in CHANGELOG.md.
function isPossiblyBotIdentity(user, botLogin) {
  return (
    user.login === botLogin ||
    user.type === "Bot" ||
    user.login === DEFAULT_BOT_LOGIN
  );
}

// A public PR can carry comments from untrusted contributors in unbounded
// number and size, so this run's cache must never hold more than the bot's
// own small, bounded set of comments - not every human comment's full
// GitHub payload for the whole life of the run. Two things keep it small:
//
// - Only a comment that BOTH carries BOT_MARKER AND has an authenticated
//   identity isPossiblyBotIdentity() accepts is ever kept at all. The
//   identity half is what actually makes this safe: BOT_MARKER alone is
//   just a literal HTML comment, and any contributor can paste it into
//   their own comment on a public PR - user.login/user.type are set by
//   GitHub from who is actually authenticated as posting, which a commenter
//   cannot forge by editing their comment body. A spoofed marker on an
//   ordinary human comment fails this check and is never cached - getting
//   past it would mean already controlling the bot's own account.
// - Only the few fields the rest of this file ever reads from a comment
//   (id, body, user.login, user.type) are kept, not the full GitHub object
//   (timestamps, URLs, avatar, reactions, and so on).
async function fetchAllIssueCommentsUncached(prNumber, botLoginPromise) {
  const all = [];
  let page = 1;
  for (;;) {
    const comments = await gh(
      `/repos/${REPO_OWNER}/${REPO_NAME}/issues/${encodeURIComponent(prNumber)}/comments?per_page=100&page=${page}`,
      GITHUB_TOKEN,
    );
    if (!comments.length) break;
    // Resolved once, reused for every page (botLogin cannot change mid-run -
    // resolveBotLogin() caches it for the whole process). Not awaited until
    // here so the caller can start this fetch and resolveBotLogin() at the
    // same time instead of one after the other.
    const botLogin = await botLoginPromise;
    all.push(
      ...comments
        .filter(
          (c) =>
            c.user &&
            c.body &&
            c.body.includes(BOT_MARKER) &&
            isPossiblyBotIdentity(c.user, botLogin),
        )
        .map((c) => ({
          id: c.id,
          body: c.body,
          user: { login: c.user.login, type: c.user.type },
        })),
    );
    if (comments.length < 100) break;
    page += 1;
  }
  return all;
}

// Drops one comment id from the current run's cached list, if this PR's list
// is cached. Used right after that comment is deleted, so a later read in
// the same run doesn't show a comment that is already gone. Only ever
// called after the list was itself just fetched successfully (see
// dedupeIdenticalTrailingComments's own `fresh: true` read), so the cached
// entry's promise here is already resolved.
async function forgetCachedComment(prNumber, commentId) {
  const cache = commentsCacheStorage.getStore();
  const entry = cache && cache.get(prNumber);
  if (!entry) return;
  const list = await entry.promise;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].id === commentId) list.splice(i, 1);
  }
}

// `cache` is normally left to default to whatever checkPR() set up for this
// run (undefined outside of one, which correctly means "no caching"). Tests
// can still pass a Map explicitly to exercise the caching in isolation,
// without going through checkPR().
async function getExistingBotComments(
  prNumber,
  {
    anyBotIdentity = false,
    fresh = false,
    cache = commentsCacheStorage.getStore(),
  } = {},
) {
  // Not awaited yet - started so it overlaps with the comments fetch below
  // (which needs it too, to decide what's even safe to cache - see
  // isPossiblyBotIdentity()) instead of adding its own separate round trip.
  const botLoginPromise = resolveBotLogin();
  const [botLogin, all] = await Promise.all([
    botLoginPromise,
    fetchAllIssueComments(prNumber, { fresh, cache, botLoginPromise }),
  ]);
  // Already the broad match (see isPossiblyBotIdentity() above).
  if (anyBotIdentity) return all;
  // Narrow further, to just the current identity.
  return all.filter((c) => c.user.login === botLogin);
}

async function postComment(prNumber, body, dedupe = true) {
  // postComment() is exported, so it checks its own input.
  assertValidPRNumber(prNumber, "postComment(prNumber)");
  const full = `${BOT_MARKER}\n${body}`;
  if (dedupe) {
    const existing = await getExistingBotComments(prNumber);
    // Compare with the latest bot comment of the same category, not just the
    // latest bot comment. checkPR() can post a personal thank-you ("other")
    // and then the pending list ("pending") back to back, so a later pending
    // comment would otherwise be compared with someone else's thank-you.
    const category = classifyBotComment(full);
    const lastOfCategory = existing.findLast(
      (c) => classifyBotComment(c.body) === category,
    );
    if (lastOfCategory && lastOfCategory.body === full) return; // unchanged
  }
  await gh(
    `/repos/${REPO_OWNER}/${REPO_NAME}/issues/${encodeURIComponent(prNumber)}/comments`,
    GITHUB_TOKEN,
    {
      method: "POST",
      body: JSON.stringify({ body: full }),
    },
  );

  if (dedupe) {
    // Best-effort. The comment is already posted, so a cleanup failure must
    // not fail the run.
    try {
      await dedupeIdenticalTrailingComments(prNumber, full);
    } catch (e) {
      console.warn(
        `::warning::Duplicate-comment cleanup failed (non-fatal, the comment itself was already posted): ${e.message}`,
      );
    }
  }
}

// The "no matching comment yet, so post" check in postComment() is two HTTP
// calls with nothing atomic between them, so two concurrent runs can both
// post. This cannot prevent that, but it cleans up right after: it finds the
// bot comments with the same body and deletes all but the newest. Running it
// twice, or deleting an already deleted comment (404), is harmless. The
// `concurrency:` group in the consumer workflow is what really closes the
// race. This is the backstop for when it is missing.
async function dedupeIdenticalTrailingComments(prNumber, body) {
  // fresh: true - this is the check for what a concurrent run may have
  // posted in the meantime, so it must not settle for whatever was cached
  // before this run's own post above.
  const comments = await getExistingBotComments(prNumber, { fresh: true });
  const matching = comments
    .filter((c) => c.body === body)
    .sort((a, b) => a.id - b.id);
  // Keep the newest (highest id), delete the rest.
  const duplicates = matching.slice(0, -1);
  if (duplicates.length > 0) {
    // Only for visibility, so a workflow without a proper `concurrency:` group
    // does not go unnoticed. Logged before the deletes so it also shows when a
    // delete fails. Contains the count and PR number only.
    console.warn(
      `::warning::Found ${duplicates.length} duplicate bot comment(s) on PR #${prNumber} and removing them - two runs likely posted the same comment at the same time. If this keeps happening, check that the consuming workflow sets the \`concurrency:\` group shown in examples/consumer-workflow.yml (see SECURITY.md).`,
    );
  }
  // Each delete targets its own comment id, so they don't depend on each
  // other - run them together instead of one after another. Every branch
  // below already catches its own error, so one failing delete can never
  // make Promise.all reject or stop the others.
  await Promise.all(
    duplicates.map(async (dup) => {
      try {
        await gh(
          `/repos/${REPO_OWNER}/${REPO_NAME}/issues/comments/${encodeURIComponent(dup.id)}`,
          GITHUB_TOKEN,
          { method: "DELETE" },
        );
        await forgetCachedComment(prNumber, dup.id);
      } catch (e) {
        // It may already be gone, or the token may lack permission. This is
        // cosmetic cleanup, so do not fail the run.
        console.warn(
          `::warning::Could not delete duplicate comment ${dup.id}: ${e.message}`,
        );
      }
    }),
  );
}

async function setStatus(sha, state, description) {
  await gh(
    `/repos/${REPO_OWNER}/${REPO_NAME}/statuses/${encodeURIComponent(sha)}`,
    GITHUB_TOKEN,
    {
      method: "POST",
      // GitHub shows only the latest status per context, so a repeat is
      // harmless and gh() may retry.
      idempotent: true,
      body: JSON.stringify({
        state,
        description: description.slice(0, 140),
        context: STATUS_CONTEXT,
      }),
    },
  );
}

async function lockPR(prNumber) {
  try {
    // lockPR() is exported too. Validating inside the try treats a bad number
    // like any other lock failure: logged, never thrown.
    assertValidPRNumber(prNumber, "lockPR(prNumber)");
    await gh(
      `/repos/${REPO_OWNER}/${REPO_NAME}/issues/${encodeURIComponent(prNumber)}/lock`,
      GITHUB_TOKEN,
      {
        method: "PUT",
        body: JSON.stringify({ lock_reason: "resolved" }),
      },
    );
  } catch (e) {
    // Nice to have, not part of CLA correctness. Log and move on.
    console.warn(`::warning::Could not lock PR #${prNumber}: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Core: evaluate one PR and bring its status and comment up to date
//
// Options:
//
// quietIfNeverFlagged (passed as true only by the automatic
// pull_request_target handler). When the PR is fully signed, post a comment
// only if the PR was blocked at some point:
//   - A new PR whose authors had all signed already gets no comment. The
//     status is still set to success, because merge protection reads that.
//   - If a "pending" comment was ever posted, the move to fully signed is
//     announced. This compares the latest "pending" comment with the latest
//     "success" one, so a second block and resolve cycle is announced again
//     and an unchanged result stays quiet.
//   - A personal reply such as "you already signed" does not count as a block.
// A human trigger (the sign phrase or `recheck`) always gets an answer, so
// those callers leave this off. The usual same-category dedupe in
// postComment() still applies.
//
// signer ({ id, login }, passed only by handleIssueComment right after it
// recorded a new signature). It changes who the bot addresses, not the
// pass/fail logic:
//   - PR still not clear: a separate "@signer Thank you for signing" comment
//     comes first, then the pending list.
//   - PR now fully signed and the signer is one of its required authors: the
//     signer is thanked by name instead of the generic success message.
//   - PR fully signed but the signer is allowlisted or has no commit on the
//     PR: the generic success message. Crediting them would be misleading.
//
// statusOnly (passed only for the "already signed" reply). Update the status
// check and return without any comment. That person's other PR may have a
// stale status from before they signed, but a full check would also post a
// new pending or success comment each time they resend the phrase.
//
// knownSignatures (passed only by handleIssueComment, with what
// writeSignatures() just returned). It is merged with checkPR()'s own fresh
// read, see mergeSignatures(). The fresh read alone can miss the write that
// just happened, and the snapshot alone can miss a signature written by
// another run meanwhile.
// ---------------------------------------------------------------------------
async function checkPR(
  prNumber,
  headSha,
  {
    quietIfNeverFlagged = false,
    signer = null,
    statusOnly = false,
    knownSignatures = null,
  } = {},
) {
  assertValidPRNumber(prNumber, "checkPR(prNumber)");
  // One run, one comments cache: see the comment above commentsCacheStorage
  // for what this buys and why it is scoped this way, not at module level.
  // Everything this run calls - postComment(), getExistingBotComments(), the
  // cleanup inside it - picks this same Map up on its own.
  return commentsCacheStorage.run(new Map(), () =>
    checkPRBody(prNumber, headSha, {
      quietIfNeverFlagged,
      signer,
      statusOnly,
      knownSignatures,
    }),
  );
}

async function checkPRBody(
  prNumber,
  headSha,
  { quietIfNeverFlagged, signer, statusOnly, knownSignatures },
) {
  if (!headSha) {
    const pr = await gh(
      `/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${encodeURIComponent(prNumber)}`,
      GITHUB_TOKEN,
    );
    headSha = assertValidSha(
      pr.head.sha,
      `GitHub API response for GET /repos/${REPO_OWNER}/${REPO_NAME}/pulls/${prNumber} (.head.sha)`,
    );
  } else {
    assertValidSha(headSha, "checkPR(headSha)");
  }

  // listPRCommitAuthors() can be slow on a big PR, so the store is read after
  // it, when it is most likely to have changed. This narrows the race with
  // other runs but does not close it. The consumer workflow's `concurrency:`
  // group does. The read is needed even with `knownSignatures`, see
  // mergeSignatures().
  const { authors, unresolved } = await listPRCommitAuthors(prNumber);
  const { data: freshData, index: freshIndex } = await withSignaturesToken(
    (sigToken) => readSignatures(sigToken),
  );
  const data = mergeSignatures(knownSignatures, freshData);
  // Index once, then one O(1) probe per author. mergeSignatures() returns
  // `freshData` itself when there was nothing to merge (the usual automatic
  // path), and then readSignatures() has already built the index.
  const signed =
    data === freshData ? freshIndex : new SignatureIndex(data.signatures);
  const missing = authors.filter(
    (a) => !isAllowlisted(a) && !isSigned(signed, a),
  );

  if (missing.length === 0 && unresolved.length === 0) {
    await setStatus(
      headSha,
      "success",
      "All contributors have signed the CLA.",
    );
    if (statusOnly) return;
    if (quietIfNeverFlagged) {
      // Comments come back oldest first, so the last match per category is
      // the latest one. Success is announced only when a pending comment is
      // newer than the last success comment (or there is none yet).
      const existing = await getExistingBotComments(prNumber, {
        anyBotIdentity: true,
      });
      const lastPendingIdx = existing.findLastIndex(
        (c) => classifyBotComment(c.body) === "pending",
      );
      const lastSuccessIdx = existing.findLastIndex(
        (c) => classifyBotComment(c.body) === "success",
      );
      if (lastPendingIdx <= lastSuccessIdx) return;
    }
    // Name the signer only when their signature completed this PR, never just
    // because a `signer` was passed. See signerCompletedRequirement().
    await postComment(
      prNumber,
      signerCompletedRequirement(authors, signer)
        ? personalSuccessMessage(signer.login)
        : SUCCESS_MESSAGE,
    );
    return;
  }

  const lines = [PENDING_MARKER];
  if (missing.length) {
    lines.push(
      `The following contributor(s) ${NEEDS_SIGN_FRAGMENT} [CLA](${CLA_DOCUMENT_URL}) before this PR can be merged:`,
      "",
    );
    missing.forEach((a) => lines.push(`- @${a.login}`));
    lines.push(
      "",
      "Please comment on this PR with **exactly** the following text to sign:",
      "",
      `> ${SIGN_PHRASE}`,
      "",
      "Signing once covers **all** FOSSASIA repositories - you will not be asked again.",
    );
  }
  if (unresolved.length) {
    // No email here, since it can be personal data and this comment is
    // public. The SHA is on the PR's Commits tab, which is enough for a
    // maintainer to find the commit.
    const shaList = unresolved.map((sha) => sha.slice(0, 7)).join(", ");
    const n = unresolved.length;
    lines.push(
      "",
      `⚠️ ${n} commit${n === 1 ? "" : "s"} ${NEEDS_REVIEW_FRAGMENT} to a GitHub account. A maintainer will need to verify ${n === 1 ? "it" : "them"} manually: ${shaList}`,
    );
  }

  await setStatus(
    headSha,
    "failure",
    missing.length
      ? `${missing.length} contributor(s) need to sign the CLA`
      : "Manual verification needed",
  );
  if (statusOnly) return;
  if (signer) {
    // The PR is not clear yet, but this person did just sign. Acknowledge it
    // in its own comment, so one comment says "your signature was recorded"
    // and the next says where the PR stands.
    await postComment(
      prNumber,
      `@${signer.login} Thank you for signing the CLA! We look forward to your contributions.`,
    );
  }
  await postComment(prNumber, lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------
function isPrivileged(payload, commenter) {
  // The PR author can always recheck their own PR. Otherwise GitHub's
  // author_association already tells us the commenter's role, no API call
  // needed.
  const prAuthor =
    payload.issue && payload.issue.user && payload.issue.user.login;
  if (prAuthor && prAuthor.toLowerCase() === commenter.toLowerCase())
    return true;

  const association = payload.comment && payload.comment.author_association;
  return ["OWNER", "MEMBER", "COLLABORATOR"].includes(association);
}

async function handleIssueComment(payload) {
  if (!payload.issue || !payload.issue.pull_request) return; // plain issue, not a PR
  if (
    !payload.comment ||
    !payload.comment.user ||
    typeof payload.comment.user.login !== "string" ||
    payload.comment.user.login.length === 0
  ) {
    // A real issue_comment event always has comment.user. Fail with a clear
    // message instead of a TypeError. An empty login is rejected as well,
    // since isSigned() never matches it and every attempt would append a new
    // entry.
    throw new Error(
      "issue_comment payload is missing comment.user.login (or it is empty) - malformed or unexpected webhook delivery.",
    );
  }
  const prNumber = assertValidPRNumber(
    payload.issue.number,
    "issue_comment payload issue.number",
  );
  const body = (payload.comment.body || "").trim();
  const commenter = payload.comment.user.login;

  if (body.toLowerCase() === SIGN_PHRASE.toLowerCase()) {
    // Record the numeric id, not just the login, so the signature survives a
    // username change. Validated here, before any network call and only on
    // this branch, so a bad id cannot break `recheck`, which never uses it.
    const commenterId = assertValidUserId(
      payload.comment.user.id,
      "issue_comment payload comment.user.id",
    );
    const commenterIdentity = { id: commenterId, login: commenter };

    // The check and the append run inside one mutate() on data that
    // writeSignatures() has just re-read. That keeps signing idempotent when a
    // webhook is delivered twice or the 409 retry re-runs this closure.
    let alreadySigned = false;
    const writtenSignatures = await withSignaturesToken((sigToken) =>
      writeSignatures(
        sigToken,
        (data, index) => {
          if (isSigned(index, commenterIdentity)) {
            alreadySigned = true;
            return null; // no write needed
          }
          return {
            ...data,
            signatures: [
              ...data.signatures,
              {
                id: commenterId,
                login: commenter,
                pr: `${REPO_OWNER}/${REPO_NAME}#${prNumber}`,
                commentUrl: payload.comment.html_url,
                signedAt: new Date().toISOString(),
              },
            ],
          };
        },
        `${commenter} signed the CLA`,
      ),
    );

    if (alreadySigned) {
      // Deduped by default, so repeating the phrase does not get a new reply
      // each time.
      await postComment(
        prNumber,
        `@${commenter} you have already signed the CLA. Nothing more to do here.`,
      );
      // This PR's status may be stale, since they may have signed through a
      // different PR after it was last set. Fix it without another comment.
      await checkPR(prNumber, undefined, {
        statusOnly: true,
        knownSignatures: writtenSignatures,
      });
      return;
    }

    // Re-evaluate now that one more person has signed. `signer` makes
    // checkPR() thank this person by name, and `knownSignatures` stops its own
    // read from hiding the write that just happened, which would list them as
    // still needing to sign.
    await checkPR(prNumber, undefined, {
      signer: commenterIdentity,
      knownSignatures: writtenSignatures,
    });
    return;
  }

  if (body.toLowerCase() === "recheck") {
    // recheck costs Actions minutes, so it is limited to the PR author and
    // people with a role in the repo. Signing stays open to everyone, because
    // first-time contributors must be able to sign.
    if (!isPrivileged(payload, commenter)) return;
    await checkPR(prNumber);
  }
}

async function handlePullRequestTarget(payload) {
  if (!payload.pull_request) {
    // A real pull_request_target event always has this.
    throw new Error(
      "pull_request_target payload is missing pull_request - malformed or unexpected webhook delivery.",
    );
  }
  const prNumber = assertValidPRNumber(
    payload.pull_request.number,
    "pull_request_target payload pull_request.number",
  );
  if (payload.action === "closed" && payload.pull_request.merged) {
    await lockPR(prNumber);
    return;
  }
  if (["opened", "synchronize", "reopened"].includes(payload.action)) {
    const headSha = assertValidSha(
      payload.pull_request.head && payload.pull_request.head.sha,
      "pull_request_target payload pull_request.head.sha",
    );
    // Automatic trigger, not a direct question, so stay quiet on a clean
    // result unless the PR was blocked before. See checkPR().
    await checkPR(prNumber, headSha, { quietIfNeverFlagged: true });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function main() {
  validateConfig();
  if (!EVENT_PATH || !fs.existsSync(EVENT_PATH)) {
    fail(
      `GITHUB_EVENT_PATH not found (${EVENT_PATH}). This script must run inside a GitHub Actions job.`,
    );
  }
  const payload = JSON.parse(fs.readFileSync(EVENT_PATH, "utf8"));

  if (EVENT_NAME === "issue_comment" && payload.action === "created") {
    await handleIssueComment(payload);
  } else if (EVENT_NAME === "pull_request_target") {
    await handlePullRequestTarget(payload);
  } else {
    console.log(
      `Nothing to do for event "${EVENT_NAME}" / action "${payload.action}".`,
    );
  }
}

// Run only when executed directly, not when the tests require this file.
if (require.main === module) {
  main().catch((e) => fail(e.stack || e.message));
}

// Exported for tests only, not part of the action's public contract.
module.exports = {
  isSigned,
  SignatureIndex,
  isAllowlisted,
  parseAllowlist,
  createAppJWT,
  ghRaw,
  base64url,
  readSignatures,
  writeSignatures,
  isPrivileged,
  handleIssueComment,
  handlePullRequestTarget,
  checkPR,
  getSignaturesToken,
  withSignaturesToken,
  resolveSigTokenExpiry,
  SIG_TOKEN_LIFETIME_MS,
  SIG_TOKEN_REFRESH_SKEW_MS,
  postComment,
  validateConfig,
  lockPR,
  findSigPathProblem,
  encodeRepoPath,
  sigInstallationApiPath,
  sigContentsApiPath,
  assertValidPRNumber,
  assertValidInstallationId,
  assertValidUserId,
  assertValidSha,
  classifyBotComment,
  personalSuccessMessage,
  isSameContributor,
  mergeSignatures,
  signerCompletedRequirement,
  extractCoAuthors,
  fail,
  getExistingBotComments,
  resolveUserIdByLogin,
  resolveLoginById,
  setStatus,
};
