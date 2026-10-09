"use strict";
/**
 * getExistingBotComments() can be asked about the same PR several times in
 * one run (checkPR()'s history check, postComment()'s dedupe check, the
 * post-write cleanup re-fetch). It now takes an optional `cache` - a plain
 * Map, created fresh per checkPR() run - so those reads share one paginated
 * fetch instead of repeating it. No `cache` passed (e.g. a direct
 * postComment() call) means no caching at all, the original always-fresh
 * behavior.
 *
 * Part 1 exercises the caching directly through the exported
 * getExistingBotComments(). Part 2 proves the savings happen for real
 * through checkPR(), the way it is actually used.
 *
 * Run: node test/comments-cache.test.js (also included in `npm test`)
 */
const assert = require("assert");
const fs = require("fs");
const { Readable } = require("stream");

process.env.GITHUB_TOKEN = "dummy";
process.env.GITHUB_REPOSITORY = "fossasia/testrepo";
process.env.SIG_OWNER = "fossasia";
process.env.SIG_REPO = "cla-signatures";
process.env.CLA_DOCUMENT_URL = "https://example.com/CLA.md";
process.env.ALLOWLIST = "";

const {
  getExistingBotComments,
  checkPR,
  handlePullRequestTarget,
  handleIssueComment,
  postComment,
  pendingIsNewerThanSuccess,
  commentsCacheStorage,
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

function rawRes(status, bodyText, link = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => bodyText,
    headers: { get: (name) => (name.toLowerCase() === "link" ? link : null) },
  };
}

// Model GitHub's numeric JSON IDs while keeping unsafe values exact in the
// fixture. JSON.stringify() can't represent those numeric literals faithfully.
function commentListRes(comments, status = 200, link = null) {
  const json = JSON.stringify(comments).replace(
    /"id":"([1-9]\d*)"/g,
    '"id":$1',
  );
  return rawRes(status, json, link);
}

function commentsPageLink(url, page, total) {
  const pages = Math.ceil(total / 100);
  if (pages <= 1) return null;
  const base = new URL(url);
  const link = [];
  if (page < pages) {
    base.searchParams.set("page", String(page + 1));
    link.push(`<${base.href}>; rel="next"`);
  }
  base.searchParams.set("page", String(pages));
  link.push(`<${base.href}>; rel="last"`);
  return link.join(", ");
}

const BOT = { login: "github-actions[bot]" };
const MARKER = "<!-- fossasia-cla-bot:v1 -->";

(async () => {
  // =========================================================================
  // Part 1: getExistingBotComments() + a caller-supplied cache, in isolation.
  // =========================================================================

  await test("two calls sharing a cache for the same PR fetch the comment list only once", async () => {
    let getCalls = 0;
    global.fetch = async (url) => {
      if (url.endsWith("/user")) return res(404, { message: "Not Found" });
      getCalls += 1;
      return res(200, [{ id: 1, body: `${MARKER}\nhi`, user: BOT }]);
    };
    const cache = new Map();
    const a = await getExistingBotComments(1, { cache });
    const b = await getExistingBotComments(1, { anyBotIdentity: true, cache });
    assert.strictEqual(
      getCalls,
      1,
      "the raw comment page must be fetched once, not twice",
    );
    assert.deepStrictEqual(
      a.map((c) => c.id),
      [1],
    );
    assert.deepStrictEqual(
      b.map((c) => c.id),
      [1],
      "the second call's different `anyBotIdentity` filter must still see the same underlying data",
    );
  });

  await test("the cache never retains ordinary (non-bot-marked) comments, nor fields beyond id/body/user.login/user.type", async () => {
    global.fetch = async (url) => {
      if (url.endsWith("/user")) return res(404, { message: "Not Found" });
      return res(200, [
        {
          // An ordinary human comment on a public PR - this must never sit
          // in the cache, however many of these a PR has.
          id: 1,
          body: "just a normal human comment, no marker here",
          user: { login: "some-contributor", type: "User", id: 999 },
          created_at: "2024-01-01T00:00:00Z",
          html_url:
            "https://github.com/fossasia/testrepo/pull/1#issuecomment-1",
          reactions: { "+1": 3 },
        },
        {
          id: 2,
          body: `${MARKER}\nbot comment`,
          user: {
            login: "github-actions[bot]",
            type: "Bot",
            id: 41898282,
            avatar_url: "https://avatars.example/bot.png",
          },
          created_at: "2024-01-02T00:00:00Z",
          html_url:
            "https://github.com/fossasia/testrepo/pull/1#issuecomment-2",
        },
      ]);
    };
    const cache = new Map();
    await getExistingBotComments(1, { cache, anyBotIdentity: true });
    const { comments: raw } = await cache.get(1).promise;
    assert.strictEqual(
      raw.length,
      1,
      "the ordinary human comment must never enter the cache at all, not even trimmed",
    );
    assert.deepStrictEqual(
      Object.keys(raw[0]).sort(),
      ["body", "id", "user"],
      "a cached comment must carry only id/body/user, not the full GitHub payload",
    );
    assert.deepStrictEqual(
      Object.keys(raw[0].user).sort(),
      ["login", "type"],
      "a cached comment's user must carry only login/type, not id/avatar_url/etc",
    );
    assert.strictEqual(raw[0].id, 2);
    assert.strictEqual(raw[0].user.login, "github-actions[bot]");
  });

  await test("a PUBLIC CONTRIBUTOR spoofing BOT_MARKER in their own comment body is never cached, however many times they try", async () => {
    // The literal marker text is visible in every bot comment, so anyone can
    // paste it into their own comment. What must stop this is the
    // AUTHENTICATED identity on the comment (user.login/user.type, set by
    // GitHub, not editable from the comment body) - never the marker alone.
    global.fetch = async (url) => {
      if (url.endsWith("/user")) return res(404, { message: "Not Found" });
      return res(200, [
        {
          id: 1,
          body: `${MARKER}\npretending to be the real bot, attempt 1`,
          user: { login: "attacker-one", type: "User" },
        },
        {
          id: 2,
          body: `${MARKER}\npretending to be the real bot, attempt 2`,
          user: { login: "attacker-two", type: "User" },
        },
        {
          id: 3,
          body: `${MARKER}\nthe real bot comment`,
          user: { login: "github-actions[bot]", type: "Bot" },
        },
      ]);
    };
    const cache = new Map();
    // Ask with anyBotIdentity: true, the most permissive mode there is - if
    // a spoofed comment could ever get in, it would be here.
    const result = await getExistingBotComments(1, {
      cache,
      anyBotIdentity: true,
    });
    assert.deepStrictEqual(
      result.map((c) => c.id),
      [3],
      "both spoofed comments must be rejected, not just filtered out of the final result",
    );
    const { comments: raw } = await cache.get(1).promise;
    assert.strictEqual(
      raw.length,
      1,
      "a spoofed comment must never even enter the cache - not admitted, not trimmed, not retained at all",
    );
    assert.strictEqual(raw[0].id, 3);
  });

  await test("a flood of marker-bearing BOT-TYPE comments is capped - the cache never grows past MAX_CACHED_COMMENTS, and the real, most recent one always survives the trim", async () => {
    // isPossiblyBotIdentity() admits any type:"Bot" account, not just this
    // bot's own (that's what lets anyBotIdentity survive a token rotation) -
    // so an unrelated or compromised app posting many large marker-bearing
    // comments must still be bounded by an explicit cap, not just identity.
    const floodSize = 350; // > MAX_CACHED_COMMENTS (200), spans 4 pages of 100
    const flood = Array.from({ length: floodSize }, (_, i) => ({
      id: i,
      body: `${MARKER}\n` + `fake message #${i} `.padEnd(2000, "x"),
      user: { login: `rogue-bot-${i}`, type: "Bot" },
    }));
    // The bot's own real comment - appended LAST (so it's the most recent,
    // since GitHub returns comments oldest-first). A correct trim keeps the
    // most recent entries and drops the oldest, so this must survive even
    // though it's vastly outnumbered by the flood ahead of it.
    const real = {
      id: 999999,
      body: `${MARKER}\nthe real bot comment`,
      user: BOT,
    };
    global.fetch = async (url) => {
      if (url.endsWith("/user")) return res(404, { message: "Not Found" });
      const all = [...flood, real];
      const page = Number(new URL(url).searchParams.get("page")) || 1;
      const start = (page - 1) * 100;
      const pageItems = all.slice(start, start + 100);
      return commentListRes(
        pageItems,
        200,
        commentsPageLink(url, page, all.length),
      );
    };
    const cache = new Map();
    const result = await getExistingBotComments(1, {
      cache,
      anyBotIdentity: true,
    });
    const { comments: raw } = await cache.get(1).promise;
    assert.ok(
      raw.length <= 200,
      `the cache must never exceed MAX_CACHED_COMMENTS (200), got ${raw.length}`,
    );
    assert.ok(
      raw.some((c) => c.id === 999999),
      "the real, most recently posted bot comment must survive the trim",
    );
    assert.ok(
      result.some((c) => c.id === 999999),
      "and must still be returned to the caller, despite the flood",
    );
  });

  await test("a cache is scoped per PR number - a different PR is never served from another PR's entry", async () => {
    let getCalls = 0;
    global.fetch = async (url) => {
      if (url.endsWith("/user")) return res(404, { message: "Not Found" });
      getCalls += 1;
      const prNumber = url.includes("/issues/1/comments") ? 1 : 2;
      return res(200, [
        { id: prNumber, body: `${MARKER}\npr-${prNumber}`, user: BOT },
      ]);
    };
    const cache = new Map();
    const one = await getExistingBotComments(1, { cache });
    const two = await getExistingBotComments(2, { cache });
    assert.strictEqual(
      getCalls,
      2,
      "two different PRs must each get their own fetch",
    );
    assert.deepStrictEqual(
      one.map((c) => c.id),
      [1],
    );
    assert.deepStrictEqual(
      two.map((c) => c.id),
      [2],
    );
  });

  await test("fresh: true always re-fetches, even with a warm cache, and the fresh result becomes the new cache entry", async () => {
    let getCalls = 0;
    global.fetch = async (url) => {
      if (url.endsWith("/user")) return res(404, { message: "Not Found" });
      getCalls += 1;
      // The 2nd call (fresh) sees one more comment than the 1st - simulating
      // another process having posted in between.
      const body =
        getCalls === 1
          ? [{ id: 1, body: `${MARKER}\nfirst`, user: BOT }]
          : [
              { id: 1, body: `${MARKER}\nfirst`, user: BOT },
              { id: 2, body: `${MARKER}\nsecond`, user: BOT },
            ];
      return res(200, body);
    };
    const cache = new Map();
    const warm = await getExistingBotComments(1, { cache });
    assert.deepStrictEqual(
      warm.map((c) => c.id),
      [1],
    );
    const fresh = await getExistingBotComments(1, { cache, fresh: true });
    assert.strictEqual(
      getCalls,
      2,
      "fresh: true must bypass the cache and hit GitHub again",
    );
    assert.deepStrictEqual(
      fresh.map((c) => c.id),
      [1, 2],
    );
    // A plain (non-fresh) read right after must reuse the FRESH result, not
    // re-fetch and not fall back to the stale first snapshot.
    const after = await getExistingBotComments(1, { cache });
    assert.strictEqual(
      getCalls,
      2,
      "the fresh result must now be what's cached",
    );
    assert.deepStrictEqual(
      after.map((c) => c.id),
      [1, 2],
    );
  });

  await test("a failed fetch is evicted from the cache - the next call for the same PR gets a real retry, not the same error forever", async () => {
    let getCalls = 0;
    global.fetch = async (url) => {
      if (url.endsWith("/user")) return res(404, { message: "Not Found" });
      getCalls += 1;
      if (getCalls === 1)
        return res(403, { message: "Resource not accessible" });
      return res(200, [{ id: 9, body: `${MARKER}\nok`, user: BOT }]);
    };
    const cache = new Map();
    await assert.rejects(() => getExistingBotComments(1, { cache }));
    const recovered = await getExistingBotComments(1, { cache });
    assert.strictEqual(
      getCalls,
      2,
      "the 2nd call must make a real new request, proving the failed one was not left cached",
    );
    assert.deepStrictEqual(
      recovered.map((c) => c.id),
      [9],
    );
  });

  await test("a stale call's late failure must not evict a newer, concurrent fresh:true call's still-good cache entry (identity-guarded eviction)", async () => {
    const cache = new Map();
    let getCalls = 0;
    let rejectSlowFirstCall;
    global.fetch = async (url) => {
      if (url.endsWith("/user")) return res(404, { message: "Not Found" });
      getCalls += 1;
      if (getCalls === 1) {
        // The first (non-fresh) call's own request hangs - it only fails
        // once the test tells it to, below, which is deliberately AFTER the
        // second (fresh) call has already replaced the cache entry.
        return new Promise((_resolve, reject) => {
          rejectSlowFirstCall = () => reject(new Error("network blip"));
        });
      }
      return res(200, [{ id: 1, body: `${MARKER}\nfresh`, user: BOT }]);
    };
    // Starts the slow fetch and (synchronously, within this call) caches its
    // promise - see fetchAllIssueComments: cache.set() happens before any
    // await, so this is already true by the time this line returns.
    const first = getExistingBotComments(1, { cache });
    // A concurrent fresh:true read for the same PR, sharing the same cache,
    // completes first and overwrites the entry the slow call set.
    const second = await getExistingBotComments(1, { cache, fresh: true });
    assert.deepStrictEqual(
      second.map((c) => c.id),
      [1],
    );
    // Now let the first, now-superseded call fail. Its cleanup must not
    // delete the second call's still-good, newer entry.
    rejectSlowFirstCall();
    await assert.rejects(() => first);
    assert.ok(
      cache.has(1),
      "the newer entry must survive an older, already-superseded call's late failure",
    );
    const third = await getExistingBotComments(1, { cache });
    assert.strictEqual(
      getCalls,
      2,
      "the still-good entry must be reused, not re-fetched a 3rd time",
    );
    assert.deepStrictEqual(
      third.map((c) => c.id),
      [1],
    );
  });

  await test("without a cache (the default), two calls for the same PR each do their own fetch - unchanged, always-fresh behavior", async () => {
    let getCalls = 0;
    global.fetch = async (url) => {
      if (url.endsWith("/user")) return res(404, { message: "Not Found" });
      getCalls += 1;
      return res(200, [{ id: 1, body: `${MARKER}\nhi`, user: BOT }]);
    };
    await getExistingBotComments(1);
    await getExistingBotComments(1);
    assert.strictEqual(
      getCalls,
      2,
      "omitting `cache` must mean no caching at all",
    );
  });

  // =========================================================================
  // Part 2: the real savings, through checkPR() (via the event handlers).
  // =========================================================================

  function makeFakeGitHub({ commits, initialSignatures, comments = [] }) {
    const state = {
      signatures: initialSignatures,
      sha: "sig-sha-0",
      _comments: comments,
      statuses: [],
    };
    // Tests inspect the live fake-GitHub state after DELETE requests replace
    // the backing array, so never expose a stale reference to the initial one.
    Object.defineProperty(state, "comments", {
      configurable: true,
      get() {
        return this._comments;
      },
      set(value) {
        this._comments = value;
      },
    });
    function b64(obj) {
      return Buffer.from(JSON.stringify(obj)).toString("base64");
    }
    state.fetch = async (url, opts = {}) => {
      const method = (opts.method || "GET").toUpperCase();
      if (url.endsWith("/user")) return res(404, { message: "Not Found" });
      if (url.includes("/compare/")) {
        return res(200, { commits, total_commits: commits.length });
      }
      if (url.includes("/pulls/1")) {
        return res(200, {
          head: { sha: "head-sha-abc" },
          base: { sha: "base-sha-abc" },
        });
      }
      if (url.includes("/contents/signatures/cla.json")) {
        if (method === "GET") {
          return res(200, {
            sha: state.sha,
            content: b64(state.signatures),
            encoding: "base64",
          });
        }
        if (method === "PUT") {
          const body = JSON.parse(opts.body);
          if (body.sha !== state.sha)
            return res(409, { message: "sha mismatch" });
          state.signatures = JSON.parse(
            Buffer.from(body.content, "base64").toString(),
          );
          state.sha = `sig-sha-${Number(state.sha.split("-")[2]) + 1}`;
          return res(200, { content: { sha: state.sha } });
        }
      }
      if (url.includes("/issues/1/comments")) {
        if (method === "GET") {
          // GitHub defaults issue-comment lists to newest-first. Honor an
          // explicit created/ascending request, and model that default when
          // callers omit it so ordering assumptions are tested.
          const parsedUrl = new URL(url);
          const ascending =
            parsedUrl.searchParams.get("sort") === "created" &&
            parsedUrl.searchParams.get("direction") === "asc";
          const ordered = [...state.comments].sort((left, right) => {
            const a = BigInt(String(left.id));
            const b = BigInt(String(right.id));
            return a === b ? 0 : (a < b) === ascending ? -1 : 1;
          });
          // Real GitHub pagination, so a flood of comments exercises multiple
          // pages instead of looping forever (per_page=100 is fixed by source).
          const page = Number(parsedUrl.searchParams.get("page")) || 1;
          const start = (page - 1) * 100;
          return commentListRes(
            ordered.slice(start, start + 100),
            200,
            commentsPageLink(url, page, ordered.length),
          );
        }
        if (method === "POST") {
          const { body } = JSON.parse(opts.body);
          const comment = { id: state.comments.length + 1, body, user: BOT };
          state.comments.push(comment);
          return res(201, comment);
        }
      }
      if (url.includes("/issues/comments/") && method === "DELETE") {
        const id = Number(url.split("/issues/comments/")[1]);
        state.comments = state.comments.filter((c) => c.id !== id);
        return res(204, null);
      }
      if (url.includes("/statuses/")) {
        state.statuses.push(JSON.parse(opts.body));
        return res(201, {});
      }
      throw new Error(`Unhandled mock request: ${method} ${url}`);
    };
    return state;
  }

  // Wraps a fake GitHub's fetch so GET /issues/1/comments calls are counted.
  function countCommentReads(gh) {
    let count = 0;
    const inner = gh.fetch;
    global.fetch = async (url, opts = {}) => {
      const method = (opts.method || "GET").toUpperCase();
      if (method === "GET" && url.includes("/issues/1/comments")) count += 1;
      return inner(url, opts);
    };
    return () => count;
  }

  await test("comment-history pagination requests created/ascending order and keeps chronology across pages", async () => {
    const comments = [
      {
        id: 1,
        body: `${MARKER}\n<!-- fossasia-cla-bot:success -->\nold success`,
        user: BOT,
      },
      ...Array.from({ length: 99 }, (_, index) => ({
        id: index + 2,
        body: `ordinary comment ${index}`,
        user: { login: `user-${index}`, type: "User" },
      })),
      {
        id: 101,
        body: `${MARKER}\n<!-- fossasia-cla-bot:pending -->\nnew pending`,
        user: BOT,
      },
      { id: 102, body: `${MARKER}\nunrelated latest bot comment`, user: BOT },
    ];
    const gh = makeFakeGitHub({
      commits: [],
      initialSignatures: { version: 1, signatures: [] },
      comments,
    });
    const requestedUrls = [];
    const inner = gh.fetch;
    global.fetch = async (url, opts = {}) => {
      if (url.includes("/issues/1/comments")) requestedUrls.push(url);
      return inner(url, opts);
    };

    const cache = new Map();
    const pendingIsNewer = await commentsCacheStorage.run(cache, async () => {
      const listed = await getExistingBotComments(1, { anyBotIdentity: true });
      assert.deepStrictEqual(
        listed.map((comment) => comment.id),
        [1, 101, 102],
        "all admitted bot comments must remain in ascending creation order despite the API's descending default",
      );
      return pendingIsNewerThanSuccess(1);
    });

    assert.strictEqual(
      pendingIsNewer,
      true,
      "a newer pending comment must remain newer than success even when an unrelated bot comment follows it",
    );
    assert.deepStrictEqual(
      requestedUrls.map((url) => {
        const parsed = new URL(url);
        return [parsed.searchParams.get("sort"), parsed.searchParams.get("direction")];
      }),
      [ ["created", "asc"], ["created", "asc"] ],
      "every comment-history page must explicitly request created/ascending order",
    );
  });

  await test("comment-history pagination falls back to page-size behavior for a partially malformed Link header", async () => {
    const comments = Array.from({ length: 101 }, (_, index) => ({
      id: index + 1,
      body:
        index === 100
          ? `${MARKER}\n<!-- fossasia-cla-bot:pending -->\nlast-page pending`
          : `${MARKER}\n<!-- fossasia-cla-bot:success -->\ncomment ${index}`,
      user: BOT,
    }));
    const calls = [];
    global.fetch = async (url) => {
      if (url.endsWith("/user")) return res(404, { message: "Not Found" });
      if (url.includes("/issues/1/comments")) {
        const page = Number(new URL(url).searchParams.get("page"));
        calls.push(page);
        const slice = comments.slice((page - 1) * 100, page * 100);
        const link =
          page === 1
            ? '<https://api.github.com/x?page=1>; rel="prev", malformed next relation'
            : '<https://api.github.com/x?page=1>; rel="prev"';
        return commentListRes(slice, 200, link);
      }
      throw new Error(`unexpected call: ${url}`);
    };

    const cache = new Map();
    const result = await commentsCacheStorage.run(cache, () =>
      getExistingBotComments(1, { anyBotIdentity: true }),
    );

    assert.deepStrictEqual(calls, [1, 2]);
    assert.strictEqual(result.length, 101);
    assert.ok(result.some((comment) => comment.body.includes("last-page pending")));
  });

  await test("comment IDs above Number.MAX_SAFE_INTEGER stay exact in cache and chronological comparisons", async () => {
    const firstId = "9007199254740992";
    const secondId = "9007199254740993";
    const payload =
      `[{"id":${firstId},"body":${JSON.stringify(`${MARKER}\n<!-- fossasia-cla-bot:success -->\nold success`)},"user":{"login":"github-actions[bot]","type":"Bot"}},` +
      `{"id":${secondId},"body":${JSON.stringify(`${MARKER}\n<!-- fossasia-cla-bot:pending -->\nnew pending`)},"user":{"login":"github-actions[bot]","type":"Bot"}}]`;
    global.fetch = async (url) => {
      if (url.endsWith("/user")) return res(404, { message: "Not Found" });
      if (url.includes("/issues/1/comments")) return rawRes(200, payload);
      throw new Error(`unexpected call: ${url}`);
    };

    const cache = new Map();
    const result = await commentsCacheStorage.run(cache, async () => {
      const comments = await getExistingBotComments(1, {
        anyBotIdentity: true,
      });
      return {
        ids: comments.map((comment) => comment.id),
        pendingIsNewer: await pendingIsNewerThanSuccess(1),
      };
    });

    assert.deepStrictEqual(result.ids, [firstId, secondId]);
    assert.strictEqual(result.pendingIsNewer, true);
  });

  await test("duplicate cleanup deletes the exact decimal comment ID above Number.MAX_SAFE_INTEGER", async () => {
    const createdId = "9007199254740993";
    const concurrentDuplicateId = "9007199254740994";
    const comments = [];
    const deleteUrls = [];
    global.fetch = async (url, opts = {}) => {
      const method = (opts.method || "GET").toUpperCase();
      if (url.endsWith("/user")) return res(404, { message: "Not Found" });
      if (url.includes("/issues/1/comments") && method === "GET") {
        return commentListRes(
          [...comments].sort((left, right) =>
            BigInt(String(left.id)) < BigInt(String(right.id)) ? -1 : 1,
          ),
        );
      }
      if (url.includes("/issues/1/comments") && method === "POST") {
        const body = JSON.parse(opts.body).body;
        const created = { id: createdId, body, user: BOT };
        comments.push(created, {
          id: concurrentDuplicateId,
          body,
          user: BOT,
        });
        return commentListRes(created, 201);
      }
      if (url.includes("/issues/comments/") && method === "DELETE") {
        deleteUrls.push(url);
        const id = url.slice(url.lastIndexOf("/") + 1);
        const index = comments.findIndex((comment) => String(comment.id) === id);
        if (index !== -1) comments.splice(index, 1);
        return res(204, null);
      }
      throw new Error(`unexpected call: ${method} ${url}`);
    };

    await postComment(1, "large-id duplicate race");

    assert.deepStrictEqual(
      deleteUrls,
      [`https://api.github.com/repos/fossasia/testrepo/issues/comments/${createdId}`],
      "the old duplicate's exact decimal ID must be used in the DELETE URL, never a rounded Number",
    );
    assert.deepStrictEqual(
      comments.map((comment) => comment.id),
      [concurrentDuplicateId],
      "cleanup should keep the newest exact-ID comment",
    );
  });

  await test("duplicate cleanup rejects a corrupt temporary ID before sending any DELETE", async () => {
    const body = `${MARKER}\ncorrupt spool fixture`;
    let commentReads = 0;
    const deletes = [];
    const originalCreateReadStream = fs.createReadStream;
    const originalWarn = console.warn;
    const warnings = [];
    global.fetch = async (url, opts = {}) => {
      const method = (opts.method || "GET").toUpperCase();
      if (url.endsWith("/user")) return res(404, { message: "Not Found" });
      if (url.includes("/issues/1/comments") && method === "GET") {
        commentReads += 1;
        const items = commentReads === 1
          ? []
          : [1, 2].map((id) => ({ id, body, user: BOT }));
        return commentListRes(items);
      }
      if (url.includes("/issues/1/comments") && method === "POST") {
        return res(201, { id: 3, body, user: BOT });
      }
      if (url.includes("/issues/comments/") && method === "DELETE") {
        deletes.push(url);
        return res(204, null);
      }
      throw new Error(`unexpected call: ${method} ${url}`);
    };
    fs.createReadStream = () => Readable.from(["not-a-decimal-id\n"]);
    console.warn = (...args) => warnings.push(args.join(" "));

    try {
      await postComment(1, "corrupt spool fixture");
      assert.deepStrictEqual(deletes, []);
      assert.ok(warnings.some((warning) => warning.includes("invalid ID in its temporary file")));
    } finally {
      fs.createReadStream = originalCreateReadStream;
      console.warn = originalWarn;
    }
  });

  await test("status-only checks on successful and failing PRs make zero comment-list requests", async () => {
    const commit = {
      sha: "c1",
      author: { id: 1, login: "alice" },
      parents: [{ sha: "p1" }],
      commit: { author: { email: "alice@example.com" } },
    };
    for (const scenario of [
      {
        name: "already signed",
        signatures: { version: 1, signatures: [{ id: 1, login: "alice" }] },
      },
      { name: "still missing a signature", signatures: { version: 1, signatures: [] } },
    ]) {
      const gh = makeFakeGitHub({
        commits: [commit],
        initialSignatures: scenario.signatures,
      });
      const getCommentReads = countCommentReads(gh);

      await checkPR(1, "head-sha-abc", { statusOnly: true });

      assert.strictEqual(
        getCommentReads(),
        0,
        `${scenario.name} status-only evaluation must not fetch PR comments`,
      );
      assert.strictEqual(gh.comments.length, 0);
    }
  });

  await test("quiet clean success reads history once and does not refresh after deciding not to post", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 1, login: "alice" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "alice@example.com" } },
        },
      ],
      initialSignatures: {
        version: 1,
        signatures: [{ id: 1, login: "alice" }],
      },
    });
    const getCommentReads = countCommentReads(gh);

    await handlePullRequestTarget({
      action: "synchronize",
      pull_request: {
        number: 1,
        head: { sha: "head-sha-abc" },
        base: { sha: "base-sha-abc" },
      },
    });

    assert.strictEqual(
      getCommentReads(),
      1,
      "the prior-block decision needs one history read; a read-only quiet result must not force-refresh it",
    );
    assert.strictEqual(gh.comments.length, 0);
    assert.strictEqual(gh.statuses.at(-1).state, "success");
  });

  await test("a first pending post uses one cached pre-check plus one fresh cleanup scan", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 1, login: "alice" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "alice@example.com" } },
        },
      ],
      initialSignatures: { version: 1, signatures: [] },
    });
    const getCommentReads = countCommentReads(gh);

    await handlePullRequestTarget({
      action: "synchronize",
      pull_request: {
        number: 1,
        head: { sha: "head-sha-abc" },
        base: { sha: "base-sha-abc" },
      },
    });

    assert.strictEqual(
      getCommentReads(),
      2,
      "one cached list for dedupe and one forced-fresh scan after the successful post",
    );
    assert.strictEqual(gh.comments.length, 1);
    assert.match(gh.comments[0].body, /need to sign/i);
  });

  await test("a full 100-comment page without Link metadata requires an empty follow-up GET", async () => {
    const prior = Array.from({ length: 99 }, (_, index) => ({
      id: index + 1,
      body: `ordinary comment ${index}`,
      user: { login: `user-${index}`, type: "User" },
    }));
    const gh = makeFakeGitHub({
      commits: [],
      initialSignatures: { version: 1, signatures: [] },
      comments: prior,
    });
    const getCommentReads = countCommentReads(gh);

    await postComment(1, "the 100th comment");

    assert.strictEqual(gh.comments.length, 100);
    assert.strictEqual(
      getCommentReads(),
      3,
      "the pre-post snapshot reads 99 comments once, then cleanup confirms the full 100-comment page with empty page 2",
    );
  });

  await test("a REAL pending flag from 250+ admitted comments ago (older than MAX_CACHED_COMMENTS) still correctly triggers a success announcement", async () => {
    // Proves the capped comments LIST (MAX_CACHED_COMMENTS) is never used to
    // answer this question - only the uncapped lastPendingSeq/lastSuccessSeq
    // counters are. A genuine, still-unresolved "pending" flag from long
    // before the cap would otherwise silently vanish and the bot would stay
    // quiet when it should announce.
    const oldPending = {
      id: 1,
      body: "<!-- fossasia-cla-bot:v1 -->\n<!-- fossasia-cla-bot:pending -->\nold pending list",
      user: BOT,
    };
    // 250 bot-marked "other"-category comments after it - more than
    // MAX_CACHED_COMMENTS (200), and none of them pending or success, so a
    // trimmed-list-based check would find neither category and (wrongly)
    // conclude there was nothing to announce.
    const noise = Array.from({ length: 250 }, (_, i) => ({
      id: 100 + i,
      body: `${MARKER}\nunrelated bot chatter #${i}`,
      user: BOT,
    }));
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 1, login: "alice" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "alice@example.com" } },
        },
      ],
      initialSignatures: {
        version: 1,
        signatures: [{ id: 1, login: "alice" }],
      },
      comments: [oldPending, ...noise],
    });
    countCommentReads(gh); // wires up global.fetch to this gh instance

    await handlePullRequestTarget({
      action: "synchronize",
      // The event's base matches the mocked GET /pulls/1 base above exactly:
      // these scenarios are about the comments cache, not checkPR()'s
      // base-change retry path, so no run should take an extra,
      // unintended re-evaluation.
      pull_request: {
        number: 1,
        head: { sha: "head-sha-abc" },
        base: { sha: "base-sha-abc" },
      },
    });

    assert.ok(
      gh.comments.some((c) => c.body.includes("All contributors")),
      "the success comment must still be posted - the old pending flag must not be lost to the cap",
    );
  });

  await test("a quiet, already-blocked PR going back to 'signed' does the history check and the dedupe pre-check as ONE shared read, plus one fresh cleanup read - 2 total, not 3", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 1, login: "alice" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "alice@example.com" } },
        },
      ],
      initialSignatures: {
        version: 1,
        signatures: [{ id: 1, login: "alice" }],
      },
      // A prior "pending" comment exists, so success is newsworthy and
      // postComment() actually runs (quietIfNeverFlagged would otherwise
      // return before ever posting).
      comments: [
        {
          id: 1,
          body: "<!-- fossasia-cla-bot:v1 -->\n<!-- fossasia-cla-bot:pending -->\nold pending list",
          user: BOT,
        },
      ],
    });
    const getCommentReads = countCommentReads(gh);

    await handlePullRequestTarget({
      action: "synchronize",
      // The event's base matches the mocked GET /pulls/1 base above exactly:
      // these scenarios are about the comments cache, not checkPR()'s
      // base-change retry path, so no run should take an extra,
      // unintended re-evaluation.
      pull_request: {
        number: 1,
        head: { sha: "head-sha-abc" },
        base: { sha: "base-sha-abc" },
      },
    });

    assert.strictEqual(
      getCommentReads(),
      2,
      "expected exactly 2 real GET /comments calls: 1 shared by the history check + dedupe pre-check, 1 forced-fresh cleanup re-fetch",
    );
    assert.strictEqual(gh.statuses[gh.statuses.length - 1].state, "success");
    assert.ok(
      gh.comments.some((c) => c.body.includes("All contributors")),
      "the success comment must actually have been posted",
    );
  });

  await test("checkPR's two postComment() calls in one run (signer thank-you + pending list) share cached reads - 3 total comment GETs, not 4", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 1, login: "alice" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "alice@example.com" } },
        },
        {
          sha: "c2",
          author: { id: 2, login: "bob" },
          parents: [{ sha: "p2" }],
          commit: { author: { email: "bob@example.com" } },
        },
      ],
      // Nobody has signed yet - alice is about to, bob still won't have.
      initialSignatures: { version: 1, signatures: [] },
    });
    const getCommentReads = countCommentReads(gh);

    await handleIssueComment({
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "alice" } },
      comment: {
        user: { id: 1, login: "alice" },
        body: "I have read the CLA Document and I hereby sign the CLA",
        html_url: "x",
        author_association: "NONE",
      },
    });

    assert.strictEqual(
      getCommentReads(),
      3,
      "expected 3 real GET /comments calls: 1 shared pre-check (warm cache) + 2 forced-fresh cleanups (one per postComment call)",
    );
    const bodies = gh.comments.map((c) => c.body);
    assert.ok(
      bodies.some((b) => b.includes("Thank you for signing")),
      "alice must be thanked by name",
    );
    assert.ok(
      bodies.some((b) => b.includes("@bob")),
      "bob must still be listed as needing to sign",
    );
  });

  await test("a PR flooded with ordinary contributor comments still works correctly, and none of them ever reach the cache (checkPR path)", async () => {
    const floodSize = 250; // spans more than one 100-per-page GitHub response
    const flood = Array.from({ length: floodSize }, (_, i) => ({
      id: 1000 + i,
      body: `comment #${i} from an untrusted public contributor`,
      user: { login: `rando-${i}`, type: "User" },
    }));
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 1, login: "alice" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "alice@example.com" } },
        },
      ],
      initialSignatures: { version: 1, signatures: [] },
      comments: flood,
    });
    const getCommentReads = countCommentReads(gh);

    await handleIssueComment({
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "alice" } },
      comment: {
        user: { id: 1, login: "alice" },
        body: "I have read the CLA Document and I hereby sign the CLA",
        html_url: "x",
        author_association: "NONE",
      },
    });

    // 250 flood comments page as 100 + 100 + 50 (3 raw GETs) for the shared
    // pre-check, then 251 (+ the just-posted bot comment) page the same way
    // for the forced-fresh cleanup re-fetch - 6 raw GETs total, still just
    // the 2 logical reads from the single-postComment() case above.
    assert.strictEqual(
      getCommentReads(),
      6,
      "3 paginated GETs for the shared pre-check + 3 for the forced-fresh cleanup, despite the flood",
    );
    assert.ok(
      gh.comments.some((c) => c.body.includes("Thank you for signing the CLA")),
      "the real bot comment must still be posted correctly despite the flood",
    );
    assert.strictEqual(
      gh.comments.filter((c) => c.user !== BOT).length,
      floodSize,
      "none of the flood of ordinary comments were touched or lost",
    );
  });

  await test("a genuine duplicate found by the forced-fresh cleanup is still deleted correctly when a cache is in play (checkPR path)", async () => {
    const gh = makeFakeGitHub({
      commits: [
        {
          sha: "c1",
          author: { id: 1, login: "alice" },
          parents: [{ sha: "p1" }],
          commit: { author: { email: "alice@example.com" } },
        },
      ],
      // Not signed yet - the sign flow below always posts (no
      // quietIfNeverFlagged short-circuit), so the duplicate race is
      // guaranteed to be exercised.
      initialSignatures: { version: 1, signatures: [] },
    });
    // Rig the mock's POST so a 2nd, identical comment (simulating a truly
    // concurrent run) appears on GitHub the moment this run posts its own.
    const originalFetch = gh.fetch;
    gh.fetch = async (url, opts = {}) => {
      const result = await originalFetch(url, opts);
      const method = (opts.method || "GET").toUpperCase();
      if (method === "POST" && url.includes("/issues/1/comments")) {
        const posted = JSON.parse(await result.text());
        gh.comments.push({ id: posted.id + 1, body: posted.body, user: BOT });
      }
      return result;
    };
    global.fetch = gh.fetch;

    await handleIssueComment({
      action: "created",
      issue: { number: 1, pull_request: {}, user: { login: "alice" } },
      comment: {
        user: { id: 1, login: "alice" },
        body: "I have read the CLA Document and I hereby sign the CLA",
        html_url: "x",
        author_association: "NONE",
      },
    });

    // alice is the sole author, so she gets the personalized success message
    // rather than the generic one - either way, only one copy of it should
    // remain once the cleanup runs.
    const matching = gh.comments.filter((c) =>
      c.body.includes("Thank you for signing the CLA"),
    );
    assert.strictEqual(
      matching.length,
      1,
      "the older duplicate must have been cleaned up, leaving exactly the newest comment",
    );
  });

  // ===========================================================================
  // Part 3: the duplicate cleanup and the dedupe pre-check must see the PR's
  // ENTIRE comment history, never just the most recent MAX_CACHED_COMMENTS
  // (200) - unlike the general-purpose cache, which is fine to cap. Each
  // test below plants a genuine match far outside a 200-item window and
  // proves it is still found.
  // ===========================================================================

  await test("duplicate cleanup finds and deletes an OLD duplicate far beyond MAX_CACHED_COMMENTS (200), not just a recent one", async () => {
    const text = "dup-beyond-cap";
    const full = `${MARKER}\n${text}`;
    // An exact duplicate at position 1, then 499 unrelated filler bot
    // comments, then this run's own just-posted copy (id 501) - 500
    // comments separate the two exact duplicates, well past the cap.
    const oldDup = { id: 1, body: full, user: BOT };
    const filler = Array.from({ length: 499 }, (_, i) => ({
      id: 2 + i,
      body: `${MARKER}\nfiller #${i}`,
      user: BOT,
    }));
    let getCount = 0;
    const deleted = [];
    global.fetch = async (url, opts = {}) => {
      const method = (opts.method || "GET").toUpperCase();
      if (url.endsWith("/user")) return res(404, { message: "Not Found" });
      if (url.includes("/issues/1/comments")) {
        if (method === "GET") {
          getCount += 1;
          if (getCount === 1) return res(200, []); // pre-check: nothing yet
          // The cleanup's own fresh, paginated scan - must see everything,
          // not just a recent window.
          const all = [oldDup, ...filler, { id: 501, body: full, user: BOT }];
          const page = Number(new URL(url).searchParams.get("page")) || 1;
          const start = (page - 1) * 100;
          return commentListRes(
            all.slice(start, start + 100),
            200,
            commentsPageLink(url, page, all.length),
          );
        }
        if (method === "POST")
          return res(201, { id: 501, body: full, user: BOT });
      }
      if (url.includes("/issues/comments/") && method === "DELETE") {
        const id = Number(url.split("/issues/comments/")[1]);
        deleted.push(id);
        return res(204, null);
      }
      throw new Error(`unexpected call: ${method} ${url}`);
    };
    await postComment(1, text);
    assert.deepStrictEqual(
      deleted,
      [1],
      "the OLD duplicate (id 1), 500 comments back, must still be found and deleted - not silently left behind",
    );
  });

  await test("postComment()'s own dedupe correctly finds an OLD matching comment far beyond MAX_CACHED_COMMENTS (200) and skips reposting it", async () => {
    // Deliberately a "pending"-category message (not "other"): the 300
    // filler comments below are "other"-category, so they can never become
    // a NEWER "pending" that legitimately supersedes this old one - the
    // test would be meaningless otherwise, since a newer same-category
    // comment SHOULD win over an older one.
    const text = "<!-- fossasia-cla-bot:pending -->\nold pending list";
    const full = `${MARKER}\n${text}`;
    // The bot's own prior comment with this exact text, then 300 unrelated
    // "other"-category admitted bot comments since - well past the cap -
    // with no newer "pending" comment in between.
    const oldComment = { id: 1, body: full, user: BOT };
    const filler = Array.from({ length: 300 }, (_, i) => ({
      id: 2 + i,
      body: `${MARKER}\nfiller #${i}`,
      user: BOT,
    }));
    let postCalls = 0;
    global.fetch = async (url, opts = {}) => {
      const method = (opts.method || "GET").toUpperCase();
      if (url.endsWith("/user")) return res(404, { message: "Not Found" });
      if (url.includes("/issues/1/comments")) {
        if (method === "GET") {
          const all = [oldComment, ...filler];
          const page = Number(new URL(url).searchParams.get("page")) || 1;
          const start = (page - 1) * 100;
          return commentListRes(
            all.slice(start, start + 100),
            200,
            commentsPageLink(url, page, all.length),
          );
        }
        if (method === "POST") {
          postCalls += 1;
          return res(201, { id: 999, body: full, user: BOT });
        }
      }
      throw new Error(`unexpected call: ${method} ${url}`);
    };
    await postComment(1, text);
    assert.strictEqual(
      postCalls,
      0,
      "must recognize the old, exact match 300 comments back and skip reposting - not just within the most recent 200",
    );
  });

  await test("a second postComment() call in the same run for the SAME category sees the first call's own just-posted comment immediately, not a stale pre-post snapshot", async () => {
    // checkPR()'s own two postComment() calls per run are always different
    // categories, so this never happens there today - but postComment() is
    // exported, and the shared cache must stay correct regardless of
    // caller, not just for today's one call pattern.
    const text = "same-category-twice";
    const full = `${MARKER}\n${text}`;
    let postCount = 0;
    global.fetch = async (url, opts = {}) => {
      const method = (opts.method || "GET").toUpperCase();
      if (url.endsWith("/user")) return res(404, { message: "Not Found" });
      if (url.includes("/issues/1/comments")) {
        if (method === "GET") return res(200, []); // nothing posted yet, ever
        if (method === "POST") {
          postCount += 1;
          return res(201, { id: postCount, body: full, user: BOT });
        }
      }
      throw new Error(`unexpected call: ${method} ${url}`);
    };
    const cache = new Map();
    await commentsCacheStorage.run(cache, async () => {
      await postComment(1, text); // posts for real
      const currentComments = await getExistingBotComments(1);
      assert.deepStrictEqual(
        currentComments,
        [{ id: 1, body: full, user: { login: BOT.login, type: BOT.type } }],
        "a cached read after POST must include the comment this run just created",
      );
      await postComment(1, text); // identical body, same category - must be a no-op
    });
    assert.strictEqual(
      postCount,
      1,
      "the second call must recognize the first call's own just-posted comment and skip reposting, not post a duplicate",
    );
  });

  await test("the run-scoped comment cache reflects a new post and successful duplicate cleanup", async () => {
    const text = "cache-write-through";
    const full = `${MARKER}\n${text}`;
    const comments = [
      { id: 1, body: full, user: BOT },
      { id: 2, body: `${MARKER}\nnewer other comment`, user: BOT },
    ];
    global.fetch = async (url, opts = {}) => {
      const method = (opts.method || "GET").toUpperCase();
      if (url.endsWith("/user")) return res(404, { message: "Not Found" });
      if (url.includes("/issues/1/comments")) {
        if (method === "GET") {
          const page = Number(new URL(url).searchParams.get("page")) || 1;
          const start = (page - 1) * 100;
          return commentListRes(
            comments.slice(start, start + 100),
            200,
            commentsPageLink(url, page, comments.length),
          );
        }
        if (method === "POST") {
          const created = {
            id: 3,
            body: JSON.parse(opts.body).body,
            user: BOT,
          };
          comments.push(created);
          return res(201, created);
        }
      }
      if (url.includes("/issues/comments/") && method === "DELETE") {
        const id = Number(url.split("/issues/comments/")[1]);
        const index = comments.findIndex((comment) => comment.id === id);
        if (index !== -1) comments.splice(index, 1);
        return res(204, null);
      }
      throw new Error(`unexpected call: ${method} ${url}`);
    };

    const cache = new Map();
    await commentsCacheStorage.run(cache, async () => {
      await postComment(1, text);
      const cached = await getExistingBotComments(1);
      assert.deepStrictEqual(
        cached.map((comment) => comment.id),
        [2, 3],
        "the cache must include the newly created comment and remove the duplicate deleted during cleanup",
      );
    });
  });

  await test("write-through updates whole-history pending/success sequence metadata", async () => {
    let nextId = 1;
    global.fetch = async (url, opts = {}) => {
      const method = (opts.method || "GET").toUpperCase();
      if (url.endsWith("/user")) return res(404, { message: "Not Found" });
      if (url.includes("/issues/1/comments")) {
        if (method === "GET") return res(200, []);
        if (method === "POST") {
          const created = {
            id: nextId++,
            body: JSON.parse(opts.body).body,
            user: BOT,
          };
          return res(201, created);
        }
      }
      throw new Error(`unexpected call: ${method} ${url}`);
    };

    const cache = new Map();
    await commentsCacheStorage.run(cache, async () => {
      await getExistingBotComments(1); // establish an empty cached history
      await postComment(
        1,
        "<!-- fossasia-cla-bot:pending -->\nPlease sign the CLA",
      );
      assert.strictEqual(
        await pendingIsNewerThanSuccess(1),
        true,
        "a pending comment written during this run must immediately set the pending-after-success history state",
      );

      await postComment(
        1,
        "<!-- fossasia-cla-bot:success -->\nAll contributors have signed the CLA",
      );
      assert.strictEqual(
        await pendingIsNewerThanSuccess(1),
        false,
        "a later success comment written during this run must close the pending history state",
      );
    });
  });

  await test("a cache update failure after POST is non-fatal and logged", async () => {
    global.fetch = async (url, opts = {}) => {
      const method = (opts.method || "GET").toUpperCase();
      if (url.includes("/issues/1/comments") && method === "POST") {
        return res(201, { id: 1, body: "posted", user: BOT });
      }
      throw new Error(`unexpected call: ${method} ${url}`);
    };
    const rejected = Promise.reject(new Error("cached fetch failed"));
    rejected.catch(() => {}); // the post path below is the intended observer
    const cache = new Map([[1, { promise: rejected }]]);
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(message);
    try {
      await commentsCacheStorage.run(cache, () => postComment(1, "posted", false));
    } finally {
      console.warn = originalWarn;
    }
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /Could not update the run-scoped comment cache/);
  });

  await test("write-through keeps the cached comment list within MAX_CACHED_COMMENTS", async () => {
    const existing = Array.from({ length: 200 }, (_, index) => ({
      id: index + 1,
      body: `${MARKER}\nexisting #${index}`,
      user: BOT,
    }));
    const gh = makeFakeGitHub({
      commits: [],
      initialSignatures: { version: 1, signatures: [] },
      comments: existing,
    });
    global.fetch = gh.fetch;
    const cache = new Map();
    await commentsCacheStorage.run(cache, async () => {
      await getExistingBotComments(1);
      await postComment(1, "newly posted", false);
      const current = await getExistingBotComments(1);
      assert.strictEqual(current.length, 200);
      assert.strictEqual(current[0].id, 2, "the oldest cached comment is trimmed");
      assert.strictEqual(current.at(-1).id, 201, "the new comment remains cached");
    });
  });

  await test("duplicate-ID spool flushes each full 1,000-ID buffer", async () => {
    const text = "many exact duplicates";
    const full = `${MARKER}\n${text}`;
    const comments = Array.from({ length: 1000 }, (_, index) => ({
      id: index + 1,
      body: full,
      user: BOT,
    }));
    comments.push({ id: 1001, body: `${MARKER}\nnewer different comment`, user: BOT });
    let deleteCount = 0;
    global.fetch = async (url, opts = {}) => {
      const method = (opts.method || "GET").toUpperCase();
      if (url.endsWith("/user")) return res(404, { message: "Not Found" });
      if (url.includes("/issues/1/comments")) {
        if (method === "GET") {
          const page = Number(new URL(url).searchParams.get("page")) || 1;
          const start = (page - 1) * 100;
          return commentListRes(
            comments.slice(start, start + 100),
            200,
            commentsPageLink(url, page, comments.length),
          );
        }
        if (method === "POST") {
          const created = { id: 1002, body: full, user: BOT };
          comments.push(created);
          return res(201, created);
        }
      }
      if (url.includes("/issues/comments/") && method === "DELETE") {
        deleteCount += 1;
        const id = Number(url.split("/issues/comments/")[1]);
        const index = comments.findIndex((comment) => comment.id === id);
        if (index !== -1) comments.splice(index, 1);
        return res(204, null);
      }
      throw new Error(`unexpected call: ${method} ${url}`);
    };

    await postComment(1, text);
    assert.strictEqual(deleteCount, 1000);
    assert.deepStrictEqual(
      comments.map((comment) => comment.id).sort((a, b) => a - b),
      [1001, 1002],
      "cleanup removes all old matches and keeps the newest matching comment",
    );
  });
})();
