"use strict";
/** Tests report validation and safe posting of coverage comments. */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const yaml = require("js-yaml");

const postComment = require("../.github/scripts/post-coverage-comment.js");
const {
  resolveTrustedPullRequest,
  sanitizeReport,
  readReport,
  gateChangeNotice,
  isGateFile,
  isSupersededBy,
  runOrder,
  commitFooter,
  unavailableReport,
  UNAVAILABLE_MARKER,
  MARKER,
  BOT_LOGIN,
  MAX_REPORT_BYTES,
  MAX_COMMENT_LENGTH,
  NOTICE_RESERVE,
  MAX_LISTED_GATE_FILES,
  MAX_NAME_LENGTH,
} = postComment;

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

const SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const OTHER_SHA = "cafebabecafebabecafebabecafebabecafebabe";
const RUN_CREATED = "2026-10-04T10:00:00Z";
const BEFORE_RUN = "2026-10-01T00:00:00Z";
const AFTER_RUN = "2026-10-04T10:05:00Z";

async function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cla-bot-post-comment-"));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Sets (or, for undefined, removes) environment variables for the duration
// of fn and puts every one of them back exactly as it was - a plain
// `process.env.X = previous` would turn an unset variable into the literal
// string "undefined".
async function withEnv(vars, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function makeCore() {
  const logs = { warning: [], info: [] };
  return {
    logs,
    core: {
      warning: (m) => logs.warning.push(m),
      info: (m) => logs.info.push(m),
    },
  };
}

// Mirrors the slice of the Octokit surface the script uses. `paginate`
// behaves like actions/github-script's: it calls the endpoint function it
// is handed and returns the flattened array of items.
//
// pulls.get answers from `prs` (pull_number -> PR object), falling back to
// `openPrs`. A value that is an ARRAY is a sequence of answers, one per
// call (the last one repeats), which is how the tests model "the PR's head
// moved between two reads".
function makeGithub({
  prs = {},
  openPrs = [], // what pulls.list returns
  comments = [],
  getError, // pulls.get always rejects with this
  getErrorOnCall, // pulls.get rejects only on this (1-based) call
  files = [], // what pulls.listFiles returns
  filesError,
} = {}) {
  const calls = {
    pullsGet: [],
    pullsList: [],
    listFiles: [],
    listComments: [],
    createComment: [],
    updateComment: [],
  };
  const github = {
    paginate: async (fn, params) => (await fn(params)).data,
    rest: {
      pulls: {
        get: async (params) => {
          calls.pullsGet.push(params);
          if (getError !== undefined) throw getError;
          if (getErrorOnCall === calls.pullsGet.length) {
            throw new Error("transient failure");
          }
          let answer =
            prs[params.pull_number] ??
            openPrs.find((p) => p.number === params.pull_number);
          if (Array.isArray(answer)) {
            const index = Math.min(
              calls.pullsGet.length - 1,
              answer.length - 1,
            );
            answer = answer[index];
          }
          return { data: answer };
        },
        list: async (params) => {
          calls.pullsList.push(params);
          return { data: openPrs };
        },
        listFiles: async (params) => {
          calls.listFiles.push(params);
          if (filesError !== undefined) throw filesError;
          return { data: files };
        },
      },
      issues: {
        listComments: async (params) => {
          calls.listComments.push(params);
          return { data: comments };
        },
        createComment: async (params) => {
          calls.createComment.push(params);
          return { data: {} };
        },
        updateComment: async (params) => {
          calls.updateComment.push(params);
          return { data: {} };
        },
      },
    },
  };
  return { github, calls };
}

const repoCtx = { owner: "fossasia", repo: "cla-bot" };

function samePrContext(overrides = {}) {
  return {
    repo: repoCtx,
    payload: {
      workflow_run: {
        id: 5,
        run_attempt: 1,
        created_at: RUN_CREATED,
        head_sha: SHA,
        head_branch: "feature",
        head_repository: { owner: { login: "fossasia" } },
        pull_requests: [{ number: 7 }],
        ...overrides,
      },
    },
  };
}

function forkContext(overrides = {}) {
  return samePrContext({
    head_branch: "my-fix",
    head_repository: { owner: { login: "contributor" } },
    pull_requests: [], // GitHub leaves this empty for fork PRs
    ...overrides,
  });
}

const openPr = (number, sha = SHA, extra = {}) => ({
  number,
  state: "open",
  created_at: BEFORE_RUN,
  head: { sha },
  ...extra,
});

function writeArtifact(workspace, body, extraFiles = {}) {
  const dir = path.join(workspace, "coverage-artifact");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "pr-comment.md"), body);
  for (const [name, content] of Object.entries(extraFiles)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

function run(workspace, { github, context, core }) {
  return withEnv({ GITHUB_WORKSPACE: workspace }, () =>
    postComment({ github, context, core }),
  );
}

const ourComment = (id, body) => ({ id, user: { login: BOT_LOGIN }, body });
const tagged = (number, attempt, rest = "report") =>
  `${MARKER}\n<!-- cla-bot:coverage-run ${number}.${attempt} -->\n${rest}`;

// A comment exactly as the script writes it: marker, run tag, FULL-SHA tag.
const taggedAt = (sha, rest = "report", number = 5, attempt = 1) =>
  `${MARKER}\n<!-- cla-bot:coverage-run ${number}.${attempt} -->\n<!-- cla-bot:coverage-sha ${sha} -->\n${rest}`;

// --- sanitizeReport ---------------------------------------------------------------

test("sanitizeReport defuses @user and @org/team mentions but keeps the text readable", () => {
  const out = sanitizeReport("cc @alice and @fossasia/maintainers, thanks");
  assert.ok(!/@(?=[A-Za-z0-9])/.test(out), "no live mention may remain");
  assert.strictEqual(
    out.replace(/\u200b/g, ""),
    "cc @alice and @fossasia/maintainers, thanks",
  );
});

test("sanitizeReport leaves a bare @ and non-mention text alone", () => {
  assert.strictEqual(sanitizeReport("a @ b, @-x, 100%"), "a @ b, @-x, 100%");
});

test("sanitizeReport handles back-to-back @ characters", () => {
  assert.strictEqual(sanitizeReport("@@x"), "@@\u200bx");
});

test("sanitizeReport splits every HTML comment opener so the report can't hide content or fake our tags", () => {
  const out = sanitizeReport(
    "a <!-- hidden --> b <!-- cla-bot:coverage-run 999999.1 --> c",
  );
  assert.ok(!out.includes("<!--"));
  assert.strictEqual(
    out.replace(/\u200b/g, ""),
    "a <!-- hidden --> b <!-- cla-bot:coverage-run 999999.1 --> c",
  );
});

// --- readReport -------------------------------------------------------------------

test("readReport returns the file's text for a normal report", async () => {
  await withTmpDir((dir) => {
    const file = path.join(dir, "r.md");
    fs.writeFileSync(file, "hello");
    const { core, logs } = makeCore();
    assert.strictEqual(readReport(file, core), "hello");
    assert.strictEqual(logs.warning.length, 0);
  });
});

test("readReport warns and returns null when the file is missing", async () => {
  await withTmpDir((dir) => {
    const { core, logs } = makeCore();
    assert.strictEqual(readReport(path.join(dir, "nope.md"), core), null);
    assert.match(logs.warning[0], /not found/);
  });
});

test("readReport refuses a symlink instead of following it", async () => {
  await withTmpDir((dir) => {
    const target = path.join(dir, "secret.txt");
    fs.writeFileSync(target, "runner secret");
    const link = path.join(dir, "r.md");
    fs.symlinkSync(target, link);
    const { core, logs } = makeCore();
    assert.strictEqual(readReport(link, core), null);
    assert.match(logs.warning[0], /not a regular file/);
  });
});

test("readReport refuses a directory", async () => {
  await withTmpDir((dir) => {
    const { core, logs } = makeCore();
    assert.strictEqual(readReport(dir, core), null);
    assert.match(logs.warning[0], /not a regular file/);
  });
});

test("readReport refuses a file over the size limit", async () => {
  await withTmpDir((dir) => {
    const file = path.join(dir, "r.md");
    fs.writeFileSync(file, "x".repeat(MAX_REPORT_BYTES + 1));
    const { core, logs } = makeCore();
    assert.strictEqual(readReport(file, core), null);
    assert.match(logs.warning[0], /over the .* limit/);
  });
});

// --- runOrder / isSupersededBy / commitFooter ----------------------------------------------

test("runOrder reads the trusted run ID and attempt, defaulting the attempt to 1", () => {
  assert.deepStrictEqual(runOrder({ id: 5, run_attempt: 2 }), {
    number: 5,
    attempt: 2,
  });
  assert.deepStrictEqual(runOrder({ id: "7" }), {
    number: 7,
    attempt: 1,
  });
});

test("runOrder returns null for missing or unusable values (so no tag and no ordering guard)", () => {
  for (const bad of [
    {},
    { id: 0 },
    { id: -3 },
    { id: 1.5 },
    { id: "abc" },
    { id: 5, run_attempt: 0 },
    { id: 5, run_attempt: "x" },
    { id: 2 ** 60 },
  ]) {
    assert.strictEqual(runOrder(bad), null, JSON.stringify(bad));
  }
});

test("isSupersededBy is true only when the existing comment is from a strictly newer run/attempt", () => {
  const order = { number: 5, attempt: 2 };
  assert.strictEqual(isSupersededBy(tagged(6, 1), order), true);
  assert.strictEqual(isSupersededBy(tagged(5, 3), order), true);
  assert.strictEqual(isSupersededBy(tagged(5, 2), order), false);
  assert.strictEqual(isSupersededBy(tagged(5, 1), order), false);
  assert.strictEqual(isSupersededBy(tagged(4, 9), order), false);
});

test("isSupersededBy ignores bodies without our tag at the very top, and ignores everything when this run has no order", () => {
  const order = { number: 5, attempt: 1 };
  assert.strictEqual(isSupersededBy(undefined, order), false);
  assert.strictEqual(isSupersededBy(null, order), false);
  assert.strictEqual(
    isSupersededBy(`${MARKER}\nold untagged report`, order),
    false,
  );
  // A tag buried below the top (e.g. injected through the report) is not read.
  assert.strictEqual(
    isSupersededBy(
      `${MARKER}\ntext\n<!-- cla-bot:coverage-run 99.1 -->`,
      order,
    ),
    false,
  );
  assert.strictEqual(isSupersededBy(tagged(99, 1), null), false);
});

test("commitFooter shows the 7-character commit, and nothing for a malformed SHA", () => {
  assert.match(
    commitFooter({ head_sha: SHA }),
    /Measured at commit `deadbee`\./,
  );
  assert.strictEqual(commitFooter({ head_sha: "not-a-sha" }), "");
});

// --- resolveTrustedPullRequest ----------------------------------------------------

test("resolveTrustedPullRequest returns the live PR for a same-repo run linked to exactly one PR", async () => {
  const { github, calls } = makeGithub({ prs: { 7: openPr(7) } });
  const { core, logs } = makeCore();
  const pr = await resolveTrustedPullRequest({
    github,
    context: samePrContext(),
    core,
  });
  assert.strictEqual(pr.number, 7);
  assert.deepStrictEqual(calls.pullsGet, [
    { owner: "fossasia", repo: "cla-bot", pull_number: 7 },
  ]);
  assert.strictEqual(calls.pullsList.length, 0);
  assert.strictEqual(logs.warning.length, 0);
});

test("resolveTrustedPullRequest finds a fork PR (empty pull_requests) by '<fork owner>:<branch>' among ALL PRs and the tested commit", async () => {
  const { github, calls } = makeGithub({
    openPrs: [openPr(41, OTHER_SHA), openPr(42, SHA)],
  });
  const { core } = makeCore();
  const pr = await resolveTrustedPullRequest({
    github,
    context: forkContext(),
    core,
  });
  assert.strictEqual(pr.number, 42);
  assert.strictEqual(calls.pullsGet.length, 0);
  assert.strictEqual(calls.pullsList[0].head, "contributor:my-fix");
  assert.strictEqual(calls.pullsList[0].state, "all");
});

test("resolveTrustedPullRequest treats a missing pull_requests field like an empty one", async () => {
  const { github } = makeGithub({ openPrs: [openPr(42)] });
  const { core } = makeCore();
  const context = forkContext();
  delete context.payload.workflow_run.pull_requests;
  const pr = await resolveTrustedPullRequest({ github, context, core });
  assert.strictEqual(pr.number, 42);
});

test("resolveTrustedPullRequest skips (never guesses) when the run is linked to more than one PR", async () => {
  const { github, calls } = makeGithub();
  const { core, logs } = makeCore();
  const pr = await resolveTrustedPullRequest({
    github,
    context: samePrContext({ pull_requests: [{ number: 7 }, { number: 8 }] }),
    core,
  });
  assert.strictEqual(pr, null);
  assert.strictEqual(logs.warning.length, 1);
  assert.strictEqual(calls.pullsGet.length + calls.pullsList.length, 0);
});

test("resolveTrustedPullRequest skips when the linked PR can't be fetched (Error and non-Error rejections)", async () => {
  for (const getError of [new Error("Not Found"), "boom"]) {
    const { github } = makeGithub({ getError });
    const { core, logs } = makeCore();
    const pr = await resolveTrustedPullRequest({
      github,
      context: samePrContext(),
      core,
    });
    assert.strictEqual(pr, null);
    assert.match(logs.warning[0], /Could not fetch PR #7/);
    assert.match(logs.warning[0], /Not Found|boom/);
  }
});

test("resolveTrustedPullRequest skips a fork run that has no head owner or no head branch to look up", async () => {
  const noOwner = forkContext({ head_repository: {} });
  const noRepo = forkContext({ head_repository: null });
  const noBranch = forkContext({ head_branch: null });
  for (const context of [noOwner, noRepo, noBranch]) {
    const { github, calls } = makeGithub();
    const { core, logs } = makeCore();
    assert.strictEqual(
      await resolveTrustedPullRequest({ github, context, core }),
      null,
    );
    assert.match(logs.warning[0], /no linked pull request/);
    assert.strictEqual(calls.pullsList.length, 0);
  }
});

test("resolveTrustedPullRequest skips a fork run when no PR is at the tested commit", async () => {
  const { github } = makeGithub({ openPrs: [openPr(41, OTHER_SHA)] });
  const { core, logs } = makeCore();
  assert.strictEqual(
    await resolveTrustedPullRequest({ github, context: forkContext(), core }),
    null,
  );
  assert.match(logs.warning[0], /found 0/);
});

test("resolveTrustedPullRequest skips a fork run when several PRs share that branch and commit (ambiguous)", async () => {
  const { github } = makeGithub({ openPrs: [openPr(41), openPr(42)] });
  const { core, logs } = makeCore();
  assert.strictEqual(
    await resolveTrustedPullRequest({ github, context: forkContext(), core }),
    null,
  );
  assert.match(logs.warning[0], /found 2/);
});

// The reviewed lifecycle bug: old PR closes -> a NEW PR reuses the same fork
// branch and exact same commit -> the old run finishes. The old run must not
// be attached to the new PR.
test("fork PR lifecycle: an old run is NOT attached to a later PR that reuses the same fork branch and commit", async () => {
  const { github } = makeGithub({
    openPrs: [
      openPr(41, SHA, { state: "closed", created_at: BEFORE_RUN }),
      openPr(42, SHA, { created_at: AFTER_RUN }), // opened after the run started
    ],
  });
  const { core, logs } = makeCore();
  assert.strictEqual(
    await resolveTrustedPullRequest({ github, context: forkContext(), core }),
    null,
  );
  // Only the old (closed) PR existed when the run started, so that is the
  // one candidate - and it is closed, so nothing is posted anywhere.
  assert.match(logs.info[0], /PR #41 is no longer open/);
  assert.strictEqual(logs.warning.length, 0);
});

test("fork PR lifecycle: a PR created after the run started is never its target, even with no other PR", async () => {
  const { github } = makeGithub({
    openPrs: [openPr(42, SHA, { created_at: AFTER_RUN })],
  });
  const { core, logs } = makeCore();
  assert.strictEqual(
    await resolveTrustedPullRequest({ github, context: forkContext(), core }),
    null,
  );
  assert.match(logs.warning[0], /found 0/);
});

test("fork PR lifecycle: if the old PR is closed and was the only PR at that commit, the run is skipped, not retargeted", async () => {
  const { github } = makeGithub({
    openPrs: [openPr(41, SHA, { state: "closed" })],
  });
  const { core, logs } = makeCore();
  assert.strictEqual(
    await resolveTrustedPullRequest({ github, context: forkContext(), core }),
    null,
  );
  assert.match(logs.info[0], /no longer open/);
});

test("fork PR lifecycle: a closed PR that existed at the run's start still makes a second one ambiguous", async () => {
  const { github } = makeGithub({
    openPrs: [
      openPr(41, SHA, { state: "closed" }),
      openPr(42, SHA, { created_at: BEFORE_RUN }),
    ],
  });
  const { core, logs } = makeCore();
  assert.strictEqual(
    await resolveTrustedPullRequest({ github, context: forkContext(), core }),
    null,
  );
  assert.match(logs.warning[0], /found 2/);
});

test("fork PR lifecycle: a PR created in the same instant as the run is accepted, a missing or garbled timestamp is not", async () => {
  const same = makeGithub({
    openPrs: [openPr(42, SHA, { created_at: RUN_CREATED })],
  });
  assert.strictEqual(
    (
      await resolveTrustedPullRequest({
        github: same.github,
        context: forkContext(),
        core: makeCore().core,
      })
    ).number,
    42,
  );

  for (const [prCreated, runCreated] of [
    [undefined, RUN_CREATED],
    ["garbage", RUN_CREATED],
    [BEFORE_RUN, undefined],
    [BEFORE_RUN, "garbage"],
  ]) {
    const { github } = makeGithub({
      openPrs: [openPr(42, SHA, { created_at: prCreated })],
    });
    assert.strictEqual(
      await resolveTrustedPullRequest({
        github,
        context: forkContext({ created_at: runCreated }),
        core: makeCore().core,
      }),
      null,
      `${prCreated} / ${runCreated}`,
    );
  }
});

test("same-repo lifecycle: a run linked to a PR that has since been closed is skipped (not moved to a newer PR)", async () => {
  const { github, calls } = makeGithub({
    prs: { 7: openPr(7, SHA, { state: "closed" }) },
    openPrs: [openPr(8, SHA, { created_at: AFTER_RUN })],
  });
  const { core, logs } = makeCore();
  assert.strictEqual(
    await resolveTrustedPullRequest({ github, context: samePrContext(), core }),
    null,
  );
  assert.match(logs.info[0], /no longer open/);
  assert.strictEqual(calls.pullsList.length, 0);
});

test("resolveTrustedPullRequest skips a stale run whose commit has been superseded by a newer push", async () => {
  const { github } = makeGithub({ prs: { 7: openPr(7, OTHER_SHA) } });
  const { core, logs } = makeCore();
  assert.strictEqual(
    await resolveTrustedPullRequest({ github, context: samePrContext(), core }),
    null,
  );
  assert.match(logs.info[0], /superseded/);
});

// --- the full script: trust boundaries ------------------------------------------------

test("posts to the PR GitHub says the run belongs to - an attacker-planted PR number in the artifact is ignored", async () => {
  await withTmpDir(async (dir) => {
    // The artifact (built by PR-controlled code) tries to redirect the
    // comment to unrelated issue #999 using every field it can think of.
    writeArtifact(dir, "report body", {
      "pr-comment-meta.json": JSON.stringify({
        prNumber: 999,
        headSha: SHA,
        pull_request: { number: 999 },
      }),
    });
    const { github, calls } = makeGithub({ prs: { 7: openPr(7) } });
    const { core } = makeCore();

    await run(dir, { github, context: samePrContext(), core });

    assert.strictEqual(calls.createComment.length, 1);
    assert.strictEqual(calls.createComment[0].issue_number, 7);
    for (const call of [
      ...calls.pullsGet,
      ...calls.listFiles,
      ...calls.listComments,
      ...calls.createComment,
      ...calls.updateComment,
    ]) {
      assert.notStrictEqual(call.pull_number ?? call.issue_number, 999);
    }
  });
});

test("posts a new sticky comment (marker, run tag, mentions defused, commit footer) on a fork PR found by branch + commit", async () => {
  await withTmpDir(async (dir) => {
    writeArtifact(dir, "## Report\nping @victim and @org/team");
    const { github, calls } = makeGithub({ openPrs: [openPr(42)] });
    const { core, logs } = makeCore();

    await run(dir, { github, context: forkContext(), core });

    assert.strictEqual(calls.createComment.length, 1);
    const { issue_number, body } = calls.createComment[0];
    assert.strictEqual(issue_number, 42);
    assert.ok(
      body.startsWith(`${MARKER}\n<!-- cla-bot:coverage-run 5.1 -->\n`),
    );
    assert.ok(!/@(?=[A-Za-z0-9])/.test(body), "mentions must be defused");
    assert.ok(body.endsWith("\n\n<sub>Measured at commit `deadbee`.</sub>"));
    assert.match(
      logs.info.join("\n"),
      /Posted a new coverage comment on PR #42/,
    );
  });
});

test("a forged run tag inside the report can neither be parsed as ours nor block a later run", async () => {
  await withTmpDir(async (dir) => {
    writeArtifact(dir, "report\n<!-- cla-bot:coverage-run 999999.1 -->\nmore");
    const { github, calls } = makeGithub({ prs: { 7: openPr(7) } });
    await run(dir, { github, context: samePrContext(), core: makeCore().core });

    const { body } = calls.createComment[0];
    assert.strictEqual(
      (body.match(/<!-- cla-bot:coverage-run/g) || []).length,
      1,
    );
    assert.strictEqual(isSupersededBy(body, { number: 6, attempt: 1 }), false);
    assert.strictEqual(isSupersededBy(body, { number: 4, attempt: 1 }), true);
  });
});

test("updates our existing sticky comment instead of posting a second one", async () => {
  await withTmpDir(async (dir) => {
    writeArtifact(dir, "fresh report");
    const { github, calls } = makeGithub({
      prs: { 7: openPr(7) },
      comments: [ourComment(555, `${MARKER}\nold report`)],
    });
    const { core, logs } = makeCore();

    await run(dir, { github, context: samePrContext(), core });

    assert.strictEqual(calls.createComment.length, 0);
    assert.strictEqual(calls.updateComment.length, 1);
    assert.strictEqual(calls.updateComment[0].comment_id, 555);
    assert.strictEqual(
      calls.updateComment[0].body,
      `${MARKER}\n<!-- cla-bot:coverage-run 5.1 -->\n<!-- cla-bot:coverage-sha deadbeefdeadbeefdeadbeefdeadbeefdeadbeef -->\nfresh report\n\n<sub>Measured at commit \`deadbee\`.</sub>`,
    );
    assert.match(
      logs.info.join("\n"),
      /Updated existing coverage comment \(id 555\)/,
    );
  });
});

test("never edits a comment that merely quotes the marker unless the github-actions bot wrote it", async () => {
  await withTmpDir(async (dir) => {
    writeArtifact(dir, "fresh report");
    const { github, calls } = makeGithub({
      prs: { 7: openPr(7) },
      comments: [
        { id: 1, user: { login: "mallory", type: "User" }, body: MARKER },
        {
          id: 2,
          user: { login: "dependabot[bot]", type: "Bot" },
          body: MARKER,
        },
        { id: 3, user: null, body: MARKER },
        { id: 4, user: { login: BOT_LOGIN }, body: null },
        { id: 5, user: { login: BOT_LOGIN }, body: "some other bot comment" },
      ],
    });
    const { core } = makeCore();

    await run(dir, { github, context: samePrContext(), core });

    assert.strictEqual(calls.updateComment.length, 0);
    assert.strictEqual(calls.createComment.length, 1);
  });
});

// --- freshness (TOCTOU) ------------------------------------------------------------------

test("skips posting when the report is stale (a newer push already superseded this run)", async () => {
  await withTmpDir(async (dir) => {
    writeArtifact(dir, "report");
    const { github, calls } = makeGithub({ prs: { 7: openPr(7, OTHER_SHA) } });
    const { core, logs } = makeCore();

    await run(dir, { github, context: samePrContext(), core });

    assert.strictEqual(calls.createComment.length, 0);
    assert.strictEqual(calls.updateComment.length, 0);
    assert.strictEqual(calls.listComments.length, 0);
    assert.ok(logs.info.some((m) => m.includes("superseded")));
  });
});

test("re-checks the PR head right before writing: a push that lands after the first check blocks the write", async () => {
  await withTmpDir(async (dir) => {
    writeArtifact(dir, "report");
    // First read: still at the tested commit. Second read (just before the
    // write): a newer commit has landed.
    const { github, calls } = makeGithub({
      prs: { 7: [openPr(7, SHA), openPr(7, OTHER_SHA)] },
    });
    const { core, logs } = makeCore();

    await run(dir, { github, context: samePrContext(), core });

    assert.strictEqual(calls.pullsGet.length, 2);
    assert.strictEqual(calls.createComment.length, 0);
    assert.strictEqual(calls.updateComment.length, 0);
    assert.ok(logs.info.some((m) => m.includes("superseded")));
  });
});

test("re-checks that the PR is still open right before writing", async () => {
  await withTmpDir(async (dir) => {
    writeArtifact(dir, "report");
    const { github, calls } = makeGithub({
      prs: { 7: [openPr(7), openPr(7, SHA, { state: "closed" })] },
    });
    const { core, logs } = makeCore();
    await run(dir, { github, context: samePrContext(), core });
    assert.strictEqual(calls.createComment.length, 0);
    assert.ok(logs.info.some((m) => m.includes("no longer open")));
  });
});

test("skips (rather than writing blind) when the pre-write re-check itself fails", async () => {
  await withTmpDir(async (dir) => {
    writeArtifact(dir, "report");
    const { github, calls } = makeGithub({
      prs: { 7: openPr(7) },
      getErrorOnCall: 2,
    });
    const { core, logs } = makeCore();
    await run(dir, { github, context: samePrContext(), core });
    assert.strictEqual(calls.createComment.length, 0);
    assert.strictEqual(calls.updateComment.length, 0);
    assert.match(logs.warning[0], /Could not re-check PR #7/);
    assert.match(logs.warning[0], /transient failure/);
  });
});

test("the pre-write re-check also tolerates a non-Error rejection", async () => {
  await withTmpDir(async (dir) => {
    writeArtifact(dir, "report");
    const { github, calls } = makeGithub({ prs: { 7: openPr(7) } });
    let call = 0;
    const originalGet = github.rest.pulls.get;
    github.rest.pulls.get = async (params) => {
      call += 1;
      if (call === 2) throw "plain string failure";
      return originalGet(params);
    };
    const { core, logs } = makeCore();
    await run(dir, { github, context: samePrContext(), core });
    assert.strictEqual(calls.createComment.length, 0);
    assert.match(logs.warning[0], /plain string failure/);
  });
});

test("an OLDER run never overwrites a comment written by a NEWER run, whatever order the jobs finish in", async () => {
  for (const [existing, expectWrite] of [
    [tagged(6, 1), false], // newer run number
    [tagged(5, 2), false], // same run, later attempt
    [tagged(5, 1), true], // same run and attempt (idempotent refresh)
    [tagged(4, 3), true], // older run
    [`${MARKER}\nuntagged older-format report`, true], // pre-existing comment
    [`${MARKER}\nfoo\n<!-- cla-bot:coverage-run 99.1 -->`, true], // tag not at the top
  ]) {
    await withTmpDir(async (dir) => {
      writeArtifact(dir, "report");
      const { github, calls } = makeGithub({
        prs: { 7: openPr(7) },
        comments: [ourComment(555, existing)],
      });
      const { core, logs } = makeCore();

      await run(dir, { github, context: samePrContext(), core });

      assert.strictEqual(
        calls.updateComment.length,
        expectWrite ? 1 : 0,
        existing,
      );
      if (!expectWrite) {
        assert.ok(logs.info.some((m) => m.includes("newer coverage run")));
        assert.strictEqual(calls.createComment.length, 0);
        // And it never even spends the extra freshness call.
        assert.strictEqual(calls.pullsGet.length, 1);
      }
    });
  }
});

test("a rerun (attempt 2) of the same run replaces the first attempt's comment", async () => {
  await withTmpDir(async (dir) => {
    writeArtifact(dir, "report");
    const { github, calls } = makeGithub({
      prs: { 7: openPr(7) },
      comments: [ourComment(555, tagged(5, 1))],
    });
    await run(dir, {
      github,
      context: samePrContext({ run_attempt: 2 }),
      core: makeCore().core,
    });
    assert.strictEqual(calls.updateComment.length, 1);
    assert.ok(calls.updateComment[0].body.includes("coverage-run 5.2 -->"));
  });
});

test("without a usable run ID the comment is still posted, just untagged and unguarded", async () => {
  await withTmpDir(async (dir) => {
    writeArtifact(dir, "report");
    const { github, calls } = makeGithub({
      prs: { 7: openPr(7) },
      comments: [ourComment(555, tagged(99, 1))],
    });
    await run(dir, {
      github,
      context: samePrContext({ id: undefined }),
      core: makeCore().core,
    });
    assert.strictEqual(calls.updateComment.length, 1);
    assert.ok(
      calls.updateComment[0].body.startsWith(
        `${MARKER}\n<!-- cla-bot:coverage-sha deadbeefdeadbeefdeadbeefdeadbeefdeadbeef -->\nreport`,
      ),
    );
    assert.ok(!calls.updateComment[0].body.includes("coverage-run"));
  });
});

test("a leftover tag from the OLD 'Test Coverage' workflow (run number 23) can't outrank a new CI run ID", async () => {
  await withTmpDir(async (dir) => {
    writeArtifact(dir, "report");
    const { github, calls } = makeGithub({
      prs: { 7: openPr(7) },
      comments: [ourComment(55, tagged(23, 1, "old workflow report"))],
    });
    await run(dir, {
      github,
      context: samePrContext({ id: 25000000000 }),
      core: makeCore().core,
    });
    assert.strictEqual(calls.updateComment.length, 1);
    assert.match(calls.updateComment[0].body, /coverage-run 25000000000\.1/);
  });
});

test("coverage-comment.yml runs the post step even when the artifact download failed (so a missing report is reported, not ignored)", () => {
  const workflow = yaml.load(
    fs.readFileSync(
      path.join(
        __dirname,
        "..",
        ".github",
        "workflows",
        "coverage-comment.yml",
      ),
      "utf8",
    ),
  );
  const steps = workflow.jobs.comment.steps;
  const post = steps.find((st) => /github-script/.test(st.uses || ""));
  assert.ok(post, "the github-script step must exist");
  assert.strictEqual(post.if, undefined, "must not be gated on the download");
  const download = steps.find((st) => /download-artifact/.test(st.uses || ""));
  assert.strictEqual(download["continue-on-error"], true);
});

test("coverage-comment.yml serialises comment jobs per branch (never cancel-in-progress) so two jobs can't interleave read-then-write", () => {
  const workflow = yaml.load(
    fs.readFileSync(
      path.join(
        __dirname,
        "..",
        ".github",
        "workflows",
        "coverage-comment.yml",
      ),
      "utf8",
    ),
  );
  assert.ok(workflow.concurrency, "a concurrency group must exist");
  assert.strictEqual(workflow.concurrency["cancel-in-progress"], false);
  assert.match(
    workflow.concurrency.group,
    /head_repository\.full_name.*head_branch/,
  );
});

// --- the rest of the script flow -----------------------------------------------------------

test("a missing artifact still posts a 'report unavailable' notice (never silence, never a stale 100%)", async () => {
  await withTmpDir(async (dir) => {
    const { github, calls } = makeGithub({ prs: { 7: openPr(7) } });
    const { core, logs } = makeCore();

    await run(dir, {
      github,
      context: samePrContext({
        conclusion: "failure",
        html_url: "https://github.com/fossasia/cla-bot/actions/runs/5",
      }),
      core,
    });

    assert.strictEqual(logs.warning.length, 1);
    assert.match(logs.warning[0], /not found/);
    assert.strictEqual(calls.createComment.length, 1);
    const body = calls.createComment[0].body;
    assert.ok(
      body.startsWith(`${MARKER}\n<!-- cla-bot:coverage-run 5.1 -->\n`),
    );
    assert.ok(body.includes(UNAVAILABLE_MARKER));
    assert.match(body, /report unavailable/);
    assert.match(
      body,
      /conclusion: `failure`\. \[View the workflow run\]\(https:\/\/github\.com\/fossasia\/cla-bot\/actions\/runs\/5\)/,
    );
    assert.match(body, /Measured at commit `deadbee`/);
  });
});

test("a failed commit REPLACES the previous commit's '100%' comment in place with the unavailable notice", async () => {
  await withTmpDir(async (dir) => {
    const { github, calls } = makeGithub({
      prs: { 7: openPr(7) },
      comments: [
        ourComment(
          55,
          tagged(
            4,
            1,
            "## ✅ Test coverage: 100%\n\n<sub>Measured at commit `1247bb2`.</sub>",
          ),
        ),
      ],
    });
    await run(dir, { github, context: samePrContext(), core: makeCore().core });
    assert.strictEqual(calls.createComment.length, 0);
    assert.strictEqual(calls.updateComment.length, 1);
    assert.strictEqual(calls.updateComment[0].comment_id, 55);
    assert.ok(calls.updateComment[0].body.includes(UNAVAILABLE_MARKER));
    assert.ok(!calls.updateComment[0].body.includes("100%"));
  });
});

test("the unavailable notice never replaces a REAL report already posted for the same commit", async () => {
  await withTmpDir(async (dir) => {
    const real = taggedAt(
      SHA,
      "## ✅ Test coverage: 100%\n\n<sub>Measured at commit `deadbee`.</sub>",
    );
    const { github, calls } = makeGithub({
      prs: { 7: openPr(7) },
      comments: [ourComment(55, real)],
    });
    const { core, logs } = makeCore();
    await run(dir, {
      github,
      context: samePrContext({ run_attempt: 2 }),
      core,
    });
    assert.strictEqual(calls.updateComment.length, 0);
    assert.strictEqual(calls.createComment.length, 0);
    assert.ok(logs.info.some((m) => /already holds a real report/.test(m)));
  });
});

test("an unavailable notice for the same commit is itself refreshed (e.g. a re-run that fails differently)", async () => {
  await withTmpDir(async (dir) => {
    const old = taggedAt(
      SHA,
      `${UNAVAILABLE_MARKER}\nold\n\n<sub>Measured at commit \`deadbee\`.</sub>`,
    );
    const { github, calls } = makeGithub({
      prs: { 7: openPr(7) },
      comments: [ourComment(55, old)],
    });
    await run(dir, {
      github,
      context: samePrContext({ run_attempt: 2, conclusion: "timed_out" }),
      core: makeCore().core,
    });
    assert.strictEqual(calls.updateComment.length, 1);
    assert.match(calls.updateComment[0].body, /conclusion: `timed_out`/);
  });
});

test("with a malformed head SHA there is no footer to compare, so the notice still replaces the old comment", async () => {
  await withTmpDir(async (dir) => {
    const { github, calls } = makeGithub({
      prs: { 7: openPr(7, "abc") },
      comments: [ourComment(55, tagged(4, 1, "old report"))],
    });
    await run(dir, {
      github,
      context: samePrContext({ head_sha: "abc" }),
      core: makeCore().core,
    });
    assert.strictEqual(calls.updateComment.length, 1);
    assert.ok(calls.updateComment[0].body.includes(UNAVAILABLE_MARKER));
  });
});

test("a stale run with no report writes nothing (the newer push owns the comment)", async () => {
  await withTmpDir(async (dir) => {
    const { github, calls } = makeGithub({ prs: { 7: openPr(7, OTHER_SHA) } });
    await run(dir, { github, context: samePrContext(), core: makeCore().core });
    assert.strictEqual(calls.createComment.length, 0);
    assert.strictEqual(calls.updateComment.length, 0);
  });
});

test("a footer copied into a report by the PR does not make an old report count as 'real, same commit'", async () => {
  await withTmpDir(async (dir) => {
    // The comment really was measured at OTHER_SHA, but the report text
    // itself contains a forged footer for SHA (the commit now being run).
    const forged = taggedAt(
      OTHER_SHA,
      "## ✅ 100%\n<sub>Measured at commit `deadbee`.</sub>\n\n<sub>Measured at commit `cafebab`.</sub>",
    );
    const { github, calls } = makeGithub({
      prs: { 7: openPr(7) },
      comments: [ourComment(55, forged)],
    });
    await run(dir, {
      github,
      context: samePrContext({ id: 6 }),
      core: makeCore().core,
    });
    assert.strictEqual(calls.updateComment.length, 1);
    assert.ok(calls.updateComment[0].body.includes(UNAVAILABLE_MARKER));
  });
});

test("two commits sharing the same 7-character prefix are told apart by the full SHA", async () => {
  await withTmpDir(async (dir) => {
    const A = "abcdef0" + "1".repeat(33);
    const B = "abcdef0" + "2".repeat(33);
    const { github, calls } = makeGithub({
      prs: { 7: openPr(7, B) },
      comments: [ourComment(55, taggedAt(A, "real report for A"))],
    });
    await run(dir, {
      github,
      context: samePrContext({ id: 6, head_sha: B }),
      core: makeCore().core,
    });
    assert.strictEqual(calls.updateComment.length, 1);
    assert.ok(calls.updateComment[0].body.includes(UNAVAILABLE_MARKER));
    assert.match(calls.updateComment[0].body, new RegExp(`coverage-sha ${B}`));
  });
});

test("the full-SHA tag is only trusted at the very top of the comment", async () => {
  await withTmpDir(async (dir) => {
    const buried = `${MARKER}\nintro\n<!-- cla-bot:coverage-sha ${SHA} -->\nreport`;
    const { github, calls } = makeGithub({
      prs: { 7: openPr(7) },
      comments: [ourComment(55, buried)],
    });
    await run(dir, { github, context: samePrContext(), core: makeCore().core });
    assert.strictEqual(calls.updateComment.length, 1);
  });
});

test("the SHA tag is compared case-insensitively and is written in lowercase", async () => {
  await withTmpDir(async (dir) => {
    const upper = SHA.toUpperCase();
    const { github, calls } = makeGithub({
      prs: { 7: openPr(7, upper) },
      comments: [ourComment(55, taggedAt(SHA, "real"))],
    });
    await run(dir, {
      github,
      context: samePrContext({ head_sha: upper }),
      core: makeCore().core,
    });
    assert.strictEqual(
      calls.updateComment.length,
      0,
      "same commit, real report kept",
    );
    writeArtifact(dir, "fresh");
    const second = makeGithub({ prs: { 7: openPr(7, upper) } });
    await run(dir, {
      github: second.github,
      context: samePrContext({ head_sha: upper }),
      core: makeCore().core,
    });
    assert.ok(
      second.calls.createComment[0].body.includes(`coverage-sha ${SHA} -->`),
    );
  });
});

test("an empty or whitespace-only artifact is 'unavailable', not a successful report", async () => {
  for (const content of ["", "  \n\t\n"]) {
    await withTmpDir(async (dir) => {
      writeArtifact(dir, content);
      const { github, calls } = makeGithub({ prs: { 7: openPr(7) } });
      const { core, logs } = makeCore();
      await run(dir, { github, context: samePrContext(), core });
      assert.match(logs.warning[0], /is empty/);
      assert.strictEqual(calls.createComment.length, 1);
      assert.ok(calls.createComment[0].body.includes(UNAVAILABLE_MARKER));
    });
  }
});

test("runOrder refuses values its own tag pattern could not read back (16-digit id, 7-digit attempt)", () => {
  assert.deepStrictEqual(
    runOrder({ id: 999999999999999, run_attempt: 999999 }),
    {
      number: 999999999999999,
      attempt: 999999,
    },
  );
  assert.strictEqual(runOrder({ id: 1000000000000000 }), null);
  assert.strictEqual(runOrder({ id: 5, run_attempt: 1000000 }), null);
});

test("unavailableReport only echoes a sane conclusion and an https .../actions/runs/<id> link", () => {
  const ok = unavailableReport({
    conclusion: "cancelled",
    html_url: "https://github.com/o/r/actions/runs/123",
  });
  assert.match(
    ok,
    /`cancelled`\. \[View the workflow run\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/123\)/,
  );
  for (const html_url of [
    undefined,
    "http://github.com/o/r/actions/runs/1",
    "https://github.com/o/r/actions/runs/1)[x](https://evil",
    "https://evil.example/o/r/pull/1",
  ]) {
    const out = unavailableReport({ conclusion: "failure", html_url });
    assert.ok(!out.includes("View the workflow run"), String(html_url));
  }
  for (const conclusion of [undefined, "FAIL<script>", "`x`", "a".repeat(31)]) {
    const out = unavailableReport({ conclusion });
    assert.match(out, /conclusion: `unknown`/);
    assert.ok(!out.includes("<script>"));
  }
});

test("skips when the event has no workflow_run or no head SHA to verify against", async () => {
  await withTmpDir(async (dir) => {
    writeArtifact(dir, "report");
    for (const context of [
      { repo: repoCtx, payload: {} },
      samePrContext({ head_sha: undefined }),
    ]) {
      const { github, calls } = makeGithub({ prs: { 7: openPr(7) } });
      const { core, logs } = makeCore();
      await run(dir, { github, context, core });
      assert.match(logs.warning[0], /No workflow_run head SHA/);
      assert.strictEqual(calls.createComment.length, 0);
      assert.strictEqual(calls.pullsGet.length, 0);
    }
  });
});

test("skips (never guesses a target) when the run is linked to more than one PR", async () => {
  await withTmpDir(async (dir) => {
    writeArtifact(dir, "report");
    const { github, calls } = makeGithub({ prs: { 7: openPr(7) } });
    const { core } = makeCore();
    await run(dir, {
      github,
      context: samePrContext({ pull_requests: [{ number: 7 }, { number: 8 }] }),
      core,
    });
    assert.strictEqual(calls.createComment.length, 0);
    assert.strictEqual(calls.listComments.length, 0);
  });
});

test("a report too long for a GitHub comment (leaving room for what we add) is replaced by the unavailable notice", async () => {
  await withTmpDir(async (dir) => {
    writeArtifact(dir, "x".repeat(MAX_COMMENT_LENGTH - NOTICE_RESERVE + 1));
    const { github, calls } = makeGithub({ prs: { 7: openPr(7) } });
    const { core, logs } = makeCore();
    await run(dir, { github, context: samePrContext(), core });
    assert.match(logs.warning[0], /over GitHub's comment limit/);
    // too long to post, so the notice goes up instead of nothing at all
    assert.strictEqual(calls.createComment.length, 1);
    assert.ok(calls.createComment[0].body.includes(UNAVAILABLE_MARKER));
  });
});

test("falls back to the current directory when GITHUB_WORKSPACE is unset", async () => {
  await withTmpDir(async (dir) => {
    writeArtifact(dir, "report");
    const { github, calls } = makeGithub({ prs: { 7: openPr(7) } });
    const { core } = makeCore();
    const previous = process.cwd();
    process.chdir(dir);
    try {
      await withEnv({ GITHUB_WORKSPACE: undefined }, () =>
        postComment({ github, context: samePrContext(), core }),
      );
    } finally {
      process.chdir(previous);
    }
    assert.strictEqual(calls.createComment.length, 1);
  });
});

// --- gate-change notice ------------------------------------------------------------------

test("isGateFile matches the files that define the gate and nothing else", () => {
  for (const name of [
    ".c8rc.json",
    "action.yml",
    "package.json",
    "package-lock.json",
    ".github/workflows/ci.yml",
    ".github/workflows/coverage.yml",
    ".github/workflows/coverage-comment.yml",
    ".github/workflows/anything-new.yml",
    ".github/rulesets/main.json",
    ".github/scripts/coverage-report.js",
    ".github/scripts/anything-new.js",
  ]) {
    assert.strictEqual(isGateFile(name), true, name);
  }
  for (const name of [
    "src/cla-bot.js",
    "test/logic.test.js",
    "README.md",
    ".github/dependabot.yml",
    ".github/PULL_REQUEST_TEMPLATE.md",
    "docs/package.json",
    "examples/action.yml",
  ]) {
    assert.strictEqual(isGateFile(name), false, name);
  }
});

test("a PR that touches gate files gets a warning ABOVE the report, built from the API's file list", async () => {
  await withTmpDir(async (dir) => {
    writeArtifact(dir, "## Report body");
    const { github, calls } = makeGithub({
      prs: { 7: openPr(7) },
      files: [
        { filename: "src/cla-bot.js" },
        { filename: ".c8rc.json" },
        { filename: "action.yml" },
        { filename: ".github/scripts/coverage-report.js" },
      ],
    });
    const { core } = makeCore();

    await run(dir, { github, context: samePrContext(), core });

    assert.deepStrictEqual(calls.listFiles, [
      { owner: "fossasia", repo: "cla-bot", pull_number: 7, per_page: 100 },
    ]);
    const { body } = calls.createComment[0];
    assert.ok(
      body.startsWith(
        `${MARKER}\n<!-- cla-bot:coverage-run 5.1 -->\n<!-- cla-bot:coverage-sha ${SHA} -->\n> [!WARNING]\n`,
      ),
    );
    assert.match(body, /changes files that define the coverage gate/);
    assert.match(
      body,
      /> - `\.c8rc\.json`\n> - `\.github\/scripts\/coverage-report\.js`\n> - `action\.yml`/,
    );
    assert.ok(!body.includes("src/cla-bot.js"));
    assert.match(body, /\n\n## Report body\n\n<sub>Measured at commit/);
  });
});

test("no warning when the PR touches no gate file", async () => {
  await withTmpDir(async (dir) => {
    writeArtifact(dir, "## Report body");
    const { github, calls } = makeGithub({
      prs: { 7: openPr(7) },
      files: [
        { filename: "src/cla-bot.js" },
        { filename: "test/logic.test.js" },
      ],
    });
    const { core } = makeCore();
    await run(dir, { github, context: samePrContext(), core });
    assert.ok(!calls.createComment[0].body.includes("[!WARNING]"));
  });
});

test("a gate file renamed away (only previous_filename matches) is still flagged", async () => {
  const { github } = makeGithub({
    files: [{ filename: "config/old.json", previous_filename: ".c8rc.json" }],
  });
  const { core } = makeCore();
  const notice = await gateChangeNotice({
    github,
    context: samePrContext(),
    core,
    pr: { number: 7 },
  });
  assert.match(notice, /> - `\.c8rc\.json`/);
});

test("the notice lists at most 10 gate files and says how many more there are", async () => {
  const files = Array.from({ length: 13 }, (_, i) => ({
    filename: `.github/scripts/s${String(i).padStart(2, "0")}.js`,
  }));
  const { github } = makeGithub({ files });
  const { core } = makeCore();
  const notice = await gateChangeNotice({
    github,
    context: samePrContext(),
    core,
    pr: { number: 7 },
  });
  assert.strictEqual(
    (notice.match(/^> - `/gm) || []).length,
    MAX_LISTED_GATE_FILES,
  );
  assert.match(notice, /> - \.\.\.and 3 more/);
});

test("file names are sanitised before being echoed (no Markdown/HTML injection via a crafted path)", async () => {
  const { github } = makeGithub({
    files: [{ filename: ".github/scripts/x`<img src=x>\n@victim.js" }],
  });
  const { core } = makeCore();
  const notice = await gateChangeNotice({
    github,
    context: samePrContext(),
    core,
    pr: { number: 7 },
  });
  const line = notice.split("\n").find((l) => l.startsWith("> - `"));
  assert.strictEqual(line, "> - `.github/scripts/x??img?src?x???victim.js`");
});

test("very long file names are truncated, so the notice has a hard upper bound", async () => {
  const files = Array.from({ length: 12 }, (_, i) => ({
    filename: `.github/scripts/${String(i).padStart(2, "0")}${"a".repeat(240)}.js`,
  }));
  const { github } = makeGithub({ files });
  const { core } = makeCore();
  const notice = await gateChangeNotice({
    github,
    context: samePrContext(),
    core,
    pr: { number: 7 },
  });
  for (const line of notice.split("\n").filter((l) => l.startsWith("> - `"))) {
    // "> - `" + name + "...`"
    assert.ok(line.length <= 5 + MAX_NAME_LENGTH + 3 + 1, line.length);
  }
  assert.match(notice, /\.\.\.`$/m);
});

test("worst case: a maximum-size report plus the longest possible notice, tag and footer still fits in one comment", async () => {
  await withTmpDir(async (dir) => {
    const report = "x".repeat(MAX_COMMENT_LENGTH - NOTICE_RESERVE);
    writeArtifact(dir, report);
    const files = Array.from({ length: 40 }, (_, i) => ({
      filename: `.github/scripts/${String(i).padStart(2, "0")}${"a".repeat(240)}.js`,
      previous_filename: `.github/scripts/old-${i}${"b".repeat(240)}.js`,
    }));
    const { github, calls } = makeGithub({ prs: { 7: openPr(7) }, files });
    const { core, logs } = makeCore();

    await run(dir, {
      github,
      context: samePrContext({
        id: 999999999999999,
        run_attempt: 999999,
      }),
      core,
    });

    assert.strictEqual(logs.warning.length, 0, logs.warning.join("\n"));
    assert.strictEqual(calls.createComment.length, 1);
    const { body } = calls.createComment[0];
    assert.ok(body.length <= MAX_COMMENT_LENGTH, body.length);
    const overhead = body.length - report.length;
    assert.ok(
      overhead < NOTICE_RESERVE,
      `our additions (${overhead}) must stay below NOTICE_RESERVE (${NOTICE_RESERVE})`,
    );
  });
});

test("if the file list can't be fetched, the comment still posts - with an explicit 'could not check' warning", async () => {
  for (const filesError of [new Error("rate limited"), "boom"]) {
    await withTmpDir(async (dir) => {
      writeArtifact(dir, "## Report body");
      const { github, calls } = makeGithub({
        prs: { 7: openPr(7) },
        filesError,
      });
      const { core, logs } = makeCore();

      await run(dir, { github, context: samePrContext(), core });

      assert.match(logs.warning[0], /Could not list PR #7's files/);
      assert.match(logs.warning[0], /rate limited|boom/);
      const { body } = calls.createComment[0];
      assert.match(
        body,
        /Could not check whether this PR changes the coverage gate/,
      );
      assert.match(body, /## Report body/);
    });
  }
});

test("the gate-change check is not run for a stale or unresolved PR (no extra API calls)", async () => {
  await withTmpDir(async (dir) => {
    writeArtifact(dir, "report");
    const { github, calls } = makeGithub({ prs: { 7: openPr(7, OTHER_SHA) } });
    const { core } = makeCore();
    await run(dir, { github, context: samePrContext(), core });
    assert.strictEqual(calls.listFiles.length, 0);
  });
});

// --- runner -------------------------------------------------------------------------------

async function runAll() {
  let passed = 0;
  for (const { name, fn } of cases) {
    try {
      await fn();
      console.log(`PASS: ${name}`);
      passed += 1;
    } catch (e) {
      console.error(`FAIL: ${name}\n - ${e.stack}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}/${cases.length} test(s) passed.`);
  if (process.exitCode) {
    console.error("SOME TESTS FAILED.");
  } else {
    console.log("ALL TESTS PASSED.");
  }
}

runAll();
