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
 * It also checks that what ships is what gets measured, because the gate
 * only means something if the executed code is inside src/:
 *
 *  - action.yml (a composite action) must run only `node` scripts that live
 *    under src/ and are in the report, and must not run inline (`-e`) or
 *    preloaded (`-r`) code, which is never measured. Otherwise action.yml
 *    could be pointed at an unmeasured script while src/ stays at 100%.
 *  - No file under src/ may load a relative module from outside src/ (also
 *    never measured).
 *
 * Scope: every .js/.cjs/.mjs file under src/ (the shipped action). If a
 * file type here is not matched by .c8rc.json's `include`, it is reported
 * as missing - which is the point: it forces the config to be fixed rather
 * than letting code ship unmeasured.
 *
 * This script is itself part of the PR, so it cannot protect against a PR
 * that edits it; see CONTRIBUTING.md "How the coverage gate is enforced".
 *
 * Exports are pure functions so they can be tested without running c8.
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const SOURCE_DIR = "src";
const SOURCE_EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);
const METRICS = ["lines", "statements", "functions", "branches"];

// Reads a file, or returns null if it does not exist. Reading and handling
// ENOENT is atomic, unlike "check it exists, then read it" (CodeQL
// js/file-system-race).
function readOptional(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

// Absolute paths of every source file under <cwd>/src, sorted.
function listSourceFiles(cwd) {
  const root = path.join(cwd, SOURCE_DIR);
  let entries;
  try {
    entries = fs.readdirSync(root, { recursive: true, withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return [];
    throw err;
  }
  return entries
    .filter(
      (entry) =>
        entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name)),
    )
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

const toPosix = (p) => p.split(path.sep).join("/");
const isInside = (root, target) => {
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

// --- action.yml: what the shipped action actually runs --------------------------------

// How a composite step may refer to the action's own directory. The
// ACTION_PATH variable form is only trusted when the step defines it as
// exactly `${{ github.action_path }}` (checked below), because a step's
// `env` could otherwise repoint it at a different tree.
const ACTION_PATH_EXPRESSION = "${{ github.action_path }}";
const ACTION_ROOT_PREFIXES = [
  { prefix: `${ACTION_PATH_EXPRESSION}/` },
  { prefix: "$ACTION_PATH/", envVar: "ACTION_PATH" },
  { prefix: "${ACTION_PATH}/", envVar: "ACTION_PATH" },
];

// `node [options] <script>`, with the script optionally quoted.
const NODE_INVOCATION =
  /(?:^|[\s;&|(])node((?:[ \t]+-[^\s]*)*)[ \t]+(?:"([^"\n]*)"|'([^'\n]*)'|((?:\$\{\{[^}\n]*\}\}|[^\s"';&|)])+))/g;
const INLINE_CODE_FLAG =
  /(?:^|\s)(?:-e|-p|-r|--eval|--print|--require|--import)(?:=|\s|$)/;

function findEntrypointProblems(cwd, tracked) {
  const text = readOptional(path.join(cwd, "action.yml"));
  if (text === null) return []; // no action, nothing shipped to verify

  let doc;
  try {
    doc = yaml.load(text);
  } catch (err) {
    return [
      `action.yml could not be parsed (${err.message}), so what the action runs cannot be verified.`,
    ];
  }
  const runs = doc && doc.runs;
  if (!runs || typeof runs !== "object") {
    return [
      "action.yml has no `runs` section, so what the action runs cannot be verified.",
    ];
  }

  const srcRoot = path.join(cwd, SOURCE_DIR);
  const problems = [];
  const targets = []; // absolute paths of node scripts the action runs

  if (runs.using === "composite") {
    for (const step of Array.isArray(runs.steps) ? runs.steps : []) {
      if (!step || typeof step.run !== "string") continue;
      for (const match of step.run.matchAll(NODE_INVOCATION)) {
        const options = match[1] || "";
        const target = match[2] ?? match[3] ?? match[4];
        if (INLINE_CODE_FLAG.test(options)) {
          problems.push(
            `action.yml runs node with inline or preloaded code ("node${options} ${target}"), which is never measured.`,
          );
          continue;
        }
        const root = ACTION_ROOT_PREFIXES.find((r) =>
          target.startsWith(r.prefix),
        );
        const envOk =
          root &&
          (!root.envVar ||
            (step.env && step.env[root.envVar] === ACTION_PATH_EXPRESSION));
        const rel = root ? target.slice(root.prefix.length) : null;
        if (!root || !envOk || /[$`\\]|(^|\/)\.\.(\/|$)/.test(rel)) {
          problems.push(
            `action.yml runs "node ${target}" from a location the gate cannot verify. Run scripts as node "${ACTION_PATH_EXPRESSION}/src/<file>.js" (or via an ACTION_PATH env var set to that expression).`,
          );
          continue;
        }
        targets.push(path.resolve(cwd, rel));
      }
    }
    if (targets.length === 0 && problems.length === 0) {
      problems.push(
        "action.yml does not run any node script from src/, so the shipped code is not what the coverage gate measures.",
      );
    }
  } else if (typeof runs.using === "string" && /^node\d+$/.test(runs.using)) {
    for (const key of ["main", "pre", "post"]) {
      if (typeof runs[key] === "string") {
        targets.push(path.resolve(cwd, runs[key]));
      }
    }
    if (targets.length === 0) {
      problems.push(
        "action.yml declares a node action without a `main` script.",
      );
    }
  } else {
    problems.push(
      `action.yml uses runs.using "${runs.using}", which the coverage gate cannot verify (only composite and node actions are supported).`,
    );
  }

  for (const target of targets) {
    const shown = toPosix(path.relative(cwd, target));
    if (!isInside(srcRoot, target)) {
      problems.push(
        `action.yml runs ${shown}, which is outside ${SOURCE_DIR}/ and therefore never measured by the coverage gate.`,
      );
    } else if (!tracked.has(target)) {
      problems.push(
        `action.yml runs ${shown}, but it is missing from the coverage report (it does not exist, or was never measured).`,
      );
    }
  }
  return problems;
}

// --- relative imports that leave src/ ---------------------------------------------------

const RELATIVE_IMPORT =
  /\b(?:require|import)\s*\(\s*(["'`])(\.\.?(?:\/[^"'`]*)?)\1|\b(?:from|import)\s+(["'])(\.\.?(?:\/[^"']*)?)\3/g;

function findImportProblems(cwd, sources) {
  const srcRoot = path.join(cwd, SOURCE_DIR);
  const problems = [];
  for (const file of sources) {
    const code = readOptional(file);
    if (code === null) continue; // vanished since it was listed
    for (const match of code.matchAll(RELATIVE_IMPORT)) {
      const specifier = match[2] ?? match[4];
      const resolved = path.resolve(path.dirname(file), specifier);
      if (resolved !== srcRoot && !isInside(srcRoot, resolved)) {
        problems.push(
          `${toPosix(path.relative(cwd, file))} loads "${specifier}", which is outside ${SOURCE_DIR}/ and therefore never measured.`,
        );
      }
    }
  }
  return problems;
}

// --- the checks --------------------------------------------------------------------------

// Problems that mean the report cannot be trusted, whatever its
// percentages say: nothing measured, a source file absent from it, or
// shipped code outside the measured tree.
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

  problems.push(...findEntrypointProblems(cwd, tracked));
  problems.push(...findImportProblems(cwd, sources));
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
  const text = readOptional(summaryPath);
  if (text === null) {
    return [
      `${path.relative(cwd, summaryPath) || summaryPath} not found - run "npm run test:coverage-nocheck" first.`,
    ];
  }
  const summary = JSON.parse(text);
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
  findEntrypointProblems,
  findImportProblems,
  SOURCE_DIR,
};
