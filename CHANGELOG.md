# Changelog

All notable changes to this project are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

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
