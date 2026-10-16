"use strict";
/**
 * Regression tests for: two open PRs with the same head SHA (same branch
 * opened against two different bases, a retarget that lines up with another
 * PR, etc.) used to be able to overwrite each other's commit status, since
 * GitHub shows one status per (sha, context) to every PR that has it as a
 * head - not one per PR. See findUncleanSiblingHead() in src/cla-bot.js.
 */
const assert = require("assert");
const testGitSha = require("./helpers/git-sha");

process.env.GITHUB_TOKEN = "dummy";
process.env.GITHUB_REPOSITORY = "fossasia/testrepo";
process.env.SIG_OWNER = "fossasia";
process.env.SIG_REPO = "cla-signatures";
process.env.CLA_DOCUMENT_URL = "https://example.com/CLA.md";
process.env.ALLOWLIST = "";

function freshModule() {
  delete require.cache[require.resolve("../src/cla-bot.js")];
  return require("../src/cla-bot.js");
}

let passed = 0;
let finished = false;
process.on("exit", () => {
  if (!finished) {
    console.error(
      "FAIL: the test run ended before every test finished (a promise never settled)",
    );
    process.exitCode = 1;
  }
});
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

const SIG_BLOB_SHA = testGitSha("shared-head-sha-signatures");
const AUTHOR_IDS = { alice: 1, bob: 2 };

function commit(sha, authorId, login) {
  return {
    sha,
    commit: {
      author: { name: login, email: `${login}@example.com`, date: "2024-01-01T00:00:00Z" },
      committer: { name: login, email: `${login}@example.com`, date: "2024-01-01T00:00:00Z" },
      message: "work",
      verification: { verified: true },
    },
    author: { id: authorId, login },
    committer: { id: authorId, login },
    parents: [{ sha: "parent-sha" }],
  };
}

// A commit whose author email isn't linked to any GitHub account - flagged
// for manual review (evaluatePair()'s "unresolved", not "missing").
function unresolvedCommit(sha) {
  return {
    sha,
    commit: {
      author: { name: "ghost", email: "ghost@example.com", date: "2024-01-01T00:00:00Z" },
      committer: { name: "ghost", email: "ghost@example.com", date: "2024-01-01T00:00:00Z" },
      message: "work",
      verification: { verified: true },
    },
    author: null,
    committer: null,
    parents: [{ sha: "parent-sha" }],
  };
}

// A small GitHub mock that understands several PRs at once (the real
// makeGitHub() in concurrency.test.js is hardcoded to PR #1).
//
// `prs`: { [prNumber]: { headSha, baseSha, state } }
// `commitsByBase`: { [baseSha]: [commit(...), ...] } - what the compare
//   between that base and the (single, shared) head returns.
function makeMultiPRGitHub({ prs, commitsByBase, signedLogins }) {
  const g = { statuses: [], comments: [] };
  g.fetch = async (url, opts = {}) => {
    const method = (opts.method || "GET").toUpperCase();
    const path = url.replace("https://api.github.com", "");

    let m;
    if ((m = path.match(/^\/repos\/fossasia\/testrepo\/pulls\/(\d+)$/))) {
      const pr = prs[Number(m[1])];
      return res(200, {
        head: { sha: pr.headSha },
        base: { sha: pr.baseSha },
        state: pr.state || "open",
      });
    }
    if (path.startsWith("/repos/fossasia/testrepo/compare/")) {
      const basehead = decodeURIComponent(path.split("/compare/")[1]).split("?")[0];
      const base = basehead.split("...")[0];
      const commits = commitsByBase[base] || [];
      return res(200, { commits, total_commits: commits.length });
    }
    if (
      (m = path.match(/^\/repos\/fossasia\/testrepo\/commits\/([0-9a-f]+)\/pulls/))
    ) {
      const headSha = m[1];
      const matches = Object.entries(prs)
        .filter(([, pr]) => pr.headSha === headSha)
        .map(([number, pr]) => ({
          number: Number(number),
          state: pr.state || "open",
          head: { sha: pr.headSha },
          base: { sha: pr.baseSha },
        }));
      return res(200, matches);
    }
    if (path.startsWith("/repos/fossasia/cla-signatures/contents/")) {
      return res(200, {
        type: "file",
        sha: SIG_BLOB_SHA,
        content: Buffer.from(
          JSON.stringify({
            version: 1,
            // Signatures match by numeric id, same as production - not by
            // login, which can be renamed. AUTHOR_IDS keeps this in sync
            // with the ids used in commit() below.
            signatures: signedLogins.map((login) => ({
              id: AUTHOR_IDS[login],
              login,
            })),
          }),
        ).toString("base64"),
        encoding: "base64",
      });
    }
    if (path.includes("/issues/") && path.includes("/comments")) {
      if (method === "GET") return res(200, []);
      if (method === "POST") {
        const { body } = JSON.parse(opts.body);
        const comment = { id: g.comments.length + 1, body, user: { login: "github-actions[bot]" } };
        g.comments.push(comment);
        return res(201, comment);
      }
    }
    if (path.startsWith("/repos/fossasia/testrepo/statuses/")) {
      g.statuses.push({ sha: path.split("/statuses/")[1], ...JSON.parse(opts.body) });
      return res(201, {});
    }
    if (path.includes("/lock") && method === "PUT") {
      return res(204, null);
    }
    if (path === "/user") return res(404, { message: "Not Found" });
    throw new Error(`Unhandled mock request: ${method} ${path}`);
  };
  return g;
}

const HEAD = testGitSha("shared-head");
const BASE_CLEAN = testGitSha("base-with-only-signed-author"); // -> alice only
const BASE_DIRTY = testGitSha("base-with-an-unsigned-author"); // -> alice + bob
const BASE_UNRESOLVED = testGitSha("base-with-an-unlinked-author");
const commitsByBase = {
  [BASE_CLEAN]: [commit(testGitSha("c1"), 1, "alice")],
  [BASE_DIRTY]: [commit(testGitSha("c1"), 1, "alice"), commit(testGitSha("c2"), 2, "bob")],
  [BASE_UNRESOLVED]: [
    commit(testGitSha("c1"), 1, "alice"),
    unresolvedCommit(testGitSha("c3")),
  ],
};

(async () => {
  await test(
    "two open PRs sharing one head SHA: the PR that is individually clean does not publish 'success' while the other is unsigned",
    async () => {
      const bot = freshModule();
      const handler = makeMultiPRGitHub({
        prs: {
          1: { headSha: HEAD, baseSha: BASE_CLEAN },
          2: { headSha: HEAD, baseSha: BASE_DIRTY },
        },
        commitsByBase,
        signedLogins: ["alice"],
      });
      global.fetch = handler.fetch;

      // PR #2 (dirty against its own base) is checked first, same as the
      // original bug report.
      await bot.checkPR(2, HEAD, { statusOnly: true, eventBaseSha: BASE_DIRTY });
      // PR #1 (clean against its own base) is checked second.
      await bot.checkPR(1, HEAD, { statusOnly: true, eventBaseSha: BASE_CLEAN });

      assert.strictEqual(handler.statuses.length, 2);
      assert.strictEqual(handler.statuses[0].state, "failure"); // PR #2's own result
      // PR #1's own result was clean, but it must not override PR #2's
      // failure with a "success" on the shared SHA.
      const last = handler.statuses[handler.statuses.length - 1];
      assert.strictEqual(last.state, "failure");
      assert.match(last.description, /#2/);
    },
  );

  await test(
    "same scenario in the opposite order: checking the clean PR first still doesn't publish 'success' for the shared head",
    async () => {
      const bot = freshModule();
      const handler = makeMultiPRGitHub({
        prs: {
          1: { headSha: HEAD, baseSha: BASE_CLEAN },
          2: { headSha: HEAD, baseSha: BASE_DIRTY },
        },
        commitsByBase,
        signedLogins: ["alice"],
      });
      global.fetch = handler.fetch;

      // Clean PR checked first this time.
      await bot.checkPR(1, HEAD, { statusOnly: true, eventBaseSha: BASE_CLEAN });

      assert.strictEqual(handler.statuses.length, 1);
      assert.strictEqual(handler.statuses[0].state, "failure");
      assert.match(handler.statuses[0].description, /#2/);
    },
  );

  await test(
    "a PR with no other open PR sharing its head still publishes 'success' normally (the common case is unaffected)",
    async () => {
      const bot = freshModule();
      const handler = makeMultiPRGitHub({
        prs: { 1: { headSha: HEAD, baseSha: BASE_CLEAN } },
        commitsByBase,
        signedLogins: ["alice"],
      });
      global.fetch = handler.fetch;

      await bot.checkPR(1, HEAD, { statusOnly: true, eventBaseSha: BASE_CLEAN });

      assert.strictEqual(handler.statuses.length, 1);
      assert.strictEqual(handler.statuses[0].state, "success");
    },
  );

  await test(
    "two open PRs sharing one head SHA that are BOTH individually clean still publish 'success' (no unnecessary blocking)",
    async () => {
      const bot = freshModule();
      const handler = makeMultiPRGitHub({
        prs: {
          1: { headSha: HEAD, baseSha: BASE_CLEAN },
          2: { headSha: HEAD, baseSha: BASE_CLEAN },
        },
        commitsByBase,
        signedLogins: ["alice"],
      });
      global.fetch = handler.fetch;

      await bot.checkPR(1, HEAD, { statusOnly: true, eventBaseSha: BASE_CLEAN });

      assert.strictEqual(handler.statuses.length, 1);
      assert.strictEqual(handler.statuses[0].state, "success");
    },
  );

  await test(
    "a CLOSED PR that historically shared this head is ignored - only OPEN siblings can hold a result back",
    async () => {
      const bot = freshModule();
      const handler = makeMultiPRGitHub({
        prs: {
          1: { headSha: HEAD, baseSha: BASE_CLEAN },
          2: { headSha: HEAD, baseSha: BASE_DIRTY, state: "closed" },
        },
        commitsByBase,
        signedLogins: ["alice"],
      });
      global.fetch = handler.fetch;

      await bot.checkPR(1, HEAD, { statusOnly: true, eventBaseSha: BASE_CLEAN });

      assert.strictEqual(handler.statuses.length, 1);
      assert.strictEqual(handler.statuses[0].state, "success");
    },
  );

  await test(
    "siblings spread across multiple pages of the sibling-PRs listing are still all found",
    async () => {
      const bot = freshModule();
      // Page 1 is a full page of 100 unrelated PRs (none open, none matching
      // this head) - the dirty sibling only shows up on page 2. Only a real
      // pagination loop, not a single-page read, will ever see it.
      const page1 = Array.from({ length: 100 }, (_, i) => ({
        number: 1000 + i,
        state: "closed",
        head: { sha: testGitSha(`unrelated-${i}`) },
        base: { sha: testGitSha(`unrelated-base-${i}`) },
      }));
      const page2 = [
        { number: 2, state: "open", head: { sha: HEAD }, base: { sha: BASE_DIRTY } },
      ];
      let pullsCalls = 0;
      const statuses = [];
      global.fetch = async (url, opts = {}) => {
        const method = (opts.method || "GET").toUpperCase();
        const path = url.replace("https://api.github.com", "");
        if (path.startsWith(`/repos/fossasia/testrepo/commits/${HEAD}/pulls`)) {
          pullsCalls += 1;
          const page = Number(new URL(url).searchParams.get("page")) || 1;
          if (page === 1) {
            return res(200, page1, {
              link: `<https://api.github.com/repos/fossasia/testrepo/commits/${HEAD}/pulls?per_page=100&page=2>; rel="next"`,
            });
          }
          return res(200, page2);
        }
        if (path === "/repos/fossasia/testrepo/pulls/1") {
          return res(200, { head: { sha: HEAD }, base: { sha: BASE_CLEAN }, state: "open" });
        }
        if (path === "/repos/fossasia/testrepo/pulls/2") {
          return res(200, { head: { sha: HEAD }, base: { sha: BASE_DIRTY }, state: "open" });
        }
        if (path.startsWith("/repos/fossasia/testrepo/compare/")) {
          const base = decodeURIComponent(path.split("/compare/")[1]).split("?")[0].split("...")[0];
          const commits = commitsByBase[base] || [];
          return res(200, { commits, total_commits: commits.length });
        }
        if (path.startsWith("/repos/fossasia/cla-signatures/contents/")) {
          return res(200, {
            type: "file",
            sha: SIG_BLOB_SHA,
            content: Buffer.from(
              JSON.stringify({ version: 1, signatures: [{ id: AUTHOR_IDS.alice, login: "alice" }] }),
            ).toString("base64"),
            encoding: "base64",
          });
        }
        if (path.includes("/issues/") && path.includes("/comments")) {
          if (method === "GET") return res(200, []);
          if (method === "POST")
            return res(201, { id: 1, body: JSON.parse(opts.body).body, user: { login: "x" } });
        }
        if (path.startsWith("/repos/fossasia/testrepo/statuses/")) {
          statuses.push(JSON.parse(opts.body));
          return res(201, {});
        }
        if (path === "/user") return res(404, { message: "Not Found" });
        throw new Error(`Unhandled mock request: ${method} ${path}`);
      };

      await bot.checkPR(1, HEAD, { statusOnly: true, eventBaseSha: BASE_CLEAN });

      assert.ok(pullsCalls >= 2, "expected the sibling listing to be paged at least twice");
      assert.strictEqual(statuses.length, 1);
      assert.strictEqual(statuses[0].state, "failure"); // page-2 sibling (#2) is dirty
      assert.match(statuses[0].description, /#2/);
    },
  );

  await test(
    "more open siblings than the safety cap allows: fails closed instead of silently checking only some",
    async () => {
      const bot = freshModule();
      const tooMany = Array.from({ length: 21 }, (_, i) => ({
        number: 100 + i,
        state: "open",
        head: { sha: HEAD },
        base: { sha: BASE_CLEAN },
      }));
      const handler = makeMultiPRGitHub({
        prs: { 1: { headSha: HEAD, baseSha: BASE_CLEAN } },
        commitsByBase,
        signedLogins: ["alice"],
      });
      const baseFetch = handler.fetch;
      global.fetch = async (url, opts = {}) => {
        if (url.includes(`/commits/${HEAD}/pulls`)) return res(200, tooMany);
        return baseFetch(url, opts);
      };

      await assert.rejects(
        () => bot.checkPR(1, HEAD, { statusOnly: true, eventBaseSha: BASE_CLEAN }),
        /too many to verify safely/,
      );
      // Fails closed rather than leaving the SHA unconfirmed or publishing
      // the "success" this PR's own evaluation found.
      assert.strictEqual(handler.statuses.length, 1);
      assert.strictEqual(handler.statuses[0].state, "failure");
    },
  );

  await test(
    "the sibling-PRs endpoint returning something other than a list fails closed instead of being read as 'no siblings'",
    async () => {
      const bot = freshModule();
      const handler = makeMultiPRGitHub({
        prs: { 1: { headSha: HEAD, baseSha: BASE_CLEAN } },
        commitsByBase,
        signedLogins: ["alice"],
      });
      const baseFetch = handler.fetch;
      global.fetch = async (url, opts = {}) => {
        if (url.includes(`/commits/${HEAD}/pulls`)) {
          return res(200, { message: "unexpected shape" }); // not an array
        }
        return baseFetch(url, opts);
      };

      await assert.rejects(
        () => bot.checkPR(1, HEAD, { statusOnly: true, eventBaseSha: BASE_CLEAN }),
        /is not a list/,
      );
      assert.strictEqual(handler.statuses.length, 1);
      assert.strictEqual(handler.statuses[0].state, "failure");
    },
  );

  await test(
    "the sibling check failing before this PR has published anything still fails closed (does not just leave whatever status was already there)",
    async () => {
      const bot = freshModule();
      const handler = makeMultiPRGitHub({
        prs: { 1: { headSha: HEAD, baseSha: BASE_CLEAN } },
        commitsByBase,
        signedLogins: ["alice"],
      });
      const baseFetch = handler.fetch;
      global.fetch = async (url, opts = {}) => {
        if (url.includes(`/commits/${HEAD}/pulls`)) {
          return res(400, { message: "malformed request (test fixture)" });
        }
        return baseFetch(url, opts);
      };

      await assert.rejects(() =>
        bot.checkPR(1, HEAD, { statusOnly: true, eventBaseSha: BASE_CLEAN }),
      );
      // Nothing had been published yet this run when the sibling check blew
      // up - the old everPublished-only recovery path would have left this
      // empty. It must still fail closed.
      assert.strictEqual(handler.statuses.length, 1);
      assert.strictEqual(handler.statuses[0].state, "failure");
    },
  );

  await test(
    "a sibling that opens and is already dirty between this PR's check and its publish is caught by the post-publish recheck",
    async () => {
      const bot = freshModule();
      // No sibling yet on the first (pre-publish) lookup; the dirty sibling
      // "appears" only on the second (post-publish) lookup - simulating one
      // opening in the narrow window between the two reads.
      let pullsCalls = 0;
      const handler = makeMultiPRGitHub({
        prs: {
          1: { headSha: HEAD, baseSha: BASE_CLEAN },
          2: { headSha: HEAD, baseSha: BASE_DIRTY },
        },
        commitsByBase,
        signedLogins: ["alice"],
      });
      const baseFetch = handler.fetch;
      global.fetch = async (url, opts = {}) => {
        if (url.includes(`/commits/${HEAD}/pulls`)) {
          pullsCalls += 1;
          if (pullsCalls === 1) return res(200, []);
          return res(200, [
            { number: 2, state: "open", head: { sha: HEAD }, base: { sha: BASE_DIRTY } },
          ]);
        }
        return baseFetch(url, opts);
      };

      await bot.checkPR(1, HEAD, { statusOnly: true, eventBaseSha: BASE_CLEAN });

      assert.ok(pullsCalls >= 2, "expected a post-publish recheck of siblings");
      // The first write is the "success" this PR's own evaluation found;
      // the post-publish recheck must then correct it.
      assert.strictEqual(handler.statuses.length, 2);
      assert.strictEqual(handler.statuses[0].state, "success");
      assert.strictEqual(handler.statuses[1].state, "failure");
      assert.match(handler.statuses[1].description, /#2/);
    },
  );

  await test(
    "the post-publish sibling recheck failing is still handled by the existing fail-closed recovery path",
    async () => {
      const bot = freshModule();
      let pullsCalls = 0;
      const handler = makeMultiPRGitHub({
        prs: { 1: { headSha: HEAD, baseSha: BASE_CLEAN } },
        commitsByBase,
        signedLogins: ["alice"],
      });
      const baseFetch = handler.fetch;
      global.fetch = async (url, opts = {}) => {
        if (url.includes(`/commits/${HEAD}/pulls`)) {
          pullsCalls += 1;
          if (pullsCalls === 1) return res(200, []); // clean on the pre-publish check
          return res(400, { message: "malformed request (test fixture)" }); // blows up on the recheck
        }
        return baseFetch(url, opts);
      };

      await assert.rejects(() =>
        bot.checkPR(1, HEAD, { statusOnly: true, eventBaseSha: BASE_CLEAN }),
      );
      assert.strictEqual(pullsCalls, 2);
      // "success" was published, then the recheck's failure must still
      // correct it via the pre-existing everPublished fail-closed path.
      assert.strictEqual(handler.statuses.length, 2);
      assert.strictEqual(handler.statuses[0].state, "success");
      assert.strictEqual(handler.statuses[1].state, "failure");
    },
  );

  await test(
    "a sibling retargets onto a dirty base between being evaluated and the immediate re-check: it's still caught",
    async () => {
      const bot = freshModule();
      const statuses = [];
      // The sibling listing itself reports BASE_CLEAN (so the first
      // evaluatePair() call on it comes back clean), but by the time we
      // re-read PR #2 directly (fetchPRSnapshot), it has already retargeted
      // onto BASE_DIRTY - simulating a retarget that lands mid-check.
      let pr2Reads = 0;
      global.fetch = async (url, opts = {}) => {
        const method = (opts.method || "GET").toUpperCase();
        const path = url.replace("https://api.github.com", "");
        if (path === "/repos/fossasia/testrepo/pulls/1") {
          return res(200, { head: { sha: HEAD }, base: { sha: BASE_CLEAN }, state: "open" });
        }
        if (path === "/repos/fossasia/testrepo/pulls/2") {
          pr2Reads += 1;
          return res(200, { head: { sha: HEAD }, base: { sha: BASE_DIRTY }, state: "open" });
        }
        if (path.startsWith(`/repos/fossasia/testrepo/commits/${HEAD}/pulls`)) {
          return res(200, [
            { number: 2, state: "open", head: { sha: HEAD }, base: { sha: BASE_CLEAN } },
          ]);
        }
        if (path.startsWith("/repos/fossasia/testrepo/compare/")) {
          const base = decodeURIComponent(path.split("/compare/")[1]).split("?")[0].split("...")[0];
          const commits = commitsByBase[base] || [];
          return res(200, { commits, total_commits: commits.length });
        }
        if (path.startsWith("/repos/fossasia/cla-signatures/contents/")) {
          return res(200, {
            type: "file",
            sha: SIG_BLOB_SHA,
            content: Buffer.from(
              JSON.stringify({ version: 1, signatures: [{ id: AUTHOR_IDS.alice, login: "alice" }] }),
            ).toString("base64"),
            encoding: "base64",
          });
        }
        if (path.includes("/issues/") && path.includes("/comments")) {
          if (method === "GET") return res(200, []);
          if (method === "POST")
            return res(201, { id: 1, body: JSON.parse(opts.body).body, user: { login: "x" } });
        }
        if (path.startsWith("/repos/fossasia/testrepo/statuses/")) {
          statuses.push(JSON.parse(opts.body));
          return res(201, {});
        }
        if (path === "/user") return res(404, { message: "Not Found" });
        throw new Error(`Unhandled mock request: ${method} ${path}`);
      };

      await bot.checkPR(1, HEAD, { statusOnly: true, eventBaseSha: BASE_CLEAN });

      assert.ok(pr2Reads >= 1, "expected PR #2 to be re-read directly after its first evaluation");
      assert.strictEqual(statuses.length, 1);
      assert.strictEqual(statuses[0].state, "failure");
      assert.match(statuses[0].description, /#2/);
    },
  );

  await test(
    "a sibling retargets onto a base with an unresolved (not merely unsigned) commit between its evaluation and the immediate re-check: still caught",
    async () => {
      const bot = freshModule();
      const statuses = [];
      global.fetch = async (url, opts = {}) => {
        const method = (opts.method || "GET").toUpperCase();
        const path = url.replace("https://api.github.com", "");
        if (path === "/repos/fossasia/testrepo/pulls/1") {
          return res(200, { head: { sha: HEAD }, base: { sha: BASE_CLEAN }, state: "open" });
        }
        if (path === "/repos/fossasia/testrepo/pulls/2") {
          return res(200, { head: { sha: HEAD }, base: { sha: BASE_UNRESOLVED }, state: "open" });
        }
        if (path.startsWith(`/repos/fossasia/testrepo/commits/${HEAD}/pulls`)) {
          return res(200, [
            { number: 2, state: "open", head: { sha: HEAD }, base: { sha: BASE_CLEAN } },
          ]);
        }
        if (path.startsWith("/repos/fossasia/testrepo/compare/")) {
          const base = decodeURIComponent(path.split("/compare/")[1]).split("?")[0].split("...")[0];
          const commits = commitsByBase[base] || [];
          return res(200, { commits, total_commits: commits.length });
        }
        if (path.startsWith("/repos/fossasia/cla-signatures/contents/")) {
          return res(200, {
            type: "file",
            sha: SIG_BLOB_SHA,
            content: Buffer.from(
              JSON.stringify({ version: 1, signatures: [{ id: AUTHOR_IDS.alice, login: "alice" }] }),
            ).toString("base64"),
            encoding: "base64",
          });
        }
        if (path.includes("/issues/") && path.includes("/comments")) {
          if (method === "GET") return res(200, []);
          if (method === "POST")
            return res(201, { id: 1, body: JSON.parse(opts.body).body, user: { login: "x" } });
        }
        if (path.startsWith("/repos/fossasia/testrepo/statuses/")) {
          statuses.push(JSON.parse(opts.body));
          return res(201, {});
        }
        if (path === "/user") return res(404, { message: "Not Found" });
        throw new Error(`Unhandled mock request: ${method} ${path}`);
      };

      await bot.checkPR(1, HEAD, { statusOnly: true, eventBaseSha: BASE_CLEAN });

      assert.strictEqual(statuses.length, 1);
      assert.strictEqual(statuses[0].state, "failure");
      assert.match(statuses[0].description, /#2/);
    },
  );

  await test(
    "a sibling that closes between being evaluated and the immediate re-check is not treated as a blocker",
    async () => {
      const bot = freshModule();
      const statuses = [];
      global.fetch = async (url, opts = {}) => {
        const method = (opts.method || "GET").toUpperCase();
        const path = url.replace("https://api.github.com", "");
        if (path === "/repos/fossasia/testrepo/pulls/1") {
          return res(200, { head: { sha: HEAD }, base: { sha: BASE_CLEAN }, state: "open" });
        }
        if (path === "/repos/fossasia/testrepo/pulls/2") {
          // Closed by the time we re-check it directly, even though the
          // listing still showed it open a moment earlier.
          return res(200, { head: { sha: HEAD }, base: { sha: BASE_DIRTY }, state: "closed" });
        }
        if (path.startsWith(`/repos/fossasia/testrepo/commits/${HEAD}/pulls`)) {
          return res(200, [
            { number: 2, state: "open", head: { sha: HEAD }, base: { sha: BASE_CLEAN } },
          ]);
        }
        if (path.startsWith("/repos/fossasia/testrepo/compare/")) {
          const base = decodeURIComponent(path.split("/compare/")[1]).split("?")[0].split("...")[0];
          const commits = commitsByBase[base] || [];
          return res(200, { commits, total_commits: commits.length });
        }
        if (path.startsWith("/repos/fossasia/cla-signatures/contents/")) {
          return res(200, {
            type: "file",
            sha: SIG_BLOB_SHA,
            content: Buffer.from(
              JSON.stringify({ version: 1, signatures: [{ id: AUTHOR_IDS.alice, login: "alice" }] }),
            ).toString("base64"),
            encoding: "base64",
          });
        }
        if (path.includes("/issues/") && path.includes("/comments")) {
          if (method === "GET") return res(200, []);
          if (method === "POST")
            return res(201, { id: 1, body: JSON.parse(opts.body).body, user: { login: "x" } });
        }
        if (path.startsWith("/repos/fossasia/testrepo/statuses/")) {
          statuses.push(JSON.parse(opts.body));
          return res(201, {});
        }
        if (path === "/user") return res(404, { message: "Not Found" });
        throw new Error(`Unhandled mock request: ${method} ${path}`);
      };

      await bot.checkPR(1, HEAD, { statusOnly: true, eventBaseSha: BASE_CLEAN });

      assert.strictEqual(statuses.length, 1);
      assert.strictEqual(statuses[0].state, "success");
    },
  );

  await test(
    "a blocked-by-sibling result (not statusOnly) posts an explanatory comment, not just the status",
    async () => {
      const bot = freshModule();
      const handler = makeMultiPRGitHub({
        prs: {
          1: { headSha: HEAD, baseSha: BASE_CLEAN },
          2: { headSha: HEAD, baseSha: BASE_DIRTY },
        },
        commitsByBase,
        signedLogins: ["alice"],
      });
      global.fetch = handler.fetch;

      // No statusOnly here - this is the normal, comment-posting path.
      await bot.checkPR(1, HEAD, { eventBaseSha: BASE_CLEAN });

      assert.strictEqual(handler.statuses.length, 1);
      assert.strictEqual(handler.statuses[0].state, "failure");
      assert.strictEqual(handler.comments.length, 1);
      assert.match(handler.comments[0].body, /#2/);
      assert.match(handler.comments[0].body, /recheck/);
      assert.match(
        handler.comments[0].body,
        /Every contributor on this PR has signed the CLA/,
      );
    },
  );

  // --- Lifecycle: automatic recovery once a blocking sibling goes away ---
  // These exercise handlePullRequestTarget() directly, the real webhook
  // entry point, rather than calling checkPR() ourselves - that's the only
  // way to cover the "closed" / "synchronize" event-routing branches that
  // decide whether a stale shared-head failure gets a chance to clear.

  await test(
    "lifecycle: a clean PR blocked by a dirty sibling automatically recovers to 'success' once that sibling closes unmerged",
    async () => {
      const bot = freshModule();
      const prs = {
        1: { headSha: HEAD, baseSha: BASE_CLEAN, state: "open" },
        2: { headSha: HEAD, baseSha: BASE_DIRTY, state: "open" },
      };
      const handler = makeMultiPRGitHub({ prs, commitsByBase, signedLogins: ["alice"] });
      global.fetch = handler.fetch;

      await bot.checkPR(1, HEAD, { statusOnly: true, eventBaseSha: BASE_CLEAN });
      assert.strictEqual(handler.statuses.length, 1);
      assert.strictEqual(handler.statuses[0].state, "failure");

      // #2 closes without merging - the mock's "ground truth" reflects
      // that, the same way GitHub itself would from this point on.
      prs[2].state = "closed";
      await bot.handlePullRequestTarget({
        action: "closed",
        pull_request: {
          number: 2,
          merged: false,
          head: { sha: HEAD },
          base: { sha: BASE_DIRTY },
        },
      });

      assert.strictEqual(handler.statuses.length, 2);
      assert.strictEqual(handler.statuses[1].sha, HEAD);
      assert.strictEqual(handler.statuses[1].state, "success");
    },
  );

  await test(
    "lifecycle: a clean PR blocked by a dirty sibling automatically recovers to 'success' once that sibling's head changes (synchronize)",
    async () => {
      const bot = freshModule();
      const newHeadForSibling = testGitSha("pr2-new-head-after-push");
      const prs = {
        1: { headSha: HEAD, baseSha: BASE_CLEAN, state: "open" },
        2: { headSha: HEAD, baseSha: BASE_DIRTY, state: "open" },
      };
      const handler = makeMultiPRGitHub({ prs, commitsByBase, signedLogins: ["alice"] });
      global.fetch = handler.fetch;

      await bot.checkPR(1, HEAD, { statusOnly: true, eventBaseSha: BASE_CLEAN });
      assert.strictEqual(handler.statuses.length, 1);
      assert.strictEqual(handler.statuses[0].state, "failure");

      // #2 pushes new commits - its head moves off the shared SHA entirely.
      prs[2].headSha = newHeadForSibling;
      await bot.handlePullRequestTarget({
        action: "synchronize",
        before: HEAD,
        pull_request: {
          number: 2,
          merged: false,
          head: { sha: newHeadForSibling },
          base: { sha: BASE_DIRTY },
        },
      });

      // #1's status lives on the OLD shared SHA - isolate it from whatever
      // #2's own (unrelated) check just wrote to its new head.
      const onOldHead = handler.statuses.filter((s) => s.sha === HEAD);
      assert.strictEqual(onOldHead.length, 2);
      assert.strictEqual(onOldHead[1].state, "success");
    },
  );

  await test(
    "lifecycle: ALL open siblings on an old shared head are rechecked, not just the first one found",
    async () => {
      const bot = freshModule();
      const prs = {
        1: { headSha: HEAD, baseSha: BASE_CLEAN, state: "open" },
        2: { headSha: HEAD, baseSha: BASE_DIRTY, state: "open" }, // the one that will close
        3: { headSha: HEAD, baseSha: BASE_CLEAN, state: "open" },
      };
      const handler = makeMultiPRGitHub({ prs, commitsByBase, signedLogins: ["alice"] });
      global.fetch = handler.fetch;

      await bot.checkPR(1, HEAD, { statusOnly: true, eventBaseSha: BASE_CLEAN });
      await bot.checkPR(3, HEAD, { statusOnly: true, eventBaseSha: BASE_CLEAN });
      assert.strictEqual(handler.statuses.length, 2);
      assert.ok(handler.statuses.every((s) => s.state === "failure"));

      prs[2].state = "closed";
      await bot.handlePullRequestTarget({
        action: "closed",
        pull_request: {
          number: 2,
          merged: false,
          head: { sha: HEAD },
          base: { sha: BASE_DIRTY },
        },
      });

      const onHead = handler.statuses.filter((s) => s.sha === HEAD);
      assert.strictEqual(onHead.length, 4); // 2 initial failures + 2 recoveries
      assert.strictEqual(onHead[2].state, "success");
      assert.strictEqual(onHead[3].state, "success");
    },
  );

  await test(
    "lifecycle: a merged close does not attempt a sibling recheck (lockPR's early return is unaffected)",
    async () => {
      const bot = freshModule();
      const prs = {
        1: { headSha: HEAD, baseSha: BASE_CLEAN, state: "open" },
        2: { headSha: HEAD, baseSha: BASE_DIRTY, state: "open" },
      };
      let siblingLookups = 0;
      const handler = makeMultiPRGitHub({ prs, commitsByBase, signedLogins: ["alice"] });
      const baseFetch = handler.fetch;
      global.fetch = async (url, opts) => {
        if (url.includes("/pulls") && url.includes("/commits/")) siblingLookups += 1;
        return baseFetch(url, opts);
      };

      await bot.checkPR(1, HEAD, { statusOnly: true, eventBaseSha: BASE_CLEAN });
      siblingLookups = 0; // only count lookups from the close event itself

      await bot.handlePullRequestTarget({
        action: "closed",
        pull_request: {
          number: 2,
          merged: true,
          head: { sha: HEAD },
          base: { sha: BASE_DIRTY },
        },
      });

      assert.strictEqual(siblingLookups, 0);
    },
  );

  await test(
    "lifecycle: synchronize with no 'before' field (unusual payload) does not crash and does not attempt a recheck",
    async () => {
      const bot = freshModule();
      const newHeadForSibling = testGitSha("pr2-new-head-no-before-field");
      const prs = {
        1: { headSha: HEAD, baseSha: BASE_CLEAN, state: "open" },
        2: { headSha: HEAD, baseSha: BASE_DIRTY, state: "open" },
      };
      let siblingLookups = 0;
      const handler = makeMultiPRGitHub({ prs, commitsByBase, signedLogins: ["alice"] });
      const baseFetch = handler.fetch;
      global.fetch = async (url, opts) => {
        if (url.includes("/pulls") && url.includes("/commits/")) siblingLookups += 1;
        return baseFetch(url, opts);
      };

      await bot.checkPR(1, HEAD, { statusOnly: true, eventBaseSha: BASE_CLEAN });
      siblingLookups = 0;
      prs[2].headSha = newHeadForSibling;

      await bot.handlePullRequestTarget({
        action: "synchronize",
        // no `before` field at all
        pull_request: {
          number: 2,
          merged: false,
          head: { sha: newHeadForSibling },
          base: { sha: BASE_DIRTY },
        },
      });

      assert.strictEqual(siblingLookups, 0);
    },
  );

  await test(
    "lifecycle: synchronize whose 'before' equals the new head (no actual move) does not attempt a recheck",
    async () => {
      const bot = freshModule();
      const prs = {
        1: { headSha: HEAD, baseSha: BASE_CLEAN, state: "open" },
        2: { headSha: HEAD, baseSha: BASE_DIRTY, state: "open" },
      };
      let siblingLookups = 0;
      const handler = makeMultiPRGitHub({ prs, commitsByBase, signedLogins: ["alice"] });
      const baseFetch = handler.fetch;
      global.fetch = async (url, opts) => {
        if (url.includes("/pulls") && url.includes("/commits/")) siblingLookups += 1;
        return baseFetch(url, opts);
      };

      await bot.checkPR(1, HEAD, { statusOnly: true, eventBaseSha: BASE_CLEAN });
      siblingLookups = 0;

      await bot.handlePullRequestTarget({
        action: "synchronize",
        before: HEAD, // identical to the reported head - nothing actually moved
        pull_request: {
          number: 2,
          merged: false,
          head: { sha: HEAD },
          base: { sha: BASE_DIRTY },
        },
      });

      assert.strictEqual(siblingLookups, 0);
    },
  );

  await test(
    "lifecycle: a failure looking up siblings of the old head is logged and swallowed, not thrown - the close event itself still completes",
    async () => {
      const bot = freshModule();
      const prs = { 1: { headSha: HEAD, baseSha: BASE_CLEAN, state: "open" } };
      const handler = makeMultiPRGitHub({ prs, commitsByBase, signedLogins: ["alice"] });
      const baseFetch = handler.fetch;
      global.fetch = async (url, opts) => {
        if (url.includes("/pulls") && url.includes("/commits/")) {
          return res(400, { message: "malformed request (test fixture)" });
        }
        return baseFetch(url, opts);
      };
      const originalConsoleError = console.error;
      let loggedSomething = false;
      console.error = (...args) => {
        loggedSomething = true;
        originalConsoleError(...args);
      };

      try {
        await bot.handlePullRequestTarget({
          action: "closed",
          pull_request: {
            number: 2,
            merged: false,
            head: { sha: HEAD },
            base: { sha: BASE_DIRTY },
          },
        });
      } finally {
        console.error = originalConsoleError;
      }

      assert.ok(loggedSomething, "expected the lookup failure to be logged");
    },
  );

  await test(
    "lifecycle: one sibling's recheck failing does not stop the others from being rechecked",
    async () => {
      const bot = freshModule();
      // #1 is processed before #3 (object key order), and listOtherOpenPRsWithHead()
      // returns candidates in listing order, so #1's own recheck hits a
      // one-time blip - but by the time #3's recheck separately asks about
      // #1 (as ITS candidate sibling), that same read succeeds normally.
      // This isolates "this one recheck attempt failed" from "this sibling
      // is permanently unreadable", which would fail both PRs by design.
      const prs = {
        1: { headSha: HEAD, baseSha: BASE_CLEAN, state: "open" },
        2: { headSha: HEAD, baseSha: BASE_DIRTY, state: "open" },
        3: { headSha: HEAD, baseSha: BASE_CLEAN, state: "open" }, // should still recover
      };
      const handler = makeMultiPRGitHub({ prs, commitsByBase, signedLogins: ["alice"] });
      const baseFetch = handler.fetch;
      let pulls1Reads = 0;
      global.fetch = async (url, opts) => {
        if (url.endsWith("/repos/fossasia/testrepo/pulls/1")) {
          pulls1Reads += 1;
          if (pulls1Reads === 1) {
            return res(400, { message: "malformed request (test fixture, one-shot)" });
          }
        }
        return baseFetch(url, opts);
      };

      const originalConsoleError = console.error;
      console.error = () => {};
      try {
        prs[2].state = "closed"; // the event below reports exactly this
        await bot.handlePullRequestTarget({
          action: "closed",
          pull_request: {
            number: 2,
            merged: false,
            head: { sha: HEAD },
            base: { sha: BASE_DIRTY },
          },
        });
      } finally {
        console.error = originalConsoleError;
      }

      assert.ok(pulls1Reads >= 2, "expected #1 to be read again later, not just once");
      // #1's own recheck failed and published nothing for it specifically,
      // but #3 must still have recovered to "success".
      const onHead = handler.statuses.filter((s) => s.sha === HEAD);
      assert.ok(
        onHead.some((s) => s.state === "success"),
        "expected PR #3 to still recover despite PR #1's recheck failing",
      );
    },
  );

  await test(
    "RACE: recovery's stale (pre-sign) evaluation of a PR must not overwrite a fresher 'success' that a directly-triggered check publishes for the same PR while recovery is mid-flight",
    async () => {
      const bot = freshModule();
      const order = [];
      const prs = {
        1: { headSha: HEAD, baseSha: BASE_DIRTY, state: "open" },
        2: { headSha: HEAD, baseSha: BASE_DIRTY, state: "closed" }, // already closed by the time recovery runs
      };
      let signedLogins = []; // bob has not signed yet
      let sigReads = 0;
      let releaseFirstRead;
      const firstReadGate = new Promise((resolve) => {
        releaseFirstRead = resolve;
      });

      const handler = makeMultiPRGitHub({
        prs,
        commitsByBase: { [BASE_DIRTY]: commitsByBase[BASE_DIRTY] },
        signedLogins: [],
      });
      const baseFetch = handler.fetch;
      global.fetch = async (url, opts) => {
        if (url.startsWith("https://api.github.com/repos/fossasia/cla-signatures/contents/")) {
          sigReads += 1;
          const myReadNumber = sigReads;
          // A real GitHub read reflects the data as of when the request
          // reached GitHub, not whenever our code gets around to using the
          // response - freeze the snapshot now, before any delay below.
          const frozenSignedLogins = [...signedLogins];
          if (myReadNumber === 1) {
            order.push("PR #1's first signature read (recovery's) starts and pauses");
            await firstReadGate;
            order.push("PR #1's first signature read resumes with its ORIGINAL (stale) data");
          }
          return res(200, {
            type: "file",
            sha: SIG_BLOB_SHA,
            content: Buffer.from(
              JSON.stringify({
                version: 1,
                signatures: frozenSignedLogins.map((login) => ({ id: AUTHOR_IDS[login], login })),
              }),
            ).toString("base64"),
            encoding: "base64",
          });
        }
        return baseFetch(url, opts);
      };

      const recovery = (async () => {
        order.push("recovery (PR #2 closing) starts");
        await bot.handlePullRequestTarget({
          action: "closed",
          pull_request: {
            number: 2,
            merged: false,
            head: { sha: HEAD },
            base: { sha: BASE_DIRTY },
          },
        });
        order.push("recovery finishes");
      })();

      // Let recovery's first (now-paused) read happen, then run a
      // completely separate, directly-triggered check (as a signing
      // comment's own checkPR() call would) that observes the sign and
      // publishes success - all while recovery is still paused mid-flight.
      while (sigReads < 1) await new Promise((r) => setTimeout(r, 1));
      signedLogins = ["alice", "bob"]; // the sign happens here
      order.push("a sign-triggered direct check starts");
      await bot.checkPR(1, HEAD, { statusOnly: true, eventBaseSha: BASE_DIRTY });
      order.push("a sign-triggered direct check finishes");
      releaseFirstRead();

      await recovery;

      const onHead = handler.statuses.filter((s) => s.sha === HEAD);
      // The LAST word on this SHA must be "success" - recovery's stale
      // "failure" (based on data read before the sign) must not win just
      // because its own publish happens to land after the fresher one's.
      assert.strictEqual(onHead[onHead.length - 1].state, "success");
      assert.deepStrictEqual(order, [
        "recovery (PR #2 closing) starts",
        "PR #1's first signature read (recovery's) starts and pauses",
        "a sign-triggered direct check starts",
        "a sign-triggered direct check finishes",
        "PR #1's first signature read resumes with its ORIGINAL (stale) data",
        "recovery finishes",
      ]);
    },
  );

  await test(
    "recovery stops early, rather than attempting more rechecks, once the event's remaining request budget runs low",
    async () => {
      const bot = freshModule();
      const prs = {
        1: { headSha: HEAD, baseSha: BASE_CLEAN, state: "open" },
        2: { headSha: HEAD, baseSha: BASE_DIRTY, state: "open" }, // closes
        3: { headSha: HEAD, baseSha: BASE_CLEAN, state: "open" }, // never reached
      };
      const handler = makeMultiPRGitHub({ prs, commitsByBase, signedLogins: ["alice"] });
      global.fetch = handler.fetch;

      prs[2].state = "closed";
      // Spend the run's budget down below the per-sibling reserve before
      // the close event is even processed, so recovery never gets to
      // attempt a single recheck.
      await bot.runWithGitHubTokenRequestBudget(1, 0, async () => {
        await bot.handlePullRequestTarget({
          action: "closed",
          pull_request: {
            number: 2,
            merged: false,
            head: { sha: HEAD },
            base: { sha: BASE_DIRTY },
          },
        });
      });

      assert.strictEqual(handler.statuses.length, 0);
    },
  );

  await test(
    "a clean result that turns dirty during the sibling check itself (not just the extraCautious pre-check) is still caught before publishing",
    async () => {
      const bot = freshModule();
      const statuses = [];
      let sigReads = 0;
      global.fetch = async (url, opts = {}) => {
        const method = (opts.method || "GET").toUpperCase();
        const path = url.replace("https://api.github.com", "");
        if (path === "/repos/fossasia/testrepo/pulls/1") {
          return res(200, { head: { sha: HEAD }, base: { sha: BASE_CLEAN }, state: "open" });
        }
        if (path === "/repos/fossasia/testrepo/pulls/3") {
          return res(200, { head: { sha: HEAD }, base: { sha: BASE_CLEAN }, state: "open" });
        }
        if (path.startsWith(`/repos/fossasia/testrepo/commits/${HEAD}/pulls`)) {
          return res(200, [
            { number: 3, state: "open", head: { sha: HEAD }, base: { sha: BASE_CLEAN } },
          ]);
        }
        if (path.startsWith("/repos/fossasia/testrepo/compare/")) {
          const base = decodeURIComponent(path.split("/compare/")[1]).split("?")[0].split("...")[0];
          const commits = commitsByBase[base] || [];
          return res(200, { commits, total_commits: commits.length });
        }
        if (path.startsWith("/repos/fossasia/cla-signatures/contents/")) {
          sigReads += 1;
          // Reads 1 and 2 are PR #1's own first evaluation and PR #3's
          // (the sibling's) evaluation - both see alice signed, so both
          // come back clean. Read 3 is PR #1's post-sibling-check
          // reconfirm - simulate alice's signature having been removed in
          // between (e.g. a corrected/retracted signature).
          const signed = sigReads >= 3 ? [] : ["alice"];
          return res(200, {
            type: "file",
            sha: SIG_BLOB_SHA,
            content: Buffer.from(
              JSON.stringify({
                version: 1,
                signatures: signed.map((login) => ({ id: AUTHOR_IDS[login], login })),
              }),
            ).toString("base64"),
            encoding: "base64",
          });
        }
        if (path.includes("/issues/") && path.includes("/comments")) {
          if (method === "GET") return res(200, []);
          if (method === "POST")
            return res(201, { id: 1, body: JSON.parse(opts.body).body, user: { login: "x" } });
        }
        if (path.startsWith("/repos/fossasia/testrepo/statuses/")) {
          statuses.push(JSON.parse(opts.body));
          return res(201, {});
        }
        if (path === "/user") return res(404, { message: "Not Found" });
        throw new Error(`Unhandled mock request: ${method} ${path}`);
      };

      await bot.checkPR(1, HEAD, { statusOnly: true, eventBaseSha: BASE_CLEAN });

      assert.ok(sigReads >= 3, "expected a post-sibling-check reconfirm read");
      assert.strictEqual(statuses.length, 1);
      assert.strictEqual(statuses[0].state, "failure");
    },
  );

  await test(
    "remainingGitHubTokenRequestBudget() reports Infinity (no limit) outside any tracked budget",
    async () => {
      const bot = freshModule();
      assert.strictEqual(bot.remainingGitHubTokenRequestBudget(), Infinity);
      await bot.runWithGitHubTokenRequestBudget(3, 0, async () => {
        assert.strictEqual(bot.remainingGitHubTokenRequestBudget(), 3);
      });
      // Back outside the budget's own async context, it reports unlimited
      // again rather than leaking the budget that just ended.
      assert.strictEqual(bot.remainingGitHubTokenRequestBudget(), Infinity);
    },
  );

  finished = true;
  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) console.log("SOME TESTS FAILED.");
  else console.log("ALL TESTS PASSED.");
})();
