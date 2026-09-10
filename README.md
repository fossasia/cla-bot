# fossasia/cla-bot

A small GitHub Action that checks whether contributors have signed
FOSSASIA's Contributor License Agreement (CLA), and asks them to sign if
they haven't. It works across every FOSSASIA repository, using one shared
private repo (`fossasia/cla-signatures`) to keep track of who has signed.

It's written from scratch in plain Node.js, with no external packages. That
means there's nothing to install and nothing outside this repo that could
break or get abandoned.

## How it works

1. Someone opens a pull request in a FOSSASIA repo that has this bot set up.
2. The bot checks if everyone who contributed to that PR has already signed
   the CLA - this includes co-authors added through a `Co-authored-by` line
   in a commit message, not just the main author. If someone hasn't signed,
   it comments with instructions and marks the PR's `cla/fossasia` check as
   failing.
3. The contributor replies on the PR with the exact sign phrase.
4. The bot saves the signature (in `fossasia/cla-signatures`) and re-checks
   the PR. Once everyone has signed, the check turns green.
5. Since the signature list is shared across the whole org, signing once
   covers every other FOSSASIA repo too - no need to sign again.

## Why no dependencies

Everything here uses only what Node.js already comes with (`fetch`,
`crypto`, `fs`) - nothing to `npm install`. That keeps the surface area
small: there's no third-party package that could stop being maintained,
get compromised, or need updating. See `CONTRIBUTING.md` before adding one.

(The one exception is in `ci.yml`, which installs a small package just to
double-check `action.yml` is well-formed. That never ships as part of the
action itself - it's only used to test this repo.)

## Security highlights

The short version:

- Writing to the signatures repo uses a **short-lived** GitHub App token,
  created fresh each time the bot runs - never a long-lived token sitting
  in a secret.
- A PR only counts as "signed" once everyone who contributed to it
  (checked via the GitHub API, including co-authors) matches the signature
  list - not just whoever left a comment. Someone else can't clear a PR by
  signing on your behalf.
- The list of accounts allowed to skip signing (bots like Dependabot) only
  matches exact usernames - no wildcards that a person could exploit.
- This action never checks out or runs any code from the pull request.

## Using this in a repo

Copy [`examples/consumer-workflow.yml`](./examples/consumer-workflow.yml)
into `.github/workflows/cla.yml` in any repo that needs it, and fill in the
`with:` values for your setup. That file is the actual, tested
configuration - this README won't duplicate it separately, so it can't
drift out of date.

For the full org-wide setup - creating the GitHub App, setting up the
signatures repo, secrets, and rolling this out to every repo - see
"SETUP_GUIDE.md".

## Inputs

| Name                       | Required | Default               | What it's for                                                                                                                                                                              |
| -------------------------- | -------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `github-token`             | yes      | -                     | Usually `secrets.GITHUB_TOKEN`. See `action.yml` for the exact permissions it needs.                                                                                                       |
| `signatures-owner`         | yes      | -                     | The org or user that owns the signatures repo.                                                                                                                                             |
| `signatures-repo`          | yes      | -                     | Name of the private repo storing signatures.                                                                                                                                               |
| `signatures-path`          | no       | `signatures/cla.json` | Where the signatures file lives inside that repo.                                                                                                                                          |
| `cla-document-url`         | yes      | -                     | Link to the CLA text shown to contributors.                                                                                                                                                |
| `allowlist`                | no       | `''`                  | Comma-separated usernames that don't need to sign (exact match only, no wildcards).                                                                                                        |
| `app-id`                   | no       | `''`                  | GitHub App ID, used to get access to the signatures repo.                                                                                                                                  |
| `app-private-key`          | no       | `''`                  | The GitHub App's private key (should come from a secret).                                                                                                                                  |
| `require-verified-commits` | no       | `'false'`             | When `true`, only trusts a commit's author if that same account is also its verified committer - hardens against forged authors. Off by default so unsigned-commit workflows keep working. |
| `node-version`             | no       | `'22'`                | Node.js version the bot's script runs on. Only matters if you're on a self-hosted runner without a recent Node already installed.                                                          |

## Development

```bash
npm test                       # runs all the tests, no network needed
node --check src/cla-bot.js    # quick syntax check
```

See `CONTRIBUTING.md` for guidelines and `CHANGELOG.md` for what's changed.

## License

Apache-2.0 - see `LICENSE`.
