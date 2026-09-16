"use strict";
/**
 * Offline unit tests - no network calls, no GitHub API needed.
 * Run: node test/logic.test.js (or `npm test`)
 */
const assert = require("assert");
const crypto = require("crypto");

// Point the module at dummy required env vars just so the top-of-file
// destructuring doesn't matter for the pure functions we import the
// require.main guard means main() itself never runs here.
process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || "dummy";
process.env.SIG_OWNER = process.env.SIG_OWNER || "fossasia";
process.env.SIG_REPO = process.env.SIG_REPO || "cla-signatures";
process.env.CLA_DOCUMENT_URL =
  process.env.CLA_DOCUMENT_URL || "https://example.com/CLA.md";
process.env.ALLOWLIST = "dependabot[bot],renovate[bot]";

const {
  isSigned,
  isAllowlisted,
  createAppJWT,
  base64url,
  isPrivileged,
  assertValidPRNumber,
  assertValidInstallationId,
  assertValidSha,
  classifyBotComment,
  personalSuccessMessage,
  isSameContributor,
  signerCompletedRequirement,
  mergeSignatures,
  extractCoAuthors,
  fail,
} = require("../src/cla-bot.js");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (e) {
    console.error(`FAIL: ${name}\n - ${e.message}`);
    process.exitCode = 1;
  }
}

// --- signature matching ---------------------------------------------------
test("signature match is case-insensitive", () => {
  const data = { signatures: [{ login: "AmanKumar" }] };
  assert.strictEqual(isSigned(data, "amankumar"), true);
});

test("signature match does not false-positive on unrelated user", () => {
  const data = { signatures: [{ login: "AmanKumar" }] };
  assert.strictEqual(isSigned(data, "someoneelse"), false);
});

test("signature match on empty store returns false", () => {
  assert.strictEqual(isSigned({ signatures: [] }, "anyone"), false);
});

// --- identity: signatures survive a GitHub username rename/reclaim -------
test("signature match is keyed on immutable id, not the (mutable) login", () => {
  // alice signed while her login was "alice", recorded with her numeric id.
  const data = { signatures: [{ id: 555, login: "alice" }] };
  // She has since renamed to "alice-new" - the PR-authors lookup will now
  // report her under her NEW login, but her id hasn't changed.
  assert.strictEqual(isSigned(data, { id: 555, login: "alice-new" }), true);
});

test("a different account that reclaims a released login is NOT treated as already signed", () => {
  // Same scenario as above, but "alice" is now released and claimed by
  // someone else entirely (a different numeric id).
  const data = { signatures: [{ id: 555, login: "alice" }] };
  assert.strictEqual(isSigned(data, { id: 999, login: "alice" }), false);
});

test("isSigned still works with a bare login string (legacy call shape / no id available)", () => {
  const data = { signatures: [{ login: "alice" }] }; // legacy entry, no id
  assert.strictEqual(isSigned(data, "alice"), true);
  assert.strictEqual(isSigned(data, "bob"), false);
});

test("an id match takes priority over a stale login mismatch", () => {
  const data = { signatures: [{ id: 555, login: "alice-old-name" }] };
  assert.strictEqual(
    isSigned(data, { id: 555, login: "alice-new-name" }),
    true,
  );
});

// --- allowlist: exact match only, no wildcard bypass ----------------------
test("allowlist matches exact bot names", () => {
  assert.strictEqual(isAllowlisted("dependabot[bot]"), true);
  assert.strictEqual(isAllowlisted("DEPENDABOT[BOT]"), true); // case-insensitive
});

test("allowlist does NOT let a human bypass by naming themselves like a bot", () => {
  assert.strictEqual(isAllowlisted("bot-hacker-123"), false);
  assert.strictEqual(isAllowlisted("super-bot"), false);
});

// The module-level ALLOWLIST const is `(process.env.ALLOWLIST || "")
// .split(",").map(trim).filter(Boolean)` - every other test in this file
// uses a clean, pre-trimmed value ("dependabot[bot],renovate[bot]"), which
// never actually exercises .trim() or .filter(Boolean) (there's nothing
// for them to do). This forces a genuinely messy real-world value -
// surrounding whitespace on some entries, a doubled comma, and a
// trailing comma - through a fresh module instance, and confirms both
// that the real names still match despite the mess and that a stray
// empty segment doesn't itself become a phantom allowlist entry.
test("ALLOWLIST parsing trims whitespace around entries and drops empty segments (extra/doubled commas, trailing comma)", () => {
  withFreshBot(
    { ALLOWLIST: "  dependabot[bot] , ,renovate[bot],,  " },
    ({ isAllowlisted: freshIsAllowlisted }) => {
      assert.strictEqual(
        freshIsAllowlisted("dependabot[bot]"),
        true,
        "surrounding whitespace around this entry must be trimmed away",
      );
      assert.strictEqual(
        freshIsAllowlisted("renovate[bot]"),
        true,
        "this entry must still match despite the doubled/trailing commas around it",
      );
      assert.strictEqual(
        freshIsAllowlisted(""),
        false,
        "an empty login must never match, even though the messy input contained empty comma-separated segments - filter(Boolean) must have dropped them, not turned them into a literal '' allowlist entry",
      );
      assert.strictEqual(freshIsAllowlisted("some-other-bot[bot]"), false);
    },
  );
});

// --- impersonation guard ---------------------------------------------------
test("a third party signing does not clear the actual PR commit author", () => {
  const prCommitAuthors = ["real-author"];
  const store = { signatures: [{ login: "random-commenter" }] };
  const missing = prCommitAuthors.filter((l) => !isSigned(store, l));
  assert.deepStrictEqual(missing, ["real-author"]);
});

test("PR is fully clear only once the actual author signs", () => {
  const prCommitAuthors = ["real-author"];
  const store = { signatures: [{ login: "real-author" }] };
  const missing = prCommitAuthors.filter((l) => !isSigned(store, l));
  assert.deepStrictEqual(missing, []);
});

test("multiple commit authors on one PR all must sign independently", () => {
  const prCommitAuthors = ["alice", "bob"];
  const store = { signatures: [{ login: "alice" }] };
  const missing = prCommitAuthors.filter((l) => !isSigned(store, l));
  assert.deepStrictEqual(missing, ["bob"]);
});

// --- base64url ---------------------------------------------------------
// createAppJWT() exercises base64url() indirectly on every call, but a
// direct test pins down each individual character-substitution rule so a
// future refactor of the function can't silently break one of them while
// still passing the higher-level JWT round-trip test below.
test("base64url strips '=' padding", () => {
  // Buffer.from("a").toString("base64") === "YQ==" - two padding chars.
  assert.strictEqual(base64url(Buffer.from("a")), "YQ");
});

test("base64url replaces '+' with '-'", () => {
  // 0xfb 0xff -> base64 "+/8=" - contains both '+' and '/' to substitute.
  assert.strictEqual(base64url(Buffer.from([0xfb, 0xff])), "-_8");
});

test("base64url replaces '/' with '_'", () => {
  // 0xff 0xff 0xff -> base64 "////" - a deterministic run of raw '/'s.
  const buf = Buffer.from([0xff, 0xff, 0xff]);
  assert.strictEqual(buf.toString("base64"), "////");
  assert.strictEqual(base64url(buf), "____");
});

test("base64url of an empty buffer is an empty string", () => {
  assert.strictEqual(base64url(Buffer.alloc(0)), "");
});

test("base64url round-trips arbitrary binary bytes (all 256 byte values)", () => {
  const buf = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const encoded = base64url(buf);
  assert.ok(!encoded.includes("="), "must not contain '=' padding");
  assert.ok(!encoded.includes("+"), "must not contain '+'");
  assert.ok(!encoded.includes("/"), "must not contain '/'");
  const restored = Buffer.from(
    encoded.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  );
  assert.ok(
    buf.equals(restored),
    "decoding the url-safe form must recover the exact original bytes",
  );
});

// --- GitHub App JWT ---------------------------------------------------------
test("JWT is well-formed RS256 with a valid exp window and verifies correctly", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwt = createAppJWT("123456", privateKey);
  const [h, p, s] = jwt.split(".");
  const header = JSON.parse(Buffer.from(h, "base64").toString());
  const payload = JSON.parse(Buffer.from(p, "base64").toString());

  assert.strictEqual(header.alg, "RS256");
  assert.strictEqual(payload.iss, "123456");
  assert.ok(
    payload.exp - payload.iat <= 600,
    "exp must be <= 10 minutes per GitHub App spec",
  );
  assert.ok(
    payload.iat <= Math.floor(Date.now() / 1000),
    "iat should not be in the future",
  );

  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(`${h}.${p}`);
  verifier.end();
  const sigBuf = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  assert.ok(
    verifier.verify(publicKey, sigBuf),
    "JWT signature must verify against the matching public key",
  );
});

test("JWT signed with the wrong key fails verification (sanity check on the test itself)", () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const { publicKey: otherPublicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwt = createAppJWT("123456", privateKey);
  const [h, p, s] = jwt.split(".");
  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(`${h}.${p}`);
  verifier.end();
  const sigBuf = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  assert.strictEqual(verifier.verify(otherPublicKey, sigBuf), false);
});

// Item: validateConfig's PEM-shape check is deliberately shallow (it only
// checks for a "-----BEGIN" header, see its own comment) - a string that
// passes that check can still be garbage between the markers (e.g. a
// truncated or corrupted secret). createAppJWT() itself must fail there,
// at actual signing time, with a real (if less friendly) crypto error -
// this is the "later, inside crypto.sign()" case validateConfig's own
// comment explicitly says it does NOT protect against.
test("createAppJWT throws when given a PEM-shaped but cryptographically invalid private key (passes the shape check, fails at actual signing)", () => {
  const fakePem =
    "-----BEGIN RSA PRIVATE KEY-----\nnot-real-key-bytes-but-has-the-right-shape\n-----END RSA PRIVATE KEY-----";
  assert.throws(
    () => createAppJWT("123456", fakePem),
    undefined,
    "expected signer.sign() to throw on a key that isn't actually valid PEM content, not silently produce a garbage signature",
  );
});

// --- recheck authorization guard (resource-abuse mitigation) ---------------
function fakeCommentPayload({
  prAuthor = "pr-owner",
  commenter,
  association = "NONE",
}) {
  return {
    issue: { user: { login: prAuthor } },
    comment: { user: { login: commenter }, author_association: association },
  };
}

test("the PR author can always trigger recheck, regardless of association", () => {
  const payload = fakeCommentPayload({
    prAuthor: "alice",
    commenter: "alice",
    association: "NONE",
  });
  assert.strictEqual(isPrivileged(payload, "alice"), true);
});

test("PR-author check is case-insensitive (GitHub usernames are)", () => {
  const payload = fakeCommentPayload({
    prAuthor: "Alice",
    commenter: "alice",
    association: "NONE",
  });
  assert.strictEqual(isPrivileged(payload, "alice"), true);
});

test("an owner/member/collaborator can trigger recheck on someone else's PR", () => {
  for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    const payload = fakeCommentPayload({
      prAuthor: "alice",
      commenter: "maintainer-bob",
      association,
    });
    assert.strictEqual(
      isPrivileged(payload, "maintainer-bob"),
      true,
      `${association} should be privileged`,
    );
  }
});

test("a random passer-by with no association cannot trigger recheck on someone else's PR", () => {
  for (const association of [
    "NONE",
    "FIRST_TIME_CONTRIBUTOR",
    "FIRST_TIMER",
    "CONTRIBUTOR",
    "MANNEQUIN", // real GitHub association for an unclaimed/migrated ("ghost") account
  ]) {
    const payload = fakeCommentPayload({
      prAuthor: "alice",
      commenter: "random-user",
      association,
    });
    assert.strictEqual(
      isPrivileged(payload, "random-user"),
      false,
      `${association} should NOT be privileged`,
    );
  }
});

// --- isSigned / isAllowlisted: fail closed on malformed shapes -----------
test("isSigned fails closed (returns false, never throws) on malformed author shapes", () => {
  const data = { signatures: [] };
  for (const bad of [
    null,
    undefined,
    {},
    { id: 1 },
    { login: null },
    { login: 123 },
  ]) {
    assert.strictEqual(
      isSigned(data, bad),
      false,
      `isSigned(data, ${JSON.stringify(bad)}) should return false, not throw`,
    );
  }
});

test("isAllowlisted fails closed (returns false, never throws) on malformed login values", () => {
  for (const bad of [null, undefined, 123, {}, []]) {
    assert.strictEqual(
      isAllowlisted(bad),
      false,
      `isAllowlisted(${JSON.stringify(bad)}) should return false, not throw`,
    );
  }
});

test("isSigned still ignores a well-formed signature entry with a non-string login (defense in depth on stored data too)", () => {
  const data = { signatures: [{ id: 1, login: 123 }] };
  assert.strictEqual(isSigned(data, { id: 2, login: "someone" }), false);
});

test("isSigned fails closed (returns false, never throws) on a null/non-object STORED entry", () => {
  // readSignatures() deliberately keeps malformed/hand-edited entries in the
  // array instead of dropping them (so a write-back can never permanently
  // delete a real record just because it doesn't match today's shape) -
  // which means isSigned() has to be safe against a genuinely garbage entry
  // showing up here, not just a garbage `author` argument.
  const data = {
    signatures: [null, undefined, 42, "oops", [], { note: "no login field" }],
  };
  assert.strictEqual(isSigned(data, "alice"), false);
  assert.strictEqual(isSigned(data, { id: 1, login: "alice" }), false);
});

// --- validateConfig: format validation, not just presence -----------------
function withFreshBot(envOverrides, fn) {
  const keys = Object.keys(envOverrides);
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  Object.assign(process.env, envOverrides);
  delete require.cache[require.resolve("../src/cla-bot.js")];
  try {
    const mod = require("../src/cla-bot.js");
    return fn(mod);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    delete require.cache[require.resolve("../src/cla-bot.js")];
  }
}

function assertConfigFails(envOverrides, messageSubstring) {
  withFreshBot(envOverrides, (mod) => {
    const originalExit = process.exit;
    const originalError = console.error;
    let exitCode = null;
    let lastMessage = "";
    process.exit = (code) => {
      exitCode = code;
      throw new Error("__TEST_PROCESS_EXIT__");
    };
    console.error = (msg) => {
      lastMessage = msg;
    };
    try {
      mod.validateConfig();
      assert.fail(
        "expected validateConfig() to reject this config, but it accepted it",
      );
    } catch (e) {
      if (e.message !== "__TEST_PROCESS_EXIT__") throw e;
      assert.strictEqual(exitCode, 1);
      assert.ok(
        lastMessage.includes(messageSubstring),
        `expected the failure message to mention "${messageSubstring}", got: ${lastMessage}`,
      );
    } finally {
      process.exit = originalExit;
      console.error = originalError;
    }
  });
}

function assertConfigOK(envOverrides) {
  withFreshBot(envOverrides, (mod) => {
    const originalExit = process.exit;
    let exitCalled = false;
    process.exit = () => {
      exitCalled = true;
    };
    try {
      mod.validateConfig();
      assert.strictEqual(
        exitCalled,
        false,
        "validateConfig() should not have rejected a valid config",
      );
    } finally {
      process.exit = originalExit;
    }
  });
}

const VALID_BASE_CONFIG = {
  GITHUB_TOKEN: "dummy",
  SIG_OWNER: "fossasia",
  SIG_REPO: "cla-signatures",
  SIG_PATH: "signatures/cla.json",
  CLA_DOCUMENT_URL: "https://example.com/CLA.md",
};

test("validateConfig accepts a well-formed config (baseline sanity check for the tests below)", () => {
  assertConfigOK(VALID_BASE_CONFIG);
});

test("validateConfig rejects a CLA_DOCUMENT_URL that is not a valid URL", () => {
  assertConfigFails(
    { ...VALID_BASE_CONFIG, CLA_DOCUMENT_URL: "not-a-url" },
    "CLA_DOCUMENT_URL",
  );
});

test("validateConfig rejects a non-http(s) CLA_DOCUMENT_URL (e.g. file://)", () => {
  assertConfigFails(
    { ...VALID_BASE_CONFIG, CLA_DOCUMENT_URL: "file:///etc/passwd" },
    "CLA_DOCUMENT_URL",
  );
});

test("validateConfig rejects a SIG_OWNER that is not a valid GitHub login", () => {
  assertConfigFails(
    { ...VALID_BASE_CONFIG, SIG_OWNER: "-bad-owner-" },
    "SIG_OWNER",
  );
});

test("validateConfig rejects a SIG_REPO with characters GitHub repo names disallow", () => {
  assertConfigFails(
    { ...VALID_BASE_CONFIG, SIG_REPO: "repo name/with slash" },
    "SIG_REPO",
  );
});

test("validateConfig rejects a path-traversal-style SIG_PATH", () => {
  assertConfigFails(
    { ...VALID_BASE_CONFIG, SIG_PATH: "../../../etc/passwd" },
    "SIG_PATH",
  );
});

test("validateConfig rejects an absolute SIG_PATH", () => {
  assertConfigFails(
    { ...VALID_BASE_CONFIG, SIG_PATH: "/etc/passwd" },
    "SIG_PATH",
  );
});

// The SIG_PATH check is a single `||` chain of four conditions
// (startsWith("/"), includes("\\"), split("/").includes(".."),
// trim().length === 0) - the two tests above only ever drive the FIRST
// and THIRD conditions true. Without a dedicated test for each of the
// remaining two, a future refactor could silently break either one (e.g.
// drop the backslash check entirely) and nothing would catch it, even
// though overall statement/line coverage of this file would stay at
// 100% throughout (the buggy line would still be *executed*, just no
// longer *asserted on*).
test("validateConfig rejects a SIG_PATH containing a backslash", () => {
  assertConfigFails(
    { ...VALID_BASE_CONFIG, SIG_PATH: "signatures\\cla.json" },
    "SIG_PATH",
  );
});

test("validateConfig rejects a whitespace-only SIG_PATH", () => {
  assertConfigFails({ ...VALID_BASE_CONFIG, SIG_PATH: "   " }, "SIG_PATH");
});

test("validateConfig accepts a SIG_PATH nested in subdirectories (sanity check: legitimate relative paths are not caught by the traversal/absolute/backslash checks above)", () => {
  assertConfigOK({
    ...VALID_BASE_CONFIG,
    SIG_PATH: "nested/dir/signatures.json",
  });
});

test("validateConfig rejects a SIG_APP_PRIVATE_KEY that does not look like PEM", () => {
  assertConfigFails(
    {
      ...VALID_BASE_CONFIG,
      SIG_APP_ID: "12345",
      SIG_APP_PRIVATE_KEY: "definitely-not-a-real-key",
    },
    "SIG_APP_PRIVATE_KEY",
  );
});

// The test above only exercises the FAILURE side of the PEM shape check -
// the TRUE branch (a key that genuinely looks like PEM) was never
// separately forced. validateConfig only checks for the "-----BEGIN"
// header (deliberately - it's a cheap, fail-fast sanity check, not full
// PEM parsing; genuinely invalid key *contents* are caught later, at
// actual JWT-signing time), so a syntactically-plausible-looking string is
// enough here without needing a real, cryptographically valid key.
test("validateConfig accepts a SIG_APP_PRIVATE_KEY that does look like PEM (happy path for the PEM-shape check)", () => {
  assertConfigOK({
    ...VALID_BASE_CONFIG,
    SIG_APP_ID: "12345",
    SIG_APP_PRIVATE_KEY:
      "-----BEGIN RSA PRIVATE KEY-----\nnot-real-key-bytes-but-has-the-right-shape\n-----END RSA PRIVATE KEY-----",
  });
});

test("validateConfig still requires the base presence checks (unchanged behavior)", () => {
  assertConfigFails({ ...VALID_BASE_CONFIG, GITHUB_TOKEN: "" }, "GITHUB_TOKEN");
});

// Item B: the base presence loop checks 4 required values, but only
// GITHUB_TOKEN's absence was covered above - each of the other 3 needs its
// own dedicated test so a future refactor that drops one of them from the
// loop (or typos its name) fails immediately and specifically, the same
// reasoning already applied to every SIG_PATH sub-condition above.
test("validateConfig rejects a missing/empty SIG_OWNER", () => {
  assertConfigFails({ ...VALID_BASE_CONFIG, SIG_OWNER: "" }, "SIG_OWNER");
});

test("validateConfig rejects a missing/empty SIG_REPO", () => {
  assertConfigFails({ ...VALID_BASE_CONFIG, SIG_REPO: "" }, "SIG_REPO");
});

test("validateConfig rejects a missing/empty CLA_DOCUMENT_URL", () => {
  assertConfigFails(
    { ...VALID_BASE_CONFIG, CLA_DOCUMENT_URL: "" },
    "CLA_DOCUMENT_URL",
  );
});

// --- isPrivileged: malformed payload shapes fail safe, don't throw --------
test("isPrivileged does not throw when payload.issue or payload.comment is missing", () => {
  assert.strictEqual(
    isPrivileged({ comment: { author_association: "NONE" } }, "someone"),
    false,
  );
  assert.strictEqual(isPrivileged({ issue: {} }, "someone"), false);
  assert.strictEqual(isPrivileged({}, "someone"), false);
});

// --- assertValidPRNumber / assertValidSha: direct unit-level regression ---
// contract for UNSAFE_URL_SEGMENT_RE and the PR-number integer check.
//
// These call the validators straight (no webhook simulation, no fetch
// mocking) precisely so that if either check is ever loosened - e.g. a
// character accidentally dropped from UNSAFE_URL_SEGMENT_RE's class - the
// failure is immediate, synchronous, and named after the exact character
// that stopped being rejected, rather than surfacing only indirectly deep
// inside an async webhook-handler integration test.

test("assertValidPRNumber accepts an ordinary positive integer and returns it unchanged", () => {
  assert.strictEqual(assertValidPRNumber(42, "ctx"), 42);
});

for (const { label, value } of [
  { label: "zero", value: 0 },
  { label: "a negative integer", value: -1 },
  { label: "a non-integer float", value: 1.5 },
  { label: "NaN", value: NaN },
  { label: "Infinity", value: Infinity },
  { label: "-Infinity", value: -Infinity },
  { label: "a numeric string", value: "1" },
  { label: "null", value: null },
  { label: "undefined", value: undefined },
  { label: "an array", value: [1] },
  { label: "a plain object", value: {} },
  { label: "a boolean", value: true },
]) {
  test(`assertValidPRNumber rejects ${label}`, () => {
    assert.throws(
      () => assertValidPRNumber(value, "ctx"),
      /expected a positive integer/,
    );
  });
}

// Dedicated unsafe-integer boundary tests. Number.isInteger() alone is not
// enough here: every double past 2^53 has no fractional part, so
// Number.isInteger() calls it "an integer" even though it can't reliably
// represent the real value - these three values would each have slipped
// past a Number.isInteger()-only check. assertValidPRNumber uses
// Number.isSafeInteger() specifically to reject them, and each test below
// proves that with an explicit assert.ok(Number.isInteger(...)) sanity
// check, so a regression back to Number.isInteger() fails immediately and
// specifically here rather than only turning up as a garbled URL later.
for (const { label, value } of [
  {
    label:
      "Number.MAX_SAFE_INTEGER + 1 (still passes Number.isInteger, but not Number.isSafeInteger)",
    value: Number.MAX_SAFE_INTEGER + 1,
  },
  {
    label:
      "1e100 (a huge float with no fractional part, but nowhere near a real PR number)",
    value: 1e100,
  },
  {
    label:
      "9007199254740993, which JSON.parse() itself already silently rounds to a different integer (9007199254740992)",
    value: 9007199254740993,
  },
]) {
  test(`assertValidPRNumber rejects ${label}`, () => {
    // Confirms this specific value really is the kind Number.isInteger()
    // alone would wrongly accept - otherwise this test would prove nothing
    // about the isSafeInteger() vs isInteger() distinction.
    assert.ok(
      Number.isInteger(value),
      "expected this value to be a case Number.isInteger() alone would accept",
    );
    assert.throws(
      () => assertValidPRNumber(value, "ctx"),
      /expected a positive integer/,
    );
  });
}

test("assertValidPRNumber accepts Number.MAX_SAFE_INTEGER itself (the boundary, not the offender)", () => {
  assert.strictEqual(
    assertValidPRNumber(Number.MAX_SAFE_INTEGER, "ctx"),
    Number.MAX_SAFE_INTEGER,
  );
});

// assertValidInstallationId() sits at the identical trust boundary as
// assertValidPRNumber() above (an externally-sourced number interpolated
// directly into a request path) and shares its exact Number.isSafeInteger
// + > 0 bar - these tests mirror that suite directly. Critically, this is
// also the ONLY honest way to verify the NaN/Infinity/-Infinity cases at
// all: getSignaturesToken() only ever receives this value after a real
// `JSON.parse()` of an HTTP response body, and JSON's grammar has no token
// for any of the three - JSON.parse() can never produce them, and
// JSON.stringify() silently turns all three into `null` before they'd ever
// be sent. A fetch-mock-based test using JSON.stringify({id: NaN}) would
// therefore silently test `null` a second time, not NaN - calling this
// function directly is what makes the coverage real.
test("assertValidInstallationId accepts an ordinary positive integer and returns it unchanged", () => {
  assert.strictEqual(assertValidInstallationId(12345, "ctx"), 12345);
});

for (const { label, value } of [
  { label: "zero", value: 0 },
  { label: "a negative integer", value: -1 },
  { label: "a non-integer float", value: 1.5 },
  { label: "NaN", value: NaN },
  { label: "Infinity", value: Infinity },
  { label: "-Infinity", value: -Infinity },
  { label: "a numeric string", value: "1" },
  { label: "null", value: null },
  { label: "undefined", value: undefined },
  { label: "an array", value: [1] },
  { label: "a plain object", value: {} },
  { label: "a boolean", value: true },
]) {
  test(`assertValidInstallationId rejects ${label}`, () => {
    assert.throws(
      () => assertValidInstallationId(value, "ctx"),
      /missing a usable "id" field/,
    );
  });
}

for (const { label, value } of [
  {
    label:
      "Number.MAX_SAFE_INTEGER + 1 (still passes Number.isInteger, but not Number.isSafeInteger)",
    value: Number.MAX_SAFE_INTEGER + 1,
  },
  {
    label:
      "1e100 (a huge float with no fractional part, but nowhere near a real installation id)",
    value: 1e100,
  },
]) {
  test(`assertValidInstallationId rejects ${label}`, () => {
    assert.ok(
      Number.isInteger(value),
      "expected this value to be a case Number.isInteger() alone would accept",
    );
    assert.throws(
      () => assertValidInstallationId(value, "ctx"),
      /missing a usable "id" field/,
    );
  });
}

test("assertValidInstallationId accepts Number.MAX_SAFE_INTEGER itself (the boundary, not the offender)", () => {
  assert.strictEqual(
    assertValidInstallationId(Number.MAX_SAFE_INTEGER, "ctx"),
    Number.MAX_SAFE_INTEGER,
  );
});

test("assertValidInstallationId's error message includes the given context string and the rejected value", () => {
  assert.throws(
    () =>
      assertValidInstallationId(
        -1,
        "GitHub App installation lookup for /repos/x/y/installation",
      ),
    /GitHub App installation lookup for \/repos\/x\/y\/installation is missing a usable "id" field \(got -1\)/,
  );
});

test("assertValidSha accepts a real 40-character lowercase-hex sha1 and returns it unchanged", () => {
  const sha = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4";
  assert.strictEqual(assertValidSha(sha, "ctx"), sha);
});

test("assertValidSha accepts a real 64-character lowercase-hex sha256", () => {
  const sha = "a".repeat(64);
  assert.strictEqual(assertValidSha(sha, "ctx"), sha);
});

test("assertValidSha accepts opaque non-hex placeholder strings (test/tooling convention, not just real hex shas)", () => {
  assert.strictEqual(assertValidSha("head-sha-abc", "ctx"), "head-sha-abc");
});

// One test per individual member of UNSAFE_URL_SEGMENT_RE's character
// class, plus the ".." alternation - so if a future edit ever drops just
// one of them, exactly one narrowly-named test fails and points straight
// at what changed.
for (const { label, value } of [
  { label: "a forward slash", value: "abc/def" },
  { label: "a backslash", value: "abc\\def" },
  { label: "a question mark", value: "abc?def" },
  { label: "a hash/fragment marker", value: "abc#def" },
  { label: "a percent sign", value: "abc%def" },
  { label: "a space", value: "abc def" },
  { label: "a tab", value: "abc\tdef" },
  { label: "a newline", value: "abc\ndef" },
  { label: "a NUL byte", value: "abc\x00def" },
  { label: "a literal '..' traversal segment", value: "abc..def" },
]) {
  test(`assertValidSha rejects a sha containing ${label}`, () => {
    assert.throws(
      () => assertValidSha(value, "ctx"),
      /expected a valid commit SHA/,
    );
  });
}

// Dedicated, explicitly-named percent-encoding bypass tests. Unencoded
// "/", "..", "?", "#" are already covered above and by the integration
// suite; a percent-encoded form of the same attack (e.g. "%2f" for "/",
// "%2e%2e" for "..") contains none of those literal characters, so it can
// ONLY be caught by the "%" member of the character class - these two
// tests exist specifically to fail if that "%" is ever removed, even
// though no other character in the value would trip any other check.
test("assertValidSha rejects a percent-encoded '/' (\"%2f\") even though it contains no literal slash", () => {
  assert.doesNotMatch("abc%2fdef", /[/\\?#\s\x00-\x1f]|\.\./);
  assert.throws(
    () => assertValidSha("abc%2fdef", "ctx"),
    /expected a valid commit SHA/,
  );
});

test("assertValidSha rejects a percent-encoded '../' traversal (\"%2e%2e%2f\") even though it contains no literal dot-dot or slash", () => {
  assert.doesNotMatch("%2e%2e%2f", /[/\\?#\s\x00-\x1f]|\.\./);
  assert.throws(
    () => assertValidSha("%2e%2e%2f", "ctx"),
    /expected a valid commit SHA/,
  );
});

test("assertValidSha rejects an empty string", () => {
  assert.throws(() => assertValidSha("", "ctx"), /expected a valid commit SHA/);
});

test("assertValidSha rejects a non-string value", () => {
  assert.throws(
    () => assertValidSha(12345, "ctx"),
    /expected a valid commit SHA/,
  );
});

test("assertValidSha accepts exactly 64 characters (the sha256 boundary) but rejects 65", () => {
  assert.strictEqual(assertValidSha("a".repeat(64), "ctx"), "a".repeat(64));
  assert.throws(
    () => assertValidSha("a".repeat(65), "ctx"),
    /expected a valid commit SHA/,
  );
});

// --- classifyBotComment ----------------------------------------------------
// Used by checkPR's quietIfNeverFlagged logic to tell a genuine "this PR
// was blocked" comment apart from unrelated bot chatter on the same
// thread. See src/cla-bot.js for the full reasoning.

test("classifyBotComment recognizes a current-format 'needs to sign' comment (with PENDING_MARKER) as pending", () => {
  const body =
    "<!-- fossasia-cla-bot:v1 -->\n<!-- fossasia-cla-bot:pending -->\n" +
    "The following contributor(s) need to sign our [CLA](https://example.com/CLA.md) before this PR can be merged:\n\n- @alice";
  assert.strictEqual(classifyBotComment(body), "pending");
});

test("classifyBotComment recognizes a LEGACY 'needs to sign' comment with NO PENDING_MARKER at all as pending (backward compatibility with PRs blocked by an older deployment)", () => {
  const body =
    "<!-- fossasia-cla-bot:v1 -->\n" +
    "The following contributor(s) need to sign our [CLA](https://example.com/CLA.md) before this PR can be merged:\n\n- @alice";
  assert.strictEqual(classifyBotComment(body), "pending");
});

test("classifyBotComment recognizes a 'needs manual review' (unresolved commit) comment as pending, current and legacy wording alike", () => {
  const current =
    "<!-- fossasia-cla-bot:v1 -->\n<!-- fossasia-cla-bot:pending -->\n" +
    "⚠️ 1 commit could not be automatically attributed to a GitHub account. A maintainer will need to verify it manually: abc1234";
  const legacy =
    "<!-- fossasia-cla-bot:v1 -->\n" +
    "⚠️ 1 commit could not be automatically attributed to a GitHub account. A maintainer will need to verify it manually: abc1234";
  assert.strictEqual(classifyBotComment(current), "pending");
  assert.strictEqual(classifyBotComment(legacy), "pending");
});

test("classifyBotComment recognizes the exact legacy success announcement as success", () => {
  const body =
    "<!-- fossasia-cla-bot:v1 -->\nAll contributors have signed the CLA. \u2705";
  assert.strictEqual(classifyBotComment(body), "success");
});

test("classifyBotComment recognizes a current-format (SUCCESS_MARKER) success announcement as success, generic and personalized wording alike", () => {
  const generic =
    "<!-- fossasia-cla-bot:v1 -->\n<!-- fossasia-cla-bot:success -->\nAll contributors have signed the CLA. \u2705";
  const personalized =
    "<!-- fossasia-cla-bot:v1 -->\n<!-- fossasia-cla-bot:success -->\n@alice Thank you for signing the CLA! We look forward to your contributions.";
  assert.strictEqual(classifyBotComment(generic), "success");
  assert.strictEqual(classifyBotComment(personalized), "success");
});

test("classifyBotComment does NOT treat arbitrary bot text merely CONTAINING the legacy success phrase as a success announcement", () => {
  // Regression test: the legacy fallback used to be a plain body.includes()
  // substring search, which would have wrongly matched here just because
  // this text happens to quote/mention the exact legacy phrase somewhere
  // inside a longer, unrelated comment. It must now require the comment's
  // ENTIRE body to be nothing more than that fixed legacy string (see
  // LEGACY_SUCCESS_COMMENT's doc comment in src/cla-bot.js) - a substring
  // match here is a false positive, since this comment doesn't actually
  // represent this PR ever having reached a genuine success state.
  const body =
    "<!-- fossasia-cla-bot:v1 -->\n" +
    "FYI, once everyone signs you'll see a comment saying " +
    '"All contributors have signed the CLA. \u2705" - just a heads up, ' +
    "nobody has signed yet.";
  assert.strictEqual(classifyBotComment(body), "other");
});

test("classifyBotComment treats the personal 'already signed, nothing more to do' reply as neither pending nor success", () => {
  const body =
    "<!-- fossasia-cla-bot:v1 -->\n@alice you have already signed the CLA. Nothing more to do here.";
  assert.strictEqual(classifyBotComment(body), "other");
});

// --- personalSuccessMessage / SUCCESS_MARKER --------------------------------
// The per-signer completion announcement (checkPR's `signer` option) that
// replaces the generic SUCCESS_MESSAGE whenever we know exactly who just
// completed the PR's signing requirement.

test("personalSuccessMessage addresses the given login by name and invites their contributions", () => {
  const body = personalSuccessMessage("carol");
  assert.ok(
    body.includes(
      "@carol Thank you for signing the CLA! We look forward to your contributions.",
    ),
    `expected a personalized thank-you for carol, got: ${body}`,
  );
});

test("personalSuccessMessage embeds SUCCESS_MARKER so classifyBotComment recognizes it as a success announcement, even though its visible text differs per signer", () => {
  const body = `<!-- fossasia-cla-bot:v1 -->\n${personalSuccessMessage("dave")}`;
  assert.strictEqual(classifyBotComment(body), "success");
});

test("two personalSuccessMessage() calls for different logins produce different bodies (so they are never mistaken for duplicates of each other)", () => {
  assert.notStrictEqual(
    personalSuccessMessage("alice"),
    personalSuccessMessage("bob"),
  );
});

// --- isSameContributor -------------------------------------------------
// Used by checkPR's `signerCompletedRequirement` check to tell whether the
// person who just signed via a comment is actually one of a PR's own
// commit authors (as opposed to an unrelated bystander) - see its doc
// comment in src/cla-bot.js for why that distinction matters.

test("isSameContributor matches by numeric id even when the logins differ (a renamed account)", () => {
  assert.strictEqual(
    isSameContributor(
      { id: 42, login: "old-name" },
      { id: 42, login: "new-name" },
    ),
    true,
  );
});

test("isSameContributor falls back to a case-insensitive login match when either side has no id", () => {
  assert.strictEqual(
    isSameContributor({ login: "Alice" }, { login: "alice" }),
    true,
  );
});

// The two tests above only ever exercise BOTH sides having a numeric id,
// or NEITHER side having one. The asymmetric case - one side has a
// numeric id (e.g. a commit author resolved via the API) and the other
// doesn't (e.g. a legacy signature entry, or a bare { login } passed by
// an older caller) - takes a different code path (falls through to the
// login-only comparison) and needs its own coverage, since a future
// change to the id-check condition could silently break just this one
// asymmetric shape without either existing test noticing.
test("isSameContributor falls back to a login match when only ONE side has a numeric id (asymmetric shape)", () => {
  assert.strictEqual(
    isSameContributor({ id: 1, login: "alice" }, { login: "alice" }),
    true,
    "same login should still match even though only one side carries an id",
  );
  assert.strictEqual(
    isSameContributor({ login: "alice" }, { id: 2, login: "alice" }),
    true,
    "order of which side has the id must not matter",
  );
  assert.strictEqual(
    isSameContributor({ id: 1, login: "alice" }, { login: "bob" }),
    false,
    "an id on only one side must not cause a false match against a different login",
  );
});

test("isSameContributor returns false for genuinely different identities", () => {
  assert.strictEqual(
    isSameContributor({ id: 1, login: "alice" }, { id: 2, login: "bob" }),
    false,
  );
});

test("isSameContributor fails closed (false, never throws) on null/undefined input", () => {
  assert.strictEqual(isSameContributor(null, { login: "alice" }), false);
  assert.strictEqual(isSameContributor({ login: "alice" }, undefined), false);
});

// --- mergeSignatures (checkPR) -------------------------------------------
// Reconciles a caller's already-known signature snapshot (knownSignatures)
// with a freshly-read one, so that neither side's staleness can hide a real
// signature from checkPR - see its doc comment in src/cla-bot.js.

test("mergeSignatures returns the fresh read unchanged when there is no known snapshot to merge", () => {
  const fresh = { version: 1, signatures: [{ id: 1, login: "alice" }] };
  assert.deepStrictEqual(mergeSignatures(null, fresh), fresh);
  assert.deepStrictEqual(mergeSignatures(undefined, fresh), fresh);
});

test("mergeSignatures keeps a known entry that the fresh read is missing (fresh is stale relative to the caller's own write)", () => {
  const known = { version: 1, signatures: [{ id: 1, login: "alice" }] };
  const fresh = { version: 1, signatures: [] };
  assert.deepStrictEqual(mergeSignatures(known, fresh), {
    version: 1,
    signatures: [{ id: 1, login: "alice" }],
  });
});

test("mergeSignatures adds a fresh entry that known doesn't have (a different contributor signed concurrently elsewhere)", () => {
  const known = { version: 1, signatures: [{ id: 1, login: "alice" }] };
  const fresh = {
    version: 1,
    signatures: [
      { id: 1, login: "alice" },
      { id: 2, login: "bob" },
    ],
  };
  assert.deepStrictEqual(mergeSignatures(known, fresh), {
    version: 1,
    signatures: [
      { id: 1, login: "alice" },
      { id: 2, login: "bob" },
    ],
  });
});

test("mergeSignatures prefers the fresh entry over a matching known one (same identity, per isSameContributor's id-first rule)", () => {
  const known = { version: 1, signatures: [{ id: 1, login: "old-name" }] };
  const fresh = { version: 1, signatures: [{ id: 1, login: "new-name" }] };
  assert.deepStrictEqual(mergeSignatures(known, fresh), {
    version: 1,
    signatures: [{ id: 1, login: "new-name" }],
  });
});

// --- signerCompletedRequirement (checkPR) --------------------------------
// checkPR's own, single-source-of-truth definition of "did this signer's
// own signature complete the PR's requirement" - see its doc comment in
// src/cla-bot.js. Tests call the REAL exported function directly (rather
// than re-typing its expression here) so these can never silently drift
// out of sync with the production logic they're meant to be verifying.

test("signerCompletedRequirement is false for an allowlisted commit author, even though they ARE the PR's only author and DID just sign", () => {
  const authors = [{ id: 99, login: "dependabot[bot]" }];
  const signer = { id: 99, login: "dependabot[bot]" };
  assert.strictEqual(
    signerCompletedRequirement(authors, signer),
    false,
    "an allowlisted account was never actually blocking this PR (it's excluded from `missing` regardless of signature status), so it must not be credited with completing it",
  );
});

test("signerCompletedRequirement is true for a genuine, non-allowlisted commit author who just signed", () => {
  const authors = [{ id: 100, login: "alice" }];
  const signer = { id: 100, login: "alice" };
  assert.strictEqual(signerCompletedRequirement(authors, signer), true);
});

test("signerCompletedRequirement is false for someone who isn't a commit author on this PR at all (an unrelated bystander)", () => {
  const authors = [{ id: 100, login: "alice" }];
  const signer = { id: 999, login: "mallory" };
  assert.strictEqual(signerCompletedRequirement(authors, signer), false);
});

test("signerCompletedRequirement is false when there is no signer at all (an automatic check, not a comment-triggered one)", () => {
  const authors = [{ id: 100, login: "alice" }];
  assert.strictEqual(signerCompletedRequirement(authors, null), false);
});

// --- fail(): direct assertion on its error-formatting/exit contract -------
// fail() is only ever exercised indirectly today (via validateConfig, the
// missing-event-file path in main(), etc.) - a dedicated test pins down its
// own two responsibilities directly: the exact "::error::"-prefixed
// console.error output GitHub Actions annotations rely on, and exiting with
// code 1 specifically (not just "some nonzero code" or a thrown exception).
test("fail() logs a '::error::'-prefixed message to console.error and calls process.exit(1)", () => {
  const originalError = console.error;
  const originalExit = process.exit;
  let loggedMessage = null;
  let exitCode = null;
  console.error = (msg) => {
    loggedMessage = msg;
  };
  process.exit = (code) => {
    exitCode = code;
  };
  try {
    fail("something went wrong");
  } finally {
    console.error = originalError;
    process.exit = originalExit;
  }
  assert.strictEqual(
    loggedMessage,
    "::error::something went wrong",
    "fail() must prefix the message with the exact GitHub Actions error-annotation syntax",
  );
  assert.strictEqual(
    exitCode,
    1,
    "fail() must exit with code 1 specifically, not merely a truthy/nonzero value",
  );
});

console.log(`\n${passed} test(s) passed.`);
if (process.exitCode) {
  console.error("\nSOME TESTS FAILED.");
} else {
  console.log("ALL TESTS PASSED.");
}

// ---------------------------------------------------------------------------
// extractCoAuthors is async (it may resolve co-author noreply emails via the
// API), so its tests run in an async IIFE after the synchronous ones above -
// the summary printed above only covers those. This second, independent
// summary covers this block specifically; `npm test`'s overall pass/fail for
// this file is the logical AND of both (either block setting
// process.exitCode fails the whole `node test/logic.test.js` run).
// ---------------------------------------------------------------------------
(async () => {
  let asyncPassed = 0;
  async function testAsync(name, fn) {
    try {
      await fn();
      console.log(`PASS: ${name}`);
      asyncPassed += 1;
    } catch (e) {
      console.error(`FAIL: ${name}\n - ${e.stack}`);
      process.exitCode = 1;
    }
  }

  // --- extractCoAuthors: defensive against non-string/empty input --------
  // Production only ever calls this with `c.commit?.message`, which can
  // legitimately be undefined (missing `commit` object in a malformed API
  // response) - and the function itself does `commitMessage || ""` before
  // matching, suggesting it was written to tolerate more than just the one
  // real-world undefined case. Each of these documents (and locks in) that
  // it resolves to "no co-authors found" without throwing and, just as
  // importantly, without making any network call it doesn't need to - a
  // stubbed fetch that throws on any call proves that.
  const throwIfFetched = async (url) => {
    throw new Error(
      `extractCoAuthors must not make any network call for input with no trailer match, but called: ${url}`,
    );
  };

  await testAsync(
    "extractCoAuthors(undefined) returns no co-authors, no crash, no network call",
    async () => {
      global.fetch = throwIfFetched;
      const result = await extractCoAuthors(undefined);
      assert.deepStrictEqual(result, { authors: [], hasUnresolved: false });
    },
  );

  await testAsync(
    "extractCoAuthors(null) returns no co-authors, no crash, no network call",
    async () => {
      global.fetch = throwIfFetched;
      const result = await extractCoAuthors(null);
      assert.deepStrictEqual(result, { authors: [], hasUnresolved: false });
    },
  );

  await testAsync(
    'extractCoAuthors("") returns no co-authors, no crash, no network call',
    async () => {
      global.fetch = throwIfFetched;
      const result = await extractCoAuthors("");
      assert.deepStrictEqual(result, { authors: [], hasUnresolved: false });
    },
  );

  await testAsync(
    "extractCoAuthors rejects a non-string value (e.g. a number) safely instead of throwing",
    async () => {
      global.fetch = throwIfFetched;
      const result = await extractCoAuthors(12345);
      assert.deepStrictEqual(result, { authors: [], hasUnresolved: false });
    },
  );

  await testAsync(
    "extractCoAuthors rejects a non-string, non-primitive value (a plain object) safely instead of throwing",
    async () => {
      global.fetch = throwIfFetched;
      const result = await extractCoAuthors({ not: "a string" });
      assert.deepStrictEqual(result, { authors: [], hasUnresolved: false });
    },
  );

  await testAsync(
    'extractCoAuthors still correctly finds a real trailer once given an actual string message (sanity check: the defensive `|| ""` above isn\'t swallowing real input too)',
    async () => {
      global.fetch = async (url) => {
        if (url.includes("/user/123")) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ login: "alice" }),
            headers: { get: () => null },
          };
        }
        throw new Error(`unexpected call: ${url}`);
      };
      const result = await extractCoAuthors(
        "Fix bug\n\nCo-authored-by: Alice <123+alice@users.noreply.github.com>",
      );
      assert.strictEqual(result.hasUnresolved, false);
      assert.deepStrictEqual(result.authors, [{ id: 123, login: "alice" }]);
    },
  );

  await testAsync(
    "extractCoAuthors flags a NEW_NOREPLY-format trailer as unresolved when resolveLoginById can't resolve the claimed id (e.g. a deleted account)",
    async () => {
      global.fetch = async (url) => {
        if (url.includes("/user/999888777"))
          return {
            ok: false,
            status: 404,
            text: async () => "{}",
            headers: { get: () => null },
          };
        throw new Error(`unexpected call: ${url}`);
      };
      const result = await extractCoAuthors(
        "Fix bug\n\nCo-authored-by: Ghost <999888777+ghost@users.noreply.github.com>",
      );
      assert.strictEqual(
        result.hasUnresolved,
        true,
        "an id that doesn't resolve to any current account must be flagged for manual review, not silently dropped or trusted from the trailer text",
      );
      assert.deepStrictEqual(result.authors, []);
    },
  );

  await testAsync(
    "extractCoAuthors flags an OLD_NOREPLY-format trailer as unresolved when resolveUserIdByLogin can't resolve the login (e.g. a deleted/renamed account)",
    async () => {
      global.fetch = async (url) => {
        if (url.includes("/users/long-gone-user"))
          return {
            ok: false,
            status: 404,
            text: async () => "{}",
            headers: { get: () => null },
          };
        throw new Error(`unexpected call: ${url}`);
      };
      const result = await extractCoAuthors(
        "Fix bug\n\nCo-authored-by: Old Timer <long-gone-user@users.noreply.github.com>",
      );
      assert.strictEqual(
        result.hasUnresolved,
        true,
        "a login that doesn't resolve to any current account must be flagged for manual review",
      );
      assert.deepStrictEqual(result.authors, []);
    },
  );

  // --- MAX_COAUTHOR_TRAILERS_PER_COMMIT (20) exact boundary --------------
  await testAsync(
    "extractCoAuthors resolves ALL 20 co-authors, with hasUnresolved: false, when a commit has EXACTLY the cap's worth of unique trailers",
    async () => {
      const trailers = Array.from(
        { length: 20 },
        (_, i) =>
          `Co-authored-by: Person${i} <${5000 + i}+person${i}@users.noreply.github.com>`,
      ).join("\n");
      global.fetch = async (url) => {
        const m = url.match(/\/user\/(\d+)$/);
        if (m) {
          const id = Number(m[1]);
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ login: `person${id - 5000}` }),
            headers: { get: () => null },
          };
        }
        throw new Error(`unexpected call: ${url}`);
      };
      const result = await extractCoAuthors(`Fix bug\n\n${trailers}`);
      assert.strictEqual(
        result.hasUnresolved,
        false,
        "exactly 20 unique trailers must all be processed - the cap check (seen.size >= 20) must not fire before the 20th one is added",
      );
      assert.strictEqual(result.authors.length, 20);
    },
  );

  await testAsync(
    "extractCoAuthors stops at 20 and flags hasUnresolved: true once a commit has 21 unique trailers - the 21st (and only the 21st) tips over the cap",
    async () => {
      const trailers = Array.from(
        { length: 21 },
        (_, i) =>
          `Co-authored-by: Person${i} <${6000 + i}+person${i}@users.noreply.github.com>`,
      ).join("\n");
      global.fetch = async (url) => {
        const m = url.match(/\/user\/(\d+)$/);
        if (m) {
          const id = Number(m[1]);
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ login: `person${id - 6000}` }),
            headers: { get: () => null },
          };
        }
        throw new Error(`unexpected call: ${url}`);
      };
      const result = await extractCoAuthors(`Fix bug\n\n${trailers}`);
      assert.strictEqual(
        result.hasUnresolved,
        true,
        "the 21st unique trailer must tip the cap and flag the commit for manual review",
      );
      assert.strictEqual(
        result.authors.length,
        20,
        "exactly the first 20 must still be processed - the cap stops further lookups, it doesn't discard what was already resolved",
      );
    },
  );

  console.log(`\n${asyncPassed} test(s) passed.`);
  if (process.exitCode) {
    console.error("\nSOME TESTS FAILED.");
    process.exit(1);
  } else {
    console.log("ALL TESTS PASSED.");
  }
})();
