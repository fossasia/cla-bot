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

const {
  readSignatures,
  writeSignatures,
  getSignaturesToken,
  postComment,
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

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error("\nSOME TESTS FAILED.");
    process.exit(1);
  } else {
    console.log("ALL TESTS PASSED.");
  }
})();
