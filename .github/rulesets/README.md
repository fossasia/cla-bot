# Branch ruleset for `main` (as code)

`main.json` is an export-format GitHub **repository ruleset**. GitHub does not
read it from the repo on its own, so import it once (below). Keeping it here
means rule changes are reviewed diffs, and `test/ci-gate.test.js` checks that
it stays consistent with `ci.yml`.

## What it enforces on the default branch

| Rule                   | Setting                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| Require a pull request | Changes can only land through a pull request (this also blocks direct pushes to `main`).                      |
| Require status checks  | Only **`Required checks pass`**, from the GitHub Actions app (id `15368`); the branch need not be up to date. |
| Reviews / code owners  | **None.** `required_approving_review_count: 0`, `require_code_owner_review: false`.                           |
| Bypass list            | Empty - nobody skips CI, including admins.                                                                    |

So: **the only thing that decides whether a pull request can be merged is
whether CI is green.** Anyone with write access to the repository can open a
PR and merge it themselves the moment `Required checks pass` succeeds - no
approval, no code-owner review, no second person required. This is a
deliberate choice for this repository (see below), not an oversight.

### Branch protection has exactly one required condition, by design

This repository intentionally does **not** use `CODEOWNERS` or a required
code-owner/human review. Some setups pair a single CI gate with mandatory
review specifically because a pull request can edit the very workflow files
that define the gate (see the "Threat model" comment at the top of
`coverage.yml` and "How the coverage gate is enforced" in
`CONTRIBUTING.md`) - a required review is the one control a PR cannot grant
itself. That trade-off is **not** adopted here: this repository's maintainers
have chosen to keep merging frictionless for anyone with write access, and
accept that a PR could in principle touch the gate's own definition as long
as its own (possibly weakened) copy of the gate still reports green. If that
trade-off ever needs tightening for this or another repository, see
"Optional: add required review back" below - it is a small, additive change
to `main.json`, nothing else has to move.

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
  required check, `Required checks pass`, and **no** review requirement -
  the "Merge" button is enabled as soon as CI is green, for any contributor
  with write access.
- Break one check on a throwaway PR (for example an actionlint error): the
  gate must go red (not skipped), and Merge must stay blocked until it is
  fixed and reruns green.

## Optional: add required review back

Not used by this repository today, but if a team wants a human in the loop
later without giving up the "one required check" structure, two small,
independent additions do that without touching `ci.yml`:

- **Any reviewer, no CODEOWNERS file needed:** set
  `required_approving_review_count` to `1` (or more) in the `pull_request`
  rule in `main.json`, leave `require_code_owner_review: false`. Any
  collaborator with write access can give that approval.
- **Specific owners for specific paths:** add a `.github/CODEOWNERS` file
  and set `require_code_owner_review: true` in addition. This is the
  pattern the comment at the top of `coverage.yml` describes as the control
  that closes the "a PR can edit its own gate" gap - deliberately not
  enabled by default here (see above).

Either way, `required_approving_review_count` and
`require_code_owner_review` are the only two fields that change; the status
check and bypass list stay exactly as they are.

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
name (plus, as here, a plain `pull_request` rule with zero required
approvals if you want merges to stay review-free). An organization ruleset
can target many repositories with the same JSON shape - status-check names
are not indexed above repository level, so type the name instead of picking
it from a dropdown, and let each repository's own `ci.yml` keep `needs:` in
sync with its own job list.
