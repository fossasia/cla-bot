# Contributing to fossasia/cla-bot

Thanks for wanting to improve this! A few ground rules specific to this
repo, since it's security-sensitive infrastructure used across all of
FOSSASIA's projects.

## Ground rules

1. **No new runtime dependencies without discussion.** The shipped action
   (`src/cla-bot.js`, run via `action.yml`) uses only Node.js built-ins on
   purpose - adding a package reintroduces the "could get abandoned or
   compromised" risk this project exists to avoid. If you think one is
   genuinely justified, open an issue first. (CI tooling is a different
   bar: `.github/workflows/ci.yml` installs `js-yaml` purely to validate
   `action.yml`'s structure, and `c8` measures test coverage. Neither ships
   with the action, so neither counts against this rule.)
2. **Every change to `src/cla-bot.js` needs a matching test.** Pick the
   right layer: `test/logic.test.js` for pure functions (no network),
   `test/http.test.js` for anything touching `readSignatures`/`writeSignatures`
   (mocked `fetch`), `test/sig-path.test.js` for how `SIG_PATH`/`SIG_OWNER`/
   `SIG_REPO` become request URLs (validation + encoding), `test/integration.test.js` for changes to event
   orchestration (`handleIssueComment`, `checkPR`), and
   `test/bot-identity*.test.js` for anything about how the bot resolves its
   own identity, and `test/token-expiry.test.js` for anything about the
   signatures-repo token's lifetime (caching, refresh, 401 recovery),
   `test/release-check.test.js` for the release helper script and
   `test/release-workflow.test.js` for the properties of `release.yml`. Run `npm test` before opening a PR - CI runs it too, on
   Node 22 and 24.
3. **This repo requires 100% test coverage (lines, statements, functions
   and branches) on every PR**, enforced by `.github/workflows/coverage.yml`
   (called from `ci.yml` - see "CI structure and the single required check"
   below). Run `npm run coverage` locally before pushing - it fails the same way CI
   does if anything is untested, and `npm run coverage:report` turns that
   into the same human-readable breakdown (missing lines, never-called
   functions, untested branches) that gets posted as a PR comment. The 100%
   gate covers the shipped action (`src/`); the CI helper scripts in
   `.github/scripts/` have their own tests (`test/coverage-report.test.js`,
   `test/post-coverage-comment.test.js`, `test/verify-coverage.test.js`) -
   update those too if you change them (`npm run coverage:scripts` applies
   the same 100% rule to them).
4. **Don't weaken any of the security properties** listed at the top of
   `src/cla-bot.js` or in `SECURITY.md` (impersonation guard, exact-match
   allowlist, short-lived tokens, etc.) without discussing it in an issue
   first.
5. Changes to `action.yml` inputs should stay backward compatible where
   possible; if a breaking change is unavoidable, bump the major version
   tag and note it in `CHANGELOG.md`.
6. **When changing the release pipeline** (`.github/workflows/release.yml`,
   `.github/scripts/release-check.js`), update its regression tests and keep
   the documented behavior accurate. Repository writers can merge changes to
   these files under the same PR and CI rules as every other path; there is no
   separate team approval. `test/release-workflow.test.js` checks important
   least-privilege, pinning and ordering properties. Every third-party action
   there is pinned to a full commit SHA. The
   `publish` job has `contents: write` but runs no third-party actions or
   repository code; actions needing OIDC/signing permissions are isolated in
   the separate `sign` job, which cannot publish releases. The shipped
   `action.yml` may only `uses:` direct Actions pinned that way, and no local
   `./` action (the SBOM refuses anything else rather than omitting it from
   its direct-action inventory).

## How the coverage gate is enforced (maintainers)

The 100% rule is only as strong as the files that define it, and a pull
request can edit those files: `ci.yml` (which calls `coverage.yml`) runs on
`pull_request`, so GitHub uses the PR's _own_ copy of the workflow,
`package.json`, `.c8rc.json` and `.github/scripts/`. A PR could therefore
lower a threshold, narrow `include`, point `action.yml` at an unmeasured
script, or change the test command and still show a green check with the
same job name.

Repository writers may change the files that define the coverage gate. This is
an accepted trust boundary: anyone with repository write access can propose
and merge such changes when CI passes. `coverage-comment.yml` posts a visible
warning when gate files change, but does not require reviewer or team approval.

**What the code does** (CI job "Enforce 100% coverage"):

- `c8 check-coverage` enforces the thresholds in `.c8rc.json`.
- `.github/scripts/verify-coverage.js` re-checks independently, because c8
  judges only the files it tracked: every `.js`/`.cjs`/`.mjs` file under
  `src/` must appear in the report, something must actually have been
  measured, and every metric must be covered === total. "Nothing measured"
  therefore fails instead of passing as 100% (c8 does exactly that when
  `include` matches no file).
- The same script checks that what ships is what is measured: `action.yml`
  may only run `node` scripts that live under `src/` (no inline `-e` or
  preloaded `-r` / `--import` / `--loader` code, no other directory), and
  nothing in `src/` may load a relative module from outside `src/`. Preloads
  smuggled in through `NODE_OPTIONS` are rejected too, wherever a step sets
  it: its `env`, a `NODE_OPTIONS=... node ...` prefix, `export NODE_OPTIONS=...`
  or an `echo NODE_OPTIONS=... >> "$GITHUB_ENV"`. A value built from an
  expression or variable (`${{ inputs.x }}`, `$X`) cannot be checked and is
  rejected as well; harmless values such as `--max-old-space-size=4096` are
  fine. `src/` may not contain symlinks, which could run code from outside
  the measured tree.
- The tests are untrusted code that runs before the gate, so the gate does
  not trust the workspace they ran in: it fails if the tests changed any
  file in the checkout (tests must only write to temp directories),
  reinstalls `node_modules` from the lockfile, and calls `c8` and
  `verify-coverage.js` directly instead of through `package.json` scripts.
  It also fails if the tests hid an edit from git with
  `update-index --assume-unchanged` / `--skip-worktree`. This catches
  tampering with `.c8rc.json`, the scripts, `src/` or `c8` itself. It cannot
  stop a test that forges coverage data or a repository writer from changing
  the workflow and its checks.
- The comment workflow (`coverage-comment.yml`, which always runs the
  version on `main`) puts a warning at the top of the PR comment whenever a
  PR changes a gate file (`.c8rc.json`, `action.yml`, `package.json`,
  `package-lock.json`, any file under `.github/workflows/**`,
  `.github/scripts/**` or `.github/rulesets/**`), so nobody reading the PR
  can miss that the result was measured with the PR's own rules.

**Known limits** (accepted on purpose, so nobody over-trusts the check):

- **Forged coverage.** 100% is enforced against honest pull requests. The
  tests are the measurement vehicle, and `c8` trusts any V8 coverage JSON in
  its temp directory, so a malicious test can write a forged file claiming
  every line of `src/` is hit and pass both `c8 check-coverage` and
  `verify-coverage.js`. Closing this needs a second trusted job that never
  runs PR code, or signed coverage artifacts - disproportionate here. This
  limitation is accepted for repository writers; the required CI check is the
  merge gate.
- **Dynamic imports.** Only literal specifiers are followed:
  `require(path.join(__dirname, "../x.js"))`, `import(variable)` and
  `createRequire()` are invisible. Resolving every dynamic load statically is
  undecidable, so this is a best-effort guard.
- **Shell indirection.** `env node`, `${NODE:-node}` and `command node` are
  not parsed; `action.yml` uses the plain `node "$ACTION_PATH/src/..."` form.

**What the repository is configured to do** (GitHub settings; the part that
actually makes the gate binding, not just a convention):

Mark the single **`Required checks pass`** job of the `CI` workflow as a
**required status check** on `main` (see `.github/rulesets/main.json`). It
already fans in the coverage gate and every other check. No human or team
approval is required; repository write access and the required CI status check
are the merge controls.

## CI structure and the single required check

Every pull-request check runs from one workflow, `.github/workflows/ci.yml`:

| Job in `ci.yml` | What it does                                         | Defined in                  |
| --------------- | ---------------------------------------------------- | --------------------------- |
| `test`          | `npm test` on Node 22 and 24, validates `action.yml` | `ci.yml` (inline)           |
| `actionlint`    | lints every workflow file                            | `actionlint.yml` (reusable) |
| `zizmor`        | security audit of workflows (fails on any finding)   | `zizmor.yml` (reusable)     |
| `codeql`        | CodeQL for JavaScript/TypeScript and for Actions     | `codeql.yml` (reusable)     |
| `coverage`      | the 100% coverage gate described above               | `coverage.yml` (reusable)   |

The last job, **`Required checks pass`**, `needs:` all of them and is the
only status check branch protection requires. Things a contributor cannot
infer from the name:

- It is an allow-list: every job must be exactly `success`. A failed,
  cancelled **or skipped** job fails it - GitHub counts a skipped required
  check as passing, so a gate that only looked for `failure` would go green
  exactly when something broke. It also runs under `if: always()` for the
  same reason.
- Adding a check is two edits and no settings change: add the job to
  `ci.yml`, then add its id to the gate's `needs:`. `test/ci-gate.test.js`
  fails the build if a job is missing from `needs:`, if a reusable workflow
  is never called, or if the gate is made conditional.
- The reusable workflows have **no triggers or `concurrency:` of their
  own** (`workflow_call` and a manual `workflow_dispatch` only). Own
  triggers would run every check twice; a `concurrency` group built from
  `github.workflow` deadlocks, because inside a reusable workflow that is
  the _caller's_ name. `ci.yml` owns concurrency and cancels superseded
  pull-request runs only.
- `scorecard.yml`, `coverage-comment.yml` and `release.yml` are deliberately
  outside the gate: Scorecard does not run on pull requests and reports a
  score rather than pass/fail, the comment workflow runs after CI
  (`workflow_run`, listening to the workflow named `CI`) only to post the
  coverage report, and the release workflow only ever runs for a pushed tag.
  They are still linted by `actionlint` and `zizmor` like every other file in
  `.github/workflows/`.
- A green `codeql` job means the analysis ran, not that there are no
  alerts. It does not block on alerts by itself (opt-in in
  `.github/rulesets/README.md`, "Optional: block on CodeQL alerts").
- Repository writers can change any path and can create release tags. No
  reviewer or team approval is required; the configured CI checks and release
  validation still apply.
- Merge queue is not enabled. If it ever is, add `merge_group:` to `ci.yml`
  (and confirm CodeQL and the SARIF uploads behave on that event) first,
  otherwise queued pull requests never get their checks.

## Releasing a new version

The supported release path is **signed publication by CI**. Repository actors
with release rights can still create releases manually; this workflow does not
prevent that. For the verified path, someone pushes a signed, annotated tag;
`.github/workflows/release.yml` then verifies
it, re-runs the whole test suite and the 100% coverage gate, builds the
assets, signs and attests them with Sigstore (keyless, so there is no signing
key to guard), publishes the release, and verifies what it published. What a
release contains and how consumers verify it: "Verifying a release" in
`SECURITY.md`.

GitHub's `Latest` marker tracks the numerically highest published stable
`vMAJOR.MINOR.PATCH` release that passes the pipeline's verification: signed
annotated tag, default-branch ancestry, exact expected asset set and checksums,
Cosign signatures, and GitHub attestations from this workflow. Manually
published releases remain allowed for repository writers, but do not qualify
for Latest unless they satisfy those same checks. Publishing an older valid
version to backfill a gap does not demote a newer valid release.

Latest rechecks the public stable-version maximum, tag binding, branch ancestry,
release metadata and verified asset fingerprint immediately before changing
the marker. If a newer stable release appears after candidate verification,
the stale run fails without promoting its older candidate; rerun the workflow
to verify and reconcile the current release set. GitHub has no atomic
verify-and-promote API, so an external release can still change in the small
interval between the final checks and the marker update. The workflow test
suite models the newer-publication race and asserts that stale promotion is
rejected. Since published releases are intentionally mutable, editing release
metadata and assets are checked by the scheduled reconciliation configured
every six hours; Actions or API delays can extend that interval. A changed
release no longer qualifies once a reconciliation observes it, and the highest
remaining verified stable release is selected. Latest can temporarily
reference changed content until that run completes; if no stable release
verifies, reconciliation fails closed and reports that no eligible candidate
exists. For transient failures, rerun failed jobs from the original release
run; the release workflow has no manual-dispatch trigger.

Every example and setup doc in this project (`examples/consumer-workflow.yml`,
"SETUP_GUIDE.md", this file) refers to a release as `@vX.Y.Z`. That release
has to exist before anything referencing it works, which is why the last step
below comes **after** the workflow has finished.

### One-time setup (repository admin)

The release setting, environment and signing key are GitHub settings, not
repository files. Releases are intentionally editable after publication so a
maintainer with release rights can correct them. Do this once, and re-check it
when something about releasing seems off:

1. **Leave "Immutable releases" off** (Settings -> General -> Releases) if
   published releases need to remain editable. Release notes can be corrected
   as needed. Replacing a signed asset invalidates its signatures/checksums;
   consumers must reject it, so publish a newly signed asset under the next
   patch version instead of silently replacing it in place.
2. **Release authorization and mutability:** repository permissions alone
   determine who may publish; no separate reviewer or team approval is
   required. The workflow reads the actual `release` environment rules and
   fails before building if required reviewers are configured. Mutability is
   intentionally `not-required` in workflow code.
3. **Create the `release` environment** (Settings -> Environments -> New
   environment). Under "Deployment branches and tags", select "Selected
   branches and tags" and add exactly one rule: tag pattern `v*` (no branch
   rules and no additional patterns). Do not configure a wait timer or custom
   deployment protection rule. The policy job reads the environment
   mode and the complete paginated rules list, and fails before build if they
   differ. Leave required reviewers empty. GitHub enforces environment
   protection independently; the workflow checks this before building so the
   environment cannot add an approval gate.
4. **Import the release tag ruleset** in `.github/rulesets/release-tags.json`
   as a repository admin. It lets writers create version tags but blocks
   moving or deleting them after creation. The policy job checks that an
   active effective ruleset protects exactly `refs/tags/v*` and blocks both
   updates and deletions. Confirm in repository settings that its bypass list
   is empty; GitHub may hide that list from the workflow's read-only token.
   A tag correction uses a new version.
5. **Register a signing key on your GitHub account**, as a _Signing Key_ (not
   just an authentication key), and use the same address as a verified email:
   ```bash
   # SSH signing (simplest); GPG works too
   git config --global gpg.format ssh
   git config --global user.signingkey ~/.ssh/id_ed25519.pub
   ```
   then add that public key at Settings -> SSH and GPG keys -> New SSH key ->
   Key type **Signing Key**. The workflow refuses any tag GitHub does not
   report as _verified_.
5. If your organisation restricts which actions may run, allow
   `actions/attest`, `actions/upload-artifact` and
   `sigstore/cosign-installer` (plus the ones the CI already uses). The
   release-writing job downloads artifacts with the runner's GitHub CLI.

### Rehearse in a fork first

`release.yml` only uses `github.repository`, never a hard-coded name, so it
runs unchanged in a fork. Before the **first** real release (and after any
change to the workflow), push a throwaway signed tag such as `v0.0.1` to a fork
that has its own `release` environment and signing key, and watch the whole
run, including the final "verify the published release" step. Everything here
is tested offline (the helper script, the workflow's structure, the CLI flags),
but signing and attesting need a real GitHub run.

### Cutting a release

1. Merge your changes to `main` and let CI go green. A tag on a commit that is
   not on `main` is refused.
2. In a pull request, rename `## [Unreleased]` in `CHANGELOG.md` to
   `## [X.Y.Z] - YYYY-MM-DD` (leave a new, empty `## [Unreleased]` above it)
   and bump the version:
   ```bash
   npm version X.Y.Z --no-git-tag-version   # updates package.json and package-lock.json
   ```
   The section's text becomes the release notes, and the workflow fails if
   the tag, `package.json` and `CHANGELOG.md` disagree. Merge it. The
   workflow publishes that text as `RELEASE_NOTES.md`, signs it alongside the
   source archive and SBOM, and signs a `SHA256SUMS` manifest covering all
   three payloads. Signature and attestation bundles are verified as proofs.
3. Tag the merge commit **with a signature**, check it, and push it:
   ```bash
   git switch main && git pull
   git tag -s vX.Y.Z -m "cla-bot vX.Y.Z"
   git tag -v vX.Y.Z          # must say the signature is good
   git push origin vX.Y.Z
   ```
   Only `vMAJOR.MINOR.PATCH` starts a release; no pre-release suffixes. A
   lightweight tag (`git tag vX.Y.Z`) or an unverified one fails the run.
4. Watch the **Release** workflow (Actions tab). The `publish` job runs
   without a second-person approval and ends by downloading and verifying the
   published release the way a consumer would.
5. **Only after it succeeded**, open
   `https://github.com/fossasia/cla-bot/releases/tag/vX.Y.Z`, run the
   verification in `SECURITY.md` once from a clean machine, and then update
   the `@vX.Y.Z` references in `examples/consumer-workflow.yml` and
   "SETUP_GUIDE.md". The commit SHA to pin is
   `git ls-remote --tags origin vX.Y.Z "vX.Y.Z^{}"` (the `^{}` line).

### If a release run fails

- **The `build` job failed** (tag not verified, version or changelog
  mismatch, tests, not on `main`): nothing was published. The simplest fix is
  to repair `main` and cut the **next patch version**; skipping a number costs
  nothing. If the release tag ruleset is not yet applied, you may delete and
  recreate an unpublished tag after fixing the cause. Once the ruleset is
  active, fix the cause and use the next patch version.
- **A "no longer resolves to the signed tag object" error** means the tag
  changed after the build job verified it (possible only if tag updates are
  not blocked by the release tag ruleset).
  Two cases, told apart by the message:
  - _Before publishing_ ("Refusing to release"): nothing is public. Do not
    re-run; investigate who changed the tag, then release the next patch
    version from a fresh tag.
  - _After publishing_ ("Treat this release as compromised"): the release **is
    public**. Do not re-run. If the release is still editable (no immutable
    releases), mark it as a pre-release with a notice, or delete it; find out
    who moved the tag; release the next patch version from a fresh, verified
    tag and say in its changelog which version it supersedes. Consumers who
    pinned a verified commit SHA are unaffected, but tell everyone else to
    move to the new version.
- **A draft check error** ("Refusing to publish": assets or release metadata
  differ from what was prepared) means someone or something changed the draft
  after it was created. Nothing is public. The workflow fails closed; inspect
  the draft and delete it manually only after confirming it is safe, then rerun.
- **A "policy" job failure** (invalid workflow immutability policy, required
  reviewers configured on the `release` environment, or inability to read the
  environment): nothing was built or published. Do the one-time
  setup it names, then re-run the failed jobs.
- **"... NOT immutable (isImmutable=false)"** at the very end: the release is
  published, signed and verified, but "Immutable releases" is off although
  the workflow policy says `required`. Turn it on before the next release
  (it cannot be applied to this one), or change the policy in workflow code if
  mutable releases are intended.
- **An existing release for the tag** (draft or published) prevents creation:
  a matching draft is reused only after its metadata, notes and every asset
  match this run's verified files. A mismatching draft fails closed; inspect it
  and remove it manually only after confirming it is safe. Published releases
  are never overwritten or deleted by the workflow.
- **The `publish` job failed** (Sigstore or GitHub outage, upload error): use
  "Re-run failed jobs". If draft creation had completed, the retry reuses the
  draft only when its metadata, notes and assets match exactly; it never
  deletes or overwrites an existing release.
  If it failed after publication, the read-only candidate verification still
  runs when possible;
  if that check also failed transiently, use **Re-run failed jobs** from the
  original release run. Scheduled reconciliation retries Latest verification
  without rebuilding or overwriting a release.
- **A published release turns out to be wrong:** edit its notes for a notes
  issue. For an asset or source correction, release the next patch version and
  say in its changelog which version it supersedes; consumers must reject any
  replaced asset whose signatures no longer verify.

## Local development

```bash
git clone https://github.com/fossasia/cla-bot.git
cd cla-bot
npm test              # runs the full offline unit-test suite
npm run coverage       # same, plus a coverage report - fails if any line, statement, branch or function isn't hit
npm run coverage:scripts   # the same 100% rule applied to the CI helper scripts in .github/scripts/
node --check src/cla-bot.js   # quick syntax check
```

There's no build step - this is plain, unbundled Node.js.

## Testing against a real repository

Because this action calls the live GitHub API, the most reliable way to
test end-to-end behavior is:

1. Fork or create a scratch test repository.
2. Point its signatures-owner/signatures-repo inputs at a scratch private
   "signatures" repo you control.
3. Open a test PR and walk through the sign flow manually - see
   "TESTING_GUIDE.md" in this repo for the full walkthrough, including the
   impersonation test.
