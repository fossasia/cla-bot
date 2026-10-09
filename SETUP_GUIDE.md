# FOSSASIA CLA Bot Setup

The setup has three parts: publish this action, create a private signature
repository, and install a GitHub App that can write to it. Consumer
repositories use the tested workflow in `examples/consumer-workflow.yml`.

## 1. Publish the action

Create the public `fossasia/cla-bot` repository and push this code. Run
`npm test`, then follow the signed release steps in
[`CONTRIBUTING.md`](./CONTRIBUTING.md#releasing-a-new-version).

Before using a release, verify its assets and attestations using
[SECURITY.md](./SECURITY.md#verifying-a-release). Pin the full commit SHA of
the verified tag in each consumer workflow:

```bash
git ls-remote --tags https://github.com/fossasia/cla-bot.git v1.0.0 'v1.0.0^{}'
```

Use the 40-character SHA on the line ending in `^{}`. Add the version as a
trailing comment. Repeat for each release. Never use a moving tag in
production.

## 2. Create the signature repository

1. Create a private repository named `fossasia/cla-signatures`.
2. Add the reviewed CLA text as `CLA.md`.
3. Limit access to people who manage CLA records. The repository contains
   contributor names, account ids, and timestamps.
4. Do not create `signatures/cla.json`; the bot creates it when the first
   contributor signs.

## 3. Create and install a GitHub App

1. Create an organization App named `fossasia-cla-bot`.
2. Disable its webhook. It only needs to mint installation tokens.
3. Grant **Repository permissions → Contents: Read and write**.
4. Allow installation only on the FOSSASIA account, then install it only on
   `fossasia/cla-signatures`.
5. Save the App ID and downloaded private key for the next step. Keep the key
   in a secret, not in a file or repository.

## 4. Add organization secrets

At the organization Actions secrets page, create:

- `CLA_APP_ID`: the App ID.
- `CLA_APP_PRIVATE_KEY`: the full `.pem` contents, including real line breaks.

Set access to **Selected repositories** and include only repositories that
need the CLA check. Do not replace line breaks with the characters `\n`.

## 5. Add the consumer workflow

Copy `examples/consumer-workflow.yml` to each repository's
`.github/workflows/cla.yml`. Set the signature repository, CLA URL, verified
action SHA, and required secrets. Keep the workflow's permissions and
per-PR concurrency settings.

Check the repository's organization base permissions. Keep private signature
records unavailable to members who do not manage them.

Start with one test repository:

1. Open a PR from a second account and confirm the bot lists missing signers.
2. Post the exact sign phrase shown by the bot.
3. Confirm the signature appears in `cla-signatures` and the PR status passes.
4. On another PR, confirm a bystander cannot sign for its author.

After that, add the workflow to the remaining repositories. For a large
rollout, use an internal deployment script and preserve repositories with
custom workflows.

## Operations

- Keep a regular backup of `cla-signatures` and restrict repository deletion.
- Notify maintainers about failed workflow runs.
- When the CLA changes, use a new signature file path and ask contributors to
  sign again. Keep old records for the audit trail.

## Limits

- If GitHub cannot link a commit email to an account, the bot asks a
  maintainer to verify the author.
- Concurrent signature writes are retried, but unusually high signing volume
  may still need attention.
