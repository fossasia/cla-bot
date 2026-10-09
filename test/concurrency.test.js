"use strict";
/**
 * The bot's independent GitHub reads (co-author lookups, pages of commits and
 * comments, the bot's own login) run side by side through one
 * limiter instead of one after another. These tests check that:
 *
 *   1. the limiter and the `Link` header parser work on their own,
 *   2. reads really overlap, and never go past the limit of 8,
 *   3. the result is exactly what the one-by-one code gave (same items, same
 *      order, same failures), even if a list grows while we read it,
 *   4. renamed co-authors end up where we expect (see the last section).
 *
 * Overlap is measured by counting requests in flight and the order they
 * start in, never by time, so nothing here is flaky.
 *
 * Run: node test/concurrency.test.js (also part of `npm test`)
 */
const assert = require("assert");

process.env.GITHUB_TOKEN = "dummy";
process.env.GITHUB_REPOSITORY = "fossasia/testrepo";
process.env.SIG_OWNER = "fossasia";
process.env.SIG_REPO = "cla-signatures";
process.env.CLA_DOCUMENT_URL = "https://example.com/CLA.md";
process.env.ALLOWLIST = "";

// The caches for identity lookups and the bot login live at module level, so
// every test that depends on them loads its own copy of the module.
function freshModule() {
  delete require.cache[require.resolve("../src/cla-bot.js")];
  return require("../src/cla-bot.js");
}
const bot = freshModule();

let passed = 0;
let finished = false;
// If a promise never settles, Node just exits with status 0 and the rest of the
// file never runs. Make that a failure instead of a silent pass.
process.on("exit", () => {
  if (!finished) {
    console.error(
      "FAIL: the test run ended before every test finished (a promise never settled)",
    );
    process.exitCode = 1;
  }
});
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function res(status, jsonBody, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (jsonBody === null ? "" : JSON.stringify(jsonBody)),
    headers: { get: (h) => headers[h.toLowerCase()] || null },
  };
}

// Counts requests in flight and remembers the order they started in.
function makeTracker() {
  const t = { inFlight: 0, max: 0, started: [] };
  t.run = async (label, work) => {
    t.inFlight += 1;
    t.max = Math.max(t.max, t.inFlight);
    t.started.push(label);
    try {
      return await work();
    } finally {
      t.inFlight -= 1;
    }
  };
  return t;
}

const linkTo = (path, last) =>
  `<https://api.github.com${path}?per_page=100&page=2>; rel="next", <https://api.github.com${path}?per_page=100&page=${last}>; rel="last"`;

// ---------------------------------------------------------------------------
// 1. The limiter
// ---------------------------------------------------------------------------
(async () => {
  await test("createLimiter never runs more than the maximum at once, runs every task, and starts them in queue order", async () => {
    const run = bot.createLimiter(3);
    let active = 0;
    let max = 0;
    const startOrder = [];
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        run(async () => {
          startOrder.push(i);
          active += 1;
          max = Math.max(max, active);
          await sleep(i % 3); // uneven durations
          active -= 1;
          return i * 10;
        }),
      ),
    );
    assert.strictEqual(max, 3, "should reach, and not pass, the limit");
    assert.deepStrictEqual(
      results,
      Array.from({ length: 12 }, (_, i) => i * 10),
    );
    assert.deepStrictEqual(
      startOrder,
      Array.from({ length: 12 }, (_, i) => i),
    );
  });

  await test("createLimiter: a rejecting task rejects only its own promise and frees its slot", async () => {
    const run = bot.createLimiter(1);
    const boom = new Error("boom");
    const results = await Promise.allSettled([
      run(async () => {
        throw boom;
      }),
      run(async () => "after"),
    ]);
    assert.strictEqual(results[0].status, "rejected");
    assert.strictEqual(results[0].reason, boom);
    assert.deepStrictEqual(results[1], { status: "fulfilled", value: "after" });
  });

  await test("createLimiter: a task that throws synchronously becomes a rejection and frees its slot", async () => {
    const run = bot.createLimiter(1);
    const results = await Promise.allSettled([
      run(() => {
        throw new TypeError("sync");
      }),
      run(() => 7),
    ]);
    assert.strictEqual(results[0].status, "rejected");
    assert.ok(results[0].reason instanceof TypeError);
    assert.deepStrictEqual(results[1], { status: "fulfilled", value: 7 });
  });

  // -------------------------------------------------------------------------
  // 2. The Link header parser
  // -------------------------------------------------------------------------
  await test("parseLastPage reads the real GitHub header, in either order", () => {
    const next =
      '<https://api.github.com/repositories/1/issues/2/comments?per_page=100&page=2>; rel="next"';
    const last =
      '<https://api.github.com/repositories/1/issues/2/comments?per_page=100&page=7>; rel="last"';
    assert.strictEqual(bot.parseLastPage(`${next}, ${last}`), 7);
    assert.strictEqual(bot.parseLastPage(`${last}, ${next}`), 7);
  });

  await test("parseLastPage accepts the legal variations of the header", () => {
    const base = "https://api.github.com/x?page=5";
    assert.strictEqual(
      bot.parseLastPage(`<${base}>; rel=last`),
      5,
      "no quotes",
    );
    assert.strictEqual(bot.parseLastPage(`<${base}>; REL="LAST"`), 5, "case");
    assert.strictEqual(
      bot.parseLastPage(`<${base}>; rel="next last"`),
      5,
      "rel list",
    );
    assert.strictEqual(
      bot.parseLastPage(`<${base}>; foo="bar"; rel="last"`),
      5,
      "extra params",
    );
    assert.strictEqual(
      bot.parseLastPage('</x?page=4>; rel="last"'),
      4,
      "relative URL",
    );
    assert.strictEqual(
      bot.parseLastPage(
        `<https://api.github.com/x?per_page=100&page=100>; rel="last"`,
      ),
      100,
      "at the limit",
    );
  });

  await test("parseLastPage returns the number as written, however large: the page limit is the caller's job, so a huge value is never silently ignored", () => {
    for (const page of [101, 100000, 9007199254740991]) {
      assert.strictEqual(
        bot.parseLastPage(
          `<https://api.github.com/x?page=${page}>; rel="last"`,
        ),
        page,
      );
    }
  });

  await test("parseLastPage returns null for anything that is not a plain page number (the caller then walks sequentially, within the page limit)", () => {
    const cases = [
      [null, "null"],
      [undefined, "undefined"],
      [42, "a number"],
      ["", "empty"],
      ['<https://api.github.com/x?page=2>; rel="next"', "no last"],
      [
        '<https://api.github.com/x?page=1>; rel="first", <https://api.github.com/x?page=1>; rel="prev"',
        "first/prev only",
      ],
      ['<https://api.github.com/x>; rel="last"', "no page param"],
      ['<https://api.github.com/x?page=>; rel="last"', "empty page"],
      ['<https://api.github.com/x?page=0>; rel="last"', "page 0"],
      ['<https://api.github.com/x?page=-3>; rel="last"', "negative"],
      ['<https://api.github.com/x?page=abc>; rel="last"', "not a number"],
      ['<https://api.github.com/x?page=1e1>; rel="last"', "exponent form"],
      ['<https://api.github.com/x?page=3.5>; rel="last"', "fraction"],
      ['<https://api.github.com/x?page=007>; rel="last"', "leading zeros"],
      [
        '<https://api.github.com/x?page=99999999999999999999>; rel="last"',
        "unsafe integer",
      ],
      ['<http://[>; rel="last"', "not a URL"],
      ['; rel="last"', "no target"],
      ["<https://api.github.com/x?page=5>", "no rel"],
      [
        '<https://api.github.com/x?page=5>; title="last"',
        "last is not the rel",
      ],
    ];
    for (const [header, why] of cases) {
      assert.strictEqual(bot.parseLastPage(header), null, why);
    }
  });

  // -------------------------------------------------------------------------
  // 3. ghRaw withLink
  // -------------------------------------------------------------------------
  await test("ghRaw returns { data, link } only when asked, and tolerates a response with no headers", async () => {
    global.fetch = async () => res(200, [1, 2], { link: 'x; rel="last"' });
    assert.deepStrictEqual(await bot.ghRaw("/p", "t", { withLink: true }), {
      data: [1, 2],
      link: 'x; rel="last"',
    });
    assert.deepStrictEqual(
      await bot.ghRaw("/p", "t"),
      [1, 2],
      "bare body by default",
    );

    const noHeaders = { ok: true, status: 200, text: async () => "[3]" };
    global.fetch = async () => noHeaders;
    assert.deepStrictEqual(await bot.ghRaw("/p", "t", { withLink: true }), {
      data: [3],
      link: null,
    });
    const noGet = {
      ok: true,
      status: 200,
      text: async () => "[4]",
      headers: {},
    };
    global.fetch = async () => noGet;
    assert.deepStrictEqual(await bot.ghRaw("/p", "t", { withLink: true }), {
      data: [4],
      link: null,
    });
  });

  // -------------------------------------------------------------------------
  // A fake GitHub for the identity / comments / checkPR tests
  // -------------------------------------------------------------------------
  // Default base SHA for every test PR. Distinct from headSha so a mock that
  // forgets to set one stands out immediately instead of accidentally working.
  const BASE_SHA = "base0000".repeat(5);
  // makeGitHub()'s own default headSha, used by every test below that
  // doesn't pass its own.
  const DEFAULT_HEAD_SHA = "a".repeat(40);

  function makeGitHub({
    commits = [],
    idLogins = {}, // account id -> login (omit for a 404)
    loginIds = {}, // login -> account id (omit for a 404)
    comments = [],
    signatures = [],
    headSha = "a".repeat(40),
    baseSha = BASE_SHA,
    idDelay = () => 1,
    link = true,
    botLoginOk = false,
    commentsDelay = 1,
    headDelay = 1,
  } = {}) {
    const g = {
      t: makeTracker(),
      calls: [],
      statuses: [],
      posted: [],
      deleted: [],
      comments,
      fetch: null,
    };
    const paged = (url, items, path) => {
      const page = Number((url.match(/[&?]page=(\d+)/) || [])[1] || 1);
      const lastPage = Math.max(1, Math.ceil(items.length / 100));
      const headers =
        link && lastPage > 1 ? { link: linkTo(path, lastPage) } : {};
      return res(200, items.slice((page - 1) * 100, page * 100), headers);
    };
    // Compare returns an object, not a bare array: { commits, total_commits }.
    // Each page carries `commits` for that page only.
    const pagedCompare = (url, items, path) => {
      const page = Number((url.match(/[&?]page=(\d+)/) || [])[1] || 1);
      const lastPage = Math.max(1, Math.ceil(items.length / 100));
      const headers =
        link && lastPage > 1 ? { link: linkTo(path, lastPage) } : {};
      return res(
        200,
        {
          commits: items.slice((page - 1) * 100, page * 100),
          total_commits: items.length,
        },
        headers,
      );
    };
    g.fetch = async (url, opts = {}) => {
      const method = (opts.method || "GET").toUpperCase();
      const path = url.replace("https://api.github.com", "");
      g.calls.push(`${method} ${path}`);
      return g.t.run(`${method} ${path}`, async () => {
        let m;
        if ((m = path.match(/^\/user\/(\d+)$/))) {
          await sleep(idDelay(Number(m[1])));
          return m[1] in idLogins
            ? res(200, { id: Number(m[1]), login: idLogins[m[1]] })
            : res(404, { message: "Not Found" });
        }
        if ((m = path.match(/^\/users\/([^/?]+)$/))) {
          await sleep(1);
          const login = decodeURIComponent(m[1]);
          // GitHub logins are case-insensitive.
          const known = Object.keys(loginIds).find(
            (k) => k.toLowerCase() === login.toLowerCase(),
          );
          return known !== undefined
            ? res(200, { id: loginIds[known], login: known })
            : res(404, { message: "Not Found" });
        }
        if (path === "/user") {
          await sleep(commentsDelay);
          return botLoginOk
            ? res(200, { login: "my-pat-bot" })
            : res(403, { message: "Resource not accessible by integration" });
        }
        if (path.startsWith(`/repos/fossasia/testrepo/compare/`)) {
          await sleep(1);
          return pagedCompare(
            path,
            commits,
            path.split("?")[0], // the basehead part varies per test
          );
        }
        if (/^\/repos\/fossasia\/testrepo\/pulls\/1$/.test(path)) {
          await sleep(headDelay);
          return res(200, { head: { sha: headSha }, base: { sha: baseSha } });
        }
        if (path.startsWith("/repos/fossasia/cla-signatures/contents/")) {
          await sleep(1);
          return res(200, {
            sha: "s0",
            content: Buffer.from(
              JSON.stringify({ version: 1, signatures }),
            ).toString("base64"),
            encoding: "base64",
          });
        }
        if (path.startsWith("/repos/fossasia/testrepo/issues/1/comments")) {
          if (method === "POST") {
            const { body } = JSON.parse(opts.body);
            const c = {
              id: 100000 + g.posted.length,
              body,
              user: { login: "github-actions[bot]" },
            };
            g.posted.push(c);
            g.comments.push(c);
            return res(201, c);
          }
          await sleep(commentsDelay);
          return paged(
            path,
            g.comments,
            "/repos/fossasia/testrepo/issues/1/comments",
          );
        }
        if (
          (m = path.match(
            /^\/repos\/fossasia\/testrepo\/issues\/comments\/(\d+)$/,
          ))
        ) {
          g.deleted.push(Number(m[1]));
          g.comments = g.comments.filter((c) => c.id !== Number(m[1]));
          return res(204, null);
        }
        if (path.startsWith("/repos/fossasia/testrepo/statuses/")) {
          g.statuses.push({
            sha: path.split("/statuses/")[1],
            ...JSON.parse(opts.body),
          });
          return res(201, {});
        }
        throw new Error(`Unhandled mock request: ${method} ${path}`);
      });
    };
    return g;
  }

  const trailer = (n, email) => `Co-authored-by: Person ${n} <${email}>`;
  const newStyle = (id, name = "someone") =>
    `${id}+${name}@users.noreply.github.com`;

  // -------------------------------------------------------------------------
  // 4. Co-author identity lookups
  // -------------------------------------------------------------------------
  await test("extractCoAuthors: all lookups of one commit are in flight together, and the result keeps TRAILER order even when answers arrive in reverse", async () => {
    const b = freshModule();
    const ids = [101, 102, 103, 104, 105, 106];
    const g = makeGitHub({
      idLogins: Object.fromEntries(ids.map((id) => [id, `login${id}`])),
      idDelay: (id) => (107 - id) * 3, // 106 answers first, 101 last
    });
    global.fetch = g.fetch;
    const message = `Fix\n\n${ids.map((id) => trailer(id, newStyle(id))).join("\n")}`;
    const { authors, hasUnresolved } = await b.extractCoAuthors(message);
    assert.deepStrictEqual(
      authors,
      ids.map((id) => ({ id, login: `login${id}` })),
    );
    assert.strictEqual(hasUnresolved, false);
    assert.strictEqual(g.t.max, 6, "all six lookups were in flight at once");
  });

  await test("extractCoAuthors: caps at 20 distinct trailers (21st is never looked up) and flags the commit", async () => {
    const b = freshModule();
    const ids = Array.from({ length: 25 }, (_, i) => 200 + i);
    const g = makeGitHub({
      idLogins: Object.fromEntries(ids.map((id) => [id, `l${id}`])),
    });
    global.fetch = g.fetch;
    const message = ids.map((id) => trailer(id, newStyle(id))).join("\n");
    const { authors, hasUnresolved } = await b.extractCoAuthors(message);
    assert.strictEqual(authors.length, 20);
    assert.strictEqual(hasUnresolved, true);
    assert.deepStrictEqual(
      g.calls.filter((c) => c.startsWith("GET /user/")).sort(),
      ids
        .slice(0, 20)
        .map((id) => `GET /user/${id}`)
        .sort(),
      "exactly the first 20 distinct ids",
    );
    assert.ok(g.t.max <= 8, `bounded: ${g.t.max}`);
  });

  await test("extractCoAuthors: a repeated trailer (any case) costs one lookup, two emails for one account give two entries", async () => {
    const b = freshModule();
    const g = makeGitHub({ idLogins: { 301: "same" } });
    global.fetch = g.fetch;
    const message = [
      trailer(1, newStyle(301, "a")),
      trailer(2, newStyle(301, "a").toUpperCase()), // same address, other case
      trailer(3, newStyle(301, "b")), // other address, same account id
    ].join("\n");
    const { authors } = await b.extractCoAuthors(message);
    assert.strictEqual(
      g.calls.filter((c) => c === "GET /user/301").length,
      1,
      "one request per id",
    );
    assert.deepStrictEqual(authors, [
      { id: 301, login: "same" },
      { id: 301, login: "same" },
    ]);
  });

  await test("extractCoAuthors: unresolvable trailers are flagged and the resolvable ones are kept, in order", async () => {
    const b = freshModule();
    const g = makeGitHub({
      idLogins: { 401: "found" },
      loginIds: { OldStyle: 402 },
    });
    global.fetch = g.fetch;
    const message = [
      trailer(1, newStyle(999)), // id matches no account
      trailer(2, newStyle(401)), // resolves
      trailer(3, "OldStyle@users.noreply.github.com"), // old style, resolves by login
      trailer(4, "Ghost@users.noreply.github.com"), // old style, no such account
      trailer(5, "someone@example.com"), // not a noreply address at all
    ].join("\n");
    const { authors, hasUnresolved } = await b.extractCoAuthors(message);
    assert.deepStrictEqual(authors, [
      { id: 401, login: "found" },
      { id: 402, login: "OldStyle" },
    ]);
    assert.strictEqual(hasUnresolved, true);
  });

  await test("extractCoAuthors: no trailers, or no message at all, means no lookups and nothing unresolved", async () => {
    const b = freshModule();
    global.fetch = async () => {
      throw new Error("no request expected");
    };
    for (const message of [undefined, null, "", "just a subject line"]) {
      assert.deepStrictEqual(await b.extractCoAuthors(message), {
        authors: [],
        hasUnresolved: false,
      });
    }
  });

  // -------------------------------------------------------------------------
  // 5. listPRCommitAuthors
  // -------------------------------------------------------------------------
  const commit = (n, id, login, message = "", extra = {}) => ({
    sha: `c${n}`,
    author: { id, login },
    committer: { id, login },
    parents: [{ sha: "p" }],
    commit: { message, author: { email: `${login}@example.com` } },
    ...extra,
  });

  await test("old-style noreply trailers (looked up by login) overlap too, are looked up once per login (any case), and stay within the bound", async () => {
    const b = freshModule();
    const loginIds = Object.fromEntries(
      Array.from({ length: 36 }, (_, i) => [`Old${i}`, 800 + i]),
    );
    const commits = Array.from({ length: 36 }, (_, i) =>
      commit(
        i,
        20 + i,
        `author${i}`,
        trailer(i, `Old${i}@users.noreply.github.com`) +
          "\n" +
          trailer(i + 100, `old${(i + 1) % 36}@users.noreply.github.com`),
      ),
    );
    const g = makeGitHub({ commits, loginIds });
    global.fetch = g.fetch;
    const { authors, unresolved } = await b.listPRCommitAuthors(
      BASE_SHA,
      DEFAULT_HEAD_SHA,
    );
    const loginCalls = g.calls.filter((c) => c.startsWith("GET /users/"));
    assert.strictEqual(
      loginCalls.length,
      36,
      "one request per distinct login, case-insensitively",
    );
    assert.deepStrictEqual(unresolved, []);
    assert.strictEqual(authors.length, 36 + 36);
    assert.ok(g.t.max > 1, "lookups overlapped");
    assert.ok(g.t.max <= 8, `bounded: ${g.t.max}`);
  });

  await test("listPRCommitAuthors: authors and unresolved SHAs come out in COMMIT order even when identity answers arrive in reverse", async () => {
    const b = freshModule();
    const g = makeGitHub({
      commits: [
        commit(1, 1, "alice", trailer(1, newStyle(501))),
        commit(
          2,
          2,
          "bob",
          trailer(2, newStyle(502)) + "\n" + trailer(3, "x@example.com"),
        ),
        commit(3, 3, "carol", trailer(4, newStyle(503))),
        commit(4, null, null, ""), // no linked account -> flagged
      ],
      idLogins: { 501: "dave", 502: "erin", 503: "frank" },
      idDelay: (id) => (504 - id) * 4, // 503 first, 501 last
    });
    global.fetch = g.fetch;
    const { authors, unresolved } = await b.listPRCommitAuthors(
      BASE_SHA,
      DEFAULT_HEAD_SHA,
    );
    assert.deepStrictEqual(
      authors.map((a) => a.login),
      ["alice", "dave", "bob", "erin", "carol", "frank"],
    );
    assert.deepStrictEqual(unresolved, ["c2", "c4"]);
  });

  await test("listPRCommitAuthors: merge commits are skipped entirely, with no lookups for their trailers", async () => {
    const b = freshModule();
    const g = makeGitHub({
      commits: [
        commit(1, 1, "alice", ""),
        commit(2, 2, "merger", trailer(1, newStyle(601)), {
          parents: [{ sha: "a" }, { sha: "b" }],
        }),
      ],
      idLogins: { 601: "ghost" },
    });
    global.fetch = g.fetch;
    const { authors, unresolved } = await b.listPRCommitAuthors(
      BASE_SHA,
      DEFAULT_HEAD_SHA,
    );
    assert.deepStrictEqual(
      authors.map((a) => a.login),
      ["alice"],
    );
    assert.deepStrictEqual(unresolved, []);
    assert.ok(
      !g.calls.some((c) => c.startsWith("GET /user/")),
      "no identity request",
    );
  });

  await test("listPRCommitAuthors: an account credited on many commits is looked up once; lookups across commits overlap but stay within the bound", async () => {
    const b = freshModule();
    const commits = [];
    for (let i = 0; i < 60; i++) {
      // 40 distinct co-authors, with ids 700..739 reused by later commits.
      commits.push(
        commit(i, 10 + i, `author${i}`, trailer(i, newStyle(700 + (i % 40)))),
      );
    }
    const idLogins = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [700 + i, `co${i}`]),
    );
    const g = makeGitHub({ commits, idLogins, idDelay: () => 3 });
    global.fetch = g.fetch;
    const { authors } = await b.listPRCommitAuthors(BASE_SHA, DEFAULT_HEAD_SHA);
    assert.strictEqual(authors.length, 60 + 40);
    const idCalls = g.calls.filter((c) => c.startsWith("GET /user/"));
    assert.strictEqual(
      idCalls.length,
      40,
      "one request per distinct id, not per trailer",
    );
    assert.strictEqual(new Set(idCalls).size, 40);
    assert.ok(g.t.max > 1, "lookups overlapped");
    assert.ok(g.t.max <= 8, `bounded: ${g.t.max}`);
  });

  await test("listPRCommitAuthors: 250 commits over three pages with a Link header are all read, the extra pages in parallel, in order", async () => {
    const b = freshModule();
    const commits = Array.from({ length: 250 }, (_, i) =>
      commit(i, 1000 + i, `u${i}`),
    );
    const g = makeGitHub({ commits });
    global.fetch = g.fetch;
    const { authors, unresolved } = await b.listPRCommitAuthors(
      BASE_SHA,
      DEFAULT_HEAD_SHA,
    );
    assert.deepStrictEqual(
      authors.map((a) => a.id),
      commits.map((c) => c.author.id),
    );
    assert.deepStrictEqual(unresolved, []);
    assert.deepStrictEqual(
      g.calls.filter((c) => c.includes("/compare/")).length,
      3,
    );
  });

  await test("listPRCommitAuthors: without a Link header the same 250 commits are still all read (sequential walk)", async () => {
    const b = freshModule();
    const commits = Array.from({ length: 250 }, (_, i) =>
      commit(i, 1000 + i, `u${i}`),
    );
    const g = makeGitHub({ commits, link: false });
    global.fetch = g.fetch;
    const { authors } = await b.listPRCommitAuthors(BASE_SHA, DEFAULT_HEAD_SHA);
    assert.strictEqual(authors.length, 250);
    assert.strictEqual(
      g.calls.filter((c) => c.includes("/compare/")).length,
      3,
    );
  });

  // -------------------------------------------------------------------------
  // 6. Comments: bot login + pages, and the dedupe on top of them
  // -------------------------------------------------------------------------
  const BOT_MARKER = "<!-- fossasia-cla-bot:v1 -->";
  const botComment = (id, body) => ({
    id,
    body: `${BOT_MARKER}\n${body}`,
    user: { login: "github-actions[bot]" },
  });

  await test("getExistingBotComments: the bot-login request and the first comment page are in flight together, each requested once", async () => {
    const b = freshModule();
    const g = makeGitHub({
      comments: [botComment(1, "hello")],
      commentsDelay: 10,
    });
    global.fetch = g.fetch;
    const got = await b.getExistingBotComments(1);
    assert.strictEqual(got.length, 1);
    assert.strictEqual(g.t.max, 2, "GET /user and GET comments overlapped");
    assert.strictEqual(g.calls.filter((c) => c === "GET /user").length, 1);
    // A second listing must reuse the cached login: no second GET /user.
    await b.getExistingBotComments(1);
    assert.strictEqual(g.calls.filter((c) => c === "GET /user").length, 1);
  });

  await test("getExistingBotComments: a 350-comment PR is read completely (page by page), keeping only the bot's marker comments in order", async () => {
    const b = freshModule();
    const comments = [];
    for (let i = 1; i <= 350; i++) {
      comments.push(
        i % 7 === 0
          ? botComment(i, `status ${i}`)
          : { id: i, body: `human ${i}`, user: { login: "someone" } },
      );
    }
    const g = makeGitHub({ comments });
    global.fetch = g.fetch;
    const got = await b.getExistingBotComments(1);
    assert.deepStrictEqual(
      got.map((c) => c.id),
      comments.filter((c) => c.id % 7 === 0).map((c) => c.id),
    );
    assert.strictEqual(
      g.calls.filter((c) => c.includes("/comments?")).length,
      // Pages 1-4, one after another, and nothing more: the walk stops at
      // the first short page (see fetchAllIssueCommentsUncached()).
      4,
    );
  });

  await test("getExistingBotComments rejects when a comment page fails (and the cached bot login stays usable)", async () => {
    const b = freshModule();
    const g = makeGitHub({ comments: [botComment(1, "x")] });
    const inner = g.fetch;
    global.fetch = async (url, opts) =>
      url.includes("/issues/1/comments")
        ? res(404, { message: "Not Found" })
        : inner(url, opts);
    await assert.rejects(
      () => b.getExistingBotComments(1),
      (e) => e.status === 404,
    );
  });

  await test("postComment sees an identical bot comment that is on the LAST of three pages and posts nothing", async () => {
    const b = freshModule();
    const comments = Array.from({ length: 249 }, (_, i) => ({
      id: i + 1,
      body: `human ${i}`,
      user: { login: "someone" },
    }));
    const full = "Please sign the CLA";
    comments.push(botComment(250, full)); // newest comment, page 3
    const g = makeGitHub({ comments });
    global.fetch = g.fetch;
    await b.postComment(1, full);
    assert.strictEqual(g.posted.length, 0, "unchanged, so nothing posted");
  });

  await test("postComment posts a changed comment and its post-write cleanup deletes a duplicate that is on another page", async () => {
    const b = freshModule();
    const comments = Array.from({ length: 205 }, (_, i) => ({
      id: i + 1,
      body: `human ${i}`,
      user: { login: "someone" },
    }));
    const g = makeGitHub({ comments });
    // Simulate a racing run: right after our POST, an identical comment from
    // another run lands too, so the cleanup listing contains two copies.
    const inner = g.fetch;
    let injected = false;
    global.fetch = async (url, opts = {}) => {
      const r = await inner(url, opts);
      if ((opts.method || "GET") === "POST" && !injected) {
        injected = true;
        g.comments.push(
          botComment(
            999999,
            JSON.parse(opts.body).body.replace(`${BOT_MARKER}\n`, ""),
          ),
        );
      }
      return r;
    };
    await b.postComment(1, "Please sign the CLA");
    assert.strictEqual(g.posted.length, 1);
    assert.strictEqual(
      g.deleted.length,
      1,
      "one of the two identical comments was removed",
    );
    const remaining = g.comments.filter((c) =>
      c.body.includes("Please sign the CLA"),
    );
    assert.strictEqual(remaining.length, 1);
  });

  // -------------------------------------------------------------------------
  // 7. checkPR: the PR snapshot (base + head) is read BEFORE the commit list
  // -------------------------------------------------------------------------
  await test("checkPR with no headSha reads the PR first, then compares base...head, and uses the head it read", async () => {
    const b = freshModule();
    const sha = "b".repeat(40);
    const g = makeGitHub({
      headSha: sha,
      headDelay: 30, // slow, so any overlap with the compare call would show
      commits: [commit(1, 1, "alice")],
      signatures: [{ id: 1, login: "alice" }],
    });
    global.fetch = g.fetch;
    await b.checkPR(1, undefined, { statusOnly: true });
    assert.strictEqual(
      g.t.max,
      1,
      "the PR read must finish before the compare call starts",
    );
    const firstCompare = g.calls.findIndex((c) => c.includes("/compare/"));
    const firstPull = g.calls.findIndex((c) => /\/pulls\/1$/.test(c));
    assert.ok(firstPull >= 0 && firstPull < firstCompare, g.calls.join("\n"));
    assert.ok(
      g.calls[firstCompare].includes(`${BASE_SHA}...${sha}`),
      "compares the exact base and head that were just read",
    );
    assert.strictEqual(g.statuses.length, 1);
    assert.strictEqual(g.statuses[0].sha, sha);
    assert.strictEqual(g.statuses[0].state, "success");
  });

  await test("checkPR: an invalid head SHA from the API is still rejected with the same error, and no status is posted", async () => {
    const b = freshModule();
    const g = makeGitHub({
      headSha: "bad/../sha",
      commits: [commit(1, 1, "alice")],
      signatures: [{ id: 1, login: "alice" }],
    });
    global.fetch = g.fetch;
    await assert.rejects(
      () => b.checkPR(1, undefined, { statusOnly: true }),
      (e) => /head\.sha/.test(e.message),
    );
    assert.strictEqual(g.statuses.length, 0);
  });

  await test("checkPR: an invalid base SHA from the API is rejected too, and no status is posted", async () => {
    const b = freshModule();
    const g = makeGitHub({
      baseSha: "bad/../sha",
      commits: [commit(1, 1, "alice")],
      signatures: [{ id: 1, login: "alice" }],
    });
    global.fetch = g.fetch;
    await assert.rejects(
      () => b.checkPR(1, undefined, { statusOnly: true }),
      (e) => /base\.sha/.test(e.message),
    );
    assert.strictEqual(g.statuses.length, 0);
  });

  await test("checkPR: a failing compare call rejects even though the PR read succeeded, and posts no status", async () => {
    const b = freshModule();
    const g = makeGitHub({ commits: [] });
    const inner = g.fetch;
    global.fetch = async (url, opts) =>
      url.includes("/compare/")
        ? res(404, { message: "Not Found" })
        : inner(url, opts);
    await assert.rejects(
      () => b.checkPR(1, undefined, { statusOnly: true }),
      (e) => e.status === 404,
    );
    assert.strictEqual(g.statuses.length, 0);
  });

  await test("checkPR: a headSha passed in is validated before ANY request is made", async () => {
    const b = freshModule();
    let requests = 0;
    global.fetch = async () => {
      requests += 1;
      throw new Error("no request expected");
    };
    await assert.rejects(
      () => b.checkPR(1, "a/b", { statusOnly: true }),
      /checkPR\(headSha\)/,
    );
    assert.strictEqual(requests, 0);
  });

  await test("checkPR: a headSha that is no longer the PR's head is skipped - nothing is certified and no compare runs", async () => {
    const b = freshModule();
    const givenSha = "c".repeat(40);
    const g = makeGitHub({
      headSha: "d".repeat(40), // the PR has moved on since the given head
      commits: [commit(1, 1, "alice")],
      signatures: [{ id: 1, login: "alice" }],
    });
    global.fetch = g.fetch;
    await b.checkPR(1, givenSha, { statusOnly: true });
    assert.strictEqual(g.statuses.length, 0, "no status on a head we did not read as current");
    assert.ok(
      !g.calls.some((c) => c.includes("/compare/")),
      "no compare for a stale pair",
    );
  });

  // -------------------------------------------------------------------------
  // 7b. The limit of 8 counts EVERY read that can overlap
  // -------------------------------------------------------------------------
  await test("checkPR: co-author lookups stay within the limit of 8 while the PR is re-read", async () => {
    const b = freshModule();
    const ids = Array.from({ length: 30 }, (_, i) => 900 + i);
    const g = makeGitHub({
      commits: ids.map((id, i) =>
        commit(i, 1 + i, `u${i}`, trailer(i, newStyle(id))),
      ),
      idLogins: Object.fromEntries(ids.map((id) => [id, `co${id}`])),
      idDelay: () => 25,
    });
    global.fetch = g.fetch;
    await b.checkPR(1, undefined, { statusOnly: true });
    assert.ok(g.t.max > 4, `should overlap, saw ${g.t.max}`);
    assert.ok(g.t.max <= 8, `at most 8 in flight, saw ${g.t.max}`);
  });

  await test("a comment listing (bot login, first page, later pages) shares the limit of 8 with co-author lookups", async () => {
    for (const total of [100, 250]) {
      // 100 comments: page 1 is full and has no Link header, so the walk
      // continues one page at a time. 250: the later pages go in parallel.
      const b = freshModule();
      const ids = Array.from({ length: 20 }, (_, i) => 1200 + i);
      const comments = Array.from({ length: total }, (_, i) => ({
        id: i + 1,
        body: "chat",
        user: { login: "x" },
      }));
      const g = makeGitHub({
        comments,
        commentsDelay: 30,
        idLogins: Object.fromEntries(ids.map((id) => [id, `l${id}`])),
        idDelay: () => 30,
      });
      global.fetch = g.fetch;
      const message = ids.map((id) => trailer(id, newStyle(id))).join("\n");
      // The listing goes first, then the lookups pile on top of it.
      const [listed] = await Promise.all([
        b.getExistingBotComments(1),
        b.extractCoAuthors(message),
      ]);
      assert.deepStrictEqual(listed, []);
      assert.ok(g.t.max > 4, `total=${total}: should overlap, saw ${g.t.max}`);
      assert.ok(
        g.t.max <= 8,
        `total=${total}: at most 8 in flight, saw ${g.t.max}`,
      );
    }
  });

  // -------------------------------------------------------------------------
  // 7c. Renamed co-authors
  // -------------------------------------------------------------------------
  const SHA = "d".repeat(40);
  const alice = { id: 1, login: "alice" };

  await test("renamed co-author, NEW noreply format (id+login@...): found by id, so the old name in the address doesn't matter", async () => {
    const b = freshModule();
    const g = makeGitHub({
      headSha: SHA,
      commits: [commit(1, 1, "alice", trailer(1, newStyle(321, "oldname")))],
      idLogins: { 321: "newname" },
      signatures: [alice, { id: 321, login: "newname" }],
    });
    global.fetch = g.fetch;
    await b.checkPR(1, SHA, { statusOnly: true });
    assert.strictEqual(g.statuses[0].state, "success");
  });

  await test("renamed co-author, OLD noreply format (login@...): the old login doesn't resolve, so the commit goes to manual review", async () => {
    const b = freshModule();
    const g = makeGitHub({
      headSha: SHA,
      commits: [
        commit(1, 1, "alice", trailer(1, "OldName@users.noreply.github.com")),
      ],
      loginIds: {}, // GitHub: no such user any more
      signatures: [alice],
    });
    global.fetch = g.fetch;
    await b.checkPR(1, SHA);
    assert.strictEqual(g.statuses.length, 1);
    assert.strictEqual(g.statuses[0].state, "failure");
    assert.strictEqual(g.statuses[0].description, "Manual verification needed");
    const body = g.posted[g.posted.length - 1].body;
    assert.ok(
      body.includes("⚠️") && body.includes("c1"),
      "points a maintainer at the commit",
    );
    assert.ok(!/- @/.test(body), "nobody is asked to sign");
    assert.ok(
      !/oldname/i.test(body),
      "the address is not shown in the public comment",
    );
  });

  await test("old noreply format, account not renamed: found by login and fine once they have signed", async () => {
    const b = freshModule();
    const g = makeGitHub({
      headSha: SHA,
      commits: [
        commit(1, 1, "alice", trailer(1, "OldName@users.noreply.github.com")),
      ],
      loginIds: { OldName: 5 },
      signatures: [alice, { id: 5, login: "OldName" }],
    });
    global.fetch = g.fetch;
    await b.checkPR(1, SHA, { statusOnly: true });
    assert.strictEqual(g.statuses[0].state, "success");
  });

  await test("KNOWN LIMIT, old noreply format: if someone else now owns that login we can't tell, so they are the one asked to sign", async () => {
    const b = freshModule();
    const g = makeGitHub({
      headSha: SHA,
      commits: [
        commit(1, 1, "alice", trailer(1, "OldName@users.noreply.github.com")),
      ],
      loginIds: { OldName: 777 }, // a different person who took the freed name
      signatures: [alice],
    });
    global.fetch = g.fetch;
    await b.checkPR(1, SHA);
    assert.strictEqual(g.statuses[0].state, "failure");
    assert.ok(g.posted[g.posted.length - 1].body.includes("- @OldName"));
  });

  // -------------------------------------------------------------------------
  // 8. End to end at scale
  // -------------------------------------------------------------------------
  await test("at scale: 250 commits (3 pages), 250 distinct co-authors and a 230-comment PR give the right verdict with bounded concurrency and exactly one request per identity", async () => {
    const b = freshModule();
    const N = 250;
    const commits = Array.from({ length: N }, (_, i) =>
      commit(i, 10_000 + i, `author${i}`, trailer(i, newStyle(50_000 + i))),
    );
    const idLogins = Object.fromEntries(
      Array.from({ length: N }, (_, i) => [50_000 + i, `co${i}`]),
    );
    const signatures = [
      ...Array.from({ length: N }, (_, i) => ({
        id: 10_000 + i,
        login: `author${i}`,
      })),
      // One co-author has NOT signed, so the verdict must be a failure naming exactly them.
      ...Array.from({ length: N }, (_, i) => i)
        .filter((i) => i !== 123)
        .map((i) => ({ id: 50_000 + i, login: `co${i}` })),
    ];
    const comments = Array.from({ length: 230 }, (_, i) => ({
      id: i + 1,
      body: `chatter ${i}`,
      user: { login: "someone" },
    }));
    const g = makeGitHub({
      commits,
      idLogins,
      signatures,
      comments,
      headSha: "c".repeat(40),
    });
    global.fetch = g.fetch;

    await b.checkPR(1, "c".repeat(40));

    assert.strictEqual(g.statuses.length, 1);
    assert.strictEqual(g.statuses[0].state, "failure");
    assert.strictEqual(g.posted.length, 1, "one pending-signatures comment");
    assert.ok(
      g.posted[0].body.includes("@co123"),
      "names the co-author who has not signed",
    );
    assert.ok(
      !/@co1(?!23)\d*\b/.test(g.posted[0].body.replace("@co123", "")),
      "and nobody else",
    );
    const idCalls = g.calls.filter((c) => /^GET \/user\/\d+$/.test(c));
    assert.strictEqual(
      idCalls.length,
      N,
      "exactly one identity request per co-author",
    );
    assert.strictEqual(new Set(idCalls).size, N);
    assert.ok(
      g.t.max > 1 && g.t.max <= 8,
      `overlap within the bound, saw ${g.t.max}`,
    );
  });

  // -------------------------------------------------------------------------
  // 8. checkPR: the author list always belongs to the exact revision we
  //    report on, because it's read by comparing two fixed commit SHAs
  //
  // There used to be a pin-head / list-commits / re-read-head dance here,
  // because the old commits endpoint tracked the PR's live, moving head. A
  // force-push at exactly the wrong moment could still slip a mixed commit
  // list past that check (see git history / PR review for the details).
  // Comparing two fixed SHAs removes the moving target entirely: a commit
  // SHA can't change once it exists, so there's nothing left to race.
  // -------------------------------------------------------------------------
  const REV_A = "a".repeat(40);
  const REV_B = "b".repeat(40);

  // One PR, where the live head keeps moving (new pushes landing) while
  // checkPR() is mid-flight. `revs` maps a name to { sha, commits }.
  // `onPull(n, st)` runs after the n-th read of GET /pulls/1 and may advance
  // `st.rev`, simulating a push that lands between checkPR()'s one-time PR
  // read and its compare call.
  function makeRevisionedPR(revs, { signatures = [alice], onPull } = {}) {
    const g = makeGitHub({ signatures });
    const inner = g.fetch;
    const st = { rev: "A", pulls: 0 };
    g.st = st;
    g.fetch = async (url, opts = {}) => {
      const path = url.replace("https://api.github.com", "");
      if (/^\/repos\/fossasia\/testrepo\/pulls\/1$/.test(path)) {
        st.pulls += 1;
        const r = revs[st.rev];
        const out = res(200, { head: { sha: r.sha }, base: { sha: BASE_SHA } });
        if (onPull) onPull(st.pulls, st);
        return out;
      }
      if (path.startsWith("/repos/fossasia/testrepo/compare/")) {
        // A real compare call is pinned to two exact SHAs and answers the
        // same way no matter what else happens on the branch meanwhile, so
        // the mock looks up the revision by the head SHA in the URL - never
        // by "whichever revision is live now".
        const basehead = decodeURIComponent(
          path.split("/compare/")[1].split("?")[0],
        );
        const [, head] = basehead.split("...");
        const match = Object.values(revs).find((r) => r.sha === head);
        const all = match ? match.commits : [];
        // Paginate like GitHub: 100 per page, a Link header naming the last
        // page, and the full total on every page.
        const page = Number((path.match(/[&?]page=(\d+)/) || [])[1] || 1);
        const lastPage = Math.max(1, Math.ceil(all.length / 100));
        const headers =
          lastPage > 1
            ? {
                link: linkTo(
                  "/repos/fossasia/testrepo/compare/" + basehead,
                  lastPage,
                ),
              }
            : {};
        return res(
          200,
          {
            commits: all.slice((page - 1) * 100, page * 100),
            total_commits: all.length,
          },
          headers,
        );
      }
      return inner(url, opts);
    };
    return g;
  }

  await test("a push landing right after the PR is read: the old head is never published, the new head is evaluated and gets the status", async () => {
    const b = freshModule();
    const g = makeRevisionedPR(
      {
        A: { sha: REV_A, commits: [commit(1, 1, "alice")] },
        B: {
          sha: REV_B,
          commits: [commit(1, 1, "alice"), commit(2, 2, "bob")],
        },
      },
      // The push (A -> B) lands the instant the first GET /pulls/1 answers,
      // before the compare call is even made.
      { onPull: (n, st) => n === 1 && (st.rev = "B") },
    );
    global.fetch = g.fetch;
    await b.checkPR(1, undefined, { statusOnly: true });
    // The compare for A used pinned SHAs, so it was correct for A. But the
    // final look at the PR sees B, so A's "success" is dropped and B is
    // checked: bob has not signed, so B gets a failure and A gets nothing.
    assert.strictEqual(g.statuses.length, 1);
    assert.strictEqual(g.statuses[0].sha, REV_B);
    assert.strictEqual(g.statuses[0].state, "failure");
  });

  await test("event base A + event head H1, while the PR already reads head H2: nothing is published for H1 and B is never paired with H1", async () => {
    const b = freshModule();
    const A = "a1".repeat(20);
    const B = "b2".repeat(20);
    const H1 = "c3".repeat(20);
    const H2 = "d4".repeat(20);
    const g = makeGitHub({
      headSha: H2,
      baseSha: B,
      commits: [commit(1, 1, "alice")],
      signatures: [{ id: 1, login: "alice" }],
    });
    global.fetch = g.fetch;
    await b.checkPR(1, H1, { statusOnly: true, eventBaseSha: A });
    const compares = g.calls.filter((c) => c.includes("/compare/"));
    assert.strictEqual(compares.length, 1, "exactly one compare");
    assert.ok(compares[0].includes(`${A}...${H1}`), "compares the event's own pair");
    assert.ok(!compares[0].includes(B), "the PR's current base is never used");
    assert.strictEqual(
      g.calls.filter((c) => c.includes("/pulls/1")).length,
      1,
      "one PR read: the final check",
    );
    assert.strictEqual(g.statuses.length, 0, "H1 is stale, so no status for it");
    assert.strictEqual(g.posted.length, 0, "and no comment");
  });

  await test("more than 250 commits are all read through pagination, not capped - a signer past commit #250 is still caught", async () => {
    const b = freshModule();
    const N = 400;
    const commits = Array.from({ length: N }, (_, i) =>
      commit(i, 1 + i, `author${i}`),
    );
    const signatures = Array.from({ length: N }, (_, i) => ({
      id: 1 + i,
      login: `author${i}`,
    })).filter((s) => s.id !== 1 + 399); // everyone except the very last author
    const g = makeGitHub({ commits, signatures });
    global.fetch = g.fetch;
    await b.checkPR(1, DEFAULT_HEAD_SHA, { statusOnly: true });
    // All four pages of the compare were requested, not just the first.
    const comparePages = g.calls
      .filter((c) => c.includes("/compare/"))
      .map((c) => Number((c.match(/[&?]page=(\d+)/) || [])[1]))
      .sort((x, y) => x - y);
    assert.deepStrictEqual(comparePages, [1, 2, 3, 4]);
    assert.strictEqual(g.statuses.length, 1);
    assert.notStrictEqual(g.statuses[0].state, "success");
    assert.strictEqual(
      g.statuses[0].state,
      "failure",
      "the 400th commit's author is still checked, not silently dropped past a 250 cap",
    );
  });

  await test("listCommitsBetween: pages are fetched across the full range, in order, with no 250-commit cap", async () => {
    const b = freshModule();
    const commits = Array.from({ length: 400 }, (_, i) => commit(i, 1, "x"));
    const g = makeGitHub({ commits });
    global.fetch = g.fetch;
    const got = await b.listCommitsBetween(BASE_SHA, DEFAULT_HEAD_SHA, "t");
    assert.strictEqual(got.length, 400);
    assert.deepStrictEqual(
      got.map((c) => c.sha),
      commits.map((c) => c.sha),
    );
  });

  await test("listCommitsBetween: pagination handles page boundaries with Link metadata", async () => {
    const b = freshModule();
    for (const total of [0, 1, 100, 101, 199, 200, 201]) {
      const commits = Array.from({ length: total }, (_, i) =>
        commit(i, i + 1, `author${i}`),
      );
      const expectedPages = Math.ceil(total / 100);
      const calls = [];
      global.fetch = async (url) => {
        const page = Number((url.match(/[&?]page=(\d+)/) || [])[1] || 1);
        calls.push(page);
        const path = url.replace("https://api.github.com", "").split("?")[0];
        return res(
          200,
          {
            commits: commits.slice((page - 1) * 100, page * 100),
            total_commits: total,
          },
          expectedPages > 1 ? { link: linkTo(path, expectedPages) } : {},
        );
      };

      const got = await b.listCommitsBetween(BASE_SHA, DEFAULT_HEAD_SHA, "t");
      assert.deepStrictEqual(
        got.map((c) => c.sha),
        commits.map((c) => c.sha),
        `${total} commits`,
      );
      assert.deepStrictEqual(
        calls.sort((a, b) => a - b),
        Array.from({ length: Math.max(1, expectedPages) }, (_, i) => i + 1),
        `${total} commits: requests exactly the expected pages`,
      );
    }
  });

  await test("listCommitsBetween: total_commits controls the page range when Link is missing, malformed, low, or high", async () => {
    const b = freshModule();
    const cases = [
      { total: 201, link: null, pages: 3, name: "missing Link" },
      { total: 201, link: "not a Link header", pages: 3, name: "malformed Link" },
      {
        total: 201,
        link: '<https://api.github.com/r/compare?page=2>; rel="last"',
        pages: 3,
        name: "under-reported last page",
      },
      {
        total: 101,
        link: '<https://api.github.com/r/compare?page=3>; rel="last"',
        pages: 2,
        name: "over-reported last page",
      },
      {
        total: 100,
        link: '<https://api.github.com/r/compare?page=101>; rel="last"',
        pages: 1,
        name: "oversized last page contradicted by count",
      },
    ];
    for (const c of cases) {
      const commits = Array.from({ length: c.total }, (_, i) =>
        commit(i, i + 1, `author${i}`),
      );
      const calls = [];
      global.fetch = async (url) => {
        const page = Number((url.match(/[&?]page=(\d+)/) || [])[1] || 1);
        calls.push(page);
        return res(
          200,
          {
            commits: commits.slice((page - 1) * 100, page * 100),
            total_commits: c.total,
          },
          c.link ? { link: c.link } : {},
        );
      };

      const got = await b.listCommitsBetween(BASE_SHA, DEFAULT_HEAD_SHA, "t");
      assert.strictEqual(got.length, c.total, c.name);
      assert.deepStrictEqual(
        calls.sort((a, b) => a - b),
        Array.from({ length: c.pages }, (_, i) => i + 1),
        `${c.name}: fetch only count-derived pages`,
      );
    }
  });

  await test("checkPR: a PR move during a paginated compare cannot mix revisions or publish the old pair", async () => {
    const b = freshModule();
    const A = "a1".repeat(20);
    const B = "b2".repeat(20);
    const H = "c3".repeat(20);
    const commitsA = Array.from({ length: 101 }, (_, i) =>
      commit(i, i + 1, "alice"),
    );
    const commitsB = [
      ...commitsA.slice(0, 100),
      commit(100, 101, "bob"),
    ];
    const g = makeGitHub({
      headSha: H,
      baseSha: A,
      signatures: [{ id: 1, login: "alice" }],
    });
    const inner = g.fetch;
    let currentBase = A;
    let moved = false;
    const compareRequests = [];
    g.fetch = async (url, opts = {}) => {
      const path = url.replace("https://api.github.com", "");
      if (path.startsWith("/repos/fossasia/testrepo/compare/")) {
        const pair = decodeURIComponent(path.split("/compare/")[1].split("?")[0]);
        const page = Number((path.match(/[&?]page=(\d+)/) || [])[1] || 1);
        compareRequests.push({ pair, page });
        const rows = pair === `${A}...${H}` ? commitsA : commitsB;
        if (pair === `${A}...${H}` && page === 1 && !moved) {
          moved = true;
          currentBase = B;
        }
        return res(200, {
          commits: rows.slice((page - 1) * 100, page * 100),
          total_commits: rows.length,
        }, linkTo(path.split("?")[0], 2));
      }
      if (/^\/repos\/fossasia\/testrepo\/pulls\/1$/.test(path)) {
        return res(200, { head: { sha: H }, base: { sha: currentBase } });
      }
      return inner(url, opts);
    };
    global.fetch = g.fetch;

    await b.checkPR(1, undefined, { statusOnly: true });

    assert.deepStrictEqual(compareRequests, [
      { pair: `${A}...${H}`, page: 1 },
      { pair: `${A}...${H}`, page: 2 },
      { pair: `${B}...${H}`, page: 1 },
      { pair: `${B}...${H}`, page: 2 },
    ]);
    assert.strictEqual(g.statuses.length, 1, "only the confirmed pair is published");
    assert.strictEqual(g.statuses[0].sha, H);
    assert.strictEqual(g.statuses[0].state, "failure", "bob on B is unsigned");
  });

  await test("listCommitsBetween: when one page fails, the pages still queued are never sent (a failed list stops spending requests)", async () => {
    const calls = [];
    global.fetch = async (url) => {
      const page = Number(url.match(/[&?]page=(\d+)/)[1]);
      calls.push(page);
      await sleep(5);
      if (page === 2) return res(404, { message: "Not Found" });
      return res(
        200,
        { commits: Array(100).fill({}), total_commits: 3000 },
        { link: linkTo("/r/compare", 30) },
      );
    };
    await assert.rejects(() =>
      bot.listCommitsBetween(BASE_SHA, DEFAULT_HEAD_SHA, "t"),
    );
    // 30 pages were announced. Only page 1 and the 8 reads already in flight
    // can have gone out; the rest must never reach fetch.
    assert.ok(
      calls.length <= 9,
      `expected at most 9 requests, saw ${calls.length}: ${calls.join(",")}`,
    );
  });

  await test("listCommitsBetween: a page count that doesn't add up to GitHub's own total_commits is treated as a failed read, not a silent partial list", async () => {
    const b = freshModule();
    global.fetch = async (url) => {
      if (url.includes("/compare/")) {
        // GitHub says 5 commits but only returns 3 - e.g. a transient,
        // inconsistent read on GitHub's side. Trust the number, not the list.
        return res(200, {
          commits: [commit(1, 1, "a"), commit(2, 2, "b"), commit(3, 3, "c")],
          total_commits: 5,
        });
      }
      throw new Error(`unexpected request: ${url}`);
    };
    await assert.rejects(
      () => b.listCommitsBetween(BASE_SHA, DEFAULT_HEAD_SHA, "t"),
      /reported 5 commit\(s\).*returned 3/,
    );
  });

  await test("listCommitsBetween: total_commits must be a non-negative whole number matching the commits read - anything else fails closed", async () => {
    const b = freshModule();
    const two = [commit(1, 1, "a"), commit(2, 2, "b")];
    const cases = [
      { name: "missing", body: { commits: two }, ok: false },
      { name: "null", body: { commits: two, total_commits: null }, ok: false },
      { name: "string", body: { commits: two, total_commits: "2" }, ok: false },
      { name: "negative", body: { commits: two, total_commits: -2 }, ok: false },
      { name: "fractional", body: { commits: two, total_commits: 2.5 }, ok: false },
      { name: "unsafe integer", body: { commits: two, total_commits: 2 ** 60 }, ok: false },
      { name: "too small", body: { commits: two, total_commits: 1 }, ok: false },
      { name: "too large", body: { commits: two, total_commits: 3 }, ok: false },
      { name: "zero with commits present", body: { commits: two, total_commits: 0 }, ok: false },
      { name: "exact", body: { commits: two, total_commits: 2 }, ok: true, n: 2 },
      { name: "zero, empty compare", body: { commits: [], total_commits: 0 }, ok: true, n: 0 },
      { name: "zero, commits key absent", body: { total_commits: 0 }, ok: true, n: 0 },
    ];
    for (const c of cases) {
      global.fetch = async (url) => {
        if (url.includes("/compare/")) return res(200, c.body);
        throw new Error(`unexpected request: ${url}`);
      };
      const run = () => b.listCommitsBetween(BASE_SHA, DEFAULT_HEAD_SHA, "t");
      if (c.ok) {
        assert.strictEqual((await run()).length, c.n, c.name);
      } else {
        await assert.rejects(run, /total_commits|pagination returned|reported/, c.name);
      }
    }
  });

  await test("listCommitsBetween: a matching count is rejected when commit SHAs are missing or repeated", async () => {
    const b = freshModule();
    const firstPage = Array.from({ length: 100 }, (_, i) =>
      commit(i, i + 1, `author${i}`),
    );
    const cases = [
      {
        name: "duplicate within one page",
        total: 2,
        pages: [[commit(1, 1, "a"), commit(1, 1, "a")]],
        error: /duplicate commit SHA/,
      },
      {
        name: "duplicate across pages replaces an omitted commit",
        total: 101,
        pages: [firstPage, [commit(0, 1, "author0")]],
        error: /duplicate commit SHA/,
      },
      {
        name: "SHA comparison is case-insensitive",
        total: 2,
        pages: [[commit(1, 1, "a"), commit(1, 1, "a", "", { sha: "C1" })]],
        error: /duplicate commit SHA/,
      },
      {
        name: "missing SHA",
        total: 2,
        pages: [[commit(1, 1, "a"), { author: { id: 2, login: "b" } }]],
        error: /without a valid SHA/,
      },
      {
        name: "empty SHA",
        total: 2,
        pages: [[commit(1, 1, "a"), commit(2, 2, "b", "", { sha: "" })]],
        error: /without a valid SHA/,
      },
      {
        name: "non-string SHA",
        total: 2,
        pages: [[commit(1, 1, "a"), commit(2, 2, "b", "", { sha: 2 })]],
        error: /without a valid SHA/,
      },
      {
        name: "whitespace-padded SHA",
        total: 2,
        pages: [[commit(1, 1, "a"), commit(2, 2, "b", "", { sha: " c2 " })]],
        error: /without a valid SHA/,
      },
    ];

    for (const c of cases) {
      const calls = [];
      global.fetch = async (url) => {
        const page = Number((url.match(/[&?]page=(\d+)/) || [])[1] || 1);
        calls.push(page);
        const path = url.replace("https://api.github.com", "").split("?")[0];
        return res(
          200,
          { commits: c.pages[page - 1] || [], total_commits: c.total },
          c.pages.length > 1 && page === 1
            ? { link: linkTo(path, c.pages.length) }
            : {},
        );
      };
      await assert.rejects(
        () => b.listCommitsBetween(BASE_SHA, DEFAULT_HEAD_SHA, "t"),
        c.error,
        c.name,
      );
      assert.strictEqual(calls.length, c.pages.length, `${c.name}: all expected pages read`);
    }
  });

  await test("listCommitsBetween: a response with no total_commits is a failed read, never a list passed on trust", async () => {
    const b = freshModule();
    global.fetch = async (url) => {
      if (url.includes("/compare/")) return res(200, { commits: [commit(1, 1, "a")] });
      throw new Error(`unexpected request: ${url}`);
    };
    await assert.rejects(
      () => b.listCommitsBetween(BASE_SHA, DEFAULT_HEAD_SHA, "t"),
      /total_commits/,
    );
  });

  await test("checkPR on a PR that does not move: one read at the start, one before publishing, one after publishing to confirm it's still valid - one compare call, no re-evaluation", async () => {
    const b = freshModule();
    const g = makeRevisionedPR({
      A: { sha: REV_A, commits: [commit(1, 1, "alice")] },
    });
    global.fetch = g.fetch;
    await b.checkPR(1, undefined, { statusOnly: true });
    assert.strictEqual(
      g.st.pulls,
      3,
      "one PR read to start, one right before publishing, one right after - there's no atomic GitHub primitive for that publish, so it's confirmed on both sides",
    );
    assert.strictEqual(g.statuses.length, 1);
    assert.strictEqual(g.statuses[0].state, "success");
  });



  await test("createReadGroup: after abort() a queued read fails without sending a request", async () => {
    const group = bot.createReadGroup();
    const sent = [];
    global.fetch = async (url) => {
      sent.push(url);
      return res(200, []);
    };
    group.abort();
    await assert.rejects(() => group.read("/r/x", "t"), /cancelled/);
    assert.deepStrictEqual(sent, [], "nothing was sent after abort");
  });

  await test("allOrAbort: a failing read aborts the group, so the rest of the group is cancelled", async () => {
    const group = bot.createReadGroup();
    await assert.rejects(
      () =>
        bot.allOrAbort(group, [
          Promise.reject(new Error("boom")),
          Promise.resolve(1),
        ]),
      /boom/,
    );
    await assert.rejects(() => group.read("/r/x", "t"), /cancelled/);
  });

  await test("listCommitsBetween: a compare answer with no body at all fails closed (no total_commits to check)", async () => {
    global.fetch = async (url) => {
      if (url.includes("/compare/")) return res(200, null);
      throw new Error(`unexpected request: ${url}`);
    };
    await assert.rejects(
      () => bot.listCommitsBetween(BASE_SHA, DEFAULT_HEAD_SHA, "t"),
      /total_commits/,
    );
  });

  // -------------------------------------------------------------------------
  // 5. Page limits for the commit list
  // -------------------------------------------------------------------------
  await test("listCommitsBetween: a compare that needs more than 100 pages fails after one request, whether total_commits or the Link header says so", async () => {
    for (const [total, header, why] of [
      [10001, null, "total_commits"],
      [
        10001,
        '<https://api.github.com/x?page=101>; rel="last"',
        "total_commits and Link header",
      ],
    ]) {
      const calls = [];
      global.fetch = async (url) => {
        calls.push(url);
        return res(
          200,
          { commits: Array(100).fill({}), total_commits: total },
          header ? { link: header } : {},
        );
      };
      await assert.rejects(
        () => bot.listCommitsBetween(BASE_SHA, DEFAULT_HEAD_SHA, "t"),
        /more than 100 pages/,
        why,
      );
      assert.strictEqual(calls.length, 1, `${why}: no fan-out, no walk`);
    }
  });

  await test("listCommitsBetween: with no usable header, exactly 10,000 commits (total_commits says so) is accepted and stops right at page 100", async () => {
    const calls = [];
    global.fetch = async (url) => {
      const page = Number(url.match(/[&?]page=(\d+)/)[1]);
      calls.push(page);
      return res(200, {
        commits: Array.from({ length: 100 }, (_, i) => ({ sha: `page-${page}-commit-${i}` })),
        total_commits: 10000,
      });
    };
    const got = await bot.listCommitsBetween(BASE_SHA, DEFAULT_HEAD_SHA, "t");
    assert.strictEqual(got.length, 10000);
    assert.strictEqual(
      calls.length,
      100,
      "total_commits already says there are exactly 10,000, so page 101 is never requested",
    );
  });

  await test("listCommitsBetween: the 9,999 and 10,000 commit boundaries agree with a valid Link last page", async () => {
    for (const total of [9999, 10000]) {
      const expectedPages = Math.ceil(total / 100);
      const calls = [];
      global.fetch = async (url) => {
        const page = Number(url.match(/[&?]page=(\d+)/)[1]);
        calls.push(page);
        const path = url.replace("https://api.github.com", "").split("?")[0];
        return res(
          200,
          {
            commits: Array.from(
              { length: Math.min(100, total - (page - 1) * 100) },
              (_, i) => ({ sha: `page-${page}-commit-${i}` }),
            ),
            total_commits: total,
          },
          page === 1 ? { link: linkTo(path, expectedPages) } : {},
        );
      };
      const got = await bot.listCommitsBetween(BASE_SHA, DEFAULT_HEAD_SHA, "t");
      assert.strictEqual(got.length, total, `${total} commits`);
      assert.deepStrictEqual(
        calls.sort((a, b) => a - b),
        Array.from({ length: expectedPages }, (_, i) => i + 1),
        `${total} commits: Link and total agree through the final page`,
      );
    }
  });

  await test("listCommitsBetween: with no usable header, the walk stops as soon as total_commits is reached - more items than promised is still caught as a mismatch, not silently accepted", async () => {
    const calls = [];
    global.fetch = async (url) => {
      calls.push(Number(url.match(/[&?]page=(\d+)/)[1]));
      // total_commits says 9999, but every page keeps coming back full, so
      // by the time 9999 is reached the walk has actually read 10,000.
      return res(200, { commits: Array(100).fill({}), total_commits: 9999 });
    };
    await assert.rejects(
      () => bot.listCommitsBetween(BASE_SHA, DEFAULT_HEAD_SHA, "t"),
      /reported 9999 commit\(s\).*returned 10000/,
    );
    assert.strictEqual(
      calls.length,
      100,
      "stops the moment total_commits is reached or passed, no 101st page",
    );
  });

  // -------------------------------------------------------------------------
  // 6. Comment history does not depend on page boundaries
  // -------------------------------------------------------------------------
  const BOT_MARK = "<!-- fossasia-cla-bot:v1 -->";
  const pagedBotComment = (id, kind) => ({
    id,
    user: { login: "github-actions[bot]", type: "Bot" },
    body: `${BOT_MARK}\n<!-- fossasia-cla-bot:${kind} -->`,
  });
  const human = (id) => ({ id, user: { login: "human" }, body: "hi" });
  const noBotLogin = (url) => /\/user$/.test(url);

  await test("getExistingBotComments: a comment added while the pages are read shifts a page boundary (every page still a valid size), and each bot comment still shows up once, in id order", async () => {
    const b = freshModule();
    // 250 comments: pages of 100, 100 and 50.
    const list = Array.from({ length: 250 }, (_, i) => human(i + 1));
    list[99] = pagedBotComment(100, "pending"); // last item of page 1
    list[199] = pagedBotComment(200, "success");
    let shifted = false;
    global.fetch = async (url) => {
      if (noBotLogin(url)) return res(403, { message: "no" });
      const page = Number(url.match(/[&?]page=(\d+)/)[1]);
      const out = list.slice((page - 1) * 100, page * 100);
      if (!shifted) {
        // Right after page 1 is served, something is added in front. Page 2
        // now starts one item earlier, so comment 100 comes back again.
        shifted = true;
        list.unshift(human(0));
      }
      return res(200, out, { link: linkTo("/r/comments", 3) });
    };
    const found = await b.getExistingBotComments(1);
    assert.deepStrictEqual(
      found.map((c) => c.id),
      [100, 200],
      "comment 100 is listed once, not twice",
    );
  });

  await test("getExistingBotComments: a repeated or out-of-order entry is skipped, so each bot comment shows up once and the result stays in ascending id order", async () => {
    const b = freshModule();
    global.fetch = async (url) => {
      if (noBotLogin(url)) return res(403, { message: "no" });
      // GitHub lists by ascending id. 20 comes back twice, and 15 arrives
      // after 20: neither is a new comment.
      return res(200, [
        pagedBotComment(10, "pending"),
        human(12),
        pagedBotComment(20, "pending"),
        pagedBotComment(20, "pending"),
        pagedBotComment(15, "pending"),
        pagedBotComment(30, "success"),
      ]);
    };
    assert.deepStrictEqual(
      (await b.getExistingBotComments(1)).map((c) => c.id),
      [10, 20, 30],
    );
  });

  await test("getExistingBotComments: an entry without a usable id is skipped without disturbing valid ids around it", async () => {
    const b = freshModule();
    const noId = { ...pagedBotComment(0, "pending"), id: undefined };
    global.fetch = async (url) => {
      if (noBotLogin(url)) return res(403, { message: "no" });
      return res(200, [
        pagedBotComment(10, "pending"),
        noId,
        pagedBotComment(10, "pending"),
        pagedBotComment(20, "success"),
      ]);
    };
    assert.deepStrictEqual(
      (await b.getExistingBotComments(1)).map((c) => c.id),
      [10, 20],
    );
  });

  await test("postComment: a comment the listing returns twice is not seen as its own duplicate, so the cleanup deletes nothing", async () => {
    const b = freshModule();
    const body = "Please sign";
    const full = `${BOT_MARK}\n${body}`;
    const old = { ...pagedBotComment(7, "x"), body: `${BOT_MARK}\nold text` };
    const mine = {
      id: 8,
      user: { login: "github-actions[bot]", type: "Bot" },
      body: full,
    };
    const deletes = [];
    let created = false;
    global.fetch = async (url, opts = {}) => {
      const method = (opts.method || "GET").toUpperCase();
      if (noBotLogin(url)) return res(403, { message: "no" });
      if (method === "DELETE") {
        deletes.push(url);
        return res(204, null);
      }
      if (method === "POST") {
        created = true;
        return res(201, mine);
      }
      // After the post, the listing repeats the new comment.
      return res(200, created ? [old, mine, mine] : [old]);
    };
    await b.postComment(1, body);
    assert.ok(created, "the new comment was posted");
    assert.deepStrictEqual(deletes, [], "the only copy is not deleted");
  });

  // -------------------------------------------------------------------------
  // 7. The PR is checked again right before a result is published
  // -------------------------------------------------------------------------
  // GET /pulls/1 answers with whatever `prAt(readNumber)` says. Compare
  // answers by BASE: only the pair based on `A` leaves bob out.
  function makeMovingBase(prAt) {
    const g = makeGitHub({ signatures: [{ id: 1, login: "alice" }] });
    const inner = g.fetch;
    g.prReads = 0;
    g.fetch = async (url, opts) => {
      const path = url.replace("https://api.github.com", "");
      if (/^\/repos\/fossasia\/testrepo\/pulls\/1$/.test(path)) {
        g.prReads += 1;
        g.calls.push(`GET ${path}`);
        const { head, base } = prAt(g.prReads);
        return res(200, { head: { sha: head }, base: { sha: base } });
      }
      if (path.includes("/compare/")) {
        g.calls.push(`GET ${path}`);
        const base = decodeURIComponent(path.split("/compare/")[1]).split(
          "...",
        )[0];
        const commits =
          base === "a1".repeat(20)
            ? [commit(1, 1, "alice")]
            : [commit(1, 1, "alice"), commit(2, 2, "bob")];
        return res(200, { commits, total_commits: commits.length });
      }
      return inner(url, opts);
    };
    return g;
  }

  await test("checkPR: if the base moves while the event's pair is being checked, the PR is checked again against the new base before anything is published", async () => {
    const b = freshModule();
    const A = "a1".repeat(20);
    const B = "b2".repeat(20);
    const H = "c3".repeat(20);
    // Evaluated against A, only alice is on the PR (signed). The PR now has
    // base B, where bob's unsigned commit is part of it too.
    const g = makeMovingBase(() => ({ head: H, base: B }));
    global.fetch = g.fetch;
    await b.checkPR(1, H, { statusOnly: true, eventBaseSha: A });
    const compares = g.calls.filter((c) => c.includes("/compare/"));
    assert.strictEqual(compares.length, 2, "A...H, then B...H");
    assert.ok(compares[0].includes(`${A}...${H}`));
    assert.ok(compares[1].includes(`${B}...${H}`));
    assert.strictEqual(g.statuses.length, 1, "published once, not for A...H");
    assert.strictEqual(g.statuses[0].sha, H);
    assert.strictEqual(g.statuses[0].state, "failure", "bob has not signed");
  });

  await test("checkPR: a PR whose base keeps changing is never certified: it gives up after 3 checks, publishes nothing and says so", async () => {
    const b = freshModule();
    const A = "a1".repeat(20);
    const H = "c3".repeat(20);
    const bases = [A, ...["b1", "b2", "b3"].map((x) => x.repeat(20))];
    const g = makeMovingBase((n) => ({ head: H, base: bases[n - 1] }));
    global.fetch = g.fetch;
    await assert.rejects(
      () => b.checkPR(1, H, { statusOnly: true }),
      /kept changing.*3 attempts/,
    );
    assert.strictEqual(
      g.calls.filter((c) => c.includes("/compare/")).length,
      3,
    );
    assert.strictEqual(g.statuses.length, 0, "no status");
    assert.strictEqual(g.posted.length, 0, "no comment");
  });

  // -------------------------------------------------------------------------
  // 8. The final base/head check and the status write are two separate HTTP
  //    calls, so GitHub gives us no way to make them atomic. checkPR() now
  //    reads the PR once more right AFTER publishing too, and treats that
  //    the same way as the pre-publish check above: a base that moved onto
  //    the very same head is re-evaluated and re-published instead of being
  //    left alone. These tests are the missing regression test the review
  //    repeatedly asked for.
  // -------------------------------------------------------------------------
  await test("checkPR: a base change landing right after a successful publish is caught and corrected - the stale 'success' is not left standing", async () => {
    const b = freshModule();
    const A = "a1".repeat(20);
    const B = "b2".repeat(20);
    const H = "c3".repeat(20);
    // Read 1: base=A, still matches the pinned pair -> publish (success, only
    // alice). Read 2 (right after that publish): base has already moved to
    // B -> the status we just wrote is stale, go around again. Reads 3 and 4:
    // base=B, stable -> publish the corrected result (failure, bob hasn't
    // signed) and confirm it holds.
    const bases = [A, B, B, B];
    const g = makeMovingBase((n) => ({ head: H, base: bases[n - 1] }));
    global.fetch = g.fetch;
    await b.checkPR(1, H, { statusOnly: true, eventBaseSha: A });
    const compares = g.calls.filter((c) => c.includes("/compare/"));
    assert.strictEqual(compares.length, 2, "A...H (now stale), then B...H (the correction)");
    assert.ok(compares[0].includes(`${A}...${H}`));
    assert.ok(compares[1].includes(`${B}...${H}`));
    // Both statuses land on the same head SHA - GitHub only shows the latest
    // one, so what matters for safety is that the LAST write is the
    // corrected result, not the stale success evaluated against the old base.
    assert.strictEqual(
      g.statuses.length,
      2,
      "the stale success is overwritten by a fresh evaluation, not left standing",
    );
    assert.strictEqual(g.statuses[0].sha, H);
    assert.strictEqual(
      g.statuses[0].state,
      "success",
      "correct for A...H at the moment it was published",
    );
    assert.strictEqual(g.statuses[1].sha, H);
    assert.strictEqual(
      g.statuses[1].state,
      "failure",
      "the published result is corrected once the base-drift to B...H (bob unsigned) is caught",
    );
  });

  await test("checkPR: a PR whose base keeps moving right after every publish is never left on a stale status - it's overwritten with a conservative failure once attempts run out", async () => {
    const b = freshModule();
    const A = "a1".repeat(20);
    const H = "c3".repeat(20);
    // base=A only for the very first read (so the first publish happens and
    // succeeds); every read after that reports a different, never-repeating
    // base, so the post-publish check always finds the PR has already moved
    // on again, attempt after attempt.
    const bases = ["a1", "b2", "b2", "c3", "c3", "d4"].map((x) => x.repeat(20));
    const g = makeMovingBase((n) => ({ head: H, base: bases[n - 1] }));
    global.fetch = g.fetch;
    await assert.rejects(
      () => b.checkPR(1, H, { statusOnly: true, eventBaseSha: A }),
      /kept changing.*3 attempts/,
    );
    assert.strictEqual(
      g.calls.filter((c) => c.includes("/compare/")).length,
      3,
      "one evaluation per attempt",
    );
    // 3 attempts each publish once (the pre-publish check matched every
    // time), plus one final conservative overwrite once every attempt is
    // spent - never a status left over from a pair already known to be stale.
    assert.strictEqual(g.statuses.length, 4);
    const last = g.statuses[g.statuses.length - 1];
    assert.strictEqual(last.sha, H);
    assert.strictEqual(
      last.state,
      "failure",
      "fails closed rather than trusting whatever was last written",
    );
  });

  await test("checkPR: the head moving on right after a successful publish needs no correction - the status is already bound to the old head, and the new head's own event covers it", async () => {
    const b = freshModule();
    const g = makeRevisionedPR(
      {
        A: { sha: REV_A, commits: [commit(1, 1, "alice")] },
        B: { sha: REV_B, commits: [commit(1, 1, "alice"), commit(2, 2, "bob")] },
      },
      // The push (A -> B) lands between the pre-publish check (still A, so
      // the publish for A goes ahead) and the post-publish check (now B).
      { onPull: (n, st) => n === 2 && (st.rev = "B") },
    );
    global.fetch = g.fetch;
    await b.checkPR(1, REV_A, { statusOnly: true });
    // Read 1: initial read, still A. Read 2: the pre-publish check, still A
    // -> publish goes ahead. Read 3: the post-publish check, now B.
    assert.strictEqual(g.st.pulls, 3);
    assert.strictEqual(g.statuses.length, 1, "nothing more is published for A");
    assert.strictEqual(g.statuses[0].sha, REV_A);
    assert.strictEqual(g.statuses[0].state, "success");
  });

  await test("checkPR: the co-author lookup budget is shared across every re-evaluation attempt in one run, not reset per attempt", async () => {
    const b = freshModule();
    const A = "a1".repeat(20);
    const B = "b2".repeat(20);
    const H = "c3".repeat(20);

    // Revision A: 15 commits x 20 distinct new-style trailers = exactly 300
    // distinct co-author ids - the whole run's budget, spent by itself.
    const idsA = Array.from({ length: 300 }, (_, i) => 1 + i);
    const commitsA = Array.from({ length: 15 }, (_, i) => {
      const slice = idsA.slice(i * 20, i * 20 + 20);
      return commit(
        `a${i}`,
        9000 + i,
        `author${i}`,
        slice.map((id) => trailer(id, newStyle(id))).join("\n"),
      );
    });
    // What the base moves to: one commit with 20 BRAND NEW ids the budget
    // has never seen. If the budget were wrongly reset per attempt, these
    // would resolve fine with a fresh 300-slot budget of their own.
    const idsB = Array.from({ length: 20 }, (_, i) => 301 + i);
    const commitsB = [
      commit(
        "b0",
        9100,
        "authorB",
        idsB.map((id) => trailer(id, newStyle(id))).join("\n"),
      ),
    ];

    const idLogins = Object.fromEntries(
      [...idsA, ...idsB].map((id) => [id, `co${id}`]),
    );
    const signatures = [
      ...Array.from({ length: 15 }, (_, i) => ({
        id: 9000 + i,
        login: `author${i}`,
      })),
      ...idsA.map((id) => ({ id, login: `co${id}` })),
    ];

    const g = makeGitHub({ idLogins, signatures, headSha: H, baseSha: A });
    const inner = g.fetch;
    let pulls = 0;
    g.fetch = async (url, opts = {}) => {
      const path = url.replace("https://api.github.com", "");
      if (/^\/repos\/fossasia\/testrepo\/pulls\/1$/.test(path)) {
        pulls += 1;
        // Only the very first read (the pre-publish check for A) still says
        // A; every read after that - including the post-publish check that
        // triggers the re-evaluation - already reports the base moved to B.
        const base = pulls <= 1 ? A : B;
        return res(200, { head: { sha: H }, base: { sha: base } });
      }
      if (path.startsWith("/repos/fossasia/testrepo/compare/")) {
        const basehead = decodeURIComponent(
          path.split("/compare/")[1].split("?")[0],
        );
        const base = basehead.split("...")[0];
        const commits = base === A ? commitsA : commitsB;
        return res(200, { commits, total_commits: commits.length });
      }
      return inner(url, opts);
    };
    global.fetch = g.fetch;

    await b.checkPR(1, H, { statusOnly: true, eventBaseSha: A });

    const idCalls = g.calls.filter((c) => /^GET \/user\/\d+$/.test(c));
    assert.strictEqual(
      idCalls.length,
      300,
      "exactly the run's budget worth of lookups happened, all spent on A",
    );
    assert.ok(
      idsB.every((id) => !idCalls.includes(`GET /user/${id}`)),
      "B's brand-new co-authors were never looked up - the shared budget was already spent on A, so B's trailers are flagged unresolved instead",
    );
    assert.strictEqual(
      g.statuses.length,
      2,
      "A's success, then B's corrected failure (unresolved co-authors)",
    );
    assert.strictEqual(g.statuses[1].state, "failure");
  });

  // -------------------------------------------------------------------------
  // 9. A real failure (not just a stale pair) after a status has already
  //    landed: checkPR() must not let that status stand unconfirmed, and
  //    failClosedStatus()'s own best-effort recovery write can itself fail
  //    without masking the original error.
  // -------------------------------------------------------------------------
  await test("checkPR: a hard failure after a successful publish still fails closed, and a failed recovery write doesn't mask the original error", async () => {
    const b = freshModule();
    const A = "a1".repeat(20);
    const B = "b2".repeat(20);
    const H = "c3".repeat(20);
    const g = makeGitHub({
      commits: [commit(1, 1, "alice")],
      signatures: [{ id: 1, login: "alice" }],
      headSha: H,
      baseSha: A,
    });
    const inner = g.fetch;
    let pulls = 0;
    let statusCalls = 0;
    g.fetch = async (url, opts = {}) => {
      const path = url.replace("https://api.github.com", "");
      if (/^\/repos\/fossasia\/testrepo\/pulls\/1$/.test(path)) {
        pulls += 1;
        // Read 1 (before publishing attempt 1): still A -> publish succeeds.
        // Read 2 (right after): base has moved to B -> go around again.
        const base = pulls <= 1 ? A : B;
        return res(200, { head: { sha: H }, base: { sha: base } });
      }
      if (path.startsWith("/repos/fossasia/testrepo/compare/")) {
        if (path.includes(`${B}...${H}`)) {
          // Attempt 2's evaluation hits a hard failure - not a stale pair,
          // a real error (e.g. the GitHub API itself breaking).
          throw new Error("simulated transient GitHub failure");
        }
        return inner(url, opts);
      }
      if (path.startsWith("/repos/fossasia/testrepo/statuses/")) {
        statusCalls += 1;
        if (statusCalls === 1) return inner(url, opts); // A's success lands
        // The fail-closed recovery write itself fails. 400 (not 5xx/429), so
        // gh() does not retry it - keeps this test fast and deterministic.
        return res(400, { message: "Bad Request" });
      }
      return inner(url, opts);
    };
    global.fetch = g.fetch;

    await assert.rejects(
      () => b.checkPR(1, H, { statusOnly: true, eventBaseSha: A }),
      /simulated transient GitHub failure/,
      "the ORIGINAL error surfaces, not the recovery write's own failure",
    );
    assert.strictEqual(
      statusCalls,
      2,
      "the first publish, then one attempted (and failed) fail-closed overwrite",
    );
    assert.strictEqual(
      g.statuses.length,
      1,
      "only the first (A's success) write actually landed on GitHub",
    );
  });

  await test("checkPR: a failed post-publish PR re-read overwrites the uncertain status and surfaces the read error", async () => {
    const b = freshModule();
    const A = "a1".repeat(20);
    const H = "c3".repeat(20);
    const g = makeGitHub({
      commits: [commit(1, 1, "alice")],
      signatures: [{ id: 1, login: "alice" }],
      headSha: H,
      baseSha: A,
    });
    const inner = g.fetch;
    let pulls = 0;
    g.fetch = async (url, opts = {}) => {
      const path = url.replace("https://api.github.com", "");
      if (/^\/repos\/fossasia\/testrepo\/pulls\/1$/.test(path)) {
        pulls += 1;
        if (pulls === 2) {
          return res(400, { message: "Simulated post-publish read failure" });
        }
      }
      return inner(url, opts);
    };
    global.fetch = g.fetch;

    await assert.rejects(
      () => b.checkPR(1, H, { statusOnly: true, eventBaseSha: A }),
      (error) =>
        error.status === 400 &&
        /Simulated post-publish read failure/.test(error.message),
    );
    assert.strictEqual(pulls, 2);
    assert.deepStrictEqual(
      g.statuses.map((status) => status.state),
      ["success", "failure"],
      "the unconfirmed success is overwritten with a fail-closed result",
    );
    assert.ok(g.statuses.every((status) => status.sha === H));
  });

  await test("checkPR: when the main budget's OWN exhaustion is what triggers the catch, failClosedStatus()'s recovery write still gets out - the emergency reserve is what makes that possible, not luck", async () => {
    const b = freshModule();
    const A = "a1".repeat(20);
    const B = "b2".repeat(20);
    const H = "c3".repeat(20);
    const g = makeGitHub({
      commits: [commit(1, 1, "alice")],
      signatures: [{ id: 1, login: "alice" }],
      headSha: H,
      baseSha: A,
    });
    let pulls = 0;
    const inner = g.fetch;
    g.fetch = async (url, opts = {}) => {
      const path = url.replace("https://api.github.com", "");
      if (/^\/repos\/fossasia\/testrepo\/pulls\/1$/.test(path)) {
        pulls += 1;
        const base = pulls <= 1 ? A : B; // base drifts right after the first publish
        return res(200, { head: { sha: H }, base: { sha: base } });
      }
      return inner(url, opts);
    };
    global.fetch = g.fetch;

    // A tiny outer budget (see runWithGitHubTokenRequestBudget()'s
    // reentrancy: checkPR() reuses this instead of starting its own 700/10
    // one). 5 normal requests exactly covers attempt 1 end to end (compare,
    // signature read, pre-publish confirm, the status write itself,
    // post-publish confirm that finds the drift to B) - attempt 2's first
    // request (its compare call) is then the 6th, and finds nothing left.
    await assert.rejects(
      () =>
        b.runWithGitHubTokenRequestBudget(7, 2, () =>
          b.checkPR(1, H, { statusOnly: true, eventBaseSha: A }),
        ),
      (e) => e.budgetExhausted === true,
      "the ORIGINAL error (budget exhaustion) still surfaces",
    );
    assert.strictEqual(
      g.statuses.length,
      2,
      "A's success, then the reserve-funded recovery failure - not left on the stale success",
    );
    assert.strictEqual(g.statuses[0].state, "success");
    assert.strictEqual(
      g.statuses[1].state,
      "failure",
      "failClosedStatus() got its write out even though the SAME exhaustion that triggered it had already emptied the main pool",
    );
  });

  await test("ghRaw: each actual attempt (gh()'s retries included) spends its own reserve slot, not one shared slot per logical call", async () => {
    const b = freshModule();
    global.fetch = async () => res(200, { ok: true });
    await b.runWithGitHubTokenRequestBudget(0, 3, async () => {
      // Three separate attempts, exactly what gh()'s own retry loop would
      // make for one logical call that failed transiently twice before
      // succeeding - ghRaw() doesn't know or care that they're "the same"
      // logical write, so each spends its own slot of the reserve.
      await b.ghRaw("/r/attempt-1", process.env.GITHUB_TOKEN, {
        emergency: true,
      });
      await b.ghRaw("/r/attempt-2", process.env.GITHUB_TOKEN, {
        emergency: true,
      });
      await b.ghRaw("/r/attempt-3", process.env.GITHUB_TOKEN, {
        emergency: true,
      });
      // The reserve (3) is exactly spent now - a 4th, from a main pool
      // that's also 0, has nothing left in either pool.
      await assert.rejects(() =>
        b.ghRaw("/r/attempt-4", process.env.GITHUB_TOKEN, { emergency: true }),
      );
    });
  });

  await test("ghRaw: the run-wide GITHUB_TOKEN request budget is a hard ceiling, counting every actual attempt", async () => {
    const b = freshModule();
    global.fetch = async () => res(200, { ok: true });
    await b.runWithGitHubTokenRequestBudget(2, 0, async () => {
      await b.ghRaw("/r/one", process.env.GITHUB_TOKEN);
      await b.ghRaw("/r/two", process.env.GITHUB_TOKEN);
      await assert.rejects(
        () => b.ghRaw("/r/three", process.env.GITHUB_TOKEN),
        (e) => e.budgetExhausted === true && /budget/.test(e.message),
      );
      // A different token (e.g. the signatures repo's own installation
      // token) has its own separate quota and is never gated by this one.
      await b.ghRaw("/r/four", "a-completely-different-token");
    });
    // Outside any runWithGitHubTokenRequestBudget() call, there's no active
    // store, so nothing is gated - confirms tracking doesn't leak out.
    await b.ghRaw("/r/five", process.env.GITHUB_TOKEN);
  });

  await test("ghRaw: the emergency reserve is untouched by normal requests, and only draws down once the main budget is spent", async () => {
    const b = freshModule();
    global.fetch = async () => res(200, { ok: true });
    // max=2, reserve=1: the reserve is carved OUT of max (see
    // runWithGitHubTokenRequestBudget()), so this leaves exactly 1 normal
    // slot (2 - 1) plus the 1 reserved slot - 2 total, never more than max.
    await b.runWithGitHubTokenRequestBudget(2, 1, async () => {
      await b.ghRaw("/r/normal", process.env.GITHUB_TOKEN); // spends the 1 main slot
      // A normal request now has nothing left in the main budget and is
      // refused...
      await assert.rejects(() =>
        b.ghRaw("/r/blocked", process.env.GITHUB_TOKEN),
      );
      // ...but an emergency one still has the untouched reserve to draw on.
      await b.ghRaw("/r/emergency", process.env.GITHUB_TOKEN, {
        emergency: true,
      });
      // Now both are spent - even an emergency request is refused.
      await assert.rejects(() =>
        b.ghRaw("/r/emergency-2", process.env.GITHUB_TOKEN, {
          emergency: true,
        }),
      );
    });
  });

  await test("runWithGitHubTokenRequestBudget: a nested call reuses the outer budget instead of starting a fresh one - this is what lets a signing comment's pre-checkPR() signature traffic share checkPR()'s own budget", async () => {
    const b = freshModule();
    global.fetch = async () => res(200, { ok: true });
    await b.runWithGitHubTokenRequestBudget(2, 0, async () => {
      await b.ghRaw("/r/one", process.env.GITHUB_TOKEN); // spends 1 of the outer 2
      // A nested call, even with a much larger budget of its own, must NOT
      // get a fresh allowance - it has to share what's left of the outer
      // one, exactly as checkPR() shares handleIssueComment()'s budget.
      await b.runWithGitHubTokenRequestBudget(700, 10, async () => {
        await b.ghRaw("/r/two", process.env.GITHUB_TOKEN); // spends the last of the OUTER 2
        await assert.rejects(() => b.ghRaw("/r/three", process.env.GITHUB_TOKEN));
      });
    });
  });

  await test("runWithGitHubTokenRequestBudget: two overlapping calls never share or clobber each other's budget - the exact race a single module-global counter would have", async () => {
    const b = freshModule();
    global.fetch = async () => res(200, { ok: true });
    const order = [];

    const runA = b.runWithGitHubTokenRequestBudget(1, 0, async () => {
      await b.ghRaw("/r/a1", process.env.GITHUB_TOKEN); // spends A's only slot
      order.push("A spent its slot");
      // Simulate A still being "in flight" while B starts AND finishes an
      // entirely separate, larger budget of its own.
      await new Promise((r) => setTimeout(r, 20));
      order.push("A resumes");
      // A's own budget must still be exhausted here - B completing (and
      // tearing down its own store) must not have touched A's.
      await assert.rejects(() => b.ghRaw("/r/a2", process.env.GITHUB_TOKEN));
    });

    const runB = (async () => {
      await new Promise((r) => setTimeout(r, 5)); // let A spend its slot first
      await b.runWithGitHubTokenRequestBudget(5, 0, async () => {
        order.push("B starts, budget=5");
        await b.ghRaw("/r/b1", process.env.GITHUB_TOKEN);
        await b.ghRaw("/r/b2", process.env.GITHUB_TOKEN);
        order.push("B finishes");
      });
    })();

    await Promise.all([runA, runB]);
    assert.deepStrictEqual(order, [
      "A spent its slot",
      "B starts, budget=5",
      "B finishes",
      "A resumes",
    ]);
  });

  finished = true;
  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) console.log("SOME TESTS FAILED.");
  else console.log("ALL TESTS PASSED.");

})();
