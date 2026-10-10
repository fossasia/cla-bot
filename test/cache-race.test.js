"use strict";
/** Tests that concurrent identity lookups share one request. */
const assert = require("assert");

process.env.GITHUB_TOKEN = "dummy";
process.env.GITHUB_REPOSITORY = "fossasia/testrepo";
process.env.SIG_OWNER = "fossasia";
process.env.SIG_REPO = "cla-signatures";
process.env.CLA_DOCUMENT_URL = "https://example.com/CLA.md";
process.env.ALLOWLIST = "";

const MODULE = "../src/cla-bot.js";
const { resolveUserIdByLogin, resolveLoginById, extractCoAuthors } = require(
  MODULE,
);

function freshModule() {
  delete require.cache[require.resolve(MODULE)];
  return require(MODULE);
}

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

function res(status, jsonBody) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (jsonBody === null ? "" : JSON.stringify(jsonBody)),
    headers: { get: () => null },
  };
}

// A gate every mocked request waits on. `open()` lets them all answer.
function makeGate() {
  let open;
  const opened = new Promise((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

// Lets every already-started caller run up to its first await.
const settle = () => new Promise((resolve) => setImmediate(resolve));

(async () => {
  // =========================================================================
  // resolveUserIdByLogin
  // =========================================================================
  await test("resolveUserIdByLogin: concurrent callers for the same login (any casing) share ONE request", async () => {
    const gate = makeGate();
    const requests = [];
    global.fetch = async (url) => {
      requests.push(url);
      await gate.opened;
      return res(200, { id: 4242, login: "Race-Alice" });
    };
    const pending = [
      resolveUserIdByLogin("Race-Alice"),
      resolveUserIdByLogin("race-alice"),
      resolveUserIdByLogin("RACE-ALICE"),
      resolveUserIdByLogin("Race-Alice"),
      resolveUserIdByLogin("race-alice"),
    ];
    await settle();
    gate.open();
    const results = await Promise.all(pending);
    assert.deepStrictEqual(results, [4242, 4242, 4242, 4242, 4242]);
    assert.strictEqual(
      requests.length,
      1,
      `expected exactly one GET /users/..., got ${requests.length}`,
    );
    // A call after the lookup has settled is still served from the cache.
    assert.strictEqual(await resolveUserIdByLogin("race-ALICE"), 4242);
    assert.strictEqual(requests.length, 1);
  });

  await test("resolveUserIdByLogin: concurrent callers for DIFFERENT logins each get their own request and their own answer", async () => {
    const gate = makeGate();
    const requests = [];
    global.fetch = async (url) => {
      requests.push(url);
      await gate.opened;
      if (url.endsWith("/users/race-bob")) return res(200, { id: 11 });
      if (url.endsWith("/users/race-carol")) return res(200, { id: 22 });
      throw new Error(`unexpected call: ${url}`);
    };
    const pending = [
      resolveUserIdByLogin("race-bob"),
      resolveUserIdByLogin("race-carol"),
      resolveUserIdByLogin("race-bob"),
      resolveUserIdByLogin("race-carol"),
    ];
    await settle();
    gate.open();
    assert.deepStrictEqual(await Promise.all(pending), [11, 22, 11, 22]);
    assert.strictEqual(requests.length, 2, "one request per distinct login");
  });

  await test("resolveUserIdByLogin: a concurrent 404 is shared too, and stays cached (negative caching is unchanged)", async () => {
    const gate = makeGate();
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      await gate.opened;
      return res(404, { message: "Not Found" });
    };
    const pending = [
      resolveUserIdByLogin("race-ghost"),
      resolveUserIdByLogin("race-ghost"),
      resolveUserIdByLogin("Race-Ghost"),
    ];
    await settle();
    gate.open();
    assert.deepStrictEqual(await Promise.all(pending), [null, null, null]);
    assert.strictEqual(calls, 1);
    assert.strictEqual(await resolveUserIdByLogin("race-ghost"), null);
    assert.strictEqual(calls, 1, "the unresolved result must stay cached");
  });

  await test("resolveUserIdByLogin: a network-level failure resolves every concurrent caller to null (never rejects) and is shared", async () => {
    const gate = makeGate();
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      await gate.opened;
      throw new TypeError("fetch failed"); // e.g. DNS failure - not a retried status
    };
    const pending = [
      resolveUserIdByLogin("race-offline"),
      resolveUserIdByLogin("race-offline"),
    ];
    await settle();
    gate.open();
    assert.deepStrictEqual(await Promise.all(pending), [null, null]);
    assert.strictEqual(calls, 1);
  });

  // =========================================================================
  // resolveLoginById
  // =========================================================================
  await test("resolveLoginById: concurrent callers for the same id share ONE request", async () => {
    const gate = makeGate();
    const requests = [];
    global.fetch = async (url) => {
      requests.push(url);
      await gate.opened;
      return res(200, { id: 777001, login: "race-dave" });
    };
    const pending = [
      resolveLoginById(777001),
      resolveLoginById(777001),
      resolveLoginById(777001),
      resolveLoginById(777001),
    ];
    await settle();
    gate.open();
    assert.deepStrictEqual(await Promise.all(pending), [
      "race-dave",
      "race-dave",
      "race-dave",
      "race-dave",
    ]);
    assert.strictEqual(
      requests.length,
      1,
      `expected exactly one GET /user/..., got ${requests.length}`,
    );
    assert.strictEqual(await resolveLoginById(777001), "race-dave");
    assert.strictEqual(requests.length, 1);
  });

  await test("resolveLoginById: concurrent callers for DIFFERENT ids each get their own request and their own answer", async () => {
    const gate = makeGate();
    const requests = [];
    global.fetch = async (url) => {
      requests.push(url);
      await gate.opened;
      if (url.endsWith("/user/777002")) return res(200, { login: "race-erin" });
      if (url.endsWith("/user/777003"))
        return res(200, { login: "race-frank" });
      throw new Error(`unexpected call: ${url}`);
    };
    const pending = [
      resolveLoginById(777002),
      resolveLoginById(777003),
      resolveLoginById(777002),
      resolveLoginById(777003),
    ];
    await settle();
    gate.open();
    assert.deepStrictEqual(await Promise.all(pending), [
      "race-erin",
      "race-frank",
      "race-erin",
      "race-frank",
    ]);
    assert.strictEqual(requests.length, 2, "one request per distinct id");
  });

  await test("resolveLoginById: a concurrent 404 is shared too, and stays cached", async () => {
    const gate = makeGate();
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      await gate.opened;
      return res(404, { message: "Not Found" });
    };
    const pending = [resolveLoginById(777004), resolveLoginById(777004)];
    await settle();
    gate.open();
    assert.deepStrictEqual(await Promise.all(pending), [null, null]);
    assert.strictEqual(calls, 1);
    assert.strictEqual(await resolveLoginById(777004), null);
    assert.strictEqual(calls, 1);
  });

  await test("resolveLoginById: a network-level failure resolves every concurrent caller to null (never rejects) and is shared", async () => {
    const gate = makeGate();
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      await gate.opened;
      throw new TypeError("fetch failed");
    };
    const pending = [resolveLoginById(777005), resolveLoginById(777005)];
    await settle();
    gate.open();
    assert.deepStrictEqual(await Promise.all(pending), [null, null]);
    assert.strictEqual(calls, 1);
  });

  // =========================================================================
  // The real call path: the same co-author in several commits resolved at
  // the same time (what a parallelized listPRCommitAuthors() would do).
  // =========================================================================
  await test("extractCoAuthors: the same co-authors across concurrently processed commits cost ONE lookup each", async () => {
    const gate = makeGate();
    const requests = [];
    global.fetch = async (url) => {
      requests.push(url);
      await gate.opened;
      if (url.endsWith("/user/888001")) return res(200, { login: "race-gina" });
      if (url.endsWith("/users/race-hank")) return res(200, { id: 888002 });
      throw new Error(`unexpected call: ${url}`);
    };
    const message =
      "Fix thing\n\n" +
      "Co-authored-by: Gina <888001+race-gina@users.noreply.github.com>\n" +
      "Co-authored-by: Hank <race-hank@users.noreply.github.com>\n";
    const pending = [
      extractCoAuthors(message),
      extractCoAuthors(message),
      extractCoAuthors(message),
    ];
    await settle();
    // Release the gate repeatedly: the second lookup (old-style login) only
    // starts after the first one resolves, within each call.
    gate.open();
    const results = await Promise.all(pending);
    for (const r of results) {
      assert.deepStrictEqual(r, {
        authors: [
          { id: 888001, login: "race-gina" },
          { id: 888002, login: "race-hank" },
        ],
        hasUnresolved: false,
      });
    }
    assert.strictEqual(
      requests.length,
      2,
      `expected one lookup per distinct co-author (2), got ${requests.length}: ${requests.join(", ")}`,
    );
  });

  // =========================================================================
  // resolveBotLogin (via getExistingBotComments / postComment) - fresh module
  // per scenario, because the cache is module-scope.
  // =========================================================================
  await test("resolveBotLogin: concurrent getExistingBotComments calls share ONE GET /user when it succeeds", async () => {
    const { getExistingBotComments } = freshModule();
    const gate = makeGate();
    let userCalls = 0;
    global.fetch = async (url) => {
      if (url.endsWith("/user")) {
        userCalls += 1;
        await gate.opened;
        return res(200, { login: "race-custom-bot[bot]" });
      }
      if (url.includes("/issues/1/comments")) {
        return res(200, [
          {
            id: 1,
            user: { login: "race-custom-bot[bot]" },
            body: "<!-- fossasia-cla-bot:v1 -->\nmine",
          },
          {
            id: 2,
            user: { login: "github-actions[bot]" },
            body: "<!-- fossasia-cla-bot:v1 -->\nnot-mine",
          },
        ]);
      }
      throw new Error(`unexpected call: ${url}`);
    };
    const pending = [
      getExistingBotComments(1),
      getExistingBotComments(1),
      getExistingBotComments(1),
    ];
    await settle();
    gate.open();
    const results = await Promise.all(pending);
    assert.strictEqual(
      userCalls,
      1,
      `expected one GET /user, got ${userCalls}`,
    );
    for (const r of results) {
      assert.deepStrictEqual(
        r.map((c) => c.id),
        [1],
        "every caller must filter against the SAME resolved identity",
      );
    }
  });

  await test("resolveBotLogin: concurrent callers share ONE GET /user when it fails, and all fall back to the default login", async () => {
    const { getExistingBotComments } = freshModule();
    const gate = makeGate();
    let userCalls = 0;
    global.fetch = async (url) => {
      if (url.endsWith("/user")) {
        userCalls += 1;
        await gate.opened;
        return res(403, { message: "Resource not accessible by integration" });
      }
      if (url.includes("/issues/1/comments")) {
        return res(200, [
          {
            id: 1,
            user: { login: "github-actions[bot]" },
            body: "<!-- fossasia-cla-bot:v1 -->\nmine",
          },
        ]);
      }
      throw new Error(`unexpected call: ${url}`);
    };
    const pending = [getExistingBotComments(1), getExistingBotComments(1)];
    await settle();
    gate.open();
    const results = await Promise.all(pending);
    assert.strictEqual(userCalls, 1);
    assert.deepStrictEqual(
      results.map((r) => r.map((c) => c.id)),
      [[1], [1]],
    );
    // Later calls reuse the settled fallback - still no second GET /user.
    await getExistingBotComments(1);
    assert.strictEqual(userCalls, 1);
  });

  await test("resolveBotLogin: concurrent postComment calls (different bodies) share ONE GET /user", async () => {
    const { postComment } = freshModule();
    const gate = makeGate();
    let userCalls = 0;
    const posted = [];
    global.fetch = async (url, opts = {}) => {
      const method = opts.method || "GET";
      if (url.endsWith("/user")) {
        userCalls += 1;
        await gate.opened;
        return res(401, { message: "Bad credentials" });
      }
      if (url.includes("/issues/1/comments") && method === "GET") {
        return res(200, []);
      }
      if (url.includes("/issues/1/comments") && method === "POST") {
        const body = JSON.parse(opts.body).body;
        posted.push(body);
        return res(201, { id: posted.length, body });
      }
      throw new Error(`unexpected call: ${method} ${url}`);
    };
    const pending = [
      postComment(1, "first-body"),
      postComment(1, "second-body"),
    ];
    await settle();
    gate.open();
    await Promise.all(pending);
    assert.strictEqual(
      userCalls,
      1,
      `expected one GET /user, got ${userCalls}`,
    );
    assert.strictEqual(posted.length, 2, "both different comments are posted");
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error("\nSOME TESTS FAILED.");
    process.exit(1);
  } else {
    console.log("ALL TESTS PASSED.");
  }
})();
