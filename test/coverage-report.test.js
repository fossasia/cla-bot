"use strict";
/**
 * Offline unit + integration tests for .github/scripts/coverage-report.js.
 * No network calls. Run: node test/coverage-report.test.js (or `npm test`)
 *
 * This script isn't part of the shipped action (`src/cla-bot.js`), so it's
 * intentionally out of scope for the project's 100%-coverage gate (see
 * .c8rc.json's `include`, and CONTRIBUTING.md's dependency rule for the
 * same src/ vs. CI-tooling split) - but it's still part of the new
 * security-sensitive comment-posting mechanism, so it gets its own
 * targeted tests here, run as part of the regular `npm test` suite.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (e) {
    console.error(`FAIL: ${name}\n - ${e.message}`);
    process.exitCode = 1;
  }
}

// coverage-report.js resolves its input/output paths from process.cwd() at
// require time, so each scenario below gets its own scratch directory and
// its own fresh require (via a cleared require-cache entry) pointed at it.
const SCRIPT_PATH = path.join(
  __dirname,
  "..",
  ".github",
  "scripts",
  "coverage-report.js",
);

function loadInScratchDir(dir) {
  const prevCwd = process.cwd();
  process.chdir(dir);
  delete require.cache[require.resolve(SCRIPT_PATH)];
  const mod = require(SCRIPT_PATH);
  process.chdir(prevCwd);
  return mod;
}

function makeScratchDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coverage-report-test-"));
  fs.mkdirSync(path.join(dir, "coverage"));
  return dir;
}

function writeCoverageFixture(dir, { summary, final }) {
  fs.writeFileSync(
    path.join(dir, "coverage", "coverage-summary.json"),
    JSON.stringify(summary),
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "coverage", "coverage-final.json"),
    JSON.stringify(final),
    "utf8",
  );
}

function pctEntry(pct, covered, total) {
  return { pct, covered, total };
}

function fullyCoveredEntry() {
  return {
    lines: pctEntry(100, 10, 10),
    statements: pctEntry(100, 10, 10),
    functions: pctEntry(100, 2, 2),
    branches: pctEntry(100, 4, 4),
  };
}

// --- toRanges --------------------------------------------------------------

const { toRanges, analyzeFile, formatFileSection, relativize, sourceSnippet } =
  loadInScratchDir(makeScratchDir());

test("toRanges collapses consecutive line numbers into a single range", () => {
  assert.deepStrictEqual(toRanges([1, 2, 3]), ["1-3"]);
});

test("toRanges keeps non-consecutive line numbers as separate entries", () => {
  assert.deepStrictEqual(toRanges([1, 5, 6, 20]), ["1", "5-6", "20"]);
});

test("toRanges de-duplicates and sorts out-of-order input", () => {
  assert.deepStrictEqual(toRanges([5, 3, 3, 4]), ["3-5"]);
});

test("toRanges returns an empty array for no lines", () => {
  assert.deepStrictEqual(toRanges([]), []);
});

// --- sourceSnippet / relativize ---------------------------------------------

test("sourceSnippet returns the trimmed source line for a valid line number", () => {
  assert.strictEqual(sourceSnippet(["  const x = 1;  "], 1), "const x = 1;");
});

test("sourceSnippet returns null for a line number past the end of the file", () => {
  assert.strictEqual(sourceSnippet(["one line"], 5), null);
});

test("relativize converts an absolute path to a forward-slash relative path", () => {
  const abs = path.join(process.cwd(), "src", "cla-bot.js");
  assert.strictEqual(relativize(abs), "src/cla-bot.js");
});

// --- analyzeFile -------------------------------------------------------------

test("analyzeFile reports uncovered statement lines, functions and branch paths", () => {
  const fileCoverage = {
    statementMap: {
      0: { start: { line: 5 } },
      1: { start: { line: 6 } },
    },
    s: { 0: 0, 1: 3 },
    fnMap: {
      0: { name: "doThing", decl: { start: { line: 10 } } },
      1: { name: "(anonymous_0)", decl: { start: { line: 20 } } },
    },
    f: { 0: 0, 1: 0 },
    branchMap: {
      0: {
        loc: { start: { line: 30 } },
        locations: [{ start: { line: 30 } }, { start: { line: 31 } }],
      },
    },
    b: { 0: [1, 0] },
  };

  const detail = analyzeFile(fileCoverage);

  assert.deepStrictEqual(detail.uncoveredStatementLines, [5]);
  assert.deepStrictEqual(detail.uncoveredFunctions, [
    { name: "doThing", line: 10 },
    { name: "(anonymous function)", line: 20 },
  ]);
  assert.strictEqual(detail.branchLineCounts.get(31), 1);
  assert.strictEqual(detail.branchLineCounts.has(30), false);
});

test("analyzeFile reports no findings for a fully-covered file", () => {
  const fileCoverage = {
    statementMap: { 0: { start: { line: 1 } } },
    s: { 0: 1 },
    fnMap: {},
    f: {},
    branchMap: {},
    b: {},
  };
  const detail = analyzeFile(fileCoverage);
  assert.deepStrictEqual(detail.uncoveredStatementLines, []);
  assert.deepStrictEqual(detail.uncoveredFunctions, []);
  assert.strictEqual(detail.branchLineCounts.size, 0);
});

// --- formatFileSection -------------------------------------------------------

test("formatFileSection includes statement coverage in the header (regression: a file at 100% lines/branches/functions but not statements must still be visible)", () => {
  const summary = {
    lines: pctEntry(100, 10, 10),
    statements: pctEntry(90, 9, 10),
    functions: pctEntry(100, 2, 2),
    branches: pctEntry(100, 4, 4),
  };
  const detail = {
    uncoveredStatementLines: [7],
    uncoveredFunctions: [],
    branchLineCounts: new Map(),
  };
  const section = formatFileSection("src/example.js", summary, detail, [
    "",
    "",
    "",
    "",
    "",
    "",
    "const unused = 1;",
  ]);
  assert.match(section, /90% statements/);
  assert.match(section, /Missing line coverage:\*\* 7/);
  assert.match(section, /```js\n7: const unused = 1;\n```/);
});

test("formatFileSection lists uncovered functions and branch paths", () => {
  const summary = {
    lines: pctEntry(80, 8, 10),
    statements: pctEntry(80, 8, 10),
    functions: pctEntry(50, 1, 2),
    branches: pctEntry(50, 1, 2),
  };
  const detail = {
    uncoveredStatementLines: [],
    uncoveredFunctions: [{ name: "helper", line: 3 }],
    branchLineCounts: new Map([[9, 2]]),
  };
  const section = formatFileSection("src/example.js", summary, detail, []);
  assert.match(section, /Never called by any test:\*\* `helper` \(line 3\)/);
  assert.match(
    section,
    /Branches with an untested path:\*\* line 9 \(2 paths\)/,
  );
});

// --- closeUnbalancedFence ------------------------------------------------

const { closeUnbalancedFence } = loadInScratchDir(makeScratchDir());

test("closeUnbalancedFence leaves already-balanced text untouched", () => {
  const text = "before\n```js\ncode\n```\nafter";
  assert.strictEqual(closeUnbalancedFence(text), text);
});

test("closeUnbalancedFence closes a fence left open by a hard truncation cut", () => {
  const text = "before\n```js\nsome code that got cut off mid-block";
  const result = closeUnbalancedFence(text);
  assert.strictEqual(result, `${text}\n\`\`\``);
  // The result must have a balanced (even) number of fence markers.
  assert.strictEqual((result.match(/^```/gm) || []).length % 2, 0);
});

test("closeUnbalancedFence handles text with no fences at all", () => {
  assert.strictEqual(
    closeUnbalancedFence("just plain text"),
    "just plain text",
  );
});

// --- main() integration ------------------------------------------------------

test("main() reports 100% pass status and writes matching metadata when everything is covered", () => {
  const dir = makeScratchDir();
  writeCoverageFixture(dir, {
    summary: {
      total: fullyCoveredEntry(),
      [path.join(dir, "src", "a.js")]: fullyCoveredEntry(),
    },
    final: {},
  });
  process.env.GITHUB_EVENT_PATH = "";
  const { main } = loadInScratchDir(dir);
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    main();
  } finally {
    process.chdir(prevCwd);
  }

  const md = fs.readFileSync(
    path.join(dir, "coverage", "pr-comment.md"),
    "utf8",
  );
  const meta = JSON.parse(
    fs.readFileSync(path.join(dir, "coverage", "pr-comment-meta.json"), "utf8"),
  );

  assert.match(md, /✅ Test coverage: 100%/);
  assert.strictEqual(meta.status, "pass");
  assert.strictEqual(meta.pct.statements, 100);
});

test("main() lists a file whose statement coverage alone is below 100% (regression for the per-file statements-pct bug)", () => {
  const dir = makeScratchDir();
  const filePath = path.join(dir, "src", "partial.js");
  const summaryEntry = {
    lines: pctEntry(100, 5, 5),
    statements: pctEntry(80, 4, 5),
    functions: pctEntry(100, 1, 1),
    branches: pctEntry(100, 0, 0),
  };
  writeCoverageFixture(dir, {
    summary: {
      total: {
        lines: pctEntry(100, 5, 5),
        statements: pctEntry(80, 4, 5),
        functions: pctEntry(100, 1, 1),
        branches: pctEntry(100, 0, 0),
      },
      [filePath]: summaryEntry,
    },
    final: {
      [filePath]: {
        statementMap: { 0: { start: { line: 2 } } },
        s: { 0: 0 },
        fnMap: {},
        f: {},
        branchMap: {},
        b: {},
      },
    },
  });
  process.env.GITHUB_EVENT_PATH = "";
  const { main } = loadInScratchDir(dir);
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    main();
  } finally {
    process.chdir(prevCwd);
  }

  const md = fs.readFileSync(
    path.join(dir, "coverage", "pr-comment.md"),
    "utf8",
  );
  assert.match(md, /❌ Test coverage is below the required 100%/);
  // Before the fix, a file at 100% lines/branches/functions but <100%
  // statements was silently skipped from the file-by-file breakdown.
  assert.match(md, /src\/partial\.js/);
  assert.match(md, /80% statements/);
});

test("main() records the event's pull_request number in metadata as an (untrusted) hint, and writes no comment/posting decision itself", () => {
  const dir = makeScratchDir();
  writeCoverageFixture(dir, {
    summary: { total: fullyCoveredEntry() },
    final: {},
  });
  const eventPath = path.join(dir, "event.json");
  fs.writeFileSync(
    eventPath,
    JSON.stringify({ pull_request: { number: 42 } }),
    "utf8",
  );
  process.env.GITHUB_EVENT_PATH = eventPath;
  const { main } = loadInScratchDir(dir);
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    main();
  } finally {
    process.chdir(prevCwd);
    delete process.env.GITHUB_EVENT_PATH;
  }

  const meta = JSON.parse(
    fs.readFileSync(path.join(dir, "coverage", "pr-comment-meta.json"), "utf8"),
  );
  assert.strictEqual(meta.prNumber, 42);
});

console.log(`\n${passed} test(s) passed.`);
if (process.exitCode) {
  console.error("\nSOME TESTS FAILED.");
} else {
  console.log("ALL TESTS PASSED.");
}
