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
   signatures-repo token's lifetime (caching, refresh, 401 recovery). Run `npm test` before opening a PR - CI runs it too, on
   Node 22 and 24.
3. **This repo requires 100% test coverage (lines, statements, functions
   and branches) on every PR**, enforced by `.github/workflows/coverage.yml`.
   Run `npm run coverage` locally before pushing - it fails the same way CI
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

## How the coverage gate is enforced (maintainers)

The 100% rule is only as strong as the files that define it, and a pull
request can edit those files: `coverage.yml` runs on `pull_request`, so
GitHub uses the PR's _own_ copy of the workflow, `package.json`,
`.c8rc.json` and `.github/scripts/`. A PR could therefore lower a
threshold, narrow `include`, point `action.yml` at an unmeasured script,
or change the test command and still show a green check with the same job
name. No workflow can fully fix that from inside the PR; it is closed by
repository settings. Until they are in place, 100% is a convention, not an
enforced rule.

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
  `package-lock.json`, `.github/CODEOWNERS`, `coverage.yml`,
  `coverage-comment.yml`, `.github/scripts/**`), so a reviewer cannot miss
  that the result was measured with the PR's own rules.

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

**What the repository must be configured to do** (GitHub settings; the
part that actually makes the gate trustworthy):

1. Keep the gate files in `.github/CODEOWNERS`. The repository ships one
   that names `@fossasia/cla-admins` for `.c8rc.json`, `action.yml`, `src/`,
   `package.json`, `package-lock.json`, `.github/CODEOWNERS`,
   `.github/workflows/` and `.github/scripts/`. If your maintainers team has
   a different handle, replace it in every line. The team must have explicit
   **write** access to this repository, or GitHub silently ignores its
   entries. An empty or missing `CODEOWNERS` file protects nothing.

2. In the branch protection rule or ruleset for `main`, enable **Require
   review from Code Owners** - CODEOWNERS entries are inert without it.
3. Mark the **Enforce 100% coverage** job of the `Test Coverage` workflow as
   a **required status check**.

## Releasing a new version

Every example and setup doc in this project (`examples/consumer-workflow.yml`,
"SETUP_GUIDE.md", this file) references a specific tag like `@vX.Y.Z`.
**That tag has to actually exist and be pushed before anything referencing
it will work** - a workflow pointing at a tag that isn't there yet just
fails to resolve. When cutting a release:

1. Merge your changes to `main` first.
2. Update `CHANGELOG.md` and `package.json`'s `version` field.
3. Tag and push:
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
4. **Only after step 3 succeeds**, update any `@vX.Y.Z` references in
   `examples/consumer-workflow.yml` and "SETUP_GUIDE.md" to match, and
   double-check by opening
   `https://github.com/fossasia/cla-bot/releases/tag/vX.Y.Z` in a browser
   (or `git ls-remote --tags origin`) to confirm it's really there, not
   just that the push command didn't error.

If you're reading this because an example pointed at a tag that 404s: that
almost certainly means step 3 hasn't happened yet for the version the docs
claim exists - go create it, or point the reference back at the last tag
that actually does exist.

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
