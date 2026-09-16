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
 * itself: the only input is the coverage report artifact, which is just
 * JSON/Markdown text, not code.
 *
 * Two trust boundaries matter here, because the artifact this reads was
 * produced by a job that ran the PR's own (untrusted) test code:
 *
 *  1. WHICH issue/PR to comment on is never taken from the artifact. A
 *     PR's test run could tamper with the coverage job's output before it's
 *     uploaded (e.g. by monkey-patching fs, or just because a bug in our
 *     own script reads the wrong value) and claim to be about some other
 *     issue/PR number entirely - if we trusted that, this privileged,
 *     pull-requests:write job would post to whatever issue the artifact
 *     said. Instead we only ever use `context.payload.workflow_run.
 *     pull_requests`, which GitHub itself computes server-side from the
 *     workflow run's actual head branch and is not something PR content
 *     can influence.
 *  2. WHETHER this specific report is still current is checked against the
 *     PR's live head sha (fetched fresh via the API, not trusted from the
 *     artifact either) before writing anything. Coverage jobs for older
 *     pushes to the same PR aren't guaranteed to finish in order, so
 *     without this check a slow, stale run could finish after a newer one
 *     and overwrite the sticky comment with outdated results.
 *
 * The report *content* (coverage percentages, which lines are missing) is
 * still taken from the artifact as-is - that's just the PR's own honest
 * result being displayed back on its own comment, not a trust boundary.
 *
 * Expected to be invoked from actions/github-script as:
 *   const script = require(process.env.GITHUB_WORKSPACE + '/.github/scripts/post-coverage-comment.js');
 *   await script({ github, context, core });
 */

const fs = require("fs");
const path = require("path");

// Hidden marker so we find and update our own previous comment instead of
// piling up a new one on every push - the same "one sticky status comment"
// approach cla-bot's own CLA-signing logic already uses for its own
// pending/success comments.
const MARKER = "<!-- cla-bot:coverage-report -->";

// Resolves the PR this workflow_run was actually for, from data GitHub
// itself attached to the event - never from anything the triggering job's
// (PR-controlled) code could have written. Returns null if there isn't
// exactly one unambiguous PR, in which case the caller should skip
// commenting rather than guess.
function resolveTrustedPullRequest(context, core) {
  const pullRequests =
    (context.payload.workflow_run &&
      context.payload.workflow_run.pull_requests) ||
    [];
  if (pullRequests.length !== 1) {
    core.warning(
      `Expected exactly one associated pull request on the workflow_run event, found ${pullRequests.length} - skipping comment (can't safely determine the target).`,
    );
    return null;
  }
  return pullRequests[0];
}

module.exports = async ({ github, context, core }) => {
  const artifactDir = path.join(
    process.env.GITHUB_WORKSPACE || ".",
    "coverage-artifact",
  );
  const metaPath = path.join(artifactDir, "pr-comment-meta.json");
  const bodyPath = path.join(artifactDir, "pr-comment.md");

  if (!fs.existsSync(metaPath) || !fs.existsSync(bodyPath)) {
    core.warning(
      `Coverage report artifact not found under ${artifactDir} - the coverage job may have failed before it could generate one. Skipping comment.`,
    );
    return;
  }

  const trustedPR = resolveTrustedPullRequest(context, core);
  if (!trustedPR) {
    return;
  }

  const { owner, repo } = context.repo;
  const issue_number = trustedPR.number;

  // Fetch the PR's *current* head sha fresh from the API (not from the
  // artifact, and not from the workflow_run payload's own possibly-stale
  // snapshot) and compare it to the sha the report was actually generated
  // for. A mismatch means a newer push has already superseded this run -
  // writing its (now-stale) results over the sticky comment would show
  // outdated coverage for the PR's current code, so we skip instead.
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  const { data: currentPR } = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: issue_number,
  });
  if (!meta.headSha || meta.headSha !== currentPR.head.sha) {
    core.info(
      `Coverage report is for commit ${meta.headSha || "(unknown)"}, but PR #${issue_number}'s current head is ${currentPR.head.sha} - a newer push has already superseded this run. Skipping comment.`,
    );
    return;
  }

  const reportBody = fs.readFileSync(bodyPath, "utf8");
  const commentBody = `${MARKER}\n${reportBody}`;

  const existing = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number,
  });
  const previous = existing.find(
    (c) => c.user?.type === "Bot" && c.body?.includes(MARKER),
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
module.exports.MARKER = MARKER;
