/**
 *
 * A self-contained GitHub Action that enforces CLA signing across every
 * FOSSASIA repository, backed by one central private signature store
 * (fossasia/cla-signatures). No npm dependencies - just Node's built-in
 * `fetch` and `crypto`.
 *
 * ── Security properties (read before changing anything below) ───────────
 * 1. Writes to the signatures repo use a short-lived GitHub App token,
 *    minted fresh each run. No long-lived PAT is ever stored.
 * 2. Everything else (comments, statuses) uses the job's own `GITHUB_TOKEN`,
 *    which has no access to the signatures repo - a leaked token can't
 *    reach it.
 * 3. A PR only counts as "signed" once every one of its real commit authors
 *    (looked up via the API, not whoever left the sign comment) is in the
 *    signature store. Someone else can't sign on a contributor's behalf.
 * 4. The allowlist is an exact, case-insensitive string match only - no
 *    wildcards, so nobody can dodge signing by naming themselves like a bot.
 * 5. Writes retry with a fresh read on HTTP 409, for when two repos' PRs
 *    write to the same file at once.
 * 6. Every request has a timeout, so a hung call can't stall the whole job.
 * 7. Signatures are keyed by the signer's numeric GitHub id, not their
 *    login. Logins can be renamed and reused by someone else later, so
 *    matching on login alone could hand an old signature to a new owner.
 *    See isSigned().
 * 8. A commit/co-author email that can't be resolved to an account never
 *    shows up in a comment or log - it can be personal data. Only the
 *    (already public) commit SHA is shown instead. See listPRCommitAuthors()
 *    and checkPR().
 * 9. GitHub matches a commit's author to an account by email, and that's
 *    spoofable: anyone can set their author email to
 *    id+victim@users.noreply.github.com, since both are public. GitHub also
 *    only ever verifies the committer, not the author, so a validly signed
 *    commit can still carry a forged author. REQUIRE_VERIFIED_COMMITS=true
 *    closes this by only trusting the author when that same account is also
 *    the verified committer - see listPRCommitAuthors().
 * 10. A Co-authored-by: trailer is free text - GitHub never authenticates
 *     it. What this bot does check is that the (id, login) pair it acts on
 *     really is one real account, resolved from GitHub itself rather than
 *     trusted from the trailer - otherwise someone could pair a real,
 *     already-signed id with a made-up login to sneak past the
 *     login-based allowlist check. It can't verify the named person
 *     actually agreed to be credited; nothing can, since GitHub doesn't
 *     ask.
 */

"use strict";

const fs = require("fs");
const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Node 18/20 are past End-of-Life, so we require 22+. Fail loudly here
// instead of hitting a confusing "fetch is not defined" later.
// ---------------------------------------------------------------------------
const [NODE_MAJOR] = process.versions.node.split(".").map(Number);
if (NODE_MAJOR < 22 || typeof fetch !== "function") {
  console.error(
    `::error::cla-bot requires Node.js >= 22 with global fetch (Node 18/20 are past End-of-Life). Detected ${process.version}.`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Config - all of this comes from env vars set by action.yml.
// ---------------------------------------------------------------------------
const GITHUB_API = process.env.GITHUB_API_URL || "https://api.github.com";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const SIG_APP_ID = process.env.SIG_APP_ID || "";
const SIG_APP_PRIVATE_KEY = process.env.SIG_APP_PRIVATE_KEY || "";
const SIG_OWNER = process.env.SIG_OWNER;
const SIG_REPO = process.env.SIG_REPO;
const SIG_PATH = process.env.SIG_PATH || "signatures/cla.json";
const CLA_DOCUMENT_URL = process.env.CLA_DOCUMENT_URL;
const ALLOWLIST = (process.env.ALLOWLIST || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SIGN_PHRASE = "I have read the CLA Document and I hereby sign the CLA";
const STATUS_CONTEXT = "cla/fossasia";
const BOT_MARKER = "<!-- fossasia-cla-bot:v1 -->";
// Embedded (in addition to BOT_MARKER) in the comment checkPR posts when a
// PR genuinely needs action - someone still needs to sign, or a commit
// needs manual review. Together with the two legacy text fragments below,
// this is how a later, automatically triggered checkPR call recognizes
// "this PR was actually blocked at some point" - see classifyBotComment()
// and quietIfNeverFlagged.
const PENDING_MARKER = "<!-- fossasia-cla-bot:pending -->";
// The exact fragments that appear in the "please sign" and "needs manual
// review" comment templates below (see the `lines` array in checkPR).
// Defined once and referenced from both the template text and
// classifyBotComment() so the two can never silently drift apart - and,
// importantly, so a PR blocked by an OLDER deployment of this bot (from
// before PENDING_MARKER existed, which only ever wrote this same wording)
// is still correctly recognized as having been blocked. PENDING_MARKER
// alone would miss those pre-existing comments entirely on the very first
// run of the upgraded code.
const NEEDS_SIGN_FRAGMENT = "need to sign our";
const NEEDS_REVIEW_FRAGMENT = "could not be automatically attributed";
// The exact legacy success wording, kept as its own constant so
// classifyBotComment() can still recognize a plain-text success comment
// posted by an OLDER deployment of this bot, from before SUCCESS_MARKER
// existed (same reasoning as the two NEEDS_*_FRAGMENT constants above for
// the "pending" case) - see the fallback check in classifyBotComment.
const LEGACY_SUCCESS_TEXT = "All contributors have signed the CLA. ✅";
// The full body of a "success" comment as posted by a version of this bot
// from before SUCCESS_MARKER existed: back then, a success comment's
// entire content beyond BOT_MARKER was always nothing more than this one
// fixed string, with nothing else ever appended - unlike NEEDS_SIGN_FRAGMENT/
// NEEDS_REVIEW_FRAGMENT above, which are genuinely partial fragments of a
// longer, variable comment (one that also lists specific missing
// contributors or unresolved commit SHAs, so no fixed whole-body string
// exists to match against). Since the full legacy body IS fixed and known,
// classifyBotComment checks it with an exact equality match rather than a
// substring search - substring matching here would risk a false positive on
// some unrelated future bot comment that merely happens to quote or mention
// this exact phrase.
const LEGACY_SUCCESS_COMMENT = `${BOT_MARKER}\n${LEGACY_SUCCESS_TEXT}`;
// Embedded (in addition to BOT_MARKER) in EVERY comment this bot posts that
// announces a PR as fully signed. classifyBotComment() looks for this
// marker first, falling back to LEGACY_SUCCESS_COMMENT only for comments
// predating it, so that checkPR's quietIfNeverFlagged history check keeps
// recognizing "this PR's completion was already announced" even though the
// visible wording now varies per signer instead of always being the one
// fixed string it used to be. SUCCESS_MESSAGE below is built FROM this
// marker (rather than the marker being appended separately at each call
// site) specifically so that guarantee can never be broken by editing the
// generic wording without also remembering to touch classifyBotComment.
// Unlike LEGACY_SUCCESS_COMMENT above, this marker is matched with a
// substring search rather than exact equality - it's a purpose-built,
// distinctive HTML-comment sentinel (not a plain English phrase that could
// plausibly appear elsewhere), and the personalized variant it also appears
// in (personalSuccessMessage()) has a variable "@login" suffix that an
// exact whole-body match couldn't account for anyway.
const SUCCESS_MARKER = "<!-- fossasia-cla-bot:success -->";
// Only ever used when checkPR() has no specific signer to credit (an
// automatic pull_request_target check, or the human-triggered `recheck`
// command) - see personalSuccessMessage() below for the normal, per-signer
// case.
const SUCCESS_MESSAGE = `${SUCCESS_MARKER}\n${LEGACY_SUCCESS_TEXT}`;
// The per-signer announcement checkPR() posts when the person who *just*
// signed (via the sign-phrase comment) is themselves one of the PR's
// required (non-allowlisted) commit authors AND their signing is what
// makes the PR fully signed. Replaces the one-size-fits-all SUCCESS_MESSAGE
// for that specific case, so the contributor who unblocked the PR is
// thanked by name instead of an anonymous "All contributors..."
// announcement. See checkPR()'s `signer` option and the
// `signerCompletedRequirement` check there for why this is NOT used
// whenever `signer` is merely present - crediting a completely unrelated
// commenter (someone who isn't even a commit author on this PR) with
// "completing" a PR they had no bearing on would be actively misleading.
function personalSuccessMessage(login) {
  return `${SUCCESS_MARKER}\n@${login} Thank you for signing the CLA! We look forward to your contributions.`;
}
// Optional hardening, off by default so normal unsigned-commit workflows
// keep working. GitHub attributes a commit's author to an account purely by
// matching the commit's git email - for the noreply format that's
// `ID+USERNAME@users.noreply.github.com`, and both parts are public. So
// anyone can set their author email to an already-signed account's noreply
// address and have GitHub display that commit as authored by the victim.
// Commit signature verification doesn't fix this either: GitHub only ever
// verifies the committer, never the author, so a forged commit (author =
// victim, committer = attacker's own verified account) still shows as fully
// verified. When this flag is on, we only trust `c.author` if that same
// account is also the verified committer - see listPRCommitAuthors().
const REQUIRE_VERIFIED_COMMITS =
  (process.env.REQUIRE_VERIFIED_COMMITS || "false").toLowerCase() === "true";
// Comments posted via the default GITHUB_TOKEN always show this exact login
// - this is the correct, documented value for the intended/standard use of
// this action. If a consumer passes a different kind of token (a PAT, or a
// separate GitHub App token) instead, the actual authenticated identity
// could differ; resolveBotLogin() below tries to detect that at runtime and
// falls back to this constant when it can't.
const DEFAULT_BOT_LOGIN = "github-actions[bot]";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
// Caps how many Co-authored-by trailers we'll resolve per commit - each one
// costs an API call, so a commit padded with thousands of fake trailers
// could otherwise burn through the run's time and rate limit. Anything past
// the cap gets flagged for manual review instead of silently dropped; see
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

// GitHub login/org names: letters, digits, single hyphens, can't start or
// end with one, max 39 chars.
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
// Repo names are looser: letters, digits, '.', '-', '_', up to 100 chars.
const GITHUB_REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

// ---------------------------------------------------------------------------
// Webhook-payload sanitizers.
//
// EVENT_PATH (see main()) is a JSON file GitHub itself writes before the job
// starts, but it's still external, file-provided data - a PR/issue number or
// commit SHA read out of it flows straight into the path of every gh()/fetch
// call below (postComment, checkPR, lockPR, setStatus, ...). These two
// checks are called right where that data is first pulled out of the parsed
// payload (handleIssueComment, handlePullRequestTarget), so nothing
// unvalidated from the file ever reaches a request URL - a malformed or
// unexpected event file fails loudly here instead of being interpolated
// into an outbound API call.
//
// Number.isSafeInteger(), not Number.isInteger(): every double beyond
// 2^53 is still "an integer" with no fractional part, so Number.isInteger
// happily accepts values like 1e100 or Number.MAX_SAFE_INTEGER + 1 - which
// then serialize into a URL as garbage (e.g. "1e+100") instead of a real
// PR number. Worse, JSON.parse() itself silently rounds an out-of-range
// integer literal in the source JSON to the nearest representable double
// (JSON.parse("9007199254740993") === 9007199254740992) - by the time
// this function sees the value, that corruption has already happened, so
// isSafeInteger is the only check that reliably tells us we're not one of
// those rounded, no-longer-faithful values. No real GitHub PR/issue number
// is ever remotely close to this boundary, so this is strictly tighter
// with zero risk to legitimate input.
function assertValidPRNumber(value, context) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `${context}: expected a positive integer issue/PR number, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

// Real git commit SHAs are lowercase hex (40 chars for sha1, 64 for
// sha256), but test/tooling code sometimes uses opaque placeholder strings
// in their place, so this deliberately doesn't require hex - it only
// rejects what would actually be dangerous as a URL path segment: slashes,
// "..", "?"/"#" (which would truncate or redirect the request path/query),
// whitespace/control characters, and "%" (blocks a percent-encoded
// bypass of the checks above, e.g. "%2e%2e" or "%2f" - a real SHA never
// contains one either way, so this costs nothing).
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

function validateConfig() {
  for (const [name, val] of [
    ["GITHUB_TOKEN", GITHUB_TOKEN],
    ["SIG_OWNER", SIG_OWNER],
    ["SIG_REPO", SIG_REPO],
    ["CLA_DOCUMENT_URL", CLA_DOCUMENT_URL],
  ]) {
    if (!val) fail(`Missing required input/env: ${name}`);
  }

  // These checks are just fail-fast convenience for maintainer-supplied
  // config (not attacker-controlled PR content). Without them a typo would
  // still surface eventually, just as a vague API error several steps
  // later - this catches it immediately with a message that says exactly
  // what's wrong.
  if (!GITHUB_LOGIN_RE.test(SIG_OWNER)) {
    fail(
      `SIG_OWNER "${SIG_OWNER}" doesn't look like a valid GitHub user/org name.`,
    );
  }
  if (!GITHUB_REPO_NAME_RE.test(SIG_REPO)) {
    fail(
      `SIG_REPO "${SIG_REPO}" doesn't look like a valid GitHub repository name.`,
    );
  }
  if (
    SIG_PATH.startsWith("/") ||
    SIG_PATH.includes("\\") ||
    SIG_PATH.split("/").includes("..") ||
    SIG_PATH.trim().length === 0
  ) {
    fail(
      `SIG_PATH "${SIG_PATH}" must be a non-empty, relative path within the signatures repo (no leading "/", no ".." segments, no backslashes).`,
    );
  }
  try {
    const parsed = new URL(CLA_DOCUMENT_URL);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      fail(`CLA_DOCUMENT_URL "${CLA_DOCUMENT_URL}" must be an http(s) URL.`);
    }
  } catch (e) {
    fail(`CLA_DOCUMENT_URL "${CLA_DOCUMENT_URL}" is not a valid URL.`);
  }
  // App auth is optional (getSignaturesToken falls back to GITHUB_TOKEN when
  // either half is missing), but if a key WAS supplied, check its shape here
  // so a mis-pasted secret fails clearly instead of deep inside crypto.sign().
  if (SIG_APP_PRIVATE_KEY && !SIG_APP_PRIVATE_KEY.includes("-----BEGIN")) {
    fail(
      'SIG_APP_PRIVATE_KEY is set but does not look like a PEM-encoded private key (missing a "-----BEGIN" header).',
    );
  }
}

// ---------------------------------------------------------------------------
// HTTP helper: timeout, JSON handling, and a retry for transient failures
// (rate limits, brief 5xx). 409 conflicts on writes are handled separately
// in writeSignatures() since those need a re-fetch, not a blind retry.
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
        // fetch() doesn't set this for a plain string body on its own.
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });
    const text = await res.text();
    if (!res.ok) {
      // GitHub's API returns JSON errors, but a proxy/gateway can return an
      // HTML error page on a 502/503/504 instead. Parse defensively so that
      // doesn't mask the real status with a "Unexpected token <" crash.
      let body = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = null; // non-JSON body - raw text is still in the Error message below
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
    // Raw-media-type requests (see readSignatures, for files too big for
    // the base64+JSON envelope) return plain text, not JSON.
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
    // Only retry what's safe to repeat: GETs, PUTs (protected by GitHub's
    // sha compare-and-swap, so a retry either no-ops via 409 or applies
    // exactly once), and DELETEs (repeating one just 404s). POSTs that
    // create something (comments, tokens) are excluded by default since a
    // blind retry could create a duplicate - callers that know a POST is
    // safe to retry can pass `idempotent: true`.
    const method = (options.method || "GET").toUpperCase();
    const safeToRetry =
      options.idempotent === true ||
      method === "GET" ||
      method === "PUT" ||
      method === "DELETE";
    const transient =
      safeToRetry &&
      (e.status === 429 ||
        (e.status === 403 && e.retryAfter) || // GitHub secondary rate limit
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
// GitHub App: mint a short-lived installation token on demand.
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
  // iat is set 60s in the past to tolerate clock drift with GitHub; exp
  // must be <= 10 minutes per GitHub's own App JWT requirements.
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId };
  const unsigned = `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(Buffer.from(JSON.stringify(payload)))}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${base64url(signer.sign(privateKeyPem))}`;
}

let _cachedSigToken = null; // one per run, no need to mint more than once
async function getSignaturesToken() {
  if (_cachedSigToken) return _cachedSigToken;

  if (!SIG_APP_ID || !SIG_APP_PRIVATE_KEY) {
    console.warn(
      "::warning::SIG_APP_ID/SIG_APP_PRIVATE_KEY not set - falling back to GITHUB_TOKEN. Cross-repo writes will only work if the signatures repo equals the current repo.",
    );
    _cachedSigToken = GITHUB_TOKEN;
    return _cachedSigToken;
  }

  const jwt = createAppJWT(SIG_APP_ID, SIG_APP_PRIVATE_KEY);
  // Repo-scoped lookup, not /orgs/{org}/installation - the org endpoint
  // 404s when signatures-owner is a user account rather than an org, and
  // this one works for both without needing to branch on account type.
  const installation = await gh(
    `/repos/${SIG_OWNER}/${SIG_REPO}/installation`,
    jwt,
  );
  const tokenResp = await gh(
    `/app/installations/${installation.id}/access_tokens`,
    jwt,
    // A retried mint just produces an extra unused, short-lived token -
    // no user-visible side effect, so it's fine to let gh() retry here.
    { method: "POST", idempotent: true },
  );
  _cachedSigToken = tokenResp.token; // valid ~1 hour
  return _cachedSigToken;
}

// ---------------------------------------------------------------------------
// Signature store (JSON file in the central private repo).
// ---------------------------------------------------------------------------
async function readSignatures(token) {
  try {
    // The 'object' media type works up to 100 MB (the default response
    // format is only reliable under 1 MB) and still gives us the sha we
    // need for compare-and-swap writes. Files at or under 1 MB come back
    // with content included; bigger files come back empty and we fetch the
    // actual bytes below via the 'raw' media type.
    const meta = await gh(
      `/repos/${SIG_OWNER}/${SIG_REPO}/contents/${SIG_PATH}`,
      token,
      {
        headers: { Accept: "application/vnd.github.object+json" },
      },
    );

    let text;
    if (meta.content && meta.encoding === "base64") {
      text = Buffer.from(meta.content, "base64").toString("utf8");
    } else {
      text = await gh(
        `/repos/${SIG_OWNER}/${SIG_REPO}/contents/${SIG_PATH}`,
        token,
        {
          headers: { Accept: "application/vnd.github.raw+json" },
          raw: true,
        },
      );
    }

    const data = JSON.parse(text);
    if (!Array.isArray(data.signatures))
      throw new Error(
        'signatures file is malformed: "signatures" is not an array',
      );

    // A malformed entry (e.g. missing "login") must never crash isSigned()
    // or isAllowlisted() - but it also can't just be dropped here, because
    // this data gets re-serialized straight back to the file on the next
    // write. Silently dropping it would permanently delete what might be a
    // real signature that just predates a schema change. So: warn, but
    // leave it in place; isSigned() handles matching against it safely.
    //
    // The warning deliberately omits the entry's own content - it prints
    // into the Actions log of every consuming repo (which can be public),
    // and entries can contain personal data. An index is enough for a
    // maintainer to go look it up directly in the signatures repo.
    data.signatures.forEach((entry, index) => {
      if (
        !entry ||
        typeof entry.login !== "string" ||
        entry.login.length === 0
      ) {
        console.warn(
          `::warning::Signature entry at index ${index} is missing/has an invalid "login" field (kept as-is, not treated as a match) - check ${SIG_OWNER}/${SIG_REPO}/${SIG_PATH}`,
        );
      }
    });
    return { sha: meta.sha, data };
  } catch (e) {
    if (e.status === 404)
      return { sha: null, data: { version: 1, signatures: [] } };
    throw e;
  }
}

async function writeSignatures(token, mutate, message, attempt = 1) {
  // Always re-read right before writing so the sha we PUT with is fresh -
  // that's what makes the retry loop below correct instead of racing itself.
  const { sha, data } = await readSignatures(token);
  const updated = mutate(data);
  if (updated === null) return data; // mutate() decided nothing changed (e.g. already signed)
  const content = Buffer.from(JSON.stringify(updated, null, 2)).toString(
    "base64",
  );
  try {
    await gh(`/repos/${SIG_OWNER}/${SIG_REPO}/contents/${SIG_PATH}`, token, {
      method: "PUT",
      body: JSON.stringify({ message, content, sha: sha || undefined }),
    });
    return updated;
  } catch (e) {
    // Two different races land here, both meaning "the file changed under
    // us - re-read and reapply our change":
    //
    // 1. A normal 409 Conflict: someone else updated the existing file
    //    between our read and our write.
    //
    // 2. A first-write race: our read saw the file didn't exist yet (sha
    //    null), but another writer's create won in the meantime. GitHub
    //    doesn't return 409 for that - it returns 422 saying a sha is
    //    required, since from its side we just tried to blindly overwrite
    //    a file that now exists. Several repos can easily race to create
    //    the signature file for the very first time, so this case matters.
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

// `author` is normally a { id, login } pair. We match on the numeric id
// where we can, since logins are mutable - a released login can be claimed
// by someone else later, and matching on login alone could hand that
// person an earlier signature that isn't theirs. A bare login string is
// also accepted (legacy entries, or callers with no id) and falls back to a
// login-only comparison.
//
// Every real caller here passes a well-formed value, but this is also an
// exported helper (used by tests), so the guards below make sure a
// malformed shape fails closed ("not signed") instead of throwing.
function isSigned(data, author) {
  if (author == null) return false;
  const login = typeof author === "string" ? author : author.login;
  const id = typeof author === "string" ? undefined : author.id;
  if (typeof login !== "string" || login.length === 0) return false;
  const l = login.toLowerCase();
  return data.signatures.some((s) => {
    // readSignatures() keeps malformed entries around instead of dropping
    // them (see there), so this has to tolerate a garbage `s` safely.
    if (!s || typeof s !== "object") return false;
    if (typeof id === "number" && typeof s.id === "number") {
      return s.id === id;
    }
    // No id on one side (legacy entry, or a caller with only a login) -
    // fall back to a login comparison instead of refusing to match at all.
    return typeof s.login === "string" && s.login.toLowerCase() === l;
  });
}

function isAllowlisted(login) {
  if (typeof login !== "string" || login.length === 0) return false;
  const l = login.toLowerCase();
  return ALLOWLIST.some((a) => a.toLowerCase() === l);
}

// Same "prefer numeric id, fall back to a case-insensitive login compare"
// matching rule as isSigned() above (kept as its own small function rather
// than shared code, so a future change to either doesn't have to reason
// about the other) - applied here to answer a different question: not
// "has this identity signed anywhere", but "is this identity one of THIS
// PR's own commit authors". Used by checkPR to tell a genuine required
// signer apart from a bystander whose sign-phrase comment didn't actually
// unblock this particular PR (see the `signerCompletedRequirement` check
// there, and personalSuccessMessage()'s doc comment for why that
// distinction matters).
function isSameContributor(a, b) {
  if (!a || !b) return false;
  if (typeof a.id === "number" && typeof b.id === "number") {
    return a.id === b.id;
  }
  return (
    typeof a.login === "string" &&
    typeof b.login === "string" &&
    a.login.toLowerCase() === b.login.toLowerCase()
  );
}

// Combines a caller's already-known signature snapshot (e.g. the object
// writeSignatures() just returned) with a freshly-read one, so that neither
// side's staleness can hide a real signature from checkPR:
//
//  - `fresh` might still be serving the pre-write snapshot due to GitHub's
//    Contents API read-after-write staleness window (see checkPR's doc
//    comment) - `known`'s entries (the exact data the caller's own write
//    just produced) cover that gap.
//  - `known` was captured at some point BEFORE listPRCommitAuthors() ran,
//    and can't reflect a signature written by a completely different
//    workflow run (e.g. someone signing via a different PR/repo) that lands
//    in the shared store while that call is in flight - `fresh`'s entries
//    cover that gap instead.
//
// Where the same identity (per isSameContributor's id-first, login-fallback
// rule) appears in both, the fresh entry wins, since it's the more recently
// observed state of the shared store; entries only `known` has are kept
// as-is. `known` may be null/undefined (every checkPR() caller except
// handleIssueComment's has no such snapshot to hand over), in which case
// `fresh` is returned unchanged.
function mergeSignatures(known, fresh) {
  if (!known) return fresh;
  const keptFromKnown = known.signatures.filter(
    (k) => !fresh.signatures.some((f) => isSameContributor(k, f)),
  );
  return {
    version: fresh.version,
    signatures: [...keptFromKnown, ...fresh.signatures],
  };
}

// Was `signer` actually a required (non-allowlisted) commit author among
// `authors` (a PR's own commit authors, as returned by
// listPRCommitAuthors())? Extracted as its own top-level function - rather
// than an expression inlined into checkPR - specifically so it has ONE
// definition that's directly unit-testable on its own (see
// test/logic.test.js), instead of being duplicated between production code
// and a re-typed copy of the same expression in its tests, which could
// silently drift out of sync with each other over time.
//
// checkPR calls this only after confirming `missing.length === 0 &&
// unresolved.length === 0` (the PR IS now fully signed), and only ever
// passes a `signer` who just recorded a BRAND NEW signature (handleIssueComment
// only passes `signer` after confirming they weren't already signed - see
// there). So if `signer` really is a required author here, they were
// necessarily among `missing` a moment ago and are not anymore: their
// comment is genuinely what moved this PR's own requirement forward. If
// not - an allowlisted account, or someone who never authored a commit on
// this PR at all - their signing had zero effect on this PR's `missing`
// list either way, so they get no credit for "completing" it (see
// personalSuccessMessage()'s doc comment for why that distinction matters).
function signerCompletedRequirement(authors, signer) {
  return (
    !!signer &&
    !isAllowlisted(signer.login) &&
    authors.some((a) => isSameContributor(a, signer))
  );
}

// Classifies one of the bot's own comments (see getExistingBotComments -
// only ever called on comments already confirmed to be from the bot) as
// either "pending" (a real "you still need to sign" / "needs manual
// review" comment - the PR was genuinely blocked when this was posted),
// "success" (the "All contributors have signed" announcement), or neither
// (e.g. the personal, non-blocking "you already signed the CLA, nothing
// more to do here" reply someone gets for redundantly re-submitting the
// sign phrase). Used by checkPR's quietIfNeverFlagged logic to tell a real
// block apart from unrelated bot chatter on the same thread.
function classifyBotComment(body) {
  if (
    body.includes(PENDING_MARKER) ||
    body.includes(NEEDS_SIGN_FRAGMENT) ||
    body.includes(NEEDS_REVIEW_FRAGMENT)
  ) {
    return "pending";
  }
  // SUCCESS_MARKER covers both the generic SUCCESS_MESSAGE and the
  // personalized per-signer thank-you (personalSuccessMessage()), since
  // SUCCESS_MESSAGE is built directly from this marker (see its doc
  // comment) - so this ALSO catches any future change to the generic
  // wording, as long as it keeps going through SUCCESS_MESSAGE. The
  // LEGACY_SUCCESS_COMMENT check is a separate, deliberately EXACT
  // (not substring) fallback: it's the only thing that still recognizes a
  // genuinely pre-marker comment (one posted by an older deployment of
  // this bot, whose entire body was always just that one fixed string with
  // nothing else appended - see LEGACY_SUCCESS_COMMENT's doc comment for
  // why exact equality is correct, and safer, here specifically).
  if (body.includes(SUCCESS_MARKER) || body === LEGACY_SUCCESS_COMMENT) {
    return "success";
  }
  return "other";
}

// ---------------------------------------------------------------------------
// Repo-local helpers (comments / status / lock) - always use GITHUB_TOKEN,
// never the signatures token.
// ---------------------------------------------------------------------------
// GitHub has two noreply email formats:
//   - ID+USERNAME@users.noreply.github.com (accounts from after 18 Jul 2017)
//     the id is right there, no lookup needed.
//   - USERNAME@users.noreply.github.com (older accounts) - needs one lookup
//     to resolve to an id.
const NEW_NOREPLY = /^(\d+)\+([^@]+)@users\.noreply\.github\.com$/i;
const OLD_NOREPLY = /^([^@+]+)@users\.noreply\.github\.com$/i;

const _userIdCache = new Map(); // login (lowercased) -> id | null (not found)
async function resolveUserIdByLogin(login) {
  const key = login.toLowerCase();
  if (_userIdCache.has(key)) return _userIdCache.get(key);
  let id = null;
  try {
    const user = await gh(`/users/${encodeURIComponent(login)}`, GITHUB_TOKEN);
    if (user && typeof user.id === "number") id = user.id;
  } catch (e) {
    // 404 or a transient failure - either way this falls through to
    // "unresolved" at the call site rather than being silently dropped.
  }
  _userIdCache.set(key, id);
  return id;
}

const _loginByIdCache = new Map(); // id -> login | null (not found)
// GET /user/{account_id} gives us the current, GitHub-verified login for an
// id, instead of trusting whatever login string sits next to that id in a
// commit trailer (see extractCoAuthors - the trailer is free text, so an
// "id+login" pair in it doesn't prove they belong to the same account).
async function resolveLoginById(id) {
  if (_loginByIdCache.has(id)) return _loginByIdCache.get(id);
  let login = null;
  try {
    const user = await gh(`/user/${encodeURIComponent(id)}`, GITHUB_TOKEN);
    if (user && typeof user.login === "string" && user.login.length > 0) {
      login = user.login;
    }
  } catch (e) {
    // 404 (deleted account, or no such id) or transient failure - falls
    // through to unresolved.
  }
  _loginByIdCache.set(id, login);
  return login;
}

// A Co-authored-by: trailer in a commit message is free text - GitHub never
// authenticates it. For the noreply formats we can at least confirm the
// (id, login) pair refers to one real account: for the new format the login
// is looked up independently by id rather than trusted from the trailer
// (see resolveLoginById), so nobody can pair a real, already-signed id with
// a fabricated login to slip past the login-based allowlist check. What we
// can't verify is that the account actually agreed to be credited on this
// commit - nothing can, since GitHub doesn't track that. Any other email
// format can't be reliably resolved to an account, so it's flagged for
// manual review just like an unresolved primary author. The raw email is
// never part of the return value, since it can be personal data and this
// eventually reaches PR comments and Actions logs (see checkPR).
async function extractCoAuthors(commitMessage) {
  const authors = [];
  let hasUnresolved = false;
  const trailerRegex = /^co-authored-by:\s*.+?<([^>]+)>\s*$/gim;
  const seen = new Set();
  let match;
  while ((match = trailerRegex.exec(commitMessage || "")) !== null) {
    const email = match[1].trim();
    const key = email.toLowerCase();
    if (seen.has(key)) continue; // don't double-count/double-lookup a repeated trailer
    if (seen.size >= MAX_COAUTHOR_TRAILERS_PER_COMMIT) {
      // Stop minting more lookups for this commit once we're past the cap,
      // and flag it for a human rather than silently ignoring the overflow
      // - see MAX_COAUTHOR_TRAILERS_PER_COMMIT above for why.
      hasUnresolved = true;
      break;
    }
    seen.add(key);

    const newStyle = email.match(NEW_NOREPLY);
    if (newStyle) {
      const claimedId = Number(newStyle[1]);
      // Deliberately ignore newStyle[2] (the trailer's own login text) and
      // resolve the account's real, current login from GitHub itself, keyed
      // off the id - the one part of this trailer that isn't just a string
      // an attacker gets to pick to match an arbitrary account.
      const authoritativeLogin = await resolveLoginById(claimedId);
      if (authoritativeLogin !== null) {
        authors.push({ id: claimedId, login: authoritativeLogin });
        continue;
      }
      // id doesn't resolve to any real/current account - fall through.
    }

    const oldStyle = email.match(OLD_NOREPLY);
    if (oldStyle) {
      const login = oldStyle[1];
      const id = await resolveUserIdByLogin(login);
      if (id !== null) {
        authors.push({ id, login });
        continue;
      }
      // lookup failed (e.g. account since deleted) - fall through to unresolved
    }

    hasUnresolved = true;
  }
  return { authors, hasUnresolved };
}

async function listPRCommitAuthors(prNumber) {
  // Keyed by numeric id (see isSigned) so the same person showing up as
  // author on one commit and co-author on another collapses to one entry.
  const authors = new Map();
  // Commits flagged for manual review, identified by SHA only - the SHA is
  // already public on the PR's Commits tab and carries no personal data,
  // unlike a raw author/co-author email.
  const unresolvedShas = new Set();
  let page = 1;
  for (;;) {
    const commits = await gh(
      `/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${encodeURIComponent(prNumber)}/commits?per_page=100&page=${page}`,
      GITHUB_TOKEN,
    );
    if (!commits.length) break;
    for (const c of commits) {
      // Skip merge commits - whoever merged didn't author the change, so
      // they shouldn't be asked to sign just for that.
      if (Array.isArray(c.parents) && c.parents.length > 1) continue;

      if (c.author && c.author.login && typeof c.author.id === "number") {
        const verified = !!(
          c.commit &&
          c.commit.verification &&
          c.commit.verification.verified
        );
        // verified === true alone proves nothing about c.author, since
        // GitHub never verifies the author, only the committer (see
        // REQUIRE_VERIFIED_COMMITS above). Only trust the author when the
        // same account is also the verified committer.
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
        // The commit's email isn't linked to any GitHub account (privacy
        // setting, or local git misconfiguration) - flag for manual review.
        unresolvedShas.add(c.sha);
      }

      // Co-authors need to sign too - their contribution counts just as
      // much as the primary author's.
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

let _cachedBotLogin = null; // one per run, same idea as _cachedSigToken
async function resolveBotLogin() {
  if (_cachedBotLogin) return _cachedBotLogin;
  try {
    // Works for a PAT or user-scoped token. The standard GITHUB_TOKEN isn't
    // one of those, so this is expected to fail in the normal setup - we
    // just fall back to the default below. This only matters for a
    // consumer using a different kind of token, so dedupe still compares
    // against the right identity instead of a hardcoded guess.
    const me = await gh("/user", GITHUB_TOKEN);
    if (me && me.login) {
      _cachedBotLogin = me.login;
      return _cachedBotLogin;
    }
  } catch (e) {
    // Expected for the standard GITHUB_TOKEN - fall through to the default.
  }
  _cachedBotLogin = DEFAULT_BOT_LOGIN;
  return _cachedBotLogin;
}

async function getExistingBotComments(
  prNumber,
  { anyBotIdentity = false } = {},
) {
  const botLogin = await resolveBotLogin();
  const all = [];
  let page = 1;
  for (;;) {
    const comments = await gh(
      `/repos/${REPO_OWNER}/${REPO_NAME}/issues/${encodeURIComponent(prNumber)}/comments?per_page=100&page=${page}`,
      GITHUB_TOKEN,
    );
    if (!comments.length) break;
    all.push(
      ...comments.filter((c) => {
        if (!c.user || !c.body || !c.body.includes(BOT_MARKER)) return false;
        if (c.user.login === botLogin) return true;
        // Broader match, opt-in via `anyBotIdentity` - used ONLY for the
        // block/recovery history check in checkPR's quietIfNeverFlagged
        // logic, never for postComment()'s own dedupe (which intentionally
        // stays strict to the currently resolved identity - see
        // bot-identity-success.test.js, which relies on a differently-
        // identified past comment NOT counting as an already-said
        // duplicate).
        //
        // Without this, a consumer that switches GITHUB_TOKEN from the
        // default Actions token to a PAT or a separate GitHub App
        // installation token (or back) mid-flight would have every comment
        // posted under the OLD identity silently excluded here, since
        // resolveBotLogin() only ever reports the CURRENT run's identity.
        // A PR genuinely blocked before the switch would then look like it
        // was never flagged, and its recovery announcement would be
        // wrongly suppressed once it becomes fully signed.
        //
        // `type === "Bot"` is a field GitHub itself sets on the comment
        // author and cannot be spoofed by an ordinary contributor's own
        // account (see the spoofed-comment test below, whose fake commenter
        // has no such type and so still fails this check) - it covers the
        // default GITHUB_TOKEN identity and any GitHub-App-based custom
        // token, regardless of which exact bot login was in use at the
        // time. DEFAULT_BOT_LOGIN is checked too, as a defense-in-depth
        // fallback for the single most common case (plain GITHUB_TOKEN) in
        // case `type` is ever missing from a response - GitHub reserves
        // the `[bot]`-suffixed login namespace for bot accounts, so an
        // ordinary user can't take that exact login either. The one gap
        // neither check can close is a PAT identity rotating to a
        // DIFFERENT PAT-owned account: both report as an ordinary `type:
        // "User"` account with an unreserved login, indistinguishable from
        // any other GitHub user, so that specific switch still can't
        // recover cross-identity history - a narrow, documented
        // limitation (see CHANGELOG.md).
        return (
          anyBotIdentity &&
          (c.user.type === "Bot" || c.user.login === DEFAULT_BOT_LOGIN)
        );
      }),
    );
    if (comments.length < 100) break;
    page += 1;
  }
  return all;
}

async function postComment(prNumber, body, dedupe = true) {
  // Defense-in-depth: postComment is exported and callable directly (not
  // only via the validated handleIssueComment/handlePullRequestTarget entry
  // points), so it re-checks its own input rather than trusting every
  // caller to have validated it first.
  assertValidPRNumber(prNumber, "postComment(prNumber)");
  const full = `${BOT_MARKER}\n${body}`;
  if (dedupe) {
    const existing = await getExistingBotComments(prNumber);
    // Compare against the most recent bot comment of the SAME category
    // (per classifyBotComment: "pending", "success", or "other"), not
    // merely the literal last bot comment overall. checkPR can post two
    // comments back to back within a single call - a personal per-signer
    // thank-you ("other") followed by the pending-list comment
    // ("pending") - so a LATER call's own pending comment would otherwise
    // be compared against an unrelated, DIFFERENT signer's thank-you that
    // landed in between (e.g. two different unrelated contributors each
    // signing while the same required contributor is still missing),
    // rather than against the earlier, byte-identical pending comment it
    // should actually be deduped against. Comparing within the same
    // category finds the right prior comment to compare against
    // regardless of what other comment category was posted in between.
    const category = classifyBotComment(full);
    const lastOfCategory = existing.findLast(
      (c) => classifyBotComment(c.body) === category,
    );
    if (lastOfCategory && lastOfCategory.body === full) return; // nothing changed, don't spam the thread
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
    // This cleanup is a best-effort mitigation for a race that's already
    // been described above - by the time we get here, the important work
    // (the comment itself) has already succeeded. A failure in the cleanup
    // step (e.g. the existence-check GET running out of retries) must not
    // fail the whole run and mask that the real work already completed.
    try {
      await dedupeIdenticalTrailingComments(prNumber, full);
    } catch (e) {
      console.warn(
        `::warning::Duplicate-comment cleanup failed (non-fatal, the comment itself was already posted): ${e.message}`,
      );
    }
  }
}

// The "no matching comment yet, so POST" check above is two separate HTTP
// calls with no atomicity between them. Two concurrent runs (a duplicate
// webhook delivery, or overlapping jobs not queued by the workflow's
// `concurrency:` group) can both pass the check before either POST lands,
// producing two identical comments. This can't prevent that - nothing
// running as two separate REST calls without a compare-and-swap can - but
// it self-heals right after: find any other bot comment with the same
// body and delete all but the newest one. Keeping the newest matters,
// since postComment() calls this right after creating a new comment, so
// that new one is the highest id. Whichever concurrent run's cleanup runs
// last still converges to the same result; deleting an already-deleted
// comment just 404s, which is caught and ignored. The workflow-level
// `concurrency:` group is what actually closes this race - this is just a
// backstop for when that's missing or a race slips through anyway.
async function dedupeIdenticalTrailingComments(prNumber, body) {
  const comments = await getExistingBotComments(prNumber);
  const matching = comments
    .filter((c) => c.body === body)
    .sort((a, b) => a.id - b.id);
  // Keep the newest (highest id), delete the rest.
  for (const dup of matching.slice(0, -1)) {
    try {
      await gh(
        `/repos/${REPO_OWNER}/${REPO_NAME}/issues/comments/${encodeURIComponent(dup.id)}`,
        GITHUB_TOKEN,
        { method: "DELETE" },
      );
    } catch (e) {
      // Could already be gone (another cleanup pass got there first) or we
      // lack permission in some edge deployment - either way this is
      // best-effort cosmetic cleanup, not worth failing the run over.
      console.warn(
        `::warning::Could not delete duplicate comment ${dup.id}: ${e.message}`,
      );
    }
  }
}

async function setStatus(sha, state, description) {
  await gh(
    `/repos/${REPO_OWNER}/${REPO_NAME}/statuses/${encodeURIComponent(sha)}`,
    GITHUB_TOKEN,
    {
      method: "POST",
      // Posting the same status twice has no visible effect - GitHub only
      // shows the latest status per context - so it's fine to let gh() retry
      // a transient failure here.
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
    // Defense-in-depth, same reasoning as postComment(): lockPR is exported
    // and callable directly. Validating inside the try means a bad
    // prNumber is handled exactly like any other lock failure - logged and
    // swallowed, never thrown - keeping lockPR's "never fails the run"
    // contract intact.
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
    // Nice-to-have hardening, not core to CLA correctness - log and move on.
    console.warn(`::warning::Could not lock PR #${prNumber}: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Core: evaluate one PR and bring its status/comment up to date.
//
// `quietIfNeverFlagged` (only ever passed `true` by the automatic
// pull_request_target handler - see handlePullRequestTarget) controls
// whether a clean result gets announced with a comment:
//
// - A brand new PR whose commit authors had ALL already signed the CLA
//   before this PR ever existed needs no comment at all - nothing was
//   ever required of anyone here, so saying "All contributors have signed
//   the CLA ✅" on a PR the bot has never spoken on before is pure noise.
//   The commit status is still set to "success" either way, since that's
//   what merge protection actually reads.
// - The moment this PR ever *did* need a signer or manual review (a
//   comment classifyBotComment() recognizes as "pending" was posted for
//   it, at any point in its history) and it later becomes fully signed,
//   that transition is worth announcing - people watched this PR go from
//   blocked to unblocked. A personal, non-blocking reply (e.g. "you
//   already signed, nothing more to do here" from someone re-submitting
//   the sign phrase) doesn't count as ever having been blocked - it says
//   nothing about the PR's own state.
// - Once that transition has already been announced, later fully-signed
//   checks stay quiet again even if some unrelated comment (like that same
//   personal reply) lands afterward - re-announcing "all signed" every
//   time something unrelated gets posted would just reintroduce the same
//   noise this whole feature exists to remove. Concretely: this compares
//   the position of the *most recent* "pending" comment against the most
//   recent "success" one - success is only (re-)announced when a pending
//   comment is the more recent of the two, i.e. a real block happened
//   since the last time success was announced (or it's never been
//   announced at all).
// - An explicit human trigger (the sign-phrase comment, or the `recheck`
//   command handled in handleIssueComment) always gets an answer, quiet
//   or not: the caller took an action and asked a direct question, so
//   `checkPR` is invoked there without this flag and always comments,
//   regardless of what's already been said on the thread (aside from the
//   ordinary same-category dedupe every postComment() call already does -
//   see its own doc comment).
//
// This is what makes "new committers joining an already-compliant PR"
// behave as silently as the very first check: as long as this PR has never
// actually needed asking (or that need was already fully announced as
// resolved), a still-fully-signed result just stays quiet.
//
// `signer` (only ever passed by handleIssueComment, right after recording a
// BRAND NEW signature - never by the automatic pull_request_target trigger
// or the `recheck` command, neither of which has any one specific person to
// address) is the `{ id, login }` of whoever just signed. When present, it
// changes how checkPR names the person(s) it addresses, without changing
// the underlying pass/fail logic at all:
//   - Still missing other signers/reviews: the pending comment leads with a
//     personal "@signer Thank you for signing..." line, in addition to
//     (not instead of) the usual list of who else still needs to sign - so
//     the contributor who just acted gets acknowledged even though the PR
//     as a whole isn't clear yet. This is always accurate regardless of
//     who `signer` turns out to be, since reaching checkPR with a `signer`
//     at all already means that exact identity just recorded a brand new
//     signature (see handleIssueComment) - it says nothing about whether
//     they were required here, just that they did in fact sign.
//   - Now fully signed AND `signer` is one of THIS PR's own required
//     (non-allowlisted) commit authors: that person is thanked by name
//     (personalSuccessMessage()) INSTEAD OF the generic, anonymous
//     SUCCESS_MESSAGE - see personalSuccessMessage()'s doc comment. This is
//     the fix for a PR with several contributors: each one signing via a
//     comment gets their own "@username Thank you for signing the CLA! We
//     look forward to your contributions." rather than everyone just seeing
//     one generic "All contributors have signed the CLA. ✅" once the last
//     person signs.
//   - Now fully signed but `signer` is NOT one of this PR's required
//     authors (an allowlisted account, or - just as easily - someone with
//     no connection to this PR at all who happened to comment the sign
//     phrase on it): falls back to the generic SUCCESS_MESSAGE. Crediting
//     that person with "completing" a PR their signature had no bearing on
//     would be actively misleading, especially since the PR may well have
//     already been fully signed before they ever commented - see
//     `signerCompletedRequirement` below.
//
// `statusOnly` (only ever passed by handleIssueComment's `alreadySigned`
// branch below) recomputes and updates the merge-blocking status check as
// usual, but returns immediately after - without posting ANY comment,
// pending or success. This exists specifically for a redundant sign-phrase
// comment from someone who'd already signed (typically via a different
// PR): that person gets their own "you already signed, nothing more to do"
// reply regardless (see handleIssueComment), but this PR's own status may
// well have gone stale in the meantime - it was last set when THIS PR was
// still missing them, and nothing had re-run checkPR for THIS PR since. A
// normal (non-statusOnly) checkPR call would fix the status too, but would
// ALSO post a fresh pending-list or success comment alongside the
// "already signed" one - and would do so AGAIN every time the same person
// harmlessly re-sends the same redundant comment, since none of those
// extra comments would be byte-identical to the one immediately before
// them (the "already signed" reply always comes first) for postComment's
// own dedupe to catch. `statusOnly` avoids that: the status is corrected
// silently, with no risk of ever piling up duplicate announcements no
// matter how many times someone redundantly re-signs.
// `knownSignatures` (only ever passed by handleIssueComment, right after a
// writeSignatures() call in the SAME request) is the exact signatures
// object writeSignatures() just returned - the freshest possible state for
// the caller's own write, known for certain without another round trip.
// When given, checkPR merges it (via mergeSignatures()) with its own fresh
// GET instead of trusting either one alone:
//
//  - The fresh GET alone isn't enough: GitHub's Contents API does NOT
//    guarantee that a GET immediately following a PUT reflects that write -
//    a super-brief read-after-write staleness window is a documented
//    characteristic of that API, not something application code can
//    reliably wait out. Without `knownSignatures` filling that gap, a
//    contributor could sign the CLA and, purely because the GET raced
//    against that same brief window, see the very message thanking them
//    for signing ALSO still list them as needing to sign.
//  - `knownSignatures` alone isn't enough either: it's a snapshot from
//    before listPRCommitAuthors() ran (which can be slow on a big PR), so
//    it can't see a DIFFERENT required contributor's signature that lands
//    in the shared store - written by a completely different workflow run,
//    e.g. them signing via another PR/repo - while that call is in flight.
//    Skipping the GET entirely in that window would let checkPR post a
//    false pending-signer comment / failure status for someone who has, in
//    fact, already signed.
//
// Every other caller of checkPR (the automatic pull_request_target
// trigger, and the `recheck` command) has no such freshly-known snapshot to
// hand over, so mergeSignatures() just returns the fresh GET unchanged for
// them - same behavior as always.
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

  // listPRCommitAuthors() can be slow on a big PR; reading the signature
  // store right after it (rather than before) is what's most likely to
  // change under us, e.g. someone signing in another run. This narrows the
  // race window but doesn't remove it - two overlapping runs can still each
  // post a stale result if they're not serialized. That's what the
  // consumer workflow's `concurrency:` group is for; it also covers the
  // comment-duplication race handled in postComment().
  //
  // Always read here, even when `knownSignatures` was given - see
  // mergeSignatures() and this function's doc comment above for why a
  // caller's own known-fresh write still isn't a substitute for this GET.
  const { authors, unresolved } = await listPRCommitAuthors(prNumber);
  const freshData = (await readSignatures(await getSignaturesToken())).data;
  const data = mergeSignatures(knownSignatures, freshData);
  const missing = authors.filter(
    (a) => !isAllowlisted(a.login) && !isSigned(data, a),
  );

  if (missing.length === 0 && unresolved.length === 0) {
    await setStatus(
      headSha,
      "success",
      "All contributors have signed the CLA.",
    );
    if (statusOnly) return;
    if (quietIfNeverFlagged) {
      // GET comments come back in creation order (oldest first), so the
      // *last* match in the array for each category is the most recent
      // one of that kind - findLastIndex() (Node 22+, per the version
      // guard at the top of this file) gets us that directly. Comparing
      // those two positions (rather than just "does a pending comment
      // exist anywhere") is what correctly re-announces success after a
      // genuine second block-and-resolve cycle, while staying quiet when
      // nothing has changed since the last announcement - see the
      // function-level comment above.
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
    // See checkPR's doc comment above and signerCompletedRequirement(): only
    // address the signer by name when their own signature is what actually
    // completed this PR's requirement, never merely because a `signer` was
    // passed at all.
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
    // No commit-author/co-author email here on purpose - it can be personal
    // data, and this comment is public. The commit SHA is already visible
    // on the PR's own Commits tab, which is enough for a maintainer to find
    // and inspect the commit themselves.
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
    // The PR isn't fully clear yet (someone else still needs to sign, or a
    // commit needs manual review), but this specific person DID just sign
    // successfully - acknowledge that as its OWN comment, separate from the
    // list of what's still outstanding below (rather than one comment
    // combining both), so each comment has one clear, single purpose: this
    // one says "your action was recorded", the next one says "here's where
    // the PR stands overall".
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
  // The PR's own author can always recheck their own PR. Beyond that,
  // GitHub already tells us the commenter's relationship to the repo via
  // author_association - no extra API call needed.
  const prAuthor =
    payload.issue && payload.issue.user && payload.issue.user.login;
  if (prAuthor && prAuthor.toLowerCase() === commenter.toLowerCase())
    return true;

  const association = payload.comment && payload.comment.author_association;
  return ["OWNER", "MEMBER", "COLLABORATOR"].includes(association);
}

async function handleIssueComment(payload) {
  if (!payload.issue || !payload.issue.pull_request) return; // comment on a plain issue, not a PR
  if (
    !payload.comment ||
    !payload.comment.user ||
    typeof payload.comment.user.login !== "string"
  ) {
    // A real issue_comment webhook always carries comment.user. Getting
    // here means a malformed event file or an unexpected caller - fail
    // loudly instead of a raw TypeError.
    throw new Error(
      "issue_comment payload is missing comment.user.login - malformed or unexpected webhook delivery.",
    );
  }
  const prNumber = assertValidPRNumber(
    payload.issue.number,
    "issue_comment payload issue.number",
  );
  const body = (payload.comment.body || "").trim();
  const commenter = payload.comment.user.login;

  if (body.toLowerCase() === SIGN_PHRASE.toLowerCase()) {
    const sigToken = await getSignaturesToken();
    // The webhook already carries the commenter's numeric id - recording
    // that, not just the login, is what lets the signature survive a later
    // username change (see isSigned).
    const commenterId = payload.comment.user.id;
    const commenterIdentity = { id: commenterId, login: commenter };

    // The check-and-append happens inside one mutate() call working on data
    // that writeSignatures() re-reads fresh right before writing. That's
    // what keeps signing idempotent under a race (a duplicate webhook, or
    // the 409 retry loop re-running this closure) - each attempt checks the
    // just-fetched state, not a stale snapshot.
    let alreadySigned = false;
    const writtenSignatures = await writeSignatures(
      sigToken,
      (data) => {
        if (isSigned(data, commenterIdentity)) {
          alreadySigned = true;
          return null; // tells writeSignatures: no write needed
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
    );

    if (alreadySigned) {
      // Dedupe is on by default - someone commenting the sign phrase again
      // after already signing shouldn't get a fresh reply every time.
      await postComment(
        prNumber,
        `@${commenter} you have already signed the CLA. Nothing more to do here.`,
      );
      // This PR's own merge-blocking status may be stale: it was last set
      // while THIS PR still considered them unsigned, and they may well
      // have signed via a DIFFERENT PR since - nothing would have re-run
      // checkPR for THIS PR in the meantime. Silently bring the status up
      // to date (statusOnly: true posts no additional comment - see
      // checkPR's doc comment for why that matters here specifically).
      // knownSignatures ensures checkPR's own fresh GET can't shadow the
      // write that just happened even if it races that write's
      // read-after-write staleness window (see checkPR's and
      // mergeSignatures()'s doc comments).
      await checkPR(prNumber, undefined, {
        statusOnly: true,
        knownSignatures: writtenSignatures,
      });
      return;
    }

    // Re-evaluate the PR now that one more person has signed. Passing
    // `signer` is what makes checkPR() address THIS specific person by name
    // (either in a personal thank-you leading the pending list, or - if
    // they're the one who just completed the requirement - in place of the
    // generic "All contributors have signed" announcement). knownSignatures
    // is the exact data writeSignatures() just wrote, so checkPR's own
    // fresh GET can't shadow it even if that GET races the write's own
    // read-after-write staleness window (see checkPR's and
    // mergeSignatures()'s doc comments) - the very bug that would let the
    // person who just signed still show up in their own "still needs to
    // sign" list.
    await checkPR(prNumber, undefined, {
      signer: commenterIdentity,
      knownSignatures: writtenSignatures,
    });
    return;
  }

  if (body.toLowerCase() === "recheck") {
    // recheck does real work for no visible benefit to a random passer-by,
    // so it's restricted to the PR's own author or someone with actual
    // standing in the repo - otherwise it could be used to churn Actions
    // minutes on PRs the commenter has nothing to do with. Signing itself
    // stays open to anyone, since first-time contributors need to be able
    // to sign too.
    if (!isPrivileged(payload, commenter)) return;
    await checkPR(prNumber);
  }
}

async function handlePullRequestTarget(payload) {
  if (!payload.pull_request) {
    // Same reasoning as the guard in handleIssueComment - a real
    // pull_request_target webhook always carries this.
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
    // Automatic trigger (PR opened/pushed to/reopened), not a human asking
    // a direct question - stay quiet on an already-compliant result unless
    // this PR previously needed action. See checkPR's quietIfNeverFlagged
    // doc comment above for the full reasoning.
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

// Only auto-run when executed directly (`node cla-bot.js`), not when
// required by the tests - otherwise importing this file would immediately
// try to run as a live Action and exit.
if (require.main === module) {
  main().catch((e) => fail(e.stack || e.message));
}

// Exported for tests only - not part of the action's public contract.
module.exports = {
  isSigned,
  isAllowlisted,
  createAppJWT,
  base64url,
  readSignatures,
  writeSignatures,
  isPrivileged,
  handleIssueComment,
  handlePullRequestTarget,
  checkPR,
  getSignaturesToken,
  postComment,
  validateConfig,
  lockPR,
  // Exported for tests only, same as everything above - not part of the
  // action's public contract. Covered directly in test/logic.test.js so a
  // future change to either validator's character rules (e.g. UNSAFE_URL_
  // SEGMENT_RE) fails immediately and specifically, rather than only being
  // caught indirectly through the webhook-handler integration tests.
  assertValidPRNumber,
  assertValidSha,
  // Exported for tests only, same reasoning: classifyBotComment() is the
  // exact piece that tells a genuine block apart from unrelated bot
  // chatter for checkPR's quietIfNeverFlagged logic, so it gets direct
  // unit coverage in test/logic.test.js in addition to the end-to-end
  // integration tests exercising it indirectly.
  classifyBotComment,
  // Exported for tests only, same reasoning: the exact per-signer wording
  // is a single source of truth used both when posting and when asserting
  // in tests, so a future wording tweak can't silently drift between them.
  personalSuccessMessage,
  // Exported for tests only, same reasoning as isSigned/isAllowlisted
  // above: this is the exact piece checkPR relies on to decide whether a
  // signer was actually one of a PR's own commit authors (as opposed to an
  // unrelated bystander), so it gets direct unit coverage of its id-first,
  // login-fallback matching rule in test/logic.test.js.
  isSameContributor,
  // Exported for tests only, same reasoning as isSameContributor above:
  // this is checkPR's single-source-of-truth definition of how a caller's
  // known-fresh write and a subsequent GET are reconciled, so it gets
  // direct unit coverage of its "fresh wins on a match, known-only entries
  // are kept" merge rule in test/logic.test.js.
  mergeSignatures,
  // Exported for tests only, same reasoning: this is checkPR's actual,
  // single-source-of-truth definition of "did this signer's own signature
  // complete the PR's requirement" - tests call this function directly
  // instead of re-typing the same expression themselves, so the two can
  // never drift out of sync with each other.
  signerCompletedRequirement,
};
