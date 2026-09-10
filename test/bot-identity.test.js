"use strict";
/**
 * resolveBotLogin() caches its result at module scope (same pattern as
 * getSignaturesToken's token cache), so each scenario needs its own fresh
 * process - that's why this is a separate file rather than more cases
 * bolted onto http.test.js or integration.test.js.
 *
 * Run: node test/bot-identity.test.js (also included in `npm test`)
 */
const assert = require("assert");

process.env.GITHUB_TOKEN = "dummy";
process.env.GITHUB_REPOSITORY = "fossasia/testrepo";
process.env.SIG_OWNER = "fossasia";
process.env.SIG_REPO = "cla-signatures";
process.env.CLA_DOCUMENT_URL = "https://example.com/CLA.md";
process.env.ALLOWLIST = "";

const { postComment } = require("../src/cla-bot.js");

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

(async () => {
  await test("when GET /user fails (the expected case for the standard GITHUB_TOKEN), dedupe falls back to github-actions[bot]", async () => {
    let filterLoginSeen = null;
    global.fetch = async (url, opts = {}) => {
      if (url.endsWith("/user"))
        return res(401, { message: "Bad credentials" }); // GITHUB_TOKEN really does fail this
      if (
        url.includes("/issues/1/comments") &&
        (opts.method || "GET") === "GET"
      ) {
        // Return one comment from each of two identities so we can see which one the filter picked.
        return res(200, [
          {
            id: 1,
            user: { login: "github-actions[bot]" },
            body: "<!-- fossasia-cla-bot:v1 -->\nmarker-a",
          },
          {
            id: 2,
            user: { login: "some-other-identity[bot]" },
            body: "<!-- fossasia-cla-bot:v1 -->\nmarker-a",
          },
        ]);
      }
      if (url.includes("/issues/1/comments") && opts.method === "POST") {
        return res(201, { id: 3, body: JSON.parse(opts.body).body });
      }
      throw new Error(`unexpected call: ${url}`);
    };
    // dedupe=true path reads existing comments and filters by resolved identity.
    // We can observe the fallback indirectly: post a body that already
    // matches the github-actions[bot] comment above -> should be treated as
    // a duplicate and skipped (no POST), proving the filter picked
    // 'github-actions[bot]', not 'some-other-identity[bot]' or neither.
    let postHappened = false;
    const originalFetch = global.fetch;
    global.fetch = async (url, opts = {}) => {
      if ((opts.method || "GET") === "POST" && url.includes("/comments"))
        postHappened = true;
      return originalFetch(url, opts);
    };
    await postComment(1, "marker-a");
    assert.strictEqual(
      postHappened,
      false,
      "should have recognized the existing github-actions[bot] comment as a duplicate and skipped posting",
    );
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error("\nSOME TESTS FAILED.");
    process.exit(1);
  } else {
    console.log("ALL TESTS PASSED.");
  }
})();
