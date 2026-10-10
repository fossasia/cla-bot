"use strict";
/** Offline unit tests for the bot's pure helpers. */
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
process.env.ALLOWLIST = "99,98";

const {
  isSigned,
  SignatureIndex,
  isAllowlisted,
  parseAllowlist,
  createAppJWT,
  base64url,
  isPrivileged,
  assertValidPRNumber,
  assertValidInstallationId,
  assertValidUserId,
  assertValidSha,
  classifyBotComment,
  personalSuccessMessage,
  isSameContributor,
  signerCompletedRequirement,
  mergeSignatures,
  extractCoAuthors,
  createLookupBudget,
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
// Identity is the immutable numeric account id ONLY. Logins are mutable and
// reusable, so they are never consulted.
test("signature match is keyed on the numeric id; login case/spelling is irrelevant", () => {
  const data = { signatures: [{ id: 7, login: "AmanKumar" }] };
  assert.strictEqual(isSigned(data, { id: 7, login: "amankumar" }), true);
  assert.strictEqual(
    isSigned(data, { id: 7, login: "totally-different" }),
    true,
  );
});

test("signature match does not false-positive on an unrelated account", () => {
  const data = { signatures: [{ id: 7, login: "AmanKumar" }] };
  assert.strictEqual(isSigned(data, { id: 8, login: "someoneelse" }), false);
});

test("signature match on empty store returns false", () => {
  assert.strictEqual(
    isSigned({ signatures: [] }, { id: 1, login: "anyone" }),
    false,
  );
});

// --- identity: signatures survive a GitHub username rename/reclaim -------
test("signature match survives a rename: same id, new login", () => {
  const data = { signatures: [{ id: 555, login: "alice" }] };
  assert.strictEqual(isSigned(data, { id: 555, login: "alice-new" }), true);
});

test("a different account that reclaims a released login is NOT treated as already signed", () => {
  const data = { signatures: [{ id: 555, login: "alice" }] };
  assert.strictEqual(isSigned(data, { id: 999, login: "alice" }), false);
});

test("isSigned NEVER falls back to login matching: a bare login string, an id-less author, or an id-less stored entry all fail closed", () => {
  const withId = { signatures: [{ id: 555, login: "alice" }] };
  assert.strictEqual(isSigned(withId, "alice"), false, "bare login string");
  assert.strictEqual(
    isSigned(withId, { login: "alice" }),
    false,
    "author without id",
  );
  assert.strictEqual(
    isSigned(withId, { id: "555", login: "alice" }),
    false,
    "string id",
  );
  const idless = {
    signatures: [
      { login: "alice" },
      { id: "555", login: "alice" },
      { id: null },
    ],
  };
  assert.strictEqual(
    isSigned(idless, { id: 555, login: "alice" }),
    false,
    "stored entry without a numeric id",
  );
});

// --- allowlist: numeric account ids only ----------------------------------
// The process-wide ALLOWLIST for this file is "99,98" (set at the top).
test("allowlist matches an author by numeric id", () => {
  assert.strictEqual(isAllowlisted({ id: 99, login: "dependabot[bot]" }), true);
  assert.strictEqual(isAllowlisted({ id: 98, login: "anything" }), true);
});

test("allowlist ignores the login entirely: a rename stays exempt, a reused login does not inherit", () => {
  assert.strictEqual(
    isAllowlisted({ id: 99, login: "renamed-bot[bot]" }),
    true,
  );
  assert.strictEqual(
    isAllowlisted({ id: 12345, login: "dependabot[bot]" }),
    false,
  );
});

test("allowlist never matches a bare login string or anything without a real numeric id", () => {
  for (const bad of [
    "dependabot[bot]",
    "99",
    99,
    null,
    undefined,
    {},
    [],
    { login: "x" },
    { id: "99" },
    { id: 99.5 },
    { id: NaN },
    { id: null },
    { id: [99] },
  ]) {
    assert.strictEqual(
      isAllowlisted(bad),
      false,
      `${JSON.stringify(bad)} must fail closed`,
    );
  }
});

test("an all-digit USERNAME equal to an allowlisted id gains nothing (login is never read as an id)", () => {
  assert.strictEqual(isAllowlisted({ id: 1, login: "99" }), false);
  assert.strictEqual(isAllowlisted({ id: 1, login: 99 }), false);
});

test("allowlist does NOT let a human bypass by naming themselves like a bot", () => {
  assert.strictEqual(isAllowlisted({ id: 1, login: "bot-hacker-123" }), false);
  assert.strictEqual(isAllowlisted({ id: 1, login: "super-bot" }), false);
});

test("parseAllowlist accepts ids separated by commas and/or any whitespace (incl. multi-line YAML) and de-duplicates", () => {
  const { ids, invalid } = parseAllowlist("  42, 7 ,,\n 99\t\r\n42 ,");
  assert.deepStrictEqual(
    [...ids].sort((a, b) => a - b),
    [7, 42, 99],
  );
  assert.deepStrictEqual(invalid, []);
});

test("parseAllowlist handles empty/undefined/null/separator-only input", () => {
  for (const v of ["", undefined, null, "  ,, \n"]) {
    const r = parseAllowlist(v);
    assert.strictEqual(r.ids.size + r.invalid.length, 0);
  }
});

test("parseAllowlist reports every non-id entry instead of dropping or coercing it", () => {
  for (const bad of [
    "dependabot[bot]",
    "id:42",
    "0",
    "-5",
    "1.5",
    "1e3",
    "0x10",
    "012",
    "+5",
    "abc",
    "42abc",
    "9007199254740993",
    "１２３" /* full-width digits */,
  ]) {
    const { ids, invalid } = parseAllowlist(bad);
    assert.strictEqual(ids.size, 0, `${bad} must not yield an id`);
    assert.deepStrictEqual(invalid, [bad], `${bad} must be reported`);
  }
  const mixed = parseAllowlist("5,bot,6");
  assert.deepStrictEqual([...mixed.ids], [5, 6]);
  assert.deepStrictEqual(mixed.invalid, ["bot"]);
});

test("a fresh module honors its own ALLOWLIST value (parsed once at load)", () => {
  withFreshBot({ ALLOWLIST: " 4242 ,\n 4243" }, ({ isAllowlisted: fresh }) => {
    assert.strictEqual(fresh({ id: 4242, login: "x" }), true);
    assert.strictEqual(fresh({ id: 4243, login: "x" }), true);
    assert.strictEqual(fresh({ id: 99, login: "x" }), false);
  });
});

// --- impersonation guard ---------------------------------------------------
test("a third party signing does not clear the actual PR commit author", () => {
  const prCommitAuthors = [{ id: 1, login: "real-author" }];
  const store = { signatures: [{ id: 2, login: "random-commenter" }] };
  const missing = prCommitAuthors.filter((a) => !isSigned(store, a));
  assert.deepStrictEqual(missing, prCommitAuthors);
});

test("PR is fully clear only once the actual author signs", () => {
  const prCommitAuthors = [{ id: 1, login: "real-author" }];
  const store = { signatures: [{ id: 1, login: "real-author" }] };
  const missing = prCommitAuthors.filter((a) => !isSigned(store, a));
  assert.deepStrictEqual(missing, []);
});

test("multiple commit authors on one PR all must sign independently", () => {
  const alice = { id: 1, login: "alice" };
  const bob = { id: 2, login: "bob" };
  const store = { signatures: [{ id: 1, login: "alice" }] };
  const missing = [alice, bob].filter((a) => !isSigned(store, a));
  assert.deepStrictEqual(missing, [bob]);
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

// validateConfig checks only the PEM header. createAppJWT() must still reject
// invalid key contents when it signs.
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

test("signerCompletedRequirement uses the signer's id for the allowlist (an allowlisted-by-id signer gets no completion credit, even after a rename)", () => {
  withFreshBot(
    { ALLOWLIST: "4242" },
    ({ signerCompletedRequirement: fresh }) => {
      const signer = { id: 4242, login: "renamed-trusted" };
      assert.strictEqual(fresh([signer], signer), false);
      const reuser = { id: 5, login: "trusted-user" };
      assert.strictEqual(fresh([reuser], reuser), true);
    },
  );
});

test("isSigned matches a malformed stored login by numeric id", () => {
  const data = { signatures: [{ id: 1, login: 123 }] };
  assert.strictEqual(isSigned(data, { id: 1, login: "someone" }), true);
});

test("isSigned fails closed (returns false, never throws) on a null/non-object STORED entry", () => {
  // Malformed stored entries are retained for write-back, so matching must
  // handle them safely.
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
  GITHUB_SERVER_URL: "https://github.com",
  // Explicitly empty: this file's process-wide ALLOWLIST (set at the top)
  // contains login entries, which make validateConfig() emit an advisory
  // warning. Tests asserting an exact warning list must not inherit that.
  ALLOWLIST: "",
};

test("validateConfig accepts a well-formed config (baseline sanity check for the tests below)", () => {
  assertConfigOK(VALID_BASE_CONFIG);
});

test("validateConfig accepts the documented GITHUB_TOKEN fallback when both App credentials are empty", () => {
  assertConfigOK({
    ...VALID_BASE_CONFIG,
    SIG_APP_ID: "",
    SIG_APP_PRIVATE_KEY: "",
  });
});

test("validateConfig rejects either partial GitHub App credential configuration", () => {
  assertConfigFails(
    { ...VALID_BASE_CONFIG, SIG_APP_ID: "12345", SIG_APP_PRIVATE_KEY: "" },
    "SIG_APP_ID and SIG_APP_PRIVATE_KEY",
  );
  assertConfigFails(
    {
      ...VALID_BASE_CONFIG,
      SIG_APP_ID: "",
      SIG_APP_PRIVATE_KEY: "configured-key",
    },
    "SIG_APP_ID and SIG_APP_PRIVATE_KEY",
  );
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

test("validateConfig rejects an invalid GITHUB_SERVER_URL before processing events", () => {
  for (const value of [
    "not a URL",
    "file:///tmp",
    "https://user:secret@example.com",
  ]) {
    assertConfigFails(
      { ...VALID_BASE_CONFIG, GITHUB_SERVER_URL: value },
      "GITHUB_SERVER_URL must be an HTTP(S) URL without credentials",
    );
  }
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

// The SIG_PATH check (findSigPathProblem) has many independent rejection
// rules (leading "/", backslash, ".." segment, whitespace-only, and - added
// later - "#", "?", "%", whitespace, control characters, "."/empty/".git"
// segments, trailing "/", invalid Unicode). The two tests above only drive
// the leading-"/" and ".." rules. Without a dedicated test for each of the
// remaining rules, a future refactor could silently break any one (e.g.
// drop the backslash check entirely) and nothing would catch it, even
// though overall statement/line coverage of this file would stay at
// 100% throughout (the buggy line would still be *executed*, just no
// longer *asserted on*). The exhaustive per-character matrix lives in
// test/sig-path.test.js; the cases below pin the validateConfig() wiring.
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

// Same as assertConfigFails, but returns the exact message instead of
// asserting on a substring - used to check the message's FORMAT (single
// line, JSON-quoted value), not just its content.
function captureConfigFailure(envOverrides) {
  let message = null;
  withFreshBot(envOverrides, (mod) => {
    const originalExit = process.exit;
    const originalError = console.error;
    process.exit = () => {
      throw new Error("__TEST_PROCESS_EXIT__");
    };
    console.error = (msg) => {
      // FIRST message wins: in production the first fail() call terminates
      // the process, but here process.exit is mocked to throw, and one
      // branch of validateConfig calls fail() inside a try/catch whose
      // catch then calls fail() AGAIN - a test-only artifact that would
      // otherwise overwrite the message under test with the second one.
      if (message === null) message = msg;
    };
    try {
      mod.validateConfig();
    } catch (e) {
      if (e.message !== "__TEST_PROCESS_EXIT__") throw e;
    } finally {
      process.exit = originalExit;
      console.error = originalError;
    }
  });
  return message;
}

for (const [label, value] of [
  [
    'a "#" (would silently truncate the request path to everything before it)',
    "sig#path.json",
  ],
  [
    'a "?" (would turn the rest of the path into a query string)',
    "sig?q=1.json",
  ],
  ['a literal "%"', "100%.json"],
  [
    'a percent-encoded ".." ("%2e%2e" is collapsed into real traversal by the URL parser)',
    "a/%2e%2e/b.json",
  ],
  ['an upper-case percent-encoded ".." ("%2E%2E")', "a/%2E%2E/b.json"],
  ['a percent-encoded slash ("%2f")', "a%2fb.json"],
  ["an interior tab (silently stripped by the URL parser)", "a\tb.json"],
  ["an interior newline", "a\nb.json"],
  // (NUL byte / lone surrogate: not representable in process.env at all -
  // covered directly via findSigPathProblem in test/sig-path.test.js.)
  ['a "." segment in the middle of the path', "a/./b.json"],
  ['a ".." segment in the middle of the path', "a/../b.json"],
  ['an empty segment ("//")', "a//b.json"],
  ["a trailing slash (a directory, not a file)", "signatures/"],
  ['a ".git" segment', "a/.git/b.json"],
]) {
  test(`validateConfig rejects a SIG_PATH containing ${label}`, () => {
    assertConfigFails({ ...VALID_BASE_CONFIG, SIG_PATH: value }, "SIG_PATH");
  });
}

test("validateConfig's SIG_PATH failure is ONE log line with the value JSON-quoted - a newline in the value can't forge extra workflow commands", () => {
  const msg = captureConfigFailure({
    ...VALID_BASE_CONFIG,
    SIG_PATH: "a\n::warning::pwned",
  });
  assert.ok(msg && msg.startsWith("::error::SIG_PATH "), msg);
  assert.ok(!msg.includes("\n"), "the message must not contain a raw newline");
  assert.ok(msg.includes('"a\\n::warning::pwned"'), msg);
});

test("validateConfig's SIG_OWNER failure is ONE log line with the value JSON-quoted (same hardening as SIG_PATH/SIG_REPO)", () => {
  const msg = captureConfigFailure({
    ...VALID_BASE_CONFIG,
    SIG_OWNER: "bad\n::warning::pwned",
  });
  assert.ok(msg && msg.startsWith("::error::SIG_OWNER "), msg);
  assert.ok(!msg.includes("\n"), "the message must not contain a raw newline");
  assert.ok(msg.includes('"bad\\n::warning::pwned"'), msg);
});

test("validateConfig's SIG_REPO failure is ONE log line with the value JSON-quoted", () => {
  const msg = captureConfigFailure({
    ...VALID_BASE_CONFIG,
    SIG_REPO: "bad\n::warning::pwned",
  });
  assert.ok(msg && msg.startsWith("::error::SIG_REPO "), msg);
  assert.ok(!msg.includes("\n"), msg);
});

test("validateConfig's CLA_DOCUMENT_URL failures (not-a-URL, and non-http(s)) are ONE log line with the value JSON-quoted", () => {
  for (const value of [
    "not a url\n::warning::pwned",
    "ftp://example.com/\n::warning::pwned",
  ]) {
    const msg = captureConfigFailure({
      ...VALID_BASE_CONFIG,
      CLA_DOCUMENT_URL: value,
    });
    assert.ok(msg && msg.startsWith("::error::CLA_DOCUMENT_URL "), msg);
    assert.ok(!msg.includes("\n"), `raw newline leaked into: ${msg}`);
    assert.ok(msg.includes(JSON.stringify(value)), msg);
  }
});

test("validateConfig's SIG_PATH failure message says WHY the path was rejected", () => {
  const msg = captureConfigFailure({
    ...VALID_BASE_CONFIG,
    SIG_PATH: "sig#path.json",
  });
  assert.ok(msg.includes('"#"'), msg);
});

// Normalization announces itself with a ::warning:: (see validateConfig), so
// the acceptance tests below mute console.warn - otherwise every accepted,
// normalized value would add a real annotation to the CI run's log.
function withMutedWarnings(fn) {
  const original = console.warn;
  const seen = [];
  console.warn = (m) => seen.push(m);
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return seen;
}

test("validateConfig accepts SIG_PATH values that always worked and must keep working (spaces, trailing whitespace/newline, a leading './', leading and Unicode whitespace as part of the name) - backward compatibility", () => {
  withMutedWarnings(() => {
    for (const p of [
      "signatures/my file.json",
      "dir with space/cla.json",
      "a\u00a0b.json",
      "signatures/cla.json\n",
      "signatures/cla.json  ",
      "./signatures/cla.json",
      " leading/cla.json",
      " ./signatures/cla.json",
      "\u00a0signatures/cla.json",
      "signatures/cla.json\u00a0",
    ]) {
      assertConfigOK({ ...VALID_BASE_CONFIG, SIG_PATH: p });
    }
  });
});

test("validateConfig warns - once, as one escaped line - when it normalizes SIG_PATH, and stays silent when it does not", () => {
  const warned = withMutedWarnings(() =>
    assertConfigOK({
      ...VALID_BASE_CONFIG,
      SIG_PATH: " \t./signatures/cla.json\n",
    }),
  );
  assert.strictEqual(warned.length, 1);
  assert.ok(warned[0].startsWith("::warning::SIG_PATH "), warned[0]);
  assert.ok(!warned[0].includes("\n"), "no raw newline in the warning");
  assert.ok(
    warned[0].includes('" \\t./signatures/cla.json\\n"'),
    warned[0],
  );
  assert.ok(
    warned[0].includes('normalized to "signatures/cla.json"'),
    warned[0],
  );

  const silent = withMutedWarnings(() => assertConfigOK(VALID_BASE_CONFIG));
  assert.deepStrictEqual(silent, []);
});

test("validateConfig fails loudly on any non-id ALLOWLIST entry (e.g. a username), naming each offender, with a safely escaped message", () => {
  for (const bad of ["dependabot[bot]", "id:42", "0", "5,oops", "1e3"]) {
    assertConfigFails({ ...VALID_BASE_CONFIG, ALLOWLIST: bad }, "ALLOWLIST");
  }
  assertConfigFails(
    { ...VALID_BASE_CONFIG, ALLOWLIST: "42,dependabot[bot]" },
    '"dependabot[bot]"',
  );
  // A control character can't inject a raw extra line into the Actions log
  // (whitespace splits entries, but other control chars stay in the entry).
  assertConfigFails(
    { ...VALID_BASE_CONFIG, ALLOWLIST: "bad\u0007bell" },
    "bad\\u0007bell",
  );
});

test("validateConfig accepts an id-only allowlist (comma/newline separated) and an empty one, silently", () => {
  for (const ok of ["42,43", "42\n43", " 42 , 43 ,", ""]) {
    assert.deepStrictEqual(
      withMutedWarnings(() =>
        assertConfigOK({ ...VALID_BASE_CONFIG, ALLOWLIST: ok }),
      ),
      [],
      `ALLOWLIST=${JSON.stringify(ok)} should be accepted with no warnings`,
    );
  }
});

test("validateConfig still rejects a value that is nothing but whitespace (ASCII, newline or Unicode) - it normalizes to empty / is empty after trim", () => {
  assertConfigFails({ ...VALID_BASE_CONFIG, SIG_PATH: " \n " }, "SIG_PATH");
  assertConfigFails({ ...VALID_BASE_CONFIG, SIG_PATH: "\u00a0" }, "SIG_PATH");
});

test("validateConfig accepts legitimate-but-unusual SIG_PATH values (hidden dirs, non-ASCII, '+', '@', '~', names merely containing dots)", () => {
  for (const p of [
    "cla.json",
    ".github/cla.json",
    "a+b@c~d.json",
    "file..name.json",
    "..hidden/x.json",
    "签名/协议.json",
  ]) {
    assertConfigOK({ ...VALID_BASE_CONFIG, SIG_PATH: p });
  }
});

test('validateConfig rejects SIG_REPO "." and ".." (they match the repo-name character class but are URL dot-segments: "/repos/o/../contents" collapses to "/repos/contents")', () => {
  assertConfigFails({ ...VALID_BASE_CONFIG, SIG_REPO: ".." }, "SIG_REPO");
  assertConfigFails({ ...VALID_BASE_CONFIG, SIG_REPO: "." }, "SIG_REPO");
});

test('validateConfig still accepts legitimate dotted repo names (".github", "a..b", "repo.js")', () => {
  for (const r of [".github", "a..b", "repo.js", "...x"]) {
    assertConfigOK({ ...VALID_BASE_CONFIG, SIG_REPO: r });
  }
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

test("validateConfig rejects SIG_APP_ID values that are not positive decimal integers", () => {
  const configuredKey = "configured-key";
  for (const id of [
    "0",
    "-1",
    "+1",
    "1.5",
    "1e3",
    "abc",
    " 123",
    "0123",
    "123\n",
    "123\r",
    "123\r\n",
    "123\u2028",
    "123\u2029",
  ]) {
    assertConfigFails(
      {
        ...VALID_BASE_CONFIG,
        SIG_APP_ID: id,
        SIG_APP_PRIVATE_KEY: configuredKey,
      },
      "SIG_APP_ID",
    );
  }
});

// validateConfig checks the PEM header only. A valid-looking header is
// enough here; JWT creation checks the key contents later.
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

// Check each required configuration value independently.
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

// --- assertValidUserId ----------------------------------------------------
// Test ids directly so NaN and Infinity are covered too.
test("assertValidUserId accepts an ordinary positive integer and returns it unchanged", () => {
  assert.strictEqual(assertValidUserId(12345, "ctx"), 12345);
});

test("assertValidUserId accepts the smallest valid id (1) and Number.MAX_SAFE_INTEGER (both boundaries, not the offenders)", () => {
  assert.strictEqual(assertValidUserId(1, "ctx"), 1);
  assert.strictEqual(
    assertValidUserId(Number.MAX_SAFE_INTEGER, "ctx"),
    Number.MAX_SAFE_INTEGER,
  );
});

for (const { label, value } of [
  {
    label:
      "undefined (the key was absent - JSON.stringify would silently drop it from the stored entry)",
    value: undefined,
  },
  { label: "null (JSON.stringify would persist a literal null)", value: null },
  {
    label:
      "a numeric string (typeof !== 'number', so isSigned() could never id-match it)",
    value: "123",
  },
  { label: "a non-numeric string", value: "not-a-number" },
  { label: "an empty string", value: "" },
  { label: "zero", value: 0 },
  { label: "negative zero", value: -0 },
  { label: "a negative integer", value: -5 },
  { label: "a non-integer float", value: 1.5 },
  { label: "NaN", value: NaN },
  { label: "Infinity", value: Infinity },
  { label: "-Infinity", value: -Infinity },
  {
    label: "Number.MAX_SAFE_INTEGER + 1 (an integer, but not a safe one)",
    value: Number.MAX_SAFE_INTEGER + 1,
  },
  { label: "1e100", value: 1e100 },
  { label: "a boolean", value: true },
  { label: "an array", value: [123] },
  { label: "a plain object", value: {} },
  { label: "a Number wrapper object", value: Object(123) },
]) {
  test(`assertValidUserId rejects ${label}`, () => {
    assert.throws(
      () => assertValidUserId(value, "ctx"),
      /expected a positive integer GitHub user id/,
    );
  });
}

test("assertValidUserId's error message includes the context, the rejected value and its type", () => {
  assert.throws(
    () => assertValidUserId("123", "issue_comment payload comment.user.id"),
    /issue_comment payload comment\.user\.id: expected a positive integer GitHub user id, got "123" \(string\)/,
  );
  assert.throws(
    () => assertValidUserId(undefined, "ctx"),
    /ctx: expected a positive integer GitHub user id, got undefined \(undefined\)/,
  );
});

// Documents WHY the validator exists, at the isSigned() level: an entry that
// was persisted without a usable numeric id can never match anyone (fail
// closed), instead of being matched by login and inherited by whoever later
// claims that login.
test("isSigned: an id-less stored entry matches NOBODY - not even the same login", () => {
  const idless = { signatures: [{ login: "mona" }] };
  assert.strictEqual(isSigned(idless, { id: 999, login: "mona" }), false);
  const withId = { signatures: [{ id: 111, login: "mona" }] };
  assert.strictEqual(isSigned(withId, { id: 999, login: "mona" }), false);
  assert.strictEqual(isSigned(withId, { id: 111, login: "mona" }), true);
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

test("isSameContributor never falls back to login matching (missing id on either side, or both)", () => {
  assert.strictEqual(
    isSameContributor({ login: "Alice" }, { login: "alice" }),
    false,
  );
  assert.strictEqual(
    isSameContributor({ id: 1, login: "alice" }, { login: "alice" }),
    false,
  );
  assert.strictEqual(
    isSameContributor({ login: "alice" }, { id: 2, login: "alice" }),
    false,
  );
  assert.strictEqual(
    isSameContributor({ id: "1", login: "alice" }, { id: "1", login: "alice" }),
    false,
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

// --- SignatureIndex: O(1) lookups with the exact semantics of the old scan ---
// isSigned() and mergeSignatures() used to scan the signature array (O(n) per
// question, O(n^2) for the merge). They now probe a SignatureIndex. These tests
// pin down three things: the index's own edge cases, that behaviour is
// identical to the old linear code (differential test against a verbatim copy
// of it), and that the complexity really is what it claims (counted reads of
// stored entries, so nothing here depends on wall-clock timing).

// Verbatim copies of the pre-index implementations. Reference only.
function legacyIsSigned(data, author) {
  if (author == null || typeof author !== "object") return false;
  const id = author.id;
  if (typeof id !== "number") return false;
  return data.signatures.some((s) => s && typeof s === "object" && s.id === id);
}
function legacyMergeSignatures(known, fresh) {
  if (!known) return fresh;
  const keptFromKnown = known.signatures.filter(
    (k) => !fresh.signatures.some((f) => isSameContributor(k, f)),
  );
  return {
    version: fresh.version,
    signatures: [...keptFromKnown, ...fresh.signatures],
  };
}

// Small seeded PRNG (mulberry32) so a failure is reproducible.
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("SignatureIndex answers has() for numeric ids of well-formed entries and nothing else", () => {
  const index = new SignatureIndex([
    { id: 1, login: "alice" },
    { id: 2 }, // no login: still indexed, isSigned() always matched on id alone
    { id: 3, login: 123 }, // wrong-typed login: same
    { id: 3, login: "dup" }, // duplicate id: harmless
  ]);
  for (const id of [1, 2, 3]) assert.strictEqual(index.has(id), true, `${id}`);
  for (const id of [0, 4, -1, "1", "2", null, undefined, {}, [], 1.5]) {
    assert.strictEqual(index.has(id), false, `has(${String(id)})`);
  }
});

test("SignatureIndex never indexes an entry without a usable numeric id (fails closed)", () => {
  const index = new SignatureIndex([
    null,
    undefined,
    42,
    "oops",
    [],
    true,
    { login: "no-id" },
    { id: "555", login: "string-id" },
    { id: null },
    { id: undefined },
    { id: {} },
    { id: NaN }, // typeof NaN is "number", but it must never match anything
    // Only plain objects count, as with the old `typeof s === "object"` rule.
    // A function (or anything else non-object) that merely carries an id is not
    // a signature record.
    Object.assign(() => {}, { id: 555 }),
  ]);
  for (const probe of [555, "555", null, undefined, NaN, 0, 42]) {
    assert.strictEqual(index.has(probe), false, `has(${String(probe)})`);
  }
});

test("SignatureIndex keeps matching like === does: 0 and -0 are the same id, Infinity is allowed", () => {
  const index = new SignatureIndex([{ id: 0 }, { id: Infinity }]);
  assert.strictEqual(index.has(-0), true);
  assert.strictEqual(index.has(Infinity), true);
  assert.strictEqual(index.has(-Infinity), false);
});

test("SignatureIndex.add() indexes a single entry and ignores a bad one", () => {
  const index = new SignatureIndex([]);
  index.add({ id: 9, login: "late" });
  index.add(null);
  index.add({ id: "10" });
  assert.strictEqual(index.has(9), true);
  assert.strictEqual(index.has(10), false);
});

test("SignatureIndex is a snapshot: later changes to the source array are not seen, so callers rebuild for new data", () => {
  const signatures = [{ id: 1, login: "a" }];
  const index = new SignatureIndex(signatures);
  signatures.push({ id: 2, login: "b" });
  assert.strictEqual(index.has(2), false);
  assert.strictEqual(new SignatureIndex(signatures).has(2), true);
});

test("SignatureIndex throws a TypeError on a non-array, like the scan it replaced", () => {
  assert.throws(() => new SignatureIndex(undefined), TypeError);
  assert.throws(() => isSigned({}, { id: 1, login: "x" }), TypeError);
});

test("isSigned accepts a prebuilt SignatureIndex and gives the same answers as a plain data object", () => {
  const data = { signatures: [{ id: 7, login: "AmanKumar" }] };
  const index = new SignatureIndex(data.signatures);
  assert.strictEqual(isSigned(index, { id: 7, login: "renamed" }), true);
  assert.strictEqual(isSigned(index, { id: 8, login: "AmanKumar" }), false);
  assert.strictEqual(isSigned(index, "AmanKumar"), false);
  assert.strictEqual(isSigned(index, { id: "7", login: "x" }), false);
  assert.strictEqual(isSigned(index, { id: NaN, login: "x" }), false);
  assert.strictEqual(isSigned(index, null), false);
});

test("isSigned with a malformed author answers false without touching the store (no throwaway index built for junk input)", () => {
  const { counter, signatures } = countingStore(500);
  for (const bad of [
    null,
    undefined,
    "alice",
    42,
    {},
    { login: "x" },
    { id: "1" },
    { id: null },
  ]) {
    assert.strictEqual(isSigned({ signatures }, bad), false);
  }
  assert.strictEqual(counter.reads, 0);
});

test("isSigned and mergeSignatures behave exactly like the old linear scan on thousands of random stores, including garbage entries", () => {
  const rnd = seededRandom(0xc1a);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const entry = () => {
    const n = 1 + Math.floor(rnd() * 40); // small id range: many collisions
    return pick([
      () => ({ id: n, login: `u${n}` }),
      () => ({ id: n, login: `u${n}`, pr: "o/r#1", signedAt: "t" }),
      () => ({ id: n }),
      () => ({ id: n, login: 123 }),
      () => ({ id: String(n), login: `u${n}` }),
      () => ({ id: null, login: "x" }),
      () => ({ login: "no-id" }),
      () => ({ id: NaN, login: "nan" }),
      () => null,
      () => undefined,
      () => 42,
      () => "oops",
      () => [],
    ])();
  };
  const store = () => ({
    version: 1,
    signatures: Array.from({ length: Math.floor(rnd() * 30) }, entry),
  });
  const authors = [
    ...Array.from({ length: 45 }, (_, i) => ({ id: i, login: `a${i}` })),
    ...Array.from({ length: 45 }, (_, i) => ({ id: String(i), login: "s" })),
    { id: NaN, login: "nan" },
    { login: "no-id" },
    null,
    undefined,
    "alice",
    42,
    {},
  ];

  for (let trial = 0; trial < 1500; trial++) {
    const data = store();
    const index = new SignatureIndex(data.signatures);
    for (const author of authors) {
      const expected = legacyIsSigned(data, author);
      assert.strictEqual(
        isSigned(data, author),
        expected,
        `plain, trial ${trial}`,
      );
      assert.strictEqual(
        isSigned(index, author),
        expected,
        `indexed, trial ${trial}`,
      );
    }
    const known = rnd() < 0.15 ? null : store();
    const fresh = store();
    assert.deepStrictEqual(
      mergeSignatures(known, fresh),
      legacyMergeSignatures(known, fresh),
      `merge, trial ${trial}`,
    );
  }
});

// A store whose entries count how often their `id` is read, so complexity can
// be asserted exactly instead of timed.
function countingStore(size) {
  const counter = { reads: 0 };
  const signatures = Array.from({ length: size }, (_, i) => ({
    get id() {
      counter.reads += 1;
      return i + 1;
    },
    login: `user${i + 1}`,
  }));
  return { counter, signatures };
}

test("complexity: once indexed, isSigned reads NO stored entry - lookups are O(1) however big the store is", () => {
  for (const size of [10, 10_000]) {
    const { counter, signatures } = countingStore(size);
    const index = new SignatureIndex(signatures);
    assert.strictEqual(counter.reads, size, "building reads each entry once");
    counter.reads = 0;
    for (let i = 0; i < 1000; i++) {
      assert.strictEqual(
        isSigned(index, { id: (i % size) + 1, login: "x" }),
        true,
      );
      assert.strictEqual(
        isSigned(index, { id: size + 1 + i, login: "x" }),
        false,
      );
    }
    assert.strictEqual(
      counter.reads,
      0,
      `2000 lookups against ${size} signatures read the store ${counter.reads} times`,
    );
  }
});

test("complexity: mergeSignatures reads each entry once (O(known + fresh)), not known x fresh", () => {
  const size = 3000;
  const known = countingStore(size);
  const fresh = countingStore(size);
  const merged = mergeSignatures(
    { version: 1, signatures: known.signatures },
    { version: 1, signatures: fresh.signatures },
  );
  assert.strictEqual(
    merged.signatures.length,
    size,
    "all known ids are in fresh",
  );
  // The nested scan needed about size^2 / 2 reads here (millions).
  assert.ok(
    known.counter.reads + fresh.counter.reads <= 2 * 2 * size,
    `merge read entries ${known.counter.reads + fresh.counter.reads} times for ${size}+${size} entries`,
  );
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

// Run async co-author tests after the synchronous helper tests.
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

  // Missing or empty messages should return no co-authors without a request.
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

  // --- createLookupBudget() / MAX_COAUTHOR_LOOKUPS_PER_RUN ----------------
  await testAsync(
    "createLookupBudget: admits new emails until max, then refuses new ones but keeps admitting ones already seen",
    async () => {
      const budget = createLookupBudget(2);
      assert.strictEqual(budget.admit("a@x.com"), true);
      assert.strictEqual(budget.admit("b@x.com"), true);
      assert.strictEqual(budget.admit("c@x.com"), false, "past the cap");
      assert.strictEqual(
        budget.admit("a@x.com"),
        true,
        "already-seen email stays free, doesn't cost a new slot",
      );
    },
  );

  await testAsync(
    "createLookupBudget: with no max given, everything is admitted (extractCoAuthors stays usable on its own)",
    async () => {
      const budget = createLookupBudget();
      for (let i = 0; i < 50; i++) {
        assert.strictEqual(budget.admit(`p${i}@x.com`), true);
      }
    },
  );

  await testAsync(
    "extractCoAuthors: a commit within the per-commit cap (20) but past a small shared run budget flags the commit, and skips the network call for the trailer it couldn't afford",
    async () => {
      let calls = 0;
      global.fetch = async (url) => {
        calls += 1;
        const m = url.match(/\/user\/(\d+)$/);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ login: `p${m[1]}` }),
          headers: { get: () => null },
        };
      };
      const budget = createLookupBudget(1); // room for exactly one identity
      const message =
        "Fix bug\n\n" +
        "Co-authored-by: One <7001+one@users.noreply.github.com>\n" +
        "Co-authored-by: Two <7002+two@users.noreply.github.com>";
      const result = await extractCoAuthors(message, budget);
      assert.strictEqual(
        result.hasUnresolved,
        true,
        "the second trailer had no budget left, so the commit is flagged for manual review",
      );
      assert.strictEqual(
        result.authors.length,
        1,
        "the first trailer still resolves normally",
      );
      assert.strictEqual(
        calls,
        1,
        "the over-budget trailer is never looked up - not even attempted",
      );
    },
  );

  await testAsync(
    "extractCoAuthors: a budget shared across several calls (same PR, different commits) is spent across all of them, not reset each time",
    async () => {
      global.fetch = async (url) => {
        const m = url.match(/\/user\/(\d+)$/);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ login: `p${m[1]}` }),
          headers: { get: () => null },
        };
      };
      const budget = createLookupBudget(1);
      const commitA = await extractCoAuthors(
        "Fix bug\n\nCo-authored-by: One <8001+one@users.noreply.github.com>",
        budget,
      );
      const commitB = await extractCoAuthors(
        "Fix bug\n\nCo-authored-by: Two <8002+two@users.noreply.github.com>",
        budget,
      );
      assert.strictEqual(commitA.hasUnresolved, false, "first commit fits");
      assert.strictEqual(commitA.authors.length, 1);
      assert.strictEqual(
        commitB.hasUnresolved,
        true,
        "by the second commit the shared budget is already spent",
      );
      assert.strictEqual(commitB.authors.length, 0);
    },
  );

  await testAsync(
    "createLookupBudget via extractCoAuthors: two trailers naming the SAME id with different claimed login text share one budget slot, not two",
    async () => {
      global.fetch = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ login: "real-login" }),
        headers: { get: () => null },
      });
      const budget = createLookupBudget(1); // room for exactly one identity
      const message =
        "Fix bug\n\n" +
        "Co-authored-by: Claimed As Bob <9001+bob@users.noreply.github.com>\n" +
        "Co-authored-by: Claimed As Robert <9001+robert@users.noreply.github.com>";
      const result = await extractCoAuthors(message, budget);
      assert.strictEqual(
        result.hasUnresolved,
        false,
        "both trailers name id 9001, so they share the one slot the budget had room for",
      );
      assert.strictEqual(
        result.authors.length,
        2,
        "both still resolve - the id is what's looked up, the login text in the trailer is ignored",
      );
      assert.deepStrictEqual(result.authors, [
        { id: 9001, login: "real-login" },
        { id: 9001, login: "real-login" },
      ]);
    },
  );

  await testAsync(
    "createLookupBudget via extractCoAuthors: a new-style trailer with an id that can never be real never touches the budget either - resolveCoAuthorEmail rejects it without a request",
    async () => {
      let calls = 0;
      global.fetch = async () => {
        calls += 1;
        throw new Error("no lookup should ever be attempted for this id");
      };
      const budget = createLookupBudget(0); // no room for anything
      // 16 nines is past Number.MAX_SAFE_INTEGER, so isValidGitHubUserId
      // rejects it - no real GitHub account could ever have this id.
      const result = await extractCoAuthors(
        "Fix bug\n\nCo-authored-by: Ghost <9999999999999999+ghost@users.noreply.github.com>",
        budget,
      );
      assert.strictEqual(calls, 0);
      assert.strictEqual(result.hasUnresolved, true);
      assert.strictEqual(result.authors.length, 0);
    },
  );

  await testAsync(
    "createLookupBudget via extractCoAuthors: an address that isn't a noreply format never touches the budget, since resolving it never costs a request",
    async () => {
      let calls = 0;
      global.fetch = async () => {
        calls += 1;
        throw new Error("no lookup should ever be attempted for this address");
      };
      const budget = createLookupBudget(0); // no room for anything
      const result = await extractCoAuthors(
        "Fix bug\n\nCo-authored-by: Someone <someone@example.com>",
        budget,
      );
      assert.strictEqual(calls, 0);
      assert.strictEqual(
        result.hasUnresolved,
        true,
        "still flagged for manual review - just not because the budget ran out",
      );
      assert.strictEqual(result.authors.length, 0);
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
