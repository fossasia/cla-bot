"use strict";
/**
 * Offline tests for .github/scripts/coverage-report.js - the script that
 * turns c8's output into the "Test Coverage" PR comment. No network.
 * Run: node test/coverage-report.test.js (also part of `npm test`).
 *
 * The script isn't part of the shipped action (src/cla-bot.js), so it is
 * deliberately outside the 100%-coverage gate (.c8rc.json only includes
 * src/**), but it sits inside the CI gate itself - if it silently
 * misreported, contributors would be told the wrong thing - so it is tested
 * thoroughly anyway, including against genuine c8 output.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const SCRIPT_PATH = path.join(
  __dirname,
  "..",
  ".github",
  "scripts",
  "coverage-report.js",
);
const report = require(SCRIPT_PATH);
const {
  main,
  toRanges,
  sourceSnippet,
  relativize,
  resolvePaths,
  isFileFullyCovered,
  analyzeFile,
  formatFileSection,
  closeUnbalancedFence,
  MAX_COMMENT_LENGTH,
  MAX_SNIPPET_LINES_PER_FILE,
} = report;

// Cases are collected and run one at a time at the bottom of the file:
// several of them chdir() or spawn processes, so letting them interleave
// would make them flaky.
const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cla-bot-coverage-report-"));
}

async function withTmpDir(fn) {
  const dir = mkTmpDir();
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function withCwd(dir, fn) {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(previous);
  }
}

// main() prints the report for the CI log; keep test output readable.
const quiet = () => {};

const pct = (value, covered, total) => ({ pct: value, covered, total });
const fullEntry = () => ({
  lines: pct(100, 10, 10),
  statements: pct(100, 10, 10),
  functions: pct(100, 2, 2),
  branches: pct(100, 4, 4),
});

function writeCoverage(dir, summary, final) {
  fs.mkdirSync(path.join(dir, "coverage"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "coverage", "coverage-summary.json"),
    JSON.stringify(summary),
  );
  fs.writeFileSync(
    path.join(dir, "coverage", "coverage-final.json"),
    JSON.stringify(final),
  );
}

// A one-statement, no-branch, no-function istanbul file entry whose single
// statement (on `line`) was never executed.
function uncoveredStatementFile(line) {
  return {
    statementMap: { 0: { start: { line } } },
    s: { 0: 0 },
    fnMap: {},
    f: {},
    branchMap: {},
    b: {},
  };
}

// Creates the (empty) source files a fixture claims to have measured, so
// the independent on-disk check in verify-coverage.js sees a coherent
// project. Returns their absolute paths.
function writeSources(dir, ...names) {
  return names.map((name) => {
    const file = path.join(dir, "src", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Append mode creates the file if it is missing and never truncates an
    // existing one - one atomic call, instead of "check, then write"
    // (CodeQL js/file-system-race).
    fs.writeFileSync(file, "", { flag: "a" });
    return file;
  });
}

const readReportMd = (dir) =>
  fs.readFileSync(path.join(dir, "coverage", "pr-comment.md"), "utf8");

// --- toRanges ---------------------------------------------------------------

test("toRanges collapses consecutive line numbers into a single range", () => {
  assert.deepStrictEqual(toRanges([10, 11, 12]), ["10-12"]);
});

test("toRanges keeps non-consecutive lines as separate entries", () => {
  assert.deepStrictEqual(toRanges([5, 8, 9, 20]), ["5", "8-9", "20"]);
});

test("toRanges de-duplicates and sorts unsorted, repeated input", () => {
  assert.deepStrictEqual(toRanges([3, 1, 2, 2, 1]), ["1-3"]);
});

test("toRanges returns an empty array for no lines", () => {
  assert.deepStrictEqual(toRanges([]), []);
});

// --- sourceSnippet / relativize / resolvePaths ---------------------------------

test("sourceSnippet returns the trimmed text of the requested (1-indexed) line", () => {
  const lines = ["const a = 1;", "  if (a) {", "    return a;", "  }"];
  assert.strictEqual(sourceSnippet(lines, 2), "if (a) {");
});

test("sourceSnippet returns null for a line number outside the file", () => {
  assert.strictEqual(sourceSnippet(["only one line"], 5), null);
  assert.strictEqual(sourceSnippet(["only one line"], 0), null);
});

test("relativize converts an absolute path to a forward-slash path relative to the given cwd", () => {
  const cwd = path.join(path.sep, "work", "repo");
  assert.strictEqual(
    relativize(path.join(cwd, "src", "cla-bot.js"), cwd),
    "src/cla-bot.js",
  );
});

test("relativize defaults to the current working directory", () => {
  assert.strictEqual(
    relativize(path.join(process.cwd(), "src", "cla-bot.js")),
    "src/cla-bot.js",
  );
});

test("resolvePaths follows the directory it is given, not wherever the module was first loaded", () => {
  const resolved = resolvePaths(path.join(path.sep, "somewhere"));
  assert.strictEqual(
    resolved.summaryPath,
    path.join(path.sep, "somewhere", "coverage", "coverage-summary.json"),
  );
  assert.strictEqual(
    resolved.outMd,
    path.join(path.sep, "somewhere", "coverage", "pr-comment.md"),
  );
});

// --- isFileFullyCovered ---------------------------------------------------------
// The exact bug a reviewer flagged: a file can be 100% on lines, branches
// and functions while a *statement* is still uncovered (two statements on
// one line), so all four metrics have to be checked.

test("isFileFullyCovered is true only when all four metrics are 100%", () => {
  assert.strictEqual(isFileFullyCovered(fullEntry()), true);
});

for (const metric of ["lines", "statements", "functions", "branches"]) {
  test(`isFileFullyCovered is false when only ${metric} is below 100%`, () => {
    const entry = fullEntry();
    entry[metric] = pct(99.5, 199, 200);
    assert.strictEqual(isFileFullyCovered(entry), false);
  });
}

test("isFileFullyCovered treats a non-numeric pct (c8's 'Unknown') as not covered", () => {
  const entry = fullEntry();
  entry.branches = { pct: "Unknown", covered: 0, total: 0 };
  assert.strictEqual(isFileFullyCovered(entry), false);
});

// --- analyzeFile ----------------------------------------------------------------

test("analyzeFile extracts uncovered statement lines, uncovered functions and per-line untaken-branch counts", () => {
  const detail = analyzeFile({
    statementMap: { 0: { start: { line: 1 } }, 1: { start: { line: 2 } } },
    s: { 0: 1, 1: 0 },
    fnMap: {
      0: { name: "used", decl: { start: { line: 1 } } },
      1: { name: "unused", decl: { start: { line: 5 } } },
      2: { name: "(anonymous_0)", decl: { start: { line: 6 } } },
      3: { decl: { start: { line: 7 } } },
    },
    f: { 0: 3, 1: 0, 2: 0, 3: 0 },
    branchMap: {
      0: { locations: [{ start: { line: 7 } }] },
      1: { locations: [{ start: { line: 7 } }] },
      2: { locations: [{ start: { line: 9 } }] },
    },
    b: { 0: [0], 1: [0], 2: [1] },
  });

  assert.deepStrictEqual(detail.uncoveredStatementLines, [2]);
  assert.deepStrictEqual(detail.uncoveredFunctions, [
    { name: "unused", line: 5 },
    { name: "(anonymous function)", line: 6 },
    { name: "(anonymous function)", line: 7 },
  ]);
  assert.strictEqual(detail.branchLineCounts.get(7), 2);
  assert.strictEqual(detail.branchLineCounts.has(9), false);
});

test("analyzeFile falls back to the branch's own loc when it has no per-path locations", () => {
  const detail = analyzeFile({
    statementMap: {},
    s: {},
    fnMap: {},
    f: {},
    branchMap: { 0: { loc: { start: { line: 12 } }, locations: [] } },
    b: { 0: [0] },
  });
  assert.strictEqual(detail.branchLineCounts.get(12), 1);
});

test("analyzeFile reports no findings for a fully-covered file", () => {
  const detail = analyzeFile({
    statementMap: { 0: { start: { line: 1 } } },
    s: { 0: 1 },
    fnMap: {},
    f: {},
    branchMap: {},
    b: {},
  });
  assert.deepStrictEqual(detail.uncoveredStatementLines, []);
  assert.deepStrictEqual(detail.uncoveredFunctions, []);
  assert.strictEqual(detail.branchLineCounts.size, 0);
});

// --- formatFileSection ----------------------------------------------------------

test("formatFileSection surfaces statements in the header and lists uncovered statements with source snippets", () => {
  const summary = {
    lines: pct(100, 10, 10),
    statements: pct(90, 9, 10),
    functions: pct(100, 2, 2),
    branches: pct(100, 4, 4),
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
  assert.match(section, /### `src\/example\.js`/);
  assert.match(section, /90% statements/);
  assert.match(section, /Uncovered statements on line\(s\):\*\* 7/);
  assert.match(section, /```js\n7: const unused = 1;\n```/);
});

test("formatFileSection lists never-called functions (sorted by line) and untested branch lines", () => {
  const summary = {
    lines: pct(80, 8, 10),
    statements: pct(80, 8, 10),
    functions: pct(50, 1, 2),
    branches: pct(50, 1, 2),
  };
  const detail = {
    uncoveredStatementLines: [],
    uncoveredFunctions: [
      { name: "later", line: 30 },
      { name: "helper", line: 3 },
    ],
    branchLineCounts: new Map([
      [9, 2],
      [5, 1],
    ]),
  };
  const section = formatFileSection("src/example.js", summary, detail, [
    "a",
    "b",
    "c",
    "d",
    "if (x) {}",
  ]);
  assert.match(
    section,
    /Never called by any test:\*\* `helper` \(line 3\), `later` \(line 30\)/,
  );
  assert.match(
    section,
    /Branches with an untested path:\*\* line 5 \(1 path\), line 9 \(2 paths\)/,
  );
  assert.match(section, /5: if \(x\) \{\}  \/\/ 1 path through this line/);
  // Line 9 is beyond the 5-line source: still listed, with an empty snippet.
  assert.match(section, /9:   \/\/ 2 paths through this line/);
});

test("formatFileSection caps the inlined snippets and says how many were left out (singular and plural)", () => {
  const total = MAX_SNIPPET_LINES_PER_FILE + 2;
  const lines = Array.from({ length: total }, (_, i) => `line${i + 1}();`);
  const allLines = lines.map((_, i) => i + 1);
  const summary = {
    lines: pct(10, 1, 10),
    statements: pct(10, 1, 10),
    functions: pct(100, 1, 1),
    branches: pct(10, 1, 10),
  };

  const plural = formatFileSection(
    "src/big.js",
    summary,
    {
      uncoveredStatementLines: allLines,
      uncoveredFunctions: [],
      branchLineCounts: new Map(allLines.map((n) => [n, 1])),
    },
    lines,
  );
  assert.match(plural, /\.\.\. \(2 more uncovered lines\)/);
  assert.match(plural, /\.\.\. \(2 more lines with an untested branch\)/);
  assert.ok(!plural.includes(`${total}: line${total}();`));

  const singular = formatFileSection(
    "src/big.js",
    summary,
    {
      uncoveredStatementLines: allLines.slice(
        0,
        MAX_SNIPPET_LINES_PER_FILE + 1,
      ),
      uncoveredFunctions: [],
      branchLineCounts: new Map(
        allLines.slice(0, MAX_SNIPPET_LINES_PER_FILE + 1).map((n) => [n, 1]),
      ),
    },
    lines,
  );
  assert.match(singular, /\.\.\. \(1 more uncovered line\)/);
  assert.match(singular, /\.\.\. \(1 more line with an untested branch\)/);
});

test("formatFileSection omits the snippet block when none of the missing lines exist in the source", () => {
  const section = formatFileSection(
    "src/gone.js",
    {
      lines: pct(0, 0, 1),
      statements: pct(0, 0, 1),
      functions: pct(100, 0, 0),
      branches: pct(100, 0, 0),
    },
    {
      uncoveredStatementLines: [3],
      uncoveredFunctions: [],
      branchLineCounts: new Map(),
    },
    [],
  );
  assert.match(section, /Uncovered statements on line\(s\):\*\* 3/);
  assert.ok(!section.includes("```"));
});

// --- Markdown safety of source text ---------------------------------------------------------
// Source lines and names are inserted into Markdown code fences / inline
// code. Nothing in them may be able to start a new Markdown line (a lone CR
// counts as one) or close the fence early.

const MARKDOWN_LINE_BREAK = /\r\n|\r|\n|\u2028|\u2029/;
const fenceLines = (markdown) =>
  markdown.split(MARKDOWN_LINE_BREAK).filter((line) => /^ {0,3}```/.test(line));

test("sourceSnippet turns CR, line separators and control characters into spaces", () => {
  assert.strictEqual(
    sourceSnippet(["a\r```\rb\u2028c\u2029d\u0000e\tf\u007f"], 1),
    "a ``` b c d e f",
  );
});

test("a source line containing ``` (alone, or after a CR) cannot close the code fence or start a new Markdown line", () => {
  const section = formatFileSection(
    "src/tricky.js",
    {
      lines: pct(0, 0, 4),
      statements: pct(0, 0, 4),
      functions: pct(100, 0, 0),
      branches: pct(100, 0, 0),
    },
    {
      uncoveredStatementLines: [1, 2, 3, 4],
      uncoveredFunctions: [],
      branchLineCounts: new Map(),
    },
    [
      "```",
      "x\r```\r<img src=x onerror=alert(1)>",
      "const s = '```js';",
      "y\u2028```\u2029z",
    ],
  );
  // Exactly our own opening and closing fence, nothing injected.
  assert.strictEqual(fenceLines(section).length, 2, section);
  assert.strictEqual(
    section.split(MARKDOWN_LINE_BREAK).filter((l) => /^\d+: /.test(l)).length,
    4,
  );
});

test("function names and file paths cannot break out of their inline-code spans", () => {
  const section = formatFileSection(
    "src/we`ird\nname.js",
    {
      lines: pct(50, 1, 2),
      statements: pct(50, 1, 2),
      functions: pct(50, 1, 2),
      branches: pct(100, 0, 0),
    },
    {
      uncoveredStatementLines: [],
      uncoveredFunctions: [{ name: "a`b\r```c", line: 3 }],
      branchLineCounts: new Map(),
    },
    [],
  );
  assert.ok(section.includes("### `src/we'ird name.js`"), section);
  assert.ok(section.includes("`a'b '''c` (line 3)"), section);
  assert.strictEqual(fenceLines(section).length, 0);
});

test("a truncated report whose snippets contain fence-like text still ends with balanced fences", async () => {
  await withTmpDir((dir) => {
    const file = path.join(dir, "src", "fences.js");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = "```" + "x".repeat(5000) + "\r```";
    fs.writeFileSync(file, Array(30).fill(line).join("\n"));
    const statementMap = {};
    const s = {};
    for (let i = 0; i < 30; i += 1) {
      statementMap[i] = { start: { line: i + 1 } };
      s[i] = 0;
    }
    const entry = {
      lines: pct(0, 0, 30),
      statements: pct(0, 0, 30),
      functions: pct(100, 0, 0),
      branches: pct(100, 0, 0),
    };
    writeCoverage(
      dir,
      { total: entry, [file]: entry },
      { [file]: { statementMap, s, fnMap: {}, f: {}, branchMap: {}, b: {} } },
    );
    const { markdown } = main({ cwd: dir, log: quiet });
    assert.match(markdown, /Report truncated/);
    assert.strictEqual(fenceLines(markdown).length % 2, 0);
  });
});

// --- closeUnbalancedFence -------------------------------------------------------

test("closeUnbalancedFence leaves already-balanced text untouched", () => {
  const text = "before\n```js\ncode\n```\nafter";
  assert.strictEqual(closeUnbalancedFence(text), text);
});

test("closeUnbalancedFence closes a fence left open by a hard truncation cut", () => {
  const text = "before\n```js\nsome code that got cut off mid-block";
  const result = closeUnbalancedFence(text);
  assert.strictEqual(result, `${text}\n\`\`\``);
  assert.strictEqual((result.match(/^```/gm) || []).length % 2, 0);
});

test("closeUnbalancedFence handles text with no fences at all", () => {
  assert.strictEqual(closeUnbalancedFence("plain text"), "plain text");
});

// --- main() ---------------------------------------------------------------------

test("main() writes a passing report - and ONLY the Markdown file (no PR number / SHA / metadata)", async () => {
  await withTmpDir((dir) => {
    const [a] = writeSources(dir, "a.js");
    writeCoverage(dir, { total: fullEntry(), [a]: fullEntry() }, {});
    const result = main({ cwd: dir, log: quiet });

    assert.strictEqual(result.isFullyCovered, true);
    const md = readReportMd(dir);
    assert.match(md, /✅ Test coverage: 100%/);
    assert.match(md, /\*\*100%\*\* lines \(10\/10\)/);
    assert.strictEqual(md, result.markdown);
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, "coverage")).sort(), [
      "coverage-final.json",
      "coverage-summary.json",
      "pr-comment.md",
    ]);
  });
});

test("main() defaults to the current working directory", async () => {
  await withTmpDir((dir) => {
    const [a] = writeSources(dir, "a.js");
    writeCoverage(dir, { total: fullEntry(), [a]: fullEntry() }, {});
    withCwd(dir, () => main({ log: quiet }));
    assert.match(readReportMd(dir), /✅ Test coverage: 100%/);
  });
});

test("main() lists a file whose statement coverage alone is below 100% (regression: per-file statements bug)", async () => {
  await withTmpDir((dir) => {
    const file = path.join(dir, "src", "partial.js");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "const a = 1;\nconst b = 2; const c = 3;\n");
    const entry = {
      lines: pct(100, 5, 5),
      statements: pct(80, 4, 5),
      functions: pct(100, 1, 1),
      branches: pct(100, 0, 0),
    };
    writeCoverage(
      dir,
      { total: entry, [file]: entry },
      { [file]: uncoveredStatementFile(2) },
    );

    const result = main({ cwd: dir, log: quiet });

    assert.strictEqual(result.isFullyCovered, false);
    const md = readReportMd(dir);
    assert.match(md, /❌ Test coverage is below the required 100%/);
    assert.match(md, /src\/partial\.js/);
    assert.match(md, /80% statements/);
    assert.match(md, /2: const b = 2; const c = 3;/);
    // lines are 100% here, so claiming "line coverage" is missing would be
    // false: what is missing is a statement on a line that did run.
    assert.match(md, /Uncovered statements on line\(s\):\*\* 2/);
    assert.ok(!/line coverage/i.test(md));
  });
});

test("main() skips fully-covered files and files with no detailed data, and still lists the rest", async () => {
  await withTmpDir((dir) => {
    const covered = path.join(dir, "src", "covered.js");
    const noDetail = path.join(dir, "src", "no-detail.js");
    const partial = path.join(dir, "src", "partial.js");
    const partialEntry = {
      lines: pct(50, 1, 2),
      statements: pct(50, 1, 2),
      functions: pct(100, 0, 0),
      branches: pct(100, 0, 0),
    };
    writeCoverage(
      dir,
      {
        total: partialEntry,
        [covered]: fullEntry(),
        [noDetail]: partialEntry,
        [partial]: partialEntry,
      },
      // No entry for no-detail.js; partial.js's source isn't on disk.
      {
        [covered]: uncoveredStatementFile(1),
        [partial]: uncoveredStatementFile(2),
      },
    );

    main({ cwd: dir, log: quiet });

    const md = readReportMd(dir);
    assert.match(md, /### `src\/partial\.js`/);
    assert.ok(!md.includes("covered.js"));
    assert.ok(!md.includes("no-detail.js"));
  });
});

test("main() says so when coverage is below 100% but there is no per-file breakdown to show", async () => {
  await withTmpDir((dir) => {
    const entry = {
      lines: pct(50, 1, 2),
      statements: pct(50, 1, 2),
      functions: pct(100, 0, 0),
      branches: pct(100, 0, 0),
    };
    writeCoverage(dir, { total: entry }, {});
    main({ cwd: dir, log: quiet });
    const md = readReportMd(dir);
    assert.match(md, /❌ Test coverage is below the required 100%/);
    assert.match(md, /No per-file breakdown was available/);
  });
});

test("main() refuses a ✅ when a src file is missing from the report, even though c8's own totals say 100%", async () => {
  await withTmpDir((dir) => {
    const [tracked] = writeSources(dir, "tracked.js");
    writeSources(dir, "new-feature.js"); // on disk, never measured
    writeCoverage(dir, { total: fullEntry(), [tracked]: fullEntry() }, {});

    const result = main({ cwd: dir, log: quiet });

    assert.strictEqual(result.isFullyCovered, false);
    const md = readReportMd(dir);
    assert.match(md, /❌ Test coverage could not be verified/);
    assert.match(md, /Everything that was measured is at 100%/);
    assert.match(
      md,
      /\*\*Coverage data problems:\*\*\n- src\/new-feature\.js exists but is missing from the coverage report/,
    );
    assert.match(
      md,
      /Make sure every file under `src\/` is imported by a test/,
    );
    assert.ok(!md.includes("✅"));
  });
});

test("main() treats a run that measured nothing as a failure, not as 100%", async () => {
  await withTmpDir((dir) => {
    const unknown = { pct: "Unknown", covered: 0, total: 0 };
    const nothing = {
      lines: unknown,
      statements: unknown,
      functions: unknown,
      branches: unknown,
    };
    writeCoverage(dir, { total: nothing }, {});

    const result = main({ cwd: dir, log: quiet });

    assert.strictEqual(result.isFullyCovered, false);
    const md = readReportMd(dir);
    assert.match(md, /❌ Test coverage is below the required 100%/);
    assert.match(md, /No source files were found under src\//);
    assert.match(md, /No coverage data was collected/);
    assert.ok(!md.includes("✅"));
  });
});

test("main() shows both the per-file gaps and the data problems when both exist", async () => {
  await withTmpDir((dir) => {
    const [partial] = writeSources(dir, "partial.js");
    writeSources(dir, "dropped.js");
    const entry = {
      lines: pct(50, 1, 2),
      statements: pct(50, 1, 2),
      functions: pct(100, 0, 0),
      branches: pct(100, 0, 0),
    };
    writeCoverage(
      dir,
      { total: entry, [partial]: entry },
      { [partial]: uncoveredStatementFile(2) },
    );

    main({ cwd: dir, log: quiet });

    const md = readReportMd(dir);
    assert.match(md, /### `src\/partial\.js`/);
    assert.match(md, /Uncovered statements on line\(s\):\*\* 2/);
    assert.match(md, /src\/dropped\.js exists but is missing/);
    assert.match(md, /Add or extend tests under `test\/`/);
  });
});

test("main() truncates an over-long report and closes any code fence the cut landed inside", async () => {
  await withTmpDir((dir) => {
    // One file whose inlined snippet block alone dwarfs the limit, so the
    // cut provably lands inside that block's ```js fence.
    const file = path.join(dir, "src", "huge.js");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const hugeLine = `call(${"x".repeat(5000)});`;
    fs.writeFileSync(file, Array(30).fill(hugeLine).join("\n"));
    const statementMap = {};
    const s = {};
    for (let i = 0; i < 30; i += 1) {
      statementMap[i] = { start: { line: i + 1 } };
      s[i] = 0;
    }
    const entry = {
      lines: pct(0, 0, 30),
      statements: pct(0, 0, 30),
      functions: pct(100, 0, 0),
      branches: pct(100, 0, 0),
    };
    writeCoverage(
      dir,
      { total: entry, [file]: entry },
      { [file]: { statementMap, s, fnMap: {}, f: {}, branchMap: {}, b: {} } },
    );

    main({ cwd: dir, log: quiet });

    const md = readReportMd(dir);
    assert.match(md, /Report truncated/);
    assert.strictEqual((md.match(/^```/gm) || []).length % 2, 0);
    assert.ok(md.length < MAX_COMMENT_LENGTH + 500);
  });
});

test("main() never cuts an astral character (e.g. an emoji in a source line) in half when truncating", async () => {
  const lone =
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  // The cut lands on a high surrogate for exactly one of two fillers that
  // differ by one code unit; run both so the guard is exercised regardless
  // of how long the (changeable) report header happens to be.
  for (const filler of ["", "x"]) {
    await withTmpDir((dir) => {
      const file = path.join(dir, "src", "emoji.js");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const line = `${filler}${"😀".repeat(30000)}`;
      fs.writeFileSync(file, `${line}\n`);
      const entry = {
        lines: pct(0, 0, 1),
        statements: pct(0, 0, 1),
        functions: pct(100, 0, 0),
        branches: pct(100, 0, 0),
      };
      writeCoverage(
        dir,
        { total: entry, [file]: entry },
        { [file]: uncoveredStatementFile(1) },
      );
      const result = main({ cwd: dir, log: quiet });
      assert.match(result.markdown, /Report truncated/);
      // Checked in memory AND on disk: writing a lone surrogate as UTF-8
      // silently turns it into U+FFFD, so the file alone would hide it.
      assert.ok(
        !lone.test(result.markdown),
        "report must not contain a dangling surrogate",
      );
      assert.ok(!readReportMd(dir).includes("\uFFFD"));
    });
  }
});

test("main() rethrows a real read error instead of reporting the coverage data as missing (only ENOENT means missing)", async () => {
  await withTmpDir((dir) => {
    // A directory where the summary file should be: reading it fails with
    // EISDIR, which must not be mistaken for "not found".
    fs.mkdirSync(path.join(dir, "coverage", "coverage-summary.json"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(dir, "coverage", "coverage-final.json"), "{}");
    assert.throws(() => main({ cwd: dir, log: quiet }), /EISDIR/);
  });
});

test("main() explains a summary with no usable total section instead of a raw TypeError", async () => {
  await withTmpDir((dir) => {
    for (const summary of [
      {},
      { total: null },
      { total: { lines: pct(100, 1, 1) } }, // other metrics missing
    ]) {
      writeCoverage(dir, summary, {});
      assert.throws(
        () => main({ cwd: dir, log: quiet }),
        /has no usable "total" section/,
      );
    }
  });
});

test("main() keeps every data problem on one bullet even when a name from the PR contains line breaks, fences or headings", async () => {
  await withTmpDir((dir) => {
    const [tracked] = writeSources(dir, "tracked.js");
    // Legal on Linux: a file name with newlines, a fence and a fake heading.
    const evil = "evil\n```\n## ✅ Test coverage: 100%\n- fake.js";
    writeSources(dir, evil + ".js");
    writeCoverage(dir, { total: fullEntry(), [tracked]: fullEntry() }, {});

    main({ cwd: dir, log: quiet });

    const md = readReportMd(dir);
    // The forged text survives only as inline words inside the one bullet:
    // no line of the report may BE a success heading or open a code fence.
    assert.ok(!/^## ✅/m.test(md), "no forged success heading");
    assert.ok(!/^```/m.test(md), "no forged code fence");
    const problems = md
      .split("**Coverage data problems:**\n")[1]
      .split("\n\n")[0]
      .split("\n");
    assert.strictEqual(problems.length, 1, "exactly one bullet");
    assert.match(
      problems[0],
      /^- src\/evil .*exists but is missing from the coverage report/,
    );
  });
});

test("main() never writes through a symlink left at coverage/pr-comment.md by an earlier step", async () => {
  await withTmpDir((dir) => {
    const [tracked] = writeSources(dir, "a.js");
    writeCoverage(dir, { total: fullEntry(), [tracked]: fullEntry() }, {});
    const victim = path.join(dir, "victim.json");
    fs.writeFileSync(victim, '{"keep":"me"}');
    const out = path.join(dir, "coverage", "pr-comment.md");
    fs.symlinkSync(victim, out);

    main({ cwd: dir, log: quiet });

    assert.strictEqual(fs.readFileSync(victim, "utf8"), '{"keep":"me"}');
    assert.ok(!fs.lstatSync(out).isSymbolicLink(), "the link was replaced");
    assert.match(fs.readFileSync(out, "utf8"), /Test coverage: 100%/);
  });
});

test("main() overwrites a stale report from a previous run", async () => {
  await withTmpDir((dir) => {
    const [tracked] = writeSources(dir, "a.js");
    writeCoverage(dir, { total: fullEntry(), [tracked]: fullEntry() }, {});
    fs.writeFileSync(path.join(dir, "coverage", "pr-comment.md"), "stale");
    main({ cwd: dir, log: quiet });
    assert.ok(!readReportMd(dir).includes("stale"));
  });
});

test("main() throws a clear error when the coverage reports are missing", async () => {
  await withTmpDir((dir) => {
    assert.throws(
      () => main({ cwd: dir, log: quiet }),
      /Coverage reports not found under .*coverage/,
    );
  });
});

// --- CLI entrypoint -----------------------------------------------------------------

test("the CLI exits 0 and writes the report when coverage data exists", async () => {
  await withTmpDir((dir) => {
    const [a] = writeSources(dir, "a.js");
    writeCoverage(dir, { total: fullEntry(), [a]: fullEntry() }, {});
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /✅ Test coverage: 100%/);
    assert.match(readReportMd(dir), /✅ Test coverage: 100%/);
  });
});

test("the CLI prints the problem and exits 1 (instead of a stack trace) when coverage data is missing", async () => {
  await withTmpDir((dir) => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /Coverage reports not found/);
    assert.ok(!result.stderr.includes("    at "), "no stack trace");
  });
});

// --- against genuine c8 output ---------------------------------------------------------
// Hand-written fixtures can drift from what c8 really emits (c8 gets major
// version bumps from Dependabot). This runs the real c8 on a tiny project
// with a known gap and checks the report pinpoints exactly that gap.

test("the report pinpoints the real gaps in genuine c8 output (uncovered function, lines and branch)", async () => {
  await withTmpDir((dir) => {
    fs.mkdirSync(path.join(dir, "src"));
    fs.mkdirSync(path.join(dir, "test"));
    fs.writeFileSync(
      path.join(dir, "src", "lib.js"),
      [
        '"use strict";',
        "function used(x) {",
        "  if (x > 0) {",
        '    return "pos";',
        "  }",
        '  return "neg";',
        "}",
        "function neverCalled() {",
        "  return 42;",
        "}",
        "module.exports = { used, neverCalled };",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "test", "t.js"),
      'require("../src/lib.js").used(1);\n',
    );

    // The real c8, with the outer run's coverage collection switched off so
    // this inner run's data isn't mixed into it.
    const env = { ...process.env };
    delete env.NODE_V8_COVERAGE;
    const c8 = spawnSync(
      process.execPath,
      [
        require.resolve("c8/bin/c8.js"),
        // Explicit, absolute output locations inside the scratch dir: the
        // inner run must never share (and with c8's default `clean`, wipe)
        // the outer run's coverage data.
        `--reports-dir=${path.join(dir, "coverage")}`,
        `--temp-directory=${path.join(dir, "coverage", "tmp")}`,
        "--reporter=json-summary",
        "--reporter=json",
        "--all",
        "--include=src/**/*.js",
        "--check-coverage=false",
        process.execPath,
        "test/t.js",
      ],
      { cwd: dir, env, encoding: "utf8" },
    );
    assert.strictEqual(c8.status, 0, c8.stderr);

    const result = main({ cwd: dir, log: quiet });

    assert.strictEqual(result.isFullyCovered, false);
    const md = readReportMd(dir);
    assert.match(md, /### `src\/lib\.js`/);
    assert.match(md, /Never called by any test:\*\* `neverCalled` \(line 8\)/);
    assert.match(md, /Uncovered statements on line\(s\):\*\* 6, 8-10/);
    assert.match(md, /Branches with an untested path:\*\* line 6 \(1 path\)/);
  });
});

// --- runner -----------------------------------------------------------------------------

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
