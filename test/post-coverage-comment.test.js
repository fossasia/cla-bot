"use strict";
/**
 * Offline tests for .github/scripts/post-coverage-comment.js - the
 * privileged (pull-requests: write) script that posts the coverage report
 * as a sticky PR comment. No network: `github` and `core` are in-memory
 * fakes. Run: node test/post-coverage-comment.test.js (also part of
 * `npm test`).
 *
 * The behaviour that matters most here is the TRUST BOUNDARY. The report
 * artifact comes from a job that ran the PR's own test code, so these
 * tests check that nothing in it can redirect the comment to another
 * issue, revive a stale run, or smuggle in notifications.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const postComment = require("../.github/scripts/post-coverage-comment.js");
const {
  resolveTrustedPullRequest,
  neutralizeMentions,
  readReport,
  gateChangeNotice,
  isGateFile,
  NOTICE_RESERVE,
  MARKER,
  BOT_LOGIN,
  MAX_REPORT_BYTES,
  MAX_COMMENT_LENGTH,
} = postComment;

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

const SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const OTHER_SHA = "cafebabecafebabecafebabecafebabecafebabe";

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
function makeGithub({
  prs = {}, // pull_number -> live PR object, for pulls.get
  openPrs = [], // what pulls.list returns
  comments = [],
  getError,
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
          return { data: prs[params.pull_number] };
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
        id: 1,
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

// --- neutralizeMentions --------------------------------------------------------

test("neutralizeMentions defuses @user and @org/team mentions but keeps the text readable", () => {
  const out = neutralizeMentions("cc @alice and @fossasia/maintainers, thanks");
  assert.ok(!/@(?=[A-Za-z0-9])/.test(out), "no live mention may remain");
  assert.strictEqual(
    out.replace(/\u200b/g, ""),
    "cc @alice and @fossasia/maintainers, thanks",
  );
});

test("neutralizeMentions leaves a bare @ and non-mention text alone", () => {
  assert.strictEqual(
    neutralizeMentions("a @ b, @-x, 100%"),
    "a @ b, @-x, 100%",
  );
});

test("neutralizeMentions handles back-to-back @ characters", () => {
  assert.strictEqual(neutralizeMentions("@@x"), "@@\u200bx");
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

test("resolveTrustedPullRequest finds a fork PR (empty pull_requests) by '<fork owner>:<branch>' and the tested commit", async () => {
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
  assert.strictEqual(calls.pullsList[0].state, "open");
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

test("resolveTrustedPullRequest skips a fork run when no open PR is at the tested commit", async () => {
  const { github } = makeGithub({ openPrs: [openPr(41, OTHER_SHA)] });
  const { core, logs } = makeCore();
  assert.strictEqual(
    await resolveTrustedPullRequest({ github, context: forkContext(), core }),
    null,
  );
  assert.match(logs.warning[0], /found 0/);
});

test("resolveTrustedPullRequest skips a fork run when several open PRs share that branch and commit (ambiguous)", async () => {
  const { github } = makeGithub({ openPrs: [openPr(41), openPr(42)] });
  const { core, logs } = makeCore();
  assert.strictEqual(
    await resolveTrustedPullRequest({ github, context: forkContext(), core }),
    null,
  );
  assert.match(logs.warning[0], /found 2/);
});

test("resolveTrustedPullRequest skips a PR that is no longer open", async () => {
  const { github } = makeGithub({
    prs: { 7: openPr(7, SHA, { state: "closed" }) },
  });
  const { core, logs } = makeCore();
  assert.strictEqual(
    await resolveTrustedPullRequest({ github, context: samePrContext(), core }),
    null,
  );
  assert.match(logs.info[0], /no longer open/);
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
      ...calls.listComments,
      ...calls.createComment,
      ...calls.updateComment,
    ]) {
      assert.notStrictEqual(call.pull_number ?? call.issue_number, 999);
    }
  });
});

test("posts a new sticky comment (marker first, mentions defused) on a fork PR found by branch + commit", async () => {
  await withTmpDir(async (dir) => {
    writeArtifact(dir, "## Report\nping @victim and @org/team");
    const { github, calls } = makeGithub({ openPrs: [openPr(42)] });
    const { core, logs } = makeCore();

    await run(dir, { github, context: forkContext(), core });

    assert.strictEqual(calls.createComment.length, 1);
    const { issue_number, body } = calls.createComment[0];
    assert.strictEqual(issue_number, 42);
    assert.ok(body.startsWith(`${MARKER}\n`));
    assert.ok(!/@(?=[A-Za-z0-9])/.test(body), "mentions must be defused");
    assert.match(
      logs.info.join("\n"),
      /Posted a new coverage comment on PR #42/,
    );
  });
});

test("updates our existing sticky comment instead of posting a second one", async () => {
  await withTmpDir(async (dir) => {
    writeArtifact(dir, "fresh report");
    const { github, calls } = makeGithub({
      prs: { 7: openPr(7) },
      comments: [
        { id: 555, user: { login: BOT_LOGIN }, body: `${MARKER}\nold report` },
      ],
    });
    const { core, logs } = makeCore();

    await run(dir, { github, context: samePrContext(), core });

    assert.strictEqual(calls.createComment.length, 0);
    assert.strictEqual(calls.updateComment.length, 1);
    assert.strictEqual(calls.updateComment[0].comment_id, 555);
    assert.strictEqual(calls.updateComment[0].body, `${MARKER}\nfresh report`);
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

test("skips (and makes no API call at all) when the artifact is missing", async () => {
  await withTmpDir(async (dir) => {
    const { github, calls } = makeGithub({ prs: { 7: openPr(7) } });
    const { core, logs } = makeCore();

    await run(dir, { github, context: samePrContext(), core });

    assert.strictEqual(logs.warning.length, 1);
    assert.deepStrictEqual(
      Object.values(calls).map((c) => c.length),
      [0, 0, 0, 0, 0, 0],
    );
  });
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

test("skips a report too long for a GitHub comment, before touching the API", async () => {
  await withTmpDir(async (dir) => {
    writeArtifact(dir, "x".repeat(MAX_COMMENT_LENGTH - NOTICE_RESERVE));
    const { github, calls } = makeGithub({ prs: { 7: openPr(7) } });
    const { core, logs } = makeCore();
    await run(dir, { github, context: samePrContext(), core });
    assert.match(logs.warning[0], /over GitHub's comment limit/);
    assert.strictEqual(calls.pullsGet.length, 0);
    assert.strictEqual(calls.createComment.length, 0);
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
    "package.json",
    "package-lock.json",
    ".github/CODEOWNERS",
    ".github/workflows/coverage.yml",
    ".github/workflows/coverage-comment.yml",
    ".github/scripts/coverage-report.js",
    ".github/scripts/anything-new.js",
  ]) {
    assert.strictEqual(isGateFile(name), true, name);
  }
  for (const name of [
    "src/cla-bot.js",
    "test/logic.test.js",
    "README.md",
    ".github/workflows/ci.yml",
    "docs/package.json",
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
        { filename: ".github/scripts/coverage-report.js" },
      ],
    });
    const { core } = makeCore();

    await run(dir, { github, context: samePrContext(), core });

    assert.deepStrictEqual(calls.listFiles, [
      { owner: "fossasia", repo: "cla-bot", pull_number: 7, per_page: 100 },
    ]);
    const { body } = calls.createComment[0];
    assert.ok(body.startsWith(`${MARKER}\n> [!WARNING]\n`));
    assert.match(body, /changes files that define the coverage gate/);
    assert.match(
      body,
      /> - `\.c8rc\.json`\n> - `\.github\/scripts\/coverage-report\.js`/,
    );
    assert.ok(!body.includes("src/cla-bot.js"));
    assert.ok(body.endsWith("\n\n## Report body"));
  });
});

test("no warning (body is exactly marker + report) when the PR touches no gate file", async () => {
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
    assert.strictEqual(
      calls.createComment[0].body,
      `${MARKER}\n## Report body`,
    );
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
  assert.strictEqual((notice.match(/^> - `/gm) || []).length, 10);
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
      assert.ok(body.endsWith("## Report body"));
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
