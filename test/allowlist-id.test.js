"use strict";
/**
 * Regression coverage for: the allowlist used to be keyed on the (mutable,
 * reusable) login only, unlike the signature store which is keyed on the
 * immutable numeric account id. If an allowlisted login was ever released and
 * claimed by someone else, the new owner silently inherited the exemption.
 *
 * The allowlist now holds numeric account ids ONLY, matched against the id
 * GitHub itself reported for each commit author. These tests
 * drive the REAL handlePullRequestTarget -> checkPR -> listPRCommitAuthors
 * orchestration against a mocked fetch (not just the isAllowlisted() helper,
 * which has its own unit tests in test/logic.test.js) so they fail if
 * checkPR's call sites ever stop passing the full { id, login } identity.
 *
 * ALLOWLIST is parsed into a module-scope const at require time, so every
 * scenario loads a fresh copy of the module with its own ALLOWLIST value.
 *
 * Run: node test/allowlist-id.test.js (also included in `npm test`)
 */
const assert = require("assert");

process.env.GITHUB_TOKEN = "dummy-token";
process.env.GITHUB_REPOSITORY = "fossasia/testrepo";
process.env.SIG_OWNER = "fossasia";
process.env.SIG_REPO = "cla-signatures";
process.env.SIG_PATH = "signatures/cla.json";
process.env.CLA_DOCUMENT_URL = "https://example.com/CLA.md";

const MODULE = require.resolve("../src/cla-bot.js");

function loadBot(allowlist) {
  process.env.ALLOWLIST = allowlist;
  delete require.cache[MODULE];
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
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64");

// One mocked GitHub for a single PR (#1). `usersById` backs GET /user/{id}
// (used to authoritatively resolve co-author trailers).
function installMockGitHub({ commits, signatures = [], usersById = {} }) {
  const state = {
    signatures: { version: 1, signatures },
    comments: [],
    statuses: [],
  };
  global.fetch = async (url, opts = {}) => {
    const method = (opts.method || "GET").toUpperCase();
    const { pathname } = new URL(url);
    const userById = pathname.match(/^\/user\/(\d+)$/);
    if (userById) {
      const u = usersById[userById[1]];
      return u ? res(200, u) : res(404, { message: "Not Found" });
    }
    if (pathname.endsWith("/pulls/1/commits")) return res(200, commits);
    if (pathname.endsWith("/pulls/1")) {
      return res(200, { head: { sha: "head-sha-abc" } });
    }
    if (pathname.includes("/contents/signatures/cla.json")) {
      if (method === "GET") {
        return res(200, {
          sha: "sig-sha-0",
          content: b64(state.signatures),
          encoding: "base64",
        });
      }
      throw new Error(`Unexpected signature-store write: ${method}`);
    }
    if (pathname.endsWith("/issues/1/comments")) {
      if (method === "GET") return res(200, state.comments);
      if (method === "POST") {
        const c = {
          id: state.comments.length + 1,
          body: JSON.parse(opts.body).body,
          user: { login: "github-actions[bot]" },
        };
        state.comments.push(c);
        return res(201, c);
      }
    }
    if (pathname.includes("/statuses/")) {
      state.statuses.push(JSON.parse(opts.body));
      return res(201, {});
    }
    // Bare GET /user (bot identity) is left unhandled on purpose, same as the
    // other suites: resolveBotLogin() swallows it and falls back to the
    // default github-actions[bot].
    throw new Error(`Unhandled mock request: ${method} ${url}`);
  };
  return state;
}

const commitBy = (id, login, message = "change") => ({
  sha: `sha-${id}`,
  author: { id, login },
  committer: { id, login },
  parents: [{ sha: "p" }],
  commit: { message },
});

const runAutomaticCheck = (bot) =>
  bot.handlePullRequestTarget({
    action: "opened",
    pull_request: { number: 1, head: { sha: "head-sha-abc" } },
  });

const lastStatus = (state) => state.statuses[state.statuses.length - 1];

(async () => {
  await test("an author on the id allowlist passes with NO signature on file and no comment", async () => {
    const bot = loadBot("4242");
    const state = installMockGitHub({
      commits: [commitBy(4242, "trusted-user")],
    });
    await runAutomaticCheck(bot);
    assert.strictEqual(lastStatus(state).state, "success");
    assert.strictEqual(state.comments.length, 0);
  });

  await test("an allowlisted account that RENAMED is still exempt (the id is what matters)", async () => {
    const bot = loadBot("4242");
    const state = installMockGitHub({
      commits: [commitBy(4242, "brand-new-name")],
    });
    await runAutomaticCheck(bot);
    assert.strictEqual(lastStatus(state).state, "success");
  });

  await test("LOGIN REUSE: a different account holding the previously allowlisted login is NOT exempt and is asked to sign", async () => {
    const bot = loadBot("4242");
    const state = installMockGitHub({
      commits: [commitBy(9999, "trusted-user")],
    });
    await runAutomaticCheck(bot);
    assert.strictEqual(lastStatus(state).state, "failure");
    assert.strictEqual(state.comments.length, 1);
    assert.ok(state.comments[0].body.includes("- @trusted-user"));
  });

  await test("an empty allowlist exempts nobody", async () => {
    const bot = loadBot("");
    const state = installMockGitHub({
      commits: [commitBy(4242, "trusted-user")],
    });
    await runAutomaticCheck(bot);
    assert.strictEqual(lastStatus(state).state, "failure");
  });

  await test("several ids (comma + newline separated) are all honored; non-listed co-authors still must sign", async () => {
    const bot = loadBot("4242,\n4243");
    const state = installMockGitHub({
      commits: [commitBy(4242, "a"), commitBy(4243, "b"), commitBy(8, "bob")],
    });
    await runAutomaticCheck(bot);
    assert.strictEqual(lastStatus(state).state, "failure");
    assert.ok(state.comments[0].body.includes("- @bob"));
    assert.ok(
      !state.comments[0].body.includes("@a") &&
        !state.comments[0].body.includes("- @b\n"),
    );
  });

  await test("an allowlisted co-author (id resolved from GitHub, not trusted from the trailer's login text) is exempt", async () => {
    const bot = loadBot("4242");
    const state = installMockGitHub({
      commits: [
        commitBy(
          7,
          "alice",
          "msg\n\nCo-authored-by: Whatever <4242+totally-fake-login@users.noreply.github.com>",
        ),
      ],
      signatures: [{ id: 7, login: "alice" }],
      usersById: { 4242: { id: 4242, login: "real-trusted-user" } },
    });
    await runAutomaticCheck(bot);
    assert.strictEqual(lastStatus(state).state, "success");
  });

  await test("a co-author trailer using the allowlisted LOGIN with a different id gains nothing", async () => {
    const bot = loadBot("4242");
    const state = installMockGitHub({
      commits: [
        commitBy(
          7,
          "alice",
          "msg\n\nCo-authored-by: X <9999+trusted-user@users.noreply.github.com>",
        ),
      ],
      signatures: [{ id: 7, login: "alice" }],
      usersById: { 9999: { id: 9999, login: "trusted-user" } },
    });
    await runAutomaticCheck(bot);
    assert.strictEqual(lastStatus(state).state, "failure");
    assert.ok(state.comments[0].body.includes("- @trusted-user"));
  });

  await test("a stored signature WITHOUT an id never clears anyone, even for the same login (no login fallback)", async () => {
    const bot = loadBot("");
    const state = installMockGitHub({
      commits: [commitBy(5, "mona")],
      signatures: [{ login: "mona" }],
    });
    await runAutomaticCheck(bot);
    assert.strictEqual(lastStatus(state).state, "failure");
  });

  await test("an allowlisted-by-id account signing the CLA gets the generic success message, not personalized completion credit", async () => {
    const bot = loadBot("4242");
    const state = installMockGitHub({
      commits: [commitBy(4242, "renamed-trusted")],
    });
    const base = global.fetch;
    global.fetch = async (url, opts = {}) => {
      const { pathname } = new URL(url);
      if (
        (opts.method || "GET").toUpperCase() === "PUT" &&
        pathname.includes("/contents/signatures/cla.json")
      ) {
        state.signatures = JSON.parse(
          Buffer.from(JSON.parse(opts.body).content, "base64").toString(),
        );
        return res(200, { content: { sha: "sig-sha-1" } });
      }
      return base(url, opts);
    };
    await bot.handleIssueComment({
      action: "created",
      issue: {
        number: 1,
        pull_request: {},
        user: { login: "renamed-trusted" },
      },
      comment: {
        user: { id: 4242, login: "renamed-trusted" },
        body: "I have read the CLA Document and I hereby sign the CLA",
        html_url: "x",
        author_association: "NONE",
      },
    });
    assert.strictEqual(lastStatus(state).state, "success");
    assert.strictEqual(state.comments.length, 1);
    assert.ok(state.comments[0].body.includes("All contributors have signed"));
    assert.ok(!state.comments[0].body.includes("@renamed-trusted"));
  });

  // --- the well-known automation accounts (real GitHub account ids) --------
  const BOTS = {
    "github-actions[bot]": 41898282,
    "dependabot[bot]": 49699333,
    "renovate[bot]": 29139614,
  };
  const BOT_ALLOWLIST = Object.values(BOTS).join(",");

  await test("github-actions[bot], dependabot[bot] and renovate[bot] (by their real ids) are all exempt, with no signature on file", async () => {
    const bot = loadBot(BOT_ALLOWLIST);
    for (const [login, id] of Object.entries(BOTS)) {
      const state = installMockGitHub({ commits: [commitBy(id, login)] });
      await runAutomaticCheck(bot);
      assert.strictEqual(lastStatus(state).state, "success", login);
      assert.strictEqual(state.comments.length, 0, login);
    }
  });

  await test("a PR mixing github-actions[bot] commits with a human who has not signed still fails, naming only the human", async () => {
    const bot = loadBot(BOT_ALLOWLIST);
    const state = installMockGitHub({
      commits: [
        commitBy(BOTS["github-actions[bot]"], "github-actions[bot]"),
        commitBy(8, "bob"),
      ],
    });
    await runAutomaticCheck(bot);
    assert.strictEqual(lastStatus(state).state, "failure");
    assert.ok(state.comments[0].body.includes("- @bob"));
    assert.ok(!state.comments[0].body.includes("github-actions[bot]"));
  });

  await test("a different account whose login is 'github-actions[bot]' (id mismatch) is NOT exempt", async () => {
    const bot = loadBot(BOT_ALLOWLIST);
    const state = installMockGitHub({
      commits: [commitBy(5, "github-actions[bot]")],
    });
    await runAutomaticCheck(bot);
    assert.strictEqual(lastStatus(state).state, "failure");
  });

  // GitHub attributes a commit's AUTHOR to an account purely by the git
  // email, and `ID+name@users.noreply.github.com` is public - so anyone can
  // forge a commit that GitHub shows as authored by an allowlisted bot. The
  // pre-existing REQUIRE_VERIFIED_COMMITS hardening is what closes this: it
  // only trusts the author when that same account is the verified committer.
  const forgedBotCommit = {
    sha: "forged",
    author: { id: BOTS["github-actions[bot]"], login: "github-actions[bot]" },
    committer: { id: 9999, login: "mallory" },
    parents: [{ sha: "p" }],
    commit: { message: "x", verification: { verified: true } },
  };

  await test("DOCUMENTED RISK (default): a commit forged to look authored by an allowlisted bot is exempt unless require-verified-commits is on", async () => {
    delete process.env.REQUIRE_VERIFIED_COMMITS;
    const bot = loadBot(BOT_ALLOWLIST);
    const state = installMockGitHub({ commits: [forgedBotCommit] });
    await runAutomaticCheck(bot);
    assert.strictEqual(lastStatus(state).state, "success");
  });

  await test("require-verified-commits=true flags that forged bot-authored commit for manual review instead of exempting it", async () => {
    process.env.REQUIRE_VERIFIED_COMMITS = "true";
    try {
      const bot = loadBot(BOT_ALLOWLIST);
      const state = installMockGitHub({ commits: [forgedBotCommit] });
      await runAutomaticCheck(bot);
      assert.strictEqual(lastStatus(state).state, "failure");
      assert.ok(
        state.comments[0].body.includes(
          "could not be automatically attributed",
        ),
      );
    } finally {
      delete process.env.REQUIRE_VERIFIED_COMMITS;
    }
  });

  // The example workflow is what people copy-paste: it must always ship an
  // allowlist the bot itself accepts (an invalid entry fails the run), and it
  // must cover github-actions[bot].
  await test("examples/consumer-workflow.yml ships a valid allowlist that includes github-actions[bot]", async () => {
    const yaml = require("js-yaml");
    const fs = require("fs");
    const path = require("path");
    const wf = yaml.load(
      fs.readFileSync(
        path.join(__dirname, "..", "examples", "consumer-workflow.yml"),
        "utf8",
      ),
    );
    const steps = Object.values(wf.jobs).flatMap((j) => j.steps || []);
    const step = steps.find(
      (st) =>
        typeof st.uses === "string" && st.uses.startsWith("fossasia/cla-bot@"),
    );
    assert.ok(step, "example workflow must contain the cla-bot step");
    const { ids, invalid } = loadBot("").parseAllowlist(step.with.allowlist);
    assert.deepStrictEqual(invalid, []);
    for (const id of Object.values(BOTS))
      assert.ok(ids.has(id), `missing ${id}`);
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error("\nSOME TESTS FAILED.");
    process.exit(1);
  } else {
    console.log("ALL TESTS PASSED.");
  }
})();
