"use strict";
/**
 * Regression coverage for: getExistingBotComments() used to filter strictly
 * to the CURRENTLY resolved bot identity (resolveBotLogin()). A consumer
 * that switches GITHUB_TOKEN from the default Actions token to a PAT or a
 * separate GitHub App installation token (or back) mid-flight would then
 * have every comment posted under the OLD identity silently excluded from
 * checkPR's "was this PR ever genuinely blocked" history check. A PR
 * blocked before the switch would look like it was never flagged once the
 * identity changed, and its recovery announcement ("All contributors have
 * signed the CLA. ✅") would be wrongly suppressed - even though nothing
 * about the PR itself changed, only which credential the automation runs
 * under.
 *
 * resolveBotLogin() caches its result at module scope for the life of the
 * process (same pattern as getSignaturesToken's token cache and the other
 * bot-identity*.test.js files), so this needs its own fresh process rather
 * than more cases bolted onto integration.test.js.
 *
 * Run: node test/bot-identity-recovery.test.js (also included in `npm test`)
 */
const assert = require("assert");

process.env.GITHUB_TOKEN = "a-pat-not-the-actions-token";
process.env.GITHUB_REPOSITORY = "fossasia/testrepo";
process.env.SIG_OWNER = "fossasia";
process.env.SIG_REPO = "cla-signatures";
process.env.CLA_DOCUMENT_URL = "https://example.com/CLA.md";
process.env.ALLOWLIST = "";

const { handlePullRequestTarget } = require("../src/cla-bot.js");

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
function b64(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

(async () => {
  await test("a PR blocked under an OLD bot identity still gets its recovery announced after GITHUB_TOKEN is switched to a different (PAT/App) identity", async () => {
    // This process resolves the bot identity to "new-custom-bot[bot]" (the
    // PAT/App token now in use) - simulating that the switch already
    // happened before this run.
    const state = {
      signatures: {
        version: 1,
        signatures: [{ id: 1, login: "alice" }], // alice already signed
      },
      sha: "sig-sha-0",
      comments: [
        // Seeded exactly as the OLD identity would have posted it, back
        // before the token was switched: same PENDING_MARKER/wording this
        // fixed version writes, but authored by a different bot login.
        {
          id: 1,
          user: { login: "github-actions[bot]", type: "Bot" },
          body:
            "<!-- fossasia-cla-bot:v1 -->\n<!-- fossasia-cla-bot:pending -->\n" +
            "The following contributor(s) need to sign our [CLA](https://example.com/CLA.md) before this PR can be merged:\n\n" +
            "- @alice",
        },
      ],
      statuses: [],
    };
    const commits = [
      {
        sha: "c1",
        author: { id: 1, login: "alice" },
        parents: [{ sha: "p1" }],
        commit: { author: { email: "alice@example.com" } },
      },
    ];

    global.fetch = async (url, opts = {}) => {
      const method = (opts.method || "GET").toUpperCase();
      if (url.endsWith("/user")) {
        return res(200, { login: "new-custom-bot[bot]", type: "Bot" });
      }
      if (url.includes("/pulls/1/commits")) return res(200, commits);
      if (url.includes("/contents/signatures/cla.json") && method === "GET") {
        return res(200, {
          sha: state.sha,
          content: b64(state.signatures),
          encoding: "base64",
        });
      }
      if (url.includes("/issues/1/comments")) {
        if (method === "GET") return res(200, state.comments);
        if (method === "POST") {
          const { body } = JSON.parse(opts.body);
          const c = {
            id: state.comments.length + 1,
            body,
            // New comments are posted under the NEW (currently resolved)
            // identity, as they always would be.
            user: { login: "new-custom-bot[bot]", type: "Bot" },
          };
          state.comments.push(c);
          return res(201, c);
        }
      }
      if (url.includes("/issues/comments/") && method === "DELETE") {
        const id = Number(url.split("/issues/comments/")[1]);
        state.comments = state.comments.filter((c) => c.id !== id);
        return res(204, null);
      }
      if (url.includes("/statuses/")) {
        state.statuses.push(JSON.parse(opts.body));
        return res(201, {});
      }
      throw new Error(`unexpected call: ${method} ${url}`);
    };

    // Alice was already signed before this run even started (e.g. she
    // signed under the old identity, or her signature predates this PR
    // entirely) - the PR is fully compliant. This is the automatic,
    // quiet-by-default pull_request_target trigger.
    await handlePullRequestTarget({
      action: "synchronize",
      pull_request: { number: 1, head: { sha: "head-sha" } },
    });

    assert.strictEqual(
      state.statuses[state.statuses.length - 1].state,
      "success",
    );
    assert.strictEqual(
      state.comments.length,
      2,
      "the PR's recovery must still be announced - the old identity's " +
        "'needs to sign' comment must be recognized as a genuine past " +
        "block despite being authored by a different bot login",
    );
    assert.ok(
      state.comments[1].body.includes("All contributors have signed"),
      "the new comment must be the success announcement",
    );
  });

  await test("a comment forged by an ordinary user (not a Bot-type account) is still never mistaken for real bot history, even under the broadened cross-identity check", async () => {
    const state = {
      signatures: { version: 1, signatures: [{ id: 1, login: "alice" }] },
      sha: "sig-sha-0",
      comments: [
        // A regular contributor's comment, crafted to look exactly like a
        // genuine "needs to sign" comment, including the literal marker
        // text - but their account is an ordinary user, not a Bot.
        {
          id: 1,
          user: { login: "a-regular-user" }, // no `type: "Bot"` - GitHub itself decides this, not spoofable
          body:
            "<!-- fossasia-cla-bot:v1 -->\n<!-- fossasia-cla-bot:pending -->\n" +
            "The following contributor(s) need to sign our [CLA](https://example.com/CLA.md) before this PR can be merged:\n\n" +
            "- @alice",
        },
      ],
      statuses: [],
    };
    const commits = [
      {
        sha: "c1",
        author: { id: 1, login: "alice" },
        parents: [{ sha: "p1" }],
        commit: { author: { email: "alice@example.com" } },
      },
    ];

    global.fetch = async (url, opts = {}) => {
      const method = (opts.method || "GET").toUpperCase();
      if (url.endsWith("/user")) {
        return res(200, { login: "new-custom-bot[bot]", type: "Bot" });
      }
      if (url.includes("/pulls/1/commits")) return res(200, commits);
      if (url.includes("/contents/signatures/cla.json") && method === "GET") {
        return res(200, {
          sha: state.sha,
          content: b64(state.signatures),
          encoding: "base64",
        });
      }
      if (url.includes("/issues/1/comments")) {
        if (method === "GET") return res(200, state.comments);
        if (method === "POST") {
          const { body } = JSON.parse(opts.body);
          const c = {
            id: state.comments.length + 1,
            body,
            user: { login: "new-custom-bot[bot]", type: "Bot" },
          };
          state.comments.push(c);
          return res(201, c);
        }
      }
      if (url.includes("/issues/comments/") && method === "DELETE") {
        const id = Number(url.split("/issues/comments/")[1]);
        state.comments = state.comments.filter((c) => c.id !== id);
        return res(204, null);
      }
      if (url.includes("/statuses/")) {
        state.statuses.push(JSON.parse(opts.body));
        return res(201, {});
      }
      throw new Error(`unexpected call: ${method} ${url}`);
    };

    await handlePullRequestTarget({
      action: "opened",
      pull_request: { number: 1, head: { sha: "head-sha" } },
    });

    assert.strictEqual(
      state.statuses[state.statuses.length - 1].state,
      "success",
    );
    assert.strictEqual(
      state.comments.length,
      1,
      "a forged, non-Bot-type comment must NOT count as real block history - the PR must stay quiet, exactly as if it had never been blocked at all",
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
