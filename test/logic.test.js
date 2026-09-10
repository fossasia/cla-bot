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
  isPrivileged,
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

test("validateConfig still requires the base presence checks (unchanged behavior)", () => {
  assertConfigFails({ ...VALID_BASE_CONFIG, GITHUB_TOKEN: "" }, "GITHUB_TOKEN");
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

console.log(`\n${passed} test(s) passed.`);
if (process.exitCode) {
  console.error("\nSOME TESTS FAILED.");
} else {
  console.log("ALL TESTS PASSED.");
}
