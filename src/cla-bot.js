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
 * 12. The author list for a PR comes from comparing two fixed commit SHAs
 *     (base...head), never from the PR's live, mutable commit list. A commit
 *     SHA can't change once it exists, so a force-push after the SHAs are
 *     read can't mix revisions into the list. See listCommitsBetween() and
 *     checkPR().
 * 13. Nothing is published until the PR is read once more and still has the
 *     pair that was checked. A moved head is skipped, a moved base is
 *     checked again. No REST call makes "confirm, then publish" atomic, so
 *     the PR is also read once more right AFTER publishing: a base that
 *     moved onto the same head during the write is caught there too, and the
 *     stale status is corrected rather than left standing. See checkPR().
 * 14. The co-author lookup budget is created once per checkPR() run and
 *     passed through every re-evaluation attempt, so the cap applies once
 *     per run, not once per attempt. It is keyed by the parsed identity (id
 *     or login), not the raw trailer address, so two trailers in the SAME
 *     format naming the same account share a slot instead of each costing
 *     one; the same account named once in each of the two formats still
 *     costs two, since telling them apart without a lookup is exactly what
 *     the budget exists to avoid - see SECURITY.md for why that's accepted.
 *     See createLookupBudget(), coAuthorLookupKey() and MAX_COAUTHOR_LOOKUPS_PER_RUN.
 * 15. That identity cap counts distinct accounts, not HTTP requests - gh()
 *     can retry a single one of them. A separate, hard ceiling on actual
 *     GITHUB_TOKEN requests (retries included) is enforced underneath it in
 *     ghRaw(), so the real request count this run makes is always bounded
 *     regardless of retries, pagination, or anything else. See
 *     MAX_GITHUB_TOKEN_REQUESTS_PER_RUN and consumeGitHubTokenRequest().
 * 16. If a status has already been published this run and anything after
 *     that - another attempt, a re-read, a comment write - then throws, the
 *     thrown error does not just propagate past a status that was never
 *     re-confirmed: checkPR() fails it closed first (best-effort, logging
 *     rather than throwing if that overwrite itself fails), then re-throws
 *     the original error so the run still visibly fails. See
 *     failClosedStatus() and checkPRInner().
 * 17. The request budget in point 15 lives in an AsyncLocalStorage store,
 *     one per checkPR() call, not a shared variable - two overlapping calls
 *     in the same process (checkPR() is exported and async; nothing but
 *     today's single-event call pattern rules this out) each get their own,
 *     with no risk of one finishing and clearing or overwriting the other's.
 *     See runWithGitHubTokenRequestBudget().
 * 18. failClosedStatus()'s own recovery write draws from a small separate
 *     reserve (GITHUB_TOKEN_EMERGENCY_RESERVE) before ever touching the main
 *     budget, so the exact exhaustion that can trigger a fail-closed
 *     overwrite is never also what blocks it from being sent.
 * 19. A base retarget with no new commit fires neither "synchronize" nor
 *     "closed"/"reopened", so handlePullRequestTarget() also reacts to
 *     "edited" - but only when payload.changes.base is present, GitHub's own
 *     signal that the base branch itself changed, not just the title or
 *     body. Without this, a status published for the old base could stay on
 *     the unchanged head indefinitely once a run finishes, since nothing
 *     inside one checkPR() run can detect a change landing after it returns.
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
// The per-commit cap above still leaves the total unbounded: a PR can have up
// to 10,000 commits (see MAX_LIST_PAGES), so a malicious one could carry up
// to 10,000 * 20 = 200,000 distinct co-author trailers, each costing an
// identity lookup. That is a real availability problem (the shared limiter
// would just queue all of it), not a slow run. This caps how many DISTINCT
// identities one checkPR() run will ever look up in total; past it, the
// remaining trailers are flagged for manual review instead of queued. See
// createLookupBudget() and listPRCommitAuthors().
//
// One checkPR() run can re-evaluate the same PR up to MAX_PAIR_ATTEMPTS times
// (the base can move under it, see checkPR()), so a single budget instance is
// created once per run and threaded through every attempt - it must NOT be
// recreated per attempt, or the real ceiling becomes MAX_PAIR_ATTEMPTS times
// this number.
//
// The default GITHUB_TOKEN GitHub gives an Actions job is rate-limited to
// 1,000 REST requests/hour per repository. 300 leaves comfortable room under
// that for a single run's other traffic (paging the commit compare, paging
// comments, reading/writing the status, reading the PR itself) while still
// covering realistic co-author counts; past it a human reviews the rest.
//
// This counts distinct identities admitted, not HTTP requests - gh()
// transparently retries a transient failure (see MAX_RETRIES), so one
// admitted identity can cost more than one actual request. That gap is what
// MAX_GITHUB_TOKEN_REQUESTS_PER_RUN below closes: it is a hard ceiling on
// every actual GITHUB_TOKEN request this run makes, retries included, and is
// what actually keeps the run under GitHub's 1,000/hour, regardless of how
// this number or anything else adds up. Keep this one for what it's good at
// instead - an early, cheap filter that avoids spending any requests at all
// on a pathologically large PR - rather than trying to make it a request
// count itself.
const MAX_COAUTHOR_LOOKUPS_PER_RUN = 300;

// Hard ceiling on actual GITHUB_TOKEN HTTP requests for one event's
// processing, counted in ghRaw() - every attempt counts, including retries,
// so this is a real request count, not a logical one. Once it's spent, gh()
// refuses to make another GITHUB_TOKEN request rather than let this one
// event's processing blow past a sane bound - see consumeGitHubTokenRequest().
//
// This is a genuinely hard ceiling - total consumption, normal traffic and
// the emergency reserve below combined, can never exceed this number for
// ONE event; it is not "700 plus a bit more for emergencies". See
// runWithGitHubTokenRequestBudget().
//
// What this is NOT: a guarantee that the repository's real, GitHub-side
// GITHUB_TOKEN limit (1,000 requests/hour, shared by every workflow run in
// the repository, not per-run) is respected. 700 comfortably covers one
// event's own worst case with headroom to spare, but each event gets its
// own fresh 700 - several events landing in the same hour (several PRs each
// getting pushed to, say) can still add up past 1,000 on GitHub's side even
// though no single one of them ever went over its own 700. There is no
// in-process fix for that: each event is a separate workflow run in a
// separate process, so nothing here can see what another run has already
// spent. A real repository-wide guarantee would need state shared across
// processes (committed to a file, a cache, some external store) with its
// own consistency and cost problems, for a failure mode that is already
// self-limiting: going over the real limit makes GitHub itself start
// refusing requests, which this bot already treats as a hard failure rather
// than something to work around - it fails the run, not the CLA decision.
// 700 is a per-event safety budget against one event's own runaway
// consumption (a pathologically large PR, a list that won't stop growing),
// not a repository-wide rate-limit guarantee.
//
// handleIssueComment() and handlePullRequestTarget() each start one of these
// for their own entire call, not just for checkPR() - a signing comment
// reads and writes the signature store, and does so with GITHUB_TOKEN
// whenever no separate App installation token is configured (see
// mintSignaturesToken()), before checkPR() is even reached, so leaving that
// traffic out would make "one event's processing" not actually mean the
// whole event. checkPR() also starts its own budget too, for any caller that
// reaches it some other way (every test does, and it's an exported
// function, so a future caller might too) - see
// runWithGitHubTokenRequestBudget()'s reentrancy. The signatures repo's own
// token (an installation token, when one is configured) is a separate
// credential with its own separate quota, so it is not counted here.
const MAX_GITHUB_TOKEN_REQUESTS_PER_RUN = 700;

// A small slice carved OUT of the budget above, set aside purely for
// failClosedStatus()'s own recovery write - never spent by normal operation,
// so the one write that exists specifically to fail a run closed can't
// itself be the thing the budget blocks. Without this, the run can hit the
// ceiling on a request that happens to follow a successful publish, and the
// recovery write - needing a request of its own - would be refused for
// exactly the same reason, deterministically: see failClosedStatus().
const GITHUB_TOKEN_EMERGENCY_RESERVE = 10;

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
// Run-wide GITHUB_TOKEN request budget - see MAX_GITHUB_TOKEN_REQUESTS_PER_RUN.
//
// This is carried in an AsyncLocalStorage store, not a plain module-level
// variable: checkPR() is an exported, async, re-entrant function, so two
// overlapping calls (in the same process, from a caller that doesn't await
// one before starting the next) are a real possibility the implementation
// has to hold up under, not just the one-call-per-process shape this Action
// happens to use today. A single shared counter would let one run's
// completion (resetting it to null) blow away another still-in-flight run's
// remaining budget, or let two runs silently share one 700-request ceiling
// instead of each getting their own. AsyncLocalStorage gives every call to
// runWithGitHubTokenRequestBudget() its own store, correctly followed
// through every `await` in that call's entire async chain regardless of how
// it interleaves with any other call's chain - no manual threading of a
// budget object through every function between checkPR() and ghRaw() is
// needed to get that isolation.
//
// getStore() returns undefined outside any such call - every other entry
// point, and every test that calls ghRead/listCommitsBetween/etc. directly, is
// unaffected, same as before.
// ---------------------------------------------------------------------------
const _githubTokenRequestBudget = new AsyncLocalStorage();

// Runs fn() with its own fresh, isolated GITHUB_TOKEN request budget - see
// checkPR(). The store is a plain mutable object specifically so nested
// calls within the same async chain (there are none today, but nothing
// stops a future one) share the one store AsyncLocalStorage hands them,
// rather than each creating another nested layer.
// Reentrant: if a budget is already active (an outer handleIssueComment() or
// handlePullRequestTarget() call already started one - see those functions),
// this just runs fn() under that SAME store rather than starting a nested,
// fresh one. That's what lets the budget cover a whole event's real
// GITHUB_TOKEN traffic (including a signature read/write that happens before
// checkPR() is ever called) while checkPR() itself still gets its own
// self-contained budget on any OTHER path that calls it directly, without
// going through either handler - tests do this throughout, and it's exactly
// the guarantee a direct caller of this exported function should get.
//
// emergencyReserve is carved OUT of max, not added on top: total consumption
// across both pools can never exceed max - "max is the hard ceiling" is then
// literally true, not an approximation that needs a footnote.
function runWithGitHubTokenRequestBudget(max, emergencyReserve, fn) {
  if (_githubTokenRequestBudget.getStore()) return fn();
  return _githubTokenRequestBudget.run(
    { remaining: max - emergencyReserve, emergencyReserve },
    fn,
  );
}

// Called once per actual HTTP attempt made with GITHUB_TOKEN specifically -
// see ghRaw(). A token that isn't GITHUB_TOKEN (the signatures repo's own
// installation token, when configured) has its own separate rate limit and
// is deliberately not counted here.
//
// emergency is for failClosedStatus()'s own recovery write only (see
// GITHUB_TOKEN_EMERGENCY_RESERVE): it draws from the reserve first, so it
// can never be blocked by the very exhaustion that made it necessary: only
// once the reserve is also gone does it fall back to competing for whatever
// is left of the main budget, same as any other request.
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

// ---------------------------------------------------------------------------
// HTTP helper: timeout, JSON handling and a retry for transient failures
// (rate limits, brief 5xx). 409 conflicts on writes are handled in
// writeSignatures(), since they need a re-read, not a blind retry.
// ---------------------------------------------------------------------------
async function ghRaw(path, token, options = {}) {
  // Counted here, not in gh(), so every actual attempt is counted once -
  // gh()'s retry calls ghRaw() again per attempt (options, emergency
  // included, passed through unchanged each time), this never double-counts
  // a single attempt, and a caller that bypasses gh() and calls ghRaw()
  // directly still can't evade the budget.
  consumeGitHubTokenRequest(token, { emergency: options.emergency === true });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const fetchOptions = { ...options };
  delete fetchOptions.preserveUnsafeIds;
  try {
    const res = await fetch(`${GITHUB_API}${path}`, {
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

// ---------------------------------------------------------------------------
// Reads that can run side by side
//
// A PR can need lots of independent reads: one lookup per co-author, one
// request per page of commits, and the bot's own login and the first page of
// comments, which are asked for together. One at a time is slow, and all at
// once can trip GitHub's secondary rate limits. So they share one limiter and
// only 8 are in flight at any moment.
//
// Only reads use it. Writes (comments, statuses, locks, deletes, signature
// updates) stay one at a time: GitHub asks for a pause between them, and
// people can see the order of the comments.
//
// A slot is held for the whole gh() call, retries included, so a rate-limited
// run slows down instead of piling on. A task is a single request, so tasks
// never wait on each other and this can't deadlock.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Paginated reads of the commits between two SHAs
//
// Page 1's `Link` header names the last page, so we can fetch the rest at the
// same time and join them in order. We only take the page *number* from the
// header and never request the URL it names. With no usable header we walk
// one page at a time, see listCommitsBetween().
//
// Every read is capped at MAX_LIST_PAGES pages, regardless of what the
// header or data says. Past that we fail instead of walking on. A list of
// exactly 10,000 items (100 full pages) is legitimate, so the limit is "more
// than 100 pages", not "100 pages". Comment history is also read one page at
// a time and retains only a bounded subset of comments in memory, but its
// compact ordering counters still require scanning every page within this
// explicit request bound.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Commits between two fixed, immutable SHAs (the "Compare two commits"
// endpoint)
//
// `/pulls/{n}/commits` tracks the PR's CURRENT head - a moving target that
// can change mid-read, and capped at 250 commits. Compare instead takes two
// exact commit objects and returns `git log base..head` for THOSE two
// objects. A commit's SHA never changes once it's made, so once base and
// head are pinned, this read cannot be mixed by a force-push that happens
// afterwards - there's nothing left to race, because we're no longer
// reading a live ref. Paginating also removes the 250-commit cap, since
// that cap only applies to an unpaginated request. See checkPR().
// ---------------------------------------------------------------------------
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
//
// The id part must look exactly like a real GitHub account id: no leading
// zero (GitHub never pads one) and short enough that it can't overflow
// Number's safe range. `[1-9][0-9]{0,15}` already rules out "0" and
// anything with a leading zero; isValidGitHubUserId() below does the final
// Number.isSafeInteger check, same as every other id in this file.
const NEW_NOREPLY =
  /^([1-9][0-9]{0,15})\+([^@]+)@users\.noreply\.github\.com$/i;
const OLD_NOREPLY = /^([^@+]+)@users\.noreply\.github\.com$/i;

// ---------------------------------------------------------------------------
// Identity lookups (login -> id, id -> login, and the bot's own login)
//
// The caches hold the promise, stored before the request is awaited, so two
// callers asking for the same key share one request. That matters now that
// listPRCommitAuthors() looks things up in parallel.
//
// The fetchers never reject: any failure becomes null (or the default bot
// login). Failures are cached on purpose, so a bad co-author costs one request
// per run, and null is flagged for manual review, so it fails closed. A
// fetcher that can reject must also remove its own cache entry.
//
// These caches live exactly as long as the process: there's no eviction or
// TTL. That's intentional for how this is actually deployed - one GitHub
// Actions job handles exactly one event and exits, so the cache never
// outlives the run it was built for (see main()). It would be the wrong
// choice for a long-lived process serving many events over time, where a
// renamed or deleted account could go stale in the cache - this module
// isn't meant to run that way, and nothing here should be read as a
// guarantee that it's safe to.
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

// Reads the Co-authored-by trailers of a commit message. GitHub doesn't check
// them, so for the new noreply format we look the login up by id instead of
// trusting the text. Anything we can't resolve is flagged for manual review.
// The raw email is never returned: it can be personal data and ends up in
// logs.
//
// parseCoAuthorEmails() picks which trailers count (no repeats, at most
// MAX_COAUTHOR_TRAILERS_PER_COMMIT). extractCoAuthors() looks them all up at
// once and keeps the trailer order.
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
    // NEW_NOREPLY's own pattern already blocks "0" and a leading zero, but
    // the safe-integer check still matters: the regex allows up to 16
    // digits so a 20-digit id doesn't silently pass, and a 16-digit one can
    // still land past Number.MAX_SAFE_INTEGER. A trailer that fails this
    // is never a real GitHub id, so skip the lookup and fall through to
    // unresolved instead of asking the API about a number we can't trust.
    if (isValidGitHubUserId(claimedId)) {
      // Ignore the login text in the trailer and ask GitHub for the real one.
      const authoritativeLogin = await resolveLoginById(claimedId);
      if (authoritativeLogin !== null) {
        return { id: claimedId, login: authoritativeLogin };
      }
      // The id matches no current account, so fall through.
    }
  }

  // Old format: `login@users.noreply...`, with no account id in it. If that
  // person renamed their account the login won't resolve (GitHub doesn't
  // redirect old usernames) and no API maps it to an id, so it ends up
  // unresolved and a maintainer checks the commit. If someone else took the
  // old login, it resolves to them and we can't tell. The new format
  // (`id+login@...`) doesn't have this problem, it is looked up by id.
  const oldStyle = email.match(OLD_NOREPLY);
  if (oldStyle) {
    const login = oldStyle[1];
    const id = await resolveUserIdByLogin(login);
    if (id !== null) return { id, login };
    // The lookup failed (for example a deleted account), so fall through.
  }

  return null;
}

// Tracks how many distinct lookup KEYS one run is willing to admit in total,
// across every commit. A key already admitted stays free to admit again (it
// costs nothing extra, the id/login caches dedupe it); a new one is only
// admitted while there's room left in the budget. No `max` means no limit,
// so extractCoAuthors() stays usable on its own in tests.
//
// The caller decides what a "key" is - see coAuthorLookupKey() below. It is
// deliberately not the raw trailer email: two different noreply addresses
// can still name the same GitHub account (the new id-based format and the
// old login-based one resolve through different lookups but can point at one
// person), so keying on the raw address would let one account burn more than
// one slot of the budget and push an otherwise-ordinary PR into manual
// review. Keying on the parsed (id or login) identity instead means the
// budget tracks accounts, not trailer spellings.
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

// The budget key for one trailer address, or null when the address is never
// going to cost a lookup in the first place (see resolveCoAuthorEmail(): it
// only ever calls the API for the two noreply formats below, anything else
// resolves to null with no request at all). Keying by the parsed id/login
// rather than the raw address also means two trailers that both name the
// same account - say, the same id with a different claimed login text in
// each - share one slot instead of two, since resolveLoginById() looks them
// up the same way regardless of what the trailer's login text says.
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
  // Trailers past the per-commit cap are already excluded by parseCoAuthorEmails
  // above (capped=true). Here we additionally drop whatever the shared,
  // per-run budget has no room left for - same effect (flag for manual
  // review instead of looking it up), different reason.
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

// baseSha and headSha must both be exact commit SHAs, already pinned by the
// caller (see checkPR()), not branch names - that's what makes this read
// immune to anything that happens on the PR branch after they're read.
//
// lookupBudget defaults to a fresh MAX_COAUTHOR_LOOKUPS_PER_RUN budget so this
// stays usable on its own (directly, or in tests). checkPR() must NOT rely on
// that default: it creates one budget per run and passes it in explicitly on
// every call, including every re-evaluation attempt, so the cap applies once
// per run - not once per attempt. See checkPR() and MAX_COAUTHOR_LOOKUPS_PER_RUN.
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

// Comment history is requested explicitly in creation/id ascending order; a
// comment's id never changes. A list read over several pages can still hand back the same
// comment twice, or out of order, when the list changes while it is being
// read. Such an entry must not count: a repeat would be read as a second copy
// of that comment, and dedupeIdenticalTrailingComments() would then delete
// one of the "two" - which is the only one. So an entry counts only if its id
// is above every id taken so far.
//
// Returns a function to call once per entry, in listing order: true to take
// the entry, false to skip a repeat or an out-of-order one. It keeps one
// BigInt, so it is as cheap on a huge history as on a small one (the readers
// below stream the history on purpose, and must not start holding it). An
// entry with an invalid or untrustworthy id is skipped.
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

// ---------------------------------------------------------------------------
// Per-run cache for a PR's comment history, shared by three different
// questions checkPR() and postComment() ask about the same PR, sometimes
// more than once in one run: checkPR()'s own "is a success announcement
// overdue" history check (pendingIsNewerThanSuccess()), postComment()'s own
// dedupe check - sometimes twice, for the thank-you and the pending list
// (latestOwnCommentBody()), and (only for tests or other direct callers,
// see below) getExistingBotComments()'s general-purpose comment list. All
// three page through the exact same raw comments - only what each extracts
// from them differs - so the paginated fetch itself happens at most once
// per PR per run instead of being repeated for each.
//
// The post-write duplicate cleanup (dedupeIdenticalTrailingComments(), via
// findExactDuplicateComments()) is NOT one of these three: it needs the
// PR's entire comment history, every time, with no cap and no reuse of a
// stale pre-write snapshot (see findExactDuplicateComments() for why a
// separate, always-fresh, uncapped fetch is still safe there), so it
// deliberately has its own, completely separate fetch instead of sharing
// this cache at all.
//
// checkPR() opens one AsyncLocalStorage run with a fresh Map and everything
// it calls - postComment(), pendingIsNewerThanSuccess(),
// latestOwnCommentBody() - picks that same Map up automatically through
// commentsCacheStorage.getStore(), with no cache argument threaded through
// any of their signatures. This is what AsyncLocalStorage is for:
// request-scoped state that many functions down a call tree need, without
// every one of them taking and forwarding an extra parameter just to pass
// it along (easy to forget at some future call site, which would silently
// turn caching off there). A call made outside any checkPR() run -
// postComment() used on its own, or a direct call in tests - simply finds
// no store, so it gets no caching: the original, always-fresh behavior for
// a one-off call.
//
// Like the identity lookups above, a cache entry holds the in-flight fetch,
// so callers that overlap share one fetch, and a failed fetch evicts itself
// so the next caller gets a real retry instead of a cached error.
// After that snapshot resolves, successful writes and deletes made by this
// run are applied to it (write-through). This is intentionally an invocation
// snapshot, not a linearizable view of GitHub: external edits/deletes do not
// rewrite history already observed, and an external comment added mid-run may
// not be seen. Production callers are safe under the required consumer
// workflow concurrency group (documented in SECURITY.md):
// - pendingIsNewerThanSuccess() reads the append-only history of whether this
//   PR was previously blocked; deleting a comment does not undo that event.
//   On the automatic path it is the first comment-history read in checkPR(),
//   immediately before the quiet/success decision.
// - latestOwnCommentBody() is only a dedupe optimization. It sees this run's
//   own writes through the cache; a concurrent run is serialized by the
//   workflow group, and the fresh post-write scan repairs duplicates if a
//   post actually occurs.
// A consumer that omits the concurrency group accepts stale decisions across
// overlapping runs; a fresh read would only narrow that race, not make the
// multi-request REST decision atomic.
//
// `fresh: true` always hits GitHub and replaces the cache entry, for a
// direct caller of getExistingBotComments() that wants to bypass whatever
// is cached (no internal caller needs this anymore - see above - so it
// exists for tests and other direct use). This only orders a stale fetch's
// own FAILURE against a newer one's success (see the eviction guard below)
// - two fresh:true fetches for the same PR that both succeed settle on
// whichever happens to finish last, same as any cache with concurrent
// writers. `cache` itself is exposed as a plain parameter mainly so tests
// can exercise the caching on its own, without a whole checkPR() run.
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

// isPossiblyBotIdentity() is deliberately broad (any Bot-type account, not
// just this bot's own - that is what lets `anyBotIdentity` survive a token
// rotation), so it does NOT by itself bound how many comments this run ever
// retains: nothing stops some other installed app, or a compromised one,
// from posting many large comments that happen to carry BOT_MARKER too.
// MAX_CACHED_COMMENTS is the actual, hard bound - see where it's applied in
// fetchAllIssueCommentsUncached() below. 200 is far more than this bot's own
// comments ever realistically reach on one PR (dedupeIdenticalTrailingComments
// keeps that near-zero in steady state), while still capping worst-case
// per-PR cache memory to a small, fixed, auditable number regardless of how
// many marker-bearing Bot-type comments a PR accumulates.
const MAX_CACHED_COMMENTS = 200;

// A public PR can carry comments from untrusted contributors in unbounded
// number and size, so this run's cache must never hold more than the bot's
// own small, bounded set of comments - not every human comment's full
// GitHub payload for the whole life of the run. Three things keep the
// CACHED LIST small - see the separate note on lastPendingSeq/lastSuccessSeq
// below for the one thing that is deliberately NOT bounded by any of these,
// because it cannot be without a real correctness cost:
//
// - Only a comment that BOTH carries BOT_MARKER AND has an authenticated
//   identity isPossiblyBotIdentity() accepts is ever kept at all. The
//   identity half is what actually makes this safe: BOT_MARKER alone is
//   just a literal HTML comment, and any contributor can paste it into
//   their own comment on a public PR - user.login/user.type are set by
//   GitHub from who is actually authenticated as posting, which a commenter
//   cannot forge by editing their comment body. A spoofed marker on an
//   ordinary human comment fails this check and is never cached - getting
//   past it would mean already controlling some Bot-type account.
// - MAX_CACHED_COMMENTS hard-caps what even an admitted flood can cost (see
//   above): only the most recent MAX_CACHED_COMMENTS admitted comments are
//   ever kept, trimmed as they come in, so the LIST never holds more than
//   that regardless of how many qualify in total. Trimming the OLDEST
//   entries (GitHub returns comments oldest-first) rather than refusing new
//   ones is deliberate: this list is only ever used to find an EXACT,
//   recent duplicate (postComment()'s own dedupe, and the post-write
//   cleanup) - both inherently care about recent matches only, so a flood
//   of old noise is exactly what should be dropped first. Every page is
//   still read in full either way - a flood earlier in the thread can never
//   make this stop short of a genuine, more recent bot comment later in it.
// - Only the few fields the rest of this file ever reads from a comment
//   (id, body, user.login, user.type) are kept, not the full GitHub object
//   (timestamps, URLs, avatar, reactions, and so on).
//
// lastPendingSeq/lastSuccessSeq answer a DIFFERENT question than the list
// above: not "what did the bot say recently" but "did a pending flag ever
// go out that a success announcement hasn't closed out yet" - checkPR()'s
// quietIfNeverFlagged check (see pendingIsNewerThanSuccess() below) needs
// the TRUE answer over the PR's whole history, not just its most recent
// MAX_CACHED_COMMENTS comments: trimming old entries from the list above is
// safe for exact-duplicate lookups, but would silently give the wrong
// answer here if an old, still-unresolved pending comment ever aged out of
// the window. So these two are never trimmed and never hold a comment or
// its body at all - just which admission-order position ("seq") the most
// recent "pending" and the most recent "success" were last seen at, each
// overwritten in place as a later one of the same category comes along.
// That is two integers, genuinely O(1) regardless of how many comments a PR
// has ever accumulated - correct at any scale, not just within a cap.
async function fetchAllIssueCommentsUncached(prNumber, botLoginPromise) {
  const all = [];
  let seq = 0;
  let lastPendingSeq = -1;
  let lastSuccessSeq = -1;
  // Latest comment BODY per category, for the CURRENT (strict) identity
  // only - never the broader anyBotIdentity match. Same reasoning and same
  // "just overwrite it, never trim it" technique as lastPendingSeq /
  // lastSuccessSeq above: classifyBotComment() only ever returns one of a
  // small fixed set of categories, so this is bounded by that set, not by
  // how many comments the PR has - see latestOwnCommentBody() below for who
  // actually needs this.
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

// Whether a broad-identity "pending" comment is more recent than the last
// broad-identity "success" comment (or there is no success yet) - the exact
// question checkPR()'s quietIfNeverFlagged branch needs answered, using
// lastPendingSeq/lastSuccessSeq above so the answer is correct regardless of
// how many bot-marked comments the PR has ever accumulated, not just within
// MAX_CACHED_COMMENTS. Shares the same cached fetch as any other read for
// this PR in the same run (when `cache` is set), same as
// getExistingBotComments() - this only reads the sequence numbers from it,
// never the list itself.
async function pendingIsNewerThanSuccess(prNumber) {
  const cache = commentsCacheStorage.getStore();
  const botLoginPromise = resolveBotLogin();
  const { lastPendingSeq, lastSuccessSeq } = await fetchAllIssueComments(
    prNumber,
    { cache, botLoginPromise },
  );
  return lastPendingSeq > lastSuccessSeq;
}

// The current bot identity's own latest comment body for `category` (or
// undefined if it has never posted one) - what postComment()'s own dedupe
// check needs: "did I already say exactly this, most recently?" Using
// latestOwnBodyByCategory above keeps this correct regardless of how many
// bot-marked comments the PR has ever accumulated, not just within
// MAX_CACHED_COMMENTS - the same reasoning as pendingIsNewerThanSuccess()
// just above. Shares the same cached fetch as any other read for this PR in
// the same run.
async function latestOwnCommentBody(prNumber, category) {
  const cache = commentsCacheStorage.getStore();
  const botLoginPromise = resolveBotLogin();
  const { latestOwnBodyByCategory } = await fetchAllIssueComments(prNumber, {
    cache,
    botLoginPromise,
  });
  return latestOwnBodyByCategory[category];
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

// Deletes targeted by one dedupeIdenticalTrailingComments() cleanup are each
// independent, so they run together rather than one after another - but
// without some limit, a pathological PR with many duplicate bot comments
// (MAX_CACHED_COMMENTS already bounds that count, but it's still up to a few
// hundred in the worst case) would fire that many DELETE requests at GitHub
// in one burst. That is more likely to trip its secondary rate limiting than
// to finish any faster, so only this many run at once.
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
    }
    // It may already be gone, or the token may lack permission. This is
    // cosmetic cleanup, so do not fail the run.
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

// Finds exact matches for the CURRENT bot identity across the full history.
// The complete fresh scan is needed because the regular cache is capped and
// predates this post. Matching IDs are spooled to a private temporary file so
// discovery does not retain a history-sized array in memory; deletions start
// only after pagination finishes, because deleting during a page-number scan
// would shift later pages and could skip comments. This intentionally trades
// O(number of matching IDs) temporary disk and O(number of history pages) API
// reads for complete-history cleanup within MAX_LIST_PAGES. Exceeding that
// explicit safety bound fails the scan before any deletion begins. The
// pre-post cache fetch follows the same bound while retaining correct
// pending/success ordering and latest-own-category state beyond
// MAX_CACHED_COMMENTS.
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

// The "no matching comment yet, so post" check in postComment() is two HTTP
// calls with nothing atomic between them, so two concurrent runs can both
// post. The fresh full-history scan is the backstop for that race. GitHub
// returns issue comments oldest-first, so keep the final (newest) match and
// delete all earlier exact matches in bounded batches.
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

// How many times checkPR() re-evaluates when the PR's base or head moves
// under it before giving up.
const MAX_PAIR_ATTEMPTS = 3;

// Who is on the commits between this exact pair, and who of them still has to
// sign. Publishes nothing.
//
// lookupBudget is created once by the caller (checkPR()) and passed in here
// unchanged on every attempt, so the co-author lookup cap applies across the
// whole run rather than resetting each time this is called. It falls back to
// a fresh budget only so evaluatePair() stays directly callable (e.g. tests).
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
  // The signatures file is read after the commit list so it is as fresh as
  // possible. That narrows the race with other runs; the workflow's
  // `concurrency:` group is what closes it. We read it even with
  // `knownSignatures`, see mergeSignatures().
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
  return { authors, unresolved, missing };
}

// Best-effort only: used after something has already gone wrong and a status
// that was published earlier can no longer be trusted (see checkPR()). A
// further failure here is logged, not thrown - the original problem is what
// should surface and fail the run, not a secondary issue with this safety
// net overwriting it.
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

// Writes the status (and, unless statusOnly, the comment) for one confirmed
// evaluation. Pulled out of checkPR() so the retry loop below can call it
// more than once: GitHub gives us no way to publish a status only if the PR
// is still the exact pair we checked, so checkPR() calls this, then reads the
// PR once more to see whether that publish is still valid - see checkPR().
//
// onStatusPublished fires the instant setStatus() itself succeeds, before
// anything else in this function runs. The status is the part that actually
// matters for branch protection; the comment below it is cosmetic. If the
// comment step throws, the caller still needs to know a status DID land, so
// it does not mistake "this call threw" for "nothing was published" - see
// checkPR()'s use of this.
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
    eventBaseSha = null,
  } = {},
) {
  assertValidPRNumber(prNumber, "checkPR(prNumber)");
  // A headSha we were given is checked before any request is made.
  if (headSha) assertValidSha(headSha, "checkPR(headSha)");
  if (eventBaseSha) assertValidSha(eventBaseSha, "checkPR(eventBaseSha)");

  // One budget for the whole run, shared across every evaluation attempt
  // below (including re-evaluations after the pair moved). It must be
  // created once here, not inside the loop or inside evaluatePair()'s
  // default - otherwise a PR that forces several attempts gets the full cap
  // again on each one. See MAX_COAUTHOR_LOOKUPS_PER_RUN.
  const lookupBudget = createLookupBudget(MAX_COAUTHOR_LOOKUPS_PER_RUN);
  // The hard, run-wide ceiling on actual GITHUB_TOKEN requests - see
  // MAX_GITHUB_TOKEN_REQUESTS_PER_RUN. Each call gets its own isolated
  // store (see runWithGitHubTokenRequestBudget()), so two overlapping
  // checkPR() calls in the same process can never share or clobber each
  // other's budget, and this one is automatically done with once this
  // call's async chain finishes, success or failure - nothing to reset
  // afterward, and nothing to leak into anything that runs after it.
  //
  // The run-scoped comments cache (see the comment above
  // commentsCacheStorage for what it buys and why it is scoped this way, not
  // at module level) is opened inside it, once per call, and is shared by
  // every evaluation attempt below: postComment(), pendingIsNewerThanSuccess()
  // and the rest of what this run calls pick the same Map up on their own,
  // and our own writes are applied to it as they happen, so a later attempt
  // sees what an earlier one in this run already posted.
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

  // The status and the author list must describe the same revision. We
  // compare two fixed commit SHAs (base...head), so nothing on the branch can
  // change the list mid-read. The one thing left to get right is which pair:
  // - The webhook gave us both base and head (pull_request_target). Start from
  //   that exact pair, so no base from a later state is mixed with the
  //   event's head.
  // - Otherwise read the PR once and use its own base and head together.
  // Either way the pair can go stale while we work, so right before
  // publishing we read the PR once more - and because GitHub gives us no way
  // to make "confirm, then publish" one atomic operation, we read it once
  // again right AFTER publishing too. Either re-check finding the pair
  // changed sends us back around the same loop; MAX_PAIR_ATTEMPTS bounds the
  // whole thing, pre- and post-publish checks together.
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
  // Tracks whether a status has actually landed on GitHub this run, and for
  // which head - set the instant setStatus() succeeds (see
  // publishEvaluation()'s onStatusPublished), not after publishEvaluation()
  // returns. A status write can be followed by a comment write that fails,
  // or by a PR re-read that fails (rate limit, network): either throws past
  // the point where these would otherwise be set. The catch below is what
  // lets a published-but-now-uncertain status still be found and corrected,
  // instead of silently standing simply because something after it failed.
  let everPublished = false;
  let lastPublishedHeadSha = null;

  try {
    // settled only ever becomes true right before a `break` (see below), so
    // checking it here too would be redundant - the loop can only ever end
    // either by running out of attempts or by that `break`.
    for (let attempt = 1; attempt <= MAX_PAIR_ATTEMPTS; attempt++) {
      const result = await evaluatePair(pair, knownSignatures, lookupBudget);

      // Last look before publishing. If the PR moved while we were reading,
      // this result no longer describes it. A moved head is left to the
      // event for the new head when the caller pinned one. A moved base has
      // no event of its own, so the pair is evaluated again instead of
      // leaving the PR with no status.
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

      // The pair was confirmed fresh immediately before this. Publish it,
      // then read the PR once more: there is no REST primitive that
      // publishes a status only if the PR is still this exact pair, so this
      // is the closest we can get. A change can still land after that read,
      // including after this run finishes. There is no bounded time guarantee
      // for how long a status can remain stale; that depends on when another
      // check is triggered. Every attempt that lands here starts from a pair
      // just re-confirmed, which is the strongest guarantee this API allows.
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
        // The head moved on from under the status we just wrote. That
        // status is bound to the exact head SHA it was written for, which is
        // no longer this PR's head, so it cannot satisfy anything checking
        // the PR's current head - the event for the new head covers it.
        // Nothing left to correct for the old head.
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
      // A status was published at some point this run, but something after
      // it - another attempt's evaluation, a re-read, a comment write - blew
      // up before we could either confirm it still holds or correct it. Do
      // not let it stand unconfirmed: fail closed, then let the original
      // error surface so the run is still visibly a failure.
      await failClosedStatus(
        lastPublishedHeadSha,
        "An error occurred while finishing this CLA check, so the previous result could not be confirmed; comment `recheck` to try again.",
      );
    }
    throw err;
  }

  if (!settled) {
    if (everPublished && lastPublishedHeadSha) {
      // We did publish at least once, but every time we checked right after,
      // the PR had already moved on again - so whatever we last wrote may no
      // longer be accurate. Leave the head in a known, conservative state
      // instead of trusting a status that was already shown to be stale by
      // the time we looked.
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

// Wraps the whole handler in one GITHUB_TOKEN request budget - see
// MAX_GITHUB_TOKEN_REQUESTS_PER_RUN. A signing comment reads and writes the
// signature store (with GITHUB_TOKEN, unless a separate App token is
// configured) before checkPR() is ever reached, so the budget has to start
// here, not inside checkPR(), to actually cover everything this event does.
async function handleIssueComment(payload) {
  return runWithGitHubTokenRequestBudget(
    MAX_GITHUB_TOKEN_REQUESTS_PER_RUN,
    GITHUB_TOKEN_EMERGENCY_RESERVE,
    () => handleIssueCommentInner(payload),
  );
}

async function handleIssueCommentInner(payload) {
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

// See handleIssueComment() for why this budget is started at the handler,
// not inside checkPR().
async function handlePullRequestTarget(payload) {
  return runWithGitHubTokenRequestBudget(
    MAX_GITHUB_TOKEN_REQUESTS_PER_RUN,
    GITHUB_TOKEN_EMERGENCY_RESERVE,
    () => handlePullRequestTargetInner(payload),
  );
}

async function handlePullRequestTargetInner(payload) {
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
  // "edited" also fires for a title or body change, which doesn't need a
  // re-check - only react to it when payload.changes names "base", GitHub's
  // own signal that the PR was actually retargeted to a different base
  // branch. Without this, a retarget with no new commit (so no
  // "synchronize") never gets evaluated against its new base: the
  // Compare-based commit list and the status it produces would both still
  // describe the old base indefinitely, until something else happens on the
  // PR. See checkPR().
  const isGenuineRetarget =
    payload.action === "edited" && payload.changes && payload.changes.base;
  if (
    ["opened", "synchronize", "reopened"].includes(payload.action) ||
    isGenuineRetarget
  ) {
    const headSha = assertValidSha(
      payload.pull_request.head && payload.pull_request.head.sha,
      "pull_request_target payload pull_request.head.sha",
    );
    // Automatic trigger, not a direct question, so stay quiet on a clean
    // result unless the PR was blocked before. See checkPR().
    const baseSha = assertValidSha(
      payload.pull_request.base && payload.pull_request.base.sha,
      "pull_request_target payload pull_request.base.sha",
    );
    await checkPR(prNumber, headSha, {
      quietIfNeverFlagged: true,
      eventBaseSha: baseSha,
    });
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
