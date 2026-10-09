"use strict";
/**
 * Signatures-repo token lifecycle: expiry-aware caching, proactive refresh,
 * reactive refresh on 401, shared in-flight mints, and the GITHUB_TOKEN
 * fallback - tested at three levels:
 *
 *   1. getSignaturesToken / withSignaturesToken / resolveSigTokenExpiry
 *      directly, against a fake clock (Date.now is stubbed) and a stub fetch.
 *   2. The real handlers (handleIssueComment, handlePullRequestTarget ->
 *      checkPR) against a stateful fake GitHub that ENFORCES token expiry
 *      and revocation exactly like the real API (401 "Bad credentials"), so
 *      "the token died between the write and the final read" is reproduced
 *      for real instead of being assumed.
 *   3. The real CLI (child process) against a local HTTP server.
 *
 * Run: node test/token-expiry.test.js (also included in `npm test`)
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const SRC = path.resolve(__dirname, "../src/cla-bot.js");
// fs.mkdtempSync (unlike a hand-built "pid + Date.now()" path in the shared,
// world-writable os.tmpdir()) creates a directory with an unguessable name
// and owner-only permissions (0o700 on POSIX), so no other local user can
// pre-create, read, or symlink-swap the event file. Same pattern as
// test/e2e.test.js.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cla-bot-token-expiry-"));
process.on("exit", () => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});
const PRIVATE_KEY = crypto
  .generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" });
const SIGN_PHRASE = "I have read the CLA Document and I hereby sign the CLA";
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const MIN = 60 * 1000;

const BASE_ENV = {
  GITHUB_TOKEN: "job-token",
  GITHUB_REPOSITORY: "fossasia/testrepo",
  SIG_OWNER: "fossasia",
  SIG_REPO: "cla-signatures",
  SIG_PATH: "signatures/cla.json",
  CLA_DOCUMENT_URL: "https://example.com/CLA.md",
  ALLOWLIST: "",
};

// The module reads its env once, at load time - so each test gets a fresh
// copy (empty token cache, fresh in-flight slot) with the env it asks for.
function loadFresh({ app = true } = {}) {
  Object.assign(process.env, BASE_ENV);
  process.env.SIG_APP_ID = app ? "123456" : "";
  process.env.SIG_APP_PRIVATE_KEY = app ? PRIVATE_KEY : "";
  delete process.env.REQUIRE_VERIFIED_COMMITS;
  delete require.cache[require.resolve(SRC)];
  return require(SRC);
}

// ---- fake clock -----------------------------------------------------------
const realNow = Date.now;
let fakeNow = 0;
function startClock() {
  fakeNow = Date.parse("2026-10-03T00:00:00.000Z");
  Date.now = () => fakeNow;
}
function stopClock() {
  Date.now = realNow;
}
function advance(ms) {
  fakeNow += ms;
}

// ---- harness --------------------------------------------------------------
let passed = 0;
let warnings = [];
async function test(name, fn, { clock = true } = {}) {
  const realWarn = console.warn;
  const realFetch = global.fetch;
  warnings = [];
  console.warn = (...a) => warnings.push(a.join(" "));
  if (clock) startClock();
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (e) {
    console.error(`FAIL: ${name}\n - ${e.stack}`);
    process.exitCode = 1;
  } finally {
    stopClock();
    console.warn = realWarn;
    global.fetch = realFetch;
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
function err(status, extra = {}) {
  return Object.assign(new Error(`HTTP ${status}`), { status, ...extra });
}

// ---- stateful fake GitHub (App auth) ---------------------------------------
// Signatures-repo calls are only accepted with a live installation token
// minted by this server (not expired by the CURRENT Date.now(), not revoked);
// everything else must carry the job's own GITHUB_TOKEN. That makes any
// request sent with the wrong credential a loud test failure.
function makeAppGitHub({
  lifetimeMs = 60 * MIN,
  expiresAt = "auto", // "auto" | "omit" | any literal value to send
  installationStatus = 200,
  commits,
  signatures = { version: 1, signatures: [] },
} = {}) {
  const s = {
    mintCount: 0,
    installationLookups: 0,
    unauthorized: 0,
    tokens: new Map(),
    requests: [],
    statuses: [],
    comments: [],
    hooks: {},
    sigSha: "sig-sha-0",
    sigPuts: 0,
    signatures,
    commits: commits || [
      {
        sha: "c0ffee1",
        author: { id: 42, login: "alice" },
        committer: { id: 42, login: "alice" },
        parents: [{ sha: "p0" }],
        commit: {
          message: "fix",
          author: { email: "alice@example.com" },
          verification: { verified: false },
        },
      },
    ],
  };
  s.revoke = (token) => {
    const t = s.tokens.get(token);
    if (t) t.revoked = true;
  };
  s.handle = (method, p, bearer, rawBody) => {
    s.requests.push({ method, path: p, bearer });
    if (p.endsWith("/installation")) {
      assert.strictEqual(
        bearer.split(".").length,
        3,
        "installation lookup must carry the App JWT",
      );
      s.installationLookups += 1;
      return installationStatus === 200
        ? { status: 200, body: { id: 7 } }
        : { status: installationStatus, body: { message: "Not Found" } };
    }
    if (/\/app\/installations\/7\/access_tokens$/.test(p)) {
      assert.strictEqual(bearer.split(".").length, 3, "mint must use the JWT");
      s.mintCount += 1;
      const token = `inst-tok-${s.mintCount}`;
      const expiresAtMs = Date.now() + lifetimeMs;
      s.tokens.set(token, { expiresAtMs, revoked: false });
      const body = { token };
      if (expiresAt === "auto")
        body.expires_at = new Date(expiresAtMs).toISOString();
      else if (expiresAt !== "omit") body.expires_at = expiresAt;
      return { status: 201, body };
    }
    if (p.includes("/repos/fossasia/cla-signatures/contents/")) {
      const t = s.tokens.get(bearer);
      if (!t || t.revoked || Date.now() >= t.expiresAtMs) {
        s.unauthorized += 1;
        return { status: 401, body: { message: "Bad credentials" } };
      }
      if (method === "GET") {
        const out = {
          status: 200,
          body: {
            sha: s.sigSha,
            content: b64(s.signatures),
            encoding: "base64",
          },
        };
        if (s.hooks.afterSigGet) s.hooks.afterSigGet(s);
        return out;
      }
      if (method === "PUT") {
        const payload = JSON.parse(rawBody);
        if ((payload.sha || null) !== s.sigSha) {
          return { status: 409, body: { message: "sha does not match" } };
        }
        s.signatures = JSON.parse(
          Buffer.from(payload.content, "base64").toString("utf8"),
        );
        s.sigPuts += 1;
        s.sigSha = `sig-sha-${s.sigPuts}`;
        return { status: 200, body: { content: { sha: s.sigSha } } };
      }
    }
    // Everything below is the job's own repo: must use GITHUB_TOKEN.
    assert.strictEqual(
      bearer,
      "job-token",
      `${method} ${p} must use the job's GITHUB_TOKEN, got: ${bearer.slice(0, 20)}`,
    );
    if (p === "/graphql") {
      return {
        status: 200,
        body: {
          data: {
            repository: {
              pullRequest: {
                baseRefOid: BASE_SHA,
                headRefOid: HEAD_SHA,
                comments: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
              },
            },
          },
        },
      };
    }
    if (p.includes("/compare/")) {
      if (s.hooks.onCommits) s.hooks.onCommits(s);
      return {
        status: 200,
        body: { commits: s.commits, total_commits: s.commits.length },
      };
    }
    if (/\/pulls\/1(?:\?|$)/.test(p)) {
      return {
        status: 200,
        body: { head: { sha: HEAD_SHA }, base: { sha: BASE_SHA } },
      };
    }
    if (p.includes("/statuses/")) {
      s.statuses.push(JSON.parse(rawBody));
      return { status: 201, body: {} };
    }
    if (p.includes("/issues/1/comments")) {
      if (method === "GET") return { status: 200, body: s.comments };
      const posted = JSON.parse(rawBody);
      s.comments.push({
        id: s.comments.length + 1,
        user: { login: "github-actions[bot]", type: "Bot" },
        body: posted.body,
      });
      return { status: 201, body: {} };
    }
    if (/\/user(?:\?|$)/.test(p)) {
      return { status: 404, body: { message: "Not Found" } };
    }
    throw new Error(`fake GitHub: unhandled ${method} ${p}`);
  };
  s.fetch = async (url, opts = {}) => {
    const out = s.handle(
      (opts.method || "GET").toUpperCase(),
      url.replace("https://api.github.com", ""),
      ((opts.headers && opts.headers.Authorization) || "").replace(
        /^Bearer /,
        "",
      ),
      opts.body,
    );
    return res(out.status, out.body);
  };
  return s;
}

const signPayload = () => ({
  action: "created",
  issue: { number: 1, pull_request: {}, user: { login: "alice" } },
  comment: {
    user: { id: 42, login: "alice" },
    body: SIGN_PHRASE,
    html_url: "https://github.com/fossasia/testrepo/pull/1#issuecomment-1",
    author_association: "NONE",
  },
});

const successStatuses = (s) => s.statuses.filter((x) => x.state === "success");

(async () => {
  // =========================================================================
  // resolveSigTokenExpiry - pure
  // =========================================================================
  await test("resolveSigTokenExpiry: a parseable expires_at inside the 1h ceiling is used as-is", async () => {
    const m = loadFresh();
    const t0 = Date.parse("2026-10-03T00:00:00Z");
    const iso = new Date(t0 + 30 * MIN).toISOString();
    assert.strictEqual(m.resolveSigTokenExpiry(iso, t0), t0 + 30 * MIN);
  });

  await test("resolveSigTokenExpiry: an expires_at beyond the documented lifetime is clamped to the ceiling", async () => {
    const m = loadFresh();
    const t0 = Date.parse("2026-10-03T00:00:00Z");
    assert.strictEqual(
      m.resolveSigTokenExpiry("9999-12-31T00:00:00Z", t0),
      t0 + m.SIG_TOKEN_LIFETIME_MS,
    );
  });

  await test("resolveSigTokenExpiry: an expires_at already in the past is NOT bumped up (the token is treated as stale)", async () => {
    const m = loadFresh();
    const t0 = Date.parse("2026-10-03T00:00:00Z");
    const past = new Date(t0 - 10 * MIN).toISOString();
    assert.strictEqual(m.resolveSigTokenExpiry(past, t0), t0 - 10 * MIN);
  });

  for (const [label, value] of [
    ["undefined", undefined],
    ["null", null],
    ["a number", 1759449600],
    ["an object", {}],
    ["an empty string", ""],
    ["garbage text", "not-a-date"],
  ]) {
    await test(`resolveSigTokenExpiry: ${label} falls back to the 1h ceiling and is always a finite number (never NaN)`, async () => {
      const m = loadFresh();
      const t0 = Date.parse("2026-10-03T00:00:00Z");
      const out = m.resolveSigTokenExpiry(value, t0);
      assert.ok(Number.isFinite(out), `expected a finite number, got ${out}`);
      assert.strictEqual(out, t0 + m.SIG_TOKEN_LIFETIME_MS);
    });
  }

  // =========================================================================
  // getSignaturesToken - cache lifecycle
  // =========================================================================
  await test("getSignaturesToken reuses the cached token while it is comfortably valid (zero extra API calls)", async () => {
    const m = loadFresh();
    const gh = makeAppGitHub();
    global.fetch = gh.fetch;
    const first = await m.getSignaturesToken();
    advance(30 * MIN);
    const second = await m.getSignaturesToken();
    assert.strictEqual(second, first);
    assert.strictEqual(gh.mintCount, 1);
    assert.strictEqual(gh.installationLookups, 1);
  });

  await test("getSignaturesToken re-mints once the token is inside the refresh-skew window, and returns the NEW token", async () => {
    const m = loadFresh();
    const gh = makeAppGitHub();
    global.fetch = gh.fetch;
    const first = await m.getSignaturesToken();
    advance(m.SIG_TOKEN_LIFETIME_MS - m.SIG_TOKEN_REFRESH_SKEW_MS + 1);
    const second = await m.getSignaturesToken();
    assert.notStrictEqual(second, first);
    assert.strictEqual(second, "inst-tok-2");
    assert.strictEqual(gh.mintCount, 2);
    // ...and the new one is itself cached.
    assert.strictEqual(await m.getSignaturesToken(), "inst-tok-2");
    assert.strictEqual(gh.mintCount, 2);
  });

  await test("getSignaturesToken refresh boundary is exact: 1ms before (expiry - skew) is still cached, at (expiry - skew) it is stale", async () => {
    const m = loadFresh();
    const gh = makeAppGitHub();
    global.fetch = gh.fetch;
    await m.getSignaturesToken();
    const edge = m.SIG_TOKEN_LIFETIME_MS - m.SIG_TOKEN_REFRESH_SKEW_MS;
    advance(edge - 1);
    assert.strictEqual(await m.getSignaturesToken(), "inst-tok-1");
    assert.strictEqual(gh.mintCount, 1);
    advance(1);
    assert.strictEqual(await m.getSignaturesToken(), "inst-tok-2");
    assert.strictEqual(gh.mintCount, 2);
  });

  await test("getSignaturesToken re-mints after the token has fully expired", async () => {
    const m = loadFresh();
    const gh = makeAppGitHub();
    global.fetch = gh.fetch;
    await m.getSignaturesToken();
    advance(3 * 60 * MIN);
    assert.strictEqual(await m.getSignaturesToken(), "inst-tok-2");
  });

  await test("getSignaturesToken honours a SHORTER server-reported expires_at than the default hour", async () => {
    const m = loadFresh();
    const gh = makeAppGitHub({ lifetimeMs: 20 * MIN });
    global.fetch = gh.fetch;
    await m.getSignaturesToken();
    advance(14 * MIN); // 6 min left > 5 min skew
    assert.strictEqual(await m.getSignaturesToken(), "inst-tok-1");
    advance(2 * MIN); // 4 min left < 5 min skew
    assert.strictEqual(await m.getSignaturesToken(), "inst-tok-2");
  });

  await test("getSignaturesToken without an expires_at assumes the documented 1h lifetime (cached early, refreshed before it ends)", async () => {
    const m = loadFresh();
    const gh = makeAppGitHub({ expiresAt: "omit" });
    global.fetch = gh.fetch;
    await m.getSignaturesToken();
    advance(30 * MIN);
    assert.strictEqual(await m.getSignaturesToken(), "inst-tok-1");
    advance(26 * MIN); // 56 min total: inside the skew window
    assert.strictEqual(await m.getSignaturesToken(), "inst-tok-2");
  });

  for (const [label, value] of [
    ["unparseable text", "tomorrow-ish"],
    ["null", null],
    ["a number", 12345],
  ]) {
    await test(`getSignaturesToken treats a ${label} expires_at like a missing one - no NaN poisoning, no re-mint on every call`, async () => {
      const m = loadFresh();
      const gh = makeAppGitHub({ expiresAt: value });
      global.fetch = gh.fetch;
      await m.getSignaturesToken();
      await m.getSignaturesToken();
      await m.getSignaturesToken();
      assert.strictEqual(
        gh.mintCount,
        1,
        "a bad expires_at must not make every call re-mint",
      );
    });
  }

  await test("getSignaturesToken clamps an absurdly far-future expires_at so the token is still refreshed after ~1h", async () => {
    const m = loadFresh();
    const gh = makeAppGitHub({ expiresAt: "9999-12-31T00:00:00Z" });
    global.fetch = gh.fetch;
    await m.getSignaturesToken();
    advance(56 * MIN);
    assert.strictEqual(await m.getSignaturesToken(), "inst-tok-2");
  });

  await test("getSignaturesToken tolerates an expires_at that is already in the past (clock skew): the fresh token is still returned, and each call mints at most once - no loop", async () => {
    const m = loadFresh();
    const gh = makeAppGitHub({ lifetimeMs: -10 * MIN });
    global.fetch = gh.fetch;
    const t = await m.getSignaturesToken();
    assert.strictEqual(t, "inst-tok-1");
    assert.strictEqual(gh.mintCount, 1, "a single call mints exactly once");
    await m.getSignaturesToken();
    assert.strictEqual(
      gh.mintCount,
      2,
      "the next call re-mints once, never more",
    );
  });

  await test("getSignaturesToken trims the minted token, same as before", async () => {
    const m = loadFresh();
    global.fetch = async (url) => {
      if (url.endsWith("/installation")) return res(200, { id: 7 });
      return res(201, {
        token: "  padded-token \n",
        expires_at: new Date(Date.now() + 60 * MIN).toISOString(),
      });
    };
    assert.strictEqual(await m.getSignaturesToken(), "padded-token");
  });

  await test("getSignaturesToken: concurrent callers share ONE in-flight mint (one lookup, one mint, same token)", async () => {
    const m = loadFresh();
    const gh = makeAppGitHub();
    global.fetch = async (url, opts) => {
      await new Promise((r) => setImmediate(r)); // keep the mint genuinely in flight
      return gh.fetch(url, opts);
    };
    const tokens = await Promise.all([
      m.getSignaturesToken(),
      m.getSignaturesToken(),
      m.getSignaturesToken(),
      m.getSignaturesToken(),
      m.getSignaturesToken(),
    ]);
    assert.deepStrictEqual(new Set(tokens), new Set(["inst-tok-1"]));
    assert.strictEqual(gh.mintCount, 1);
    assert.strictEqual(gh.installationLookups, 1);
  });

  await test("getSignaturesToken: a failed mint rejects every concurrent waiter, then clears the in-flight slot so the next call recovers", async () => {
    const m = loadFresh();
    const gh = makeAppGitHub({ installationStatus: 404 });
    global.fetch = async (url, opts) => {
      await new Promise((r) => setImmediate(r));
      return gh.fetch(url, opts);
    };
    const results = await Promise.allSettled([
      m.getSignaturesToken(),
      m.getSignaturesToken(),
      m.getSignaturesToken(),
    ]);
    assert.ok(results.every((r) => r.status === "rejected"));
    assert.ok(results.every((r) => r.reason.status === 404));
    assert.strictEqual(
      gh.installationLookups,
      1,
      "the waiters shared one failed attempt",
    );

    const healthy = makeAppGitHub();
    global.fetch = healthy.fetch;
    assert.strictEqual(await m.getSignaturesToken(), "inst-tok-1");
  });

  await test("getSignaturesToken: when a refresh fails after expiry, the error surfaces - the stale token is NOT silently handed out - and a later call recovers", async () => {
    const m = loadFresh();
    const gh = makeAppGitHub();
    global.fetch = gh.fetch;
    await m.getSignaturesToken();
    advance(61 * MIN);
    const broken = makeAppGitHub({ installationStatus: 404 });
    global.fetch = broken.fetch;
    await assert.rejects(
      () => m.getSignaturesToken(),
      (e) => e.status === 404,
    );
    const healthy = makeAppGitHub();
    global.fetch = healthy.fetch;
    assert.strictEqual(await m.getSignaturesToken(), "inst-tok-1");
  });

  // ---- GITHUB_TOKEN fallback --------------------------------------------
  await test("fallback mode (no App creds): returns GITHUB_TOKEN forever - never expires, never touches the network, warns exactly once", async () => {
    const m = loadFresh({ app: false });
    global.fetch = async (url) => {
      throw new Error(`fallback mode must not call the API: ${url}`);
    };
    assert.strictEqual(await m.getSignaturesToken(), "job-token");
    advance(48 * 60 * MIN);
    assert.strictEqual(await m.getSignaturesToken(), "job-token");
    assert.strictEqual(await m.getSignaturesToken(), "job-token");
    assert.strictEqual(
      warnings.filter((w) => w.includes("falling back to GITHUB_TOKEN")).length,
      1,
    );
  });

  // =========================================================================
  // withSignaturesToken - reactive refresh
  // =========================================================================
  await test("withSignaturesToken passes the token to fn once and returns its result when nothing goes wrong", async () => {
    const m = loadFresh();
    const gh = makeAppGitHub();
    global.fetch = gh.fetch;
    const seen = [];
    const out = await m.withSignaturesToken(async (t) => {
      seen.push(t);
      return "result";
    });
    assert.strictEqual(out, "result");
    assert.deepStrictEqual(seen, ["inst-tok-1"]);
    assert.strictEqual(gh.mintCount, 1);
    assert.strictEqual(warnings.length, 0);
  });

  await test("withSignaturesToken: a 401 invalidates the token, mints a fresh one, retries fn ONCE with it, and logs a warning", async () => {
    const m = loadFresh();
    const gh = makeAppGitHub();
    global.fetch = gh.fetch;
    const seen = [];
    const out = await m.withSignaturesToken(async (t) => {
      seen.push(t);
      if (seen.length === 1) throw err(401);
      return "recovered";
    });
    assert.strictEqual(out, "recovered");
    assert.deepStrictEqual(seen, ["inst-tok-1", "inst-tok-2"]);
    assert.strictEqual(gh.mintCount, 2);
    assert.ok(warnings.some((w) => w.includes("rejected (HTTP 401)")));
    // the refreshed token is now the cached one
    assert.strictEqual(await m.getSignaturesToken(), "inst-tok-2");
    assert.strictEqual(gh.mintCount, 2);
  });

  await test("withSignaturesToken: a second 401 propagates - exactly two attempts and two mints, never a loop", async () => {
    const m = loadFresh();
    const gh = makeAppGitHub();
    global.fetch = gh.fetch;
    let attempts = 0;
    await assert.rejects(
      () =>
        m.withSignaturesToken(async () => {
          attempts += 1;
          throw err(401, { attempt: attempts });
        }),
      (e) => e.status === 401 && e.attempt === 2,
    );
    assert.strictEqual(attempts, 2);
    assert.strictEqual(gh.mintCount, 2);
  });

  for (const status of [400, 403, 404, 409, 422, 429, 500, 502]) {
    await test(`withSignaturesToken does NOT retry or re-mint on HTTP ${status}`, async () => {
      const m = loadFresh();
      const gh = makeAppGitHub();
      global.fetch = gh.fetch;
      let attempts = 0;
      await assert.rejects(
        () =>
          m.withSignaturesToken(async () => {
            attempts += 1;
            throw err(status);
          }),
        (e) => e.status === status,
      );
      assert.strictEqual(attempts, 1);
      assert.strictEqual(gh.mintCount, 1);
    });
  }

  await test("withSignaturesToken does NOT retry a non-HTTP error (no .status), a null rejection, or a string rejection", async () => {
    const m = loadFresh();
    const gh = makeAppGitHub();
    global.fetch = gh.fetch;
    for (const thrown of [new Error("boom"), null, "plain string"]) {
      let attempts = 0;
      await assert.rejects(() =>
        m.withSignaturesToken(async () => {
          attempts += 1;
          throw thrown;
        }),
      );
      assert.strictEqual(attempts, 1);
    }
    assert.strictEqual(gh.mintCount, 1);
  });

  await test("withSignaturesToken in GITHUB_TOKEN fallback mode does not retry a 401 (nothing to re-mint)", async () => {
    const m = loadFresh({ app: false });
    global.fetch = async () => {
      throw new Error("must not call the API");
    };
    let attempts = 0;
    await assert.rejects(
      () =>
        m.withSignaturesToken(async () => {
          attempts += 1;
          throw err(401);
        }),
      (e) => e.status === 401,
    );
    assert.strictEqual(attempts, 1);
    assert.ok(!warnings.some((w) => w.includes("rejected (HTTP 401)")));
  });

  await test("withSignaturesToken: a failure while re-minting after a 401 surfaces the mint error, with no further fn attempt", async () => {
    const m = loadFresh();
    const gh = makeAppGitHub();
    global.fetch = gh.fetch;
    let attempts = 0;
    await assert.rejects(
      () =>
        m.withSignaturesToken(async () => {
          attempts += 1;
          global.fetch = makeAppGitHub({ installationStatus: 404 }).fetch;
          throw err(401);
        }),
      (e) => e.status === 404,
    );
    assert.strictEqual(attempts, 1);
  });

  await test("withSignaturesToken: if another caller already refreshed the cache, a stale 401 does NOT discard that newer token and does not mint a third", async () => {
    const m = loadFresh();
    const gh = makeAppGitHub();
    global.fetch = gh.fetch;
    const seen = [];
    const out = await m.withSignaturesToken(async (t) => {
      seen.push(t);
      if (seen.length === 1) {
        advance(m.SIG_TOKEN_LIFETIME_MS - m.SIG_TOKEN_REFRESH_SKEW_MS);
        assert.strictEqual(await m.getSignaturesToken(), "inst-tok-2");
        throw err(401);
      }
      return "ok";
    });
    assert.strictEqual(out, "ok");
    assert.deepStrictEqual(seen, ["inst-tok-1", "inst-tok-2"]);
    assert.strictEqual(
      gh.mintCount,
      2,
      "must reuse the newer token, not mint a third",
    );
  });

  await test("withSignaturesToken: if the re-mint hands back the very same token, the original 401 is rethrown instead of a pointless identical retry", async () => {
    const m = loadFresh();
    global.fetch = async (url) => {
      if (url.endsWith("/installation")) return res(200, { id: 7 });
      return res(201, {
        token: "same-token",
        expires_at: new Date(Date.now() + 60 * MIN).toISOString(),
      });
    };
    let attempts = 0;
    await assert.rejects(
      () =>
        m.withSignaturesToken(async () => {
          attempts += 1;
          throw err(401);
        }),
      (e) => e.status === 401,
    );
    assert.strictEqual(attempts, 1);
  });

  // =========================================================================
  // Real handlers against a fake GitHub that enforces expiry / revocation
  // =========================================================================
  await test("sign flow, baseline: one mint, no 401s, signature stored once, PR ends 'success'", async () => {
    const m = loadFresh();
    const gh = makeAppGitHub();
    global.fetch = gh.fetch;
    await m.handleIssueComment(signPayload());
    assert.strictEqual(gh.mintCount, 1);
    assert.strictEqual(gh.unauthorized, 0);
    assert.strictEqual(gh.signatures.signatures.length, 1);
    assert.strictEqual(gh.signatures.signatures[0].id, 42);
    assert.strictEqual(successStatuses(gh).length, 1);
  });

  await test("sign flow: the token DIES between the signature write and checkPR's final read (slow PR) - run still completes, via a re-mint", async () => {
    const m = loadFresh();
    const gh = makeAppGitHub();
    // The commit listing is the slow part: by the time it returns, the token
    // minted for the write is past its real expiry.
    gh.hooks.onCommits = () => advance(61 * MIN);
    global.fetch = gh.fetch;
    await m.handleIssueComment(signPayload());
    assert.strictEqual(gh.mintCount, 2);
    assert.strictEqual(
      gh.unauthorized,
      0,
      "the proactive refresh must avoid ever sending the expired token",
    );
    assert.strictEqual(gh.signatures.signatures.length, 1);
    assert.strictEqual(successStatuses(gh).length, 1);
    assert.ok(
      gh.comments.some((c) => c.body.includes("@alice Thank you for signing")),
    );
    const lastRead = [...gh.requests]
      .reverse()
      .find((r) => r.method === "GET" && r.path.includes("/contents/"));
    assert.strictEqual(
      lastRead.bearer,
      "inst-tok-2",
      "the final read must use the fresh token",
    );
  });

  await test("sign flow: token close to expiry (inside the skew window, not yet expired) is refreshed BEFORE it can fail", async () => {
    const m = loadFresh();
    const gh = makeAppGitHub();
    gh.hooks.onCommits = () => advance(58 * MIN);
    global.fetch = gh.fetch;
    await m.handleIssueComment(signPayload());
    assert.strictEqual(gh.mintCount, 2);
    assert.strictEqual(gh.unauthorized, 0);
    assert.strictEqual(successStatuses(gh).length, 1);
  });

  await test("sign flow: a token REVOKED early (well before expiry) is recovered from reactively - one 401, one re-mint, success", async () => {
    const m = loadFresh();
    const gh = makeAppGitHub();
    gh.hooks.onCommits = () => gh.revoke("inst-tok-1");
    global.fetch = gh.fetch;
    await m.handleIssueComment(signPayload());
    assert.strictEqual(gh.unauthorized, 1);
    assert.strictEqual(gh.mintCount, 2);
    assert.strictEqual(gh.signatures.signatures.length, 1);
    assert.strictEqual(successStatuses(gh).length, 1);
    assert.ok(warnings.some((w) => w.includes("rejected (HTTP 401)")));
  });

  await test("sign flow: a 401 on the PUT itself re-runs the whole read-modify-write once - the signature is stored EXACTLY once, with the fresh token", async () => {
    const m = loadFresh();
    const gh = makeAppGitHub();
    let revoked = false;
    gh.hooks.afterSigGet = () => {
      if (!revoked) {
        revoked = true;
        gh.revoke("inst-tok-1"); // dies after the read, before the PUT
      }
    };
    global.fetch = gh.fetch;
    await m.handleIssueComment(signPayload());
    assert.strictEqual(gh.unauthorized, 1);
    assert.strictEqual(gh.sigPuts, 1, "exactly one successful write");
    assert.strictEqual(
      gh.signatures.signatures.length,
      1,
      "no duplicate signature entry",
    );
    const puts = gh.requests.filter((r) => r.method === "PUT");
    assert.strictEqual(
      puts.length,
      2,
      "one rejected PUT, then one successful PUT",
    );
    assert.strictEqual(
      puts[0].bearer,
      "inst-tok-1",
      "first attempt used the dead token",
    );
    assert.strictEqual(
      puts[1].bearer,
      "inst-tok-2",
      "the retry used the fresh token",
    );
    assert.strictEqual(successStatuses(gh).length, 1);
  });

  await test("sign flow: when re-minting cannot help (every token is rejected) the run fails with the 401 instead of looping", async () => {
    const m = loadFresh();
    const gh = makeAppGitHub();
    gh.hooks.afterSigGet = () => {
      for (const t of gh.tokens.keys()) gh.revoke(t);
    };
    global.fetch = gh.fetch;
    await assert.rejects(
      () => m.handleIssueComment(signPayload()),
      (e) => e.status === 401,
    );
    assert.strictEqual(
      gh.mintCount,
      2,
      "one original mint + one retry mint, no more",
    );
    assert.strictEqual(gh.sigPuts, 0);
  });

  await test("sign flow: 'already signed' still short-circuits with a single mint and no spurious refresh", async () => {
    const m = loadFresh();
    const gh = makeAppGitHub({
      signatures: { version: 1, signatures: [{ id: 42, login: "alice" }] },
    });
    global.fetch = gh.fetch;
    await m.handleIssueComment(signPayload());
    assert.strictEqual(gh.sigPuts, 0);
    assert.strictEqual(gh.mintCount, 1);
    assert.strictEqual(gh.unauthorized, 0);
    assert.ok(gh.comments.some((c) => c.body.includes("already signed")));
  });

  await test("pull_request_target flow: checkPR's signature read recovers when the cached token was rejected", async () => {
    const m = loadFresh();
    const gh = makeAppGitHub({
      signatures: { version: 1, signatures: [{ id: 42, login: "alice" }] },
    });
    global.fetch = gh.fetch;
    await m.getSignaturesToken(); // a token is already cached in this process...
    gh.revoke("inst-tok-1"); // ...and is then killed server-side
    await m.handlePullRequestTarget({
      action: "opened",
      pull_request: { number: 1, head: { sha: HEAD_SHA }, base: { sha: "base-sha-fixture" } },
    });
    assert.strictEqual(gh.unauthorized, 1);
    assert.strictEqual(gh.mintCount, 2);
    assert.strictEqual(successStatuses(gh).length, 1);
  });

  await test("recheck flow: a token that expired while the process was alive is refreshed proactively before the read", async () => {
    const m = loadFresh();
    const gh = makeAppGitHub({
      signatures: { version: 1, signatures: [{ id: 42, login: "alice" }] },
    });
    global.fetch = gh.fetch;
    await m.getSignaturesToken();
    advance(2 * 60 * MIN);
    await m.checkPR(1);
    assert.strictEqual(gh.unauthorized, 0);
    assert.strictEqual(gh.mintCount, 2);
    assert.strictEqual(successStatuses(gh).length, 1);
  });

  await test("fallback mode: the sign flow still works end-to-end with the job token and never mints", async () => {
    const m = loadFresh({ app: false });
    const gh = makeAppGitHub();
    // In fallback mode the signatures repo is addressed with the job token.
    global.fetch = async (url, opts = {}) => {
      const bearer = (
        (opts.headers && opts.headers.Authorization) ||
        ""
      ).replace(/^Bearer /, "");
      assert.strictEqual(bearer, "job-token");
      if (url.includes("/contents/")) {
        gh.tokens.set("job-token", { expiresAtMs: Infinity, revoked: false });
      }
      return gh.fetch(url, opts);
    };
    await m.handleIssueComment(signPayload());
    assert.strictEqual(gh.mintCount, 0);
    assert.strictEqual(gh.signatures.signatures.length, 1);
    assert.strictEqual(successStatuses(gh).length, 1);
  });

  // =========================================================================
  // Real CLI against a local HTTP server (real process, real fetch, real
  // clock) - the revoke path, since the child's clock can't be faked.
  // =========================================================================
  await test(
    "CLI e2e: a sign-phrase run survives its installation token being revoked mid-run (re-mint + retry), exits 0, stores the signature once",
    async () => {
      const gh = makeAppGitHub();
      let revoked = false;
      gh.hooks.afterSigGet = () => {
        if (!revoked) {
          revoked = true;
          gh.revoke("inst-tok-1");
        }
      };
      const server = http.createServer((req, resp) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          let out;
          try {
            out = gh.handle(
              req.method,
              req.url,
              (req.headers.authorization || "").replace(/^Bearer /, ""),
              raw,
            );
          } catch (e) {
            out = { status: 500, body: { message: String(e.message) } };
          }
          resp.writeHead(out.status, { "Content-Type": "application/json" });
          resp.end(JSON.stringify(out.body));
        });
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const eventFile = path.join(TMP_DIR, "event.json");
      // flag "wx": fail instead of following/overwriting anything that
      // already exists at this path. mode 0o600: owner read/write only.
      fs.writeFileSync(eventFile, JSON.stringify(signPayload()), {
        flag: "wx",
        mode: 0o600,
      });
      try {
        const env = {
          PATH: process.env.PATH,
          HOME: process.env.HOME || TMP_DIR,
          ...BASE_ENV,
          GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
          GITHUB_EVENT_NAME: "issue_comment",
          GITHUB_EVENT_PATH: eventFile,
          SIG_APP_ID: "123456",
          SIG_APP_PRIVATE_KEY: PRIVATE_KEY,
        };
        const result = await new Promise((resolve) => {
          const child = spawn(process.execPath, [SRC], { env });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (d) => (stdout += d));
          child.stderr.on("data", (d) => (stderr += d));
          child.on("close", (code) => resolve({ code, stdout, stderr }));
        });
        assert.strictEqual(
          result.code,
          0,
          `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
        );
        assert.strictEqual(gh.mintCount, 2);
        assert.strictEqual(gh.unauthorized, 1);
        assert.strictEqual(gh.signatures.signatures.length, 1);
        assert.strictEqual(successStatuses(gh).length, 1);
        assert.ok(
          /rejected \(HTTP 401\)/.test(result.stdout + result.stderr),
          "expected the refresh warning in the Actions log",
        );
      } finally {
        await new Promise((r) => server.close(r));
        fs.unlinkSync(eventFile);
      }
    },
    { clock: false },
  );

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) console.error("SOME TESTS FAILED.");
  else console.log("ALL TESTS PASSED.");
})();
