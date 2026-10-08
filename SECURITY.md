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
   verified and whose own signed name is that same version (so a valid
   signed tag for another version cannot be replayed under a new name), on a
   commit that is already on `main`, after the full test suite and the 100%
   coverage gate pass on that exact commit. The workflow checks only that the
   commit is an ancestor of `main`; that commits reach `main` through a pull
   request and a passing "Required checks pass" is enforced by the `main`
   ruleset (`.github/rulesets/main.json`), which must be applied. Nobody
   uploads release assets by hand. The signed tag object the build verified
   is pinned: the publish job re-checks that the tag still resolves to that
   exact object right before it creates the draft, and again in the very same
   shell step as the publish call. The final step downloads and compares the
   DRAFT's assets, checks the tag, then reads the release again by ID before
   publication. That last read detects asset replacement during the tag API
   request. GitHub has no atomic verify-and-publish operation: a tag can move
   during the final release read, and release contents can change after that
   read. The release tag ruleset (`.github/rulesets/release-tags.json`)
   prevents ordinary writers from updating or deleting a `v*` tag once
   created; it must be imported in GitHub settings. Without it, repeated
   checks only narrow the tag race. If an administrator disables or bypasses
   the ruleset, the tag can move during the final release read; the release
   itself can still be edited after that read. See "A tag moved between
   verification and release" below. The
   draft release is also compared with what was prepared and verified, right
   before it is published: its assets byte for byte and as a set, and its
   title, tag, notes, draft and pre-release flags. Before publication the
   `sign` job verifies the signatures and attestations. After publication, all
   downloaded assets are compared byte for byte with the digest-pinned signed
   artifact and checked as a set; the post-publication checks verify its
   attestations again.
   The release is published without changing GitHub's `Latest` marker; a
   separate globally serialized job points it at the highest verified stable
   SemVer release. Candidate verification requires a signed annotated tag that
   directly names a commit on the default branch, the exact expected asset
   set, valid checksums and Cosign signatures, and workflow attestations bound
   to the tag and commit. A manually created release can be public, but cannot
   become Latest unless it passes these same checks.
   Reconciliation is eventually consistent: a newer release published after
   an in-flight run selects a candidate can briefly leave Latest behind; the
   serialized run for that publication verifies the current release list and
   converges the marker. If post-publication verification fails, `verify-latest`
   independently re-verifies public candidates using the helper from the exact
   workflow commit. It requires the policy job to pass on manual dispatch too.
   `workflow_dispatch` provides a manual recovery path without modifying
   published assets.
7. Release signing uses no long-lived key. Assets are signed with Sigstore
   keyless signing, bound to the identity of that workflow run through
   GitHub's OIDC token, and recorded in a public transparency log. The jobs
   are split by what they run: `build` creates the archive with `git` and
   Node built-ins and runs **no third-party code at all**; the `checks` job,
   on a different machine, installs the dev dependencies and runs them (the
   YAML parser for the SBOM, the coverage tool) and the test suite, and can
   at worst falsify the SBOM, never the archive; `sign` verifies both producer
   digests, signs and attests without checking out repository code, then
   passes a digest of the complete signed artifact through a job output.
   Third-party actions that need OIDC/signing permissions run only in `sign`.
   `publish` has `contents: write` but no OIDC permission and no third-party
   actions or repository code; it downloads the artifact with the runner's
   GitHub CLI and checks the sign job's digest before publication. `policy`,
   `build`, `checks`, and `sign` cannot publish releases. The separate `latest`
   job has only `contents: write`, runs shell commands without checkout or
   repository code, and uses that permission only to reconcile GitHub's Latest
   marker.
8. A release does not start unless the workflow's immutability policy is
   explicit and the `release` environment has no required reviewers. Mutability
   is intentionally `not-required` in workflow code. Repository release rights
   are the only human authorization for publishing. GitHub's actual environment
   protection rules still apply to the publish job. Release notes, the source archive and the SBOM
   each have a direct Cosign signature and are listed in the signed checksum
   manifest. A changed release-body copy is rejected by release verification
   unless it matches the signed notes asset. Mutable metadata such as the title
   is not signed. For a payload correction, publish a new patch version;
   consumers must reject an in-place replacement whose signatures no longer
   verify.

## Verifying a release

Every release of this action is built and signed by GitHub Actions
(`.github/workflows/release.yml`), not on anyone's laptop. A release that does
not carry **all** the assets below is not a release of this project; do not
use it. The release notes, source archive, and SBOM are payloads and each has
a direct Cosign signature. `SHA256SUMS` covers those three payloads and is
itself directly signed. Cosign signature bundles and GitHub attestation
bundles are cryptographic proof files; verify them with their corresponding
tools rather than trying to recursively sign proof files.

| Asset                                   | What it is                                                         |
| --------------------------------------- | ------------------------------------------------------------------ |
| `RELEASE_NOTES.md`                      | Generated release notes, directly signed and checksummed.         |
| `RELEASE_NOTES.md.sigstore.json`        | Sigstore (cosign) signature bundle for the release notes.          |
| `cla-bot-<tag>.tar.gz`                  | Source archive of the tagged commit (deterministic `git archive`). |
| `cla-bot-<tag>.tar.gz.sigstore.json`    | Sigstore (cosign) signature bundle for the archive.                |
| `cla-bot-<tag>.sbom.cdx.json`           | CycloneDX SBOM, directly signed and checksummed.                   |
| `cla-bot-<tag>.sbom.cdx.json.sigstore.json` | Sigstore (cosign) signature bundle for the SBOM.               |
| `cla-bot-<tag>.provenance.intoto.jsonl` | SLSA build-provenance attestation for checksummed payloads.        |
| `cla-bot-<tag>.sbom.intoto.jsonl`       | Attestation binding the SBOM to the archive.                       |
| `SHA256SUMS`                            | Checksums of release notes, archive, and SBOM.                     |
| `SHA256SUMS.sigstore.json`              | Sigstore signature bundle for `SHA256SUMS`.                        |

The signatures prove **where a release came from**: this repository's
`release.yml`, running on that tag and commit. They do not prove the code is
free of bugs, and they cannot prove anything about a release you never
verified. Check before you first pin a version:

```bash
TAG=vX.Y.Z                      # the release you are about to adopt
REPO=fossasia/cla-bot
WORKFLOW="$REPO/.github/workflows/release.yml"

# gh attestation verify must be v2.102.0 or newer. Older versions have
# verification-policy bugs in --signer-workflow and --source-ref.
GH_VERSION="$(gh version | awk 'NR == 1 { sub(/^gh version /, ""); print $1 }')"
if [[ ! "$GH_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Could not read the GitHub CLI version" >&2
  exit 1
fi
IFS=. read -r GH_MAJOR GH_MINOR _ <<< "$GH_VERSION"
if (( 10#$GH_MAJOR < 2 || (10#$GH_MAJOR == 2 && 10#$GH_MINOR < 102) )); then
  echo "Upgrade GitHub CLI to v2.102.0 or newer" >&2
  exit 1
fi

gh release download "$TAG" --repo "$REPO" --dir cla-bot-release
cd cla-bot-release

# 1. The payloads match the signed checksum manifest.
sha256sum --check --strict SHA256SUMS

# 2. The visible release body matches the signed release-notes asset.
RELEASE_BODY="$(gh api "repos/$REPO/releases/tags/$TAG" --jq '.body // ""' | tr -d '\r')"
SIGNED_NOTES="$(tr -d '\r' < RELEASE_NOTES.md)"
if [[ "$RELEASE_BODY" != "$SIGNED_NOTES" ]]; then
  echo "The release body differs from the signed RELEASE_NOTES.md asset" >&2
  exit 1
fi

# 3. Sigstore signatures (cosign v3 or later). The identity is matched EXACTLY:
#    this workflow file, on this tag, issued by GitHub's OIDC provider.
for f in RELEASE_NOTES.md "cla-bot-$TAG.tar.gz" \
    "cla-bot-$TAG.sbom.cdx.json" SHA256SUMS; do
  cosign verify-blob \
    --bundle "$f.sigstore.json" \
    --certificate-identity "https://github.com/$WORKFLOW@refs/tags/$TAG" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    "$f"
done

# 4. GitHub build-provenance and SBOM attestations.
# Resolve the tag once. The provenance check below must attest this exact
# commit, and this same value is the only SHA to use in the consumer workflow.
SOURCE_SHA="$(git ls-remote --tags "https://github.com/$REPO.git" "$TAG" "$TAG^{}" | awk '$2 ~ /\^\{\}$/ {print $1}')"
if ! [[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Could not resolve an annotated release tag to a commit" >&2
  exit 1
fi
gh attestation verify "cla-bot-$TAG.tar.gz" \
  --bundle "cla-bot-$TAG.provenance.intoto.jsonl" \
  --repo "$REPO" --signer-workflow "$WORKFLOW" --source-ref "refs/tags/$TAG" \
  --source-digest "$SOURCE_SHA"
gh attestation verify "cla-bot-$TAG.tar.gz" \
  --bundle "cla-bot-$TAG.sbom.intoto.jsonl" \
  --repo "$REPO" --signer-workflow "$WORKFLOW" \
  --source-ref "refs/tags/$TAG" --source-digest "$SOURCE_SHA" \
  --predicate-type https://cyclonedx.org/bom

# 5. GitHub's release immutability attestation is available only when the
#    repository has "Immutable releases" enabled. Mutable releases are
#    intentional here, so check it only when that setting is on.
if [ "$(gh release view "$TAG" --repo "$REPO" --json isImmutable --jq .isImmutable)" = true ]; then
  gh release verify "$TAG" --repo "$REPO"
  gh release verify-asset "$TAG" "cla-bot-$TAG.tar.gz" --repo "$REPO"
else
  echo "Release is mutable; asset signatures and attestations above are the integrity checks."
fi
```

Then **pin the exact `SOURCE_SHA` used above**, not a freshly resolved tag.
The provenance and SBOM attestations have both been required to match that
commit with `--source-digest`; therefore this is the verified source commit
that must appear in `uses: fossasia/cla-bot@$SOURCE_SHA # $TAG` (as a literal
SHA in the workflow, not a shell variable). This closes the gap between the
verified source and the commit GitHub Actions will execute. A tag, even a protected one, is a name
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
  tagger is identifiable from the signed tag. This project intentionally does
  not require a second-person approval; repository actors with release rights
  are authorized to publish.
- **A change to `release.yml` itself.** This repository deliberately has no
  required code review on `main` (see `.github/rulesets/README.md`), and the
  signing identity above names the workflow _file_, not its contents. A pull
  request that passes CI could therefore change `release.yml`, including
  removing the policy checks or the `environment: release` line that applies
  the environment's deployment tag restriction, and no check inside that same
  file can stop it. The
  policy gate protects against misconfiguration and against someone who can
  push tags but not change the workflow; it is **not** a defence against a
  malicious change to the workflow. Repository writers are trusted to change
  the release pipeline, and no separate human or team approval is required.
  Consumers should inspect the `release.yml` and `release-check.js` changes
  between the releases they adopt.
- **A tag moved between verification and release.** The publish job refuses
  to continue unless the tag still resolves to the exact signed tag object
  that was verified (`gh release create --verify-tag` alone would not catch
  this; it only checks that the tag exists). Importing the tag ruleset blocks
  updates/deletions by ordinary writers. If an administrator disables or
  bypasses that ruleset, the tag check and final release read remain separate
  API operations, so the tag can move during that read. The release can also
  change after its final read and before publication. Two
  outcomes call for different responses:
  - _Caught before publishing_ (the normal case): the run fails with "no
    longer resolves to the signed tag object", **nothing is public**, and
    nothing needs undoing.
  - _Caught only after publishing_ (the tag moved between the last check and
    GitHub's publish call): the run fails with "after
    publishing ... Treat this release as compromised". **The release is
    already public.** Do not re-run it; follow "If a release run fails" in
    `CONTRIBUTING.md` (mark or remove the release if it is still editable,
    find out who moved the tag, release the next patch version). Consumers who
    pinned the commit of a release they verified are unaffected, because the
    signed assets and attestations still describe the commit that was built.
- **A draft release altered by someone with write access.** The final
  release-ID snapshot follows the tag lookup and catches an asset replacement
  during that lookup. GitHub exposes no atomic release-read-and-publish call,
  so a writer can still change the release after the final snapshot and before
  publication. The post-publish verification re-checks what users download
  and fails the run loudly; consumers must verify signatures and attestations
  before using assets.
- **A tag moved or deleted after you pinned it.** Pinning the commit SHA makes
  this irrelevant for you. Import `.github/rulesets/release-tags.json` to
  prevent updates and deletions of `v*` tags while still allowing authorized
  writers to create new releases. Without that repository ruleset, the
  workflow's repeated tag checks narrow but do not eliminate the tag race.

## Known limitations (not vulnerabilities, but worth knowing)

- The CycloneDX SBOM's `metadata.timestamp` is the source commit timestamp, not
  the time the SBOM was generated. This keeps the SBOM reproducible for a given
  commit; use the GitHub attestation and release publication time when you
  need to know when the build actually ran or the artifact became public.

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
- "Immutable releases" is a repository setting that cannot be changed by the
  workflow. This project intentionally leaves releases editable to allow
  maintainers with release rights to correct them. When a signed asset is
  changed, its signature and checksum no longer match; consumers must verify
  again and reject changed assets until corrected signatures/checksums are
  published. The workflow records whether a release is immutable, but its
  declared `not-required` policy does not fail for mutable releases.
- The release SBOM lists the pinned third-party actions that `action.yml`
  runs (`runs.steps[*].uses`). It deliberately models only a composite action
  with no local `./` actions: anything else makes the release fail instead of
  producing an incomplete SBOM. It does not describe anything a step
  downloads at run time. It is generated in the `checks` job by the pinned
  `js-yaml` dev dependency, so a compromised copy of that package could
  falsify the SBOM's contents (never the archive, which is built in a
  different job on a different machine); the SBOM is evidence about the
  dependencies, the pinned commit and signatures are the integrity guarantee.
- The workflow proves that the released commit is an ancestor of `main`, not
  how it got there; that is the `main` ruleset's job (see above).
- Verification trusts Sigstore's public-good instance (Fulcio, Rekor) and
  GitHub's OIDC provider and attestation service. An outage of either only
  delays a release or a verification; it cannot make a bad release verify.
- The `release` environment and "Immutable releases" are GitHub settings that
  no file in this repository can apply; confirm they are set (steps in
  `CONTRIBUTING.md`).
