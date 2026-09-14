"use strict";
/**
 * Regression coverage for: checkPR()'s per-signer personalized completion
 * message (personalSuccessMessage(), replacing the generic "All
 * contributors have signed the CLA. ✅" announcement whenever the person who
 * just signed via a comment is the one who completed the PR's requirement)
 * must NOT credit an allowlisted account with "completing" a PR - allowlisted
 * authors are excluded from `missing` regardless of their signature status
 * (see isAllowlisted() in checkPR's `missing` filter), so their signing never
 * actually blocked anything to begin with.
 *
 * This is deliberately a full, real handleIssueComment -> checkPR run
 * against a mocked fetch, NOT just a direct call to the extracted
 * signerCompletedRequirement() helper (that gets its own unit coverage in
 * test/logic.test.js) - a unit test of the helper in isolation would stay
 * green even if checkPR's actual call site stopped using it (e.g. someone
 * "simplifies" checkPR back down to `signer ? personalSuccessMessage(...) :
 * SUCCESS_MESSAGE` and drops the allowlist gate entirely). Only exercising
 * the real orchestration proves the gate is actually wired in.
 *
 * ALLOWLIST is read into a module-scope const at require time (see
 * src/cla-bot.js), and test/integration.test.js already fixes it to ""
 * for its entire process - so, like the bot-identity*.test.js files (which
 * need their own GITHUB_TOKEN/env), this needs its own fresh process with a
 * real, non-empty ALLOWLIST rather than a case bolted onto
 * integration.test.js.
 *
 * Run: node test/allowlist-signer-credit.test.js (also included in `npm test`)
 */
const assert = require("assert");

process.env.GITHUB_TOKEN = "dummy-token";
process.env.GITHUB_REPOSITORY = "fossasia/testrepo";
process.env.SIG_OWNER = "fossasia";
process.env.SIG_REPO = "cla-signatures";
process.env.SIG_PATH = "signatures/cla.json";
process.env.CLA_DOCUMENT_URL = "https://example.com/CLA.md";
process.env.ALLOWLIST = "ci-bot[bot],renovate[bot]";

const { handleIssueComment } = require("../src/cla-bot.js");

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
  await test("an allowlisted commit author signing the CLA via a comment gets the GENERIC success message through the real checkPR/handleIssueComment flow, not personalized completion credit", async () => {
    // ci-bot[bot] is the PR's ONLY commit author, and is on the allowlist -
    // so it was never actually blocking this PR (isAllowlisted() excludes
    // it from `missing` regardless of whether it's ever signed anything).
    // It then comments the sign phrase itself (plausible for an automation
    // account run once to tidy up its own signature record, or simply
    // triggered by mistake) - its signature gets recorded for real, but
    // must not be credited with "completing" a PR its own status never
    // blocked.
    const state = {
      signatures: { version: 1, signatures: [] },
      sha: "sig-sha-0",
      comments: [],
      statuses: [],
    };
    const commits = [
      {
        sha: "c1",
        author: { id: 555, login: "ci-bot[bot]" },
        parents: [{ sha: "p1" }],
        commit: { author: { email: "ci-bot@example.com" } },
      },
    ];

    global.fetch = async (url, opts = {}) => {
      const method = (opts.method || "GET").toUpperCase();
      // No explicit handler for bare /user (bot-identity resolution) -
      // left unhandled on purpose, same as test/integration.test.js: the
      // resulting throw is swallowed by resolveBotLogin()'s own try/catch,
      // which falls back to DEFAULT_BOT_LOGIN ("github-actions[bot]") -
      // exactly matching the login the POST handler below attributes new
      // comments to.
      if (url.includes("/pulls/1/commits")) return res(200, commits);
      if (url.includes("/pulls/1") && !url.includes("/commits")) {
        return res(200, { head: { sha: "head-sha-abc" } });
      }
      if (url.includes("/contents/signatures/cla.json")) {
        if (method === "GET") {
          return res(200, {
            sha: state.sha,
            content: b64(state.signatures),
            encoding: "base64",
          });
        }
        if (method === "PUT") {
          const body = JSON.parse(opts.body);
          state.signatures = JSON.parse(
            Buffer.from(body.content, "base64").toString(),
          );
          state.sha = `sig-sha-${Number(state.sha.split("-").pop()) + 1}`;
          return res(200, { content: { sha: state.sha } });
        }
      }
      if (url.includes("/issues/1/comments")) {
        if (method === "GET") return res(200, state.comments);
        if (method === "POST") {
          const { body } = JSON.parse(opts.body);
          const c = {
            id: state.comments.length + 1,
            body,
            user: { login: "github-actions[bot]" },
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
      throw new Error(`Unhandled mock request: ${method} ${url}`);
    };

    await handleIssueComment({
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "ci-bot[bot]" } },
      comment: {
        user: { id: 555, login: "ci-bot[bot]" },
        body: "I have read the CLA Document and I hereby sign the CLA",
        html_url: "x",
        author_association: "NONE",
      },
    });

    assert.strictEqual(
      state.statuses[state.statuses.length - 1].state,
      "success",
    );
    assert.strictEqual(state.comments.length, 1);
    assert.ok(
      state.comments[0].body.includes("All contributors have signed"),
      `expected the generic success announcement, got: ${state.comments[0].body}`,
    );
    assert.ok(
      !state.comments[0].body.includes("@ci-bot[bot]"),
      "an allowlisted account was never actually blocking this PR, so checkPR's real success path must not personally credit it with completing that PR",
    );

    // The signature is still genuinely recorded, though - this is about
    // withholding undue CREDIT for completing a PR, not about refusing to
    // record a real signature.
    assert.ok(
      state.signatures.signatures.some(
        (s) => s.id === 555 && s.login === "ci-bot[bot]",
      ),
    );
  });

  await test("sanity check: a NON-allowlisted sole commit author signing via the same real flow DOES get personalized completion credit", async () => {
    // Same exact flow, minus the allowlist membership - confirms the two
    // tests in this file are actually exercising the branch they claim to
    // (i.e. this file isn't just always emitting the generic message
    // regardless of allowlist status for some unrelated reason).
    const state = {
      signatures: { version: 1, signatures: [] },
      sha: "sig-sha-0",
      comments: [],
      statuses: [],
    };
    const commits = [
      {
        sha: "c1",
        author: { id: 556, login: "alice" },
        parents: [{ sha: "p1" }],
        commit: { author: { email: "alice@example.com" } },
      },
    ];

    global.fetch = async (url, opts = {}) => {
      const method = (opts.method || "GET").toUpperCase();
      if (url.includes("/pulls/1/commits")) return res(200, commits);
      if (url.includes("/pulls/1") && !url.includes("/commits")) {
        return res(200, { head: { sha: "head-sha-abc" } });
      }
      if (url.includes("/contents/signatures/cla.json")) {
        if (method === "GET") {
          return res(200, {
            sha: state.sha,
            content: b64(state.signatures),
            encoding: "base64",
          });
        }
        if (method === "PUT") {
          const body = JSON.parse(opts.body);
          state.signatures = JSON.parse(
            Buffer.from(body.content, "base64").toString(),
          );
          state.sha = `sig-sha-${Number(state.sha.split("-").pop()) + 1}`;
          return res(200, { content: { sha: state.sha } });
        }
      }
      if (url.includes("/issues/1/comments")) {
        if (method === "GET") return res(200, state.comments);
        if (method === "POST") {
          const { body } = JSON.parse(opts.body);
          const c = {
            id: state.comments.length + 1,
            body,
            user: { login: "github-actions[bot]" },
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
      throw new Error(`Unhandled mock request: ${method} ${url}`);
    };

    await handleIssueComment({
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "alice" } },
      comment: {
        user: { id: 556, login: "alice" },
        body: "I have read the CLA Document and I hereby sign the CLA",
        html_url: "x",
        author_association: "NONE",
      },
    });

    assert.strictEqual(
      state.statuses[state.statuses.length - 1].state,
      "success",
    );
    assert.strictEqual(state.comments.length, 1);
    assert.ok(
      state.comments[0].body.includes("@alice Thank you for signing the CLA"),
    );
    assert.ok(!state.comments[0].body.includes("All contributors have signed"));
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error("\nSOME TESTS FAILED.");
    process.exit(1);
  } else {
    console.log("ALL TESTS PASSED.");
  }
})();
