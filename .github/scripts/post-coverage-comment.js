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
 *         `<head owner>:<head branch>` and must match the tested commit.
 *     Zero or several candidates means "can't tell which PR this is", and
 *     the job skips commenting rather than guess.
 *  2. WHETHER the report is still current is checked against the PR's live
 *     head commit (fetched fresh from the API) versus
 *     `workflow_run.head_sha`, the commit coverage.yml actually tested. If
 *     a newer push has superseded it, this run is skipped, so a slow,
 *     out-of-order job can't overwrite the sticky comment with outdated
 *     results. (coverage-comment.yml's concurrency group only reduces such
 *     overlap; this check is what makes it correct.)
 *  3. The report TEXT is still the PR's own output shown back on its own
 *     PR, so it is treated as untrusted content: it must be a small regular
 *     file (not a symlink), @mentions are defused so a PR can't use the
 *     bot to ping people or teams, and it is length-checked against
 *     GitHub's comment limit.
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

// Inserts a zero-width space after every "@" that would start a mention
// (@user, @org/team), which stops GitHub from resolving it into a
// notification while leaving the text readable.
function neutralizeMentions(text) {
  return text.replace(/@(?=[A-Za-z0-9])/g, "@\u200b");
}

// Reads the report only if it is a plain, reasonably-sized file. lstat
// (not stat) so a symlink is reported as a symlink instead of silently
// followed to somewhere else on the runner.
function readReport(reportPath, core) {
  let stat;
  try {
    stat = fs.lstatSync(reportPath);
  } catch {
    core.warning(
      `Coverage report artifact not found at ${reportPath} - the coverage job may have failed before it could generate one. Skipping comment.`,
    );
    return null;
  }
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
  return fs.readFileSync(reportPath, "utf8");
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
    const candidates = await github.paginate(github.rest.pulls.list, {
      owner,
      repo,
      state: "open",
      head: `${headOwner}:${run.head_branch}`,
      per_page: 100,
    });
    const matches = candidates.filter((c) => c.head.sha === run.head_sha);
    if (matches.length !== 1) {
      core.warning(
        `Expected exactly one open pull request at commit ${run.head_sha} on ${headOwner}:${run.head_branch}, found ${matches.length} - skipping comment.`,
      );
      return null;
    }
    pr = matches[0];
  }

  if (pr.state !== "open") {
    core.info(`PR #${pr.number} is no longer open - skipping comment.`);
    return null;
  }
  if (pr.head.sha !== run.head_sha) {
    core.info(
      `Coverage report is for commit ${run.head_sha}, but PR #${pr.number}'s current head is ${pr.head.sha} - a newer push has already superseded this run. Skipping comment.`,
    );
    return null;
  }
  return pr;
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

  const commentBody = `${MARKER}\n${neutralizeMentions(report)}`;
  if (commentBody.length > MAX_COMMENT_LENGTH) {
    core.warning(
      `Coverage report is ${commentBody.length} characters, over GitHub's comment limit - skipping comment.`,
    );
    return;
  }

  const pr = await resolveTrustedPullRequest({ github, context, core });
  if (!pr) {
    return;
  }

  const { owner, repo } = context.repo;
  const issue_number = pr.number;

  const existing = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number,
    per_page: 100,
  });
  const previous = existing.find(
    (c) => c.user?.login === BOT_LOGIN && c.body?.includes(MARKER),
  );

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
module.exports.neutralizeMentions = neutralizeMentions;
module.exports.readReport = readReport;
module.exports.MARKER = MARKER;
module.exports.BOT_LOGIN = BOT_LOGIN;
module.exports.MAX_REPORT_BYTES = MAX_REPORT_BYTES;
module.exports.MAX_COMMENT_LENGTH = MAX_COMMENT_LENGTH;
