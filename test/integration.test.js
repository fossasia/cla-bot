"use strict";
/**
 * End-to-end test of the real orchestration (handleIssueComment -> writeSignatures
 * -> checkPR -> listPRCommitAuthors/postComment/setStatus), all against a single
 * mocked `fetch` router. This is the layer the other two test files don't cover:
 * they test the pieces in isolation, this exercises them wired together the way
 * a real webhook event would.
 *
 * Run: node test/integration.test.js (also included in `npm test`)
 */
const assert = require("assert");

process.env.GITHUB_TOKEN = "dummy-token";
process.env.GITHUB_REPOSITORY = "fossasia/testrepo";
process.env.SIG_OWNER = "fossasia";
process.env.SIG_REPO = "cla-signatures";
process.env.SIG_PATH = "signatures/cla.json";
process.env.CLA_DOCUMENT_URL = "https://example.com/CLA.md";
process.env.ALLOWLIST = "";
// No SIG_APP_ID/SIG_APP_PRIVATE_KEY -> getSignaturesToken() falls back to
// GITHUB_TOKEN, which is fine here since signatures-repo calls are mocked too.

const {
  handleIssueComment,
  handlePullRequestTarget,
  lockPR,
  postComment,
  checkPR,
  assertValidSha,
} = require("../src/cla-bot.js");

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (e) {
    console.error(`FAIL: ${name}\n - ${e.stack}`);
    process.exitCode = 1;
  }
}

function res(status, jsonBody) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (jsonBody === null ? "" : JSON.stringify(jsonBody)),
    headers: { get: () => null },
  };
}
function b64(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

// A fetch stub for the input-validation tests below: any call at all means
// a value that should have been rejected made it past validation and
// reached the network layer - so any invocation is itself the failure,
// regardless of what it would have returned.
function fetchThatMustNotBeCalled(url, opts) {
  throw new Error(
    `must not make any network request - validation should have thrown ` +
      `before reaching fetch(), but got: ${(opts && opts.method) || "GET"} ${url}`,
  );
}

// A small in-memory "GitHub" that the mocked fetch reads/writes so the test
// reflects real cross-call state changes (comment created, signature stored).
function makeFakeGitHub({
  commits,
  initialSignatures,
  users = {},
  usersById = {},
  lockShouldFail = false,
}) {
  const state = {
    signatures: initialSignatures,
    sha: "sha-0",
    comments: [],
    statuses: [],
    lockCalls: [],
    lockShouldFail,
  };

  state.fetch = async (url, opts = {}) => {
    const method = (opts.method || "GET").toUpperCase();

    if (url.includes("/users/")) {
      // Resolves the old-style noreply co-author format (no id embedded in
      // the email) via GET /users/{login}. `users` maps login -> user object
      // (or omit the key entirely to simulate a 404/unresolvable account).
      const login = decodeURIComponent(url.split("/users/")[1]);
      if (Object.prototype.hasOwnProperty.call(users, login)) {
        return res(200, users[login]);
      }
      return res(404, { message: "Not Found" });
    }
    if (/\/user\/\d+(?:$|\?)/.test(url)) {
      // Resolves the AUTHORITATIVE login for a numeric id via GET
      // /user/{id} (singular "user", distinct from the /users/{login}
      // endpoint above). `usersById` maps id (as a string) -> user object.
      const id = url.match(/\/user\/(\d+)/)[1];
      if (Object.prototype.hasOwnProperty.call(usersById, id)) {
        return res(200, usersById[id]);
      }
      return res(404, { message: "Not Found" });
    }
    if (url.includes("/pulls/1/commits")) {
      // Real pagination: slice `commits` into pages of 100 based on the
      // `page=` query param, so tests can exercise the loop-continuation
      // branch with a genuinely large commit list, not just a canned
      // "page=2 -> []" shortcut.
      const pageMatch = url.match(/[&?]page=(\d+)/);
      const pageNum = pageMatch ? Number(pageMatch[1]) : 1;
      const start = (pageNum - 1) * 100;
      return res(200, commits.slice(start, start + 100));
    }
    if (url.includes("/pulls/1") && !url.includes("/commits")) {
      return res(200, { head: { sha: "head-sha-abc" } });
    }
    if (url.includes("/contents/signatures/cla.json")) {
      if (method === "GET") {
        // Real GitHub always includes an `encoding` field alongside base64
        // `content` - readSignatures() checks it to know whether it got the
        // real content inline (small file) or needs a raw-content fallback
        // (file over 1 MB). Test data here is always small.
        return res(200, {
          sha: state.sha,
          content: b64(state.signatures),
          encoding: "base64",
        });
      }
      if (method === "PUT") {
        const body = JSON.parse(opts.body);
        // Real compare-and-swap semantics, matching GitHub: a PUT against a
        // stale sha is rejected with 409, not silently accepted. Without
        // this, two genuinely concurrent writers racing through this mock
        // would just last-write-wins overwrite each other instead of the
        // second one hitting writeSignatures' real 409-retry path - making
        // any race test built on this mock pass even if that retry logic
        // were completely broken.
        if (body.sha !== state.sha) {
          return res(409, { message: "sha does not match" });
        }
        state.signatures = JSON.parse(
          Buffer.from(body.content, "base64").toString(),
        );
        state.sha = `sha-${Number(state.sha.split("-")[1]) + 1}`;
        return res(200, { content: { sha: state.sha } });
      }
    }
    if (url.includes("/issues/1/comments")) {
      if (method === "GET") {
        const pageMatch = url.match(/[&?]page=(\d+)/);
        const pageNum = pageMatch ? Number(pageMatch[1]) : 1;
        const start = (pageNum - 1) * 100;
        return res(200, state.comments.slice(start, start + 100));
      }
      if (method === "POST") {
        const { body } = JSON.parse(opts.body);
        // Real GitHub always attributes comments made via GITHUB_TOKEN to
        // this exact bot login - the mock reflects that so the dedupe
        // filter (which now checks comment author, not just marker text)
        // behaves like production.
        const comment = {
          id: state.comments.length + 1,
          body,
          user: { login: "github-actions[bot]" },
        };
        state.comments.push(comment);
        return res(201, comment);
      }
    }
    if (url.includes("/issues/comments/")) {
      if (method === "DELETE") {
        const id = Number(url.split("/issues/comments/")[1]);
        const before = state.comments.length;
        state.comments = state.comments.filter((c) => c.id !== id);
        if (state.comments.length === before)
          return res(404, { message: "Not Found" }); // already deleted
        return res(204, null);
      }
    }
    if (url.includes("/statuses/")) {
      const payload = JSON.parse(opts.body);
      // sha is only in the URL, not the body - capture it too so tests can
      // assert which commit a status was posted against.
      state.statuses.push({ ...payload, sha: url.split("/statuses/")[1] });
      return res(201, {});
    }
    if (url.includes("/lock")) {
      if (method === "PUT") {
        state.lockCalls.push(JSON.parse(opts.body || "{}"));
        if (state.lockShouldFail) {
          return res(403, {
            message: "Resource not accessible by integration",
          });
        }
        return res(204, null);
      }
    }
    throw new Error(`Unhandled mock request: ${method} ${url}`);
  };

  return state;
}

(async () => {
  await test("a sole commit author signing their own PR flips status to success and posts one comment", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 1001, login: "alice" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "alice@example.com" } },
        },
      ],
      initialSignatures: { version: 1, signatures: [] },
    });
    global.fetch = gh.fetch;

    const payload = {
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "alice" } },
      comment: {
        user: { id: 1001, login: "alice" },
        body: "I have read the CLA Document and I hereby sign the CLA",
        html_url: "https://github.com/fossasia/testrepo/pull/1#issuecomment-1",
        author_association: "NONE",
      },
    };

    await handleIssueComment(payload);

    assert.strictEqual(
      gh.signatures.signatures.length,
      1,
      "signature should be recorded",
    );
    assert.strictEqual(gh.signatures.signatures[0].login, "alice");
    assert.strictEqual(
      gh.signatures.signatures[0].id,
      1001,
      "the signer's immutable numeric id must be recorded alongside the login",
    );
    assert.strictEqual(gh.statuses.length, 1);
    assert.strictEqual(gh.statuses[0].state, "success");
    assert.strictEqual(gh.comments.length, 1);
    assert.ok(
      gh.comments[0].body.includes(
        "@alice Thank you for signing the CLA! We look forward to your contributions.",
      ),
      "the sole (and completing) signer must be thanked by name, not shown the generic 'All contributors have signed' announcement",
    );
  });

  await test("a random third party commenting the sign phrase does NOT clear a PR authored by someone else", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 2001, login: "real-author" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "x@example.com" } },
        },
      ],
      initialSignatures: { version: 1, signatures: [] },
    });
    global.fetch = gh.fetch;

    const payload = {
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "real-author" } },
      comment: {
        user: { id: 9999, login: "random-commenter" }, // NOT the commit author
        body: "I have read the CLA Document and I hereby sign the CLA",
        html_url: "https://github.com/fossasia/testrepo/pull/1#issuecomment-2",
        author_association: "NONE",
      },
    };

    await handleIssueComment(payload);

    // random-commenter's own signature IS recorded (they're entitled to sign
    // for themselves) ...
    assert.strictEqual(gh.signatures.signatures[0].login, "random-commenter");
    // ... but the PR must still show as failing, because its actual author
    // ('real-author') has not signed.
    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "failure");
    const lastComment = gh.comments[gh.comments.length - 1].body;
    assert.ok(
      lastComment.includes("@real-author"),
      "the missing-signer list must name the real author, not the commenter",
    );
  });

  await test("merge commits do not require the person who merged to sign", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 3001, login: "author" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "a@example.com" } },
        },
        {
          sha: "c2",
          author: { id: 3002, login: "maintainer-who-merged-main-in" },
          parents: [{ sha: "p1" }, { sha: "p2" }],
          commit: { author: { email: "m@example.com" } },
        },
      ],
      initialSignatures: {
        version: 1,
        signatures: [{ id: 3001, login: "author" }],
      },
    });
    global.fetch = gh.fetch;

    const payload = {
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "author" } },
      comment: {
        user: { id: 3001, login: "author" },
        body: "recheck",
        html_url: "x",
        author_association: "NONE",
      },
    };
    await handleIssueComment(payload);

    assert.strictEqual(
      gh.statuses[gh.statuses.length - 1].state,
      "success",
      "the merge commit author should not block signing",
    );
  });

  await test("a co-author added via a noreply-email trailer must also sign, with their login resolved authoritatively from GitHub (not trusted from the trailer text)", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 4001, login: "primary-author" },
          parents: [{ sha: "p1" }],
          commit: {
            author: { email: "primary@example.com" },
            message:
              "Add feature\n\nCo-authored-by: Helper Person <12345+helper-login@users.noreply.github.com>",
          },
        },
      ],
      initialSignatures: {
        version: 1,
        signatures: [{ id: 4001, login: "primary-author" }],
      }, // co-author has NOT signed
      usersById: { 12345: { id: 12345, login: "helper-login" } },
    });
    global.fetch = gh.fetch;

    const payload = {
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "primary-author" } },
      comment: {
        user: { id: 4001, login: "primary-author" },
        body: "recheck",
        html_url: "x",
        author_association: "NONE",
      },
    };
    await handleIssueComment(payload);

    assert.strictEqual(
      gh.statuses[gh.statuses.length - 1].state,
      "failure",
      "the unsigned co-author must block the PR",
    );
    const lastComment = gh.comments[gh.comments.length - 1].body;
    assert.ok(
      lastComment.includes("@helper-login"),
      "the co-author extracted from the noreply email must be named as a missing signer",
    );
  });

  await test("once the co-author also signs, the PR clears", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 4001, login: "primary-author" },
          parents: [{ sha: "p1" }],
          commit: {
            author: { email: "primary@example.com" },
            message:
              "Add feature\n\nCo-authored-by: Helper Person <12345+helper-login@users.noreply.github.com>",
          },
        },
      ],
      initialSignatures: {
        version: 1,
        signatures: [
          { id: 4001, login: "primary-author" },
          { id: 12345, login: "helper-login" },
        ],
      },
      usersById: { 12345: { id: 12345, login: "helper-login" } },
    });
    global.fetch = gh.fetch;

    const payload = {
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "primary-author" } },
      comment: {
        user: { id: 4001, login: "primary-author" },
        body: "recheck",
        html_url: "x",
        author_association: "NONE",
      },
    };
    await handleIssueComment(payload);

    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "success");
  });

  await test("a co-author added via an OLD-STYLE noreply email (pre-2017 accounts, no id embedded) is resolved via one cached /users lookup", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 4101, login: "primary-author" },
          parents: [{ sha: "p1" }],
          commit: {
            author: { email: "primary@example.com" },
            // Old format: no "id+" prefix. GitHub still documents this as
            // valid for accounts that enabled email privacy before 18 Jul 2017.
            message:
              "Add feature\n\nCo-authored-by: Old Timer <old-helper@users.noreply.github.com>",
          },
        },
      ],
      initialSignatures: {
        version: 1,
        signatures: [{ id: 4101, login: "primary-author" }],
      },
      users: { "old-helper": { id: 424242, login: "old-helper" } },
    });
    global.fetch = gh.fetch;

    const payload = {
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "primary-author" } },
      comment: {
        user: { id: 4101, login: "primary-author" },
        body: "recheck",
        html_url: "x",
        author_association: "NONE",
      },
    };
    await handleIssueComment(payload);

    assert.strictEqual(
      gh.statuses[gh.statuses.length - 1].state,
      "failure",
      "old-style co-author has not signed yet, so the PR should still fail",
    );
    const lastComment = gh.comments[gh.comments.length - 1].body;
    assert.ok(
      lastComment.includes("@old-helper"),
      "the old-style co-author must be resolved and named as a missing signer, not dumped into 'unresolved'",
    );
  });

  await test("once the OLD-STYLE-noreply co-author signs (recorded with their resolved id), the PR clears", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 4102, login: "primary-author-2" },
          parents: [{ sha: "p1" }],
          commit: {
            author: { email: "primary2@example.com" },
            message:
              "Add feature\n\nCo-authored-by: Old Timer <old-helper-2@users.noreply.github.com>",
          },
        },
      ],
      initialSignatures: {
        version: 1,
        signatures: [
          { id: 4102, login: "primary-author-2" },
          { id: 434343, login: "old-helper-2" },
        ],
      },
      users: { "old-helper-2": { id: 434343, login: "old-helper-2" } },
    });
    global.fetch = gh.fetch;

    const payload = {
      action: "created",
      issue: {
        number: 1,
        pull_request: {},
        user: { login: "primary-author-2" },
      },
      comment: {
        user: { id: 4102, login: "primary-author-2" },
        body: "recheck",
        html_url: "x",
        author_association: "NONE",
      },
    };
    await handleIssueComment(payload);

    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "success");
  });

  await test("REQUIRE_VERIFIED_COMMITS=true flags an unverified commit for manual review instead of auto-trusting GitHub's email-based author match", async () => {
    const originalRVC = process.env.REQUIRE_VERIFIED_COMMITS;
    try {
      process.env.REQUIRE_VERIFIED_COMMITS = "true";
      delete require.cache[require.resolve("../src/cla-bot.js")];
      const {
        handleIssueComment: handleHardened,
      } = require("../src/cla-bot.js");
      const gh = makeFakeGitHub({
        commits: [
          {
            sha: "unsignedcommit1",
            // Even though GitHub attributes this to "victim-user" (e.g. via a
            // forged ID+login noreply address), there's no real signature
            // behind it.
            author: { id: 5101, login: "victim-user" },
            committer: { id: 5101, login: "victim-user" },
            parents: [{ sha: "p1" }],
            commit: {
              author: { email: "12345+victim-user@users.noreply.github.com" },
              verification: { verified: false, reason: "unsigned" },
            },
          },
        ],
        // victim-user already signed legitimately in the past.
        initialSignatures: {
          version: 1,
          signatures: [{ id: 5101, login: "victim-user" }],
        },
      });
      global.fetch = gh.fetch;

      const payload = {
        action: "created",
        issue: { number: 1, pull_request: {}, user: { login: "someone" } },
        comment: {
          user: { id: 6001, login: "someone" },
          body: "recheck",
          html_url: "x",
          author_association: "OWNER",
        },
      };
      await handleHardened(payload);

      assert.strictEqual(
        gh.statuses[gh.statuses.length - 1].state,
        "failure",
        "an unverified commit must not be auto-cleared just because its claimed author already signed",
      );
      const lastComment = gh.comments[gh.comments.length - 1].body;
      assert.ok(
        lastComment.includes("unsignedcommit1".slice(0, 7)),
        "the unverified commit must be surfaced by (short) SHA for manual review",
      );
    } finally {
      if (originalRVC === undefined)
        delete process.env.REQUIRE_VERIFIED_COMMITS;
      else process.env.REQUIRE_VERIFIED_COMMITS = originalRVC;
      delete require.cache[require.resolve("../src/cla-bot.js")];
    }
  });

  await test("REQUIRE_VERIFIED_COMMITS=true does NOT trust a validly-VERIFIED commit whose author differs from its committer (the author-vs-committer forgery: GitHub only ever cryptographically verifies the committer)", async () => {
    const originalRVC = process.env.REQUIRE_VERIFIED_COMMITS;
    try {
      process.env.REQUIRE_VERIFIED_COMMITS = "true";
      delete require.cache[require.resolve("../src/cla-bot.js")];
      const {
        handleIssueComment: handleHardened,
      } = require("../src/cla-bot.js");
      const gh = makeFakeGitHub({
        commits: [
          {
            sha: "forgedauthorcommit",
            // Forged: author claims to be an already-signed victim (via the
            // noreply-id trick), but the commit was actually signed and
            // committed by a completely different, real account (the
            // attacker's own). GitHub reports this as verification.verified
            // === true because the signature itself is perfectly genuine -
            // it's just genuinely the attacker's, not the victim's.
            author: { id: 7101, login: "victim-user-2" },
            committer: { id: 8001, login: "attacker" },
            parents: [{ sha: "p1" }],
            commit: {
              author: {
                email: "7101+victim-user-2@users.noreply.github.com",
              },
              verification: { verified: true, reason: "valid" },
            },
          },
        ],
        initialSignatures: {
          version: 1,
          signatures: [{ id: 7101, login: "victim-user-2" }], // victim really did sign, just not THIS commit
        },
      });
      global.fetch = gh.fetch;

      const payload = {
        action: "created",
        issue: { number: 1, pull_request: {}, user: { login: "attacker" } },
        comment: {
          user: { id: 8001, login: "attacker" },
          body: "recheck",
          html_url: "x",
          author_association: "NONE",
        },
      };
      await handleHardened(payload);

      assert.strictEqual(
        gh.statuses[gh.statuses.length - 1].state,
        "failure",
        "a verified-but-author!=committer commit must NOT be auto-credited to the (forged) author just because the signature itself checks out",
      );
      const lastComment = gh.comments[gh.comments.length - 1].body;
      assert.ok(
        lastComment.includes("forgedauthorcommit".slice(0, 7)),
        "the mismatched commit must be surfaced by SHA for manual review, not silently cleared",
      );
    } finally {
      if (originalRVC === undefined)
        delete process.env.REQUIRE_VERIFIED_COMMITS;
      else process.env.REQUIRE_VERIFIED_COMMITS = originalRVC;
      delete require.cache[require.resolve("../src/cla-bot.js")];
    }
  });

  await test("REQUIRE_VERIFIED_COMMITS=true DOES trust a verified commit when author and committer are genuinely the same account (the legitimate case)", async () => {
    const originalRVC = process.env.REQUIRE_VERIFIED_COMMITS;
    try {
      process.env.REQUIRE_VERIFIED_COMMITS = "true";
      delete require.cache[require.resolve("../src/cla-bot.js")];
      const {
        handleIssueComment: handleHardened,
      } = require("../src/cla-bot.js");
      const gh = makeFakeGitHub({
        commits: [
          {
            sha: "genuinesigned",
            author: { id: 9101, login: "real-signer" },
            committer: { id: 9101, login: "real-signer" },
            parents: [{ sha: "p1" }],
            commit: {
              author: { email: "9101+real-signer@users.noreply.github.com" },
              verification: { verified: true, reason: "valid" },
            },
          },
        ],
        initialSignatures: {
          version: 1,
          signatures: [{ id: 9101, login: "real-signer" }],
        },
      });
      global.fetch = gh.fetch;

      const payload = {
        action: "created",
        issue: { number: 1, pull_request: {}, user: { login: "real-signer" } },
        comment: {
          user: { id: 9101, login: "real-signer" },
          body: "recheck",
          html_url: "x",
          author_association: "NONE",
        },
      };
      await handleHardened(payload);

      assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "success");
    } finally {
      if (originalRVC === undefined)
        delete process.env.REQUIRE_VERIFIED_COMMITS;
      else process.env.REQUIRE_VERIFIED_COMMITS = originalRVC;
      delete require.cache[require.resolve("../src/cla-bot.js")];
    }
  });

  await test("a Co-authored-by trailer cannot pair a real, already-signed account's id with a FAKE login to slip past isAllowlisted() - the authoritative login is always resolved from GitHub, not the trailer text", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 5501, login: "primary-author-3" },
          parents: [{ sha: "p1" }],
          commit: {
            author: { email: "primary3@example.com" },
            // The trailer CLAIMS this id belongs to "dependabot[bot]" (an
            // allowlisted name) but GitHub itself says id 424242 is actually
            // "real-human-helper", a completely different, un-allowlisted
            // account that has never signed.
            message:
              "Add feature\n\nCo-authored-by: Fake Bot Name <424242+dependabot[bot]@users.noreply.github.com>",
          },
        },
      ],
      initialSignatures: {
        version: 1,
        signatures: [{ id: 5501, login: "primary-author-3" }],
      },
      usersById: { 424242: { id: 424242, login: "real-human-helper" } },
    });
    global.fetch = gh.fetch;

    const payload = {
      action: "created",
      issue: {
        number: 1,
        pull_request: {},
        user: { login: "primary-author-3" },
      },
      comment: {
        user: { id: 5501, login: "primary-author-3" },
        body: "recheck",
        html_url: "x",
        author_association: "NONE",
      },
    };
    await handleIssueComment(payload);

    assert.strictEqual(
      gh.statuses[gh.statuses.length - 1].state,
      "failure",
      "the co-author must still need to sign - the trailer's fake bot-shaped login must not grant an allowlist bypass",
    );
    const lastComment = gh.comments[gh.comments.length - 1].body;
    assert.ok(
      lastComment.includes("@real-human-helper"),
      "the co-author must be named by their REAL, GitHub-resolved login, not the trailer's fabricated one",
    );
    assert.ok(
      !lastComment.includes("@dependabot[bot]"),
      "the fabricated login from the trailer text must never be surfaced or trusted",
    );
  });

  await test("a co-author with a non-noreply (real personal) email is flagged for manual review by commit SHA, without leaking the email publicly", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1deadbeef",
          author: { id: 5001, login: "primary-author" },
          parents: [{ sha: "p1" }],
          commit: {
            author: { email: "primary@example.com" },
            message:
              "Add feature\n\nCo-authored-by: Someone <someone@theircompany.com>",
          },
        },
      ],
      initialSignatures: {
        version: 1,
        signatures: [{ id: 5001, login: "primary-author" }],
      },
    });
    global.fetch = gh.fetch;

    const payload = {
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "primary-author" } },
      comment: {
        user: { id: 5001, login: "primary-author" },
        body: "recheck",
        html_url: "x",
        author_association: "NONE",
      },
    };
    await handleIssueComment(payload);

    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "failure");
    const lastComment = gh.comments[gh.comments.length - 1].body;
    assert.ok(
      !lastComment.includes("someone@theircompany.com"),
      "the co-author's personal email must NEVER be posted in a public PR comment",
    );
    assert.ok(
      lastComment.includes("c1deadb"), // short-sha form
      "the commit SHA must be surfaced instead, so a maintainer can find the commit",
    );
  });

  await test("a commit with more Co-authored-by trailers than the resolution cap makes only a bounded number of lookups and is flagged for manual review", async () => {
    const TOTAL_TRAILERS = 30; // deliberately > MAX_COAUTHOR_TRAILERS_PER_COMMIT (20)
    const usersById = {};
    let userByIdLookups = 0;
    for (let i = 0; i < TOTAL_TRAILERS; i++) {
      usersById[20000 + i] = { id: 20000 + i, login: `co-author-${i}` };
    }
    const trailers = Array.from(
      { length: TOTAL_TRAILERS },
      (_, i) =>
        `Co-authored-by: Person ${i} <${20000 + i}+co-author-${i}@users.noreply.github.com>`,
    ).join("\n");

    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 6001, login: "primary-author" },
          parents: [{ sha: "p1" }],
          commit: {
            author: { email: "primary@example.com" },
            message: `Add feature\n\n${trailers}`,
          },
        },
      ],
      initialSignatures: {
        version: 1,
        signatures: [{ id: 6001, login: "primary-author" }],
      },
      usersById,
    });
    const innerFetch = gh.fetch;
    global.fetch = async (url, opts) => {
      if (/\/user\/\d+(?:$|\?)/.test(url)) userByIdLookups += 1;
      return innerFetch(url, opts);
    };

    const payload = {
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "primary-author" } },
      comment: {
        user: { id: 6001, login: "primary-author" },
        body: "recheck",
        html_url: "x",
        author_association: "NONE",
      },
    };
    await handleIssueComment(payload);

    assert.ok(
      userByIdLookups <= 20,
      `expected at most 20 (the cap) /user/{id} lookups for one commit, got ${userByIdLookups} - an uncapped commit message can otherwise force unbounded outbound API calls`,
    );
    assert.strictEqual(
      gh.statuses[gh.statuses.length - 1].state,
      "failure",
      "a commit with more co-authors than the cap must fail closed (manual review), never silently pass",
    );
    const lastComment = gh.comments[gh.comments.length - 1].body;
    assert.ok(
      lastComment.includes("could not be automatically attributed"),
      "the overflow must surface as needing manual verification, not be silently dropped",
    );
  });

  await test("a random passer-by cannot trigger recheck on a PR that is not theirs", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 6001, login: "author" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "a@example.com" } },
        },
      ],
      initialSignatures: { version: 1, signatures: [] },
    });
    global.fetch = gh.fetch;

    const payload = {
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "author" } },
      comment: {
        user: { id: 7001, login: "random-passerby" },
        body: "recheck",
        html_url: "x",
        author_association: "NONE",
      },
    };
    await handleIssueComment(payload);

    assert.strictEqual(
      gh.statuses.length,
      0,
      "no status call should happen - recheck must be rejected before doing any work",
    );
    assert.strictEqual(gh.comments.length, 0);
  });

  await test("signing twice in a row for the same user only records one entry and does not spam the thread", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 8001, login: "alice" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "a@example.com" } },
        },
      ],
      initialSignatures: { version: 1, signatures: [] },
    });
    global.fetch = gh.fetch;

    const payload = {
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "alice" } },
      comment: {
        user: { id: 8001, login: "alice" },
        body: "I have read the CLA Document and I hereby sign the CLA",
        html_url: "x",
        author_association: "NONE",
      },
    };
    await handleIssueComment(payload); // first sign
    await handleIssueComment(payload); // repeat sign

    assert.strictEqual(
      gh.signatures.signatures.length,
      1,
      "must not create a duplicate signature entry",
    );
    // First call: 1 "all signed" comment. Second call: 1 "already signed" comment.
    assert.strictEqual(gh.comments.length, 2);
    assert.ok(gh.comments[1].body.includes("already signed"));
  });

  await test("a spoofed comment from a regular user cannot fool the dedupe check into suppressing the real bot comment", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 9101, login: "alice" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "a@example.com" } },
        },
      ],
      initialSignatures: {
        version: 1,
        signatures: [{ id: 9101, login: "alice" }],
      },
    });
    global.fetch = gh.fetch;

    // An attacker (not the bot) posts a comment containing the bot's marker
    // and the exact text the bot would say, hoping to trick the dedupe
    // check into thinking the bot already said it.
    gh.comments.push({
      id: 999,
      body: "<!-- fossasia-cla-bot:v1 -->\nAll contributors have signed the CLA. \u2705",
      user: { login: "a-regular-user" }, // NOT github-actions[bot]
    });

    const payload = {
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "alice" } },
      comment: {
        user: { id: 9101, login: "alice" },
        body: "recheck",
        html_url: "x",
        author_association: "NONE",
      },
    };
    await handleIssueComment(payload);

    // The real bot must still post its own comment - the spoofed one from a
    // non-bot user must not count as "already said this".
    const realBotComments = gh.comments.filter(
      (c) => c.user.login === "github-actions[bot]",
    );
    assert.strictEqual(
      realBotComments.length,
      1,
      "the real bot comment must still be posted despite the spoofed one",
    );
  });

  await test("two genuinely concurrent postComment() calls racing past the same pre-check both post, but self-healing leaves exactly one comment", async () => {
    // Forces an actual race via Promise.all(), not a sequential replay: both
    // calls' pre-check GETs are held open with a barrier until both have
    // arrived, guaranteeing they see the identical empty comment list
    // before either one posts - exactly the race the code cannot prevent
    // outright (see SECURITY.md). Only the pre-check GETs are held; the
    // later cleanup-step GETs (triggered by dedupeIdenticalTrailingComments
    // after each POST) proceed immediately, same as they would in
    // production once the initial race has already happened.
    const state = { comments: [] };
    let inFlightGets = 0;
    let releaseGets;
    const bothArrived = new Promise((resolve) => {
      releaseGets = resolve;
    });

    global.fetch = async (url, opts = {}) => {
      const method = (opts.method || "GET").toUpperCase();
      if (url.includes("/issues/1/comments")) {
        if (method === "GET") {
          inFlightGets += 1;
          if (inFlightGets >= 2) releaseGets();
          if (inFlightGets <= 2) await bothArrived; // only the two initial pre-checks block on each other
          return res(200, state.comments);
        }
        if (method === "POST") {
          const { body } = JSON.parse(opts.body);
          const comment = {
            id: state.comments.length + 1,
            body,
            user: { login: "github-actions[bot]" },
          };
          state.comments.push(comment);
          return res(201, comment);
        }
      }
      if (url.includes("/issues/comments/")) {
        if (method === "DELETE") {
          const id = Number(url.split("/issues/comments/")[1]);
          const before = state.comments.length;
          state.comments = state.comments.filter((c) => c.id !== id);
          return res(
            before === state.comments.length ? 404 : 204,
            before === state.comments.length ? { message: "Not Found" } : null,
          );
        }
      }
      // Anything else (e.g. GET /user for bot-identity resolution) is left
      // unhandled on purpose - resolveBotLogin() catches that failure and
      // falls back to the default identity, same as the standard GITHUB_TOKEN
      // setup in production.
      throw new Error(`Unhandled mock request in race test: ${method} ${url}`);
    };

    const { postComment } = require("../src/cla-bot.js");
    await Promise.all([
      postComment(1, "All contributors have signed the CLA. \u2705"),
      postComment(1, "All contributors have signed the CLA. \u2705"),
    ]);

    assert.strictEqual(
      state.comments.length,
      1,
      "self-healing must converge to exactly one surviving comment under a genuine concurrent race",
    );
  });

  await test("handleIssueComment throws a clear, specific error on a malformed payload (missing comment.user) instead of a raw TypeError", async () => {
    const malformedPayload = {
      action: "created",
      issue: { number: 1, pull_request: {} },
      comment: {
        // user missing entirely - simulates a corrupted event file or a
        // non-GitHub caller, not anything a real webhook ever sends.
        body: "I have read the CLA Document and I hereby sign the CLA",
      },
    };
    await assert.rejects(
      () => handleIssueComment(malformedPayload),
      (err) => {
        assert.ok(
          /comment\.user\.login/.test(err.message),
          `expected a specific error naming the missing field, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  await test("handleIssueComment does nothing (no throw) for a comment on a plain issue, not a PR", async () => {
    // payload.issue.pull_request absent - this is the normal, frequent case
    // (someone comments on a regular issue) and must remain a silent no-op.
    await handleIssueComment({
      action: "created",
      issue: { number: 1 },
      comment: { user: { id: 1, login: "someone" }, body: "hello" },
    });
    // no assertion needed beyond "it didn't throw"
  });

  await test("handlePullRequestTarget throws a clear, specific error on a malformed payload (missing pull_request)", async () => {
    await assert.rejects(
      () => handlePullRequestTarget({ action: "opened" }),
      (err) => {
        assert.ok(
          /pull_request/.test(err.message),
          `expected a specific error naming the missing field, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------
  // lockPR: direct coverage. Production code is deliberately best-effort
  // here (see lockPR's comment in src/cla-bot.js) - a failed lock call must
  // never fail the whole run, only warn. Neither the success path nor the
  // failure path had any dedicated coverage before.
  // ---------------------------------------------------------------------
  await test("lockPR locks the PR with lock_reason 'resolved'", async () => {
    const gh = makeFakeGitHub({
      commits: [],
      initialSignatures: { version: 1, signatures: [] },
    });
    global.fetch = gh.fetch;

    await lockPR(1);

    assert.strictEqual(
      gh.lockCalls.length,
      1,
      "expected exactly one lock call",
    );
    assert.strictEqual(gh.lockCalls[0].lock_reason, "resolved");
  });

  await test("lockPR is best-effort: an API failure is caught, logged as a warning, and does NOT throw or fail the run", async () => {
    const gh = makeFakeGitHub({
      commits: [],
      initialSignatures: { version: 1, signatures: [] },
      lockShouldFail: true,
    });
    global.fetch = gh.fetch;

    const originalWarn = console.warn;
    let warned = "";
    console.warn = (msg) => {
      warned = msg;
    };
    try {
      await assert.doesNotReject(
        () => lockPR(1),
        "lockPR must never throw, even when the underlying API call fails - locking is nice-to-have hardening, not core to CLA correctness",
      );
    } finally {
      console.warn = originalWarn;
    }
    assert.strictEqual(
      gh.lockCalls.length,
      1,
      "the lock attempt should still have been made before it failed",
    );
    assert.ok(
      warned.includes("Could not lock PR #1"),
      `expected a warning naming the PR, got: ${warned}`,
    );
  });

  // ---------------------------------------------------------------------
  // handlePullRequestTarget: direct dispatch coverage. Previously only the
  // malformed-payload guard was tested here - the real event-routing logic
  // (opened/synchronize/reopened -> checkPR, closed+merged -> lockPR,
  // everything else -> no-op) had no coverage at all.
  // ---------------------------------------------------------------------
  await test("handlePullRequestTarget locks the PR when a 'closed' event reports it was merged", async () => {
    const gh = makeFakeGitHub({
      commits: [],
      initialSignatures: { version: 1, signatures: [] },
    });
    global.fetch = gh.fetch;

    const payload = {
      action: "closed",
      pull_request: { number: 1, merged: true, head: { sha: "head-sha-x" } },
    };
    await handlePullRequestTarget(payload);

    assert.strictEqual(
      gh.lockCalls.length,
      1,
      "a merged, closed PR should be locked",
    );
    assert.strictEqual(
      gh.statuses.length,
      0,
      "locking a merged PR must not also trigger a CLA status check",
    );
  });

  await test("handlePullRequestTarget does nothing when a 'closed' event reports the PR was NOT merged", async () => {
    const gh = makeFakeGitHub({
      commits: [],
      initialSignatures: { version: 1, signatures: [] },
    });
    global.fetch = gh.fetch;

    const payload = {
      action: "closed",
      pull_request: { number: 1, merged: false, head: { sha: "head-sha-x" } },
    };
    await handlePullRequestTarget(payload);

    assert.strictEqual(
      gh.lockCalls.length,
      0,
      "a PR closed without merging must not be locked",
    );
    assert.strictEqual(gh.statuses.length, 0);
  });

  await test("handlePullRequestTarget does nothing for actions it doesn't care about (e.g. 'labeled')", async () => {
    const gh = makeFakeGitHub({
      commits: [],
      initialSignatures: { version: 1, signatures: [] },
    });
    global.fetch = gh.fetch;

    const payload = {
      action: "labeled",
      pull_request: { number: 1, merged: false, head: { sha: "x" } },
    };
    await handlePullRequestTarget(payload);

    assert.strictEqual(gh.lockCalls.length, 0);
    assert.strictEqual(gh.statuses.length, 0);
  });

  for (const action of ["opened", "synchronize", "reopened"]) {
    await test(`handlePullRequestTarget on '${action}' checks the PR using the sha already on the webhook payload, without an extra GET /pulls lookup`, async () => {
      const gh = makeFakeGitHub({
        commits: [
          {
            sha: "c1",
            author: { id: 1, login: "author" },
            parents: [{ sha: "p1" }],
            commit: { author: { email: "a@example.com" } },
          },
        ],
        initialSignatures: {
          version: 1,
          signatures: [{ id: 1, login: "author" }],
        },
      });
      // If checkPR() ever stopped using the sha already carried on the
      // payload and fell back to fetching the PR itself, this would throw -
      // that's the proof the payload's own head.sha is what actually got
      // used, not a redundant lookup.
      const innerFetch = gh.fetch;
      global.fetch = async (url, opts) => {
        if (url.includes("/pulls/1") && !url.includes("/commits")) {
          throw new Error(
            "must not call GET /pulls/1 when the head sha was already supplied on the webhook payload",
          );
        }
        return innerFetch(url, opts);
      };

      const payload = {
        action,
        pull_request: { number: 1, head: { sha: "webhook-head-sha" } },
      };
      await handlePullRequestTarget(payload);

      assert.strictEqual(gh.statuses.length, 1);
      assert.strictEqual(gh.statuses[0].state, "success");
      assert.strictEqual(
        gh.statuses[0].sha,
        "webhook-head-sha",
        "the status must be posted against the sha from the webhook payload",
      );
    });
  }

  await test("a commit whose primary author has no linked GitHub account (e.g. a privacy-enabled email) is flagged for manual review by SHA, not silently skipped", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "deadbee123456",
          author: null, // GitHub could not match the commit's git email to any account
          parents: [{ sha: "p1" }],
          commit: { author: { email: "private@example.com" } },
        },
      ],
      initialSignatures: { version: 1, signatures: [] },
    });
    global.fetch = gh.fetch;

    const payload = {
      action: "opened",
      pull_request: { number: 1, head: { sha: "head-sha" } },
    };
    await handlePullRequestTarget(payload);

    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "failure");
    const lastComment = gh.comments[gh.comments.length - 1].body;
    assert.ok(
      lastComment.includes("deadbee"), // short-sha form (first 7 chars)
      "the unresolved commit's SHA must be surfaced so a maintainer can find and inspect it",
    );
    assert.ok(
      lastComment.includes("could not be automatically attributed"),
      "an author GitHub can't resolve must be flagged for manual review, never silently dropped from consideration",
    );
    assert.ok(
      !lastComment.includes("private@example.com"),
      "the raw commit email must never be posted publicly",
    );
  });

  // ---------------------------------------------------------------------
  // Pagination: previously every mock had <100 items, so the "there might
  // be another page" continuation branch in listPRCommitAuthors() and
  // getExistingBotComments() never actually ran.
  // ---------------------------------------------------------------------
  await test("listPRCommitAuthors pages through more than 100 commits on a single PR", async () => {
    const commits = [];
    for (let i = 0; i < 150; i++) {
      commits.push({
        sha: `c${i}`,
        author: { id: 10000 + i, login: `author-${i}` },
        parents: [{ sha: "p" }],
        commit: { author: { email: `a${i}@example.com` } },
      });
    }
    const initialSignatures = {
      version: 1,
      // Everyone except the very last author (on page 2) has already signed.
      signatures: commits
        .slice(0, 149)
        .map((c) => ({ id: c.author.id, login: c.author.login })),
    };
    const gh = makeFakeGitHub({ commits, initialSignatures });
    global.fetch = gh.fetch;

    const payload = {
      action: "opened",
      pull_request: { number: 1, head: { sha: "head-sha" } },
    };
    await handlePullRequestTarget(payload);

    assert.strictEqual(
      gh.statuses[gh.statuses.length - 1].state,
      "failure",
      "the one unsigned author living on page 2 (commit #150) must still be found and required to sign",
    );
    const lastComment = gh.comments[gh.comments.length - 1].body;
    assert.ok(
      lastComment.includes("@author-149"),
      "the missing signer from the second page of commits must be named",
    );
  });

  await test("getExistingBotComments pages through more than 100 existing comments when checking for duplicates", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 1, login: "alice" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "a@example.com" } },
        },
      ],
      initialSignatures: {
        version: 1,
        signatures: [{ id: 1, login: "alice" }],
      },
    });
    // Pad the comment list past 100 with unrelated comments from other
    // users, then put the bot's most recent real comment last (on page 2).
    for (let i = 0; i < 120; i++) {
      gh.comments.push({
        id: i + 1,
        body: `unrelated comment #${i}`,
        user: { login: "some-other-user" },
      });
    }
    gh.comments.push({
      id: 121,
      // Deliberately built to match whatever the current code would freshly
      // compose for this exact case (BOT_MARKER + SUCCESS_MESSAGE, which
      // itself now embeds SUCCESS_MARKER - see its doc comment in
      // src/cla-bot.js) rather than a hardcoded literal, so this test keeps
      // validating what it's actually for (pagination reaching page 2's
      // dedupe match) instead of silently starting to test a DIFFERENT
      // thing (whether a preexisting comment in the OLD, pre-marker wording
      // still gets deduped) every time the exact success wording evolves.
      body: `<!-- fossasia-cla-bot:v1 -->\n<!-- fossasia-cla-bot:success -->\nAll contributors have signed the CLA. \u2705`,
      user: { login: "github-actions[bot]" },
    });
    global.fetch = gh.fetch;

    const payload = {
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "alice" } },
      comment: {
        user: { id: 1, login: "alice" },
        body: "recheck",
        html_url: "x",
        author_association: "NONE",
      },
    };
    await handleIssueComment(payload);

    // The identical "all signed" comment already exists on page 2 - the
    // dedupe check must find it there and skip posting a new one, proving
    // pagination actually walked past page 1's 100 unrelated comments.
    const botComments = gh.comments.filter(
      (c) => c.user.login === "github-actions[bot]",
    );
    assert.strictEqual(
      botComments.length,
      1,
      "the existing duplicate on page 2 should have been found, so no new comment should have been posted",
    );
  });

  // ---------------------------------------------------------------------
  // postComment's duplicate-cleanup step is explicitly best-effort (same
  // pattern as lockPR) - a failure there must not fail the run.
  // ---------------------------------------------------------------------
  await test("postComment's duplicate-cleanup failure is caught and logged as a warning, without failing the run", async () => {
    // The cleanup step (dedupeIdenticalTrailingComments) already catches
    // and warns on a per-comment DELETE failure internally (it's meant to
    // survive one duplicate being already gone). The failure mode that
    // actually reaches postComment's own try/catch is the cleanup's GET
    // call itself failing outright (e.g. retries exhausted) - so that's
    // what this simulates: the dedupe pre-check GET succeeds, the POST
    // succeeds, but the cleanup step's own re-fetch of comments fails
    // persistently.
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = (fn) => originalSetTimeout(fn, 0);
    let getCount = 0;
    try {
      global.fetch = async (url, opts = {}) => {
        const method = (opts.method || "GET").toUpperCase();
        if (url.includes("/issues/1/comments")) {
          if (method === "GET") {
            getCount += 1;
            if (getCount === 1) return res(200, []); // dedupe pre-check: nothing exists yet
            return res(500, { message: "Internal Server Error" }); // cleanup's re-fetch, always fails
          }
          if (method === "POST") {
            return res(201, {
              id: 1,
              body: JSON.parse(opts.body).body,
              user: { login: "github-actions[bot]" },
            });
          }
        }
        throw new Error(`unexpected call: ${method} ${url}`);
      };

      const originalWarn = console.warn;
      let warned = "";
      console.warn = (msg) => {
        warned = msg;
      };
      try {
        await assert.doesNotReject(
          () => postComment(1, "a brand new message, not a duplicate"),
          "a cleanup failure must not surface as a thrown error - the comment itself already succeeded",
        );
      } finally {
        console.warn = originalWarn;
      }
      assert.ok(
        warned.includes("Duplicate-comment cleanup failed"),
        `expected a specific warning about the cleanup failure, got: ${warned}`,
      );
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });

  // ---------------------------------------------------------------------
  // Co-author id/login resolution: the "can't resolve" and "cached" edges.
  // ---------------------------------------------------------------------
  await test("a co-author in noreply-email format whose id/login cannot be resolved (e.g. a deleted account) is flagged for manual review, not silently dropped", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "deadc0ffee",
          author: { id: 1, login: "primary-author" },
          parents: [{ sha: "p1" }],
          commit: {
            author: { email: "primary@example.com" },
            // Well-formed new-style noreply trailer, but usersById has no
            // entry for 999999 - GitHub itself can't resolve this id
            // (account deleted, or never existed).
            message:
              "Add feature\n\nCo-authored-by: Ghost <999999+ghost-login@users.noreply.github.com>",
          },
        },
      ],
      initialSignatures: {
        version: 1,
        signatures: [{ id: 1, login: "primary-author" }],
      },
      usersById: {}, // deliberately empty - 999999 does not resolve
    });
    global.fetch = gh.fetch;

    const payload = {
      action: "opened",
      pull_request: { number: 1, head: { sha: "head-sha" } },
    };
    await handlePullRequestTarget(payload);

    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "failure");
    const lastComment = gh.comments[gh.comments.length - 1].body;
    assert.ok(
      lastComment.includes("deadc0f"),
      "the commit must be flagged for manual review by SHA when its co-author can't be resolved",
    );
    assert.ok(
      !lastComment.includes("ghost-login"),
      "an unresolved trailer's claimed login must never be trusted or surfaced - it was never verified against GitHub",
    );
  });

  await test("resolving the same co-author id across two different commits in one PR only makes one /user/{id} lookup (result is cached)", async () => {
    const trailer =
      "Add feature\n\nCo-authored-by: Helper <55555+helper@users.noreply.github.com>";
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 1, login: "primary-author" },
          parents: [{ sha: "p1" }],
          commit: {
            author: { email: "primary@example.com" },
            message: trailer,
          },
        },
        {
          sha: "c2",
          author: { id: 1, login: "primary-author" },
          parents: [{ sha: "p1" }],
          commit: {
            author: { email: "primary@example.com" },
            message: trailer,
          },
        },
      ],
      initialSignatures: {
        version: 1,
        signatures: [
          { id: 1, login: "primary-author" },
          { id: 55555, login: "helper" },
        ],
      },
      usersById: { 55555: { id: 55555, login: "helper" } },
    });
    let lookupCount = 0;
    const innerFetch = gh.fetch;
    global.fetch = async (url, opts) => {
      if (/\/user\/\d+(?:$|\?)/.test(url)) lookupCount += 1;
      return innerFetch(url, opts);
    };

    const payload = {
      action: "opened",
      pull_request: { number: 1, head: { sha: "head-sha" } },
    };
    await handlePullRequestTarget(payload);

    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "success");
    assert.strictEqual(
      lookupCount,
      1,
      "the same co-author id appearing on two commits in one run should only be looked up once, not twice",
    );
  });

  // ---------------------------------------------------------------------
  // Grammar/edge cases in checkPR's output.
  // ---------------------------------------------------------------------
  await test("more than one unresolvable commit produces correctly pluralized wording in the PR comment ('commits' / 'them', not 'commit' / 'it')", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "aaaaaaa1111",
          author: null,
          parents: [{ sha: "p1" }],
          commit: { author: { email: "a@example.com" } },
        },
        {
          sha: "bbbbbbb2222",
          author: null,
          parents: [{ sha: "p1" }],
          commit: { author: { email: "b@example.com" } },
        },
      ],
      initialSignatures: { version: 1, signatures: [] },
    });
    global.fetch = gh.fetch;

    const payload = {
      action: "opened",
      pull_request: { number: 1, head: { sha: "head-sha" } },
    };
    await handlePullRequestTarget(payload);

    const lastComment = gh.comments[gh.comments.length - 1].body;
    assert.ok(
      lastComment.includes("2 commits could not be automatically attributed"),
      `expected plural "commits", got: ${lastComment}`,
    );
    assert.ok(
      lastComment.includes("verify them manually"),
      `expected plural "them", got: ${lastComment}`,
    );
  });

  await test("a sign-phrase comment event with no body field at all does not crash - it is simply treated as neither a sign nor a recheck", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 1, login: "alice" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "a@example.com" } },
        },
      ],
      initialSignatures: { version: 1, signatures: [] },
    });
    global.fetch = gh.fetch;

    const payload = {
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "alice" } },
      comment: {
        user: { id: 1, login: "alice" },
        // body intentionally omitted
        html_url: "x",
        author_association: "NONE",
      },
    };
    await assert.doesNotReject(() => handleIssueComment(payload));
    assert.strictEqual(
      gh.statuses.length,
      0,
      "a missing comment body must not be treated as a sign or a recheck",
    );
  });

  await test("a co-author in OLD-STYLE noreply-email format whose login cannot be resolved (e.g. a deleted/renamed account) is flagged for manual review, not silently dropped", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "cafef00d123",
          author: { id: 1, login: "primary-author" },
          parents: [{ sha: "p1" }],
          commit: {
            author: { email: "primary@example.com" },
            // Old-style noreply trailer (no id embedded) for a login that
            // GET /users/{login} does not know about.
            message:
              "Add feature\n\nCo-authored-by: Ghost <ghost-login@users.noreply.github.com>",
          },
        },
      ],
      initialSignatures: {
        version: 1,
        signatures: [{ id: 1, login: "primary-author" }],
      },
      users: {}, // deliberately empty - "ghost-login" does not resolve
    });
    global.fetch = gh.fetch;

    const payload = {
      action: "opened",
      pull_request: { number: 1, head: { sha: "head-sha" } },
    };
    await handlePullRequestTarget(payload);

    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "failure");
    const lastComment = gh.comments[gh.comments.length - 1].body;
    assert.ok(
      lastComment.includes("cafef00"),
      "the commit must be flagged for manual review by SHA when its old-style co-author login can't be resolved",
    );
  });

  await test("a co-author trailer repeated twice in the same commit message is counted once and only looked up once (cached within the commit)", async () => {
    let lookupCount = 0;
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 1, login: "primary-author" },
          parents: [{ sha: "p1" }],
          commit: {
            author: { email: "primary@example.com" },
            message:
              "Add feature\n\n" +
              "Co-authored-by: Helper <60000+helper@users.noreply.github.com>\n" +
              "Co-authored-by: Helper <60000+helper@users.noreply.github.com>",
          },
        },
      ],
      initialSignatures: {
        version: 1,
        signatures: [
          { id: 1, login: "primary-author" },
          { id: 60000, login: "helper" },
        ],
      },
      usersById: { 60000: { id: 60000, login: "helper" } },
    });
    const innerFetch = gh.fetch;
    global.fetch = async (url, opts) => {
      if (/\/user\/\d+(?:$|\?)/.test(url)) lookupCount += 1;
      return innerFetch(url, opts);
    };

    const payload = {
      action: "opened",
      pull_request: { number: 1, head: { sha: "head-sha" } },
    };
    await handlePullRequestTarget(payload);

    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "success");
    assert.strictEqual(
      lookupCount,
      1,
      "a co-author trailer duplicated within one commit message must only trigger one lookup",
    );
  });

  await test("the same OLD-STYLE noreply co-author login used across two different commits only makes one /users/{login} lookup (result is cached)", async () => {
    const trailer =
      "Add feature\n\nCo-authored-by: Helper <old-style-helper@users.noreply.github.com>";
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 1, login: "primary-author" },
          parents: [{ sha: "p1" }],
          commit: {
            author: { email: "primary@example.com" },
            message: trailer,
          },
        },
        {
          sha: "c2",
          author: { id: 1, login: "primary-author" },
          parents: [{ sha: "p1" }],
          commit: {
            author: { email: "primary@example.com" },
            message: trailer,
          },
        },
      ],
      initialSignatures: {
        version: 1,
        signatures: [
          { id: 1, login: "primary-author" },
          { id: 70000, login: "old-style-helper" },
        ],
      },
      users: {
        "old-style-helper": { id: 70000, login: "old-style-helper" },
      },
    });
    let lookupCount = 0;
    const innerFetch = gh.fetch;
    global.fetch = async (url, opts) => {
      if (url.includes("/users/old-style-helper")) lookupCount += 1;
      return innerFetch(url, opts);
    };

    const payload = {
      action: "opened",
      pull_request: { number: 1, head: { sha: "head-sha" } },
    };
    await handlePullRequestTarget(payload);

    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "success");
    assert.strictEqual(
      lookupCount,
      1,
      "the same old-style noreply login appearing on two commits should only be looked up once, not twice",
    );
  });

  await test("listPRCommitAuthors terminates by fetching one genuinely empty page when the total commit count is an exact multiple of 100 (doesn't hang or keep paging forever)", async () => {
    const commits = [];
    for (let i = 0; i < 200; i++) {
      commits.push({
        sha: `c${i}`,
        author: { id: 20000 + i, login: `author-${i}` },
        parents: [{ sha: "p" }],
        commit: { author: { email: `a${i}@example.com` } },
      });
    }
    // Everyone already signed - this test isolates pagination termination
    // itself (page request count/sequence), not signer detection, which is
    // already covered by the >100-commits test above.
    const initialSignatures = {
      version: 1,
      signatures: commits.map((c) => ({
        id: c.author.id,
        login: c.author.login,
      })),
    };
    const gh = makeFakeGitHub({ commits, initialSignatures });
    const innerFetch = gh.fetch;
    const pageRequests = [];
    global.fetch = async (url, opts) => {
      const m = url.match(/\/pulls\/1\/commits\?.*[&?]page=(\d+)/);
      if (m) {
        const pageNum = Number(m[1]);
        pageRequests.push(pageNum);
        // If the empty-page termination branch ever regresses, this turns
        // an infinite-loop hang into an immediate, clear test failure
        // instead of timing out the whole suite.
        if (pageNum > 3) {
          throw new Error(
            `pagination did not terminate - requested page ${pageNum}, expected it to stop right after the empty page 3`,
          );
        }
      }
      return innerFetch(url, opts);
    };

    const payload = {
      action: "opened",
      pull_request: { number: 1, head: { sha: "head-sha" } },
    };
    await handlePullRequestTarget(payload);

    assert.deepStrictEqual(
      pageRequests,
      [1, 2, 3],
      "expected exactly 3 page requests - two full 100-item pages, then one genuinely empty page to terminate - not more and not fewer",
    );
    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "success");
  });

  // =========================================================================
  // "Already signed" PRs must stay quiet: checkPR's quietIfNeverFlagged
  // behaviour (only used by the automatic pull_request_target trigger).
  //
  // Regression coverage for: a contributor who already signed the CLA (in
  // an earlier PR/repo) opens a brand new PR, and the bot's very first
  // comment on that PR is "All contributors have signed the CLA. ✅" - pure
  // noise, since nothing was ever required of anyone on this PR. See
  // https://github.com/rajnishtiwari7/cla-testing/pull/7 for a live example.
  // =========================================================================

  await test("opening a PR whose sole author already signed the CLA sets a success status but posts NO comment at all (nothing ever needed doing)", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 5001, login: "already-signed-author" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "a@example.com" } },
        },
      ],
      initialSignatures: {
        version: 1,
        signatures: [{ id: 5001, login: "already-signed-author" }],
      },
    });
    global.fetch = gh.fetch;

    const payload = {
      action: "opened",
      pull_request: { number: 1, head: { sha: "head-sha-abc" } },
    };
    await handlePullRequestTarget(payload);

    assert.strictEqual(
      gh.statuses.length,
      1,
      "the merge-gating status must still be set",
    );
    assert.strictEqual(gh.statuses[0].state, "success");
    assert.strictEqual(
      gh.comments.length,
      0,
      "a PR that was compliant from the very first check must get no comment - there is nothing to tell anyone",
    );
  });

  await test("a 'synchronize' push that only adds an author who ALSO already signed keeps a never-flagged PR silent", async () => {
    // Mutated in place between the two handlePullRequestTarget calls below
    // to simulate a new commit landing on the PR - makeFakeGitHub's mock
    // reads this same array live on every request, so pushing to it after
    // the first ("opened") check is what makes the second ("synchronize")
    // check see the new commit.
    const commits = [
      {
        sha: "c1",
        author: { id: 5101, login: "author-one" },
        parents: [{ sha: "p1" }],
        commit: { author: { email: "a@example.com" } },
      },
    ];
    const gh = makeFakeGitHub({
      commits,
      initialSignatures: {
        version: 1,
        signatures: [
          { id: 5101, login: "author-one" },
          { id: 5102, login: "author-two" },
        ],
      },
    });
    global.fetch = gh.fetch;

    // First check (PR opened with only author-one's commit) - still silent.
    await handlePullRequestTarget({
      action: "opened",
      pull_request: { number: 1, head: { sha: "sha-1" } },
    });
    assert.strictEqual(gh.comments.length, 0);

    // A new commit lands from author-two, who happens to already be signed
    // too - the requirement is to *ignore* them quietly, not announce
    // anything.
    commits.push({
      sha: "c2",
      author: { id: 5102, login: "author-two" },
      parents: [{ sha: "p1" }],
      commit: { author: { email: "b@example.com" } },
    });
    await handlePullRequestTarget({
      action: "synchronize",
      pull_request: { number: 1, head: { sha: "sha-2" } },
    });

    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "success");
    assert.strictEqual(
      gh.comments.length,
      0,
      "a newly-joined but already-signed committer must not trigger any comment",
    );
  });

  await test("a 'synchronize' push that adds a NEW, unsigned committer to a previously-silent PR still asks that person to sign", async () => {
    // Same mutate-in-place pattern as above - starts with only the
    // already-signed author's commit, then a second, unsigned committer's
    // commit is added before the 'synchronize' check.
    const commits = [
      {
        sha: "c1",
        author: { id: 5201, login: "already-signed" },
        parents: [{ sha: "p1" }],
        commit: { author: { email: "a@example.com" } },
      },
    ];
    const gh = makeFakeGitHub({
      commits,
      initialSignatures: {
        version: 1,
        signatures: [{ id: 5201, login: "already-signed" }],
      },
    });
    global.fetch = gh.fetch;

    // Opened with just the already-signed author - silent, as above.
    await handlePullRequestTarget({
      action: "opened",
      pull_request: { number: 1, head: { sha: "sha-1" } },
    });
    assert.strictEqual(gh.comments.length, 0);

    // A second, unsigned committer's commit is pushed.
    commits.push({
      sha: "c2",
      author: { id: 5202, login: "brand-new-contributor" },
      parents: [{ sha: "p1" }],
      commit: { author: { email: "b@example.com" } },
    });
    await handlePullRequestTarget({
      action: "synchronize",
      pull_request: { number: 1, head: { sha: "sha-2" } },
    });

    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "failure");
    assert.strictEqual(
      gh.comments.length,
      1,
      "the new, unsigned committer must still be asked to sign",
    );
    assert.ok(
      gh.comments[0].body.includes("@brand-new-contributor"),
      "the ask must name the newly-added unsigned committer",
    );
    assert.ok(
      !gh.comments[0].body.includes("@already-signed"),
      "the already-signed committer must not be listed as needing to sign",
    );
  });

  await test("once a PR that WAS flagged (bot already asked someone to sign) becomes fully signed, the success comment IS posted - this is a real transition worth announcing", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 5301, login: "late-signer" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "a@example.com" } },
        },
      ],
      initialSignatures: { version: 1, signatures: [] },
    });
    global.fetch = gh.fetch;

    // Opened while unsigned - the bot must ask.
    await handlePullRequestTarget({
      action: "opened",
      pull_request: { number: 1, head: { sha: "sha-1" } },
    });
    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "failure");
    assert.strictEqual(gh.comments.length, 1);

    // They sign via the issue_comment flow.
    await handleIssueComment({
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "late-signer" } },
      comment: {
        user: { id: 5301, login: "late-signer" },
        body: "I have read the CLA Document and I hereby sign the CLA",
        html_url: "x",
        author_association: "NONE",
      },
    });

    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "success");
    assert.strictEqual(
      gh.comments.length,
      2,
      "the transition from blocked to fully-signed must be announced",
    );
    assert.ok(
      gh.comments[gh.comments.length - 1].body.includes(
        "@late-signer Thank you for signing the CLA! We look forward to your contributions.",
      ),
      "the specific signer who completed the PR's requirement must be thanked by name, not shown the generic 'All contributors have signed' announcement",
    );

    // A later, redundant synchronize (no new commits, same head) that
    // re-confirms the already-announced success must not spam a duplicate.
    // This automatic trigger has no specific signer to address, so it would
    // fall back to the generic SUCCESS_MESSAGE if it posted anything at all
    // - but classifyBotComment() must still recognize the personalized
    // thank-you above as a "success" comment (via SUCCESS_MARKER) so this
    // stays quiet exactly as it would have with the old generic wording.
    await handlePullRequestTarget({
      action: "synchronize",
      pull_request: { number: 1, head: { sha: "sha-1" } },
    });
    assert.strictEqual(
      gh.comments.length,
      2,
      "an unchanged already-announced success must be deduped, not reposted",
    );
  });

  // -------------------------------------------------------------------------
  // Regression: "any bot comment exists" is NOT the same thing as "this PR
  // was previously blocked". A PR that was compliant from the very start can
  // still pick up a bot comment that has nothing to do with its own status -
  // e.g. the personal, non-blocking "you already signed the CLA, nothing
  // more to do here" reply someone gets for redundantly re-submitting the
  // sign phrase. That reply must not be mistaken for proof the PR itself was
  // ever blocked.
  // -------------------------------------------------------------------------
  await test("a redundant 'already signed' reply on an always-compliant PR does NOT make a later automatic check wrongly announce success", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 5601, login: "alice" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "a@example.com" } },
        },
      ],
      initialSignatures: {
        version: 1,
        signatures: [{ id: 5601, login: "alice" }],
      },
    });
    global.fetch = gh.fetch;

    // PR opens fully compliant - silent, as expected.
    await handlePullRequestTarget({
      action: "opened",
      pull_request: { number: 1, head: { sha: "sha-1" } },
    });
    assert.strictEqual(
      gh.comments.length,
      0,
      "sanity check: the PR must start out silent",
    );

    // Alice redundantly re-submits the sign phrase even though she's
    // already signed. This produces exactly one bot comment - the personal
    // "nothing more to do here" reply - but it says nothing about whether
    // THIS PR was ever blocked, since it isn't even routed through checkPR.
    await handleIssueComment({
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "alice" } },
      comment: {
        user: { id: 5601, login: "alice" },
        body: "I have read the CLA Document and I hereby sign the CLA",
        html_url: "x",
        author_association: "NONE",
      },
    });
    assert.strictEqual(gh.comments.length, 1);
    assert.ok(gh.comments[0].body.includes("already signed the CLA"));
    assert.ok(
      !gh.comments[0].body.includes("All contributors have signed"),
      "the personal reply must not itself be the success announcement",
    );

    // A later, ordinary synchronize while the PR is still fully compliant
    // must stay just as silent as it would have if the redundant reply had
    // never happened - the PR itself was never blocked.
    await handlePullRequestTarget({
      action: "synchronize",
      pull_request: { number: 1, head: { sha: "sha-2" } },
    });

    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "success");
    assert.strictEqual(
      gh.comments.length,
      1,
      "a non-blocking bot comment (the redundant 'already signed' reply) must not be mistaken for proof the PR was ever blocked - no new comment should appear",
    );
  });

  await test("a redundant 'already signed' reply interjecting after a genuinely-blocked PR resolves does NOT cause a later automatic check to re-announce success (nothing new happened since the last announcement)", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 5701, login: "bob" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "b@example.com" } },
        },
      ],
      initialSignatures: { version: 1, signatures: [] },
    });
    global.fetch = gh.fetch;

    // Opened unsigned - genuinely blocked, bot asks.
    await handlePullRequestTarget({
      action: "opened",
      pull_request: { number: 1, head: { sha: "sha-1" } },
    });
    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "failure");
    assert.strictEqual(gh.comments.length, 1);

    // Bob signs - transition announced.
    await handleIssueComment({
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "bob" } },
      comment: {
        user: { id: 5701, login: "bob" },
        body: "I have read the CLA Document and I hereby sign the CLA",
        html_url: "x",
        author_association: "NONE",
      },
    });
    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "success");
    assert.strictEqual(gh.comments.length, 2);
    const successCommentId = gh.comments[1].id;

    // Bob redundantly signs again - personal reply, third comment. This is
    // NOT a new block, so it must not reset the "already announced"
    // tracking.
    await handleIssueComment({
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "bob" } },
      comment: {
        user: { id: 5701, login: "bob" },
        body: "I have read the CLA Document and I hereby sign the CLA",
        html_url: "x",
        author_association: "NONE",
      },
    });
    assert.strictEqual(gh.comments.length, 3);
    assert.ok(gh.comments[2].body.includes("already signed the CLA"));

    // A later, ordinary synchronize while still fully compliant must stay
    // silent: the most recent "pending" comment (the very first ask) is
    // still older than the most recent "success" comment, so nothing new
    // has happened since success was last announced - the interjecting
    // personal reply must not trigger a fresh (duplicate-in-spirit)
    // announcement.
    await handlePullRequestTarget({
      action: "synchronize",
      pull_request: { number: 1, head: { sha: "sha-2" } },
    });

    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "success");
    assert.strictEqual(
      gh.comments.length,
      3,
      "no new comment should be posted - the PR's compliant state hasn't changed since success was already announced",
    );
    assert.strictEqual(
      gh.comments[1].id,
      successCommentId,
      "the original success comment must be untouched, not replaced by a fresh duplicate",
    );
  });

  await test("a redundant 'already signed' comment on a PR whose OWN status had gone stale (they signed via a DIFFERENT PR since) silently refreshes THIS PR's status to success", async () => {
    // Regression test for the exact real-world bug this fix addresses:
    // handleIssueComment's `alreadySigned` branch used to return immediately
    // after posting the personal reply, WITHOUT ever calling checkPR() - so
    // this PR's own merge-blocking status stayed stuck at whatever it was
    // last set to (here: "failure", from when carol genuinely hadn't signed
    // yet), even after she became fully compliant via signing on a
    // completely different PR in the meantime. See checkPR's `statusOnly`
    // option.
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 6001, login: "carol" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "carol@example.com" } },
        },
      ],
      initialSignatures: { version: 1, signatures: [] },
    });
    global.fetch = gh.fetch;

    // PR opens - carol hasn't signed yet, so it's genuinely blocked and the
    // status is set to "failure".
    await handlePullRequestTarget({
      action: "opened",
      pull_request: { number: 1, head: { sha: "sha-1" } },
    });
    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "failure");
    assert.strictEqual(gh.comments.length, 1);

    // Simulate her signing via a totally different PR in the meantime -
    // directly seed the (global) signature store, exactly as
    // writeSignatures() would have left it. Nothing re-runs checkPR for
    // THIS PR as a result - signing is global, but status checks are
    // per-PR and only get recomputed when something touches that PR.
    gh.signatures.signatures.push({ id: 6001, login: "carol" });

    // She now redundantly re-sends the sign phrase on THIS still-failing
    // PR too - plausible if she has several open PRs and isn't sure
    // whether "sign once, covers everywhere" really applies to this one.
    await handleIssueComment({
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "carol" } },
      comment: {
        user: { id: 6001, login: "carol" },
        body: "I have read the CLA Document and I hereby sign the CLA",
        html_url: "x",
        author_association: "NONE",
      },
    });

    // Exactly one new comment - the personal "already signed" reply, no
    // second comment piggybacking on it - but the status must now
    // correctly reflect that she (this PR's sole author) is fully signed.
    assert.strictEqual(gh.comments.length, 2);
    assert.ok(gh.comments[1].body.includes("already signed the CLA"));
    assert.strictEqual(
      gh.statuses[gh.statuses.length - 1].state,
      "success",
      "the redundant 'already signed' comment must still silently refresh this PR's own status - it had gone stale since she signed via a different PR",
    );
  });

  await test("a redundant 'already signed' comment on a PR that's STILL genuinely blocked by someone else refreshes the status (no-op here) without posting a second, spammy pending-list comment", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 6101, login: "dave" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "dave@example.com" } },
        },
        {
          sha: "c2",
          author: { id: 6102, login: "erin" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "erin@example.com" } },
        },
      ],
      // dave already signed (elsewhere); erin has not.
      initialSignatures: {
        version: 1,
        signatures: [{ id: 6101, login: "dave" }],
      },
    });
    global.fetch = gh.fetch;

    await handlePullRequestTarget({
      action: "opened",
      pull_request: { number: 1, head: { sha: "sha-1" } },
    });
    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "failure");
    assert.strictEqual(gh.comments.length, 1);

    // dave redundantly re-signs even though he's already covered - erin is
    // still the one actually blocking this PR, so nothing about the PR's
    // own state changes.
    await handleIssueComment({
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "dave" } },
      comment: {
        user: { id: 6101, login: "dave" },
        body: "I have read the CLA Document and I hereby sign the CLA",
        html_url: "x",
        author_association: "NONE",
      },
    });

    assert.strictEqual(
      gh.comments.length,
      2,
      "only the personal 'already signed' reply - no second, redundant pending-list comment repeating that erin still needs to sign",
    );
    assert.ok(gh.comments[1].body.includes("already signed the CLA"));
    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "failure");
  });

  await test("a genuine SECOND block-and-resolve cycle on the same PR is still correctly announced, even though an earlier resolution was already announced once", async () => {
    // Mutated in place to simulate a new, unsigned committer's commit
    // landing after the PR had already been fully resolved once.
    const commits = [
      {
        sha: "c1",
        author: { id: 5901, login: "carol" },
        parents: [{ sha: "p1" }],
        commit: { author: { email: "c@example.com" } },
      },
    ];
    const gh = makeFakeGitHub({
      commits,
      initialSignatures: { version: 1, signatures: [] },
    });
    global.fetch = gh.fetch;

    // First block-and-resolve cycle.
    await handlePullRequestTarget({
      action: "opened",
      pull_request: { number: 1, head: { sha: "sha-1" } },
    });
    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "failure");
    await handleIssueComment({
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "carol" } },
      comment: {
        user: { id: 5901, login: "carol" },
        body: "I have read the CLA Document and I hereby sign the CLA",
        html_url: "x",
        author_association: "NONE",
      },
    });
    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "success");
    assert.strictEqual(gh.comments.length, 2);

    // A second, new, unsigned committer's commit lands - a genuinely new
    // block.
    commits.push({
      sha: "c2",
      author: { id: 5902, login: "dave" },
      parents: [{ sha: "p1" }],
      commit: { author: { email: "d@example.com" } },
    });
    await handlePullRequestTarget({
      action: "synchronize",
      pull_request: { number: 1, head: { sha: "sha-2" } },
    });
    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "failure");
    assert.strictEqual(gh.comments.length, 3);
    assert.ok(gh.comments[2].body.includes("@dave"));

    // Dave signs too - a second, genuinely new recovery. This MUST be
    // announced, even though success was already announced once before.
    await handleIssueComment({
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "dave" } },
      comment: {
        user: { id: 5902, login: "dave" },
        body: "I have read the CLA Document and I hereby sign the CLA",
        html_url: "x",
        author_association: "NONE",
      },
    });

    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "success");
    // Count goes to 4, not 3: unlike the old generic SUCCESS_MESSAGE (which
    // was byte-for-byte identical every time, so postComment()'s self-
    // healing dedupe collapsed successive copies down to one), each
    // announcement here is personalized to the signer who completed the
    // requirement that time around - carol's "@carol Thank you..." and
    // dave's "@dave Thank you..." are different bodies, so both stand as
    // their own distinct, genuine announcements instead of one being
    // mistaken for a stale duplicate of the other.
    assert.strictEqual(
      gh.comments.length,
      4,
      "a second, genuine block-and-resolve cycle must still be announced, even though an earlier resolution was already announced once for this same PR",
    );
    assert.ok(
      gh.comments[gh.comments.length - 1].body.includes(
        "@dave Thank you for signing the CLA! We look forward to your contributions.",
      ),
      "the second recovery must thank the specific person (dave) who completed it this time",
    );
    assert.ok(
      gh.comments[1].body.includes(
        "@carol Thank you for signing the CLA! We look forward to your contributions.",
      ),
      "the first recovery's personalized announcement (carol's) must remain untouched by the second one",
    );
  });

  await test("a PR blocked only by an unresolved (needs-manual-review) commit is also correctly tracked as 'genuinely blocked' - once superseded by a resolvable commit, success is announced", async () => {
    // Mutated in place between checks, same pattern as the earlier
    // mutate-in-place tests - simulates a force-push/rebase that replaces
    // the unresolved commit with one GitHub can attribute normally.
    const commits = [
      {
        sha: "unresolved-sha",
        author: null, // GitHub could not match this commit's email to any account
        parents: [{ sha: "p1" }],
        commit: { author: { email: "private@example.com" } },
      },
    ];
    const gh = makeFakeGitHub({
      commits,
      initialSignatures: { version: 1, signatures: [] },
    });
    global.fetch = gh.fetch;

    await handlePullRequestTarget({
      action: "opened",
      pull_request: { number: 1, head: { sha: "sha-1" } },
    });
    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "failure");
    assert.strictEqual(gh.comments.length, 1);
    assert.ok(gh.comments[0].body.includes("could not be automatically"));

    // Rebase: the unresolved commit is replaced by one from a signed,
    // resolvable author.
    commits.length = 0;
    commits.push({
      sha: "resolved-sha",
      author: { id: 5801, login: "resolved-author" },
      parents: [{ sha: "p1" }],
      commit: { author: { email: "r@example.com" } },
    });
    gh.signatures.signatures.push({ id: 5801, login: "resolved-author" });

    await handlePullRequestTarget({
      action: "synchronize",
      pull_request: { number: 1, head: { sha: "sha-2" } },
    });

    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "success");
    assert.strictEqual(
      gh.comments.length,
      2,
      "a PR that was blocked purely by a manual-review flag is still a genuinely-blocked PR, so its resolution must be announced too",
    );
    assert.ok(gh.comments[1].body.includes("All contributors have signed"));
  });

  // -------------------------------------------------------------------------
  // Migration/backward-compatibility: a PR that was blocked under an OLDER
  // deployment of this bot - one that predates PENDING_MARKER and simply
  // wrote the same "need to sign our CLA" / "could not be automatically
  // attributed" wording without any invisible marker - must still be
  // recognized as having been genuinely blocked once this fix is deployed.
  // Without this, upgrading the bot mid-flight on an already-open,
  // already-blocked PR would silently swallow that PR's eventual recovery
  // announcement, because its one and only "ask" comment predates the
  // marker.
  // -------------------------------------------------------------------------
  await test("a PR blocked by an OLDER deployment of the bot (a 'needs to sign' comment with no PENDING_MARKER at all) is still recognized as having been blocked, so its resolution is announced after an upgrade", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 6001, login: "erin" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "e@example.com" } },
        },
      ],
      initialSignatures: {
        version: 1,
        signatures: [{ id: 6001, login: "erin" }],
      },
    });
    global.fetch = gh.fetch;

    // Seed a comment exactly as the OLD (pre-PENDING_MARKER) code would
    // have written it - same wording, only missing the new marker line -
    // to simulate a PR that was already blocked before this fix shipped.
    gh.comments.push({
      id: 1,
      body:
        "<!-- fossasia-cla-bot:v1 -->\n" +
        "The following contributor(s) need to sign our [CLA](https://example.com/CLA.md) before this PR can be merged:\n\n" +
        "- @erin\n\n" +
        "Please comment on this PR with **exactly** the following text to sign:\n\n" +
        "> I have read the CLA Document and I hereby sign the CLA\n\n" +
        "Signing once covers **all** FOSSASIA repositories - you will not be asked again.",
      user: { login: "github-actions[bot]" },
    });

    // Erin has since signed (the signature store already reflects that),
    // and the bot has just been upgraded to this fixed version. The next
    // automatic check must recognize the pre-existing comment as a genuine
    // past block and announce the recovery, not silently swallow it.
    await handlePullRequestTarget({
      action: "synchronize",
      pull_request: { number: 1, head: { sha: "sha-2" } },
    });

    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "success");
    assert.strictEqual(
      gh.comments.length,
      2,
      "a PR blocked under the old, marker-less code must still get its resolution announced after upgrading",
    );
    assert.ok(gh.comments[1].body.includes("All contributors have signed"));
  });

  await test("an explicit 'recheck' request always answers, even when the PR was compliant from the start and the bot never said anything before", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 5401, login: "pr-author" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "a@example.com" } },
        },
      ],
      initialSignatures: {
        version: 1,
        signatures: [{ id: 5401, login: "pr-author" }],
      },
    });
    global.fetch = gh.fetch;

    // PR opened silently, as expected.
    await handlePullRequestTarget({
      action: "opened",
      pull_request: { number: 1, head: { sha: "sha-1" } },
    });
    assert.strictEqual(gh.comments.length, 0);

    // The PR author explicitly asks for a recheck - a direct question
    // deserves a direct answer, unlike the automatic webhook trigger.
    await handleIssueComment({
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "pr-author" } },
      comment: {
        user: { id: 5401, login: "pr-author" },
        body: "recheck",
        html_url: "x",
        author_association: "NONE",
      },
    });

    assert.strictEqual(
      gh.comments.length,
      1,
      "an explicit human recheck must get a real answer even with no prior bot comment",
    );
    assert.ok(gh.comments[0].body.includes("All contributors have signed"));
  });

  await test("a PR that was already fully signed keeps producing NO comment across repeated 'synchronize' events (no accumulating noise)", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 5501, login: "clean-author" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "a@example.com" } },
        },
      ],
      initialSignatures: {
        version: 1,
        signatures: [{ id: 5501, login: "clean-author" }],
      },
    });
    global.fetch = gh.fetch;

    for (const [action, sha] of [
      ["opened", "s1"],
      ["synchronize", "s2"],
      ["synchronize", "s3"],
    ]) {
      await handlePullRequestTarget({
        action,
        pull_request: { number: 1, head: { sha } },
      });
    }

    assert.strictEqual(gh.statuses.length, 3);
    assert.ok(gh.statuses.every((s) => s.state === "success"));
    assert.strictEqual(
      gh.comments.length,
      0,
      "repeated pushes to an always-compliant PR must never produce a comment",
    );
  });

  // =========================================================================
  // Input-validation hardening: PR/issue numbers and commit SHAs pulled out
  // of the webhook payload (itself read from a file, GITHUB_EVENT_PATH) must
  // never reach an outbound GitHub API URL unvalidated - see
  // assertValidPRNumber()/assertValidSha() in src/cla-bot.js, called from
  // handleIssueComment, handlePullRequestTarget, checkPR, postComment, and
  // lockPR. Every test below stubs fetch to THROW on any call at all, so a
  // pass proves not just "an error was thrown" but that it was thrown
  // strictly before any network request was attempted - the exact property
  // that closes the CodeQL js/file-access-to-http finding.
  // =========================================================================

  const INVALID_PR_NUMBERS = [
    { label: "zero", value: 0 },
    { label: "a negative number", value: -1 },
    { label: "a non-integer float", value: 1.5 },
    { label: "NaN", value: NaN },
    { label: "Infinity", value: Infinity },
    { label: "a numeric string", value: "1" },
    { label: "null", value: null },
    { label: "undefined", value: undefined },
    { label: "an array", value: [1] },
    // An "integer" too large to be a safe integer: Number.isInteger()
    // alone accepts this (every double past 2^53 has no fractional part),
    // but it can't reliably represent a real PR number - see the
    // dedicated Number.isSafeInteger() unit tests in test/logic.test.js
    // for the full boundary sweep; this one entry keeps that same class
    // of value covered end-to-end through the actual webhook handlers too.
    {
      label: "an unsafe integer (Number.MAX_SAFE_INTEGER + 1)",
      value: Number.MAX_SAFE_INTEGER + 1,
    },
    // The concrete shape of the reported vulnerability: if this ever
    // reached the request path unvalidated, it could redirect an
    // authenticated GitHub API call at a completely different repo.
    {
      label: "a path-traversal string",
      value: "1/../../../repos/other-org/other-repo",
    },
  ];

  for (const { label, value } of INVALID_PR_NUMBERS) {
    await test(`handleIssueComment rejects an issue.number that is ${label}, before making any network request`, async () => {
      global.fetch = fetchThatMustNotBeCalled;
      await assert.rejects(
        () =>
          handleIssueComment({
            action: "created",
            issue: {
              number: value,
              pull_request: {},
              user: { login: "alice" },
            },
            comment: {
              user: { id: 1, login: "alice" },
              body: "I have read the CLA Document and I hereby sign the CLA",
            },
          }),
        (err) => {
          assert.ok(
            /expected a positive integer/.test(err.message),
            `expected a specific validation error, got: ${err.message}`,
          );
          return true;
        },
      );
    });
  }

  for (const { label, value } of INVALID_PR_NUMBERS) {
    await test(`handlePullRequestTarget rejects a pull_request.number that is ${label} on a 'closed'+merged event, before calling lockPR`, async () => {
      global.fetch = fetchThatMustNotBeCalled;
      await assert.rejects(
        () =>
          handlePullRequestTarget({
            action: "closed",
            pull_request: {
              number: value,
              merged: true,
              head: { sha: "head-sha" },
            },
          }),
        (err) => {
          assert.ok(
            /expected a positive integer/.test(err.message),
            `expected a specific validation error, got: ${err.message}`,
          );
          return true;
        },
      );
    });
  }

  for (const { label, value } of INVALID_PR_NUMBERS) {
    await test(`handlePullRequestTarget rejects a pull_request.number that is ${label} on 'opened', before calling checkPR`, async () => {
      global.fetch = fetchThatMustNotBeCalled;
      await assert.rejects(
        () =>
          handlePullRequestTarget({
            action: "opened",
            pull_request: { number: value, head: { sha: "head-sha" } },
          }),
        (err) => {
          assert.ok(
            /expected a positive integer/.test(err.message),
            `expected a specific validation error, got: ${err.message}`,
          );
          return true;
        },
      );
    });
  }

  const INVALID_SHAS = [
    { label: "a slash", value: "abc/def" },
    { label: "a backslash", value: "abc\\def" },
    {
      label: "a path-traversal sequence",
      value: "abc/../../../repos/other-org/other-repo/statuses/x",
    },
    { label: "a query string separator", value: "abc?x=1" },
    { label: "a fragment separator", value: "abc#frag" },
    { label: "embedded whitespace", value: "abc def" },
    { label: "an embedded newline", value: "abc\ndef" },
    { label: "a percent-encoded traversal sequence", value: "%2e%2e%2f" },
    { label: "a percent-encoded slash", value: "abc%2fdef" },
    { label: "an empty string", value: "" },
    {
      label: "a 65-character string (over the length cap)",
      value: "a".repeat(65),
    },
    { label: "a number instead of a string", value: 12345 },
  ];

  for (const { label, value } of INVALID_SHAS) {
    await test(`handlePullRequestTarget rejects a pull_request.head.sha that is ${label} on 'opened', before calling checkPR`, async () => {
      global.fetch = fetchThatMustNotBeCalled;
      await assert.rejects(
        () =>
          handlePullRequestTarget({
            action: "opened",
            pull_request: { number: 1, head: { sha: value } },
          }),
        (err) => {
          assert.ok(
            /expected a valid commit SHA/.test(err.message),
            `expected a specific validation error, got: ${err.message}`,
          );
          return true;
        },
      );
    });
  }

  await test("handlePullRequestTarget throws a clear, specific error (not a raw TypeError) when pull_request.head is missing entirely on 'opened'", async () => {
    global.fetch = fetchThatMustNotBeCalled;
    await assert.rejects(
      () =>
        handlePullRequestTarget({
          action: "opened",
          pull_request: { number: 1 }, // no `head` at all
        }),
      (err) => {
        assert.ok(
          /expected a valid commit SHA/.test(err.message),
          `expected the sha validator's own error, not a raw TypeError, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  await test("checkPR rejects an invalid prNumber argument directly, before making any network request", async () => {
    global.fetch = fetchThatMustNotBeCalled;
    await assert.rejects(
      () => checkPR("1; DROP TABLE prs", "head-sha"),
      (err) => {
        assert.ok(
          /expected a positive integer/.test(err.message),
          `expected a specific validation error, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  await test("checkPR rejects an invalid headSha argument directly, before making any network request", async () => {
    global.fetch = fetchThatMustNotBeCalled;
    await assert.rejects(
      () => checkPR(1, "abc/../../secrets"),
      (err) => {
        assert.ok(
          /expected a valid commit SHA/.test(err.message),
          `expected a specific validation error, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  await test("checkPR validates the sha it fetches itself from GET /pulls/{n} (defense-in-depth for API-sourced data, not just the webhook file) and stops before posting any status or comment", async () => {
    const gh = makeFakeGitHub({
      commits: [],
      initialSignatures: { version: 1, signatures: [] },
    });
    const innerFetch = gh.fetch;
    global.fetch = async (url, opts) => {
      if (url.includes("/pulls/1") && !url.includes("/commits")) {
        // Simulate a GitHub API response carrying a malformed head.sha -
        // checkPR() must not trust this any more than it trusts the file.
        return res(200, { head: { sha: "bad/sha?with=unsafe#chars" } });
      }
      return innerFetch(url, opts);
    };

    // Called with no headSha, forcing checkPR to fetch (and then validate)
    // the PR itself.
    await assert.rejects(
      () => checkPR(1),
      (err) => {
        assert.ok(
          /expected a valid commit SHA/.test(err.message),
          `expected a specific validation error, got: ${err.message}`,
        );
        return true;
      },
    );

    assert.strictEqual(
      gh.statuses.length,
      0,
      "no status should ever be posted once the fetched sha fails validation",
    );
    assert.strictEqual(
      gh.comments.length,
      0,
      "no comment should ever be posted once the fetched sha fails validation",
    );
  });

  for (const { label, value } of INVALID_PR_NUMBERS) {
    await test(`postComment rejects a prNumber that is ${label}, before making any network request`, async () => {
      global.fetch = fetchThatMustNotBeCalled;
      await assert.rejects(
        () => postComment(value, "hello"),
        (err) => {
          assert.ok(
            /expected a positive integer/.test(err.message),
            `expected a specific validation error, got: ${err.message}`,
          );
          return true;
        },
      );
    });
  }

  await test("lockPR is best-effort even for an invalid prNumber: it does NOT throw, makes no network request, and logs a warning instead", async () => {
    global.fetch = fetchThatMustNotBeCalled;
    const originalWarn = console.warn;
    let warned = "";
    console.warn = (msg) => {
      warned = msg;
    };
    try {
      await assert.doesNotReject(
        () => lockPR("1/../../repos/other-org/other-repo"),
        "lockPR must never throw, even when its own input fails validation - see its best-effort contract",
      );
    } finally {
      console.warn = originalWarn;
    }
    assert.ok(
      /expected a positive integer/.test(warned),
      `expected the warning to include the validation error, got: ${warned}`,
    );
  });

  // ---------------------------------------------------------------------
  // Positive control: the validators above must not reject genuinely valid
  // input. Without this, an over-eager regex could silently break real
  // traffic while every negative test above kept passing.
  // ---------------------------------------------------------------------
  await test("a large, ordinary positive integer PR number and a real-shaped 40-char hex sha both pass validation and flow through end-to-end", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 1, login: "author" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "a@example.com" } },
        },
      ],
      initialSignatures: {
        version: 1,
        signatures: [{ id: 1, login: "author" }],
      },
    });
    // makeFakeGitHub()'s router is hardcoded to PR #1's endpoints, so give
    // it a matching real-shaped sha rather than reusing PR #1's number
    // (already covered extensively elsewhere) - this test's job is purely
    // to prove a legitimate 40-char lowercase-hex sha is accepted.
    const realSha = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4";
    const innerFetch = gh.fetch;
    global.fetch = async (url, opts) => {
      if (url.includes("/statuses/")) {
        assert.strictEqual(
          url.split("/statuses/")[1],
          realSha,
          "the real 40-char hex sha must reach the status endpoint unmodified",
        );
      }
      return innerFetch(url, opts);
    };

    const payload = {
      action: "opened",
      pull_request: { number: 1, head: { sha: realSha } },
    };
    await assert.doesNotReject(() => handlePullRequestTarget(payload));

    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "success");
  });

  // ---------------------------------------------------------------------
  // encodeURIComponent() at the point of URL construction (see ghRaw()'s
  // callers): assertValidSha's blocklist rejects structurally dangerous
  // characters (/, .., ?, #, %, whitespace) but, by design, doesn't
  // enforce hex-only content - so a sha containing e.g. "&" legitimately
  // passes validation. Unencoded, that "&" would be able to inject or
  // override query parameters on any request built from it. This test
  // proves percent-encoding is genuinely applied at the sink (not just
  // present in the source and inert), by checking the literal bytes that
  // reach fetch().
  // ---------------------------------------------------------------------
  await test("checkPR percent-encodes a validator-legal but URL-significant sha (containing '&') before it ever reaches fetch(), so it can't inject or override a query parameter", async () => {
    const gh = makeFakeGitHub({
      commits: [],
      initialSignatures: { version: 1, signatures: [] },
    });
    const trickySha = "abc&page=999&per_page=1";
    assert.doesNotThrow(
      () => assertValidSha(trickySha, "sanity check"),
      "this test only proves something if the tricky value is legal input to begin with",
    );

    let observedRawUrl = null;
    const innerFetch = gh.fetch;
    global.fetch = async (url, opts) => {
      if (url.includes("/statuses/")) observedRawUrl = url;
      return innerFetch(url, opts);
    };

    const payload = {
      action: "opened",
      pull_request: { number: 1, head: { sha: trickySha } },
    };
    await assert.doesNotReject(() => handlePullRequestTarget(payload));

    assert.ok(observedRawUrl, "expected a status request to have been made");
    assert.strictEqual(
      observedRawUrl.split("/statuses/")[1],
      encodeURIComponent(trickySha),
      "the sha must reach fetch() percent-encoded, not as raw, URL-significant characters",
    );
    assert.strictEqual(
      gh.statuses[gh.statuses.length - 1].sha,
      encodeURIComponent(trickySha),
    );
  });

  // =========================================================================
  // Per-signer personalized thank-you comments (replaces the old, anonymous
  // "All contributors have signed the CLA. ✅" announcement whenever we
  // know exactly who just signed via a comment - see checkPR's `signer`
  // option and personalSuccessMessage() in src/cla-bot.js).
  // =========================================================================
  await test("on a PR with 3 contributors, each one signing via a comment gets their OWN personalized thank-you - not the generic 'All contributors have signed' announcement", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 7001, login: "alice" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "alice@example.com" } },
        },
        {
          sha: "c2",
          author: { id: 7002, login: "bob" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "bob@example.com" } },
        },
        {
          sha: "c3",
          author: { id: 7003, login: "carol" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "carol@example.com" } },
        },
      ],
      initialSignatures: { version: 1, signatures: [] },
    });
    global.fetch = gh.fetch;

    const signAs = (id, login) => ({
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "alice" } },
      comment: {
        user: { id, login },
        body: "I have read the CLA Document and I hereby sign the CLA",
        html_url: `https://github.com/fossasia/testrepo/pull/1#issuecomment-${id}`,
        author_association: "NONE",
      },
    });

    // Alice signs first. Two others (bob, carol) still haven't - the PR
    // stays blocked. Alice still gets personally thanked right away for the
    // action she just took - as its OWN comment now, separate from the
    // "who's still missing" list comment that follows it.
    await handleIssueComment(signAs(7001, "alice"));
    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "failure");
    assert.strictEqual(
      gh.comments.length,
      2,
      "two comments: the personal thank-you, then the still-pending list, as separate comments",
    );
    assert.ok(
      gh.comments[0].body.includes(
        "@alice Thank you for signing the CLA! We look forward to your contributions.",
      ),
      "alice must be thanked by name immediately for her own sign action",
    );
    assert.ok(
      !gh.comments[0].body.includes("need to sign"),
      "the personal thank-you must be its own comment, not merged with the pending list",
    );
    assert.ok(
      gh.comments[1].body.includes("@bob") &&
        gh.comments[1].body.includes("@carol"),
      "bob and carol must still be listed as needing to sign, in the separate pending-list comment",
    );
    assert.ok(
      !gh.comments[1].body.includes("Thank you for signing"),
      "the pending-list comment must not also contain the personal thank-you",
    );
    assert.ok(
      !gh.comments[1].body.includes("All contributors have signed"),
      "the PR isn't fully signed yet, so the completion announcement must not appear",
    );

    // Bob signs next. Still blocked (carol hasn't signed), so bob gets his
    // own personal thank-you (comment 3) and a fresh pending-list comment
    // (comment 4) naming only carol.
    await handleIssueComment(signAs(7002, "bob"));
    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "failure");
    assert.strictEqual(gh.comments.length, 4);
    assert.ok(
      gh.comments[2].body.includes(
        "@bob Thank you for signing the CLA! We look forward to your contributions.",
      ),
    );
    assert.ok(gh.comments[3].body.includes("@carol"));
    assert.ok(!gh.comments[2].body.includes("@bob you have already"));
    assert.ok(
      !gh.comments[3].body.includes("@alice") &&
        !gh.comments[3].body.includes("@bob"),
      "alice and bob already signed and must not reappear in the still-missing list",
    );

    // Carol signs last, completing the PR. She gets her OWN personalized
    // thank-you in place of the old generic "All contributors have signed"
    // announcement - exactly the behaviour this fix is for. This is the
    // SUCCESS case, so it's still just ONE comment (the personalized
    // completion message already serves as her thank-you - no need for a
    // separate one).
    await handleIssueComment(signAs(7003, "carol"));
    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "success");
    assert.strictEqual(gh.comments.length, 5);
    assert.ok(
      gh.comments[4].body.includes(
        "@carol Thank you for signing the CLA! We look forward to your contributions.",
      ),
      "carol, who completed the PR's requirement, must be thanked by name",
    );
    assert.ok(
      !gh.comments[4].body.includes("All contributors have signed"),
      "the generic, anonymous announcement must not be used when we know exactly who completed it",
    );

    assert.strictEqual(gh.signatures.signatures.length, 3);
  });

  await test("a signer's personalized completion comment is still correctly recognized as 'success' history, so a later automatic recheck with no specific signer stays quiet", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 7101, login: "dana" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "dana@example.com" } },
        },
      ],
      initialSignatures: { version: 1, signatures: [] },
    });
    global.fetch = gh.fetch;

    // Opened unsigned - the bot asks.
    await handlePullRequestTarget({
      action: "opened",
      pull_request: { number: 1, head: { sha: "sha-1" } },
    });
    assert.strictEqual(gh.comments.length, 1);

    // Dana signs - completes the PR, gets a personalized thank-you instead
    // of the generic announcement.
    await handleIssueComment({
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "dana" } },
      comment: {
        user: { id: 7101, login: "dana" },
        body: "I have read the CLA Document and I hereby sign the CLA",
        html_url: "x",
        author_association: "NONE",
      },
    });
    assert.strictEqual(gh.comments.length, 2);
    assert.ok(
      gh.comments[1].body.includes("@dana Thank you for signing the CLA"),
    );

    // An unrelated later push (no new commits, same head) triggers the
    // automatic, quiet-by-default pull_request_target check again - this
    // has no specific signer to address, so if it posted anything at all it
    // would fall back to the generic SUCCESS_MESSAGE. It must recognize
    // dana's personalized thank-you (via SUCCESS_MARKER) as the PR's
    // already-announced success and stay silent instead of posting a
    // second, generic "All contributors have signed" comment on top of it.
    await handlePullRequestTarget({
      action: "synchronize",
      pull_request: { number: 1, head: { sha: "sha-1" } },
    });
    assert.strictEqual(
      gh.comments.length,
      2,
      "no extra comment should appear - the personalized thank-you already counts as the success announcement",
    );
  });

  await test("checkPR merges its own just-written signature data (knownSignatures) into a stale post-write GET, instead of trusting that GET alone", async () => {
    // Regression test for a real production bug: GitHub's Contents API does
    // NOT guarantee that a GET immediately following a PUT reflects that
    // write (a documented characteristic of that API, not a bug on
    // GitHub's part) - so a naive "write, then immediately re-GET to
    // recompute status" flow can occasionally read back the PRE-write
    // content. This test simulates exactly that: the signatures GET
    // endpoint is rigged to return STALE (pre-signing) content for every
    // call that happens AFTER the PUT - if checkPR trusted that fresh GET
    // alone instead of merging in the `knownSignatures` writeSignatures()
    // already handed it (see mergeSignatures()), the contributor who just
    // signed would still show up in their own "still needs to sign" list.
    let putHappened = false;
    let getCallsAfterPut = 0;
    const preWriteSignatures = { version: 1, signatures: [] };
    let sigSha = "sig-sha-0";

    const commits = [
      {
        sha: "c1",
        author: { id: 9001, login: "alice" },
        parents: [{ sha: "p1" }],
        commit: { author: { email: "alice@example.com" } },
      },
    ];
    const comments = [];

    function res(status, jsonBody) {
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => (jsonBody === null ? "" : JSON.stringify(jsonBody)),
        headers: { get: () => null },
      };
    }
    function b64(obj) {
      return Buffer.from(JSON.stringify(obj)).toString("base64");
    }

    global.fetch = async (url, opts = {}) => {
      const method = (opts.method || "GET").toUpperCase();
      if (url.includes("/pulls/1/commits")) return res(200, commits);
      if (url.includes("/pulls/1") && !url.includes("/commits")) {
        return res(200, { head: { sha: "head-sha-abc" } });
      }
      if (url.includes("/contents/signatures/cla.json")) {
        if (method === "GET") {
          if (putHappened) getCallsAfterPut += 1;
          // The crux of the simulated race: even after the PUT below has
          // completed, this GET keeps returning the PRE-write snapshot -
          // exactly the documented Contents API staleness window. If
          // checkPR's correctness depended on this GET, it would get the
          // wrong answer every single time in this test.
          return res(200, {
            sha: sigSha,
            content: b64(preWriteSignatures),
            encoding: "base64",
          });
        }
        if (method === "PUT") {
          putHappened = true;
          sigSha = "sig-sha-1";
          return res(200, { content: { sha: sigSha } });
        }
      }
      if (url.includes("/issues/1/comments")) {
        if (method === "GET") return res(200, comments);
        if (method === "POST") {
          const { body } = JSON.parse(opts.body);
          const c = {
            id: comments.length + 1,
            body,
            user: { login: "github-actions[bot]" },
          };
          comments.push(c);
          return res(201, c);
        }
      }
      if (url.includes("/issues/comments/") && method === "DELETE") {
        return res(204, null);
      }
      if (url.includes("/statuses/")) {
        return res(201, {});
      }
      throw new Error(`Unhandled mock request: ${method} ${url}`);
    };

    await handleIssueComment({
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "alice" } },
      comment: {
        user: { id: 9001, login: "alice" },
        body: "I have read the CLA Document and I hereby sign the CLA",
        html_url: "x",
        author_association: "NONE",
      },
    });

    assert.ok(
      comments.length >= 1,
      "expected checkPR to post at least one comment",
    );
    assert.ok(
      comments[comments.length - 1].body.includes(
        "@alice Thank you for signing the CLA! We look forward to your contributions.",
      ),
      `alice (this PR's sole author, who just signed) must be recognized as having completed the PR DESPITE the signatures GET being rigged to return stale (pre-signing) content - got: ${comments[comments.length - 1].body}`,
    );
    assert.ok(
      !comments.some((c) => c.body.includes("need to sign")),
      "alice must never appear in a 'still needs to sign' list here - mergeSignatures() must keep her knownSignatures entry even though the (in this test, deliberately poisoned) GET never reflects her write",
    );
    assert.strictEqual(
      getCallsAfterPut,
      1,
      "checkPR must still perform exactly one signatures GET after the write - see the next test for why skipping it entirely would itself be a bug - but must not let that GET's staleness override alice's own known-fresh signature",
    );
  });

  await test("checkPR's fresh GET still catches a DIFFERENT required contributor's signature written by a concurrent run, even when knownSignatures is also passed", async () => {
    // Regression test for the race the previous test's fix (knownSignatures)
    // introduced: knownSignatures is a snapshot from before
    // listPRCommitAuthors() ran. If checkPR used it INSTEAD OF a fresh GET
    // (rather than merging the two - see mergeSignatures()), it could never
    // see a signature written by a completely different workflow run - e.g.
    // bob signing via some other PR/repo - that lands in the shared store
    // while listPRCommitAuthors() is still in flight for THIS PR. That would
    // make checkPR post a false "bob still needs to sign" comment and a
    // failure status for a PR that is, in fact, already fully compliant.
    //
    // Here alice and bob both authored commits on this PR. alice signs via
    // a comment (the same knownSignatures path as the previous test); the
    // mocked store starts empty and bob's signature is injected into it
    // from inside the PUT handler below - AFTER alice's write has already
    // read and left the store, so it lands in time for checkPR's own
    // subsequent fresh GET but is deliberately never part of what
    // writeSignatures() hands back as knownSignatures. The PR can only be
    // recognized as fully signed if checkPR actually merges that fresh GET
    // in, rather than relying on knownSignatures alone.
    const commits = [
      {
        sha: "c1",
        author: { id: 9001, login: "alice" },
        parents: [{ sha: "p1" }],
        commit: { author: { email: "alice@example.com" } },
      },
      {
        sha: "c2",
        author: { id: 9002, login: "bob" },
        parents: [{ sha: "c1" }],
        commit: { author: { email: "bob@example.com" } },
      },
    ];
    const comments = [];
    // The store starts EMPTY - bob has not signed yet at the moment
    // alice's write reads it, so his entry is genuinely absent from
    // whatever writeSignatures() hands back to checkPR as knownSignatures
    // (alice's write only ever mutates her own entry, based on what it
    // read at read-time). Bob's signature is injected into the shared
    // store from inside the PUT handler below, simulating his concurrent
    // sign (via some other PR/repo) landing moments AFTER alice's own
    // write already completed - it only ever becomes visible through
    // checkPR's own subsequent fresh GET, never through knownSignatures.
    const storedSignatures = { version: 1, signatures: [] };
    let sigSha = "sig-sha-0";

    function res(status, jsonBody) {
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => (jsonBody === null ? "" : JSON.stringify(jsonBody)),
        headers: { get: () => null },
      };
    }
    function b64(obj) {
      return Buffer.from(JSON.stringify(obj)).toString("base64");
    }

    global.fetch = async (url, opts = {}) => {
      const method = (opts.method || "GET").toUpperCase();
      if (url.includes("/pulls/1/commits")) return res(200, commits);
      if (url.includes("/pulls/1") && !url.includes("/commits")) {
        return res(200, { head: { sha: "head-sha-abc" } });
      }
      if (url.includes("/contents/signatures/cla.json")) {
        if (method === "GET") {
          return res(200, {
            sha: sigSha,
            content: b64(storedSignatures),
            encoding: "base64",
          });
        }
        if (method === "PUT") {
          const { content } = JSON.parse(opts.body);
          const written = JSON.parse(
            Buffer.from(content, "base64").toString("utf8"),
          );
          // Bob's concurrent signature lands in the shared store right
          // after alice's own write - present for any GET from here on
          // (including checkPR's own fresh read a moment later), but
          // never part of `written` itself, since the store was still
          // empty when alice's write read it.
          storedSignatures.signatures = [
            ...written.signatures,
            { id: 9002, login: "bob" },
          ];
          sigSha = "sig-sha-1";
          return res(200, { content: { sha: sigSha } });
        }
      }
      if (url.includes("/issues/1/comments")) {
        if (method === "GET") return res(200, comments);
        if (method === "POST") {
          const { body } = JSON.parse(opts.body);
          const c = {
            id: comments.length + 1,
            body,
            user: { login: "github-actions[bot]" },
          };
          comments.push(c);
          return res(201, c);
        }
      }
      if (url.includes("/issues/comments/") && method === "DELETE") {
        return res(204, null);
      }
      if (url.includes("/statuses/")) {
        return res(201, {});
      }
      throw new Error(`Unhandled mock request: ${method} ${url}`);
    };

    await handleIssueComment({
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "alice" } },
      comment: {
        user: { id: 9001, login: "alice" },
        body: "I have read the CLA Document and I hereby sign the CLA",
        html_url: "x",
        author_association: "NONE",
      },
    });

    assert.ok(
      comments.length >= 1,
      "expected checkPR to post at least one comment",
    );
    assert.ok(
      !comments.some((c) => c.body.includes("need to sign")),
      `bob (signed concurrently, only visible via the fresh GET, never in knownSignatures) must not appear in a 'still needs to sign' list - got: ${JSON.stringify(comments.map((c) => c.body))}`,
    );
    assert.ok(
      comments.some((c) =>
        c.body.includes(
          "@alice Thank you for signing the CLA! We look forward to your contributions.",
        ),
      ),
      "alice, who just signed and completed the PR's requirement now that bob's concurrent signature is also visible, must still be personally thanked",
    );
  });

  await test("an unrelated commenter signing the CLA on an already-fully-signed PR is NOT credited with completing that PR", async () => {
    // Regression test: alice is the PR's only commit author and has
    // already signed (e.g. on some earlier PR - signatures are global).
    // mallory then comments the sign phrase on THIS pr even though she has
    // no commits on it at all. Her signature is real and gets recorded,
    // but it had zero effect on this PR's own requirement, which was
    // already satisfied before she ever commented - so the resulting
    // comment must NOT thank her as if she completed it.
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 8001, login: "alice" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "alice@example.com" } },
        },
      ],
      initialSignatures: {
        version: 1,
        signatures: [{ id: 8001, login: "alice" }],
      },
    });
    global.fetch = gh.fetch;

    await handleIssueComment({
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "alice" } },
      comment: {
        user: { id: 9001, login: "mallory" },
        body: "I have read the CLA Document and I hereby sign the CLA",
        html_url: "x",
        author_association: "NONE",
      },
    });

    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "success");
    assert.strictEqual(gh.comments.length, 1);
    assert.ok(
      !gh.comments[0].body.includes("@mallory"),
      "mallory must not be personally credited - she isn't a commit author on this PR, so her signing didn't complete anything here",
    );
    assert.ok(
      gh.comments[0].body.includes("All contributors have signed"),
      "falls back to the generic, anonymous announcement instead",
    );

    // Her signature is still genuinely recorded, though - future PRs where
    // she IS an actual commit author will correctly see her as signed.
    assert.ok(
      gh.signatures.signatures.some(
        (s) => s.id === 9001 && s.login === "mallory",
      ),
    );
  });

  await test("two DIFFERENT unrelated signers signing an unchanged, still-blocked PR do not produce a duplicate pending-status comment", async () => {
    // Regression test for postComment()'s dedupe being defeated by an
    // intervening comment of a DIFFERENT category. alice is this PR's
    // only commit author and hasn't signed; bob and carol are both
    // unrelated bystanders (see the "unrelated commenter" test above) who
    // each sign anyway. Neither signature affects alice's own requirement,
    // so the PR stays blocked on alice across both events and the
    // pending-list comment's content (just "@alice") never actually
    // changes between them.
    //
    // Each blocked-case checkPR() call posts a personal thank-you FIRST
    // (bob's, then carol's - each a distinct "other"-category comment,
    // since it names a different person), immediately followed by the
    // pending-list comment. Naively comparing only against the literal
    // last bot comment would compare the second pending comment against
    // carol's thank-you (different body -> "not a duplicate"), instead of
    // against the first, byte-identical pending comment - reposting an
    // unchanged status a second time. postComment() must instead compare
    // each comment against the most recent one of the SAME category, so
    // it correctly recognizes the second pending comment as an exact
    // repeat of the first and skips posting it.
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 8101, login: "alice" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "alice@example.com" } },
        },
      ],
      initialSignatures: { version: 1, signatures: [] },
    });
    global.fetch = gh.fetch;

    const signAs = (id, login) => ({
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "alice" } },
      comment: {
        user: { id, login },
        body: "I have read the CLA Document and I hereby sign the CLA",
        html_url: "x",
        author_association: "NONE",
      },
    });

    // bob signs first - unrelated, PR stays blocked on alice. Two
    // comments: bob's personal thank-you, then the pending list.
    await handleIssueComment(signAs(9201, "bob"));
    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "failure");
    assert.strictEqual(gh.comments.length, 2);
    assert.ok(
      gh.comments[0].body.includes(
        "@bob Thank you for signing the CLA! We look forward to your contributions.",
      ),
    );
    assert.ok(
      gh.comments[1].body.includes("@alice") &&
        !gh.comments[1].body.includes("@bob") &&
        !gh.comments[1].body.includes("@carol"),
    );

    // carol signs next - also unrelated. She gets her OWN personal
    // thank-you (a genuinely new, distinct comment - it names her, not
    // bob), but the pending-list comment that would follow is byte-for-
    // byte identical to the one already posted after bob (still just
    // "@alice", nothing about the PR's state has changed) and must be
    // deduped, not reposted.
    await handleIssueComment(signAs(9202, "carol"));
    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "failure");
    assert.strictEqual(
      gh.comments.length,
      3,
      "only carol's own thank-you should be added - the unchanged pending-list comment must be deduped against the earlier one, not posted again just because carol's thank-you sits in between",
    );
    assert.ok(
      gh.comments[2].body.includes(
        "@carol Thank you for signing the CLA! We look forward to your contributions.",
      ),
    );
    assert.ok(
      !gh.comments.some(
        (c, i) =>
          i !== 1 && c.body.includes("<!-- fossasia-cla-bot:pending -->"),
      ),
      "no second pending-list comment should exist anywhere in the thread",
    );
  });

  // ---------------------------------------------------------------------
  // Additional coverage merged in from PR #12 (add-tests-2): closed+merged
  // head.sha exemption, lockPR transient-retry behavior, REQUIRE_VERIFIED_COMMITS
  // edge cases, concurrent duplicate-webhook dedup, and combined comment rendering.
  // ---------------------------------------------------------------------
  await test("handlePullRequestTarget does NOT require pull_request.head.sha for a 'closed'+merged event - only opened/synchronize/reopened need it", async () => {
    const gh = makeFakeGitHub({
      commits: [],
      initialSignatures: { version: 1, signatures: [] },
    });
    global.fetch = gh.fetch;
    // No `head` field at all - closed+merged must not care, since it never
    // reads it.
    await handlePullRequestTarget({
      action: "closed",
      pull_request: { number: 1, merged: true },
    });
    assert.strictEqual(gh.lockCalls.length, 1);
  });

  // ---------------------------------------------------------------------
  // lockPR: transient-failure retry behavior (distinct from the existing
  // immediate-403-no-retry test) - a PUT is safeToRetry inside gh(), so a
  // transient 503 on the lock call should be retried automatically before
  // lockPR's own best-effort catch/warn ever gets involved.
  // ---------------------------------------------------------------------
  await test("lockPR retries a transient failure (503) via gh()'s built-in PUT retry and succeeds silently, without ever logging the best-effort warning", async () => {
    const gh = makeFakeGitHub({
      commits: [],
      initialSignatures: { version: 1, signatures: [] },
    });
    const innerFetch = gh.fetch;
    let lockAttempts = 0;
    global.fetch = async (url, opts = {}) => {
      if (
        url.includes("/lock") &&
        (opts.method || "GET").toUpperCase() === "PUT"
      ) {
        lockAttempts += 1;
        if (lockAttempts < 3) {
          return {
            ok: false,
            status: 503,
            text: async () =>
              JSON.stringify({ message: "Service Unavailable" }),
            headers: { get: () => null },
          };
        }
      }
      return innerFetch(url, opts);
    };
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = (fn) => originalSetTimeout(fn, 0); // fast-forward gh()'s retry backoff
    const originalWarn = console.warn;
    let warned = false;
    console.warn = () => {
      warned = true;
    };
    try {
      await lockPR(1);
    } finally {
      global.setTimeout = originalSetTimeout;
      console.warn = originalWarn;
    }
    assert.strictEqual(
      lockAttempts,
      3,
      "expected 2 failed attempts before the 3rd succeeds",
    );
    assert.strictEqual(
      gh.lockCalls.length,
      1,
      "exactly one successful lock should have been recorded",
    );
    assert.ok(
      !warned,
      "a transient failure that eventually succeeds must not log the best-effort warning",
    );
  });

  await test("lockPR exhausts gh()'s transient retries (persistent 503) and then falls back to its own best-effort warning, still without throwing", async () => {
    const gh = makeFakeGitHub({
      commits: [],
      initialSignatures: { version: 1, signatures: [] },
    });
    const innerFetch = gh.fetch;
    let lockAttempts = 0;
    global.fetch = async (url, opts = {}) => {
      if (
        url.includes("/lock") &&
        (opts.method || "GET").toUpperCase() === "PUT"
      ) {
        lockAttempts += 1;
        return {
          ok: false,
          status: 503,
          text: async () => JSON.stringify({ message: "Service Unavailable" }),
          headers: { get: () => null },
        };
      }
      return innerFetch(url, opts);
    };
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = (fn) => originalSetTimeout(fn, 0);
    const originalWarn = console.warn;
    let warned = "";
    console.warn = (msg) => {
      warned = msg;
    };
    try {
      await assert.doesNotReject(() => lockPR(1));
    } finally {
      global.setTimeout = originalSetTimeout;
      console.warn = originalWarn;
    }
    assert.strictEqual(
      lockAttempts,
      3,
      "expected exactly MAX_RETRIES (3) attempts before gh() gives up",
    );
    assert.ok(
      warned.includes("Could not lock PR #1"),
      `expected the best-effort warning after retries are exhausted, got: ${warned}`,
    );
  });

  // ---------------------------------------------------------------------
  // REQUIRE_VERIFIED_COMMITS: combinations beyond the 3 existing
  // "flag=true" scenarios - the default/off state, env-var parsing
  // edge cases, and a missing `committer` field under hardening.
  // ---------------------------------------------------------------------
  await test("REQUIRE_VERIFIED_COMMITS is false by default: an unverified commit with a mismatched committer is still auto-trusted via GitHub's email-based author match", async () => {
    const originalRVC = process.env.REQUIRE_VERIFIED_COMMITS;
    try {
      delete process.env.REQUIRE_VERIFIED_COMMITS; // explicit: default/unset
      delete require.cache[require.resolve("../src/cla-bot.js")];
      const {
        handleIssueComment: handleDefault,
      } = require("../src/cla-bot.js");
      const gh = makeFakeGitHub({
        commits: [
          {
            sha: "unverifiedandmismatched",
            author: { id: 5201, login: "some-user" },
            committer: { id: 8001, login: "someone-else" }, // deliberately mismatched
            parents: [{ sha: "p1" }],
            commit: {
              author: { email: "5201+some-user@users.noreply.github.com" },
              verification: { verified: false, reason: "unsigned" },
            },
          },
        ],
        initialSignatures: {
          version: 1,
          signatures: [{ id: 5201, login: "some-user" }],
        },
      });
      global.fetch = gh.fetch;
      const payload = {
        action: "created",
        issue: { number: 1, pull_request: {}, user: { login: "some-user" } },
        comment: {
          user: { id: 5201, login: "some-user" },
          body: "recheck",
          html_url: "x",
          author_association: "NONE",
        },
      };
      await handleDefault(payload);
      assert.strictEqual(
        gh.statuses[gh.statuses.length - 1].state,
        "success",
        "with the flag off (default), only the email-based author match should matter - verification status and committer mismatch must be ignored",
      );
    } finally {
      if (originalRVC === undefined)
        delete process.env.REQUIRE_VERIFIED_COMMITS;
      else process.env.REQUIRE_VERIFIED_COMMITS = originalRVC;
      delete require.cache[require.resolve("../src/cla-bot.js")];
    }
  });

  await test('REQUIRE_VERIFIED_COMMITS="TRUE" (mixed case) is treated the same as "true" - the comparison is case-insensitive', async () => {
    const originalRVC = process.env.REQUIRE_VERIFIED_COMMITS;
    try {
      process.env.REQUIRE_VERIFIED_COMMITS = "TRUE";
      delete require.cache[require.resolve("../src/cla-bot.js")];
      const {
        handleIssueComment: handleHardened,
      } = require("../src/cla-bot.js");
      const gh = makeFakeGitHub({
        commits: [
          {
            sha: "uppercaseflagtest",
            author: { id: 5301, login: "some-user" },
            committer: { id: 5301, login: "some-user" },
            parents: [{ sha: "p1" }],
            commit: {
              author: { email: "5301+some-user@users.noreply.github.com" },
              verification: { verified: false, reason: "unsigned" },
            },
          },
        ],
        initialSignatures: {
          version: 1,
          signatures: [{ id: 5301, login: "some-user" }],
        },
      });
      global.fetch = gh.fetch;
      const payload = {
        action: "created",
        issue: { number: 1, pull_request: {}, user: { login: "some-user" } },
        comment: {
          user: { id: 5301, login: "some-user" },
          body: "recheck",
          html_url: "x",
          author_association: "NONE",
        },
      };
      await handleHardened(payload);
      assert.strictEqual(
        gh.statuses[gh.statuses.length - 1].state,
        "failure",
        'REQUIRE_VERIFIED_COMMITS="TRUE" must harden just like "true"',
      );
    } finally {
      if (originalRVC === undefined)
        delete process.env.REQUIRE_VERIFIED_COMMITS;
      else process.env.REQUIRE_VERIFIED_COMMITS = originalRVC;
      delete require.cache[require.resolve("../src/cla-bot.js")];
    }
  });

  await test('REQUIRE_VERIFIED_COMMITS="1" does NOT enable hardening - only the literal string "true" (any case) does, by design', async () => {
    const originalRVC = process.env.REQUIRE_VERIFIED_COMMITS;
    try {
      process.env.REQUIRE_VERIFIED_COMMITS = "1";
      delete require.cache[require.resolve("../src/cla-bot.js")];
      const {
        handleIssueComment: handleWithOne,
      } = require("../src/cla-bot.js");
      const gh = makeFakeGitHub({
        commits: [
          {
            sha: "onevaluetest",
            author: { id: 5401, login: "some-user" },
            committer: { id: 9999, login: "someone-else" },
            parents: [{ sha: "p1" }],
            commit: {
              author: { email: "5401+some-user@users.noreply.github.com" },
              verification: { verified: false },
            },
          },
        ],
        initialSignatures: {
          version: 1,
          signatures: [{ id: 5401, login: "some-user" }],
        },
      });
      global.fetch = gh.fetch;
      const payload = {
        action: "created",
        issue: { number: 1, pull_request: {}, user: { login: "some-user" } },
        comment: {
          user: { id: 5401, login: "some-user" },
          body: "recheck",
          html_url: "x",
          author_association: "NONE",
        },
      };
      await handleWithOne(payload);
      assert.strictEqual(
        gh.statuses[gh.statuses.length - 1].state,
        "success",
        '"1" is not the literal string "true", so hardening must stay OFF - this locks down a common misconfiguration where someone sets REQUIRE_VERIFIED_COMMITS=1 expecting it to work',
      );
    } finally {
      if (originalRVC === undefined)
        delete process.env.REQUIRE_VERIFIED_COMMITS;
      else process.env.REQUIRE_VERIFIED_COMMITS = originalRVC;
      delete require.cache[require.resolve("../src/cla-bot.js")];
    }
  });

  await test("REQUIRE_VERIFIED_COMMITS=true treats a commit with no committer field at all as unresolved (fails closed), without crashing", async () => {
    const originalRVC = process.env.REQUIRE_VERIFIED_COMMITS;
    try {
      process.env.REQUIRE_VERIFIED_COMMITS = "true";
      delete require.cache[require.resolve("../src/cla-bot.js")];
      const {
        handleIssueComment: handleHardened,
      } = require("../src/cla-bot.js");
      const gh = makeFakeGitHub({
        commits: [
          {
            sha: "nocommitterfield",
            author: { id: 5501, login: "some-user" },
            // committer field entirely absent
            parents: [{ sha: "p1" }],
            commit: {
              author: { email: "5501+some-user@users.noreply.github.com" },
              verification: { verified: true, reason: "valid" },
            },
          },
        ],
        initialSignatures: {
          version: 1,
          signatures: [{ id: 5501, login: "some-user" }],
        },
      });
      global.fetch = gh.fetch;
      const payload = {
        action: "created",
        issue: { number: 1, pull_request: {}, user: { login: "some-user" } },
        comment: {
          user: { id: 5501, login: "some-user" },
          body: "recheck",
          html_url: "x",
          author_association: "NONE",
        },
      };
      await assert.doesNotReject(() => handleHardened(payload));
      assert.strictEqual(
        gh.statuses[gh.statuses.length - 1].state,
        "failure",
        "a missing committer field must fail closed under hardening, not crash and not be silently trusted",
      );
    } finally {
      if (originalRVC === undefined)
        delete process.env.REQUIRE_VERIFIED_COMMITS;
      else process.env.REQUIRE_VERIFIED_COMMITS = originalRVC;
      delete require.cache[require.resolve("../src/cla-bot.js")];
    }
  });

  // ---------------------------------------------------------------------
  // Concurrent write-success race: the SAME user (a duplicate webhook
  // delivery of the identical sign-phrase comment, which GitHub can and
  // does send) racing against itself, rather than two different users.
  // ---------------------------------------------------------------------
  await test("the same user signing via a genuinely concurrent duplicate webhook delivery is deduped to exactly one recorded signature, not two", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "duplicatewebhooktest",
          author: { id: 6101, login: "double-signer" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "double-signer@example.com" } },
        },
      ],
      initialSignatures: { version: 1, signatures: [] },
    });
    // Force a real race: hold both concurrent calls' initial signature-file
    // reads open with a barrier until both have arrived, so they're
    // guaranteed to see the identical (empty) starting state before either
    // one writes - exactly like two copies of the same webhook delivered
    // close enough together to both start before either finishes.
    let inFlightSigReads = 0;
    let releaseReads;
    const bothArrived = new Promise((resolve) => {
      releaseReads = resolve;
    });
    const innerFetch = gh.fetch;
    global.fetch = async (url, opts = {}) => {
      const method = (opts.method || "GET").toUpperCase();
      if (url.includes("/contents/signatures/cla.json") && method === "GET") {
        inFlightSigReads += 1;
        if (inFlightSigReads >= 2) releaseReads();
        if (inFlightSigReads <= 2) await bothArrived; // only the two initial reads block on each other
      }
      return innerFetch(url, opts);
    };

    const payload = {
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "double-signer" } },
      comment: {
        user: { id: 6101, login: "double-signer" },
        body: "I have read the CLA Document and I hereby sign the CLA",
        html_url: "x",
        author_association: "NONE",
      },
    };

    await Promise.all([
      handleIssueComment(payload),
      handleIssueComment(payload),
    ]);

    assert.strictEqual(
      gh.signatures.signatures.filter((s) => s.id === 6101).length,
      1,
      "a genuine concurrent duplicate delivery must record the signer exactly once, never twice and never zero times",
    );
    assert.strictEqual(
      gh.comments.filter((c) => c.body.includes("already signed")).length,
      1,
      "exactly one of the two racing calls should have discovered it was already signed and replied accordingly",
    );
    // Both racing calls independently re-check the PR and each calls
    // setStatus() once - the one that actually recorded the signature (via
    // its normal, non-statusOnly checkPR call) AND the one that discovered
    // it was already signed (via its statusOnly:true checkPR call, which
    // exists specifically to bring a possibly-stale status up to date - see
    // handleIssueComment's `alreadySigned` branch). That's fine by design:
    // setStatus()'s own doc comment notes that posting the same status
    // twice is a harmless no-op on GitHub's side (only the latest status
    // per context is ever shown), so this is not something worth
    // serializing against. What must never happen is a STALE status (e.g.
    // a leftover "failure" from before the signature landed) winning the
    // race - so every status either call posts here must agree, and must
    // be "success".
    assert.ok(
      gh.statuses.length >= 1,
      "at least one status update must have been posted",
    );
    assert.ok(
      gh.statuses.every((s) => s.state === "success"),
      "every status posted by either racing call must be 'success' - a stale 'failure' status must never win this race",
    );
  });

  // ---------------------------------------------------------------------
  // Comment rendering: both "missing" and "unresolved" sections together.
  // ---------------------------------------------------------------------
  await test("a PR comment correctly lists BOTH missing signers AND unresolved commits at the same time, not just whichever was checked first", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "unsignedcommitsha1",
          author: { id: 1, login: "unsigned-author" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "a@example.com" } },
        },
        {
          sha: "unresolvedcommitsha2",
          author: null,
          parents: [{ sha: "p1" }],
          commit: { author: { email: "b@example.com" } },
        },
      ],
      initialSignatures: { version: 1, signatures: [] },
    });
    global.fetch = gh.fetch;
    const payload = {
      action: "opened",
      pull_request: { number: 1, head: { sha: "head-sha" } },
    };
    await handlePullRequestTarget(payload);

    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "failure");
    const lastComment = gh.comments[gh.comments.length - 1].body;
    assert.ok(
      lastComment.includes("@unsigned-author"),
      "the missing-signer section must list the unsigned author",
    );
    assert.ok(
      lastComment.includes("unresolvedcommitsha2".slice(0, 7)),
      "the unresolved-commit section must list the unresolvable commit by sha",
    );
    assert.ok(
      lastComment.includes("could not be automatically attributed"),
      "both sections must genuinely be present together in the one comment, not one overwriting the other",
    );
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error("\nSOME TESTS FAILED.");
    process.exit(1);
  } else {
    console.log("ALL TESTS PASSED.");
  }
})();
