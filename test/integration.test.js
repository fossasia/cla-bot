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
      return res(200, url.includes("page=2") ? [] : commits);
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
        state.signatures = JSON.parse(
          Buffer.from(body.content, "base64").toString(),
        );
        state.sha = `sha-${Number(state.sha.split("-")[1]) + 1}`;
        return res(200, { content: { sha: state.sha } });
      }
    }
    if (url.includes("/issues/1/comments")) {
      if (method === "GET")
        return res(200, url.includes("page=2") ? [] : state.comments);
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
      gh.comments[0].body.includes("All contributors have signed"),
      "expected the all-signed comment",
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
    process.env.REQUIRE_VERIFIED_COMMITS = "true";
    delete require.cache[require.resolve("../src/cla-bot.js")];
    const { handleIssueComment: handleHardened } = require("../src/cla-bot.js");
    try {
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
      delete process.env.REQUIRE_VERIFIED_COMMITS;
      delete require.cache[require.resolve("../src/cla-bot.js")];
    }
  });

  await test("REQUIRE_VERIFIED_COMMITS=true does NOT trust a validly-VERIFIED commit whose author differs from its committer (the author-vs-committer forgery: GitHub only ever cryptographically verifies the committer)", async () => {
    process.env.REQUIRE_VERIFIED_COMMITS = "true";
    delete require.cache[require.resolve("../src/cla-bot.js")];
    const { handleIssueComment: handleHardened } = require("../src/cla-bot.js");
    try {
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
      delete process.env.REQUIRE_VERIFIED_COMMITS;
      delete require.cache[require.resolve("../src/cla-bot.js")];
    }
  });

  await test("REQUIRE_VERIFIED_COMMITS=true DOES trust a verified commit when author and committer are genuinely the same account (the legitimate case)", async () => {
    process.env.REQUIRE_VERIFIED_COMMITS = "true";
    delete require.cache[require.resolve("../src/cla-bot.js")];
    const { handleIssueComment: handleHardened } = require("../src/cla-bot.js");
    try {
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
      delete process.env.REQUIRE_VERIFIED_COMMITS;
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

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error("\nSOME TESTS FAILED.");
    process.exit(1);
  } else {
    console.log("ALL TESTS PASSED.");
  }
})();
