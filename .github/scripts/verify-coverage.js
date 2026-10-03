#!/usr/bin/env node
"use strict";
/**
 * Independent safety net behind `npm run coverage:check`, run after
 * `c8 check-coverage`. c8's own threshold check only judges the files c8
 * decided to track, so it can pass when it should not:
 *
 *  - No data at all. If `include` matches nothing (src/ renamed, the
 *    pattern edited, a typo), c8 reports 0/0 with "Unknown" percentages and
 *    `c8 check-coverage` exits 0. "Nothing was measured" must never read
 *    as "100% covered".
 *  - A source file c8 silently dropped from the report (upstream tracks
 *    cases like this, e.g. bcoe/c8#588 and #610). A new, never-tested
 *    src/*.js must show up as 0% and fail the gate, not vanish from it.
 *
 * So this script does not trust c8's tracking. It lists the source files
 * on disk itself and requires every one of them to appear in
 * coverage/coverage-summary.json, with all four metrics fully covered and
 * at least some code measured overall.
 *
 * Scope: every .js/.cjs/.mjs file under src/ (the shipped action). If a
 * file type here is not matched by .c8rc.json's `include`, it is reported
 * as missing - which is the point: it forces the config to be fixed rather
 * than letting code ship unmeasured.
 *
 * Exports are pure functions so they can be tested without running c8.
 */

const fs = require("fs");
const path = require("path");

const SOURCE_DIR = "src";
const SOURCE_EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);
const METRICS = ["lines", "statements", "functions", "branches"];

// Absolute paths of every source file under <cwd>/src, sorted.
function listSourceFiles(cwd) {
  const root = path.join(cwd, SOURCE_DIR);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name)),
    )
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

const toPosix = (p) => p.split(path.sep).join("/");

// Problems that mean the report cannot be trusted, whatever its
// percentages say: nothing measured, or a source file absent from it.
function findDataProblems(summary, cwd) {
  const problems = [];
  const sources = listSourceFiles(cwd);

  if (sources.length === 0) {
    problems.push(
      `No source files were found under ${SOURCE_DIR}/ - there is nothing to measure, so a coverage result would be meaningless.`,
    );
  }

  const tracked = new Set(
    Object.keys(summary)
      .filter((key) => key !== "total")
      .map((key) => path.resolve(key)),
  );
  for (const file of sources) {
    if (!tracked.has(path.resolve(file))) {
      problems.push(
        `${toPosix(path.relative(cwd, file))} exists but is missing from the coverage report, so it was never measured. Check "include" in .c8rc.json.`,
      );
    }
  }

  const total = summary.total;
  if (!total || !(total.statements && total.statements.total > 0)) {
    problems.push(
      "No coverage data was collected (0 statements measured). The test run produced no usable coverage.",
    );
  }
  return problems;
}

// Independent restatement of the 100% rule from the raw counts: every
// measured metric must have covered === total.
function findThresholdProblems(summary) {
  const total = summary.total || {};
  return METRICS.filter(
    (metric) => !total[metric] || total[metric].covered !== total[metric].total,
  ).map((metric) => {
    const m = total[metric];
    return m
      ? `${metric} coverage is ${m.covered}/${m.total}, not 100%.`
      : `${metric} coverage is missing from the report.`;
  });
}

function verify({ cwd = process.cwd() } = {}) {
  const summaryPath = path.join(cwd, "coverage", "coverage-summary.json");
  if (!fs.existsSync(summaryPath)) {
    return [
      `${path.relative(cwd, summaryPath) || summaryPath} not found - run "npm run test:coverage-nocheck" first.`,
    ];
  }
  const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  return [...findDataProblems(summary, cwd), ...findThresholdProblems(summary)];
}

if (require.main === module) {
  const problems = verify();
  if (problems.length > 0) {
    for (const problem of problems) console.error(`ERROR: ${problem}`);
    process.exitCode = 1;
  } else {
    console.log(
      "Coverage data verified: every source file is measured at 100%.",
    );
  }
}

module.exports = {
  verify,
  listSourceFiles,
  findDataProblems,
  findThresholdProblems,
  SOURCE_DIR,
};
