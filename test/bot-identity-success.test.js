"use strict";
/**
 * Companion to bot-identity.test.js covers the opposite branch (GET /user
 * succeeding, e.g. because a PAT was passed instead of the standard
 * GITHUB_TOKEN). Kept in its own file for the same reason: resolveBotLogin()
 * caches its result at module scope for the life of the process.
 *
 * Run: node test/bot-identity-success.test.js (also included in `npm test`)
 */
const assert = require("assert");

process.env.GITHUB_TOKEN = "a-pat-not-the-actions-token";
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
  await test("when GET /user succeeds (e.g. a PAT was supplied), dedupe uses the real authenticated identity instead of the hardcoded default", async () => {
    global.fetch = async (url, opts = {}) => {
      if (url.endsWith("/user"))
        return res(200, { login: "a-custom-app-bot[bot]" });
      if (
        url.includes("/issues/1/comments") &&
        (opts.method || "GET") === "GET"
      ) {
        return res(200, [
          // Only the default identity has a matching comment here - if the
          // code were still using the hardcoded default instead of the
          // resolved one, this would look like a duplicate and get skipped.
          {
            id: 1,
            user: { login: "github-actions[bot]" },
            body: "<!-- fossasia-cla-bot:v1 -->\nmarker-b",
          },
        ]);
      }
      if (url.includes("/issues/1/comments") && opts.method === "POST") {
        return res(201, {
          id: 2,
          body: JSON.parse(opts.body).body,
          user: { login: "a-custom-app-bot[bot]" },
        });
      }
      if (url.includes("/issues/comments/")) return res(204, null); // cleanup delete, if any
      throw new Error(`unexpected call: ${url}`);
    };

    let postHappened = false;
    const originalFetch = global.fetch;
    global.fetch = async (url, opts = {}) => {
      if ((opts.method || "GET") === "POST" && url.includes("/comments"))
        postHappened = true;
      return originalFetch(url, opts);
    };

    await postComment(1, "marker-b");
    assert.strictEqual(
      postHappened,
      true,
      "should NOT have matched the github-actions[bot] comment as a duplicate - the real identity is a-custom-app-bot[bot], so this must be treated as new",
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
