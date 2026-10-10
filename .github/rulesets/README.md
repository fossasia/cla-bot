# Repository rulesets

These JSON files are ruleset exports. GitHub does not apply them
automatically. `test/ci-gate.test.js` checks that `main.json` matches the CI
workflow.

## Default branch

`main.json` requires pull requests and one status check: **Required checks
pass** from GitHub Actions (app id `15368`). It has no approval requirement
and an empty bypass list. The gate depends on every other CI job and fails if
any job fails or is skipped.

Import it in **Settings → Rules → Rulesets** after `Required checks pass` has
run on `main`:

```bash
gh api --method POST repos/fossasia/cla-bot/rulesets --input .github/rulesets/main.json
```

If branch protection already exists, keep it until the new ruleset is active
and verified. Remove the old rule only after the new check is required and
passing.

Verify the result in GitHub settings and with a test PR. Confirm the only
required check is `Required checks pass`, there is no approval requirement,
and a failing or skipped CI job blocks merging.

## Release tags

`release-tags.json` allows tag creation but blocks updates and deletions of
`v*` tags. Import it as a repository admin:

```bash
gh api --method POST repos/fossasia/cla-bot/rulesets --input .github/rulesets/release-tags.json
```

Check that it targets `refs/tags/v*`, blocks updates and deletions, and has an
empty bypass list. The release workflow queries the effective repository and inherited
tag rulesets, then checks the active ruleset's target and block rules. GitHub may
hide the bypass list from its read-only token, so an administrator must verify the empty bypass
list. To correct a published version, release a new version
instead of moving or deleting its tag.

## Optional CodeQL blocking

A green CodeQL job means the analysis ran, not that there are no alerts. To
block merges on findings, add this rule to `main.json` after CodeQL has results
for both the PR and base branch:

```json
{
  "type": "code_scanning",
  "parameters": {
    "code_scanning_tools": [
      {
        "tool": "CodeQL",
        "alerts_threshold": "errors",
        "security_alerts_threshold": "high_or_higher"
      }
    ]
  }
}
```

If merge queues are enabled, add `merge_group:` to `ci.yml` too.

## Other repositories

Use one CI workflow with a final `if: always()` job that depends on every
check, then require only that job's status. Keep each repository's job list
and gate dependencies in sync.
