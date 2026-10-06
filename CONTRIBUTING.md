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
6. **Don't weaken the release pipeline** (`.github/workflows/release.yml`,
   `.github/scripts/release-check.js`)
   without discussing it in an issue first: `test/release-workflow.test.js`
   pins its least-privilege, pinning and ordering properties on purpose.
   Every third-party action there is pinned to a full commit SHA, and
   `action.yml` may only `uses:` actions pinned that way (the release SBOM
   refuses anything else).

## How the coverage gate is enforced (maintainers)

The 100% rule is only as strong as the files that define it, and a pull
request can edit those files: `ci.yml` (which calls `coverage.yml`) runs on
`pull_request`, so GitHub uses the PR's _own_ copy of the workflow,
`package.json`, `.c8rc.json` and `.github/scripts/`. A PR could therefore
lower a threshold, narrow `include`, point `action.yml` at an unmeasured
script, or change the test command and still show a green check with the
same job name.

**This repository's deliberate choice**: unlike a setup that closes that
gap with mandatory code-owner review, this repository does **not** require
any human review on top of CI - see "Branch protection has exactly one
required condition" in `.github/rulesets/README.md`. The 100% rule is
therefore enforced against honest pull requests, and a pull request that
also edits the gate's own definition is an accepted residual risk, not
something CI can block by itself. `coverage-comment.yml` still posts a
visible warning on the PR when a gate file is touched (see `GATE_FILES` /
`GATE_DIR_PREFIXES` in `.github/scripts/post-coverage-comment.js`), so this
is never silent - it just isn't a hard block. If a specific repository or
team later wants that hard block back, see "Optional: add required review
back" in `.github/rulesets/README.md` - it is a two-field change to
`main.json`, nothing in `ci.yml` has to move.

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
  stop a test that forges coverage data or a PR that edits the workflow -
  only review can.
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
  runs PR code, or signed coverage artifacts - disproportionate here. Code
  owner review is the control.
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
already fans in the coverage gate and every other check, so there is
nothing else to mark required. There is deliberately **no** required
code-owner review and **no** `CODEOWNERS` file for this - see "Branch
protection has exactly one required condition" in
`.github/rulesets/README.md` for the trade-off, and the note above for what
that means for this coverage gate specifically.

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
- There is no required review of any kind on `main` - see
  `.github/rulesets/README.md` for why, and how to add one back for a given
  repository if a team wants it.
- Merge queue is not enabled. If it ever is, add `merge_group:` to `ci.yml`
  (and confirm CodeQL and the SARIF uploads behave on that event) first,
  otherwise queued pull requests never get their checks.

## Releasing a new version

Releases are **signed and published by CI, never by hand**. Someone pushes a
signed, annotated tag; `.github/workflows/release.yml` then verifies
it, re-runs the whole test suite and the 100% coverage gate, builds the
assets, signs and attests them with Sigstore (keyless, so there is no signing
key to guard), publishes the release, and verifies what it published. What a
release contains and how consumers verify it: "Verifying a release" in
`SECURITY.md`.

Every example and setup doc in this project (`examples/consumer-workflow.yml`,
"SETUP_GUIDE.md", this file) refers to a release as `@vX.Y.Z`. That release
has to exist before anything referencing it works, which is why the last step
below comes **after** the workflow has finished.

### One-time setup (repository admin)

The immutable-releases switch, the environment and your signing key are GitHub
settings, not repository files. Do this once, and re-check it when something about releasing seems off:

1. **Turn on "Immutable releases"** (Settings -> General -> Releases). Once a
   release is published, its assets and its tag can never be changed or
   removed, even by an admin. The workflow creates each release as a draft,
   fills and verifies it, and only then publishes, precisely so this setting
   is safe to use. Without it the workflow still works, but warns on every
   release.
2. **Create the `release` environment** (Settings -> Environments -> New
   environment). Required reviewers are optional but recommended: add one or
   more (enable "Prevent self-review" if there are enough people), and under
   "Deployment branches and tags" allow only the selected tag pattern `v*`.
   The `publish` job pauses on this environment, so every release becomes an
   explicit second-person approval - a human control that does not depend on
   `main`'s review settings (there are none, by design). With no reviewers
   configured the job simply runs.
3. **Register a signing key on your GitHub account**, as a _Signing Key_ (not
   just an authentication key), and use the same address as a verified email:
   ```bash
   # SSH signing (simplest); GPG works too
   git config --global gpg.format ssh
   git config --global user.signingkey ~/.ssh/id_ed25519.pub
   ```
   then add that public key at Settings -> SSH and GPG keys -> New SSH key ->
   Key type **Signing Key**. The workflow refuses any tag GitHub does not
   report as _verified_.
4. If your organisation restricts which actions may run, allow
   `actions/attest`, `actions/upload-artifact`, `actions/download-artifact`
   and `sigstore/cosign-installer` (plus the ones the CI already uses).

### Rehearse in a fork first

`release.yml` only uses `github.repository`, never a hard-coded name, so it
runs unchanged in a fork. Before the **first** real release (and after any
change to the workflow), push a throwaway signed tag such as `v0.0.1` to a fork
that has its own `release` environment and signing key, and watch the whole
run, including the final "verify the published release" step. Everything here
is tested offline (the helper script, the workflow's structure, the CLI flags),
but signing and attesting need a real GitHub run, and with immutable releases
a mistake on the real repository burns a version number.

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
   the tag, `package.json` and `CHANGELOG.md` disagree. Merge it.
3. Tag the merge commit **with a signature**, check it, and push it:
   ```bash
   git switch main && git pull
   git tag -s vX.Y.Z -m "cla-bot vX.Y.Z"
   git tag -v vX.Y.Z          # must say the signature is good
   git push origin vX.Y.Z
   ```
   Only `vMAJOR.MINOR.PATCH` starts a release; no pre-release suffixes. A
   lightweight tag (`git tag vX.Y.Z`) or an unverified one fails the run.
4. Watch the **Release** workflow (Actions tab). Approve the `publish` job
   when asked. It ends by downloading the published release and verifying it
   the way a consumer would.
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
  nothing. Since no release exists yet, you may instead delete the tag
  (`git push --delete origin vX.Y.Z` and `git tag -d vX.Y.Z`), fix the cause
  and tag again, as long as nobody has pinned that tag in the meantime. Only a
  _published_ release is locked, and only if "Immutable releases" is on.
- **A "no longer resolves to the signed tag object" error** means the tag was
  moved, deleted and re-created, or re-signed after the build job verified it.
  Nothing was published. Do not re-run: investigate who changed the tag, then
  release the next patch version from a fresh tag.
- **The `publish` job failed** (Sigstore or GitHub outage, approval
  timed out, upload error): use "Re-run failed jobs". It is safe to repeat; a
  leftover **draft** is replaced, and a release that is already **published**
  is never overwritten (the run stops instead).
- **A published release turns out to be wrong:** never reuse its version, and
  with immutable releases you could not. Fix `main`, release the next patch
  version, and say in its changelog which version it supersedes.

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
