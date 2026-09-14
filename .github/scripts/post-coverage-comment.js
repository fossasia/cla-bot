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
  if (!meta.prNumber) {
    core.warning(
      "No pull request number in the coverage report metadata - skipping comment.",
    );
    return;
  }

  const reportBody = fs.readFileSync(bodyPath, "utf8");
  const commentBody = `${MARKER}\n${reportBody}`;

  const { owner, repo } = context.repo;
  const issue_number = meta.prNumber;

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
