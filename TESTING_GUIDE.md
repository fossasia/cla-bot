# CLA Bot Testing Guide (on your own personal GitHub account)

This guide walks through testing `fossasia/cla-bot` on your own personal
GitHub account, safely, BEFORE deploying it to the real FOSSASIA org. It's
completely free (both repos and Actions are free for personal accounts)
and doesn't touch any of FOSSASIA's real infrastructure.

Wherever you see `<you>`, replace it with your own GitHub username.

---

## Stage 1 - Quick single-repo test

This is the fastest way to confirm the bot actually triggers and the core
sign/check logic works. It doesn't test the cross-repo part yet - just
whether the basic "everything in one repo" flow behaves correctly.

### 1.1 Create a test repo

```bash
gh repo create <you>/cla-test --public --clone
cd cla-test
echo "# CLA test repo" > README.md
git add . && git commit -m "init" && git push
```

### 1.2 Add the workflow file (pointing the signatures repo at itself)

`.github/workflows/cla.yml`:

```yaml
name: "CLA Bot Test"

on:
  issue_comment:
    types: [created]
  pull_request_target:
    types: [opened, synchronize, reopened, closed]

permissions:
  pull-requests: read
  issues: write
  statuses: write

concurrency:
  group: cla-${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: false

jobs:
  cla-check:
    runs-on: ubuntu-latest
    steps:
      - uses: <you>/cla-bot@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          signatures-owner: <you>
          signatures-repo: cla-test # <-- points at itself, not a separate repo
          signatures-path: signatures/cla.json
          cla-document-url: https://github.com/<you>/cla-test/blob/main/README.md
          allowlist: dependabot[bot]
          # app-id / app-private-key are left blank on purpose - the code
          # falls back to GITHUB_TOKEN, which works fine for this repo
          # since it has read+write access to its own contents.
```

### 1.3 Push your bot code

Push this repo's entire content into a new `<you>/cla-bot` repo (keep it
public - `uses: <you>/cla-bot@main` only works if it is):

```bash
gh repo create <you>/cla-bot --public --clone
cd cla-bot
# copy this repo's entire content in here
git add . && git commit -m "test build" && git push
```

### 1.4 Open a test PR

```bash
cd ../cla-test
git checkout -b test-pr-1
echo "test change" >> README.md
git commit -am "test change"
git push -u origin test-pr-1
gh pr create --title "Test PR" --body "testing CLA bot"
```

### 1.5 Confirm it triggers

1. Go to the **Actions** tab on your `cla-test` repo.
2. You should see a workflow run called "CLA Bot Test" (it should trigger
   as soon as the PR opens, from the `pull_request_target: opened` event).
3. Click that run and open the job logs. If everything's working, you'll
   see: commits fetched, the signatures file coming back as a 404 (since
   this is the first time), and a comment posted on the PR.
4. Go back to the PR - you should see the bot's comment listing missing
   signers, plus a red or yellow status check (`cla/fossasia`) at the
   bottom of the PR.

**If the workflow doesn't trigger at all**: check that
`.github/workflows/cla.yml` is on the `main` branch, not the PR branch -
`pull_request_target` always reads the workflow file from the base branch.

**If it triggers but fails (red X)**: the logs will show the exact error.
A common cause is a missing `issues: write` permission (comments/locking
will fail with a 403) - the example in step 1.2 already has this right,
but double-check if you've modified it.

### 1.6 Sign and confirm

Reply to the bot's comment with exactly this text - a plain new comment
will not count:

```
I have read the CLA Document and I hereby sign the CLA
```

Within a few seconds you should see:

- A new bot comment: "All contributors have signed the CLA. ✅"
- The status check turning green
- A new commit in the `cla-test` repo that creates/updates
  `signatures/cla.json` (check the Code tab)

### 1.7 Confirm it persists

Open a **second** test PR (same repo, same GitHub account):

```bash
git checkout -b test-pr-2 main
echo "another change" >> README.md
git commit -am "another test change"
git push -u origin test-pr-2
gh pr create --title "Test PR 2" --body "testing persistence"
```

This PR's status check should turn **green immediately**, without you
commenting anything because you already signed. That's the whole point
of the design.

Stage 1 is done. If everything above worked, the core logic is confirmed
working. Move on to Stage 2 to test the real architecture (a separate
signatures repo plus a GitHub App).

---

## Stage 2 - Full architecture: separate signatures repo + GitHub App

### 2.1 Create a separate private signatures repo

```bash
gh repo create <you>/cla-signatures --private --clone
cd cla-signatures
# add a CLA.md file here with the CLA text
git add . && git commit -m "init" && git push
```

### 2.2 Create a test GitHub App (a personal account works fine too)

1. Go to `https://github.com/settings/apps/new` (you don't need an org for
   this - a personal account's settings can create an App too).
2. Name it `<you>-cla-bot-test`. Uncheck "Active" under Webhook.
3. Under Permissions → Repository permissions → **Contents: Read and write**.
4. Under "Where can this GitHub App be installed?", choose **Only on this
   account**.
5. After creating it: note the App ID, and click "Generate a private key"
   to download a `.pem` file.
6. **Install** the app, selecting only the `<you>/cla-signatures` repo.

### 2.3 Create two consumer repos

```bash
gh repo create <you>/cla-consumer-1 --public --clone
gh repo create <you>/cla-consumer-2 --public --clone
```

Add the same `.github/workflows/cla.yml` to both, this time pointing at
the separate signatures repo:

```yaml
with:
  github-token: ${{ secrets.GITHUB_TOKEN }}
  signatures-owner: <you>
  signatures-repo: cla-signatures # <-- a separate repo now
  signatures-path: signatures/cla.json
  cla-document-url: https://github.com/<you>/cla-signatures/blob/main/CLA.md
  allowlist: dependabot[bot]
  app-id: ${{ secrets.CLA_APP_ID }}
  app-private-key: ${{ secrets.CLA_APP_PRIVATE_KEY }}
```

Add secrets to both repos (`Settings → Secrets and variables → Actions`):

- `CLA_APP_ID` = the App ID from 2.2
- `CLA_APP_PRIVATE_KEY` = the entire raw content of the `.pem` file (with
  real line breaks, not escaped - "SETUP_GUIDE.md" has a warning about this
  exact mistake)

### 2.4 The cross-repo test (this is the most important one)

1. Open a PR in `cla-consumer-1`, sign it.
2. Open a new PR in `cla-consumer-2` (without commenting to sign at all).
3. The status should turn **green immediately** - if it does, the
   cross-repo architecture is confirmed working. This is the entire point
   of the design.

### 2.5 Edge case tests (checking specific fixes)

| Test                       | How to do it                                                                                                                                          | Expected result                                                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Impersonation guard        | From a second/alt GitHub account, comment the sign phrase on a PR where you are the commit author                                                     | The PR should **not** turn green - only the commenter signed, not the real author                                                                         |
| `recheck` authorization    | From an alt account (not the PR author), comment `recheck` on a PR                                                                                    | The bot should give **no response** (silently ignored)                                                                                                    |
| `recheck` legitimate       | The PR author themselves comments `recheck`                                                                                                           | The bot re-evaluates and responds                                                                                                                         |
| Merge-commit exclusion     | Click GitHub's "Update branch" button on a PR (this creates a merge commit)                                                                           | The person who clicked that button should not be asked to sign                                                                                            |
| Malformed-entry resilience | Manually edit `signatures/cla.json` in `cla-signatures`, remove the `login` field from one entry, commit it                                           | The next PR check should still work normally (no crash), and the Actions logs should show a `::warning::` about the malformed entry                       |
| First-write race           | Open PRs in two different consumer repos that have never had anyone sign before, and have two different people sign on each at close to the same time | Both signatures should end up recorded - neither should be lost, even though both writes are trying to create the signatures file for the very first time |
| Duplicate-signature race   | (Optional, advanced) Try sending the same sign comment twice in quick succession                                                                      | `signatures/cla.json` should not end up with a duplicate entry - this is already covered by the code-level tests, so this manual check is optional        |

For the alt account: any second GitHub account works (a friend's, or a
second account of your own) - all it needs to do is comment on your
public test repo, which any logged-in GitHub user can do.

---

## Reading the logs (debugging)

In each workflow run's Actions tab:

- `console.log(...)` shows as normal text
- `console.warn(...)` shows as a yellow `::warning::` banner
- `console.error(...)` followed by `process.exit(1)` shows as a red
  `::error::` banner, and the job shows as failed

If something's unclear, you can temporarily add
`console.log(JSON.stringify(payload, null, 2))` in `src/cla-bot.js` to see
the entire webhook payload - very useful for debugging. Remove it again
once you're done testing (production shouldn't log full payloads, since
they can contain personal data).

---

## Once Stage 2 passes

Only these values need to change for the real FOSSASIA deployment:

- `signatures-owner: <you>` → `signatures-owner: fossasia`
- `signatures-repo: cla-signatures` (the name can stay the same)
- The GitHub App needs to be recreated from FOSSASIA's **org** settings
  instead of a personal account (a personal-account App won't work for
  org repos) - everything else about it stays the same.
- `uses: <you>/cla-bot@main` → `uses: fossasia/cla-bot@vX.Y.Z`, where
  `vX.Y.Z` is whatever real tag you've actually pushed to
  `fossasia/cla-bot`. `@main` is fine for testing, but production should
  always use a pinned tag. Before switching over, check
  `https://github.com/fossasia/cla-bot/tags` to confirm that tag is
  genuinely there.

The code itself stays exactly the same - no logic changes needed.

## Cleanup (optional)

Once you're done testing:

```bash
gh repo delete <you>/cla-test --yes
gh repo delete <you>/cla-consumer-1 --yes
gh repo delete <you>/cla-consumer-2 --yes
gh repo delete <you>/cla-signatures --yes
```

You can keep or delete `<you>/cla-bot` - it's independent of the real
`fossasia/cla-bot` repo either way.
