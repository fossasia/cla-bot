"use strict";
/**
 * Offline unit tests for .github/scripts/post-coverage-comment.js - the
 * privileged (pull-requests:write) script that turns a coverage report
 * artifact into a sticky PR comment.
 *
 * These specifically exercise the trust-boundary fix: the script must
 * verify a candidate PR number from the (untrusted) artifact against the
 * trusted workflow_run.head_sha before ever calling the comment-writing
 * API, and must skip cleanly (never throw, never post) whenever that
 * verification fails.
 *
 * Not part of the shipped action or the 100%-coverage gate (see the note
 * at the top of coverage-report.test.js) - run as part of `npm test`.
 *
 * Run: node test/post-coverage-comment.test.js (or `npm test`)
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const postCoverageComment = require("../.github/scripts/post-coverage-comment.js");

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (e) {
    console.error(`FAIL: ${name}\n - ${e.message}`);
    process.exitCode = 1;
  }
}

const TRUSTED_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

// post-coverage-comment.js reads from
// path.join(GITHUB_WORKSPACE, "coverage-artifact") - see
// coverage-comment.yml's download-artifact step. This returns the
// workspace root to set GITHUB_WORKSPACE to; the artifact files
// themselves live one level down, inside "coverage-artifact/".
function makeArtifactDir({ prNumber, status = "pass", body = "report body" }) {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "coverage-workspace-"),
  );
  const artifactDir = path.join(workspace, "coverage-artifact");
  fs.mkdirSync(artifactDir);
  if (prNumber !== undefined) {
    fs.writeFileSync(
      path.join(artifactDir, "pr-comment-meta.json"),
      JSON.stringify({ prNumber, status }),
      "utf8",
    );
  }
  fs.writeFileSync(path.join(artifactDir, "pr-comment.md"), body, "utf8");
  return workspace;
}

function makeContext({ headSha = TRUSTED_SHA } = {}) {
  return {
    repo: { owner: "fossasia", repo: "cla-bot" },
    payload: {
      workflow_run: { head_sha: headSha },
    },
  };
}

function makeCore() {
  const warnings = [];
  const infos = [];
  return {
    warning: (msg) => warnings.push(msg),
    info: (msg) => infos.push(msg),
    warnings,
    infos,
  };
}

// A minimal fake of the octokit surface this script touches.
function makeGithub({ prHeadSha, existingComments = [] } = {}) {
  const calls = {
    pullsGet: [],
    listComments: [],
    updateComment: [],
    createComment: [],
  };
  return {
    calls,
    paginate: async (fn, params) => {
      calls.listComments.push(params);
      return existingComments;
    },
    rest: {
      pulls: {
        get: async (params) => {
          calls.pullsGet.push(params);
          if (prHeadSha === undefined) {
            const err = new Error("Not Found");
            err.status = 404;
            throw err;
          }
          return {
            data: { number: params.pull_number, head: { sha: prHeadSha } },
          };
        },
      },
      issues: {
        listComments: () => {
          throw new Error("should be called via paginate, not directly");
        },
        updateComment: async (params) => {
          calls.updateComment.push(params);
        },
        createComment: async (params) => {
          calls.createComment.push(params);
        },
      },
    },
  };
}

(async () => {
  // --- artifact presence -------------------------------------------------------

  await test("skips cleanly (no throw, no API calls) when the artifact files are missing", async () => {
    const artifactDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "coverage-artifact-empty-"),
    );
    process.env.GITHUB_WORKSPACE = artifactDir;
    const github = makeGithub({ prHeadSha: TRUSTED_SHA });
    const core = makeCore();
    await postCoverageComment({ github, context: makeContext(), core });
    assert.strictEqual(github.calls.pullsGet.length, 0);
    assert.strictEqual(github.calls.createComment.length, 0);
    assert.match(core.warnings[0], /artifact not found/);
  });

  // --- prNumber sanity checks ---------------------------------------------------

  await test("skips when the artifact metadata has no prNumber at all", async () => {
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "coverage-workspace-"),
    );
    const artifactDir = path.join(workspace, "coverage-artifact");
    fs.mkdirSync(artifactDir);
    fs.writeFileSync(
      path.join(artifactDir, "pr-comment-meta.json"),
      JSON.stringify({ status: "pass" }),
      "utf8",
    );
    fs.writeFileSync(path.join(artifactDir, "pr-comment.md"), "body", "utf8");
    process.env.GITHUB_WORKSPACE = workspace;
    const github = makeGithub({ prHeadSha: TRUSTED_SHA });
    const core = makeCore();
    await postCoverageComment({ github, context: makeContext(), core });
    assert.strictEqual(github.calls.pullsGet.length, 0);
    assert.match(core.warnings[0], /No usable pull request number/);
  });

  for (const bad of [0, -1, 1.5, "12", null, NaN]) {
    await test(`skips when the artifact metadata's prNumber is invalid (${JSON.stringify(bad)})`, async () => {
      const workspace = fs.mkdtempSync(
        path.join(os.tmpdir(), "coverage-workspace-"),
      );
      const artifactDir = path.join(workspace, "coverage-artifact");
      fs.mkdirSync(artifactDir);
      fs.writeFileSync(
        path.join(artifactDir, "pr-comment-meta.json"),
        JSON.stringify({ prNumber: bad }),
        "utf8",
      );
      fs.writeFileSync(path.join(artifactDir, "pr-comment.md"), "body", "utf8");
      process.env.GITHUB_WORKSPACE = workspace;
      const github = makeGithub({ prHeadSha: TRUSTED_SHA });
      const core = makeCore();
      await postCoverageComment({ github, context: makeContext(), core });
      assert.strictEqual(github.calls.pullsGet.length, 0);
      assert.match(core.warnings[0], /No usable pull request number/);
    });
  }

  // --- trust boundary: the actual security fix ----------------------------------

  await test("SECURITY: never posts when the candidate PR's real head SHA does not match the trusted workflow_run head SHA (forged/spoofed prNumber)", async () => {
    const artifactDir = makeArtifactDir({ prNumber: 999 });
    process.env.GITHUB_WORKSPACE = artifactDir;
    // The artifact claims PR #999, but PR #999's real head is a totally
    // different commit than the one this workflow run actually tested -
    // exactly what an attacker-controlled artifact would produce.
    const github = makeGithub({ prHeadSha: OTHER_SHA });
    const core = makeCore();
    await postCoverageComment({
      github,
      context: makeContext({ headSha: TRUSTED_SHA }),
      core,
    });
    assert.strictEqual(github.calls.createComment.length, 0);
    assert.strictEqual(github.calls.updateComment.length, 0);
    assert.match(core.warnings[0], /does not match|doesn't match/);
  });

  await test("SECURITY: never posts when the candidate PR's real head SHA matches a STALE run (out-of-order comment jobs)", async () => {
    const artifactDir = makeArtifactDir({ prNumber: 7 });
    process.env.GITHUB_WORKSPACE = artifactDir;
    // This run tested an older commit; the PR has since moved to a newer
    // one. The stale run's job finishing late must not overwrite the
    // sticky comment with outdated results.
    const github = makeGithub({ prHeadSha: "newer-commit-sha" });
    const core = makeCore();
    await postCoverageComment({
      github,
      context: makeContext({ headSha: "older-commit-sha" }),
      core,
    });
    assert.strictEqual(github.calls.createComment.length, 0);
    assert.strictEqual(github.calls.updateComment.length, 0);
  });

  await test("skips (does not throw) when the candidate PR number does not exist (404 from the API)", async () => {
    const artifactDir = makeArtifactDir({ prNumber: 123456 });
    process.env.GITHUB_WORKSPACE = artifactDir;
    const github = makeGithub({ prHeadSha: undefined }); // triggers a 404
    const core = makeCore();
    await postCoverageComment({ github, context: makeContext(), core });
    assert.strictEqual(github.calls.createComment.length, 0);
    assert.match(core.warnings[0], /Could not fetch PR/);
  });

  await test("skips when the triggering workflow_run event has no head_sha to verify against", async () => {
    const artifactDir = makeArtifactDir({ prNumber: 5 });
    process.env.GITHUB_WORKSPACE = artifactDir;
    const github = makeGithub({ prHeadSha: TRUSTED_SHA });
    const core = makeCore();
    const context = {
      repo: { owner: "fossasia", repo: "cla-bot" },
      payload: {},
    };
    await postCoverageComment({ github, context, core });
    assert.strictEqual(github.calls.pullsGet.length, 0);
    assert.match(core.warnings[0], /No head SHA/);
  });

  // --- happy path: legitimate matching PR -----------------------------------------

  await test("posts a new comment when the candidate PR's head SHA matches the trusted workflow_run SHA and no prior comment exists", async () => {
    const artifactDir = makeArtifactDir({ prNumber: 23, body: "## report" });
    process.env.GITHUB_WORKSPACE = artifactDir;
    const github = makeGithub({ prHeadSha: TRUSTED_SHA, existingComments: [] });
    const core = makeCore();
    await postCoverageComment({ github, context: makeContext(), core });

    assert.strictEqual(github.calls.pullsGet.length, 1);
    assert.strictEqual(github.calls.pullsGet[0].pull_number, 23);
    assert.strictEqual(github.calls.createComment.length, 1);
    assert.strictEqual(github.calls.createComment[0].issue_number, 23);
    assert.match(github.calls.createComment[0].body, /cla-bot:coverage-report/);
    assert.match(github.calls.createComment[0].body, /## report/);
    assert.strictEqual(github.calls.updateComment.length, 0);
  });

  await test("updates the existing sticky comment in place instead of creating a new one", async () => {
    const artifactDir = makeArtifactDir({
      prNumber: 23,
      body: "## updated report",
    });
    process.env.GITHUB_WORKSPACE = artifactDir;
    const github = makeGithub({
      prHeadSha: TRUSTED_SHA,
      existingComments: [
        {
          id: 555,
          user: { type: "Bot" },
          body: "<!-- cla-bot:coverage-report -->\nold report",
        },
      ],
    });
    const core = makeCore();
    await postCoverageComment({ github, context: makeContext(), core });

    assert.strictEqual(github.calls.createComment.length, 0);
    assert.strictEqual(github.calls.updateComment.length, 1);
    assert.strictEqual(github.calls.updateComment[0].comment_id, 555);
    assert.match(github.calls.updateComment[0].body, /## updated report/);
  });

  await test("does not mistake a non-Bot comment containing the marker for the sticky comment (never updates a forged human comment)", async () => {
    const artifactDir = makeArtifactDir({ prNumber: 23, body: "## report" });
    process.env.GITHUB_WORKSPACE = artifactDir;
    const github = makeGithub({
      prHeadSha: TRUSTED_SHA,
      existingComments: [
        {
          id: 1,
          user: { type: "User" },
          body: "<!-- cla-bot:coverage-report -->\nforged by a human",
        },
      ],
    });
    const core = makeCore();
    await postCoverageComment({ github, context: makeContext(), core });

    assert.strictEqual(github.calls.updateComment.length, 0);
    assert.strictEqual(github.calls.createComment.length, 1);
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error("\nSOME TESTS FAILED.");
    process.exit(1);
  } else {
    console.log("ALL TESTS PASSED.");
  }
})();
