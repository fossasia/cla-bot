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
 * TRUST BOUNDARY: the artifact (pr-comment.md / pr-comment-meta.json) was
 * built by coverage-report.js running in the *untrusted* coverage.yml job -
 * the same job that just executed the PR's own test files. That means
 * meta.prNumber cannot be trusted as-is: a malicious test could have
 * tampered with it (or with GITHUB_EVENT_PATH before coverage-report.js
 * read it) to point this privileged, pull-requests:write job at an
 * unrelated PR/issue. To close that off, we only ever use meta.prNumber as
 * a *candidate* to look up, then verify it against data GitHub itself
 * attaches to this trusted workflow_run event: we fetch that candidate PR
 * from the API and require its real head commit to equal
 * context.payload.workflow_run.head_sha (the SHA GitHub recorded as what
 * coverage.yml actually tested). An attacker can forge prNumber, but they
 * cannot forge another PR's real head SHA to match the commit under test,
 * so a forged/stale prNumber fails this check and the comment is skipped.
 *
 * This same check also fixes a second, unrelated problem: a stale rerun.
 * If an older coverage.yml run's comment job happens to finish after a
 * newer one (out-of-order workflow_run jobs), its recorded head_sha will
 * no longer match the PR's current head (which has since moved to the
 * newer commit), so the stale run is skipped instead of overwriting the
 * sticky comment with outdated results. (coverage-comment.yml's
 * concurrency group additionally serializes runs from the same source
 * branch as a first line of defense - see the comments there - but this
 * SHA check is what actually guarantees correctness, since concurrency
 * only reduces overlap, it doesn't eliminate it.)
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

  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));

  // meta.prNumber is only a *candidate* - see the trust-boundary note at
  // the top of this file. It gets verified below before it's used for
  // anything.
  const candidatePrNumber = meta.prNumber;
  if (!Number.isInteger(candidatePrNumber) || candidatePrNumber <= 0) {
    core.warning(
      "No usable pull request number in the coverage report metadata - skipping comment.",
    );
    return;
  }

  // The one piece of this event GitHub itself guarantees is trustworthy:
  // the exact commit coverage.yml actually ran against.
  const trustedHeadSha =
    context.payload.workflow_run && context.payload.workflow_run.head_sha;
  if (!trustedHeadSha) {
    core.warning(
      "No head SHA on the triggering workflow_run event - skipping comment (cannot verify the report's target PR).",
    );
    return;
  }

  const { owner, repo } = context.repo;

  let pr;
  try {
    pr = await github.rest.pulls.get({
      owner,
      repo,
      pull_number: candidatePrNumber,
    });
  } catch (err) {
    core.warning(
      `Could not fetch PR #${candidatePrNumber} to verify the coverage report's target - skipping comment. (${err.message || err})`,
    );
    return;
  }

  if (!pr.data || !pr.data.head || pr.data.head.sha !== trustedHeadSha) {
    core.warning(
      `Coverage report claims PR #${candidatePrNumber}, but that PR's current head (${
        pr.data && pr.data.head && pr.data.head.sha
      }) doesn't match the commit this workflow run actually tested (${trustedHeadSha}) - skipping comment. This is expected for a stale/superseded run, and is also what stops a forged report from targeting the wrong PR.`,
    );
    return;
  }

  const issue_number = candidatePrNumber;
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
