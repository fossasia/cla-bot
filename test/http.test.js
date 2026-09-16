"use strict";
/**
 * These tests stub `global.fetch` to exercise readSignatures/writeSignatures
 * against simulated GitHub API responses - no real network calls, no npm
 * mocking library. This is the layer where the actual bugs were found
 * (missing Content-Type header, TOCTOU duplicate-signature race), which the
 * pure-function tests in logic.test.js never touched.
 *
 * Run: node test/http.test.js (also included in `npm test`)
 */
const assert = require("assert");

process.env.GITHUB_TOKEN = "dummy";
process.env.SIG_OWNER = "a-user-account"; // deliberately user-like, not org-like, to prove the fix
process.env.SIG_REPO = "cla-signatures";
process.env.CLA_DOCUMENT_URL = "https://example.com/CLA.md";
process.env.ALLOWLIST = "";
process.env.SIG_APP_ID = "123456";
process.env.SIG_APP_PRIVATE_KEY = require("crypto")
  .generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" });
const SIG_APP_ID_FOR_TESTS = process.env.SIG_APP_ID;

const {
  readSignatures,
  writeSignatures,
  getSignaturesToken,
  postComment,
  ghRaw,
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

function b64(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

function fakeResponse(status, jsonBody, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (jsonBody === null ? "" : JSON.stringify(jsonBody)),
    headers: { get: (h) => headers[h.toLowerCase()] || null },
  };
}

(async () => {
  await test("readSignatures returns an empty store on 404 (file does not exist yet)", async () => {
    global.fetch = async () => fakeResponse(404, { message: "Not Found" });
    const { sha, data } = await readSignatures("tok");
    assert.strictEqual(sha, null);
    assert.deepStrictEqual(data, { version: 1, signatures: [] });
  });

  await test("readSignatures correctly decodes an existing base64 file", async () => {
    const stored = { version: 1, signatures: [{ login: "alice" }] };
    global.fetch = async () =>
      fakeResponse(200, {
        sha: "abc123",
        content: b64(stored),
        encoding: "base64",
      });
    const { sha, data } = await readSignatures("tok");
    assert.strictEqual(sha, "abc123");
    assert.deepStrictEqual(data, stored);
  });

  await test("every request carries Content-Type: application/json when it has a body", async () => {
    let capturedHeaders = null;
    global.fetch = async (url, opts) => {
      capturedHeaders = opts.headers;
      return fakeResponse(200, {
        sha: "x",
        content: b64({ version: 1, signatures: [] }),
        encoding: "base64",
      });
    };
    // A GET (readSignatures) has no body - Content-Type should be absent.
    await readSignatures("tok");
    assert.strictEqual(
      capturedHeaders["Content-Type"],
      undefined,
      "GET should not force a Content-Type",
    );

    global.fetch = async (url, opts) => {
      capturedHeaders = opts.headers;
      if (opts.method === "PUT") {
        if (!opts.body) throw new Error("expected a body on the PUT");
        return fakeResponse(200, {});
      }
      // internal re-read that writeSignatures performs before the PUT
      return fakeResponse(200, {
        sha: "x",
        content: b64({ version: 1, signatures: [] }),
        encoding: "base64",
      });
    };
    await writeSignatures("tok", () => ({ version: 1, signatures: [] }), "msg");
    assert.strictEqual(
      capturedHeaders["Content-Type"],
      "application/json",
      "PUT with a body must set Content-Type",
    );
  });

  await test("writeSignatures skips the network write entirely when mutate() returns null", async () => {
    let putCalled = false;
    global.fetch = async (url, opts) => {
      if (opts.method === "PUT") putCalled = true;
      return fakeResponse(200, {
        sha: "x",
        content: b64({ version: 1, signatures: [] }),
        encoding: "base64",
      });
    };
    await writeSignatures("tok", () => null, "no-op");
    assert.strictEqual(
      putCalled,
      false,
      "a null mutate() result must not trigger a PUT",
    );
  });

  await test("writeSignatures retries with a fresh sha on 409 and eventually succeeds", async () => {
    let readCount = 0;
    let putCount = 0;
    global.fetch = async (url, opts) => {
      if (opts.method === "PUT") {
        putCount += 1;
        // First PUT attempt loses the race (stale sha) -> 409.
        // Second PUT attempt (after a fresh re-read) succeeds.
        return putCount === 1
          ? fakeResponse(409, { message: "Conflict" })
          : fakeResponse(200, {});
      }
      // GET (re-read) sha changes between calls to simulate another writer.
      readCount += 1;
      return fakeResponse(200, {
        sha: `sha-${readCount}`,
        content: b64({ version: 1, signatures: [] }),
        encoding: "base64",
      });
    };
    const result = await writeSignatures(
      "tok",
      (data) => ({
        ...data,
        signatures: [...data.signatures, { login: "bob" }],
      }),
      "bob signs",
    );
    assert.strictEqual(putCount, 2, "expected exactly one retry after the 409");
    assert.strictEqual(result.signatures.length, 1);
  });

  await test("two DIFFERENT users signing at the exact same time never lose either signature (real concurrent race via Promise.all)", async () => {
    // Two different signers racing is what actually proves the compare-
    // and-swap protection works - if both added the SAME entry, a naive
    // last-write-wins mock could still produce the right count by luck.
    // A blind overwrite here would make one signer's write vanish even
    // though it appeared to succeed.
    //
    // Both writeSignatures() calls' initial reads are held open with a
    // barrier until both have issued their GET, guaranteeing they see the
    // same stale (empty) state before either writes. Only then are both
    // released to race for real. The mock's PUT handler enforces GitHub's
    // real sha-based compare-and-swap (409 if the sha doesn't match), so
    // whichever PUT lands first wins, and the loser's own 409-retry logic
    // has to correctly re-apply its write on top of the winner's.
    let sha = "sha-0";
    let signatures = [];
    let inFlightGets = 0;
    let releaseGets;
    const bothArrived = new Promise((resolve) => {
      releaseGets = resolve;
    });

    global.fetch = async (url, opts) => {
      const method = opts.method || "GET";
      if (method === "GET") {
        inFlightGets += 1;
        if (inFlightGets >= 2) releaseGets();
        await bothArrived; // blocks the first two callers until both have arrived
        return fakeResponse(200, {
          sha,
          content: b64({ version: 1, signatures }),
          encoding: "base64",
        });
      }
      if (method === "PUT") {
        const body = JSON.parse(opts.body);
        if (body.sha !== sha) {
          return fakeResponse(409, { message: "Conflict" });
        }
        const newData = JSON.parse(
          Buffer.from(body.content, "base64").toString(),
        );
        signatures = newData.signatures;
        sha = `sha-${signatures.length}-${Math.random().toString(36).slice(2)}`;
        return fakeResponse(200, { content: { sha } });
      }
      throw new Error(`unexpected method in race test: ${method}`);
    };

    const mutateAlice = (data) => {
      if (data.signatures.some((s) => s.login === "alice")) return null;
      return { ...data, signatures: [...data.signatures, { login: "alice" }] };
    };
    const mutateBob = (data) => {
      if (data.signatures.some((s) => s.login === "bob")) return null;
      return { ...data, signatures: [...data.signatures, { login: "bob" }] };
    };

    await Promise.all([
      writeSignatures("tok", mutateAlice, "alice signs"),
      writeSignatures("tok", mutateBob, "bob signs"),
    ]);

    const logins = signatures.map((s) => s.login).sort();
    assert.deepStrictEqual(
      logins,
      ["alice", "bob"],
      "both signatures must survive a genuine concurrent race - neither should be silently lost to a last-write-wins overwrite",
    );
  });

  await test("a malformed signature entry (missing login) is kept as-is, not dropped", async () => {
    global.fetch = async () =>
      fakeResponse(200, {
        sha: "x",
        content: b64({
          version: 1,
          signatures: [
            { note: "oops, hand-edited without a login field" },
            { login: "valid-user" },
          ],
        }),
        encoding: "base64",
      });
    const { data } = await readSignatures("tok");
    assert.strictEqual(
      data.signatures.length,
      2,
      "a malformed-looking entry must survive a read - dropping it here would " +
        "mean the next write from any repo deletes it from the shared store " +
        "for good, even if it's a perfectly real signature in an older shape",
    );
    assert.strictEqual(
      data.signatures[0].note,
      "oops, hand-edited without a login field",
    );
    assert.strictEqual(data.signatures[1].login, "valid-user");
  });

  await test("writing a new signature preserves a pre-existing malformed entry instead of silently deleting it", async () => {
    const stored = {
      version: 1,
      signatures: [
        { note: "hand-edited legacy record, no login field" },
        { id: 1, login: "alice" },
      ],
    };
    let putBody = null;
    global.fetch = async (url, opts) => {
      if (!opts || opts.method === undefined) {
        return fakeResponse(200, {
          sha: "abc",
          content: b64(stored),
          encoding: "base64",
        });
      }
      if (opts.method === "PUT") {
        putBody = JSON.parse(opts.body);
        return fakeResponse(200, { content: { sha: "def" } });
      }
      throw new Error(`unexpected call: ${url}`);
    };
    await writeSignatures(
      "tok",
      (data) => ({
        ...data,
        signatures: [...data.signatures, { id: 2, login: "bob" }],
      }),
      "bob signs",
    );
    assert.ok(putBody, "expected a PUT request");
    const written = JSON.parse(
      Buffer.from(putBody.content, "base64").toString("utf8"),
    );
    assert.strictEqual(
      written.signatures.length,
      3,
      "the pre-existing malformed entry must still be present after the write",
    );
    assert.ok(
      written.signatures.some(
        (s) => s.note === "hand-edited legacy record, no login field",
      ),
      "the malformed entry must be preserved verbatim, not stripped",
    );
    assert.ok(written.signatures.some((s) => s.login === "alice"));
    assert.ok(written.signatures.some((s) => s.login === "bob"));
  });

  // ===========================================================================
  // readSignatures' own malformed-entry warning - the test above proves a
  // malformed entry survives a write untouched, but never actually checks
  // the warning ITSELF: its exact message, which of the three sub-
  // conditions (`!entry`, non-string login, empty-string login) triggers
  // it, or that a genuinely valid entry stays silent. This drives
  // readSignatures() directly (no write involved) with one of each shape
  // in a single array, checked in one pass.
  // ===========================================================================
  await test("readSignatures warns with the exact, specific message for each malformed signature entry shape (null, missing login, empty-string login, non-string login) and stays silent for a valid one", async () => {
    const stored = {
      version: 1,
      signatures: [
        null, // index 0: `!entry`
        { id: 1 }, // index 1: missing login entirely (typeof undefined !== "string")
        { id: 2, login: "" }, // index 2: present but empty string
        { id: 3, login: 123 }, // index 3: present, but genuinely the wrong TYPE (not just missing/empty)
        { id: 4, login: "valid-user" }, // index 4: genuinely valid - must NOT warn
      ],
    };
    global.fetch = async () =>
      fakeResponse(200, {
        sha: "abc",
        content: b64(stored),
        encoding: "base64",
      });
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (msg) => warnings.push(msg);
    try {
      const { data } = await readSignatures("tok");
      assert.strictEqual(
        data.signatures.length,
        5,
        "all five entries, malformed or not, must be preserved in the returned data",
      );
      assert.strictEqual(
        warnings.length,
        4,
        `expected exactly 4 warnings (indices 0-3) and silence for index 4, got: ${JSON.stringify(warnings)}`,
      );
      assert.strictEqual(
        warnings[0],
        '::warning::Signature entry at index 0 is missing/has an invalid "login" field (kept as-is, not treated as a match) - check a-user-account/cla-signatures/signatures/cla.json',
        "expected the exact message for the null-entry case, verbatim",
      );
      assert.ok(
        warnings[1].startsWith(
          '::warning::Signature entry at index 1 is missing/has an invalid "login" field',
        ),
        `expected index 1 (missing login) to be named specifically, got: ${warnings[1]}`,
      );
      assert.ok(
        warnings[2].startsWith(
          '::warning::Signature entry at index 2 is missing/has an invalid "login" field',
        ),
        `expected index 2 (empty-string login) to be named specifically, got: ${warnings[2]}`,
      );
      assert.ok(
        warnings[3].startsWith(
          '::warning::Signature entry at index 3 is missing/has an invalid "login" field',
        ),
        `expected index 3 (a number, not a string - a genuinely wrong-typed login, not just missing/empty) to be named specifically, got: ${warnings[3]}`,
      );
      assert.ok(
        !warnings.some((w) => w.includes("index 4")),
        "the valid entry at index 4 must never be warned about",
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  await test("getSignaturesToken uses the repo-scoped installation lookup, which works for both user- and org-owned signatures repos", async () => {
    const calledUrls = [];
    global.fetch = async (url, opts) => {
      calledUrls.push(url);
      if (url.endsWith("/installation")) {
        // Must be /repos/{owner}/{repo}/installation, NOT /orgs/{owner}/installation
        // the org-specific endpoint 404s for a user-owned repo even though
        // SIG_OWNER here ("a-user-account") is deliberately user-like.
        assert.ok(
          !url.includes("/orgs/"),
          `must not use the org-only endpoint: ${url}`,
        );
        assert.ok(
          url.includes("/repos/a-user-account/cla-signatures/installation"),
          `expected repo-scoped installation URL, got: ${url}`,
        );
        return fakeResponse(200, { id: 42 });
      }
      if (url.includes("/access_tokens")) {
        return fakeResponse(200, { token: "fake-installation-token" });
      }
      throw new Error(`unexpected call: ${url}`);
    };
    const token = await getSignaturesToken();
    assert.strictEqual(token, "fake-installation-token");
    assert.ok(
      calledUrls.some((u) =>
        u.includes("/repos/a-user-account/cla-signatures/installation"),
      ),
    );
  });

  // ---------------------------------------------------------------------
  // GitHub App auth: strengthening the happy path beyond "a token comes
  // back eventually" - each of these uses its own fresh require() so
  // getSignaturesToken's module-scope `_cachedSigToken` cache (same
  // pattern noted in bot-identity.test.js for resolveBotLogin) starts
  // clean, rather than silently reusing the token minted by the test
  // above.
  // ---------------------------------------------------------------------
  await test("getSignaturesToken sends the App JWT (not GITHUB_TOKEN) as the Bearer auth on BOTH the installation lookup and the access_tokens mint", async () => {
    delete require.cache[require.resolve("../src/cla-bot.js")];
    const { getSignaturesToken: freshGetToken } = require("../src/cla-bot.js");
    const authHeadersSeen = [];
    global.fetch = async (url, opts) => {
      authHeadersSeen.push({ url, auth: opts.headers.Authorization });
      if (url.endsWith("/installation")) return fakeResponse(200, { id: 77 });
      if (url.includes("/access_tokens"))
        return fakeResponse(200, { token: "fresh-installation-token" });
      throw new Error(`unexpected call: ${url}`);
    };
    await freshGetToken();

    assert.strictEqual(
      authHeadersSeen.length,
      2,
      "expected exactly the installation lookup + the token mint",
    );
    for (const { url, auth } of authHeadersSeen) {
      assert.ok(
        auth.startsWith("Bearer "),
        `expected a Bearer token on ${url}, got: ${auth}`,
      );
      assert.notStrictEqual(
        auth,
        "Bearer dummy",
        `must use the App JWT, not the plain GITHUB_TOKEN ("dummy"), on ${url}`,
      );
      const jwt = auth.slice("Bearer ".length);
      const parts = jwt.split(".");
      assert.strictEqual(
        parts.length,
        3,
        `expected a well-formed JWT (header.payload.signature) on ${url}, got: ${jwt}`,
      );
      const claims = JSON.parse(
        Buffer.from(parts[1], "base64").toString("utf8"),
      );
      assert.strictEqual(
        claims.iss,
        SIG_APP_ID_FOR_TESTS,
        `expected the JWT's iss claim to be the configured SIG_APP_ID, got: ${claims.iss}`,
      );
    }
  });

  await test("getSignaturesToken caches the minted token: a second call in the same run makes zero additional API calls", async () => {
    delete require.cache[require.resolve("../src/cla-bot.js")];
    const { getSignaturesToken: freshGetToken } = require("../src/cla-bot.js");
    let callCount = 0;
    global.fetch = async (url) => {
      callCount += 1;
      if (url.endsWith("/installation")) return fakeResponse(200, { id: 88 });
      if (url.includes("/access_tokens"))
        return fakeResponse(200, { token: "cached-installation-token" });
      throw new Error(`unexpected call: ${url}`);
    };
    const first = await freshGetToken();
    assert.strictEqual(
      callCount,
      2,
      "expected exactly 2 calls for the first, uncached mint",
    );
    const second = await freshGetToken();
    assert.strictEqual(
      second,
      first,
      "the cached call must return the same token",
    );
    assert.strictEqual(
      callCount,
      2,
      "a second call must be served entirely from the cache - zero additional network calls",
    );
  });

  await test("getSignaturesToken fails clearly when the GitHub App isn't installed on the signatures repo (404 on the installation lookup)", async () => {
    delete require.cache[require.resolve("../src/cla-bot.js")];
    const { getSignaturesToken: freshGetToken } = require("../src/cla-bot.js");
    global.fetch = async (url) => {
      if (url.endsWith("/installation"))
        return fakeResponse(404, {
          message: "Not Found",
          documentation_url: "https://docs.github.com/rest",
        });
      throw new Error(
        `unexpected call: ${url} - must not reach access_tokens after a 404`,
      );
    };
    let caught = null;
    try {
      await freshGetToken();
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "expected getSignaturesToken to throw");
    assert.strictEqual(caught.status, 404);
  });

  await test("getSignaturesToken's access_tokens mint is retried on a transient failure (it's marked idempotent) and still succeeds", async () => {
    delete require.cache[require.resolve("../src/cla-bot.js")];
    const { getSignaturesToken: freshGetToken } = require("../src/cla-bot.js");
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = (fn) => originalSetTimeout(fn, 0);
    let mintAttempts = 0;
    try {
      global.fetch = async (url) => {
        if (url.endsWith("/installation")) return fakeResponse(200, { id: 99 });
        if (url.includes("/access_tokens")) {
          mintAttempts += 1;
          if (mintAttempts < 2)
            return fakeResponse(503, { message: "Service Unavailable" });
          return fakeResponse(200, { token: "retried-installation-token" });
        }
        throw new Error(`unexpected call: ${url}`);
      };
      const token = await freshGetToken();
      assert.strictEqual(token, "retried-installation-token");
      assert.strictEqual(
        mintAttempts,
        2,
        "expected 1 failed attempt before the retry succeeds",
      );
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });

  // Item E: the mint request can come back 200 OK but with a body that
  // doesn't actually carry a usable token. getSignaturesToken() now
  // validates tokenResp.token before caching/returning it (see the
  // "missing a usable token field" check right after the mint request) -
  // a malformed successful response must fail loudly right here, not
  // silently flow through as an unusable `Authorization: Bearer undefined`
  // that only surfaces later as a confusing 401 on some unrelated request.
  await test("getSignaturesToken throws a clear error (not a silently-cached undefined) when the access_tokens response body is an empty object", async () => {
    delete require.cache[require.resolve("../src/cla-bot.js")];
    const { getSignaturesToken: freshGetToken } = require("../src/cla-bot.js");
    global.fetch = async (url) => {
      if (url.endsWith("/installation")) return fakeResponse(200, { id: 111 });
      if (url.includes("/access_tokens")) return fakeResponse(200, {}); // no "token" field at all
      throw new Error(`unexpected call: ${url}`);
    };
    let caught = null;
    try {
      await freshGetToken();
    } catch (e) {
      caught = e;
    }
    assert.ok(
      caught,
      "expected getSignaturesToken to throw instead of returning an unusable undefined token",
    );
    assert.ok(
      /missing a usable "token" field/.test(caught.message),
      `expected a specific, actionable error message, got: ${caught.message}`,
    );
  });

  await test("getSignaturesToken throws a clear error (not a silently-cached null) when the access_tokens response explicitly carries a null token", async () => {
    delete require.cache[require.resolve("../src/cla-bot.js")];
    const { getSignaturesToken: freshGetToken } = require("../src/cla-bot.js");
    global.fetch = async (url) => {
      if (url.endsWith("/installation")) return fakeResponse(200, { id: 112 });
      if (url.includes("/access_tokens"))
        return fakeResponse(200, { token: null });
      throw new Error(`unexpected call: ${url}`);
    };
    let caught = null;
    try {
      await freshGetToken();
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "expected getSignaturesToken to throw on a null token");
    assert.ok(/missing a usable "token" field/.test(caught.message));
  });

  await test("getSignaturesToken throws a clear error (not a raw TypeError) when the access_tokens response is a 200 OK with a completely empty body", async () => {
    // ghRaw()'s success path does `text ? JSON.parse(text) : null` - an
    // empty 200 body becomes a bare `null`, not `{}`. Dereferencing
    // `.token` directly on that would throw an unrelated "Cannot read
    // properties of null" TypeError instead of the intended, actionable
    // validation error - this is exactly the case the `!tokenResp` guard
    // (checked before `tokenResp.token`) exists for.
    delete require.cache[require.resolve("../src/cla-bot.js")];
    const { getSignaturesToken: freshGetToken } = require("../src/cla-bot.js");
    global.fetch = async (url) => {
      if (url.endsWith("/installation")) return fakeResponse(200, { id: 114 });
      if (url.includes("/access_tokens")) return fakeResponse(200, null); // 200 OK, empty body -> ghRaw() returns bare null
      throw new Error(`unexpected call: ${url}`);
    };
    let caught = null;
    try {
      await freshGetToken();
    } catch (e) {
      caught = e;
    }
    assert.ok(
      caught,
      "expected getSignaturesToken to throw instead of crashing or silently caching an unusable token",
    );
    assert.ok(
      !(caught instanceof TypeError),
      `expected the intended, actionable Error - not a raw TypeError from dereferencing .token on null - got: ${caught.constructor.name}: ${caught.message}`,
    );
    assert.ok(
      /missing a usable "token" field/.test(caught.message),
      `expected the same specific, actionable error message as the other malformed-response cases, got: ${caught.message}`,
    );
  });

  await test("getSignaturesToken's failed-validation mint does not poison the cache: a later call still successfully re-mints a real token", async () => {
    // A thrown error happens BEFORE `_cachedSigToken` is ever assigned, so
    // the module-scope cache is never left holding a bad value - this
    // confirms a transient malformed response (e.g. a flaky proxy) doesn't
    // permanently break every subsequent call in the same run.
    delete require.cache[require.resolve("../src/cla-bot.js")];
    const { getSignaturesToken: freshGetToken } = require("../src/cla-bot.js");
    let mintCalls = 0;
    global.fetch = async (url) => {
      if (url.endsWith("/installation")) return fakeResponse(200, { id: 113 });
      if (url.includes("/access_tokens")) {
        mintCalls += 1;
        if (mintCalls === 1) return fakeResponse(200, {}); // first mint: malformed, must throw
        return fakeResponse(200, { token: "real-token-on-second-try" });
      }
      throw new Error(`unexpected call: ${url}`);
    };
    let firstCaught = null;
    try {
      await freshGetToken();
    } catch (e) {
      firstCaught = e;
    }
    assert.ok(firstCaught, "expected the first, malformed mint to throw");
    const second = await freshGetToken();
    assert.strictEqual(second, "real-token-on-second-try");
    assert.strictEqual(
      mintCalls,
      2,
      "a failed mint must not be cached as if it succeeded - the second call had to actually re-mint",
    );
  });

  await test("readSignatures falls back to a raw-media-type fetch when the file is too big for inline base64 content (over 1 MB)", async () => {
    const stored = {
      version: 1,
      signatures: [{ login: "alice" }, { login: "bob" }],
    };
    let sawObjectRequest = false;
    let sawRawRequest = false;
    global.fetch = async (url, opts) => {
      const accept = (opts.headers || {}).Accept;
      if (accept === "application/vnd.github.object+json") {
        sawObjectRequest = true;
        // GitHub's documented behavior for files over 1 MB under the
        // 'object' media type: content is empty and encoding is 'none'.
        return fakeResponse(200, {
          sha: "big-file-sha",
          content: "",
          encoding: "none",
        });
      }
      if (accept === "application/vnd.github.raw+json") {
        sawRawRequest = true;
        // The raw media type returns the file's bytes directly, not
        // wrapped in a JSON envelope.
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(stored),
          headers: { get: () => null },
        };
      }
      throw new Error(`unexpected Accept header: ${accept}`);
    };

    const { sha, data } = await readSignatures("tok");
    assert.strictEqual(sha, "big-file-sha");
    assert.deepStrictEqual(data, stored);
    assert.ok(
      sawObjectRequest,
      "must request metadata via the object media type first",
    );
    assert.ok(
      sawRawRequest,
      "must fall back to a raw-content fetch when content comes back empty",
    );
  });

  await test("readSignatures uses the inline content from the object media type directly when the file is small enough (no second request)", async () => {
    const stored = { version: 1, signatures: [{ login: "alice" }] };
    let fetchCallCount = 0;
    global.fetch = async (url, opts) => {
      fetchCallCount += 1;
      assert.strictEqual(
        (opts.headers || {}).Accept,
        "application/vnd.github.object+json",
      );
      return fakeResponse(200, {
        sha: "small-file-sha",
        content: b64(stored),
        encoding: "base64",
      });
    };
    const { data } = await readSignatures("tok");
    assert.deepStrictEqual(data, stored);
    assert.strictEqual(
      fetchCallCount,
      1,
      "a small file must not trigger a second raw-content request",
    );
  });

  await test("a non-JSON error body (e.g. an HTML gateway error page) does not mask the real error", async () => {
    global.fetch = async () => ({
      ok: false,
      status: 403, // plain 403, no retry-after header, so this isn't treated as transient/retried
      text: async () => "<html><body>403 Forbidden by proxy</body></html>",
      headers: { get: () => null },
    });
    let caught = null;
    try {
      await readSignatures("tok");
    } catch (e) {
      caught = e;
    }
    // The important thing is that JSON.parse()-ing the HTML body doesn't
    // throw a confusing "Unexpected token <" instead of surfacing the
    // real 403 status.
    assert.ok(caught, "expected an error to be thrown");
    assert.strictEqual(caught.status, 403);
    assert.strictEqual(
      caught.body,
      null,
      "a non-JSON body should fall back to null, not crash the parse",
    );
    assert.ok(
      caught.message.includes("403"),
      "the original status must still be visible in the error message",
    );
  });

  // Item D: the mirror image of the test above - here the response IS
  // ok (200), so ghRaw()'s success branch (`return text ? JSON.parse(text)
  // : null`) is what runs, and that JSON.parse is NOT wrapped in its own
  // try/catch the way the error-body path just above is. A malformed
  // success body (e.g. a misconfigured proxy that returns 200 with a
  // truncated/non-JSON payload) must still surface as a clear, immediate
  // SyntaxError - not silently produce garbage data, and not be masked by
  // gh()'s retry loop (a SyntaxError has no `.status` and isn't named
  // "AbortError", so it isn't "transient" and must NOT be retried).
  await test("ghRaw's success path (200 OK) throws a clear SyntaxError, without retrying, when the response body is not valid JSON", async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        text: async () => "this is not { valid json",
        headers: { get: () => null },
      };
    };
    let caught = null;
    try {
      await readSignatures("tok");
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "expected JSON.parse to throw on the malformed body");
    assert.ok(
      caught instanceof SyntaxError,
      `expected a SyntaxError, got: ${caught && caught.constructor.name}`,
    );
    assert.strictEqual(
      calls,
      1,
      "a SyntaxError has no .status and isn't an AbortError, so gh()'s transient-retry loop must not retry it",
    );
  });

  await test('two different users racing to create the signature file for the very first time never lose a signature (422 "sha wasn\'t supplied" race)', async () => {
    // readSignatures() sees a genuine 404 (file never existed) for both
    // concurrent writers, so both compute sha: null and attempt a create
    // (no sha in the PUT body). GitHub allows only one create to succeed;
    // the other one - whose read is now stale - gets back 422 "sha wasn't
    // supplied", not 409. That's a different error than the ordinary
    // "existing file, someone else updated it" 409 case, and the retry
    // path has to recognize it specifically, or the losing writer's
    // signature is silently dropped.
    let exists = false;
    let sha = null;
    let signatures = [];
    let inFlightGets = 0;
    let releaseGets;
    const bothArrived = new Promise((resolve) => {
      releaseGets = resolve;
    });

    global.fetch = async (url, opts) => {
      const method = opts.method || "GET";
      if (method === "GET") {
        inFlightGets += 1;
        if (inFlightGets >= 2) releaseGets();
        if (inFlightGets <= 2) await bothArrived; // both initial reads block on each other, both see the same "file doesn't exist" state
        if (!exists) return fakeResponse(404, { message: "Not Found" });
        return fakeResponse(200, {
          sha,
          content: b64({ version: 1, signatures }),
          encoding: "base64",
        });
      }
      if (method === "PUT") {
        const body = JSON.parse(opts.body);
        if (!exists) {
          // First PUT to actually reach here wins the create - this mirrors
          // GitHub's real behavior: the second writer's identical attempt
          // (also with no sha, since it also read a 404) fails.
          exists = true;
          const newData = JSON.parse(
            Buffer.from(body.content, "base64").toString(),
          );
          signatures = newData.signatures;
          sha = `sha-created-${Math.random().toString(36).slice(2)}`;
          return fakeResponse(201, { content: { sha } });
        }
        if (!body.sha) {
          // The file exists now (created by the other writer above) but
          // this request still doesn't have a sha - exactly GitHub's real
          // "sha wasn't supplied" 422 for this race.
          return fakeResponse(422, {
            message: 'Invalid request. "sha" wasn\'t supplied.',
          });
        }
        if (body.sha !== sha) {
          return fakeResponse(409, { message: "Conflict" });
        }
        const newData = JSON.parse(
          Buffer.from(body.content, "base64").toString(),
        );
        signatures = newData.signatures;
        sha = `sha-updated-${Math.random().toString(36).slice(2)}`;
        return fakeResponse(200, { content: { sha } });
      }
      throw new Error(`unexpected method in first-write race test: ${method}`);
    };

    const mutateAlice = (data) => {
      if (data.signatures.some((s) => s.login === "alice")) return null;
      return { ...data, signatures: [...data.signatures, { login: "alice" }] };
    };
    const mutateBob = (data) => {
      if (data.signatures.some((s) => s.login === "bob")) return null;
      return { ...data, signatures: [...data.signatures, { login: "bob" }] };
    };

    await Promise.all([
      writeSignatures("tok", mutateAlice, "alice signs (creates the file)"),
      writeSignatures("tok", mutateBob, "bob signs (loses the create race)"),
    ]);

    const logins = signatures.map((s) => s.login).sort();
    assert.deepStrictEqual(
      logins,
      ["alice", "bob"],
      "both signatures must survive even when they race to create the signature file for the very first time",
    );
  });

  // -------------------------------------------------------------------------
  // Timeout behavior. ghRaw() wires every fetch() to an AbortController that
  // fires after REQUEST_TIMEOUT_MS (15s) - a hung call must not stall the
  // job forever, and the resulting AbortError must be treated as transient
  // by gh()'s retry loop just like a 5xx. REQUEST_TIMEOUT_MS is a fixed
  // constant (not env-configurable), so rather than actually waiting 15
  // real seconds per attempt, these tests stub global.setTimeout to fire
  // immediately - the real AbortController/signal wiring and retry logic
  // still run for real, only the wall-clock wait is skipped.
  // -------------------------------------------------------------------------
  await test("a hung request is aborted after the configured timeout, and the AbortError is retried like other transient failures until it propagates", async () => {
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = (fn) => originalSetTimeout(fn, 0);
    let fetchCalls = 0;
    try {
      global.fetch = (url, opts) =>
        new Promise((resolve, reject) => {
          fetchCalls += 1;
          // A request that never resolves on its own - the only way it
          // ever settles is via the abort signal ghRaw() attaches, exactly
          // like a real hung connection behaves under fetch+AbortController.
          opts.signal.addEventListener("abort", () => {
            const err = new Error("This operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        });

      let caught = null;
      try {
        await readSignatures("tok");
      } catch (e) {
        caught = e;
      }
      assert.ok(caught, "expected the call to eventually throw");
      assert.strictEqual(caught.name, "AbortError");
      assert.strictEqual(
        fetchCalls,
        3,
        "AbortError must be retried up to MAX_RETRIES (3 total attempts), not thrown immediately and not retried forever",
      );
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });

  // Item C: the test above only exercises "hangs on every attempt, until
  // retries run out" - the equally important, distinct case is a transient
  // hang that clears up partway through: the first attempt(s) time out, but
  // a later attempt within MAX_RETRIES gets a real, immediate response and
  // the whole call succeeds cleanly, exactly like the 503/429 recovery
  // tests below do for HTTP-level transient errors.
  await test("a request that times out on its first attempt but succeeds on a later retry recovers cleanly (does not throw, does not needlessly exhaust all retries)", async () => {
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = (fn) => originalSetTimeout(fn, 0);
    let fetchCalls = 0;
    try {
      global.fetch = (url, opts) => {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          // Only the FIRST attempt hangs and gets aborted - every
          // subsequent attempt gets a real, immediate response below.
          return new Promise((resolve, reject) => {
            opts.signal.addEventListener("abort", () => {
              const err = new Error("This operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          });
        }
        return Promise.resolve(
          fakeResponse(200, {
            sha: "recovered-after-timeout-sha",
            content: b64({ version: 1, signatures: [] }),
            encoding: "base64",
          }),
        );
      };

      const { sha } = await readSignatures("tok");
      assert.strictEqual(sha, "recovered-after-timeout-sha");
      assert.strictEqual(
        fetchCalls,
        2,
        "expected exactly 1 timed-out attempt followed by 1 successful retry - not 3 (all retries exhausted) and not 1 (no retry happened at all)",
      );
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });

  await test("the per-request abort timer is cleared after a normal (non-hung) response, not left dangling", async () => {
    const originalClearTimeout = global.clearTimeout;
    let clearedCount = 0;
    global.clearTimeout = (id) => {
      clearedCount += 1;
      return originalClearTimeout(id);
    };
    try {
      global.fetch = async () =>
        fakeResponse(200, {
          sha: "x",
          content: b64({ version: 1, signatures: [] }),
          encoding: "base64",
        });
      await readSignatures("tok");
      assert.strictEqual(
        clearedCount,
        1,
        "expected exactly one clearTimeout call for the one request readSignatures made - a leaked timer keeps the process alive longer than necessary",
      );
    } finally {
      global.clearTimeout = originalClearTimeout;
    }
  });

  // -------------------------------------------------------------------------
  // gh()'s generic transient-failure retry loop (distinct from the
  // 409-specific compare-and-swap retry inside writeSignatures tested above).
  // -------------------------------------------------------------------------
  await test("a transient 503 is retried and the call eventually succeeds", async () => {
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = (fn) => originalSetTimeout(fn, 0);
    let calls = 0;
    try {
      global.fetch = async () => {
        calls += 1;
        if (calls < 3)
          return fakeResponse(503, { message: "Service Unavailable" });
        return fakeResponse(200, {
          sha: "recovered-sha",
          content: b64({ version: 1, signatures: [] }),
          encoding: "base64",
        });
      };
      const { sha } = await readSignatures("tok");
      assert.strictEqual(sha, "recovered-sha");
      assert.strictEqual(
        calls,
        3,
        "expected 2 failed attempts before the 3rd one succeeds",
      );
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });

  await test("a 429 rate-limit response is retried the same way as a 5xx", async () => {
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = (fn) => originalSetTimeout(fn, 0);
    let calls = 0;
    try {
      global.fetch = async () => {
        calls += 1;
        if (calls === 1) return fakeResponse(429, { message: "rate limited" });
        return fakeResponse(200, {
          sha: "x",
          content: b64({ version: 1, signatures: [] }),
          encoding: "base64",
        });
      };
      await readSignatures("tok");
      assert.strictEqual(calls, 2);
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });

  await test("gh() honors the Retry-After header for the backoff delay on a secondary rate limit (403 + retry-after), instead of the default attempt*1000 delay", async () => {
    const originalSetTimeout = global.setTimeout;
    const delaysSeen = [];
    global.setTimeout = (fn, ms) => {
      delaysSeen.push(ms);
      return originalSetTimeout(fn, 0); // fast-forward so the test doesn't actually wait
    };
    let calls = 0;
    try {
      global.fetch = async () => {
        calls += 1;
        if (calls === 1)
          return fakeResponse(
            403,
            { message: "secondary rate limit" },
            { "retry-after": "2" },
          );
        return fakeResponse(200, {
          sha: "x",
          content: b64({ version: 1, signatures: [] }),
          encoding: "base64",
        });
      };
      await readSignatures("tok");
      // Two kinds of setTimeout calls happen here: the 15s abort timer for
      // each fetch, and the one retry backoff delay between attempt 1 and
      // attempt 2. That backoff delay should be retryAfter*1000 = 2000, not
      // the default attempt*1000 = 1000.
      assert.ok(
        delaysSeen.includes(2000),
        `expected a 2000ms backoff delay honoring Retry-After: 2, saw: ${delaysSeen}`,
      );
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });

  await test("a POST (e.g. posting a comment) is NOT retried by default on a transient 5xx, since a blind retry could create a duplicate", async () => {
    let postAttempts = 0;
    global.fetch = async (url, opts) => {
      const method = (opts.method || "GET").toUpperCase();
      if (method === "GET" && url.includes("/comments")) {
        return fakeResponse(200, []); // dedupe pre-check: no existing comments
      }
      if (method === "POST") {
        postAttempts += 1;
        return fakeResponse(500, { message: "Internal Server Error" });
      }
      throw new Error(`unexpected call: ${method} ${url}`);
    };
    let caught = null;
    try {
      await postComment(1, "hello");
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "expected postComment to throw");
    assert.strictEqual(caught.status, 500);
    assert.strictEqual(
      postAttempts,
      1,
      "a POST must be attempted exactly once on a transient failure - retrying it automatically risks creating a duplicate comment",
    );
  });

  await test("a persistently-failing transient error (503) is retried up to MAX_RETRIES then propagates, not retried forever", async () => {
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = (fn) => originalSetTimeout(fn, 0);
    let calls = 0;
    try {
      global.fetch = async () => {
        calls += 1;
        return fakeResponse(503, { message: "Service Unavailable" });
      };
      let caught = null;
      try {
        await readSignatures("tok");
      } catch (e) {
        caught = e;
      }
      assert.ok(caught, "expected the call to eventually throw");
      assert.strictEqual(caught.status, 503);
      assert.strictEqual(
        calls,
        3,
        "expected exactly MAX_RETRIES (3) attempts, not unlimited retries and not fewer",
      );
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });

  await test('readSignatures throws a descriptive error when the stored file\'s "signatures" field is not an array (corrupted/hand-edited data)', async () => {
    global.fetch = async () =>
      fakeResponse(200, {
        sha: "corrupt-sha",
        content: b64({ version: 1, signatures: { not: "an array" } }),
        encoding: "base64",
      });
    let caught = null;
    try {
      await readSignatures("tok");
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "expected readSignatures to throw on corrupted data");
    assert.ok(
      /signatures.*is not an array/i.test(caught.message),
      `expected a descriptive error naming the field, got: ${caught.message}`,
    );
  });

  await test("writeSignatures gives up after repeatedly hitting 409 conflicts (4 attempts) and throws, instead of retrying forever", async () => {
    const originalSetTimeout = global.setTimeout;
    // writeSignatures' own retry backoff (attempt * 800ms: 800/1600/2400ms
    // between the 4 attempts) is separate from gh()'s transient-retry
    // backoff - stub it too, or this single test adds ~4.8s to every run.
    global.setTimeout = (fn) => originalSetTimeout(fn, 0);
    let putAttempts = 0;
    try {
      global.fetch = async (url, opts) => {
        const method = (opts && opts.method) || "GET";
        if (method === "PUT") {
          putAttempts += 1;
          return fakeResponse(409, { message: "Conflict" });
        }
        // Every re-read looks the same - the point is that the writer NEVER
        // wins, no matter how many times it retries.
        return fakeResponse(200, {
          sha: "always-stale-sha",
          content: b64({ version: 1, signatures: [] }),
          encoding: "base64",
        });
      };
      let caught = null;
      try {
        await writeSignatures(
          "tok",
          (data) => ({
            ...data,
            signatures: [...data.signatures, { login: "someone" }],
          }),
          "someone signs",
        );
      } catch (e) {
        caught = e;
      }
      assert.ok(
        caught,
        "expected writeSignatures to eventually give up and throw, not retry forever",
      );
      assert.strictEqual(caught.status, 409);
      assert.strictEqual(
        putAttempts,
        4,
        "expected exactly 4 PUT attempts (the hardcoded retry cap) before giving up",
      );
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });

  await test("writeSignatures does NOT retry a non-conflict PUT failure (e.g. 403 permissions error) - it throws immediately", async () => {
    let putAttempts = 0;
    global.fetch = async (url, opts) => {
      const method = (opts && opts.method) || "GET";
      if (method === "PUT") {
        putAttempts += 1;
        return fakeResponse(403, { message: "Resource not accessible" });
      }
      return fakeResponse(200, {
        sha: "x",
        content: b64({ version: 1, signatures: [] }),
        encoding: "base64",
      });
    };
    let caught = null;
    try {
      await writeSignatures(
        "tok",
        (data) => ({
          ...data,
          signatures: [...data.signatures, { login: "someone" }],
        }),
        "someone signs",
      );
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "expected writeSignatures to throw");
    assert.strictEqual(caught.status, 403);
    assert.strictEqual(
      putAttempts,
      1,
      "a genuine permissions error is not a write-conflict race - it must not be retried at all",
    );
  });

  await test('writeSignatures\' first-write-race detection safely falls back to "" when the 422 error body is non-JSON/empty, and does not mistake it for a retryable race', async () => {
    let putAttempts = 0;
    global.fetch = async (url, opts) => {
      const method = (opts && opts.method) || "GET";
      if (method === "PUT") {
        putAttempts += 1;
        // A 422 with no parseable body at all (e.g. a proxy/gateway
        // mangled it) - e.body ends up null, not an object with .message.
        return {
          ok: false,
          status: 422,
          text: async () => "",
          headers: { get: () => null },
        };
      }
      // sha === null path: readSignatures itself 404s (file doesn't exist
      // yet), which is what makes writeSignatures pass sha: null to the PUT.
      return {
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ message: "Not Found" }),
        headers: { get: () => null },
      };
    };
    let caught = null;
    try {
      await writeSignatures(
        "tok",
        (data) => ({
          ...data,
          signatures: [...data.signatures, { login: "someone" }],
        }),
        "someone signs",
      );
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "expected writeSignatures to throw");
    assert.strictEqual(caught.status, 422);
    assert.strictEqual(
      putAttempts,
      1,
      "a 422 with an unparseable body must not be mistaken for the first-write sha race and retried",
    );
  });

  // ---------------------------------------------------------------------
  // Item Q: rounding out the HTTP method x transient-status retry matrix.
  // The tests above already prove GET recovers from 503/429/Retry-After/
  // AbortError, and that a plain POST is never auto-retried. These fill in
  // the remaining safe-to-retry methods (PUT, DELETE) against the same
  // transient conditions, plus the one POST case that IS retried
  // (idempotent: true, on getSignaturesToken's token mint) all the way to
  // exhaustion instead of just its one already-tested recovery case.
  // ---------------------------------------------------------------------
  await test("a transient 503 on a DELETE (duplicate-comment cleanup) is retried by gh() and the cleanup succeeds silently, without ever reaching the outer per-comment warning", async () => {
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = (fn) => originalSetTimeout(fn, 0);
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (msg) => warnings.push(msg);
    let getCount = 0;
    let deleteAttempts = 0;
    try {
      global.fetch = async (url, opts) => {
        const method = (opts.method || "GET").toUpperCase();
        if (method === "GET" && url.includes("/comments")) {
          getCount += 1;
          if (getCount === 1) return fakeResponse(200, []); // pre-check: nothing yet, so postComment proceeds to POST
          // cleanup re-fetch: an older identical duplicate plus our own new comment
          return fakeResponse(200, [
            {
              id: 10,
              body: "<!-- fossasia-cla-bot:v1 -->\nhello",
              user: { login: "github-actions[bot]" },
            },
            {
              id: 11,
              body: "<!-- fossasia-cla-bot:v1 -->\nhello",
              user: { login: "github-actions[bot]" },
            },
          ]);
        }
        if (method === "POST") {
          return fakeResponse(201, {
            id: 11,
            body: "<!-- fossasia-cla-bot:v1 -->\nhello",
            user: { login: "github-actions[bot]" },
          });
        }
        if (method === "DELETE") {
          deleteAttempts += 1;
          if (deleteAttempts === 1)
            return fakeResponse(503, { message: "Service Unavailable" });
          return fakeResponse(204, null);
        }
        throw new Error(`unexpected call: ${method} ${url}`);
      };
      await postComment(1, "hello");
      assert.strictEqual(
        deleteAttempts,
        2,
        "expected the 503 to be retried once and succeed on the 2nd DELETE attempt",
      );
      assert.strictEqual(
        warnings.length,
        0,
        "a DELETE that eventually succeeds via gh()'s own retry loop must never reach the outer 'could not delete' warning",
      );
    } finally {
      global.setTimeout = originalSetTimeout;
      console.warn = originalWarn;
    }
  });

  await test("a DELETE (duplicate-comment cleanup) that times out on its first attempt recovers cleanly on retry, without ever surfacing the 'could not delete' warning", async () => {
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = (fn) => originalSetTimeout(fn, 0);
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (msg) => warnings.push(msg);
    let getCount = 0;
    let deleteAttempts = 0;
    try {
      global.fetch = (url, opts) => {
        const method = (opts.method || "GET").toUpperCase();
        if (method === "GET" && url.includes("/comments")) {
          getCount += 1;
          if (getCount === 1) return Promise.resolve(fakeResponse(200, []));
          return Promise.resolve(
            fakeResponse(200, [
              {
                id: 20,
                body: "<!-- fossasia-cla-bot:v1 -->\nworld",
                user: { login: "github-actions[bot]" },
              },
              {
                id: 21,
                body: "<!-- fossasia-cla-bot:v1 -->\nworld",
                user: { login: "github-actions[bot]" },
              },
            ]),
          );
        }
        if (method === "POST") {
          return Promise.resolve(
            fakeResponse(201, {
              id: 21,
              body: "<!-- fossasia-cla-bot:v1 -->\nworld",
              user: { login: "github-actions[bot]" },
            }),
          );
        }
        if (method === "DELETE") {
          deleteAttempts += 1;
          if (deleteAttempts === 1) {
            // First attempt hangs and gets aborted, exactly like the GET
            // timeout tests above - the only way it ever settles is via
            // the abort signal ghRaw() attaches.
            return new Promise((resolve, reject) => {
              opts.signal.addEventListener("abort", () => {
                const err = new Error("This operation was aborted");
                err.name = "AbortError";
                reject(err);
              });
            });
          }
          return Promise.resolve(fakeResponse(204, null));
        }
        return Promise.reject(new Error(`unexpected call: ${method} ${url}`));
      };
      await postComment(1, "world");
      assert.strictEqual(
        deleteAttempts,
        2,
        "expected 1 timed-out DELETE attempt followed by 1 successful retry",
      );
      assert.strictEqual(
        warnings.length,
        0,
        "a DELETE that recovers via retry must never reach the outer per-comment warning",
      );
    } finally {
      global.setTimeout = originalSetTimeout;
      console.warn = originalWarn;
    }
  });

  await test("a 429 rate-limit response on a PUT (writeSignatures) is retried the same way as a GET, and the write still succeeds", async () => {
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = (fn) => originalSetTimeout(fn, 0);
    let putAttempts = 0;
    try {
      global.fetch = async (url, opts) => {
        const method = (opts.method || "GET").toUpperCase();
        if (method === "GET") {
          return fakeResponse(200, {
            sha: "s1",
            content: b64({ version: 1, signatures: [] }),
            encoding: "base64",
          });
        }
        if (method === "PUT") {
          putAttempts += 1;
          if (putAttempts === 1)
            return fakeResponse(429, { message: "rate limited" });
          return fakeResponse(200, { content: { sha: "s2" } });
        }
        throw new Error(`unexpected call: ${method} ${url}`);
      };
      const result = await writeSignatures(
        "tok",
        (data) => ({
          ...data,
          signatures: [...data.signatures, { login: "dave" }],
        }),
        "dave signs",
      );
      assert.deepStrictEqual(
        result.signatures.map((s) => s.login),
        ["dave"],
      );
      assert.strictEqual(
        putAttempts,
        2,
        "expected 1 failed PUT attempt (429) before the retry succeeds",
      );
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });

  await test("gh() honors the Retry-After header for the backoff delay on a PUT (writeSignatures), not just a GET", async () => {
    const originalSetTimeout = global.setTimeout;
    const delaysSeen = [];
    global.setTimeout = (fn, ms) => {
      delaysSeen.push(ms);
      return originalSetTimeout(fn, 0);
    };
    let putAttempts = 0;
    try {
      global.fetch = async (url, opts) => {
        const method = (opts.method || "GET").toUpperCase();
        if (method === "GET") {
          return fakeResponse(200, {
            sha: "s1",
            content: b64({ version: 1, signatures: [] }),
            encoding: "base64",
          });
        }
        if (method === "PUT") {
          putAttempts += 1;
          if (putAttempts === 1)
            return fakeResponse(
              403,
              { message: "secondary rate limit" },
              { "retry-after": "3" },
            );
          return fakeResponse(200, { content: { sha: "s2" } });
        }
        throw new Error(`unexpected call: ${method} ${url}`);
      };
      await writeSignatures(
        "tok",
        (data) => ({
          ...data,
          signatures: [...data.signatures, { login: "eve" }],
        }),
        "eve signs",
      );
      assert.ok(
        delaysSeen.includes(3000),
        `expected a 3000ms backoff delay honoring Retry-After: 3 on the PUT, saw: ${delaysSeen}`,
      );
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });

  await test("getSignaturesToken's idempotent access_tokens mint (a POST) is retried up to MAX_RETRIES on a persistent transient failure, then propagates - not retried forever", async () => {
    delete require.cache[require.resolve("../src/cla-bot.js")];
    const { getSignaturesToken: freshGetToken } = require("../src/cla-bot.js");
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = (fn) => originalSetTimeout(fn, 0);
    let mintAttempts = 0;
    try {
      global.fetch = async (url) => {
        if (url.endsWith("/installation"))
          return fakeResponse(200, { id: 200 });
        if (url.includes("/access_tokens")) {
          mintAttempts += 1;
          return fakeResponse(503, { message: "Service Unavailable" });
        }
        throw new Error(`unexpected call: ${url}`);
      };
      let caught = null;
      try {
        await freshGetToken();
      } catch (e) {
        caught = e;
      }
      assert.ok(caught, "expected getSignaturesToken to eventually throw");
      assert.strictEqual(caught.status, 503);
      assert.strictEqual(
        mintAttempts,
        3,
        "expected exactly MAX_RETRIES (3) attempts on the idempotent POST, not unlimited retries and not fewer",
      );
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });

  // ===========================================================================
  // Rounding out the gh() retry matrix: a few specific combinations flagged
  // as still open - idempotent-but-non-transient, plain 403 without
  // Retry-After on the safe-to-retry methods, and ghRaw()'s empty-body ->
  // null path tested directly (the exact path behind the getSignaturesToken
  // null-tokenResp bug fixed above).
  // ===========================================================================
  await test("ghRaw's success path returns null (not an error, not {}) when the response body is a completely empty string", async () => {
    // readSignatures would choke on a null `data` (it expects a signatures
    // object), so this reaches into ghRaw()'s own success branch a
    // different way: through the getSignaturesToken mint call, where a
    // bare `null` is exactly the shape the validation fix above defends
    // against. This proves ghRaw() itself is what produces that null.
    delete require.cache[require.resolve("../src/cla-bot.js")];
    const { getSignaturesToken: freshGetToken } = require("../src/cla-bot.js");
    let sawEmptyBodyOnMint = false;
    global.fetch = async (url) => {
      if (url.endsWith("/installation")) return fakeResponse(200, { id: 999 });
      if (url.includes("/access_tokens")) {
        sawEmptyBodyOnMint = true;
        return {
          ok: true,
          status: 200,
          text: async () => "", // the exact case: `text ? JSON.parse(text) : null` -> null
          headers: { get: () => null },
        };
      }
      throw new Error(`unexpected call: ${url}`);
    };
    let caught = null;
    try {
      await freshGetToken();
    } catch (e) {
      caught = e;
    }
    assert.ok(sawEmptyBodyOnMint, "test setup sanity check");
    assert.ok(
      caught && !(caught instanceof TypeError),
      `ghRaw() must have returned a bare null here (not thrown, not {}) - and the caller's own validation, not a raw TypeError, must be what catches it. Got: ${caught && caught.constructor.name}`,
    );
  });

  await test("an idempotent-marked POST is still NOT retried on a non-transient error (e.g. 404) - idempotent only widens what's safe to retry, it doesn't force a retry", async () => {
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = (fn) => originalSetTimeout(fn, 0);
    delete require.cache[require.resolve("../src/cla-bot.js")];
    const { getSignaturesToken: freshGetToken } = require("../src/cla-bot.js");
    let mintAttempts = 0;
    try {
      global.fetch = async (url) => {
        if (url.endsWith("/installation"))
          return fakeResponse(200, { id: 501 });
        if (url.includes("/access_tokens")) {
          mintAttempts += 1;
          // getSignaturesToken's mint is the one real idempotent: true POST
          // in the codebase - a 404 here (e.g. the installation was
          // uninstalled between the two calls) is not transient and must
          // not be retried, despite idempotent: true.
          return fakeResponse(404, { message: "Not Found" });
        }
        throw new Error(`unexpected call: ${url}`);
      };
      let caught = null;
      try {
        await freshGetToken();
      } catch (e) {
        caught = e;
      }
      assert.ok(caught);
      assert.strictEqual(caught.status, 404);
      assert.strictEqual(
        mintAttempts,
        1,
        "a non-transient 404 must not be retried even on an idempotent-marked request",
      );
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });

  await test("a POST (idempotent: false, the default) is also NOT retried on a 429, the same as the already-tested 5xx case", async () => {
    let postAttempts = 0;
    global.fetch = async (url, opts) => {
      const method = (opts.method || "GET").toUpperCase();
      if (method === "GET" && url.includes("/comments")) {
        return fakeResponse(200, []); // dedupe pre-check: no existing comments
      }
      if (method === "POST") {
        postAttempts += 1;
        return fakeResponse(429, { message: "rate limited" });
      }
      throw new Error(`unexpected call: ${method} ${url}`);
    };
    let caught = null;
    try {
      await postComment(1, "hello");
    } catch (e) {
      caught = e;
    }
    assert.ok(caught);
    assert.strictEqual(caught.status, 429);
    assert.strictEqual(
      postAttempts,
      1,
      "a plain (non-idempotent) POST must not be retried on a 429 either - only 5xx was tested before, 429 is a distinct branch of the same status check",
    );
  });

  await test("a plain 403 WITHOUT a Retry-After header on a PUT is not retried (it's not the secondary-rate-limit case, just a permissions error)", async () => {
    let putAttempts = 0;
    global.fetch = async (url, opts) => {
      const method = (opts.method || "GET").toUpperCase();
      if (method === "GET") {
        return fakeResponse(200, {
          sha: "s1",
          content: b64({ version: 1, signatures: [] }),
          encoding: "base64",
        });
      }
      if (method === "PUT") {
        putAttempts += 1;
        return fakeResponse(403, { message: "Resource not accessible" }); // no retry-after header
      }
      throw new Error(`unexpected call: ${method} ${url}`);
    };
    let caught = null;
    try {
      await writeSignatures(
        "tok",
        (data) => ({
          ...data,
          signatures: [...data.signatures, { login: "someone" }],
        }),
        "someone signs",
      );
    } catch (e) {
      caught = e;
    }
    assert.ok(caught);
    assert.strictEqual(caught.status, 403);
    assert.strictEqual(
      putAttempts,
      1,
      "a plain 403 (no retry-after) must NOT be treated as transient, on PUT just like on GET - only 403+retry-after (secondary rate limit) qualifies",
    );
  });

  await test("a plain 403 WITHOUT a Retry-After header on a DELETE (duplicate-comment cleanup) is not retried and is swallowed by the per-comment warning, same as any other permanent DELETE failure", async () => {
    let getCount = 0;
    let deleteAttempts = 0;
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (msg) => warnings.push(msg);
    try {
      global.fetch = async (url, opts) => {
        const method = (opts.method || "GET").toUpperCase();
        if (method === "GET" && url.includes("/comments")) {
          getCount += 1;
          if (getCount === 1) return fakeResponse(200, []);
          return fakeResponse(200, [
            {
              id: 30,
              body: "<!-- fossasia-cla-bot:v1 -->\nplain403",
              user: { login: "github-actions[bot]" },
            },
            {
              id: 31,
              body: "<!-- fossasia-cla-bot:v1 -->\nplain403",
              user: { login: "github-actions[bot]" },
            },
          ]);
        }
        if (method === "POST") {
          return fakeResponse(201, {
            id: 31,
            body: "<!-- fossasia-cla-bot:v1 -->\nplain403",
            user: { login: "github-actions[bot]" },
          });
        }
        if (method === "DELETE") {
          deleteAttempts += 1;
          return fakeResponse(403, { message: "Resource not accessible" }); // no retry-after
        }
        throw new Error(`unexpected call: ${method} ${url}`);
      };
      await postComment(1, "plain403");
      assert.strictEqual(
        deleteAttempts,
        1,
        "a plain 403 (no retry-after) on a DELETE must NOT be retried - it's not transient",
      );
      assert.ok(
        warnings.some((w) => w.includes("duplicate comment 30")),
        "the permanent DELETE failure must still be swallowed as a warning by the outer per-comment catch, not thrown out of postComment",
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  // ===========================================================================
  // Signature store: the remaining readSignatures/writeSignatures branches -
  // the non-base64 encoding fallback, a non-404/non-transient error on the
  // initial read, and the isFirstWriteRace FALSE branch (a 422 that isn't
  // actually about a missing sha).
  // ===========================================================================
  await test("readSignatures falls back to a second, raw-media-type fetch when the metadata response has content but a non-base64 encoding", async () => {
    let getCount = 0;
    global.fetch = async () => {
      getCount += 1;
      if (getCount === 1) {
        // Some encoding other than "base64" (or content present but the
        // field simply isn't populated the expected way) - the base64
        // fast path must not be taken here.
        return fakeResponse(200, {
          sha: "s1",
          content: "irrelevant-because-encoding-is-wrong",
          encoding: "none",
        });
      }
      return fakeResponse(200, {
        version: 1,
        signatures: [{ login: "via-raw-fallback" }],
      });
    };
    const { sha, data } = await readSignatures("tok");
    assert.strictEqual(sha, "s1");
    assert.deepStrictEqual(data.signatures, [{ login: "via-raw-fallback" }]);
    assert.strictEqual(
      getCount,
      2,
      "a non-base64 encoding must trigger the second, raw-media-type request, just like a too-large file does",
    );
  });

  await test("readSignatures propagates a non-404, non-transient error (e.g. a permissions 403) on the initial read immediately, without retrying and without treating it as 'file doesn't exist yet'", async () => {
    let getCalls = 0;
    global.fetch = async () => {
      getCalls += 1;
      return fakeResponse(403, {
        message: "Resource not accessible by integration",
      });
    };
    let caught = null;
    try {
      await readSignatures("tok");
    } catch (e) {
      caught = e;
    }
    assert.ok(
      caught,
      "expected readSignatures to throw, not silently return an empty store",
    );
    assert.strictEqual(caught.status, 403);
    assert.strictEqual(
      getCalls,
      1,
      "a plain 403 is neither a 404 (empty store) nor transient (retryable) - it must surface immediately, on the first attempt",
    );
  });

  await test("writeSignatures does NOT treat a 422 as the first-write race when the error body's message doesn't actually mention a sha (isFirstWriteRace's message-pattern check must be specific, not just 'sha === null and status 422')", async () => {
    let putAttempts = 0;
    global.fetch = async (url, opts) => {
      const method = (opts.method || "GET").toUpperCase();
      if (method === "GET") {
        // sha === null: exactly the condition isFirstWriteRace requires
        // alongside status 422 - but the message below deliberately does
        // NOT mention "sha", so it must still be rejected as a race.
        return fakeResponse(404, { message: "Not Found" });
      }
      if (method === "PUT") {
        putAttempts += 1;
        return fakeResponse(422, {
          message: "Validation Failed: path is invalid",
        });
      }
      throw new Error(`unexpected call: ${method} ${url}`);
    };
    let caught = null;
    try {
      await writeSignatures(
        "tok",
        (data) => ({
          ...data,
          signatures: [...data.signatures, { login: "first-writer" }],
        }),
        "first-writer signs",
      );
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "expected writeSignatures to throw immediately");
    assert.strictEqual(caught.status, 422);
    assert.strictEqual(
      putAttempts,
      1,
      "a 422 whose message doesn't mention 'sha' must not be mistaken for the first-write race and retried",
    );
  });

  // ===========================================================================
  // ghRaw() tested directly (not just indirectly through some caller) -
  // its success-path body-parsing branch.
  // ===========================================================================
  await test("ghRaw itself (called directly) returns a bare null, not {} or an error, for a 200 OK response with a completely empty body", async () => {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => "",
      headers: { get: () => null },
    });
    const result = await ghRaw("/some/path", "tok");
    assert.strictEqual(result, null);
  });

  await test("ghRaw itself (called directly) parses and returns the JSON body for an ordinary 200 OK response", async () => {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ hello: "world" }),
      headers: { get: () => null },
    });
    const result = await ghRaw("/some/path", "tok");
    assert.deepStrictEqual(result, { hello: "world" });
  });

  // ===========================================================================
  // e.retryAfter present but safeToRetry === false: the delay-calculation
  // dead path. A plain (non-idempotent) POST getting a 403 WITH a
  // Retry-After header still must not be retried - `transient` is
  // `safeToRetry && (...)`, so a false safeToRetry short-circuits before
  // e.retryAfter is ever consulted, regardless of its value.
  // ===========================================================================
  await test("a plain POST (not idempotent) is not retried on a 403+Retry-After either - safeToRetry gates the whole transient check before retryAfter is ever looked at", async () => {
    let postAttempts = 0;
    global.fetch = async (url, opts) => {
      const method = (opts.method || "GET").toUpperCase();
      if (method === "GET" && url.includes("/comments")) {
        return fakeResponse(200, []); // dedupe pre-check: no existing comments
      }
      if (method === "POST") {
        postAttempts += 1;
        return fakeResponse(
          403,
          { message: "secondary rate limit" },
          { "retry-after": "5" },
        );
      }
      throw new Error(`unexpected call: ${method} ${url}`);
    };
    let caught = null;
    try {
      await postComment(1, "hello");
    } catch (e) {
      caught = e;
    }
    assert.ok(caught);
    assert.strictEqual(caught.status, 403);
    assert.strictEqual(
      postAttempts,
      1,
      "a non-idempotent POST must not be retried even with a Retry-After header present - method safety is checked first",
    );
  });

  // ===========================================================================
  // Exact attempt === MAX_RETRIES boundary, forced independently on PUT and
  // DELETE (GET and the idempotent POST mint are already covered
  // elsewhere).
  // ===========================================================================
  await test("a persistently-failing transient error (429) on a PUT (writeSignatures) is retried up to MAX_RETRIES (3) attempts, then propagates - not retried forever", async () => {
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = (fn) => originalSetTimeout(fn, 0);
    let putAttempts = 0;
    try {
      global.fetch = async (url, opts) => {
        const method = (opts.method || "GET").toUpperCase();
        if (method === "GET") {
          return fakeResponse(200, {
            sha: "s1",
            content: b64({ version: 1, signatures: [] }),
            encoding: "base64",
          });
        }
        if (method === "PUT") {
          putAttempts += 1;
          return fakeResponse(429, { message: "rate limited" });
        }
        throw new Error(`unexpected call: ${method} ${url}`);
      };
      let caught = null;
      try {
        await writeSignatures(
          "tok",
          (data) => ({
            ...data,
            signatures: [...data.signatures, { login: "persistent-429" }],
          }),
          "persistent-429 signs",
        );
      } catch (e) {
        caught = e;
      }
      assert.ok(caught, "expected writeSignatures to eventually throw");
      assert.strictEqual(caught.status, 429);
      assert.strictEqual(
        putAttempts,
        3,
        "expected exactly MAX_RETRIES (3) attempts on the PUT, not unlimited retries and not fewer",
      );
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });

  await test("a persistently-failing transient error (503) on a DELETE (duplicate-comment cleanup) is retried up to MAX_RETRIES (3) attempts, then swallowed by the outer per-comment warning - not thrown out of postComment", async () => {
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = (fn) => originalSetTimeout(fn, 0);
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (msg) => warnings.push(msg);
    let getCount = 0;
    let deleteAttempts = 0;
    try {
      global.fetch = async (url, opts) => {
        const method = (opts.method || "GET").toUpperCase();
        if (method === "GET" && url.includes("/comments")) {
          getCount += 1;
          if (getCount === 1) return fakeResponse(200, []);
          return fakeResponse(200, [
            {
              id: 50,
              body: "<!-- fossasia-cla-bot:v1 -->\npersistent503",
              user: { login: "github-actions[bot]" },
            },
            {
              id: 51,
              body: "<!-- fossasia-cla-bot:v1 -->\npersistent503",
              user: { login: "github-actions[bot]" },
            },
          ]);
        }
        if (method === "POST") {
          return fakeResponse(201, {
            id: 51,
            body: "<!-- fossasia-cla-bot:v1 -->\npersistent503",
            user: { login: "github-actions[bot]" },
          });
        }
        if (method === "DELETE") {
          deleteAttempts += 1;
          return fakeResponse(503, { message: "Service Unavailable" });
        }
        throw new Error(`unexpected call: ${method} ${url}`);
      };
      await postComment(1, "persistent503"); // must NOT throw
      assert.strictEqual(
        deleteAttempts,
        3,
        "expected exactly MAX_RETRIES (3) DELETE attempts before giving up on this one duplicate",
      );
      assert.ok(
        warnings.some((w) => w.includes("duplicate comment 50")),
        "after exhausting retries, the permanent failure must still be swallowed as a warning, not thrown out of postComment",
      );
    } finally {
      global.setTimeout = originalSetTimeout;
      console.warn = originalWarn;
    }
  });

  // ===========================================================================
  // getSignaturesToken(): installation lookup succeeds but the response has
  // no usable .id. This is now rejected BEFORE the mint request is ever
  // made - previously it flowed through unvalidated as the literal string
  // "undefined" in the access_tokens URL, and only surfaced as a
  // misleading 404 that named the wrong problem (a bad access_tokens
  // response, when the real issue was the installation lookup).
  // ===========================================================================
  await test("getSignaturesToken rejects a malformed installation-lookup response (no usable .id) BEFORE making any mint request at all", async () => {
    delete require.cache[require.resolve("../src/cla-bot.js")];
    const { getSignaturesToken: freshGetToken } = require("../src/cla-bot.js");
    let mintRequestMade = false;
    global.fetch = async (url) => {
      if (url.endsWith("/installation")) return fakeResponse(200, {}); // no `id` field at all
      if (url.includes("/access_tokens")) {
        mintRequestMade = true;
        return fakeResponse(200, { token: "should-never-be-reached" });
      }
      throw new Error(`unexpected call: ${url}`);
    };
    let caught = null;
    try {
      await freshGetToken();
    } catch (e) {
      caught = e;
    }
    assert.ok(
      caught,
      "expected getSignaturesToken to throw its own clear validation error",
    );
    assert.ok(
      /missing a usable "id" field/.test(caught.message),
      `expected a specific, actionable error naming the installation lookup as the problem, got: ${caught.message}`,
    );
    assert.strictEqual(
      mintRequestMade,
      false,
      "the mint request must never be attempted once the installation id is already known to be unusable - failing fast means not making a request that was always going to be pointless",
    );
  });

  // installation.id sits at the exact same trust boundary as a PR/issue
  // number (an externally-sourced value interpolated directly into a
  // request path), so it's held to the same Number.isSafeInteger() + > 0
  // bar assertValidPRNumber() already applies there via
  // assertValidInstallationId() - not just "is it typeof number". Each of
  // these is a value that a plain `typeof === "number"` check would have
  // wrongly accepted.
  //
  // NaN/Infinity/-Infinity are deliberately NOT in this list: they can
  // never actually reach getSignaturesToken() through a real HTTP
  // response, because JSON's grammar has no token for any of the three -
  // ghRaw()'s JSON.parse() can never produce them from response text.
  // (fakeResponse() JSON.stringify()s its body, and JSON.stringify()
  // itself silently turns all three into `null` - so mocking them here
  // would only retest the `null` case a second time under a misleading
  // name.) They're covered directly, against assertValidInstallationId()
  // itself, in test/logic.test.js instead - see the comment there.
  for (const { label, id } of [
    { label: "a non-numeric string", id: "not-a-number" },
    { label: "zero", id: 0 },
    { label: "a negative integer", id: -1 },
    { label: "a non-integer float", id: 1.5 },
    { label: "null", id: null },
    {
      label:
        "Number.MAX_SAFE_INTEGER + 1 (passes Number.isInteger, but not Number.isSafeInteger)",
      id: Number.MAX_SAFE_INTEGER + 1,
    },
  ]) {
    await test(`getSignaturesToken rejects an installation .id that is ${label}, before making any mint request at all`, async () => {
      delete require.cache[require.resolve("../src/cla-bot.js")];
      const {
        getSignaturesToken: freshGetToken,
      } = require("../src/cla-bot.js");
      let mintRequestMade = false;
      global.fetch = async (url) => {
        if (url.endsWith("/installation")) return fakeResponse(200, { id });
        if (url.includes("/access_tokens")) {
          mintRequestMade = true;
          return fakeResponse(200, { token: "should-never-be-reached" });
        }
        throw new Error(`unexpected call: ${url}`);
      };
      let caught = null;
      try {
        await freshGetToken();
      } catch (e) {
        caught = e;
      }
      assert.ok(caught, `expected getSignaturesToken to reject id=${label}`);
      assert.ok(/missing a usable "id" field/.test(caught.message));
      assert.strictEqual(
        mintRequestMade,
        false,
        `a mint request must never be attempted for an unusable id (${label})`,
      );
    });
  }

  await test("getSignaturesToken accepts a genuinely valid installation id (a real positive integer) and proceeds to mint normally", async () => {
    delete require.cache[require.resolve("../src/cla-bot.js")];
    const { getSignaturesToken: freshGetToken } = require("../src/cla-bot.js");
    global.fetch = async (url) => {
      if (url.endsWith("/installation"))
        return fakeResponse(200, { id: 987654 });
      if (url.includes("/access_tokens"))
        return fakeResponse(200, { token: "genuinely-valid-token" });
      throw new Error(`unexpected call: ${url}`);
    };
    const token = await freshGetToken();
    assert.strictEqual(token, "genuinely-valid-token");
  });

  // ===========================================================================
  // A whitespace-only token (e.g. "   ") is a non-empty string, so it would
  // pass a plain `.length === 0` check while still being just as unusable
  // as an empty one - the validation now checks the TRIMMED length.
  // ===========================================================================
  await test("getSignaturesToken rejects a whitespace-only token, not just an empty one", async () => {
    delete require.cache[require.resolve("../src/cla-bot.js")];
    const { getSignaturesToken: freshGetToken } = require("../src/cla-bot.js");
    global.fetch = async (url) => {
      if (url.endsWith("/installation")) return fakeResponse(200, { id: 115 });
      if (url.includes("/access_tokens"))
        return fakeResponse(200, { token: "   " }); // non-empty, but whitespace-only
      throw new Error(`unexpected call: ${url}`);
    };
    let caught = null;
    try {
      await freshGetToken();
    } catch (e) {
      caught = e;
    }
    assert.ok(
      caught,
      "expected a whitespace-only token to be rejected just like an empty one",
    );
    assert.ok(/missing a usable "token" field/.test(caught.message));
  });

  await test("getSignaturesToken trims incidental whitespace from an otherwise-valid token before caching it", async () => {
    // Defensive normalization, not something a real GitHub response should
    // ever need - if a token DOES arrive with stray whitespace around
    // otherwise-real content, the cached/returned value must be the clean
    // token, not a string with leading/trailing whitespace baked into every
    // future Authorization header built from it.
    delete require.cache[require.resolve("../src/cla-bot.js")];
    const { getSignaturesToken: freshGetToken } = require("../src/cla-bot.js");
    global.fetch = async (url) => {
      if (url.endsWith("/installation")) return fakeResponse(200, { id: 116 });
      if (url.includes("/access_tokens"))
        return fakeResponse(200, { token: "  real-token-with-padding  " });
      throw new Error(`unexpected call: ${url}`);
    };
    const token = await freshGetToken();
    assert.strictEqual(token, "real-token-with-padding");
  });

  // ===========================================================================
  // e.status >= 500 && e.status <= 599: every existing "5xx" test uses 500
  // or 503 generically, which proves large status codes get retried but
  // never actually forces the boundary itself - a status just below (499)
  // or just above (600) the range must NOT be treated as transient, and
  // 599 (the top of the range, inclusive) must still BE treated as
  // transient. Driven through readSignatures' GET, the simplest vehicle.
  // ===========================================================================
  await test("a 499 response (just below the 5xx transient range) is NOT retried", async () => {
    let getAttempts = 0;
    global.fetch = async () => {
      getAttempts += 1;
      return fakeResponse(499, { message: "Client Closed Request" });
    };
    let caught = null;
    try {
      await readSignatures("tok");
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "expected readSignatures to throw immediately");
    assert.strictEqual(caught.status, 499);
    assert.strictEqual(
      getAttempts,
      1,
      "499 is just outside the >= 500 transient range and must not be retried",
    );
  });

  await test("a 600 response (just above the 5xx transient range) is NOT retried", async () => {
    let getAttempts = 0;
    global.fetch = async () => {
      getAttempts += 1;
      return fakeResponse(600, { message: "non-standard status" });
    };
    let caught = null;
    try {
      await readSignatures("tok");
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "expected readSignatures to throw immediately");
    assert.strictEqual(caught.status, 600);
    assert.strictEqual(
      getAttempts,
      1,
      "600 is just outside the <= 599 transient range and must not be retried",
    );
  });

  await test("a 599 response (the top of the 5xx transient range, inclusive) IS retried and can still succeed", async () => {
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = (fn) => originalSetTimeout(fn, 0);
    let getAttempts = 0;
    try {
      global.fetch = async () => {
        getAttempts += 1;
        if (getAttempts === 1)
          return fakeResponse(599, { message: "edge of range" });
        return fakeResponse(200, {
          sha: "recovered-at-599-boundary",
          content: b64({ version: 1, signatures: [] }),
          encoding: "base64",
        });
      };
      const { sha } = await readSignatures("tok");
      assert.strictEqual(sha, "recovered-at-599-boundary");
      assert.strictEqual(
        getAttempts,
        2,
        "599 must still be treated as transient (the range is inclusive) and retried",
      );
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error("\nSOME TESTS FAILED.");
    process.exit(1);
  } else {
    console.log("ALL TESTS PASSED.");
  }
})();
