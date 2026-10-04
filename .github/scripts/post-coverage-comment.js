"use strict";
/**
 * Posts (or updates in place) the "Test Coverage" comment on a pull
 * request, using the report that coverage.yml already built and uploaded
 * as an artifact.
 *
 * This runs from coverage-comment.yml, a `workflow_run`-triggered workflow
 * with pull-requests:write, specifically so it can comment even on PRs
 * from forks (where the pull_request-triggered coverage.yml only ever gets
 * a read-only token, by GitHub's own design - see the comments in both
 * workflow files). It never checks out or executes anything from the PR
 * itself: the only input is the coverage report artifact, a single
 * Markdown file, not code.
 *
 * TRUST BOUNDARY. The artifact was produced by a job that ran the PR's own
 * (untrusted) test code, so NOTHING in it may decide where or whether this
 * privileged job writes. Concretely:
 *
 *  1. WHICH pull request gets the comment is derived only from the
 *     `workflow_run` event payload, which GitHub itself fills in and PR
 *     content cannot influence. The artifact carries no PR number at all
 *     (a forged number would otherwise let a malicious PR make this job
 *     comment on any other issue or PR - an IDOR).
 *       - Same-repo PR: `workflow_run.pull_requests` has exactly one entry.
 *       - Fork PR: GitHub leaves that list EMPTY, so the PR is looked up by
 *         `<head owner>:<head branch>` among ALL PRs (open or closed) at
 *         the tested commit that already existed when the run was created.
 *         Requiring "already existed" is what stops an old run from being
 *         attached to a LATER PR that merely reuses the same fork branch
 *         and commit (old PR closed, new one opened at the same SHA). If it
 *         is not exactly one such PR, or that PR is not open, we skip.
 *     Zero or several candidates means "can't tell which PR this is", and
 *     the job skips commenting rather than guess.
 *  2. WHETHER the report is still current. Checking the PR's live head
 *     against `workflow_run.head_sha` (the commit coverage.yml tested)
 *     once is NOT enough on its own: a push can land between that check
 *     and the write, and the check and the write cannot be made atomic
 *     through the REST API. So freshness is enforced in layers, each
 *     closing part of the window:
 *       a. the head SHA is checked when the PR is resolved AND again
 *          immediately before the comment is written;
 *       b. each comment carries a hidden tag with the workflow run number
 *          and attempt (from the trusted event payload), and an older run
 *          never overwrites a comment written by a newer one, whatever
 *          order the jobs happen to finish in;
 *       c. coverage-comment.yml serialises these jobs per branch
 *          (concurrency without cancel-in-progress), so two jobs never
 *          read-then-write the same comment at once.
 *     What is left is a window of milliseconds in which an old report can
 *     be visible; it is corrected as soon as the newer run's comment job
 *     runs, because (b) lets the newer run overwrite it. The visible
 *     "measured at commit" line lets a reader spot a stale comment, which
 *     can still happen if the newer run fails before producing a report.
 *  3. The report TEXT is still the PR's own output shown back on its own
 *     PR, so it is treated as untrusted content: it must be a small regular
 *     file (not a symlink), @mentions are defused so a PR can't use the
 *     bot to ping people or teams, HTML comment openers are defused so it
 *     can't hide content or imitate our hidden tag, and it is
 *     length-checked against GitHub's comment limit.
 *  4. The PR can also edit the files that DEFINE the gate (.c8rc.json,
 *     package.json, action.yml, coverage.yml ...), because coverage.yml runs
 *     the PR's own copy on `pull_request`. Only repository rules
 *     (CODEOWNERS + required reviews + a required status check) can truly
 *     prevent that, see CONTRIBUTING.md "How the coverage gate is
 *     enforced". What this privileged job adds is visibility: it lists the
 *     PR's changed files via the API (not from the artifact) and puts a
 *     warning at the top of the comment when any gate file is touched, so a
 *     reviewer cannot miss that the "100%" below was measured with the
 *     PR's own rules.
 *
 * Expected to be invoked from actions/github-script as:
 *   const script = require(`${process.env.GITHUB_WORKSPACE}/.github/scripts/post-coverage-comment.js`);
 *   await script({ github, context, core });
 */

const fs = require("fs");
const path = require("path");

// Hidden marker so we find and update our own previous comment instead of
// piling up a new one on every push - the same "one sticky status comment"
// approach cla-bot's own CLA-signing logic already uses for its own
// pending/success comments.
const MARKER = "<!-- cla-bot:coverage-report -->";

// Comments made with the workflow's GITHUB_TOKEN are authored by this
// account. Matching the exact login (rather than just "is some bot")
// means another bot - or a person quoting the marker - can never be picked
// up as "our" comment and edited.
const BOT_LOGIN = "github-actions[bot]";

const REPORT_FILE = "pr-comment.md";

// coverage-report.js already caps its output at ~60k characters, so a
// legitimate report is far below this; anything bigger isn't ours.
const MAX_REPORT_BYTES = 256 * 1024;

// GitHub rejects comment bodies over 65536 characters.
const MAX_COMMENT_LENGTH = 65000;

// Room kept for everything WE add around the report: marker, run tag, the
// gate-change notice and the commit footer. Worst case is about 1.6k
// characters (see MAX_LISTED_GATE_FILES / MAX_NAME_LENGTH below, and the
// test that computes it), so 2000 is a guaranteed bound, not a guess.
const NOTICE_RESERVE = 2000;

// Files whose content decides what "100% coverage" means, what counts as
// the shipped code, or whether the check runs at all. A change to any of
// them is flagged to reviewers.
const GATE_FILES = new Set([
  ".c8rc.json",
  "action.yml",
  "package.json",
  "package-lock.json",
  ".github/CODEOWNERS",
  ".github/workflows/coverage.yml",
  ".github/workflows/coverage-comment.yml",
]);
const GATE_DIR_PREFIX = ".github/scripts/";
const MAX_LISTED_GATE_FILES = 10;
// File names come from the PR and can be ~255 characters each; cap what is
// echoed so the notice has a hard upper bound.
const MAX_NAME_LENGTH = 80;

const RUN_TAG_PATTERN =
  /^<!-- cla-bot:coverage-report -->\n<!-- cla-bot:coverage-run (\d{1,15})\.(\d{1,6}) -->/;

// Inserts a zero-width space after every "@" that would start a mention
// (@user, @org/team), which stops GitHub from resolving it into a
// notification while leaving the text readable. Likewise "<!--" is split so
// the report can neither hide content in an HTML comment nor imitate the
// hidden tags this script writes.
function sanitizeReport(text) {
  return text
    .replace(/@(?=[A-Za-z0-9])/g, "@\u200b")
    .replace(/<!--/g, "<!\u200b--");
}

// Reads the report only if it is a plain, reasonably-sized file. The file is
// opened ONCE with O_NOFOLLOW (a symlink makes the open fail with ELOOP
// instead of being silently followed to somewhere else on the runner), and
// the type check, the size check and the read all use that one descriptor.
// There is no "check the path, then use the path" gap in which the file
// could be swapped (CodeQL js/file-system-race).
function readReport(reportPath, core) {
  let fd;
  try {
    fd = fs.openSync(
      reportPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
  } catch (err) {
    if (err.code === "ELOOP") {
      core.warning(
        `${reportPath} is not a regular file - skipping comment instead of following it.`,
      );
    } else {
      core.warning(
        `Coverage report artifact not found at ${reportPath} - the coverage job may have failed before it could generate one. Skipping comment.`,
      );
    }
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      core.warning(
        `${reportPath} is not a regular file - skipping comment instead of following it.`,
      );
      return null;
    }
    if (stat.size > MAX_REPORT_BYTES) {
      core.warning(
        `${reportPath} is ${stat.size} bytes, over the ${MAX_REPORT_BYTES}-byte limit for a coverage report - skipping comment.`,
      );
      return null;
    }
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

// "Did this PR already exist when the workflow run was created?" Both
// timestamps are set by GitHub. Anything unparsable counts as "no", so a
// malformed value can only ever make us skip, never comment.
function existedBefore(pr, run) {
  const prCreated = Date.parse(pr.created_at);
  const runCreated = Date.parse(run.created_at);
  return !Number.isNaN(prCreated) && !Number.isNaN(runCreated)
    ? prCreated <= runCreated
    : false;
}

// Works out which PR this workflow_run is for, using ONLY data GitHub
// attached to the event (see "TRUST BOUNDARY" above), and confirms that PR
// is still open and still at the commit that was tested. Returns the live
// pull request object, or null (after logging why) when the comment should
// be skipped.
async function resolveTrustedPullRequest({ github, context, core }) {
  const run = context.payload.workflow_run;
  const { owner, repo } = context.repo;
  const linked = run.pull_requests || [];

  let pr;
  if (linked.length > 1) {
    core.warning(
      `The workflow_run event is linked to ${linked.length} pull requests - can't tell which one this report belongs to, so skipping comment.`,
    );
    return null;
  }

  if (linked.length === 1) {
    try {
      ({ data: pr } = await github.rest.pulls.get({
        owner,
        repo,
        pull_number: linked[0].number,
      }));
    } catch (err) {
      core.warning(
        `Could not fetch PR #${linked[0].number} to verify the coverage report's target - skipping comment. (${err.message || err})`,
      );
      return null;
    }
  } else {
    // GitHub leaves workflow_run.pull_requests empty when the PR's head
    // branch lives in a fork, so look the PR up by "<fork owner>:<branch>".
    const headOwner = run.head_repository?.owner?.login;
    if (!headOwner || !run.head_branch) {
      core.warning(
        "The workflow_run event has no linked pull request and no head repository/branch to look one up by - skipping comment.",
      );
      return null;
    }
    // ALL states, not just open: a closed PR that was at this commit when
    // the run started is exactly what makes the target ambiguous.
    const candidates = await github.paginate(github.rest.pulls.list, {
      owner,
      repo,
      state: "all",
      head: `${headOwner}:${run.head_branch}`,
      per_page: 100,
    });
    const matches = candidates.filter(
      (c) => c.head.sha === run.head_sha && existedBefore(c, run),
    );
    if (matches.length !== 1) {
      core.warning(
        `Expected exactly one pull request at commit ${run.head_sha} on ${headOwner}:${run.head_branch} that existed when this run started, found ${matches.length} - skipping comment.`,
      );
      return null;
    }
    pr = matches[0];
  }

  return isCurrent(pr, run, core) ? pr : null;
}

// The PR must be open and still at the commit that was tested.
function isCurrent(pr, run, core) {
  if (pr.state !== "open") {
    core.info(`PR #${pr.number} is no longer open - skipping comment.`);
    return false;
  }
  if (pr.head.sha !== run.head_sha) {
    core.info(
      `Coverage report is for commit ${run.head_sha}, but PR #${pr.number}'s current head is ${pr.head.sha} - a newer push has already superseded this run. Skipping comment.`,
    );
    return false;
  }
  return true;
}

// {number, attempt} of the triggering run, or null when the payload does
// not carry usable values (then no tag is written and no ordering guard is
// applied, which only loses the extra protection).
function runOrder(run) {
  const number = Number(run.run_number);
  const attempt = Number(run.run_attempt ?? 1);
  return Number.isSafeInteger(number) &&
    number > 0 &&
    Number.isSafeInteger(attempt) &&
    attempt > 0
    ? { number, attempt }
    : null;
}

const runTag = ({ number, attempt }) =>
  `<!-- cla-bot:coverage-run ${number}.${attempt} -->`;

// True when the existing comment was written by a NEWER run than this one.
// Only the tag at the very top of the body (the part this script wrote) is
// read; anything an artifact could add sits below it and is ignored.
function isSupersededBy(previousBody, order) {
  const match = RUN_TAG_PATTERN.exec(previousBody || "");
  if (!match || !order) return false;
  const number = Number(match[1]);
  const attempt = Number(match[2]);
  return (
    number > order.number ||
    (number === order.number && attempt > order.attempt)
  );
}

const isGateFile = (filename) =>
  GATE_FILES.has(filename) || filename.startsWith(GATE_DIR_PREFIX);

// File names come from the PR, so keep only characters that are inert in
// Markdown before echoing one back, and cap the length.
function safeName(filename) {
  const clean = filename.replace(/[^A-Za-z0-9._\-/]/g, "?");
  return clean.length > MAX_NAME_LENGTH
    ? `${clean.slice(0, MAX_NAME_LENGTH)}...`
    : clean;
}

// Builds the warning shown above the report when the PR touches the files
// that define the gate. The file list comes from the API for the verified
// PR, never from the artifact. If it cannot be fetched we say so rather
// than silently showing nothing, because "no warning" must mean "checked,
// nothing changed".
async function gateChangeNotice({ github, context, core, pr }) {
  const { owner, repo } = context.repo;
  let files;
  try {
    files = await github.paginate(github.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: pr.number,
      per_page: 100,
    });
  } catch (err) {
    core.warning(
      `Could not list PR #${pr.number}'s files to check for gate changes. (${err.message || err})`,
    );
    return "> [!WARNING]\n> Could not check whether this PR changes the coverage gate itself (the file list was unavailable). Reviewers: check `.c8rc.json`, `package.json`, `action.yml` and `.github/` manually.\n\n";
  }

  const touched = new Set();
  for (const file of files) {
    for (const name of [file.filename, file.previous_filename]) {
      if (typeof name === "string" && isGateFile(name)) touched.add(name);
    }
  }
  if (touched.size === 0) return "";

  const names = [...touched].sort();
  const shown = names
    .slice(0, MAX_LISTED_GATE_FILES)
    .map((name) => `> - \`${safeName(name)}\``);
  if (names.length > MAX_LISTED_GATE_FILES) {
    shown.push(`> - ...and ${names.length - MAX_LISTED_GATE_FILES} more`);
  }
  return [
    "> [!WARNING]",
    "> **This PR changes files that define the coverage gate.** The result below was measured with this PR's own versions of them, so it proves nothing about the rules on `main`. Reviewers: review these changes by hand.",
    ">",
    ...shown,
    "",
    "",
  ].join("\n");
}

// Visible, trusted line saying which commit the report is for, so a stale
// comment is recognisable at a glance.
function commitFooter(run) {
  return /^[0-9a-f]{40}$/i.test(run.head_sha)
    ? `\n\n<sub>Measured at commit \`${run.head_sha.slice(0, 7)}\`.</sub>`
    : "";
}

module.exports = async ({ github, context, core }) => {
  const run = context.payload.workflow_run;
  if (!run || !run.head_sha) {
    core.warning(
      "No workflow_run head SHA on the triggering event - cannot verify what was tested, skipping comment.",
    );
    return;
  }

  // Cheap local checks first, so a missing artifact never costs an API call.
  const reportPath = path.join(
    process.env.GITHUB_WORKSPACE || ".",
    "coverage-artifact",
    REPORT_FILE,
  );
  const report = readReport(reportPath, core);
  if (report === null) {
    return;
  }

  const reportBody = sanitizeReport(report);
  if (reportBody.length > MAX_COMMENT_LENGTH - NOTICE_RESERVE) {
    core.warning(
      `Coverage report is ${reportBody.length} characters, over GitHub's comment limit - skipping comment.`,
    );
    return;
  }

  const pr = await resolveTrustedPullRequest({ github, context, core });
  if (!pr) {
    return;
  }

  const { owner, repo } = context.repo;
  const issue_number = pr.number;
  const order = runOrder(run);

  const notice = await gateChangeNotice({ github, context, core, pr });
  const header = order ? `${MARKER}\n${runTag(order)}\n` : `${MARKER}\n`;
  const commentBody = `${header}${notice}${reportBody}${commitFooter(run)}`;
  // NOTICE_RESERVE is a proven bound (see its comment and the test that
  // computes the worst case), so this cannot trip: the report was already
  // checked against MAX_COMMENT_LENGTH - NOTICE_RESERVE above. It stays as
  // the last line of defence against a 422 from GitHub if someone later
  // lengthens the notice without raising the reserve. Excluded from
  // coverage because no input can reach it today.
  /* c8 ignore start */
  if (commentBody.length > MAX_COMMENT_LENGTH) {
    core.warning(
      `Comment would be ${commentBody.length} characters, over GitHub's limit - skipping comment.`,
    );
    return;
  }
  /* c8 ignore stop */

  const existing = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number,
    per_page: 100,
  });
  const previous = existing.find(
    (c) => c.user?.login === BOT_LOGIN && c.body?.includes(MARKER),
  );

  if (previous && isSupersededBy(previous.body, order)) {
    core.info(
      `Comment ${previous.id} on PR #${issue_number} was written by a newer coverage run - not overwriting it with this older one.`,
    );
    return;
  }

  // Second freshness check, as close to the write as the API allows. A push
  // that lands after this point is handled by the run-order tag above and
  // by the newer run's own comment job (see "TRUST BOUNDARY" 2).
  let latest;
  try {
    ({ data: latest } = await github.rest.pulls.get({
      owner,
      repo,
      pull_number: issue_number,
    }));
  } catch (err) {
    core.warning(
      `Could not re-check PR #${issue_number} before commenting - skipping comment. (${err.message || err})`,
    );
    return;
  }
  if (!isCurrent(latest, run, core)) {
    return;
  }

  if (previous) {
    await github.rest.issues.updateComment({
      owner,
      repo,
      comment_id: previous.id,
      body: commentBody,
    });
    core.info(
      `Updated existing coverage comment (id ${previous.id}) on PR #${issue_number}.`,
    );
  } else {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number,
      body: commentBody,
    });
    core.info(`Posted a new coverage comment on PR #${issue_number}.`);
  }

  // Deliberately not core.setFailed() here: the actual pass/fail gate for
  // branch protection is coverage.yml's own job (it runs directly on
  // pull_request, so it can be marked as a required status check). This
  // workflow's only responsibility is posting the comment - keeping the
  // two signals in one place avoids confusing PR authors with a second,
  // differently-named failing check for the same underlying reason.
};

module.exports.resolveTrustedPullRequest = resolveTrustedPullRequest;
module.exports.sanitizeReport = sanitizeReport;
module.exports.readReport = readReport;
module.exports.gateChangeNotice = gateChangeNotice;
module.exports.isGateFile = isGateFile;
module.exports.isSupersededBy = isSupersededBy;
module.exports.runOrder = runOrder;
module.exports.commitFooter = commitFooter;
module.exports.MARKER = MARKER;
module.exports.BOT_LOGIN = BOT_LOGIN;
module.exports.MAX_REPORT_BYTES = MAX_REPORT_BYTES;
module.exports.MAX_COMMENT_LENGTH = MAX_COMMENT_LENGTH;
module.exports.NOTICE_RESERVE = NOTICE_RESERVE;
module.exports.MAX_LISTED_GATE_FILES = MAX_LISTED_GATE_FILES;
module.exports.MAX_NAME_LENGTH = MAX_NAME_LENGTH;
