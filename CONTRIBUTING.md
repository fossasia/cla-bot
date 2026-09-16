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
   `action.yml`'s structure - it never ships with the action, so it doesn't
   count against this rule.)
2. **Every change to `src/cla-bot.js` needs a matching test.** Pick the
   right layer: `test/logic.test.js` for pure functions (no network),
   `test/http.test.js` for anything touching `readSignatures`/`writeSignatures`
   (mocked `fetch`), `test/integration.test.js` for changes to event
   orchestration (`handleIssueComment`, `checkPR`), and
   `test/bot-identity*.test.js` for anything about how the bot resolves its
   own identity. Run `npm test` before opening a PR - CI runs it too, on
   Node 22 and 24.
3. **This repo requires 100% test coverage (lines, statements, functions
   and branches) on every PR**, enforced by `.github/workflows/coverage.yml`.
   Run `npm run coverage` locally before pushing - it fails the same way CI
   does if anything is untested, and `npm run coverage:report` turns that
   into the same human-readable breakdown (missing lines, never-called
   functions, untested branches) that gets posted as a PR comment.
4. **Don't weaken any of the security properties** listed at the top of
   `src/cla-bot.js` or in `SECURITY.md` (impersonation guard, exact-match
   allowlist, short-lived tokens, etc.) without discussing it in an issue
   first.
5. Changes to `action.yml` inputs should stay backward compatible where
   possible; if a breaking change is unavoidable, bump the major version
   tag and note it in `CHANGELOG.md`.

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
