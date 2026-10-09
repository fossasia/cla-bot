#!/usr/bin/env node
"use strict";
/** Formats c8 output as a Markdown coverage report. The privileged comment
 * workflow treats this report as untrusted and gets the PR and commit from
 * GitHub's workflow_run event, not from the report.
 */

const fs = require("fs");
const path = require("path");
const { findDataProblems } = require("./verify-coverage.js");

const METRICS = ["lines", "statements", "functions", "branches"];

// GitHub caps issue/PR comment bodies at 65536 characters. Leave headroom
// for the truncation notice itself and for the sticky-comment marker the
// posting step prepends.
const MAX_COMMENT_LENGTH = 60000;

// Caps how many lines of source snippet we inline per file, so a file with
// hundreds of uncovered lines still produces a readable (and GitHub
// comment-length-safe) report instead of dumping the whole file.
const MAX_SNIPPET_LINES_PER_FILE = 25;

// Resolved on every call (not once at require time) so the paths always
// follow the *current* working directory - this is what makes main()
// testable from a scratch directory, and it avoids a stale-path bug if a
// caller chdir()s after requiring this module.
function resolvePaths(cwd) {
  const coverageDir = path.join(cwd, "coverage");
  return {
    coverageDir,
    summaryPath: path.join(coverageDir, "coverage-summary.json"),
    finalPath: path.join(coverageDir, "coverage-final.json"),
    outMd: path.join(coverageDir, "pr-comment.md"),
  };
}

// Reads a file, or returns null if it does not exist. Reading and handling
// ENOENT is atomic, unlike "check it exists, then read it", where the file
// can vanish or change in between (CodeQL js/file-system-race).
function readOptional(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

// Source text and names are inserted into Markdown, so anything that could
// start a new Markdown line mid-snippet has to go. That includes a lone CR
// and the Unicode line/paragraph separators, not just \n: a source line
// like "a\r```\rb" would otherwise close our code fence and let the rest of
// the line render as Markdown. (Every snippet line is also prefixed with its
// line number, so a snippet line can never itself start with a fence.)
const LINE_BREAKS_AND_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
const scrub = (text) => text.replace(LINE_BREAKS_AND_CONTROLS, " ");

// Text placed inside `inline code` spans: also cannot contain a backtick.
const inlineCode = (text) => scrub(text).replace(/`/g, "'");

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
  return text === undefined ? null : scrub(text).trim();
}

function relativize(absolutePath, cwd = process.cwd()) {
  return path.relative(cwd, absolutePath).split(path.sep).join("/");
}

// A file only counts as fully covered when ALL FOUR metrics are 100%.
// Checking just lines/branches/functions is a real bug: two statements on
// one source line leave `lines` at 100% while `statements` is below it.
function isFileFullyCovered(fileSummary) {
  return METRICS.every((metric) => fileSummary[metric].pct === 100);
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

// A hard length cut (e.g. for the comment-length cap below) can land inside
// a ```js fence emitted by formatFileSection. An odd number of fence
// markers means the string ends mid-block - close it so whatever gets
// appended after renders as text, not code.
function closeUnbalancedFence(text) {
  const isUnbalanced = (text.match(/^```/gm) || []).length % 2 === 1;
  return isUnbalanced ? `${text}\n\`\`\`` : text;
}

function formatFileSection(relPath, summary, detail, sourceLines) {
  const lines = [
    `### \`${inlineCode(relPath)}\` — ${summary.lines.pct}% lines, ${summary.statements.pct}% statements, ${summary.branches.pct}% branches, ${summary.functions.pct}% functions`,
  ];

  if (detail.uncoveredFunctions.length > 0) {
    const fns = detail.uncoveredFunctions
      .sort((a, b) => a.line - b.line)
      .map((fn) => `\`${inlineCode(fn.name)}\` (line ${fn.line})`)
      .join(", ");
    lines.push(`**Never called by any test:** ${fns}`);
  }

  if (detail.uncoveredStatementLines.length > 0) {
    const ranges = toRanges(detail.uncoveredStatementLines);
    // Deliberately "statements", not "lines": a line can run while another
    // statement sharing it never did (lines 100% but statements < 100%),
    // so what is actually missing is a statement that *starts* on these lines.
    lines.push(`**Uncovered statements on line(s):** ${ranges.join(", ")}`);

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

function main({ cwd = process.cwd(), log = console.log } = {}) {
  const { coverageDir, summaryPath, finalPath, outMd } = resolvePaths(cwd);

  const summaryText = readOptional(summaryPath);
  const finalText = readOptional(finalPath);
  if (summaryText === null || finalText === null) {
    throw new Error(
      `Coverage reports not found under ${coverageDir}. Run "npm run coverage" first (the c8 config in .c8rc.json already emits the json-summary and json reporters this script reads).`,
    );
  }

  const summary = JSON.parse(summaryText);
  const final = JSON.parse(finalText);
  const total = summary.total;
  if (!total || METRICS.some((metric) => !total[metric])) {
    throw new Error(
      `${summaryPath} has no usable "total" section (every one of ${METRICS.join(", ")} is required), so no report can be built.`,
    );
  }

  // c8's percentages only describe the files c8 chose to track. The same
  // independent checks `npm run coverage:check` runs (nothing measured, or
  // a src file missing from the report) must veto a "100%" here too, or
  // this comment would say ✅ while the gate fails.
  const dataProblems = findDataProblems(summary, cwd);
  const metricsFull = isFileFullyCovered(total);
  const isFullyCovered = metricsFull && dataProblems.length === 0;

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
    if (metricsFull) {
      bodyParts.push("## ❌ Test coverage could not be verified");
      bodyParts.push(
        `Everything that was measured is at 100% (${metricsLine}), but the coverage data is incomplete, so the 100% requirement is not met.`,
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
        if (isFileFullyCovered(fileSummary)) continue;
        const fileCoverage = final[absPath];
        if (!fileCoverage) continue;
        const detail = analyzeFile(fileCoverage);
        const source = readOptional(absPath);
        const sourceLines = source === null ? [] : source.split("\n");
        fileSections.push(
          formatFileSection(
            relativize(absPath, cwd),
            fileSummary,
            detail,
            sourceLines,
          ),
        );
      }

      // The totals say "below 100%" but no individual file could be broken
      // down (e.g. coverage-final.json has no entry for it). Say so instead
      // of leaving the contributor with a header and nothing under it.
      bodyParts.push(
        fileSections.length > 0
          ? fileSections.join("\n\n---\n\n")
          : "_No per-file breakdown was available in the coverage data._",
      );
    }

    if (dataProblems.length > 0) {
      bodyParts.push(
        // Problems quote names taken from the PR (file names, import
        // specifiers), so line breaks and control characters are scrubbed:
        // one problem must stay one bullet, never a forged heading or fence.
        `**Coverage data problems:**\n${dataProblems.map((p) => `- ${scrub(p)}`).join("\n")}`,
      );
    }

    bodyParts.push(
      metricsFull
        ? "Make sure every file under `src/` is imported by a test and matched by `include` in `.c8rc.json`, then push again - this comment will update automatically."
        : "Add or extend tests under `test/` so every statement, function and branch listed above is executed (and every branch taken both ways), then push again - this comment will update automatically. Run `npm run coverage` locally for the full breakdown.",
    );
  }

  bodyParts.push(
    "\n<sub>Generated from `npm run coverage` (c8). This comment is updated in place on every push.</sub>",
  );

  let markdown = bodyParts.join("\n\n");

  if (markdown.length > MAX_COMMENT_LENGTH) {
    // .slice() counts UTF-16 code units, so the cut can land between the two
    // halves of an astral character (e.g. an emoji in a source snippet).
    // Drop a dangling high surrogate rather than emit a malformed string.
    const cut = markdown
      .slice(0, MAX_COMMENT_LENGTH)
      .replace(/[\uD800-\uDBFF]$/, "");
    markdown =
      closeUnbalancedFence(cut) +
      "\n\n---\n**⚠️ Report truncated** - too many files/lines to list here. Run `npm run coverage` locally for the full breakdown.";
  }

  // The tests that ran earlier are PR code and may have left a symlink at
  // this path. A plain write would follow it and overwrite its target, so
  // remove whatever is there first (rmSync removes a link, never its
  // target) and then create the file exclusively ("wx" refuses to follow or
  // reuse anything that appeared in between).
  fs.rmSync(outMd, { force: true });
  fs.writeFileSync(outMd, markdown, { encoding: "utf8", flag: "wx" });
  log(markdown);

  return { isFullyCovered, markdown };
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

module.exports = {
  main,
  analyzeFile,
  isFileFullyCovered,
  toRanges,
  formatFileSection,
  relativize,
  resolvePaths,
  sourceSnippet,
  closeUnbalancedFence,
  MAX_COMMENT_LENGTH,
  MAX_SNIPPET_LINES_PER_FILE,
};
