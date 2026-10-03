"use strict";
/**
 * Offline tests for .github/scripts/verify-coverage.js - the independent
 * check run after `c8 check-coverage` so that "nothing was measured" or "a
 * source file was dropped from the report" can never pass as 100%.
 * Run: node test/verify-coverage.test.js (also part of `npm test`).
 *
 * The last group runs the REAL c8 with the project's REAL .c8rc.json on
 * tiny scratch projects, so these tests describe what c8 actually does
 * (including where it passes when it shouldn't) rather than what a
 * hand-written fixture assumes.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO_ROOT = path.join(__dirname, "..");
const SCRIPT_PATH = path.join(
  REPO_ROOT,
  ".github",
  "scripts",
  "verify-coverage.js",
);
const {
  verify,
  listSourceFiles,
  findDataProblems,
  findThresholdProblems,
} = require(SCRIPT_PATH);

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

async function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cla-bot-verify-cov-"));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

const metric = (covered, total) => ({
  covered,
  total,
  pct: total === 0 ? "Unknown" : (covered / total) * 100,
});
const fullMetrics = () => ({
  lines: metric(10, 10),
  statements: metric(10, 10),
  functions: metric(2, 2),
  branches: metric(4, 4),
});

function writeSummary(dir, summary) {
  fs.mkdirSync(path.join(dir, "coverage"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "coverage", "coverage-summary.json"),
    JSON.stringify(summary),
  );
}

// --- listSourceFiles ------------------------------------------------------------

test("listSourceFiles finds .js/.cjs/.mjs files at any depth under src/, sorted, and nothing else", async () => {
  await withTmpDir((dir) => {
    writeFiles(dir, {
      "src/b.js": "",
      "src/a.js": "",
      "src/deep/er/c.cjs": "",
      "src/d.mjs": "",
      "src/readme.md": "",
      "src/data.json": "",
      "test/not-src.js": "",
      "other/x.js": "",
    });
    assert.deepStrictEqual(
      listSourceFiles(dir).map((f) =>
        path.relative(dir, f).split(path.sep).join("/"),
      ),
      ["src/a.js", "src/b.js", "src/d.mjs", "src/deep/er/c.cjs"],
    );
  });
});

test("listSourceFiles returns an empty list when there is no src/ directory", async () => {
  await withTmpDir((dir) => {
    assert.deepStrictEqual(listSourceFiles(dir), []);
  });
});

// --- findDataProblems --------------------------------------------------------------

test("findDataProblems is clean when every source file is tracked and data exists", async () => {
  await withTmpDir((dir) => {
    writeFiles(dir, { "src/a.js": "", "src/lib/b.js": "" });
    const summary = {
      total: fullMetrics(),
      [path.join(dir, "src", "a.js")]: fullMetrics(),
      [path.join(dir, "src", "lib", "b.js")]: fullMetrics(),
    };
    assert.deepStrictEqual(findDataProblems(summary, dir), []);
  });
});

test("findDataProblems flags a source file that is missing from the report", async () => {
  await withTmpDir((dir) => {
    writeFiles(dir, { "src/tracked.js": "", "src/new-feature.js": "" });
    const summary = {
      total: fullMetrics(),
      [path.join(dir, "src", "tracked.js")]: fullMetrics(),
    };
    const problems = findDataProblems(summary, dir);
    assert.strictEqual(problems.length, 1);
    assert.match(
      problems[0],
      /src\/new-feature\.js exists but is missing from the coverage report/,
    );
  });
});

test("findDataProblems flags having no source files to measure", async () => {
  await withTmpDir((dir) => {
    const problems = findDataProblems({ total: fullMetrics() }, dir);
    assert.ok(
      problems.some((p) => /No source files were found under src\//.test(p)),
    );
  });
});

test("findDataProblems flags a run that measured zero statements, or has no total at all", async () => {
  await withTmpDir((dir) => {
    writeFiles(dir, { "src/a.js": "" });
    const tracked = { [path.join(dir, "src", "a.js")]: fullMetrics() };
    const empty = {
      lines: metric(0, 0),
      statements: metric(0, 0),
      functions: metric(0, 0),
      branches: metric(0, 0),
    };
    for (const total of [empty, undefined, { lines: metric(1, 1) }]) {
      const problems = findDataProblems({ ...tracked, total }, dir);
      assert.ok(
        problems.some((p) => /No coverage data was collected/.test(p)),
        JSON.stringify(total),
      );
    }
  });
});

// --- findThresholdProblems ---------------------------------------------------------

test("findThresholdProblems is clean when every metric is covered === total", () => {
  assert.deepStrictEqual(findThresholdProblems({ total: fullMetrics() }), []);
});

for (const name of ["lines", "statements", "functions", "branches"]) {
  test(`findThresholdProblems reports ${name} below 100% from the raw counts`, () => {
    const total = fullMetrics();
    total[name] = metric(total[name].total - 1, total[name].total);
    const problems = findThresholdProblems({ total });
    assert.strictEqual(problems.length, 1);
    assert.match(
      problems[0],
      new RegExp(`^${name} coverage is \\d+/\\d+, not 100%`),
    );
  });
}

test("findThresholdProblems reports a metric that is missing from the report entirely", () => {
  const total = fullMetrics();
  delete total.branches;
  assert.deepStrictEqual(findThresholdProblems({ total }), [
    "branches coverage is missing from the report.",
  ]);
  assert.strictEqual(findThresholdProblems({}).length, 4);
});

// --- verify() and the CLI ---------------------------------------------------------------

test("verify() reports a missing summary instead of throwing", async () => {
  await withTmpDir((dir) => {
    const problems = verify({ cwd: dir });
    assert.strictEqual(problems.length, 1);
    assert.match(problems[0], /coverage-summary\.json not found/);
  });
});

test("verify() defaults to the current directory and passes on a complete, fully covered report", async () => {
  await withTmpDir((dir) => {
    writeFiles(dir, { "src/a.js": "" });
    writeSummary(dir, {
      total: fullMetrics(),
      [path.join(dir, "src", "a.js")]: fullMetrics(),
    });
    const previous = process.cwd();
    process.chdir(dir);
    try {
      assert.deepStrictEqual(verify(), []);
    } finally {
      process.chdir(previous);
    }
  });
});

test("verify() combines data and threshold problems", async () => {
  await withTmpDir((dir) => {
    writeSummary(dir, { total: { ...fullMetrics(), lines: metric(1, 2) } });
    const problems = verify({ cwd: dir });
    assert.ok(problems.some((p) => /No source files/.test(p)));
    assert.ok(problems.some((p) => /^lines coverage is 1\/2/.test(p)));
  });
});

test("the CLI exits 0 with a confirmation when the report is complete and fully covered", async () => {
  await withTmpDir((dir) => {
    writeFiles(dir, { "src/a.js": "" });
    writeSummary(dir, {
      total: fullMetrics(),
      [path.join(dir, "src", "a.js")]: fullMetrics(),
    });
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /Coverage data verified/);
  });
});

test("the CLI prints every problem and exits 1 when something is wrong", async () => {
  await withTmpDir((dir) => {
    writeFiles(dir, { "src/a.js": "", "src/b.js": "" });
    writeSummary(dir, {
      total: fullMetrics(),
      [path.join(dir, "src", "a.js")]: fullMetrics(),
    });
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /ERROR: src\/b\.js exists but is missing/);
  });
});

// --- the real c8, with the project's real config ---------------------------------------------

// Runs c8 for real inside `dir`, writing its data and reports only under
// dir/coverage (explicit absolute paths, so it can never touch - and with
// c8's default `clean` wipe - the coverage data of an outer c8 run that is
// measuring this very test file).
function runC8(dir, args) {
  const env = { ...process.env };
  delete env.NODE_V8_COVERAGE;
  return spawnSync(
    process.execPath,
    [
      require.resolve("c8/bin/c8.js"),
      `--reports-dir=${path.join(dir, "coverage")}`,
      `--temp-directory=${path.join(dir, "coverage", "tmp")}`,
      ...args,
    ],
    { cwd: dir, env, encoding: "utf8" },
  );
}

function useProjectConfig(dir) {
  fs.copyFileSync(
    path.join(REPO_ROOT, ".c8rc.json"),
    path.join(dir, ".c8rc.json"),
  );
}

test("REAL c8 + the project's .c8rc.json: a new src file that no test imports shows up at 0% and fails the gate", async () => {
  await withTmpDir((dir) => {
    useProjectConfig(dir);
    writeFiles(dir, {
      "src/loaded.js": "module.exports = { a() { return 1; } };\n",
      "src/new-feature.js": "module.exports = { b() { return 2; } };\n",
      "test/t.js": 'require("../src/loaded.js").a();\n',
    });

    const run = runC8(dir, [process.execPath, "test/t.js"]);
    assert.notStrictEqual(run.status, 0, "c8 itself must fail the run");
    assert.match(run.stdout + run.stderr, /does not meet global threshold/);

    const summary = JSON.parse(
      fs.readFileSync(
        path.join(dir, "coverage", "coverage-summary.json"),
        "utf8",
      ),
    );
    const tracked = Object.keys(summary).map((k) => path.basename(k));
    assert.ok(
      tracked.includes("new-feature.js"),
      "the untested file must be tracked",
    );

    // And the independent check agrees, whatever c8 did.
    assert.deepStrictEqual(findDataProblems(summary, dir), []);
    assert.ok(findThresholdProblems(summary).length > 0);
  });
});

test("REAL c8: when `include` matches nothing, c8 check-coverage still passes - and verify() catches it", async () => {
  await withTmpDir((dir) => {
    // The "include was edited / src was renamed" failure mode.
    fs.writeFileSync(
      path.join(dir, ".c8rc.json"),
      JSON.stringify({
        all: true,
        include: ["nonexistent/**/*.js"],
        reporter: ["json-summary", "json"],
        "check-coverage": true,
        lines: 100,
        statements: 100,
        functions: 100,
        branches: 100,
      }),
    );
    writeFiles(dir, {
      "src/untracked.js": "module.exports = 1;\n",
      "test/t.js": 'require("../src/untracked.js");\n',
    });

    const run = runC8(dir, [process.execPath, "test/t.js"]);
    const check = runC8(dir, ["check-coverage"]);
    // This is the upstream gap the guard exists for: nothing measured, yet
    // c8 is happy. If a c8 upgrade fixes it, this assertion will say so.
    assert.strictEqual(run.status, 0, run.stderr);
    assert.strictEqual(check.status, 0, check.stdout + check.stderr);

    const problems = verify({ cwd: dir });
    assert.ok(
      problems.some((p) => /src\/untracked\.js exists but is missing/.test(p)),
    );
    assert.ok(problems.some((p) => /No coverage data was collected/.test(p)));
  });
});

test("REAL c8 + the project's .c8rc.json: a fully tested project passes both c8 and verify()", async () => {
  await withTmpDir((dir) => {
    useProjectConfig(dir);
    writeFiles(dir, {
      "src/lib.js": "module.exports = { a() { return 1; } };\n",
      "test/t.js": 'require("../src/lib.js").a();\n',
    });
    const run = runC8(dir, [process.execPath, "test/t.js"]);
    assert.strictEqual(run.status, 0, run.stdout + run.stderr);
    assert.deepStrictEqual(verify({ cwd: dir }), []);
  });
});

// --- the project's own config ------------------------------------------------------------------
// Not a security control (a PR can edit this file and this test together -
// see CONTRIBUTING.md "How the coverage gate is enforced"), but it makes any
// weakening of the gate an explicit, visible failure in the diff.

test(".c8rc.json keeps the gate at 100% on every metric, measuring all of src/", () => {
  const config = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, ".c8rc.json"), "utf8"),
  );
  assert.strictEqual(config["check-coverage"], true);
  assert.strictEqual(config.all, true);
  assert.ok(config.include.includes("src/**/*.js"));
  for (const m of ["lines", "statements", "functions", "branches"]) {
    assert.strictEqual(config[m], 100, `${m} threshold`);
  }
  assert.ok(
    config.reporter.includes("json-summary"),
    "verify() reads json-summary",
  );
  assert.ok(config.reporter.includes("json"), "coverage-report.js reads json");
});

// --- runner -----------------------------------------------------------------------------------------

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
