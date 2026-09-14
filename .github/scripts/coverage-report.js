#!/usr/bin/env node
"use strict";
/**
 * Turns c8's istanbul-format coverage output into a human-readable PR
 * comment: overall percentages plus, for anything below 100%, the exact
 * lines, functions and branches that still need a test.
 *
 * Self-written and dependency-free (only Node's own `fs`/`path`), in
 * keeping with the rest of this project - see package.json's description.
 *
 * Reads:  coverage/coverage-summary.json, coverage/coverage-final.json
 * Writes: coverage/pr-comment.md, coverage/pr-comment-meta.json
 *
 * Run after `npm run coverage` (which is what actually enforces the
 * threshold and fails the job - this script never itself changes the
 * job's exit code, it only formats a report from whatever c8 produced).
 */

const fs = require("fs");
const path = require("path");

const COVERAGE_DIR = path.join(process.cwd(), "coverage");
const SUMMARY_PATH = path.join(COVERAGE_DIR, "coverage-summary.json");
const FINAL_PATH = path.join(COVERAGE_DIR, "coverage-final.json");
const OUT_MD = path.join(COVERAGE_DIR, "pr-comment.md");
const OUT_META = path.join(COVERAGE_DIR, "pr-comment-meta.json");

const METRICS = ["lines", "statements", "functions", "branches"];

function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

// Collapses a sorted list of line numbers into "12, 30-33, 41" style ranges
// so a file with fifty uncovered lines doesn't turn into a fifty-item list.
function toRanges(lines) {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const ranges = [];
  let start = null;
  let prev = null;
  for (const n of sorted) {
    if (start === null) {
      start = n;
    } else if (n !== prev + 1) {
      ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
      start = n;
    }
    prev = n;
  }
  if (start !== null) {
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
  }
  return ranges;
}

// c8 reports branch coverage from V8's own native counters, not from
// istanbul source instrumentation - so unlike classic nyc/istanbul output,
// every branchMap entry here has a generic type ("branch") and exactly one
// location; there's no reliable "if" vs "else" / "true" vs "false" label to
// read off it. Showing the actual source line is more honest and more
// useful than guessing a label from data that doesn't encode it.
function sourceSnippet(sourceLines, lineNumber) {
  const text = sourceLines[lineNumber - 1];
  return text === undefined ? null : text.trim();
}

function relativize(absolutePath) {
  return path.relative(process.cwd(), absolutePath).split(path.sep).join("/");
}

function analyzeFile(fileCoverage) {
  const uncoveredStatementLines = [];
  for (const [id, count] of Object.entries(fileCoverage.s)) {
    if (count === 0) {
      uncoveredStatementLines.push(fileCoverage.statementMap[id].start.line);
    }
  }

  const uncoveredFunctions = [];
  for (const [id, count] of Object.entries(fileCoverage.f)) {
    if (count === 0) {
      const fn = fileCoverage.fnMap[id];
      uncoveredFunctions.push({
        name:
          fn.name && fn.name !== "(anonymous_0)"
            ? fn.name
            : "(anonymous function)",
        line: fn.decl.start.line,
      });
    }
  }

  // Group by line and count how many separate paths through that line
  // never ran, since c8's branch data doesn't distinguish "if" from
  // "else" (see sourceSnippet's comment above).
  const branchLineCounts = new Map();
  for (const [id, hits] of Object.entries(fileCoverage.b)) {
    const branch = fileCoverage.branchMap[id];
    hits.forEach((count, index) => {
      if (count === 0) {
        const loc = branch.locations[index] || branch.loc;
        const line = loc.start.line;
        branchLineCounts.set(line, (branchLineCounts.get(line) || 0) + 1);
      }
    });
  }

  return { uncoveredStatementLines, uncoveredFunctions, branchLineCounts };
}

// Caps how many lines of source snippet we inline per file, so a file with
// hundreds of uncovered lines still produces a readable (and GitHub
// comment-length-safe) report instead of dumping the whole file.
const MAX_SNIPPET_LINES_PER_FILE = 25;

function formatFileSection(relPath, summary, detail, sourceLines) {
  const lines = [
    `### \`${relPath}\` — ${summary.lines.pct}% lines, ${summary.branches.pct}% branches, ${summary.functions.pct}% functions`,
  ];

  if (detail.uncoveredFunctions.length > 0) {
    const fns = detail.uncoveredFunctions
      .sort((a, b) => a.line - b.line)
      .map((fn) => `\`${fn.name}\` (line ${fn.line})`)
      .join(", ");
    lines.push(`**Never called by any test:** ${fns}`);
  }

  if (detail.uncoveredStatementLines.length > 0) {
    const ranges = toRanges(detail.uncoveredStatementLines);
    lines.push(`**Missing line coverage:** ${ranges.join(", ")}`);

    let shown = 0;
    const snippetLines = [];
    for (const lineNo of [...detail.uncoveredStatementLines].sort(
      (a, b) => a - b,
    )) {
      if (shown >= MAX_SNIPPET_LINES_PER_FILE) break;
      const text = sourceSnippet(sourceLines, lineNo);
      if (text) {
        snippetLines.push(`${lineNo}: ${text}`);
        shown += 1;
      }
    }
    if (snippetLines.length > 0) {
      const omitted = detail.uncoveredStatementLines.length - shown;
      lines.push(
        "```js\n" +
          snippetLines.join("\n") +
          (omitted > 0
            ? `\n... (${omitted} more uncovered line${omitted === 1 ? "" : "s"})`
            : "") +
          "\n```",
      );
    }
  }

  if (detail.branchLineCounts.size > 0) {
    const branchLines = [...detail.branchLineCounts.entries()].sort(
      (a, b) => a[0] - b[0],
    );
    const summaryText = branchLines
      .map(
        ([lineNo, count]) =>
          `line ${lineNo} (${count} path${count === 1 ? "" : "s"})`,
      )
      .join(", ");
    lines.push(`**Branches with an untested path:** ${summaryText}`);

    const snippetLines = branchLines
      .slice(0, MAX_SNIPPET_LINES_PER_FILE)
      .map(([lineNo, count]) => {
        const text = sourceSnippet(sourceLines, lineNo);
        return `${lineNo}: ${text || ""}  // ${count} path${count === 1 ? "" : "s"} through this line not exercised`;
      });
    if (snippetLines.length > 0) {
      const omitted = branchLines.length - snippetLines.length;
      lines.push(
        "```js\n" +
          snippetLines.join("\n") +
          (omitted > 0
            ? `\n... (${omitted} more line${omitted === 1 ? "" : "s"} with an untested branch)`
            : "") +
          "\n```",
      );
    }
  }

  return lines.join("\n\n");
}

function main() {
  if (!fs.existsSync(SUMMARY_PATH) || !fs.existsSync(FINAL_PATH)) {
    console.error(
      `Coverage reports not found under ${COVERAGE_DIR}. Run "npm run coverage" first (with --reporter=json-summary --reporter=json).`,
    );
    process.exit(1);
  }

  const summary = readJSON(SUMMARY_PATH);
  const final = readJSON(FINAL_PATH);
  const total = summary.total;

  const isFullyCovered = METRICS.every((m) => total[m].pct === 100);

  const metricsLine = METRICS.map(
    (m) => `**${total[m].pct}%** ${m} (${total[m].covered}/${total[m].total})`,
  ).join(" · ");

  const bodyParts = [];

  if (isFullyCovered) {
    bodyParts.push("## ✅ Test coverage: 100%");
    bodyParts.push(metricsLine);
    bodyParts.push(
      "Every statement, branch and function is exercised by the test suite. Nice work!",
    );
  } else {
    bodyParts.push("## ❌ Test coverage is below the required 100%");
    bodyParts.push(
      `This project requires **100% test coverage** on every pull request. Current coverage: ${metricsLine}.`,
    );
    bodyParts.push("Here's exactly what still needs a test, file by file:");

    const fileSections = [];
    for (const [absPath, fileSummary] of Object.entries(summary)) {
      if (absPath === "total") continue;
      if (
        fileSummary.lines.pct === 100 &&
        fileSummary.branches.pct === 100 &&
        fileSummary.functions.pct === 100
      ) {
        continue;
      }
      const fileCoverage = final[absPath];
      if (!fileCoverage) continue;
      const detail = analyzeFile(fileCoverage);
      const sourceLines = fs.existsSync(absPath)
        ? fs.readFileSync(absPath, "utf8").split("\n")
        : [];
      fileSections.push(
        formatFileSection(
          relativize(absPath),
          fileSummary,
          detail,
          sourceLines,
        ),
      );
    }

    bodyParts.push(fileSections.join("\n\n---\n\n"));
    bodyParts.push(
      "Add or extend tests under `test/` so every line above is executed and every branch is taken both ways, then push again - this comment will update automatically.",
    );
  }

  bodyParts.push(
    "\n<sub>Generated from `npm run coverage` (c8). This comment is updated in place on every push.</sub>",
  );

  let markdown = bodyParts.join("\n\n");

  // GitHub caps issue/PR comment bodies at 65536 characters. Leave headroom
  // for the truncation notice itself and for the sticky-comment marker the
  // posting step prepends.
  const MAX_COMMENT_LENGTH = 60000;
  if (markdown.length > MAX_COMMENT_LENGTH) {
    markdown =
      markdown.slice(0, MAX_COMMENT_LENGTH) +
      "\n\n---\n**⚠️ Report truncated** - too many files/lines to list here. Run `npm run coverage` locally for the full breakdown.";
  }

  fs.writeFileSync(OUT_MD, markdown, "utf8");

  const eventPath = process.env.GITHUB_EVENT_PATH;
  let prNumber = null;
  if (eventPath && fs.existsSync(eventPath)) {
    const event = readJSON(eventPath);
    prNumber = (event.pull_request && event.pull_request.number) || null;
  }

  fs.writeFileSync(
    OUT_META,
    JSON.stringify(
      {
        prNumber,
        status: isFullyCovered ? "pass" : "fail",
        pct: {
          lines: total.lines.pct,
          statements: total.statements.pct,
          functions: total.functions.pct,
          branches: total.branches.pct,
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(markdown);
  if (!prNumber) {
    console.warn(
      "No pull_request number found in the event payload - the comment step will skip posting.",
    );
  }
}

main();
