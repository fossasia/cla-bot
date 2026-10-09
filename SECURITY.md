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
6. CLA comment history treats a comment as bot state only when it contains
   this action's marker and GitHub reports its author as the configured bot,
   a GitHub `Bot` account, or the default bot login. Accepting any GitHub
   `Bot` account is intentional: it lets pending/success history survive a
   switch between this action's GitHub App and `GITHUB_TOKEN` identities.
   GitHub supplies the author identity; PR authors cannot forge another
   account's `user.type`. This means a different or compromised GitHub App
   with permission to comment can influence the bot-history calculation if
   it deliberately posts the marker. Do not grant comment permissions to
   untrusted GitHub Apps on repositories that rely on this action.
7. A release can only be created by `.github/workflows/release.yml`, from a
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
   created; it must be imported in GitHub settings. The policy job checks that
   an active effective ruleset applies to exactly `refs/tags/v*` and blocks
   both updates and deletions. GitHub can hide the ruleset's bypass list from
   the read-only workflow token, so an administrator must separately confirm
   that the list is empty. If the ruleset is missing or malformed, policy
   fails before building. If an administrator disables or bypasses the ruleset,
   the tag can move during the final release read; the release
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
   Reconciliation is eventually consistent because published releases are
   intentionally editable. A published release metadata edit triggers an
   reconciliation, and a scheduled reconciliation is configured every six
   hours to catch asset-only edits (GitHub Actions has no dedicated release-
   asset event). Scheduler or API delays can extend that interval. Each run
   verifies current release contents and selects the highest currently valid
   stable release. Once a reconciliation observes a mutation, that release
   stops being eligible and a lower valid release is promoted. A mutation can
   leave Latest stale until the next scheduled run completes; mutable releases
   cannot provide a continuous invariant between checks. If no
   published stable release verifies, reconciliation fails closed and reports
   that it found no eligible candidate. A newer release published after an
   in-flight run selects a candidate can also briefly leave Latest behind; the
   serialized run for that publication verifies the current release list and
   converges the marker. If post-publication verification fails, `verify-latest`
   independently re-verifies public candidates using the helper from the exact
   workflow commit. Scheduled runs execute on the default branch. The release
   workflow has no manual-dispatch trigger, so an unmerged branch cannot be
   selected for a Latest reconciliation run. After a transient verification
   failure, rerun the failed jobs from the release run or wait for scheduled
   reconciliation.
8. Release signing uses no long-lived key. Assets are signed with Sigstore
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
9. A release does not start unless the workflow's immutability policy is
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
- **A change to `release.yml` itself.** Repository writers can merge any
  CI-passing change, including one that removes policy checks or the
  `environment: release` tag restriction. GitHub runs a workflow revision
  associated with the triggering ref; for tag pushes, that ref is the tag.
  Because release-tag creation is intentionally open to repository writers,
  the workflow cannot independently prove that its own YAML came from a
  reviewed default-branch revision. The signatures and attestations identify
  the workflow path, source ref, and source digest that produced an artifact;
  they do not independently prove that the workflow code had a separate
  review or was unchanged. This is the project's intentional trust boundary:
  repository writers are trusted to change the release pipeline, and no
  additional human or team approval is required. A stronger guarantee would
  require an independently protected release workflow or external enforcement;
  a workflow cannot defend itself from a writer who can change and trigger it.
  Consumers should inspect `release.yml` and `release-check.js` changes between
  the releases they adopt.
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
  - The group alone isn't quite enough, though: GitHub's default queue holds
    only one pending run per group, and a run that's already pending is
    replaced - not queued behind - by a newer one that arrives before it
    starts. A signing comment's run records a real state change (the
    signature itself), not just a status re-check, so losing it this way
    would mean the comment stays on the PR but the signature is silently
    never written. `queue: max` on the group (see the example workflow) is
    what closes this: every event waits its actual turn instead of a third
    one discarding a still-pending second one.
- The comment-history cache is an invocation snapshot. Within one `checkPR()`
  run, successful comments posted or deleted by that run are written through;
  comment changes made by another process are not incorporated automatically.
  This is safe for the production reads because the automatic quiet-success
  check reads pending/success comments as historical events (removing an old
  comment does not undo that the PR was previously blocked), and it is the
  first comment-history read on that path. Comment dedupe is an optimization;
  its post-write fresh scan repairs duplicates after a post. The consumer
  workflow's per-PR `concurrency:` group is therefore required to prevent
  overlapping bot runs from making decisions against competing snapshots.
  A fresh REST read would narrow, but cannot eliminate, races with unrelated
  writers because GitHub offers no atomic read-and-decide operation here.
- Complete-history comment semantics have a corresponding resource cost.
  GitHub's list endpoint returns at most 100 comments per page, so the cache
  load reads every history page; after each successful dedupe-enabled post,
  duplicate cleanup performs another fresh full-history scan. A single post
  can therefore require roughly two sets of paginated reads when the cache is
  cold, and multiple posts each require their own fresh cleanup scan. The
  cleanup spools matching comment IDs to a private temporary file, so its
  temporary disk use grows with the number of exact duplicates. These costs
  are intentional: imposing a page or ID cap could miss an old duplicate or
  change the history-based comment decisions. Cleanup itself is best effort,
  but the pre-post history read can fail the post operation. See
  `findExactDuplicateComments()` and `postComment()` in `src/cla-bot.js`.
- The signatures file can grow past 1 MB over time. Reads use GitHub's
  `object`/`raw` media types (good up to 100 MB) instead of the default
  format (reliable only under 1 MB), so this comfortably covers realistic
  growth.
- Independent GitHub reads (co-author lookups, pages of commits, and the
  bot-login lookup that runs next to the first page of comments) run at the
  same time, but never more than 8 at once, through one shared limiter.
  Anything that changes state goes one request at a time. A big PR costs
  about the same number of requests as before, just with less waiting. The
  pages of a PR's comment history are still read one after another (see
  below).
- `checkPR()` always certifies one base and head pair, and only after
  confirming the PR still is that pair. An automatic `pull_request_target`
  run starts from the pair in its own webhook payload. Other runs read the PR
  once and use its base and head together. The commit list is built with the
  Compare endpoint (`base...head`) for those two commit SHAs, so a later push
  cannot change the list being read. Right before anything is published, the
  PR is read once more:
  - If a head was named and the PR has moved on, nothing is published. The
    event for the new head checks it.
  - If only the base moved (no event is sent for that), the new pair is
    checked instead, up to `MAX_PAIR_ATTEMPTS` (3) times. If the PR keeps
    moving, the run fails and publishes nothing; `recheck` tries again.
    A status is only ever written to the head SHA of the pair that was checked.
    This re-check is a plain equality check on base and head, so it catches
    ANY difference - a base moving backward or being retargeted to an
    unrelated branch counts exactly the same as one moving forward, and
    triggers the same re-evaluation.
  - There is no REST call that publishes a status only if the PR is still
    this exact pair, so "confirm, then publish" can never be made fully
    atomic against a change in the last few milliseconds before the write
    lands. `checkPR()` closes as much of that window as a second HTTP call
    can: right after publishing, it reads the PR once more. If the base
    moved onto the very same head during or immediately after the write, the
    status just published is now known to be stale (it certified the old
    base), so it is **not** left standing - the new pair is evaluated and
    published instead, going through the same `MAX_PAIR_ATTEMPTS`-bounded
    loop as the pre-publish check. If attempts run out while a status is
    known to be stale, the head is overwritten with a conservative failure
    rather than trusting whatever was last written. If the head itself moved
    on instead, nothing more is done for the old head - a status is bound to
    one exact SHA, so it cannot satisfy anything checking the PR's new head,
    and the event for that new head covers it on its own. The post-publish
    read confirms the pair only at the instant of that read. A base retarget
    immediately afterward is outside this run's observation window: the run
    can finish with a status that was valid for the old base but is stale for
    the new one. That status can remain until a later relevant event or
    manual `recheck` evaluates the new pair. There is no bounded
    “milliseconds” guarantee for this residual window; its length depends on
    when another check is triggered.
  - All of the above is about a change happening *while* one run is working.
    A base retarget landing cleanly *after* a run has already finished is a
    different problem, and not one `checkPR()` can detect on its own - by
    then it has already returned. The fix lives one level up, in which
    webhook actions trigger a run at all: a retarget with no new commit on
    it fires neither `synchronize` (no new head) nor `closed`/`reopened`, so
    without also listening for `edited`, nothing re-evaluates the PR against
    its new base, and a status published for the old base stays attached to
    the unchanged head indefinitely. `pull_request_target`'s `edited` action
    also fires for a plain title or body edit, which needs no re-check, so
    `handlePullRequestTarget()` only acts on it when the payload's own
    `changes.base` is present - GitHub's signal that the base branch itself
    changed, not just its description. The shipped example workflow
    subscribes to `edited` for exactly this; a consumer workflow that omits
    it reintroduces this gap.
  - `changes.base` only fires when the PR's base is pointed at a *different*
    branch. It says nothing about the base *branch's own tip* moving while
    the PR keeps targeting the same branch - an ordinary push to `main`
    doesn't deliver any `pull_request_target` event at all, retarget or
    otherwise, since the PR object itself didn't change. For a branch that
    only ever moves forward (an ordinary fast-forward push, the normal case
    for a protected branch), this is a staleness window rather than a
    correctness problem: the Compare API only ever returns commits reachable
    from the head but not the base, so a base moving forward can only shrink
    that set, never add an unvetted commit to it - a status published
    against the old base stays at least as conservative against the new one.
    A base branch that can be force-pushed or reset is a different story:
    the new comparison can be materially different from the one that was
    actually checked, while the old status stays on the unchanged head.
    Closing that fully needs something outside a single PR event entirely -
    a scheduled reconciliation pass, or a `push`-triggered recheck of every
    open PR targeting the pushed branch - which is a real feature addition,
    not a fix to this run's own logic, and not one this project ships by
    default. The specific risk only exists for repositories that allow
    force-pushes to a branch PRs target, which is already outside GitHub's
    own recommended branch-protection configuration; protecting the base
    branch from force-pushes closes this at the source and is the
    recommended mitigation for repositories that need a stronger guarantee
    here than the staleness window above.
  - This isn't limited to a stale pair. Once a status has landed this run,
    the run tracks that fact (and which head it's for) the instant the write
    itself succeeds - not after everything that follows it, like the
    comment, also succeeds. If anything after that point throws for real -
    another attempt's evaluation, a re-read, the comment write, hitting the
    request budget above - the run does not just let that error propagate
    past a status that was never re-confirmed: it fails the head closed
    first (a best-effort overwrite to `failure`; a further failure in that
    overwrite itself is logged, not thrown, so it can't mask the original
    problem), then re-raises the original error so the run is still visibly
    a failure. See `failClosedStatus()`.
- Comment history (used to avoid repeat comments) is read page by page, and
  GitHub does not give a consistent snapshot across pages - this is an
  offset-based `page=`/`per_page=` API, not a cursor or a snapshot, so a list
  that changes mid-walk can shift what lands on which page while the walk is
  reading them. It never decides who has signed, only whether a comment is
  posted again or a success announcement is skipped. GitHub lists comments by
  ascending id, so both comment readers (the cache load and the duplicate
  cleanup scan) take an entry only if its id is above every id they already
  took, and skip anything else as a repeat. That keeps a shifted page boundary
  from making the bot see one comment twice - which would make the cleanup
  treat it as a duplicate of itself and delete the only copy. It keeps
  just one number, so it holds for a history of any size.
  A comment *deleted* mid-walk is a different, still-open gap: deleting an
  item shifts every later item back by one position, so the item that shifts
  into what was already-read page N's boundary is never re-read, and is
  missed. Closing that fully would mean re-reading every earlier page too, on
  every walk, for a purely cosmetic concern. The actual exposure is also
  narrow: aside from the bot's own duplicate-cleanup, comments on an open PR
  are essentially never deleted by anyone else, and even when this does
  happen, the worst outcome is one repeated or skipped bot comment,
  self-correcting on whatever event triggers the next check.
- The commit comparison (`listCommitsBetween`) stops at 100 pages (10,000
  commits), and this is an exact limit: exactly 10,000 commits succeeds,
  10,001 fails. A longer list, or a `Link` header claiming one, makes the run
  fail instead of being trusted partly. GitHub's own `total_commits` says the
  exact count up front, so the walk stops exactly there instead of guessing
  from page fullness. Comment history has no page cap on purpose (see the
  complete-history note above); it is bounded only by the run-wide request
  budget below, which fails the run rather than let it read without limit.
- Co-author identity lookups (Co-authored-by trailers) are capped twice: at
  most 20 distinct trailers per commit, and at most `MAX_COAUTHOR_LOOKUPS_PER_RUN`
  (300) distinct identities looked up across one whole run, however many
  commits, trailers, or re-evaluation attempts there are. One budget is
  created once per `checkPR()` run and threaded through every attempt - it is
  never recreated per attempt, since a PR whose base keeps moving can be
  re-evaluated up to `MAX_PAIR_ATTEMPTS` times and a fresh budget each time
  would multiply the real ceiling. Without the per-commit cap, a PR with many
  commits, each carrying the per-commit maximum, could queue a huge number of
  identity lookups behind the shared limiter - a real availability problem,
  not just a slow run. The run-wide budget also has to leave headroom under
  the default `GITHUB_TOKEN`'s 1,000 requests/hour per-repository limit for
  the rest of the run's own traffic (paging the compare, paging comments,
  reading and writing the status, reading the PR), which is why it is well
  under 1,000, not just under it. Trailers past either cap are flagged for
  manual review instead of looked up. The budget is keyed by the parsed
  identity (an account id for `id+login@users.noreply.github.com`, or a
  lowercased login for the older `login@users.noreply.github.com` format),
  not by the raw trailer address: two different trailers *in the same
  format* that happen to name the same account - say, the same id with
  different claimed login text in each - share one slot instead of two.
  This is a real but partial improvement, not a full account-level budget:
  the same real account named once through each format (an old-style
  `login@...` trailer on one commit, a new-style `id+login@...` trailer for
  the same person on another) still produces two different keys (`login:x`
  vs `id:n`) and so still costs two slots, because which account a login
  resolves to is exactly the fact the budget exists to avoid looking up
  speculatively - there is no way to know the two keys name the same account
  without doing the very lookup being budgeted. In practice this can only
  ever double-count, never let an over-the-cap PR through uncounted, and
  doing so requires the same contributor's co-author trailer to appear in
  both formats within one PR, which is uncommon; it is flagged here for
  accuracy rather than fixed, since a real fix would have to spend the
  lookups it exists to bound. An address that isn't either noreply format
  never touches the budget, since resolving it never costs a request in the
  first place.
  This identity count is a cheap, early filter, not the actual request
  ceiling: `gh()` transparently retries a transient failure (see
  `MAX_RETRIES`), so one admitted identity can cost more than one real
  request. The actual ceiling is `MAX_GITHUB_TOKEN_REQUESTS_PER_RUN` (700),
  enforced underneath everything in `ghRaw()` - it counts every real
  `GITHUB_TOKEN` request this event's processing makes, retries included,
  from every source (identity lookups, compare pagination, comment
  pagination, the PR itself, status writes, a signature read/write), and
  refuses to send another once it's spent. A separate, small
  `GITHUB_TOKEN_EMERGENCY_RESERVE` (10) is carved *out of* that same 700, not
  added on top of it, so the total across both pools genuinely never exceeds
  it; the reserve is spent only by `failClosedStatus()`'s own recovery write
  (see below) - without it, the exact exhaustion that makes a fail-closed
  overwrite necessary could also be the thing that blocks sending it,
  deterministically defeating the safety net the moment it's needed most.
  The budget covers the whole event, not just `checkPR()`'s own work:
  `handleIssueComment()` and `handlePullRequestTarget()` each start one for
  their entire call (see `runWithGitHubTokenRequestBudget()`), since a
  signing comment reads and writes the signature store - with `GITHUB_TOKEN`
  itself, whenever no separate App installation token is configured - before
  `checkPR()` is ever reached; leaving that traffic uncounted would make
  "run-wide" not actually mean the whole run. `checkPR()` also starts its
  own budget, for any caller that reaches it some other way (every test does
  this, and it's an exported function, so a future caller might too); when
  it's called from inside one of the two handlers above, it transparently
  reuses that outer budget instead of starting a nested, independent one.
  `checkPR()` runs under this budget via an `AsyncLocalStorage` store, not a
  plain shared variable: two overlapping top-level calls in the same process
  - `checkPR()`, `handleIssueComment()`, and `handlePullRequestTarget()` are
  all exported and async, so nothing rules this out for a future caller,
  even though today's single-event Action process never does it - each get
  their own isolated budget, correctly followed through their own call's
  entire async chain regardless of how the two interleave. A shared mutable
  counter would let one call's completion reset a budget still in use by the
  other, or let two calls silently share one ceiling instead of each getting
  their own; nothing like that is possible here. A token that isn't
  `GITHUB_TOKEN` (the signatures repo's own installation token, when
  configured) has its own separate rate limit on GitHub's side and is
  deliberately not counted against this one.
  What this budget does NOT do: guarantee the repository's real, GitHub-side
  `GITHUB_TOKEN` limit (1,000 requests/hour, shared by every workflow run in
  the repository - not a separate 1,000 per run) is respected. 700 is a
  per-event safety budget against one event's own runaway consumption (a
  pathologically large PR, a list that won't stop growing); several events
  landing in the same hour each get their own fresh 700, and can still add
  up past 1,000 on GitHub's side even though none of them individually went
  over its own ceiling. There's no in-process fix for that - each event runs
  in its own separate process, with nothing in common to track a shared
  count in, short of committing state somewhere external and accepting that
  store's own consistency and cost problems for a failure mode that's
  already self-limiting: going over GitHub's real limit makes GitHub itself
  start refusing requests, which is already treated as a hard failure here,
  not something to silently route around - it fails the run loudly rather
  than risk the CLA decision.
- Old-style noreply co-author addresses (`login@users.noreply.github.com`)
  have no account id, so a renamed account can't be found. Those commits are
  flagged for manual review. If someone else now owns the old login, they would
  be treated as the co-author. Use `id+login@...` addresses (GitHub's default
  today) to avoid this.
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
- The example workflow grants `contents: read`, `pull-requests: read`,
  `issues: write` and `statuses: write`, and nothing that writes repository
  contents. `contents: read` is required because the commit list comes from
  the Compare endpoint, which GitHub gates behind Contents read. The
  signatures repo is still handled by a GitHub App. See `action.yml`'s
  `github-token` description for the one case (no GitHub App, same repo)
  where `contents: write` is also needed.
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
- The release SBOM inventories the direct pinned third-party Actions that
  `action.yml` references through `runs.steps[*].uses`. It deliberately models
  only a composite action with no local `./` actions: anything else makes the
  release fail instead of producing an incomplete direct-action inventory.
  This is not a complete runtime or transitive dependency inventory: shell
  commands, downloaded code and dependencies internal to referenced Actions
  are outside its scope. It is generated in the `checks` job by the pinned
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
