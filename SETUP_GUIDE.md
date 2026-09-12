# FOSSASIA CLA Bot Setup Guide

## Architecture

- `fossasia/cla-bot` - this action itself (zero npm dependencies). Every
  repo references it with `uses: fossasia/cla-bot@vX.Y.Z`. Replace `vX.Y.Z`
  with whatever tag actually exists - see Step 1.4 below. Don't hardcode a
  version number anywhere else in your own notes; it goes stale the moment
  a new version ships.
- `fossasia/cla-signatures` - a private repo holding the signature record,
  `signatures/cla.json`.
- Each project repo gets a workflow file at `.github/workflows/cla.yml`,
  copied from this repo's `examples/consumer-workflow.yml`, that triggers
  the bot.

Writing to the signatures repo from another repo uses a short-lived GitHub
App token - no long-lived personal access token is stored anywhere.

---

## Step 1 - Publish the `cla-bot` repo

1. Create a **public** repo named `fossasia/cla-bot` (public is fine -
   there's no secret in it, just code, and it keeps the `uses:` reference
   simple for anyone using it).
2. Push this repo's content to it as-is.
3. Run `npm test` and confirm every test passes. The count grows as the bot
   gets more features, so don't assume a specific number - just check for
   `ALL TESTS PASSED.`
4. **Create a release tag - don't skip this, everything after this step
   depends on it existing:**
   ```bash
   git tag v1.0.0   # or whatever version CHANGELOG.md currently says
   git push origin v1.0.0
   ```
   Then **verify the tag actually made it to GitHub** - open
   `https://github.com/fossasia/cla-bot/tags` in a browser, or run:
   ```bash
   git ls-remote --tags origin
   ```
   Until that tag genuinely shows up there, any workflow referencing
   `uses: fossasia/cla-bot@v1.0.0` will fail to resolve. When you later
   update the bot, tag a new version and update every reference to it.
   Always pin to a specific, real tag - never a moving reference like `v1`
   or `main` for anything other than testing. See CONTRIBUTING.md's
   "Releasing a new version" section for the full checklist.

## Step 2 - Create the central signatures repo

1. Create a **private** repo named `fossasia/cla-signatures`.
2. Add a `CLA.md` to it with the CLA text (get this reviewed by whoever
   handles FOSSASIA's legal matters before treating it as final).
3. Don't manually create `signatures/cla.json` - the bot creates it
   automatically the first time anyone signs.
4. **Access control**: give only a small team (e.g. `fossasia/cla-admins`)
   access to this repo. It will contain contributors' names, GitHub ids,
   and timestamps, which is personal data - nobody else in the org should
   be able to see it.

## Step 3 - Create a GitHub App (for cross-repo access, not a personal token)

1. Go to `https://github.com/organizations/fossasia/settings/apps/new`.
2. Name it `fossasia-cla-bot`. Under Webhook, **uncheck "Active"** - this
   app only mints tokens, it doesn't need to receive webhooks.
3. Permissions: **Repository permissions → Contents: Read and write**. It
   doesn't need anything else.
4. Under "Where can this GitHub App be installed?", choose **Only on this
   account**.
5. After creating it:
   - Note down the **App ID** (this becomes the `CLA_APP_ID` secret).
   - Click **Generate a private key** - this downloads a `.pem` file
     (this becomes the `CLA_APP_PRIVATE_KEY` secret). Don't keep a copy of
     this file anywhere else.
6. **Install** the app, but only on the `fossasia/cla-signatures` repo
   ("Only select repositories", pick just that one). This means its token
   can only ever touch that one repo, even if it were somehow leaked.

## Step 4 - Add org secrets (scoped, not "All repositories")

Go to `https://github.com/organizations/fossasia/settings/secrets/actions`.

Create two secrets:

- `CLA_APP_ID` = the App ID from Step 3
- `CLA_APP_PRIVATE_KEY` = the entire content of the `.pem` file

⚠️ **Common mistake**: paste the `.pem` file's raw content, with real line
breaks, directly into the secret's value box. Don't convert the line
breaks into a literal `\n` - that makes JWT signing fail with a confusing
OpenSSL parse error. GitHub Secrets support multi-line values natively, no
escaping needed.

Set repository access to **"Selected repositories"** - pick only the repos
that actually need the CLA check. The fewer repos that can see a secret,
the smaller the blast radius if anything ever goes wrong.

⚠️ **Common mistake #2**: a typo in `signatures-owner`/`signatures-repo`
(inside the workflow file) won't crash the bot right away. `readSignatures`
treats a non-existent repo or file the same as "nobody has signed yet" (a
404), so it will quietly show everyone as missing until someone actually
tries to sign - that's when the write fails and the job errors out. After
rolling this out, double-check the values in one repo's workflow file
match `cla-signatures` exactly.

## Step 5 - Lock down who can edit the workflow file

1. In each repo, add a `.github/CODEOWNERS` entry making a trusted team
   (e.g. `@fossasia/cla-admins`) the required approver for changes under
   `.github/workflows/`.
2. In each repo's branch protection rule (Settings → Branches, for
   main/master), turn on **"Require review from Code Owners"**.
3. ⚠️ **Important**: give that team **explicit write access on every
   individual repo**. GitHub requires a team to have write access to a
   specific repo for its CODEOWNERS entry to apply there, even if members
   already have access some other way (org membership, another team). Skip
   this and CODEOWNERS silently does nothing on that repo, with no warning.

This stops a regular contributor, or a compromised low-trust maintainer
account, from quietly editing `cla.yml` to leak a secret - any such change
now needs a CLA-admin's review before it can merge.

## Step 6 - Check the org-wide default permission (a PII leak check)

Go to `https://github.com/organizations/fossasia/settings/member_privileges`.

Confirm "Base permissions" is set to **"No permission"**, or at least
something that restricts private-repo access by default. If it's "Read" or
higher, `cla-signatures` could be visible to the whole org even though it's
marked "Private" - a broad org-wide default can override the specific
access control from Step 2.

## Step 7 - Test the workflow on one repo first

1. Copy `examples/consumer-workflow.yml` to a test repo's
   `.github/workflows/cla.yml`, filling in the `with:` values for your
   setup.
2. Open a test PR - ideally from a second GitHub account, so you're
   testing what a real external contributor would see.
3. The bot should comment listing the missing signers.
4. Sign by replying to the bot's comment with exactly:
   `I have read the CLA Document and I hereby sign the CLA`.
   A plain new comment will not count.
5. Confirm a new entry showed up in `cla-signatures`.
6. **Impersonation test**: on a different PR, reply to the bot's comment
   with the sign phrase from a third account and check the PR does _not_
   get marked as signed (unless that commenter is actually the PR's commit
   author). This is already covered by the bot's own test suite, but it's
   worth confirming
   once against a real PR too.

## Step 8 - Roll out across the whole org

Copy `examples/consumer-workflow.yml` (and, if you use one, a CODEOWNERS
entry from Step 5) into every repo that needs the CLA check. If you're
rolling out to many repos, a small internal script that pushes the
workflow file via the GitHub API (skipping repos that already have a
customized `cla.yml`) is worth writing, but that tooling isn't part of
this repository.

## Step 9 - Backups and monitoring

- Keep a weekly mirror or export of the `cla-signatures` repo somewhere
  else, in case it's ever accidentally deleted.
- Where possible, turn on repo deletion protection or require org-owner
  approval before a repo can be deleted, in Repo Settings.
- Set up a Slack or email notification for failed workflow runs (a small
  alert workflow listening for `workflow_run` events works for this).

## Step 10 - CLA versioning process (a plan, not yet needed)

When the CLA text itself changes:

1. Update `CLA.md` in the `cla-signatures` repo.
2. Point the new workflow version at a new path, like
   `signatures/cla-v2.json`, instead of the old one.
3. Announce that everyone needs to re-sign (a blog post or README banner
   works).

Old signatures stay valid under the old version - they're not deleted,
just no longer counted for the new one. This keeps a full audit trail.

---

## Known limitations

1. **Resolving a commit's email to a GitHub account**: if a contributor's
   git commit email isn't linked to their GitHub account (a privacy
   setting), the bot can't automatically resolve who they are - those PRs
   get flagged as "needs manual verification". This is a limitation shared
   by every CLA bot out there; it can't be fully automated without asking
   the contributor to verify their commit email.
2. **Concurrent write retries**: the bot retries up to a few times when two
   people sign at almost the same moment, including the very first
   signature ever written to a brand-new signature file. Under extremely
   high concurrent signing traffic this could still need watching, but
   that's an unlikely scale for FOSSASIA in practice.
