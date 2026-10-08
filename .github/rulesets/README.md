# Branch ruleset for `main` (as code)

`main.json` is an export-format GitHub **repository ruleset**. GitHub does not
read it from the repo on its own, so import it once (below). Keeping it here
means rule changes are tracked as repository diffs, and `test/ci-gate.test.js`
checks that it stays consistent with `ci.yml`.

## What it enforces on the default branch

| Rule                   | Setting                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| Require a pull request | Changes can only land through a pull request (this also blocks direct pushes to `main`).                      |
| Require status checks  | Only **`Required checks pass`**, from the GitHub Actions app (id `15368`); the branch need not be up to date. |
| Human approvals        | None required for any path.                                                                                     |
| Bypass list            | Empty - nobody skips CI, including admins.                                                                    |

Anyone with repository write access can propose and merge changes once CI is
green. No team membership or separate human approval is required for any path.

## Protect published release tags

`release-tags.json` is a tag ruleset for `v*` release tags. It leaves tag
creation open to repository writers (the release authorization policy) while
blocking updates and deletions after creation. This prevents a tag from being
moved or recreated during or after release verification. It does not make the
GitHub Release immutable: release notes and assets remain editable by actors
with repository write access, as described in `SECURITY.md`.

Import it once as a repository admin:

This is an external repository setting: the release workflow does not query
GitHub's effective rulesets and cannot prove this protection is active. Treat
importing and verifying it as a required setup step before the first release.

```bash
gh api --method POST repos/fossasia/cla-bot/rulesets --input .github/rulesets/release-tags.json
```

Verify that the active ruleset targets `refs/tags/v*`, has both `update` and
`deletion` rules, and has an empty bypass list. A correction that requires
moving or deleting a version tag must be released under a new version instead.

Why one check: `Required checks pass` (job `required-checks-pass` in
`ci.yml`) `needs:` every other job, so adding, removing or renaming a check
never needs a settings change again - edit `ci.yml` and the gate picks it up
automatically. Why the app id: it stops any other app, or a plain commit
status with the same name, from satisfying the rule.

## Before you apply it

1. Merge the change that adds `Required checks pass` (i.e. this `ci.yml`) and
   let it run on `main` at least once. Requiring a check name that has never
   reported leaves pull requests stuck on "Expected - waiting for status to
   be reported".
2. The ruleset API and the UI both need **admin** rights on the repository.

## Apply - no existing protection on `main`

Settings -> Rules -> Rulesets -> New ruleset -> **Import a ruleset** ->
`.github/rulesets/main.json`, or with the CLI as a repo admin:

```bash
gh api --method POST repos/fossasia/cla-bot/rulesets --input .github/rulesets/main.json
# update later (find the id first):
gh api repos/fossasia/cla-bot/rulesets --jq '.[] | [.id,.name]'
gh api --method PUT repos/fossasia/cla-bot/rulesets/<id> --input .github/rulesets/main.json
```

## Apply - `main` already has a protection rule or required checks

**Never remove the old protection first**: if the import fails or you are
interrupted, `main` would be unprotected in between. The order is
_add, verify, then remove_:

1. Leave the old rule alone. Old required check names (`actionlint`,
   `zizmor`, `Analyze (...)`, `Enforce 100% coverage`, `test (22)`, ...) no
   longer exist after this change, so the pull request that introduces it
   cannot satisfy them; an admin merges it using the existing bypass, or
   swaps the old names for `Required checks pass` in the old rule in a
   single edit (the name is selectable once the PR's CI has run).
   Protection never lapses.
2. Let `Required checks pass` run on `main` once, then import the ruleset
   above.
3. Verify (below). Rulesets and classic branch-protection rules stack - the
   stricter wins - so nothing is weaker while both exist.
4. Only now delete the old rule / old required checks / any old required
   reviews, so there is a single source of truth for branch protection.

## Verify (do all three)

- `gh api repos/fossasia/cla-bot/rules/branches/main` lists the
  `pull_request` and `required_status_checks` rules, and nothing else.
- A throwaway PR that only edits `README.md`: merge box shows exactly one
  required status check, `Required checks pass`, and no review requirement.
- A throwaway PR that edits `release.yml`: verify it has no human approval
  requirement and remains blocked only until required CI passes.
- Break one check on a throwaway PR (for example an actionlint error): the
  gate must go red (not skipped), and Merge must stay blocked until it is
  fixed and reruns green.

## Optional: block on CodeQL alerts

A green `codeql` job in `ci.yml` means the analysis ran, not that there are
no alerts - CodeQL does not fail its own job on findings. To also block
merges on new alerts, add this rule to `main.json`:

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

It is off by default on purpose: the rule waits until CodeQL has results for
both the PR commit and the base branch, so it blocks forever if the analysis
ever crashes or produces nothing (and, if a merge queue is ever enabled,
needs `merge_group:` added to `ci.yml`). Enable it once CodeQL has run on
`main` and you are happy with its stability.

## Applying the same idea to other FOSSASIA repositories

Same pattern per repository: one `ci.yml` with a final `if: always()` job
that `needs:` the others, and one ruleset requiring only that job's check
name (plus, as here, a `pull_request` rule with zero approvals). An organization ruleset
can target many repositories with the same JSON shape - status-check names
are not indexed above repository level, so type the name instead of picking
it from a dropdown, and let each repository's own `ci.yml` keep `needs:` in
sync with its own job list.
