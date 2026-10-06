# Security Policy

This bot writes to a private, org-wide legal record (contributor CLA
signatures) and holds a GitHub App private key as a secret. Please report
security issues responsibly.

## Reporting a vulnerability

**Do not open a public GitHub issue for security reports.**

Please report vulnerabilities through **GitHub's private vulnerability
reporting** for this repository:

1. Go to the [Security tab](https://github.com/fossasia/cla-bot/security)
   of `fossasia/cla-bot`.
2. Click **Report a vulnerability** under "Advisories".
3. Include a description of the issue and its impact, steps to reproduce
   if applicable, and a suggested fix if you have one.

This opens a private conversation with maintainers that only you and the
repository's security team can see, and keeps the whole exchange (and any
resulting advisory) attached to the repository. You should get an
acknowledgement within 5 business days.

If for some reason you can't use private vulnerability reporting, email
`security@fossasia.org` instead.

## Scope

In scope:

- `src/cla-bot.js` and `action.yml` in this repository.
- The composite action's interaction with the GitHub REST API.
- The release pipeline: `.github/workflows/release.yml`,
  `.github/scripts/release-check.js`, and the signatures and attestations they produce. A
  way to publish a release that is not built by that workflow, or a release
  that passes the verification below without having come from it, is a
  vulnerability.

Out of scope:

- The content of `fossasia/cla-signatures` (a separate, private repository
  with its own access controls).
- GitHub's own platform security (report those to GitHub directly).

## Design assumptions a security review should check against

1. Cross-repo writes must only use a short-lived GitHub App installation
   token, never a long-lived PAT hardcoded or cached beyond a single run.
2. The default `GITHUB_TOKEN` must never have access to the signatures
   repo - only the GitHub App installation token should.
3. A PR is only "signed" once everyone who contributed to it (every commit
   author, plus any co-author in a `Co-authored-by:` trailer) is in the
   signature store. Whoever left the sign comment doesn't matter.
4. The allowlist holds immutable numeric GitHub account ids only - no
   usernames and no glob/wildcard. A username can be renamed and then claimed
   by a different account, which would inherit a username-based exemption (and
   a bot-like username could bypass signing); ids are matched against what
   GitHub itself reports, exactly like the signature store.
5. This action never checks out or executes code from the pull request - it
   only reads PR/commit metadata via the API.
6. A release can only be created by `.github/workflows/release.yml`, from a
   signed, annotated `vMAJOR.MINOR.PATCH` tag that GitHub reports as
   verified, on a commit that is already on `main`, after the full test
   suite and the 100% coverage gate pass on that exact commit. Nobody
   uploads release assets by hand. The signed tag object the build verified
   is pinned: the publish job re-checks, right before it creates the release
   and again right before it publishes, that the tag still resolves to that
   exact object, so a tag moved or re-signed during the approval pause cannot
   be released. The draft release is also compared byte for byte, and as a
   set of assets, with the files that were signed and verified, right before
   it is published.
7. Release signing uses no long-lived key. Assets are signed with Sigstore
   keyless signing, bound to the identity of that workflow run through
   GitHub's OIDC token, and recorded in a public transparency log. The
   `publish` job (the only one that can sign or write) executes no
   repository code, and the `build` job (the only one that executes
   repository code) can only read.

## Verifying a release

Every release of this action is built and signed by GitHub Actions
(`.github/workflows/release.yml`), not on anyone's laptop. A release that does
not carry **all** the assets below is not a release of this project; do not
use it.

| Asset                                   | What it is                                                         |
| --------------------------------------- | ------------------------------------------------------------------ |
| `cla-bot-<tag>.tar.gz`                  | Source archive of the tagged commit (deterministic `git archive`). |
| `cla-bot-<tag>.tar.gz.sigstore.json`    | Sigstore (cosign) signature bundle for the archive.                |
| `cla-bot-<tag>.sbom.cdx.json`           | CycloneDX SBOM: the pinned third-party actions this action runs.   |
| `cla-bot-<tag>.provenance.intoto.jsonl` | SLSA build-provenance attestation (archive and SBOM).              |
| `cla-bot-<tag>.sbom.intoto.jsonl`       | Attestation binding the SBOM to the archive.                       |
| `SHA256SUMS`                            | Checksums of the archive and the SBOM.                             |
| `SHA256SUMS.sigstore.json`              | Sigstore signature bundle for `SHA256SUMS`.                        |

The signatures prove **where a release came from**: this repository's
`release.yml`, running on that tag and commit. They do not prove the code is
free of bugs, and they cannot prove anything about a release you never
verified. Check before you first pin a version:

```bash
TAG=vX.Y.Z                      # the release you are about to adopt
REPO=fossasia/cla-bot
WORKFLOW="$REPO/.github/workflows/release.yml"

gh release download "$TAG" --repo "$REPO" --dir cla-bot-release
cd cla-bot-release

# 1. The files are the ones that were signed.
sha256sum --check --strict SHA256SUMS

# 2. Sigstore signatures (cosign v3 or later). The identity is matched EXACTLY:
#    this workflow file, on this tag, issued by GitHub's OIDC provider.
for f in "cla-bot-$TAG.tar.gz" SHA256SUMS; do
  cosign verify-blob \
    --bundle "$f.sigstore.json" \
    --certificate-identity "https://github.com/$WORKFLOW@refs/tags/$TAG" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    "$f"
done

# 3. GitHub build-provenance and SBOM attestations.
gh attestation verify "cla-bot-$TAG.tar.gz" \
  --bundle "cla-bot-$TAG.provenance.intoto.jsonl" \
  --repo "$REPO" --signer-workflow "$WORKFLOW" --source-ref "refs/tags/$TAG"
gh attestation verify "cla-bot-$TAG.tar.gz" \
  --bundle "cla-bot-$TAG.sbom.intoto.jsonl" \
  --repo "$REPO" --signer-workflow "$WORKFLOW" \
  --predicate-type https://cyclonedx.org/bom

# 4. If "Immutable releases" is enabled (it should be), GitHub itself attests
#    that the release and its tag were never changed after publishing.
gh release verify "$TAG" --repo "$REPO"
gh release verify-asset "$TAG" "cla-bot-$TAG.tar.gz" --repo "$REPO"
```

Then **pin the commit, not the tag**. The commit a release tag points at is
the last line printed by:

```bash
git ls-remote --tags "https://github.com/$REPO.git" "$TAG" "$TAG^{}"
```

(the line ending in `^{}` is the commit; for an annotated tag the first line
is the tag object, which is not what you want). Use it in your workflow as
`uses: fossasia/cla-bot@<that full commit SHA> # vX.Y.Z`, as
`examples/consumer-workflow.yml` shows. A tag, even a protected one, is a name
that points at a commit; a full commit SHA is the commit itself, so nothing
that happens to this repository later can change what your workflow runs.
Dependabot and Renovate both keep a SHA pin plus a version comment up to
date.

What the signatures do **not** protect against, and what does:

- **Anyone who can push a tag to this repository.** Nothing restricts who may
  create a release tag, and "verified" only means the tag was signed by a
  key registered on the tagger's own GitHub account, so any collaborator with
  write access and a registered signing key can start a release. The checks
  that still apply to every release are: the commit must already be on
  `main`, the tests and the 100% coverage gate must pass on it, and the
  tagger is identifiable from the signed tag. If the `release` environment has
  required reviewers, a second person must also approve the publish. This
  repository also deliberately has no required code review on `main` (see
  `.github/rulesets/README.md`), so a pull request can in principle change
  `release.yml` itself, and the identity above only names the workflow _file_,
  not its contents. If you need more than that, add a required review (see the
  ruleset README) and check the diff of `release.yml` between the releases you
  adopt.
- **A tag moved between verification and release.** Not possible through this
  workflow: the publish job refuses to continue unless the tag still resolves
  to the exact signed tag object that was verified (`gh release create
--verify-tag` alone would not catch this; it only checks that the tag
  exists). What remains is a window of a few milliseconds between the last
  check and GitHub's publish call, and a final check after publishing that
  fails the run loudly if the tag moved anyway.
- **A draft release altered by someone with write access.** The byte-for-byte
  comparison right before publishing narrows this to the instant between that
  comparison and GitHub's publish call; it cannot be closed from inside a
  workflow. The post-publish verification then re-checks what users download
  and fails the run loudly, and consumers who verify (above) are protected
  regardless.
- **A tag moved or deleted after you pinned it.** Pinning the commit SHA makes
  this irrelevant for you; "Immutable releases" additionally makes it
  impossible for everyone else once a release is published. A tag that has no
  published release yet is not protected.

## Known limitations (not vulnerabilities, but worth knowing)

- Commits whose author email isn't linked to a GitHub account can't be
  automatically resolved and are flagged for manual review. This is a
  limitation shared by essentially every CLA bot.
- Co-authors are resolved from the `Co-authored-by:` trailer's email. If it
  follows GitHub's noreply format (`id+username@users.noreply.github.com`),
  the account is looked up directly. Any other email can't be reliably
  turned into a GitHub account, so it's flagged for manual review too, the
  same as an unresolved primary author.

  **What to do when this happens**: the bot's comment lists the short SHA
  of the affected commit(s) - never the raw email, since that can be
  personal data and the comment is public. A maintainer should:
  1. Open that commit and check its author/committer info directly.
  2. Confirm that person has actually signed - check
     `signatures/cla.json` in `fossasia/cla-signatures` for their GitHub
     username, or ask them to comment the sign phrase on this PR.
  3. If they're a legitimate contributor who just hasn't linked that email
     to GitHub, that's on them to fix (Settings → Emails) going forward -
     it doesn't need to block this PR once you've confirmed they signed.
  4. Comment `recheck` once satisfied. This re-evaluates the PR but won't
     clear the flagged commit on its own; merging past it is a deliberate
     maintainer call, not something the bot automates.

- Allowlisted accounts (e.g. `github-actions[bot]`, id `41898282`) are
  recognised by the account GitHub attributes a commit's **author** to, and
  GitHub does that purely from the commit's git email - which is public
  (`ID+name[bot]@users.noreply.github.com`) and can be forged by anyone. By
  default a forged "authored by github-actions[bot]" commit is therefore
  exempt from signing. Set `require-verified-commits: true` to close this: the
  author is then only trusted when that same account is also the verified
  committer, and anything else is flagged for manual review. (Check that your
  own automation's commits satisfy that before enabling it.)

- The comment-creation POST is deliberately not auto-retried by `gh()`'s
  transient-error retry (see CHANGELOG) - a genuine network blip there
  fails the job rather than risking a duplicate comment. The next PR event
  re-triggers it.
- Two races share the same root cause: nothing running as separate HTTP
  calls against a REST API with no lock can be made fully atomic.
  - The dedupe check before posting a comment (read, then post if nothing
    matches) can let two concurrent runs both post the same comment.
    `postComment` self-heals right after, by deleting duplicates down to
    the newest one.
  - `checkPR` reads commits, then the signature store, then decides and
    posts - so two overlapping runs can each act on what they saw when
    they started. Reading signatures as late as possible narrows this but
    doesn't close it.
  - Both are fully closed by the workflow-level `concurrency:` group in the
    example workflow, which queues overlapping runs for the same PR instead
    of racing them. The in-code mitigations are a backstop for when that
    group is missing, not a substitute for it.
- The signatures file can grow past 1 MB over time. Reads use GitHub's
  `object`/`raw` media types (good up to 100 MB) instead of the default
  format (reliable only under 1 MB), so this comfortably covers realistic
  growth.
- The signatures repo must never have branch protection that blocks direct
  API commits to its default branch, or the bot's writes will fail. If
  branch protection is ever added there, add the bot's GitHub App to the
  bypass list.
- Signing is intentionally open to anyone (no `author_association` check) -
  first-time contributors need to be able to sign. In principle this means
  disposable accounts could add junk entries to the store; that's accepted,
  unavoidable behavior shared by every public CLA bot, not a bug.
- `recheck` authorization uses `author_association`, which reflects the
  commenter's relationship to the repository, not to the specific PR. A
  collaborator unrelated to a given PR can still force a recheck on it -
  that's intentional, since maintainers should be able to recheck any PR.
- GitHub's "list commits on a pull request" endpoint only returns the first
  250 commits. A PR with more than that would silently miss signers past
  the 250th commit. This is an unlikely scenario for normal contributions
  and a constraint of the underlying API, not something this bot can work
  around.
- The example workflow grants `issues: write` and `pull-requests: read`
  (not `write`), since this action only ever reads PR data. `contents`
  isn't granted at all in the normal setup, since a GitHub App handles the
  signatures repo separately. See `action.yml`'s `github-token` description
  for the one case (no GitHub App configured) where `contents` is needed.
- Test coverage is offline/mocked - no real GitHub API calls in CI. A
  config or credentials mistake in a real deployment (wrong App ID, App not
  installed on the signatures repo) will only surface at runtime; the
  manual test-PR walkthrough in "TESTING_GUIDE.md" is what actually
  catches those.
- "Immutable releases" is a repository setting that cannot be turned on from
  code. Until it is enabled, a published release's assets can in principle
  still be replaced by an administrator; the signatures would then no
  longer match, so a verifying consumer notices, but a non-verifying one
  would not. The release workflow prints a warning on every release for as
  long as the setting is off.
- Verification trusts Sigstore's public-good instance (Fulcio, Rekor) and
  GitHub's OIDC provider and attestation service. An outage of either only
  delays a release or a verification; it cannot make a bad release verify.
- The `release` environment and "Immutable releases" are GitHub settings that
  no file in this repository can apply; confirm they are set (steps in
  `CONTRIBUTING.md`).
