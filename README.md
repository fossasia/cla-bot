# FOSSASIA CLA Bot

This GitHub Action checks whether pull request contributors have signed
FOSSASIA's Contributor License Agreement. It checks commit authors and
co-authors against a shared private signature repository. A comment alone
cannot satisfy another contributor's signature requirement.

The action uses Node.js built-ins and has no runtime dependencies. It does not
check out or run pull request code.

## Setup

Copy [`examples/consumer-workflow.yml`](./examples/consumer-workflow.yml) to
`.github/workflows/cla.yml`, then fill in its inputs and secrets. For the
organization-wide setup, see [`SETUP_GUIDE.md`](./SETUP_GUIDE.md).

Pin the action to the full commit SHA of a verified release. Keep the version
in a comment so Dependabot or Renovate can update both:

```yaml
uses: fossasia/cla-bot@<verified commit SHA> # vX.Y.Z
```

See [release verification](./SECURITY.md#verifying-a-release) before using a
release.

## How it works

1. On a pull request, the bot checks commit authors and `Co-authored-by`
   trailers against the signature store.
2. Missing signatures or unresolved authors are reported in a PR comment and
   the `cla/fossasia` status.
3. A contributor signs by posting the exact phrase shown in the comment.
4. The bot records the signature and checks the PR again. One signature then
   applies across FOSSASIA repositories.

## Security

- Signatures and allowlist entries use numeric GitHub account ids.
- A signer cannot satisfy another contributor's requirement.
- Signature writes use a short-lived GitHub App token when configured.
- Releases include Sigstore signatures and GitHub attestations.

See [`SECURITY.md`](./SECURITY.md) for the security model and its limits.

## Inputs

| Input | Required | Default | Purpose |
| --- | --- | --- | --- |
| `github-token` | Yes | | Read PR data, post comments, and set status. See `action.yml` for permissions. |
| `signatures-owner` | Yes | | Owner of the signature repository. |
| `signatures-repo` | Yes | | Private repository that stores signatures. |
| `signatures-path` | No | `signatures/cla.json` | Signature file path. See `action.yml` for path rules. |
| `cla-document-url` | Yes | | CLA shown to contributors. |
| `allowlist` | No | Empty | Numeric account ids that do not need to sign. |
| `app-id` | No | Empty | Positive decimal GitHub App id for signature writes. Set with `app-private-key`; leave both empty to use `github-token` (same-repository signatures only). |
| `app-private-key` | No | Empty | App private key in PEM format, provided as a secret. Set with `app-id`. |
| `require-verified-commits` | No | `false` | Require the author to match the verified committer. |
| `node-version` | No | `22` | Node.js version for self-hosted runners. |

## Allowlist

Use comma or whitespace-separated numeric GitHub account ids. Usernames and
wildcards are rejected.

```yaml
allowlist: |
  41898282
  49699333
  29139614
```

These ids are for `github-actions[bot]`, `dependabot[bot]`, and
`renovate[bot]`. Look up an id with:

```bash
gh api 'users/dependabot[bot]' --jq .id
```

## Development

```bash
npm test
npm run coverage
node --check src/cla-bot.js
```

Tests run offline. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) and
[`CHANGELOG.md`](./CHANGELOG.md) for development and release details.

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
