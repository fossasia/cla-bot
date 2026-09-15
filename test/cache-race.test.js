"use strict";
/**
 * Covers the "cache an in-flight PROMISE, not just the resolved value"
 * fix applied to every module-scope memoization cache in cla-bot.js:
 * getSignaturesToken()'s _sigTokenPromise, resolveBotLogin()'s
 * _botLoginPromise, and the two per-key Maps behind resolveUserIdByLogin()/
 * resolveLoginById(). Before this fix, each of these did a plain
 * "check cache -> await a network call -> write cache" - two concurrent
 * callers for the same key could both observe an empty cache before either
 * write landed, and each would fire its own redundant API call (an extra
 * GitHub App installation-token mint, an extra /user lookup, an extra
 * /users/{login} or /user/{id} lookup). Not a correctness bug (every
 * caller still gets a valid, correct result either way) but wasted work -
 * see the PR analysis this addresses.
 *
 * Every cache here lives at module scope for the life of one process, so
 * (same reasoning as test/bot-identity.test.js) each scenario gets its own
 * fresh `require` in its own child-process-free but cache-reset way isn't
 * available without restarting the process - this file keeps each test
 * self-contained by only asserting on call COUNTS for a single burst of
 * concurrent calls, not by trying to reset the module's internal caches
 * between tests.
 *
 * Run: node test/cache-race.test.js (also included in `npm test`)
 */
const assert = require("assert");

process.env.GITHUB_TOKEN = "dummy";
process.env.GITHUB_REPOSITORY = "fossasia/testrepo";
process.env.SIG_OWNER = "fossasia";
process.env.SIG_REPO = "cla-signatures";
process.env.CLA_DOCUMENT_URL = "https://example.com/CLA.md";
process.env.ALLOWLIST = "";
process.env.SIG_APP_ID = "123456";
process.env.SIG_APP_PRIVATE_KEY = require("crypto")
  .generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" });

const {
  getSignaturesToken,
  postComment,
  resolveUserIdByLogin,
  resolveLoginById,
} = require("../src/cla-bot.js");

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (e) {
    console.error(`FAIL: ${name}\n - ${e.stack}`);
    process.exitCode = 1;
  }
}

function res(status, jsonBody, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (jsonBody === null ? "" : JSON.stringify(jsonBody)),
    headers: { get: (h) => headers[h.toLowerCase()] || null },
  };
}

// Resolves on the next microtask/macrotask boundary - used to let two
// concurrently-started calls both reach their first `await` (and therefore
// both have a chance to observe the cache in whatever state it was in
// before either call's own write) before either one's mocked network call
// resolves. A zero-delay setTimeout is enough here since real network
// mocks below don't resolve any faster than that themselves.
function tick() {
  return new Promise((r) => setTimeout(r, 0));
}

(async () => {
  await test("two concurrent getSignaturesToken() calls mint exactly ONE installation token, not two", async () => {
    let installationCalls = 0;
    let tokenCalls = 0;
    let releaseInstallation;
    const installationGate = new Promise((r) => {
      releaseInstallation = r;
    });
    global.fetch = async (url) => {
      if (url.endsWith("/installation")) {
        installationCalls += 1;
        // Hold the FIRST call open until both callers have had a chance to
        // start - this is what actually forces the race: without the
        // promise-cache fix, the second call would see _sigTokenPromise
        // still null at this point and start its own installation lookup.
        await installationGate;
        return res(200, { id: 999 });
      }
      if (url.includes("/access_tokens")) {
        tokenCalls += 1;
        return res(200, { token: "single-minted-token" });
      }
      throw new Error(`unexpected call in token race test: ${url}`);
    };

    const p1 = getSignaturesToken();
    const p2 = getSignaturesToken();
    await tick();
    await tick();
    releaseInstallation();
    const [t1, t2] = await Promise.all([p1, p2]);

    assert.strictEqual(t1, "single-minted-token");
    assert.strictEqual(t2, "single-minted-token");
    assert.strictEqual(
      installationCalls,
      1,
      `expected exactly one /installation lookup across both concurrent callers, got ${installationCalls}`,
    );
    assert.strictEqual(
      tokenCalls,
      1,
      `expected exactly one /access_tokens mint across both concurrent callers, got ${tokenCalls}`,
    );
  });

  await test("getSignaturesToken() keeps returning the same cached token on a THIRD, later call (cache still works after the race)", async () => {
    global.fetch = async () => {
      throw new Error(
        "must not hit the network again - the token from the previous test should still be cached",
      );
    };
    const token = await getSignaturesToken();
    assert.strictEqual(token, "single-minted-token");
  });

  await test("two concurrent postComment() calls (different PRs) share exactly ONE resolveBotLogin() /user lookup", async () => {
    // Fresh process-wide bot-login cache is still unpopulated at this point
    // in the file (nothing above touched postComment/getExistingBotComments
    // yet), so this is the first time resolveBotLogin() runs.
    let userCalls = 0;
    let releaseUser;
    const userGate = new Promise((r) => {
      releaseUser = r;
    });
    const posted = { 1: [], 2: [] };

    global.fetch = async (url, opts = {}) => {
      const method = (opts.method || "GET").toUpperCase();
      if (url.endsWith("/user")) {
        userCalls += 1;
        await userGate; // hold the first lookup open so a second concurrent call can race it
        return res(200, { login: "some-pat-identity" });
      }
      const prMatch = url.match(/\/issues\/(\d+)\/comments/);
      if (prMatch) {
        const pr = Number(prMatch[1]);
        if (method === "GET") return res(200, posted[pr]);
        if (method === "POST") {
          const { body } = JSON.parse(opts.body);
          const comment = {
            id: posted[1].length + posted[2].length + 1,
            body,
            user: { login: "some-pat-identity" },
          };
          posted[pr].push(comment);
          return res(201, comment);
        }
      }
      if (url.includes("/issues/comments/") && method === "DELETE") {
        return res(404, { message: "Not Found" });
      }
      throw new Error(
        `unexpected call in bot-login race test: ${method} ${url}`,
      );
    };

    const p1 = postComment(1, "hello from PR 1");
    const p2 = postComment(2, "hello from PR 2");
    await tick();
    await tick();
    releaseUser();
    await Promise.all([p1, p2]);

    assert.strictEqual(
      userCalls,
      1,
      `expected exactly one GET /user lookup shared by both concurrent postComment() calls, got ${userCalls}`,
    );
    assert.strictEqual(posted[1].length, 1);
    assert.strictEqual(posted[2].length, 1);
  });

  await test("two concurrent resolveUserIdByLogin() calls for the SAME login share exactly ONE /users/{login} lookup", async () => {
    let userLookups = 0;
    let releaseLookup;
    const gate = new Promise((r) => {
      releaseLookup = r;
    });
    global.fetch = async (url) => {
      if (url.includes("/users/shared-login")) {
        userLookups += 1;
        await gate;
        return res(200, { id: 4242 });
      }
      throw new Error(`unexpected call: ${url}`);
    };

    const p1 = resolveUserIdByLogin("shared-login");
    const p2 = resolveUserIdByLogin("SHARED-LOGIN"); // same key, different case
    await tick();
    await tick();
    releaseLookup();
    const [id1, id2] = await Promise.all([p1, p2]);

    assert.strictEqual(id1, 4242);
    assert.strictEqual(id2, 4242);
    assert.strictEqual(
      userLookups,
      1,
      `expected exactly one /users/{login} call for two concurrent lookups of the same (case-insensitive) login, got ${userLookups}`,
    );
  });

  await test("two concurrent resolveLoginById() calls for the SAME id share exactly ONE /user/{id} lookup", async () => {
    let idLookups = 0;
    let releaseLookup;
    const gate = new Promise((r) => {
      releaseLookup = r;
    });
    global.fetch = async (url) => {
      if (url.includes("/user/777")) {
        idLookups += 1;
        await gate;
        return res(200, { login: "resolved-login" });
      }
      throw new Error(`unexpected call: ${url}`);
    };

    const p1 = resolveLoginById(777);
    const p2 = resolveLoginById(777);
    await tick();
    await tick();
    releaseLookup();
    const [login1, login2] = await Promise.all([p1, p2]);

    assert.strictEqual(login1, "resolved-login");
    assert.strictEqual(login2, "resolved-login");
    assert.strictEqual(
      idLookups,
      1,
      `expected exactly one /user/{id} call for two concurrent lookups of the same id, got ${idLookups}`,
    );
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error("SOME TESTS FAILED.");
  } else {
    console.log("ALL TESTS PASSED.");
  }
})();
