/**
 * GitHub Action for checking CLA signatures on pull requests.
 *
 * Security rules to preserve:
 * - Signatures and allowlist entries match numeric GitHub ids.
 * - PR authors come from GitHub's compare API, not the signer comment.
 * - Signature writes use a short-lived App token when configured.
 * - Requests have timeouts, retries are bounded, and writes handle conflicts.
 * - Unresolved authors are flagged without exposing their email addresses.
 * - Statuses are checked against a fixed base/head pair and corrected if it
 *   changes during publication. Request budgets apply to the whole run.
 *
 * See SECURITY.md for the limits and deployment requirements.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
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

// Config (all values come from env vars set by action.yml)
const GITHUB_API = process.env.GITHUB_API_URL || "https://api.github.com";
const GITHUB_SERVER_URL = process.env.GITHUB_SERVER_URL || "https://github.com";
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
// Limit distinct co-author identities per run. Excess trailers need manual
// review. The budget is shared across all pair rechecks; it counts identities,
// while MAX_GITHUB_TOKEN_REQUESTS_PER_RUN below counts actual requests.
const MAX_COAUTHOR_LOOKUPS_PER_RUN = 300;

// Hard per-event ceiling for actual GITHUB_TOKEN requests, including retries.
// The emergency reserve is part of this limit. GitHub's hourly limit is shared
// across runs, so this does not guarantee the repository stays below it.
// App installation token requests have a separate quota.
const MAX_GITHUB_TOKEN_REQUESTS_PER_RUN = 700;

// Reserved for failClosedStatus() so budget exhaustion cannot block recovery.
const GITHUB_TOKEN_EMERGENCY_RESERVE = 10;

const [REPO_OWNER, REPO_NAME] = (process.env.GITHUB_REPOSITORY || "/").split(
  "/",
);
const EVENT_NAME = process.env.GITHUB_EVENT_NAME;
const EVENT_PATH = process.env.GITHUB_EVENT_PATH;
// These bounded URL inputs come from GitHub's event context in action.yml.
// Keep them separate from the file-backed payload so event file data cannot
// flow into API request URLs.
const EVENT_PR_NUMBER = process.env.CLA_BOT_EVENT_PR_NUMBER;
const EVENT_HEAD_SHA = process.env.CLA_BOT_EVENT_HEAD_SHA;
const EVENT_BASE_SHA = process.env.CLA_BOT_EVENT_BASE_SHA;

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

// GitHub user/org names: letters, digits and single hyphens, no leading or
// trailing hyphen, at most 39 characters.
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
// Repo names: letters, digits, ".", "-", "_", up to 100 characters.
const GITHUB_REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

// Validate event values before using them in URLs or signature records.
// Safe-integer checks avoid precision loss from JSON.parse().
function assertValidPRNumber(value, context) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `${context}: expected a positive integer issue/PR number, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function assertValidEventPRNumber(value, context) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  return assertValidPRNumber(parsed, context);
}

function parseGitHubServerUrl(serverUrl) {
  let server;
  try {
    server = new URL(serverUrl);
  } catch {
    throw new Error(
      "GITHUB_SERVER_URL must be an HTTP(S) URL without credentials",
    );
  }
  if (!/^https?:$/.test(server.protocol) || server.username || server.password) {
    throw new Error("GITHUB_SERVER_URL must be an HTTP(S) URL without credentials");
  }
  return server;
}

function buildCommentUrl(prNumber, commentId, serverUrl = GITHUB_SERVER_URL) {
  if (!Number.isSafeInteger(commentId) || commentId <= 0) return undefined;
  const server = parseGitHubServerUrl(serverUrl);
  return new URL(
    `/${encodeURIComponent(REPO_OWNER)}/${encodeURIComponent(REPO_NAME)}/pull/${prNumber}#issuecomment-${commentId}`,
    server.origin,
  ).href;
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

// True for exactly what a real GitHub account id looks like: a positive
// integer that survives Number without losing precision. Shared by
// assertValidUserId() (throws) and resolveCoAuthorEmail() (fails closed
// instead of throwing, since a bad trailer must never crash the run).
function isValidGitHubUserId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

// This id is written to the signature store, and isSigned() matches by id
// only when both sides are numbers. A bad id would not be rejected later, it
// would just never match, and JSON.stringify drops an undefined id without
// any sign. So fail before anything is written.
function assertValidUserId(value, context) {
  if (!isValidGitHubUserId(value)) {
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

// Signature repo settings become URL path segments. Normalize the supported
// `./` and trailing-whitespace cases, reject ambiguous paths, then encode each
// segment. URL builders validate too because they are exported helpers.
// Never allowed in SIG_PATH: backslash, "?", "#", "%" and control characters.
// Control characters are blocked because the URL parser strips some of them
// and because the value is echoed into "::error::" log lines.
const SIG_PATH_UNSAFE_CHAR_RE = /[\\?#%\x00-\x1f\x7f-\x9f]/;

// Remove trailing ASCII whitespace and ASCII whitespace hiding a leading `./`.
// Other leading whitespace remains part of the filename.
function normalizeSigPath(raw) {
  let p = raw || "signatures/cla.json";
  let end = p.length;
  while (end > 0) {
    const code = p.charCodeAt(end - 1);
    const isAsciiWhitespace =
      code === 0x20 || (code >= 0x09 && code <= 0x0d);
    if (!isAsciiWhitespace) break;
    end -= 1;
  }
  p = p.slice(0, end);
  while (true) {
    let leadingWhitespaceEnd = 0;
    while (leadingWhitespaceEnd < p.length) {
      const code = p.charCodeAt(leadingWhitespaceEnd);
      const isAsciiWhitespace =
        code === 0x20 || (code >= 0x09 && code <= 0x0d);
      if (!isAsciiWhitespace) break;
      leadingWhitespaceEnd += 1;
    }
    if (p.startsWith("./", leadingWhitespaceEnd)) {
      p = p.slice(leadingWhitespaceEnd + 2);
    } else {
      break;
    }
  }
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

  try {
    parseGitHubServerUrl(GITHUB_SERVER_URL);
  } catch (error) {
    fail(error.message);
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
      `::warning::SIG_PATH ${JSON.stringify(SIG_PATH_RAW)} was normalized to ${JSON.stringify(SIG_PATH)} (trailing ASCII whitespace and ASCII whitespace before a leading "./" are ignored). Update the "signatures-path" input to the normalized value to silence this.`,
    );
  }
  if (ALLOWLIST.invalid.length) {
    fail(
      `ALLOWLIST entries must be numeric GitHub account ids (usernames are not supported - they can be renamed and reclaimed by someone else); invalid: ${ALLOWLIST.invalid.map((e) => JSON.stringify(e)).join(", ")}. Look an id up with: gh api users/NAME --jq .id`,
    );
  }
  // App auth is optional, but its credentials must be configured as a pair.
  // Otherwise a typo silently selects the GITHUB_TOKEN fallback and can make
  // cross-repository writes fail much later.
  if (Boolean(SIG_APP_ID) !== Boolean(SIG_APP_PRIVATE_KEY)) {
    fail(
      "SIG_APP_ID and SIG_APP_PRIVATE_KEY must either both be set or both be empty (both empty uses GITHUB_TOKEN fallback).",
    );
  }
  // GitHub App IDs are positive decimal identifiers. Reject malformed values
  // here instead of producing an invalid JWT issuer and failing at the API.
  // Compare the matched text with the full input instead of using `$`, which
  // also matches before a final JavaScript line terminator.
  const appIdMatch = /^[1-9][0-9]*/.exec(SIG_APP_ID);
  if (SIG_APP_ID && (!appIdMatch || appIdMatch[0] !== SIG_APP_ID)) {
    fail("SIG_APP_ID must be a positive integer in decimal form.");
  }
  // A key that is set must look like a PEM, so a mis-pasted secret fails
  // clearly instead of deep inside crypto.sign().
  if (SIG_APP_PRIVATE_KEY && !SIG_APP_PRIVATE_KEY.includes("-----BEGIN")) {
    fail(
      'SIG_APP_PRIVATE_KEY is set but does not look like a PEM-encoded private key (missing a "-----BEGIN" header).',
    );
  }
}

// Store one request budget per async event so overlapping calls cannot share
// or reset each other's counters. Direct helper calls outside a budget remain
// untracked.
const _githubTokenRequestBudget = new AsyncLocalStorage();

// Reuse an active event budget; otherwise start one with the recovery reserve
// included in the maximum.
function runWithGitHubTokenRequestBudget(max, emergencyReserve, fn) {
  if (_githubTokenRequestBudget.getStore()) return fn();
  return _githubTokenRequestBudget.run(
    { remaining: max - emergencyReserve, emergencyReserve },
    fn,
  );
}

// Count one GITHUB_TOKEN request attempt. Recovery writes use the reserve
// first; App installation token requests are not counted here.
function consumeGitHubTokenRequest(token, { emergency = false } = {}) {
  if (token !== GITHUB_TOKEN) return;
  const store = _githubTokenRequestBudget.getStore();
  if (!store) return; // not tracking - no active run, or a direct call/test
  if (emergency && store.emergencyReserve > 0) {
    store.emergencyReserve -= 1;
    return;
  }
  if (store.remaining <= 0) {
    const err = new Error(
      `This run's GITHUB_TOKEN request budget (${MAX_GITHUB_TOKEN_REQUESTS_PER_RUN}) is exhausted - refusing to send more requests this run, to stay within GitHub's 1,000 requests/hour/repository limit. This is a hard safety ceiling and is not expected in normal operation; comment \`recheck\` to try again.`,
    );
    err.budgetExhausted = true;
    throw err;
  }
  store.remaining -= 1;
}

function buildSafeApiUrl(path, apiBase = GITHUB_API) {
  const reject = () => {
    const value =
      typeof path === "string" ? JSON.stringify(path) : `<${typeof path}>`;
    throw new Error(
      `Refusing to build a request URL from an unsafe path: ${value}`,
    );
  };
  const rejectBase = () => {
    throw new Error(
      "GITHUB_API_URL must be an absolute HTTP(S) URL without credentials, query, or fragment.",
    );
  };
  if (
    typeof path !== "string" ||
    path.length < 2 ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[\\#\s\x00-\x1f\x7f-\x9f]/u.test(path) ||
    /%(?![0-9a-f]{2})/i.test(path)
  ) {
    reject();
  }
  if (
    typeof apiBase !== "string" ||
    apiBase.length === 0 ||
    apiBase.includes("?") ||
    apiBase.includes("#")
  ) {
    rejectBase();
  }
  const requestPath = path.split("?", 1)[0];
  for (const segment of requestPath.split("/")) {
    // The URL parser treats encoded dot segments as path navigation too.
    const dotSegment = segment.replace(/%2e/gi, ".");
    if (dotSegment === "." || dotSegment === "..") reject();
  }

  let base;
  try {
    base = new URL(apiBase);
  } catch {
    rejectBase();
  }
  if (
    (base.protocol !== "http:" && base.protocol !== "https:") ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    rejectBase();
  }

  let request;
  try {
    const baseHref = base.href.replace(/\/+$/, "");
    request = new URL(`${baseHref}${path}`);
  } catch {
    reject();
  }
  if (
    request.origin !== base.origin ||
    request.username ||
    request.password
  ) {
    reject();
  }

  return request.href;
}

// HTTP helper: timeout, JSON handling and a retry for transient failures
// (rate limits, brief 5xx). 409 conflicts on writes are handled in
// writeSignatures(), since they need a re-read, not a blind retry.
async function ghRaw(path, token, options = {}) {
  const requestUrl = buildSafeApiUrl(path);
  // Count each attempt here, including retries and direct ghRaw() calls.
  consumeGitHubTokenRequest(token, { emergency: options.emergency === true });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const fetchOptions = { ...options };
  delete fetchOptions.preserveUnsafeIds;
  try {
    const res = await fetch(requestUrl, {
      ...fetchOptions,
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
    const jsonText = options.preserveUnsafeIds
      ? preserveUnsafeJsonIds(text)
      : text;
    const data = jsonText ? JSON.parse(jsonText) : null;
    // Only list calls ask for the Link header (see listCommitsBetween()).
    return options.withLink ? { data, link: readLinkHeader(res) } : data;
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

// Independent reads share a limit of eight concurrent requests. Writes stay
// serialized, and a read holds its slot through retries.
const GITHUB_READ_CONCURRENCY = 8;

// Gives back run(task). A task starts when fewer than `maxConcurrent` are
// running, in the order they were added. A task that throws counts as a
// rejection.
function createLimiter(maxConcurrent) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < maxConcurrent && queue.length > 0) {
      const { task, resolve, reject } = queue.shift();
      active += 1;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };
  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      pump();
    });
}

const limitReads = createLimiter(GITHUB_READ_CONCURRENCY);

// Use this for any read that might overlap with another one. Reads that never
// overlap (like the signatures file) can call gh() directly.
const ghRead = (path, token, options) =>
  limitReads(() => gh(path, token, options));

// A set of reads that belong together (the pages of one list). If one of them
// fails, abort() stops the rest from starting: reads already in flight finish,
// but queued ones fail without sending a request, so a failed list doesn't keep
// spending GitHub calls on a result we will throw away.
function createReadGroup() {
  let aborted = false;
  return {
    read: (path, token, options) =>
      limitReads(() => {
        if (aborted) throw new Error("read cancelled: an earlier read failed");
        // Mark the group as failed right away, inside the task, so the next
        // queued read sees it before it starts (not after Promise.all settles).
        return gh(path, token, options).catch((err) => {
          aborted = true;
          throw err;
        });
      }),
    abort: () => {
      aborted = true;
    },
  };
}

// Runs all the reads in the group together. If one fails, the group is aborted
// and the first error is rethrown.
function allOrAbort(group, promises) {
  return Promise.all(promises).catch((err) => {
    group.abort();
    throw err;
  });
}

// Use the first page's Link header to fetch remaining pages concurrently.
// Without a usable header, walk pages in order. Lists over 10,000 commits fail.
const LIST_PAGE_SIZE = 100;
// The most pages one list read will ever fetch (10,000 items).
const MAX_LIST_PAGES = 100;

// Real responses always have headers; this just avoids a crash on a bare one.
function readLinkHeader(res) {
  return res.headers && typeof res.headers.get === "function"
    ? res.headers.get("link")
    : null;
}

// GitHub omits Link entirely when a list fits on one page. A valid, complete
// header with no `next` relation is authoritative even if a page was
// shortened by concurrent edits. Missing or malformed metadata is unknown,
// so callers fall back to the traditional page-size check.
function hasNextPage(linkHeader) {
  if (typeof linkHeader !== "string" || linkHeader.trim() === "") return null;

  // Split link-values only at commas outside both angle-bracket targets and
  // quoted parameter values. A comma inside title="..." is data, not a
  // second link. The grammar parser below rejects unbalanced delimiters, so
  // an unterminated quote cannot make a partial parse authoritative.
  const parts = [];
  let start = 0;
  let inTarget = false;
  let inQuote = false;
  let escaped = false;
  for (let i = 0; i < linkHeader.length; i += 1) {
    const char = linkHeader[i];
    if (inQuote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inQuote = false;
      continue;
    }
    if (char === '"' && !inTarget) inQuote = true;
    else if (char === "<" && !inTarget) inTarget = true;
    else if (char === ">" && inTarget) inTarget = false;
    else if (char === "," && !inTarget) {
      parts.push(linkHeader.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(linkHeader.slice(start).trim());
  if (parts.some((part) => !part)) return null;

  let sawNext = false;
  for (const part of parts) {
    let i = 0;
    const skipWhitespace = () => {
      while (part[i] === " " || part[i] === "\t") i += 1;
    };
    skipWhitespace();
    if (part[i] !== "<") return null;
    const targetEnd = part.indexOf(">", i + 1);
    if (
      targetEnd === -1 ||
      /[<>\s\x00-\x1f\x7f]/.test(part.slice(i + 1, targetEnd))
    ) {
      return null;
    }
    i = targetEnd + 1;
    let relValue = null;
    skipWhitespace();
    while (i < part.length) {
      if (part[i] !== ";") return null;
      i += 1;
      skipWhitespace();
      const name = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+/.exec(part.slice(i));
      if (!name) return null;
      i += name[0].length;
      const parameterName = name[0].toLowerCase();
      skipWhitespace();
      let value = null;
      if (part[i] === "=") {
        i += 1;
        skipWhitespace();
        if (part[i] === '"') {
          i += 1;
          let quoted = "";
          let closed = false;
          while (i < part.length) {
            const char = part[i++];
            if (char === "\\") {
              quoted += part[i++];
            } else if (char === '"') {
              closed = true;
              break;
            } else if (/[\x00-\x1f\x7f]/.test(char)) {
              return null;
            } else {
              quoted += char;
            }
          }
          if (!closed) return null;
          value = quoted;
        } else {
          const token = /^[!#$%&'*+.^_`|~0-9A-Za-z:-]+/.exec(part.slice(i));
          if (!token) return null;
          value = token[0];
          i += value.length;
        }
      }
      if (parameterName === "rel") {
        if (relValue !== null || value === null || !value.trim()) return null;
        relValue = value;
      }
      skipWhitespace();
    }
    if (
      relValue !== null &&
      relValue.toLowerCase().split(/[ \t]+/).includes("next")
    ) {
      sawNext = true;
    }
  }
  return sawNext;
}

// GitHub serializes database IDs as JSON numbers. JSON.parse() rounds integer
// tokens above Number.MAX_SAFE_INTEGER, so preserve unsafe `id` fields as
// decimal strings on comment responses where exact IDs are used in decisions
// or DELETE URLs. This only changes numeric `id` properties, never JSON text
// inside string values.
function preserveUnsafeJsonIds(jsonText) {
  const maxSafeId = String(Number.MAX_SAFE_INTEGER);
  return jsonText.replace(
    /([,{]\s*)"id"(\s*:\s*)([1-9]\d*)(?=\s*[,}\]])/g,
    (match, prefix, separator, decimalId) => {
      const unsafe =
        decimalId.length > maxSafeId.length ||
        (decimalId.length === maxSafeId.length && decimalId > maxSafeId);
      return unsafe
        ? `${prefix}"id"${separator}${JSON.stringify(decimalId)}`
        : match;
    },
  );
}

function isUsableCommentId(id) {
  return (
    (Number.isSafeInteger(id) && id > 0) ||
    (typeof id === "string" && /^[1-9]\d*$/.test(id))
  );
}

function commentIdAsBigInt(id) {
  if (!isUsableCommentId(id)) return null;
  return BigInt(id);
}

function sameCommentId(left, right) {
  return (
    isUsableCommentId(left) &&
    isUsableCommentId(right) &&
    String(left) === String(right)
  );
}

// The last page number from a `Link` header, or null if it's missing or not a
// plain page number. Never throws. It does not apply MAX_LIST_PAGES, see
// assertWithinPageLimit(): a huge value is a reason to fail, not to ignore
// the header.
function parseLastPage(linkHeader) {
  if (typeof linkHeader !== "string") return null;
  for (const part of linkHeader.split(/,\s*(?=<)/)) {
    const target = /^\s*<([^>]*)>/.exec(part);
    const rel = /;\s*rel\s*=\s*"?([^";]*)"?/i.exec(part);
    if (!target || !rel) continue;
    if (!rel[1].toLowerCase().split(/\s+/).includes("last")) continue;
    let rawPage;
    try {
      rawPage = new URL(target[1], GITHUB_API).searchParams.get("page");
    } catch {
      return null; // not a URL at all
    }
    if (rawPage === null || !/^[1-9][0-9]*$/.test(rawPage)) return null;
    const page = Number(rawPage);
    return Number.isSafeInteger(page) ? page : null;
  }
  return null;
}

// Fails when a read would need more than MAX_LIST_PAGES pages. Used for both
// a page count the server claims and the page we are about to walk to.
function assertWithinPageLimit(label, pages) {
  if (pages > MAX_LIST_PAGES) {
    throw new Error(
      `${label}: needs more than ${MAX_LIST_PAGES} pages of ${LIST_PAGE_SIZE}, which is more than we read, so the list cannot be trusted.`,
    );
  }
}

// A response that isn't a list counts as an empty page.
const asList = (value) => (Array.isArray(value) ? value : []);

// Compare two fixed SHAs so a force-push cannot change the commit list mid-read.
// Pagination also avoids the 250-commit limit of the PR commits endpoint.
async function listCommitsBetween(baseSha, headSha, token) {
  const basehead = `${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}`;
  const pageUrl = (page) =>
    `/repos/${REPO_OWNER}/${REPO_NAME}/compare/${basehead}?per_page=${LIST_PAGE_SIZE}&page=${page}`;
  const first = await ghRead(pageUrl(1), token, { withLink: true });
  // This list decides who signed, so it must be provably complete. GitHub's
  // own total is the check, and it has to be a real count: a whole number, not
  // negative. Anything else fails before we page any further.
  const totalCommits = first.data ? first.data.total_commits : undefined;
  if (!Number.isSafeInteger(totalCommits) || totalCommits < 0) {
    throw new Error(
      `GitHub returned no valid total_commits (${String(totalCommits)}) between ${baseSha} and ${headSha}, so the commit list cannot be verified as complete.`,
    );
  }
  const items = asList(first.data && first.data.commits);

  const label = `compare ${baseSha}...${headSha}`;
  // total_commits determines how many pages are required and is checked
  // before any fan-out. The Link header is only a pagination hint: if its
  // last-page value disagrees with the count, walk the count-derived range
  // sequentially rather than trusting either an under-reported or an
  // over-reported page count.
  const expectedPages = Math.ceil(totalCommits / LIST_PAGE_SIZE);
  assertWithinPageLimit(label, expectedPages);
  const lastPage = parseLastPage(first.link);
  if (lastPage === expectedPages && expectedPages > 1) {
    const group = createReadGroup();
    const rest = await allOrAbort(
      group,
      Array.from({ length: expectedPages - 1 }, (_, i) => i + 2).map(async (n) =>
        asList((await group.read(pageUrl(n), token)).commits),
      ),
    );
    for (const pageItems of rest) items.push(...pageItems);
  } else if (expectedPages > 1) {
    // With no usable Link header, or a Link/count disagreement, total_commits
    // gives the exact expected range. Stop at that count rather than guessing
    // from whether a page is full: a full page 100 is ambiguous at the
    // 10,000-commit boundary. A short page ends early; the final total check
    // below rejects that incomplete read.
    let page = 1;
    let lastPageSize = items.length;
    while (items.length < totalCommits && lastPageSize === LIST_PAGE_SIZE) {
      page += 1;
      assertWithinPageLimit(label, page);
      const pageItems = asList((await ghRead(pageUrl(page), token)).commits);
      items.push(...pageItems);
      lastPageSize = pageItems.length;
    }
  }

  if (items.length !== totalCommits) {
    throw new Error(
      `GitHub reported ${totalCommits} commit(s) between ${baseSha} and ${headSha}, but pagination returned ${items.length}.`,
    );
  }

  // A matching item count alone does not prove the pages contain distinct
  // commits: a repeated page could hide another contributor while preserving
  // the count. Commit SHAs are the stable identities across pages, so require
  // each item to carry one and reject duplicates before authors are derived.
  const seenShas = new Set();
  for (const item of items) {
    const sha = item && typeof item.sha === "string" ? item.sha : "";
    if (!sha || sha.trim() !== sha) {
      throw new Error(
        `GitHub returned a commit without a valid SHA between ${baseSha} and ${headSha}, so the commit list cannot be verified as complete.`,
      );
    }
    const identity = sha.toLowerCase();
    if (seenShas.has(identity)) {
      throw new Error(
        `GitHub returned duplicate commit SHA ${sha} between ${baseSha} and ${headSha}, so the commit list cannot be verified as complete.`,
      );
    }
    seenShas.add(identity);
  }
  return items;
}

// GitHub App: mint a short-lived installation token
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

// Cache token expiry, refresh shortly before it, and retry once after a 401.
// Concurrent callers share an in-flight mint.
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

// Index numeric signature ids once so repeated membership checks are O(1).
// Invalid ids are ignored, and each index represents one data snapshot.
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

// Signature store (a JSON file in the central private repo)
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

    // Keep malformed entries to avoid deleting old records. Warn by position
    // only, and index valid numeric ids regardless of the login field.
    const index = new SignatureIndex([]);
    data.signatures.forEach((entry, position) => {
      if (
        !entry ||
        typeof entry.login !== "string" ||
        entry.login.length === 0
      ) {
        console.warn(
          `::warning::Signature entry at index ${position} is missing/has an invalid "login" field (kept as-is; any valid numeric id is still used for matching) - check ${SIG_OWNER}/${SIG_REPO}/${SIG_PATH}`,
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

// Match by numeric id only. Accept an index for repeated lookups or a plain
// signatures object for one-off checks; malformed data fails closed.
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

// Merge the signing run's write result with a fresh read. This covers stale
// reads on either side; fresh entries take precedence when ids match.
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

// Repo-local helpers (comments, status, lock). These always use GITHUB_TOKEN,
// never the signatures token.
// Noreply addresses include an account id for newer accounts. Older
// addresses include only a login, which must be resolved through GitHub.
const NEW_NOREPLY =
  /^([1-9][0-9]{0,15})\+([^@]+)@users\.noreply\.github\.com$/i;
const OLD_NOREPLY = /^([^@+]+)@users\.noreply\.github\.com$/i;

// Cache lookup promises so concurrent callers share requests. Failures resolve
// to null and stay cached for this process, which handles one event per run.
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
    const user = await ghRead(
      `/users/${encodeURIComponent(login)}`,
      GITHUB_TOKEN,
    );
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
    const user = await ghRead(`/user/${encodeURIComponent(id)}`, GITHUB_TOKEN);
    if (user && typeof user.login === "string" && user.login.length > 0) {
      return user.login;
    }
  } catch {
    // 404 (deleted account or unknown id) or a transient failure: unresolved.
  }
  return null;
}

// Parse co-author trailers, resolve them through GitHub, and preserve order.
// Unresolved entries are flagged for review; raw email addresses are not kept.
function parseCoAuthorEmails(commitMessage) {
  const emails = [];
  let capped = false;
  const trailerRegex = /^co-authored-by:\s*.+?<([^>]+)>\s*$/gim;
  const seen = new Set();
  let match;
  while ((match = trailerRegex.exec(commitMessage || "")) !== null) {
    const email = match[1].trim();
    const key = email.toLowerCase();
    if (seen.has(key)) continue; // repeated trailer, skip the second lookup
    if (seen.size >= MAX_COAUTHOR_TRAILERS_PER_COMMIT) {
      // Past the cap: stop looking up and flag the commit for a human.
      capped = true;
      break;
    }
    seen.add(key);
    emails.push(email);
  }
  return { emails, capped };
}

// One trailer address to { id, login }, or null when it cannot be resolved to
// a GitHub account (the caller flags the commit for manual review).
async function resolveCoAuthorEmail(email) {
  const newStyle = email.match(NEW_NOREPLY);
  if (newStyle) {
    const claimedId = Number(newStyle[1]);
    // Reject ids that cannot be represented safely as a JavaScript number.
    if (isValidGitHubUserId(claimedId)) {
      // Ignore the login text in the trailer and ask GitHub for the real one.
      const authoritativeLogin = await resolveLoginById(claimedId);
      if (authoritativeLogin !== null) {
        return { id: claimedId, login: authoritativeLogin };
      }
      // The id matches no current account, so fall through.
    }
  }

  // Older addresses contain only a login, so renamed accounts may not resolve.
  const oldStyle = email.match(OLD_NOREPLY);
  if (oldStyle) {
    const login = oldStyle[1];
    const id = await resolveUserIdByLogin(login);
    if (id !== null) return { id, login };
    // The lookup failed (for example a deleted account), so fall through.
  }

  return null;
}

// Limit distinct co-author lookup identities across a run. Repeated keys use
// one slot; an omitted limit keeps the helper usable on its own.
function createLookupBudget(max = Infinity) {
  const seen = new Set();
  return {
    admit(key) {
      if (seen.has(key)) return true;
      if (seen.size >= max) return false;
      seen.add(key);
      return true;
    },
  };
}

// Use the parsed account identity as the budget key. Unsupported addresses
// do not trigger a lookup and need no slot.
function coAuthorLookupKey(email) {
  const newStyle = email.match(NEW_NOREPLY);
  if (newStyle) {
    const claimedId = Number(newStyle[1]);
    // An id that can never be real costs no lookup (see resolveCoAuthorEmail),
    // so it needs no budget slot either.
    return isValidGitHubUserId(claimedId) ? `id:${claimedId}` : null;
  }
  const oldStyle = email.match(OLD_NOREPLY);
  if (oldStyle) {
    // Logins are case-insensitive on GitHub, same normalization as the
    // resolver's own cache (_userIdLookups).
    return `login:${oldStyle[1].toLowerCase()}`;
  }
  return null;
}

async function extractCoAuthors(commitMessage, budget = createLookupBudget()) {
  const { emails, capped } = parseCoAuthorEmails(commitMessage);
  // Exclude trailers that exceed the shared run-wide lookup budget.
  const admitted = [];
  let budgetExceeded = false;
  for (const email of emails) {
    const key = coAuthorLookupKey(email);
    if (key === null) {
      // Doesn't match a format resolveCoAuthorEmail can look up, so it costs
      // no request either way - let it through without touching the budget.
      admitted.push(email);
      continue;
    }
    if (budget.admit(key)) {
      admitted.push(email);
    } else {
      budgetExceeded = true;
    }
  }
  // The resolvers never reject (see the note on the identity lookups), and
  // the shared limiter keeps the number of requests in flight bounded.
  const resolved = await Promise.all(admitted.map(resolveCoAuthorEmail));
  return {
    authors: resolved.filter((a) => a !== null),
    hasUnresolved: capped || budgetExceeded || resolved.includes(null),
  };
}

// A merge commit is skipped: whoever merged did not write the change.
function isMergeCommit(c) {
  return Array.isArray(c.parents) && c.parents.length > 1;
}

// Compare exact SHAs. checkPR() passes one lookup budget through every retry.
async function listPRCommitAuthors(
  baseSha,
  headSha,
  lookupBudget = createLookupBudget(MAX_COAUTHOR_LOOKUPS_PER_RUN),
) {
  // Keyed by account id, so someone who is author on one commit and co-author
  // on another counts once.
  const authors = new Map();
  // Commits flagged for manual review, by SHA only (public, no personal data).
  const unresolvedShas = new Set();
  const commits = await listCommitsBetween(baseSha, headSha, GITHUB_TOKEN);
  // Look up all the co-authors at once. The limiter keeps it to 8 at a time,
  // and an account credited on several commits is only looked up once. The
  // results are applied below in commit order, so names come out in the same
  // order as before. One budget is shared across every commit in this run
  // (not one per commit), so it caps the run's total identity lookups, not
  // just each commit's: see MAX_COAUTHOR_LOOKUPS_PER_RUN.
  const coAuthorResults = await Promise.all(
    commits.map((c) =>
      isMergeCommit(c)
        ? null
        : extractCoAuthors(c.commit?.message, lookupBudget),
    ),
  );
  commits.forEach((c, i) => {
    if (isMergeCommit(c)) return;

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

    const { authors: coAuthors, hasUnresolved } = coAuthorResults[i];
    coAuthors.forEach((a) => authors.set(a.id, a));
    if (hasUnresolved) unresolvedShas.add(c.sha);
  });
  return {
    authors: [...authors.values()],
    unresolved: [...unresolvedShas],
  };
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
    const me = await ghRead("/user", GITHUB_TOKEN);
    if (me && me.login) return me.login;
  } catch {
    // Expected for the standard GITHUB_TOKEN.
  }
  return DEFAULT_BOT_LOGIN;
}

// Keep only increasing comment ids. This avoids treating a repeated item from
// shifting pages as a duplicate comment.
function createAscendingIdFilter() {
  let last = null;
  return (id) => {
    const comparable = commentIdAsBigInt(id);
    if (comparable === null || (last !== null && comparable <= last)) {
      return false;
    }
    last = comparable;
    return true;
  };
}

// Each PR gets one comment snapshot per checkPR() run. The cache is shared by
// history and dedupe checks, and this run's writes update it. Direct calls
// outside checkPR() stay uncached. Duplicate cleanup fetches fresh history
// after a post. Consumers must serialize runs per PR; see SECURITY.md.
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
  // Keep the entry identity so an older failure cannot evict a newer fetch.
  const entry = {
    promise: fetchAllIssueCommentsUncached(prNumber, botLoginPromise),
  };
  cache.set(prNumber, entry);
  try {
    return await entry.promise;
  } catch (e) {
    // Allow a retry, but preserve any newer fetch that replaced this entry.
    if (cache.get(prNumber) === entry) cache.delete(prNumber);
    throw e;
  }
}

// Match GitHub-authenticated identity fields, never the user-controlled
// comment body. The broad match preserves history across token identity
// changes; dedupe still uses the current identity. PAT-to-PAT changes cannot
// be recognized because both accounts appear as ordinary users.
function isPossiblyBotIdentity(user, botLogin) {
  return (
    user.login === botLogin ||
    user.type === "Bot" ||
    user.login === DEFAULT_BOT_LOGIN
  );
}

// Bound cached bot comments even if another Bot-type account posts markers.
const MAX_CACHED_COMMENTS = 200;

// Cache recent marked bot comments. Sequence counters preserve pending and
// success history when older comments are trimmed.
async function fetchAllIssueCommentsUncached(prNumber, botLoginPromise) {
  const all = [];
  let seq = 0;
  let lastPendingSeq = -1;
  let lastSuccessSeq = -1;
  // Keep the latest body per category for the current bot identity.
  const latestOwnBodyByCategory = Object.create(null);
  const takeId = createAscendingIdFilter();
  const label = `issue comments for PR #${prNumber}`;
  let page = 1;
  for (;;) {
    assertWithinPageLimit(label, page);
    // ghRead(), not gh(): this runs alongside the bot-login lookup (see
    // getExistingBotComments()), and every read that can overlap another
    // shares the one limiter. The pages themselves are still read one at a
    // time, see the note above.
    const response = await ghRead(
      `/repos/${REPO_OWNER}/${REPO_NAME}/issues/${encodeURIComponent(prNumber)}/comments?sort=created&direction=asc&per_page=100&page=${page}`,
      GITHUB_TOKEN,
      { preserveUnsafeIds: true, withLink: true },
    );
    const { data: comments, link } = response;
    if (!comments.length) break;
    // Resolved once, reused for every page (botLogin cannot change mid-run -
    // resolveBotLogin() caches it for the whole process). Not awaited until
    // here so the caller can start this fetch and resolveBotLogin() at the
    // same time instead of one after the other.
    const botLogin = await botLoginPromise;
    for (const c of comments) {
      // A repeat (or out-of-order entry) from a list that changed mid-read
      // is not a second comment - see createAscendingIdFilter().
      if (!takeId(c.id)) continue;
      if (
        !c.user ||
        !c.body ||
        !c.body.includes(BOT_MARKER) ||
        !isPossiblyBotIdentity(c.user, botLogin)
      ) {
        continue;
      }
      const category = classifyBotComment(c.body);
      if (category === "pending") lastPendingSeq = seq;
      else if (category === "success") lastSuccessSeq = seq;
      seq += 1;
      if (c.user.login === botLogin) {
        latestOwnBodyByCategory[category] = c.body;
      }
      all.push({
        id: c.id,
        body: c.body,
        user: { login: c.user.login, type: c.user.type },
      });
    }
    // Trimmed here, inside the loop, not just once at the end - otherwise a
    // large flood could still blow up peak memory while it's being read,
    // even if the final cached result would have ended up small.
    if (all.length > MAX_CACHED_COMMENTS) {
      all.splice(0, all.length - MAX_CACHED_COMMENTS);
    }
    const hasNext = hasNextPage(link);
    if (hasNext === false || (hasNext === null && comments.length < 100)) {
      break;
    }
    page += 1;
  }
  return {
    comments: all,
    lastPendingSeq,
    lastSuccessSeq,
    nextSeq: seq,
    latestOwnBodyByCategory,
  };
}

// Check whether the latest pending comment is newer than the latest success.
async function pendingIsNewerThanSuccess(prNumber) {
  const cache = commentsCacheStorage.getStore();
  const botLoginPromise = resolveBotLogin();
  const { lastPendingSeq, lastSuccessSeq } = await fetchAllIssueComments(
    prNumber,
    { cache, botLoginPromise },
  );
  return lastPendingSeq > lastSuccessSeq;
}

// Return this bot identity's latest comment body in the requested category.
async function latestOwnCommentBody(prNumber, category) {
  const cache = commentsCacheStorage.getStore();
  const botLoginPromise = resolveBotLogin();
  const { latestOwnBodyByCategory } = await fetchAllIssueComments(prNumber, {
    cache,
    botLoginPromise,
  });
  return latestOwnBodyByCategory[category];
}

// Tests may pass a cache explicitly; checkPR() supplies its run-scoped cache.
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
  const [botLogin, { comments: all }] = await Promise.all([
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
  // Compare with the latest bot comment of the same category, not just the
  // latest bot comment. checkPR() can post a personal thank-you ("other")
  // and then the pending list ("pending") back to back, so a later pending
  // comment would otherwise be compared with someone else's thank-you.
  const category = classifyBotComment(full);
  if (dedupe) {
    const lastBody = await latestOwnCommentBody(prNumber, category);
    if (lastBody === full) return; // unchanged
  }
  const createdComment = await gh(
    `/repos/${REPO_OWNER}/${REPO_NAME}/issues/${encodeURIComponent(prNumber)}/comments`,
    GITHUB_TOKEN,
    {
      method: "POST",
      preserveUnsafeIds: true,
      body: JSON.stringify({ body: full }),
    },
  );

  // Keep the run-scoped snapshot current after our own write, even when this
  // call disabled duplicate detection. This is our own API-confirmed comment.
  try {
    await rememberOwnPostedComment(prNumber, category, full, createdComment);
  } catch (e) {
    console.warn(
      `::warning::Could not update the run-scoped comment cache after posting (non-fatal): ${e.message}`,
    );
  }

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

// See the comment above where this is called, in postComment().
async function rememberOwnPostedComment(prNumber, category, body, comment) {
  const cache = commentsCacheStorage.getStore();
  const entry = cache && cache.get(prNumber);
  if (!entry) return;
  const history = await entry.promise;
  const { comments, latestOwnBodyByCategory } = history;
  latestOwnBodyByCategory[category] = body;
  if (!comment || !isUsableCommentId(comment.id)) {
    // Without the API's comment ID we cannot safely patch the list. Force the
    // next read to fetch GitHub instead of returning a known-stale snapshot.
    if (cache.get(prNumber) === entry) cache.delete(prNumber);
    return;
  }
  if (comments.some((cached) => sameCommentId(cached.id, comment.id))) return;
  if (category === "pending") history.lastPendingSeq = history.nextSeq;
  else if (category === "success") history.lastSuccessSeq = history.nextSeq;
  history.nextSeq += 1;
  const botLogin = await resolveBotLogin();
  comments.push({
    id: comment.id,
    body,
    user: {
      login: (comment.user && comment.user.login) || botLogin,
      type: comment.user && comment.user.type,
    },
  });
  if (comments.length > MAX_CACHED_COMMENTS) {
    comments.splice(0, comments.length - MAX_CACHED_COMMENTS);
  }
}

// Limit parallel duplicate deletions to reduce secondary rate-limit risk.
const MAX_CONCURRENT_DELETES = 10;

async function deleteDuplicateComment(prNumber, dup) {
  try {
    await gh(
      `/repos/${REPO_OWNER}/${REPO_NAME}/issues/comments/${encodeURIComponent(dup.id)}`,
      GITHUB_TOKEN,
      { method: "DELETE" },
    );
    await forgetDeletedCachedComment(prNumber, dup.id);
  } catch (e) {
    if (e.status === 404) {
      // The comment is already absent, so the snapshot must not keep it.
      await forgetDeletedCachedComment(prNumber, dup.id);
      return;
    }
    // This is cosmetic cleanup, so a permission or network failure is non-fatal.
    console.warn(
      `::warning::Could not delete duplicate comment ${dup.id}: ${e.message}`,
    );
  }
}

// Keep the run-scoped snapshot in sync with comment deletions this run
// successfully made. Other writers remain outside the cache's snapshot.
async function forgetDeletedCachedComment(prNumber, commentId) {
  const cache = commentsCacheStorage.getStore();
  const entry = cache && cache.get(prNumber);
  if (!entry) return;
  const { comments } = await entry.promise;
  const index = comments.findIndex((comment) =>
    sameCommentId(comment.id, commentId),
  );
  if (index !== -1) comments.splice(index, 1);
}

// Scan full history because the regular cache is capped. Save matching ids to
// a temporary file, then delete after pagination so page offsets stay stable.
// The scan stops at MAX_LIST_PAGES.
async function findExactDuplicateComments(prNumber, body) {
  const botLogin = await resolveBotLogin();
  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "cla-bot-dedupe-"),
  );
  const idsPath = path.join(tempDir, "matching-comment-ids.txt");
  let file;
  try {
    file = await fs.promises.open(idsPath, "w", 0o600);
    let page = 1;
    let count = 0;
    let bufferedIds = "";
    // A comment the listing returns twice must not be counted twice: it
    // would look like a duplicate of itself, and the cleanup would delete the
    // only copy. See createAscendingIdFilter().
    const takeId = createAscendingIdFilter();
    const label = `issue comments for PR #${prNumber} duplicate cleanup`;
    for (;;) {
      assertWithinPageLimit(label, page);
      const response = await gh(
        `/repos/${REPO_OWNER}/${REPO_NAME}/issues/${encodeURIComponent(prNumber)}/comments?sort=created&direction=asc&per_page=100&page=${page}`,
        GITHUB_TOKEN,
        { preserveUnsafeIds: true, withLink: true },
      );
      const { data: comments, link } = response;
      if (!comments.length) break;
      for (const c of comments) {
        if (
          c.user &&
          c.user.login === botLogin &&
          c.body === body &&
          isUsableCommentId(c.id) &&
          takeId(c.id)
        ) {
          bufferedIds += `${String(c.id)}\n`;
          count += 1;
          // Keep the write buffer fixed-size even for pathological histories.
          if (count % 1000 === 0) {
            await file.writeFile(bufferedIds);
            bufferedIds = "";
          }
        }
      }
      const hasNext = hasNextPage(link);
      if (hasNext === false || (hasNext === null && comments.length < 100)) {
        break;
      }
      page += 1;
    }
    if (bufferedIds) await file.writeFile(bufferedIds);
    await file.close();
    file = undefined;
    return { tempDir, idsPath, count };
  } catch (error) {
    if (file) await file.close().catch(() => {});
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

// A fresh scan catches duplicates posted by concurrent runs. Keep the newest
// exact match and delete earlier ones in bounded batches.
async function dedupeIdenticalTrailingComments(prNumber, body) {
  const { tempDir, idsPath, count } = await findExactDuplicateComments(
    prNumber,
    body,
  );
  const duplicateCount = Math.max(0, count - 1);
  try {
    if (duplicateCount > 0) {
      console.warn(
        `::warning::Found ${duplicateCount} duplicate bot comment(s) on PR #${prNumber} and removing them - two runs likely posted the same comment at the same time. If this keeps happening, check that the consuming workflow sets the \`concurrency:\` group shown in examples/consumer-workflow.yml (see SECURITY.md).`,
      );
      const lines = readline.createInterface({
        input: fs.createReadStream(idsPath),
        crlfDelay: Infinity,
      });
      let previousId;
      let batch = [];
      for await (const line of lines) {
        const id = line;
        if (!isUsableCommentId(id)) {
          throw new Error(
            "Duplicate comment cleanup encountered an invalid ID in its temporary file.",
          );
        }
        if (previousId !== undefined) {
          batch.push({ id: previousId });
          if (batch.length === MAX_CONCURRENT_DELETES) {
            await Promise.all(
              batch.map((dup) => deleteDuplicateComment(prNumber, dup)),
            );
            batch = [];
          }
        }
        previousId = id;
      }
      if (batch.length) {
        await Promise.all(
          batch.map((dup) => deleteDuplicateComment(prNumber, dup)),
        );
      }
    }
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

// emergency: true marks this write as the one failClosedStatus() makes to
// recover from an already-published, now-uncertain status - see
// GITHUB_TOKEN_EMERGENCY_RESERVE and consumeGitHubTokenRequest(). Every
// other caller leaves it false and competes for the normal budget like any
// other request.
async function setStatus(sha, state, description, { emergency = false } = {}) {
  await gh(
    `/repos/${REPO_OWNER}/${REPO_NAME}/statuses/${encodeURIComponent(sha)}`,
    GITHUB_TOKEN,
    {
      method: "POST",
      // GitHub shows only the latest status per context, so a repeat is
      // harmless and gh() may retry.
      idempotent: true,
      emergency,
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

// Reads the PR's current head and base SHA in one request.
async function fetchPRSnapshot(prNumber) {
  const pr = await ghRead(
    `/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${encodeURIComponent(prNumber)}`,
    GITHUB_TOKEN,
  );
  const headSha = assertValidSha(
    pr.head.sha,
    `GitHub API response for GET /repos/${REPO_OWNER}/${REPO_NAME}/pulls/${prNumber} (.head.sha)`,
  );
  const baseSha = assertValidSha(
    pr.base.sha,
    `GitHub API response for GET /repos/${REPO_OWNER}/${REPO_NAME}/pulls/${prNumber} (.base.sha)`,
  );
  return { headSha, baseSha };
}

// Maximum pair evaluations when the PR changes during a check.
const MAX_PAIR_ATTEMPTS = 3;

// Evaluate the authors and signatures for one pair without publishing.
// checkPR() passes the same lookup budget through every retry.
async function evaluatePair(
  pair,
  knownSignatures,
  lookupBudget = createLookupBudget(MAX_COAUTHOR_LOOKUPS_PER_RUN),
) {
  const { authors, unresolved } = await listPRCommitAuthors(
    pair.baseSha,
    pair.headSha,
    lookupBudget,
  );
  // Read signatures after the commit list. The workflow serializes runs, and
  // the fresh read also merges any signature written by this event.
  const { data: freshData, index: freshIndex } = await withSignaturesToken(
    (sigToken) => readSignatures(sigToken),
  );
  const data = mergeSignatures(knownSignatures, freshData);
  // Reuse the fresh index unless merging created a new signature object.
  const signed =
    data === freshData ? freshIndex : new SignatureIndex(data.signatures);
  const missing = authors.filter(
    (a) => !isAllowlisted(a) && !isSigned(signed, a),
  );
  return { authors, unresolved, missing };
}

// Best-effort failure status. Log recovery errors so they do not hide the
// original failure.
async function failClosedStatus(headSha, description) {
  try {
    // emergency: true - this write exists specifically to recover from a
    // status that's already published and now uncertain, so it must not be
    // blocked by the very budget exhaustion that may have triggered it. See
    // GITHUB_TOKEN_EMERGENCY_RESERVE.
    await setStatus(headSha, "failure", description, { emergency: true });
  } catch (e) {
    console.log(
      `::warning::Could not overwrite the status for ${headSha} while failing closed (${e.message}). It may still show a result that was never re-confirmed.`,
    );
  }
}

// Publish one evaluation. Report a successful status immediately so checkPR()
// can recover if a later comment or PR read fails.
async function publishEvaluation(
  prNumber,
  evaluation,
  { quietIfNeverFlagged, signer, statusOnly, onStatusPublished },
) {
  const { authors, unresolved, missing, headSha } = evaluation;

  if (missing.length === 0 && unresolved.length === 0) {
    await setStatus(
      headSha,
      "success",
      "All contributors have signed the CLA.",
    );
    if (onStatusPublished) onStatusPublished();
    if (statusOnly) return;
    // Success is announced only when a pending comment is newer than the
    // last success comment (or there is none yet) - see
    // pendingIsNewerThanSuccess() for why this stays correct no matter how
    // large the PR's comment history gets.
    if (quietIfNeverFlagged && !(await pendingIsNewerThanSuccess(prNumber))) {
      return;
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
  if (onStatusPublished) onStatusPublished();
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

// Evaluate one PR and update its status and comments.
//
// quietIfNeverFlagged suppresses automatic success comments unless the PR was
// previously blocked. signer personalizes the reply after a new signature;
// it does not affect the verdict. statusOnly updates the check without a
// comment. knownSignatures merges a just-written signature with a fresh read.
async function checkPR(
  prNumber,
  headSha,
  {
    quietIfNeverFlagged = false,
    signer = null,
    statusOnly = false,
    knownSignatures = null,
    eventBaseSha = null,
  } = {},
) {
  assertValidPRNumber(prNumber, "checkPR(prNumber)");
  // A headSha we were given is checked before any request is made.
  if (headSha) assertValidSha(headSha, "checkPR(headSha)");
  if (eventBaseSha) assertValidSha(eventBaseSha, "checkPR(eventBaseSha)");

  // Share lookup and request budgets across every pair recheck.
  const lookupBudget = createLookupBudget(MAX_COAUTHOR_LOOKUPS_PER_RUN);
  return runWithGitHubTokenRequestBudget(
    MAX_GITHUB_TOKEN_REQUESTS_PER_RUN,
    GITHUB_TOKEN_EMERGENCY_RESERVE,
    () =>
      commentsCacheStorage.run(new Map(), () =>
        checkPRInner(prNumber, headSha, {
          quietIfNeverFlagged,
          signer,
          statusOnly,
          knownSignatures,
          eventBaseSha,
          lookupBudget,
        }),
      ),
  );
}

async function checkPRInner(
  prNumber,
  headSha,
  { quietIfNeverFlagged, signer, statusOnly, knownSignatures, eventBaseSha, lookupBudget },
) {

  // Pin one base/head pair for the comparison. Recheck it before and after
  // publishing, since GitHub cannot make those steps atomic.
  const pinnedHead = headSha || null;
  let pair;
  if (pinnedHead && eventBaseSha) {
    pair = { baseSha: eventBaseSha, headSha };
  } else {
    const snapshot = await fetchPRSnapshot(prNumber);
    if (pinnedHead && snapshot.headSha !== pinnedHead) {
      // The caller named a head that is no longer the PR's head. Certify
      // nothing: the event for the current head checks it.
      console.log(
        `::notice::PR #${prNumber} is now at ${snapshot.headSha}, not ${pinnedHead}. Skipping ${pinnedHead}: the event for the current head checks it.`,
      );
      return;
    }
    pair = snapshot;
  }
  let settled = false;
  // Record a successful status write immediately. Later comment or read
  // failures must still trigger a conservative status update.
  let everPublished = false;
  let lastPublishedHeadSha = null;

  try {
    // settled only ever becomes true right before a `break` (see below), so
    // checking it here too would be redundant - the loop can only ever end
    // either by running out of attempts or by that `break`.
    for (let attempt = 1; attempt <= MAX_PAIR_ATTEMPTS; attempt++) {
      const result = await evaluatePair(pair, knownSignatures, lookupBudget);

      // Recheck the pair before publishing. A moved head is handled by its
      // event; a moved base is evaluated again here.
      const beforePublish = await fetchPRSnapshot(prNumber);
      if (pinnedHead && beforePublish.headSha !== pinnedHead) {
        console.log(
          `::notice::PR #${prNumber} is now at ${beforePublish.headSha}, not ${pinnedHead}. Not publishing for ${pinnedHead}: the event for the current head checks it.`,
        );
        return;
      }
      if (
        beforePublish.headSha !== pair.headSha ||
        beforePublish.baseSha !== pair.baseSha
      ) {
        pair = beforePublish;
        continue;
      }

      // No API can publish conditionally on the PR pair, so check once more
      // after publishing. A change after that read waits for another event.
      await publishEvaluation(
        prNumber,
        { ...result, headSha: pair.headSha },
        {
          quietIfNeverFlagged,
          signer,
          statusOnly,
          onStatusPublished: () => {
            everPublished = true;
            lastPublishedHeadSha = pair.headSha;
          },
        },
      );

      const afterPublish = await fetchPRSnapshot(prNumber);
      if (pinnedHead && afterPublish.headSha !== pinnedHead) {
        // The status belongs to the old head; its event checks the new one.
        settled = true;
        break;
      }
      if (
        afterPublish.headSha === pair.headSha &&
        afterPublish.baseSha === pair.baseSha
      ) {
        settled = true;
        break;
      }
      // The base moved onto the very same head while, or right after, we
      // published - the status we just wrote certified the old base, which
      // no longer matches this head. Go around again with the new pair
      // instead of leaving a status that no longer describes the PR.
      pair = afterPublish;
    }
  } catch (err) {
    if (everPublished && lastPublishedHeadSha) {
      // A later step failed before the status could be confirmed. Fail closed
      // and then preserve the original error.
      await failClosedStatus(
        lastPublishedHeadSha,
        "An error occurred while finishing this CLA check, so the previous result could not be confirmed; comment `recheck` to try again.",
      );
    }
    throw err;
  }

  if (!settled) {
    if (everPublished && lastPublishedHeadSha) {
      // Every post-publish check found a changed pair. Leave a failure status
      // instead of keeping a result already known to be stale.
      await failClosedStatus(
        lastPublishedHeadSha,
        "Could not confirm the CLA result stayed valid long enough to publish; comment `recheck` to try again.",
      );
    }
    throw new Error(
      `PR #${prNumber} kept changing while checkPR() tried to confirm and publish a result, across ${MAX_PAIR_ATTEMPTS} attempts. Comment \`recheck\` to try again.`,
    );
  }
}

// Event handlers
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

// Wraps the whole handler in one GITHUB_TOKEN request budget - see
// MAX_GITHUB_TOKEN_REQUESTS_PER_RUN. A signing comment reads and writes the
// signature store (with GITHUB_TOKEN, unless a separate App token is
// configured) before checkPR() is ever reached, so the budget has to start
// here, not inside checkPR(), to actually cover everything this event does.
async function handleIssueComment(payload) {
  return handleIssueCommentWithIdentifiers(payload, {
    prNumber: JSON.stringify(payload.issue && payload.issue.number),
  });
}

async function handleIssueCommentWithIdentifiers(payload, identifiers) {
  return runWithGitHubTokenRequestBudget(
    MAX_GITHUB_TOKEN_REQUESTS_PER_RUN,
    GITHUB_TOKEN_EMERGENCY_RESERVE,
    () => handleIssueCommentInner(payload, identifiers),
  );
}

async function handleIssueCommentInner(payload, identifiers) {
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
  const prNumber = assertValidEventPRNumber(
    identifiers.prNumber,
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
                commentUrl: buildCommentUrl(prNumber, payload.comment.id),
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

// See handleIssueComment() for why this budget is started at the handler,
// not inside checkPR().
async function handlePullRequestTarget(payload) {
  return handlePullRequestTargetWithIdentifiers(payload, {
    prNumber: JSON.stringify(payload.pull_request && payload.pull_request.number),
    headSha:
      payload.pull_request &&
      payload.pull_request.head &&
      payload.pull_request.head.sha,
    baseSha:
      payload.pull_request &&
      payload.pull_request.base &&
      payload.pull_request.base.sha,
  });
}

async function handlePullRequestTargetWithIdentifiers(payload, identifiers) {
  return runWithGitHubTokenRequestBudget(
    MAX_GITHUB_TOKEN_REQUESTS_PER_RUN,
    GITHUB_TOKEN_EMERGENCY_RESERVE,
    () => handlePullRequestTargetInner(payload, identifiers),
  );
}

async function handlePullRequestTargetInner(payload, identifiers) {
  if (!payload.pull_request) {
    // A real pull_request_target event always has this.
    throw new Error(
      "pull_request_target payload is missing pull_request - malformed or unexpected webhook delivery.",
    );
  }
  const prNumber = assertValidEventPRNumber(
    identifiers.prNumber,
    "pull_request_target payload pull_request.number",
  );
  if (payload.action === "closed" && payload.pull_request.merged) {
    await lockPR(prNumber);
    return;
  }
  // Handle only base edits. Title and body edits do not change the comparison.
  const isGenuineRetarget =
    payload.action === "edited" && payload.changes && payload.changes.base;
  if (
    ["opened", "synchronize", "reopened"].includes(payload.action) ||
    isGenuineRetarget
  ) {
    const headSha = assertValidSha(
      identifiers.headSha,
      "pull_request_target payload pull_request.head.sha",
    );
    // Automatic trigger, not a direct question, so stay quiet on a clean
    // result unless the PR was blocked before. See checkPR().
    const baseSha = assertValidSha(
      identifiers.baseSha,
      "pull_request_target payload pull_request.base.sha",
    );
    await checkPR(prNumber, headSha, {
      quietIfNeverFlagged: true,
      eventBaseSha: baseSha,
    });
  }
}

// Entry point
async function main() {
  validateConfig();
  if (!EVENT_PATH || !fs.existsSync(EVENT_PATH)) {
    fail(
      `GITHUB_EVENT_PATH not found (${EVENT_PATH}). This script must run inside a GitHub Actions job.`,
    );
  }
  const payload = JSON.parse(fs.readFileSync(EVENT_PATH, "utf8"));

  if (EVENT_NAME === "issue_comment" && payload.action === "created") {
    await handleIssueCommentWithIdentifiers(payload, {
      prNumber: EVENT_PR_NUMBER,
    });
  } else if (EVENT_NAME === "pull_request_target") {
    await handlePullRequestTargetWithIdentifiers(payload, {
      prNumber: EVENT_PR_NUMBER,
      headSha: EVENT_HEAD_SHA,
      baseSha: EVENT_BASE_SHA,
    });
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
  createLimiter,
  createReadGroup,
  allOrAbort,
  parseLastPage,
  hasNextPage,
  listPRCommitAuthors,
  SignatureIndex,
  isAllowlisted,
  parseAllowlist,
  createAppJWT,
  ghRaw,
  buildSafeApiUrl,
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
  normalizeSigPath,
  encodeRepoPath,
  sigInstallationApiPath,
  sigContentsApiPath,
  assertValidPRNumber,
  assertValidInstallationId,
  assertValidUserId,
  assertValidSha,
  buildCommentUrl,
  classifyBotComment,
  personalSuccessMessage,
  isSameContributor,
  mergeSignatures,
  signerCompletedRequirement,
  extractCoAuthors,
  createLookupBudget,
  MAX_COAUTHOR_LOOKUPS_PER_RUN,
  MAX_GITHUB_TOKEN_REQUESTS_PER_RUN,
  GITHUB_TOKEN_EMERGENCY_RESERVE,
  runWithGitHubTokenRequestBudget,
  fail,
  getExistingBotComments,
  pendingIsNewerThanSuccess,
  resolveUserIdByLogin,
  resolveLoginById,
  setStatus,
  isValidGitHubUserId,
  fetchPRSnapshot,
  listCommitsBetween,
  commentsCacheStorage,
};
