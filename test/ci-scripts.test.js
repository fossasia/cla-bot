"use strict";
/**
 * Tests for .github/scripts/coverage-report.js and
 * .github/scripts/post-coverage-comment.js - the scripts behind the
 * "Test Coverage" PR-comment mechanism (coverage.yml / coverage-comment.yml).
 *
 * These aren't part of the shipped action (src/cla-bot.js) so they're not
 * counted in the 100%-enforced coverage threshold (.c8rc.json only
 * includes src/**), but the security-sensitive parts - who a privileged
 * comment gets posted to, and whether a report is still fresh - get real
 * tests here regardless.
 *
 * Run: node test/ci-scripts.test.js (also included in `npm run test:ci-scripts`)
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const coverageReport = require("../.github/scripts/coverage-report.js");
const postComment = require("../.github/scripts/post-coverage-comment.js");
const { resolveTrustedPullRequest, MARKER } = postComment;

// Cases are collected first and run sequentially at the bottom of the
// file, rather than executed inline on registration - several of these are
// async (the comment-poster is), and several chdir() into a temp dir, so
// letting them interleave would make them flaky.
const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

let passed = 0;
async function runAll() {
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
}

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cla-bot-coverage-test-"));
}

// --- coverage-report.js: toRanges -------------------------------------

test("toRanges collapses consecutive line numbers into a single range", () => {
  assert.deepStrictEqual(coverageReport.toRanges([10, 11, 12]), ["10-12"]);
});

test("toRanges keeps non-consecutive lines as separate entries", () => {
  assert.deepStrictEqual(coverageReport.toRanges([5, 8, 9, 20]), [
    "5",
    "8-9",
    "20",
  ]);
});

test("toRanges dedupes and sorts unsorted, repeated input", () => {
  assert.deepStrictEqual(coverageReport.toRanges([3, 1, 2, 2, 1]), ["1-3"]);
});

test("toRanges returns an empty array for no lines", () => {
  assert.deepStrictEqual(coverageReport.toRanges([]), []);
});

// --- coverage-report.js: sourceSnippet ----------------------------------

test("sourceSnippet returns the trimmed text of the requested (1-indexed) line", () => {
  const lines = ["const a = 1;", "  if (a) {", "    return a;", "  }"];
  assert.strictEqual(coverageReport.sourceSnippet(lines, 2), "if (a) {");
});

test("sourceSnippet returns null for a line number past the end of the file", () => {
  assert.strictEqual(coverageReport.sourceSnippet(["only one line"], 5), null);
});

// --- coverage-report.js: isFileFullyCovered -----------------------------
// This is the exact bug the reviewer flagged: a file can be 100% on lines,
// branches and functions while still having an uncovered *statement* (two
// statements sharing one line), and the per-file filter has to catch that
// too instead of only checking three of the four metrics.

test("isFileFullyCovered is true only when every one of the four metrics is 100%", () => {
  const full = {
    lines: { pct: 100 },
    statements: { pct: 100 },
    branches: { pct: 100 },
    functions: { pct: 100 },
  };
  assert.strictEqual(coverageReport.isFileFullyCovered(full), true);
});

test("isFileFullyCovered is false when only statements is below 100%, even if lines/branches/functions are all 100%", () => {
  const statementsGap = {
    lines: { pct: 100 },
    statements: { pct: 99.5 },
    branches: { pct: 100 },
    functions: { pct: 100 },
  };
  assert.strictEqual(coverageReport.isFileFullyCovered(statementsGap), false);
});

test("isFileFullyCovered is false when lines is below 100% (sanity check on the other three metrics)", () => {
  const linesGap = {
    lines: { pct: 90 },
    statements: { pct: 100 },
    branches: { pct: 100 },
    functions: { pct: 100 },
  };
  assert.strictEqual(coverageReport.isFileFullyCovered(linesGap), false);
});

// --- coverage-report.js: analyzeFile ------------------------------------

test("analyzeFile extracts uncovered statement lines, uncovered functions, and per-line untaken-branch counts", () => {
  const fileCoverage = {
    statementMap: { 0: { start: { line: 1 } }, 1: { start: { line: 2 } } },
    s: { 0: 1, 1: 0 }, // statement 1 (line 2) never ran
    fnMap: {
      0: { name: "used", decl: { start: { line: 1 } } },
      1: { name: "unused", decl: { start: { line: 5 } } },
    },
    f: { 0: 3, 1: 0 }, // "unused" never called
    branchMap: {
      0: { locations: [{ start: { line: 7 } }] },
      1: { locations: [{ start: { line: 7 } }] }, // second untaken path on the SAME line
      2: { locations: [{ start: { line: 9 } }] },
    },
    b: { 0: [0], 1: [0], 2: [1] }, // line 7 has two untaken paths, line 9's branch was taken
  };

  const detail = coverageReport.analyzeFile(fileCoverage);

  assert.deepStrictEqual(detail.uncoveredStatementLines, [2]);
  assert.deepStrictEqual(detail.uncoveredFunctions, [
    { name: "unused", line: 5 },
  ]);
  assert.strictEqual(detail.branchLineCounts.get(7), 2);
  assert.strictEqual(detail.branchLineCounts.has(9), false);
});

// --- coverage-report.js: formatFileSection -------------------------------

test("formatFileSection includes missing-line, missing-function and untested-branch sections with source snippets", () => {
  const detail = {
    uncoveredStatementLines: [2],
    uncoveredFunctions: [{ name: "unused", line: 5 }],
    branchLineCounts: new Map([[7, 2]]),
  };
  const summary = {
    lines: { pct: 80 },
    statements: { pct: 80 },
    branches: { pct: 60 },
    functions: { pct: 50 },
  };
  const sourceLines = [
    "const a = 1;",
    "doStuff();",
    "",
    "",
    "function unused() {}",
    "",
    "if (x) { y(); }",
  ];

  const section = coverageReport.formatFileSection(
    "src/example.js",
    summary,
    detail,
    sourceLines,
  );

  assert.ok(section.includes("src/example.js"));
  assert.ok(
    section.includes("80% statements"),
    "header must surface statements too, not just lines/branches/functions",
  );
  assert.ok(section.includes("Missing line coverage:** 2"));
  assert.ok(section.includes("doStuff();"));
  assert.ok(section.includes("Never called by any test:** `unused` (line 5)"));
  assert.ok(
    section.includes("Branches with an untested path:** line 7 (2 paths)"),
  );
});

// --- coverage-report.js: truncation closes open code fences --------------
// A comment long enough to be truncated can get cut in the middle of one of
// the ```js snippet blocks. If the fence isn't closed, everything after it
// (including the truncation notice itself) renders as code on GitHub.

test("main() closes an unbalanced code fence when truncating an over-long report", () => {
  const tmp = mkTmpDir();
  const cwd = process.cwd();
  try {
    // Build a file with enough uncovered statements, spread over enough
    // files, to blow past the 60k truncation limit mid-snippet.
    const summary = {
      total: {
        lines: { pct: 50, covered: 1, total: 2 },
        statements: { pct: 50, covered: 1, total: 2 },
        functions: { pct: 100, covered: 1, total: 1 },
        branches: { pct: 100, covered: 1, total: 1 },
      },
    };
    const final = {};
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir, { recursive: true });

    // One file whose snippet block alone is far larger than the 60k
    // truncation limit, so the cut provably lands *inside* that block's
    // ```js fence rather than between sections. formatFileSection inlines
    // at most MAX_SNIPPET_LINES_PER_FILE (25) lines, so each line is made
    // ~5000 chars: 25 * 5000 = ~125k, i.e. the fence opens well before the
    // 60k mark and would close well after it.
    const abs = path.join(srcDir, "huge.js");
    const hugeLine = `call(${"x".repeat(5000)});`;
    const fileLines = [];
    for (let i = 0; i < 30; i += 1) {
      fileLines.push(hugeLine);
    }
    fs.writeFileSync(abs, fileLines.join("\n"), "utf8");

    summary[abs] = {
      lines: { pct: 50 },
      statements: { pct: 50 },
      branches: { pct: 100 },
      functions: { pct: 100 },
    };
    const statementMap = {};
    const s = {};
    for (let i = 0; i < 30; i += 1) {
      statementMap[i] = { start: { line: i + 1 } };
      s[i] = 0; // every line uncovered, so all 30 are candidates for the snippet
    }
    final[abs] = {
      path: abs,
      statementMap,
      s,
      fnMap: {},
      f: {},
      branchMap: {},
      b: {},
    };

    fs.mkdirSync(path.join(tmp, "coverage"));
    fs.writeFileSync(
      path.join(tmp, "coverage", "coverage-summary.json"),
      JSON.stringify(summary),
    );
    fs.writeFileSync(
      path.join(tmp, "coverage", "coverage-final.json"),
      JSON.stringify(final),
    );

    process.chdir(tmp);
    const prevEventPath = process.env.GITHUB_EVENT_PATH;
    delete process.env.GITHUB_EVENT_PATH;
    try {
      coverageReport.main();
    } finally {
      process.env.GITHUB_EVENT_PATH = prevEventPath;
    }

    const md = fs.readFileSync(
      path.join(tmp, "coverage", "pr-comment.md"),
      "utf8",
    );
    assert.ok(
      md.includes("Report truncated"),
      "this fixture should be long enough to trigger truncation",
    );
    const fenceCount = (md.match(/```/g) || []).length;
    assert.strictEqual(
      fenceCount % 2,
      0,
      "every code fence must be balanced after truncation",
    );
  } finally {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- coverage-report.js: main() end-to-end ------------------------------

test("main() writes a passing report and includes the PR's head sha in the metadata", () => {
  const tmp = mkTmpDir();
  const cwd = process.cwd();
  try {
    fs.mkdirSync(path.join(tmp, "coverage"));
    fs.writeFileSync(
      path.join(tmp, "coverage", "coverage-summary.json"),
      JSON.stringify({
        total: {
          lines: { pct: 100, covered: 10, total: 10 },
          statements: { pct: 100, covered: 10, total: 10 },
          functions: { pct: 100, covered: 2, total: 2 },
          branches: { pct: 100, covered: 4, total: 4 },
        },
      }),
    );
    fs.writeFileSync(
      path.join(tmp, "coverage", "coverage-final.json"),
      JSON.stringify({}),
    );

    const eventPath = path.join(tmp, "event.json");
    fs.writeFileSync(
      eventPath,
      JSON.stringify({
        pull_request: {
          number: 42,
          head: { sha: "abc123abc123abc123abc123abc123abc123abc1" },
        },
      }),
    );

    process.chdir(tmp);
    const prevEventPath = process.env.GITHUB_EVENT_PATH;
    process.env.GITHUB_EVENT_PATH = eventPath;
    try {
      coverageReport.main();
    } finally {
      process.env.GITHUB_EVENT_PATH = prevEventPath;
    }

    const meta = JSON.parse(
      fs.readFileSync(
        path.join(tmp, "coverage", "pr-comment-meta.json"),
        "utf8",
      ),
    );
    assert.strictEqual(meta.status, "pass");
    assert.strictEqual(meta.prNumber, 42);
    assert.strictEqual(
      meta.headSha,
      "abc123abc123abc123abc123abc123abc123abc1",
    );

    const md = fs.readFileSync(
      path.join(tmp, "coverage", "pr-comment.md"),
      "utf8",
    );
    assert.ok(md.includes("100%"));
  } finally {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("main() writes a failing report with the correct status when below 100%", () => {
  const tmp = mkTmpDir();
  const cwd = process.cwd();
  try {
    fs.mkdirSync(path.join(tmp, "coverage"));
    fs.writeFileSync(
      path.join(tmp, "coverage", "coverage-summary.json"),
      JSON.stringify({
        total: {
          lines: { pct: 90, covered: 9, total: 10 },
          statements: { pct: 90, covered: 9, total: 10 },
          functions: { pct: 100, covered: 2, total: 2 },
          branches: { pct: 100, covered: 4, total: 4 },
        },
      }),
    );
    fs.writeFileSync(
      path.join(tmp, "coverage", "coverage-final.json"),
      JSON.stringify({}),
    );
    process.chdir(tmp);
    const prevEventPath = process.env.GITHUB_EVENT_PATH;
    delete process.env.GITHUB_EVENT_PATH;
    try {
      coverageReport.main();
    } finally {
      process.env.GITHUB_EVENT_PATH = prevEventPath;
    }

    const meta = JSON.parse(
      fs.readFileSync(
        path.join(tmp, "coverage", "pr-comment-meta.json"),
        "utf8",
      ),
    );
    assert.strictEqual(meta.status, "fail");
    assert.strictEqual(meta.prNumber, null);
  } finally {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- post-coverage-comment.js: resolveTrustedPullRequest ------------------

test("resolveTrustedPullRequest returns the single associated PR", () => {
  const context = {
    payload: { workflow_run: { pull_requests: [{ number: 7 }] } },
  };
  const warnings = [];
  const core = { warning: (msg) => warnings.push(msg) };
  const result = resolveTrustedPullRequest(context, core);
  assert.strictEqual(result.number, 7);
  assert.strictEqual(warnings.length, 0);
});

test("resolveTrustedPullRequest returns null and warns when there are zero associated PRs", () => {
  const context = { payload: { workflow_run: { pull_requests: [] } } };
  const warnings = [];
  const core = { warning: (msg) => warnings.push(msg) };
  assert.strictEqual(resolveTrustedPullRequest(context, core), null);
  assert.strictEqual(warnings.length, 1);
});

test("resolveTrustedPullRequest returns null and warns when there is more than one associated PR (ambiguous target)", () => {
  const context = {
    payload: {
      workflow_run: { pull_requests: [{ number: 7 }, { number: 8 }] },
    },
  };
  const warnings = [];
  const core = { warning: (msg) => warnings.push(msg) };
  assert.strictEqual(resolveTrustedPullRequest(context, core), null);
  assert.strictEqual(warnings.length, 1);
});

// --- post-coverage-comment.js: full flow, trust boundaries ----------------

function makeFakeGithub({ existingComments = [], currentHeadSha }) {
  const calls = {
    createComment: [],
    updateComment: [],
    pullsGet: [],
    paginate: [],
  };
  return {
    calls,
    github: {
      // github.paginate(fn, params) in actions/github-script returns the
      // flattened array of items, not a { data } envelope - mirror that.
      paginate: async (fn, params) => {
        calls.paginate.push(params);
        return existingComments;
      },
      rest: {
        issues: {
          listComments: async () => ({ data: existingComments }),
          createComment: async (params) => {
            calls.createComment.push(params);
            return { data: {} };
          },
          updateComment: async (params) => {
            calls.updateComment.push(params);
            return { data: {} };
          },
        },
        pulls: {
          get: async (params) => {
            calls.pullsGet.push(params);
            return { data: { head: { sha: currentHeadSha } } };
          },
        },
      },
    },
  };
}

function writeArtifact(
  dir,
  { prNumber, headSha, status = "pass", body = "report body" },
) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "pr-comment.md"), body, "utf8");
  fs.writeFileSync(
    path.join(dir, "pr-comment-meta.json"),
    JSON.stringify({
      prNumber,
      headSha,
      status,
      pct: { lines: 100, statements: 100, functions: 100, branches: 100 },
    }),
    "utf8",
  );
}

test("post-coverage-comment posts to the TRUSTED workflow_run PR number, ignoring a forged meta.prNumber", async () => {
  const tmp = mkTmpDir();
  try {
    const HEAD_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    // The artifact (attacker-influenceable, since it's built from a run of
    // the PR's own test code) claims PR #999 - a completely different
    // issue than the one this workflow_run is actually for (#7). If the
    // fix works, the comment must land on #7, never on #999.
    writeArtifact(path.join(tmp, "coverage-artifact"), {
      prNumber: 999,
      headSha: HEAD_SHA,
    });

    const context = {
      repo: { owner: "fossasia", repo: "cla-bot" },
      payload: { workflow_run: { pull_requests: [{ number: 7 }] } },
    };
    const core = { warning: () => {}, info: () => {} };
    const { github, calls } = makeFakeGithub({
      existingComments: [],
      currentHeadSha: HEAD_SHA,
    });

    const prevWorkspace = process.env.GITHUB_WORKSPACE;
    process.env.GITHUB_WORKSPACE = tmp;
    try {
      await postComment({ github, context, core });
    } finally {
      process.env.GITHUB_WORKSPACE = prevWorkspace;
    }

    assert.strictEqual(calls.createComment.length, 1);
    assert.strictEqual(
      calls.createComment[0].issue_number,
      7,
      "must use the trusted PR number, not the artifact's",
    );
    assert.strictEqual(calls.pullsGet[0].pull_number, 7);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("post-coverage-comment skips posting when the report's head sha is stale (superseded by a newer push)", async () => {
  const tmp = mkTmpDir();
  try {
    writeArtifact(path.join(tmp, "coverage-artifact"), {
      prNumber: 7,
      headSha: "old-sha",
    });

    const context = {
      repo: { owner: "fossasia", repo: "cla-bot" },
      payload: { workflow_run: { pull_requests: [{ number: 7 }] } },
    };
    const infos = [];
    const core = { warning: () => {}, info: (msg) => infos.push(msg) };
    // The PR's *current* head is a different, newer sha than the report
    // was generated for.
    const { github, calls } = makeFakeGithub({
      existingComments: [],
      currentHeadSha: "new-sha",
    });

    const prevWorkspace = process.env.GITHUB_WORKSPACE;
    process.env.GITHUB_WORKSPACE = tmp;
    try {
      await postComment({ github, context, core });
    } finally {
      process.env.GITHUB_WORKSPACE = prevWorkspace;
    }

    assert.strictEqual(calls.createComment.length, 0);
    assert.strictEqual(calls.updateComment.length, 0);
    assert.ok(infos.some((m) => m.includes("superseded")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("post-coverage-comment updates an existing marked comment instead of creating a new one", async () => {
  const tmp = mkTmpDir();
  try {
    const HEAD_SHA = "cafebabecafebabecafebabecafebabecafebabe";
    writeArtifact(path.join(tmp, "coverage-artifact"), {
      prNumber: 7,
      headSha: HEAD_SHA,
    });

    const context = {
      repo: { owner: "fossasia", repo: "cla-bot" },
      payload: { workflow_run: { pull_requests: [{ number: 7 }] } },
    };
    const core = { warning: () => {}, info: () => {} };
    const existingComments = [
      { id: 555, user: { type: "Bot" }, body: `${MARKER}\nold report` },
    ];
    const { github, calls } = makeFakeGithub({
      existingComments,
      currentHeadSha: HEAD_SHA,
    });

    const prevWorkspace = process.env.GITHUB_WORKSPACE;
    process.env.GITHUB_WORKSPACE = tmp;
    try {
      await postComment({ github, context, core });
    } finally {
      process.env.GITHUB_WORKSPACE = prevWorkspace;
    }

    assert.strictEqual(calls.createComment.length, 0);
    assert.strictEqual(calls.updateComment.length, 1);
    assert.strictEqual(calls.updateComment[0].comment_id, 555);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("post-coverage-comment skips entirely when the artifact files are missing", async () => {
  const tmp = mkTmpDir(); // no coverage-artifact/ written at all
  try {
    const context = {
      repo: { owner: "fossasia", repo: "cla-bot" },
      payload: { workflow_run: { pull_requests: [{ number: 7 }] } },
    };
    const warnings = [];
    const core = { warning: (m) => warnings.push(m), info: () => {} };
    const { github, calls } = makeFakeGithub({
      existingComments: [],
      currentHeadSha: "irrelevant",
    });

    const prevWorkspace = process.env.GITHUB_WORKSPACE;
    process.env.GITHUB_WORKSPACE = tmp;
    try {
      await postComment({ github, context, core });
    } finally {
      process.env.GITHUB_WORKSPACE = prevWorkspace;
    }

    assert.strictEqual(calls.createComment.length, 0);
    assert.strictEqual(
      calls.pullsGet.length,
      0,
      "must not even call the API once artifact files are missing",
    );
    assert.strictEqual(warnings.length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("post-coverage-comment skips (never guesses a target) when workflow_run has more than one associated PR", async () => {
  const tmp = mkTmpDir();
  try {
    writeArtifact(path.join(tmp, "coverage-artifact"), {
      prNumber: 7,
      headSha: "some-sha",
    });
    const context = {
      repo: { owner: "fossasia", repo: "cla-bot" },
      payload: {
        workflow_run: { pull_requests: [{ number: 7 }, { number: 8 }] },
      },
    };
    const core = { warning: () => {}, info: () => {} };
    const { github, calls } = makeFakeGithub({
      existingComments: [],
      currentHeadSha: "some-sha",
    });

    const prevWorkspace = process.env.GITHUB_WORKSPACE;
    process.env.GITHUB_WORKSPACE = tmp;
    try {
      await postComment({ github, context, core });
    } finally {
      process.env.GITHUB_WORKSPACE = prevWorkspace;
    }

    assert.strictEqual(calls.createComment.length, 0);
    assert.strictEqual(calls.pullsGet.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

runAll().then(() => {
  console.log(`\n${passed}/${cases.length} test(s) passed.`);
  if (process.exitCode) {
    console.error("SOME TESTS FAILED.");
  } else {
    console.log("ALL TESTS PASSED.");
  }
});
