# Changelog

All notable changes to this project are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- **Signed, attested releases.** Pushing a signed, annotated `vMAJOR.MINOR.PATCH`
  tag runs `.github/workflows/release.yml`, the supported verified release
  path. Repository writers can still create releases manually. CI verifies the
  tag (annotated, GitHub-verified signature, on
  `main`, matches `package.json` and `CHANGELOG.md`), re-runs the full test
  suite and the 100% coverage gate, and publishes generated release notes, a
  deterministic source archive, and a CycloneDX SBOM, each with a direct
  Sigstore (cosign, keyless) signature. The signed `SHA256SUMS` covers those
  payloads; SLSA build-provenance and SBOM attestations provide additional
  signed proof. Signature and attestation bundles are verified as proof files,
  not recursively signed. The release is created as a draft, verified,
  published, and verified again from the public copy. See the "Verifying a
  release" section in `SECURITY.md`.
- **Verified Latest selection and recovery.** Latest only advances to the
  highest stable release whose signed tag, default-branch ancestry, exact
  assets, checksums, signatures and workflow attestations verify. The workflow
  supports manual reconciliation after a post-publication failure, without
  overwriting a published release; updates are eventually consistent when a
  new release races with an in-flight reconciliation.
- The publish job pins the tag: it re-checks (before creating the release,
  before publishing, and after) that the tag still resolves to the exact
  signed tag object the build job verified. The final publish step also
  rechecks draft metadata and every asset immediately before publication.
  `.github/rulesets/release-tags.json` blocks updates/deletions of release tags
  once imported. The Latest verifier is pinned to the workflow commit, manual
  recovery cannot bypass the policy gate, and mutability is set in reviewed
  workflow code. Every `gh attestation
  verify`, before and after publishing, uses the persisted bundle and pins the
  repository, signer workflow, tag ref and commit digest.
- Consumer instructions resolve the tag commit once, require both attestations
  to match it via `--source-digest`, and pin that same SHA in `uses:`. The
  release workflow requires GitHub CLI 2.102.0 or newer for attestation
  verification, verifies published notes/title/tag metadata, retains cross-job
  artifacts for 90 days, and isolates different version runs from each other.
- The release workflow now publishes without changing GitHub's `Latest` marker,
  then reconciles it in a globally serialized job to the highest published
  stable SemVer tag. Backfilling an older version can no longer demote a newer
  release; queued reconciliation runs safely re-read the full release list.
- The release helper refuses npm dependencies in every field that can pull
  code in (`dependencies`, `optionalDependencies`, `peerDependencies`,
  `bundleDependencies`/`bundledDependencies`), and reads `action.yml` as YAML
  instead of with a line regex.
- Before publishing, the draft release's assets are downloaded and compared
  byte for byte, and as a set, with the files that were signed and verified.
  The published copy is also checked byte for byte and as a set after upload.
  The build job now builds and hashes the assets before any repository test
  code runs (the publish job re-checks that digest), and uploads only after the
  tests pass.
- The SBOM helper refuses npm dependencies itself (not only via `verify`),
  reads only `runs.steps[*].uses` of a composite action (a `uses` that is an
  input or a `with:` value is not a dependency), versions components by their
  pinned commit, and keeps the human version label as an annotation that is
  dropped when the source comments disagree.
- Action dependencies use the registered `pkg:github` PURL type, including the
  action subpath where applicable; tests validate output against the official
  CycloneDX 1.6 JSON schema.
- The tag check also verifies the signed tag object's own name equals the tag
  being released, so a validly signed tag for another version cannot be
  replayed under a new ref. The draft check covers release metadata (title,
  tag, notes, draft and pre-release flags) as well as the assets. The final
  step now checks the release's own `isImmutable` flag plus GitHub's release
  attestation, and FAILS the run when a release declared `required` is not
  immutable, instead of warning.
- The release helper refuses a local `./` action in `action.yml` (it resolves
  against the caller's workspace and would hide dependencies from the SBOM), and
  validates owner/repository/action path syntax and refuses extra `@` suffixes;
  its changelog parser ignores `##` lines inside fenced code blocks.
- Third-party code no longer shares a machine with the archive. The release is
  now six jobs: `policy`, `build` (verifies the tag and builds the archive with
  `git` and Node built-ins only, no npm), `checks` (installs dev dependencies,
  generates the SBOM, runs the tests and the 100% coverage gate) and `publish`
  (which needs both, re-checks both digests, and writes `SHA256SUMS` itself),
  `verify-latest` (which validates releases from their signed tags through
  asset attestations and provides a recovery path), and `latest` (which
  promotes the highest verified stable SemVer release).
- A release policy gate runs before anything is built: the workflow declares
  `RELEASE_IMMUTABILITY` (`required` or `not-required`; GitHub's setting cannot
  be read from a workflow token), and the `release` environment must have no
  required reviewers. Any actor with repository release rights can publish;
  the project intentionally permits mutable releases.
- The last tag check and the publish call are now one shell step, so nothing
  but one API round trip sits between them.
- Least-privilege release pipeline: the job that runs repository code can only
  read; the job that signs and publishes runs no repository code, re-checks
  the build's digest, and waits on the `release` environment.
- `.github/scripts/release-check.js` (tag/version/changelog/tag-signature
  verification, release notes extraction, SBOM generation) with offline tests,
  and `test/release-workflow.test.js`, which pins the pipeline's security
  properties (permissions, SHA pinning, no shell interpolation, step order,
  documented assets).

### Changed

- Documentation (`README.md`, `SETUP_GUIDE.md`, `TESTING_GUIDE.md`,
  `examples/consumer-workflow.yml`) now recommends pinning the action by the
  **full commit SHA** of a verified release, with the version in a trailing
  comment, instead of a mutable tag.
- `CONTRIBUTING.md`'s release section replaced the manual `git tag` /
  `git push` steps with the signed-release procedure, one-time repository
  setup and failure recovery.
- `README.md`'s security summary said the allowlist matches usernames; it has
  matched numeric account ids since the id-based allowlist change. Corrected.

## [1.0.0]

### Added

- Self-contained CLA enforcement action, zero npm runtime dependencies.
- Cross-repo signature writes via short-lived GitHub App installation
  tokens (minted locally via a hand-signed JWT - no external token library).
- Impersonation guard: a PR is only "signed" once its actual commit authors
  (resolved via the GitHub API) match the signature store, not the comment
  author.
- Exact-match-only allowlist (no wildcard/glob bypass).
- Retry-with-refetch on HTTP 409, and on the 422 "first write to a new
  file" race, for concurrent signature writes.
- Generic retry with backoff for transient 429/5xx GitHub API responses.
- Request timeouts on every network call.
- Comment de-duplication so repeated `synchronize` events don't spam a PR.
- Optional `require-verified-commits` hardening against author-spoofed
  commits.
- PR auto-lock after merge.
- Full offline unit-test suite (`npm test`) covering signature matching,
  allowlist behavior, the impersonation guard, JWT correctness, HTTP
  retries, and end-to-end event handling.
- CI workflow testing against Node.js 22 and 24.

### Design notes

- Built from scratch, without depending on any third-party CLA action -
  see the README for why.
- Uses a composite action (`shell: bash` + `node`) rather than
  `runs.using: node22`/`node24`, so this action is unaffected by GitHub's
  periodic JavaScript-action-runtime deprecation cycle.

### Known limitations

- Commit authors whose email isn't linked to a GitHub account can't be
  auto-resolved; such PRs are flagged for manual review.
