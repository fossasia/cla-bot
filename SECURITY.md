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
4. The allowlist only does exact string matches - no glob/wildcard, which
   would let someone bypass signing with a bot-like username.
5. This action never checks out or executes code from the pull request - it
   only reads PR/commit metadata via the API.

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
