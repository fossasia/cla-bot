/**
 * End-to-end smoke tests for the CLI entrypoint.
 *
 * Every other test file requires src/cla-bot.js as a module, which never
 * exercises main() or the `if (require.main === module)` guard at the
 * bottom of the file (see the comment there - the whole point is that
 * requiring the file must NOT auto-run it). Those lines were previously
 * 100% uncovered.
 *
 * This file instead spawns `node src/cla-bot.js` as a real subprocess -
 * the same way the GitHub Actions runner invokes it - pointed at a local
 * HTTP server via GITHUB_API_URL (an existing, real override the code
 * already supports; see `const GITHUB_API = process.env.GITHUB_API_URL ||
 * ...`) instead of the real GitHub API.
 */

const assert = require("node:assert");
const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(REPO_ROOT, "src", "cla-bot.js");

// A single, securely-created temp directory for this whole test run.
// fs.mkdtempSync (unlike hand-building a path in the shared, world-writable
// os.tmpdir() with a timestamp/random suffix) creates a directory with an
// unguessable name and owner-only permissions (mode 0o700 on POSIX), which
// avoids the predictable-shared-tmp-path class of issues (symlink races,
// other local users reading/tampering with the file before we use it).
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cla-bot-e2e-"));
process.on("exit", () => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS: ${name}`);
  } catch (e) {
    process.exitCode = 1;
    console.error(`FAIL: ${name}\n${e && e.stack ? e.stack : e}`);
  }
}

function writeTempEventFile(payload) {
  const file = path.join(
    TMP_DIR,
    `event-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  fs.writeFileSync(file, JSON.stringify(payload));
  return file;
}

// Runs the real CLI entrypoint as an actual subprocess (so module-level
// consts like GITHUB_API/REPO_OWNER/REPO_NAME - computed once, at require
// time, from that process's own env - get exercised for real), while
// intercepting the very first fetch() call via a `-r`-preloaded module and
// immediately failing it with a synthetic, clearly-labeled error instead
// of ever performing real network I/O. This is what lets a test observe
// exactly which URL a module-level `X || <default>` fallback produced
// without needing to actually reach the real https://api.github.com (or
// any other live endpoint) to prove it.
function runScriptCapturingFirstFetchUrl(env, { timeoutMs = 10000 } = {}) {
  const preload = path.join(
    TMP_DIR,
    `capture-fetch-preload-${Date.now()}-${Math.random().toString(36).slice(2)}.js`,
  );
  fs.writeFileSync(
    preload,
    [
      "const originalFetch = global.fetch;",
      "let capturedUrl = null;",
      "global.fetch = async (url, opts) => {",
      "  if (capturedUrl === null) capturedUrl = String(url);",
      "  const err = new Error('synthetic-network-failure: intercepted before any real request was made');",
      "  throw err;",
      "};",
      "process.on('exit', () => {",
      "  process.stderr.write('\\n__CAPTURED_FETCH_URL__:' + capturedUrl + '\\n');",
      "});",
    ].join("\n"),
  );
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-r", preload, SCRIPT], {
      cwd: REPO_ROOT,
      env: buildChildEnv(env),
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fs.unlinkSync(preload);
      reject(new Error(`script did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      fs.unlinkSync(preload);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      fs.unlinkSync(preload);
      const match = stderr.match(/__CAPTURED_FETCH_URL__:(\S*)/);
      resolve({
        code,
        stdout,
        stderr,
        capturedUrl: match ? match[1] : null,
      });
    });
  });
}

function runScript(env, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      cwd: REPO_ROOT,
      env: buildChildEnv(env),
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`script did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// Every environment variable src/cla-bot.js reads, explicitly defaulted to
// "" (which every `process.env.X || fallback`/`process.env.X || ""` read in
// the source treats the same as unset).
//
// Deliberately NOT `{ ...process.env, ...overrides }`: spreading the
// parent's real environment would let anything the ambient shell/CI
// happens to export (SIG_APP_ID, SIG_APP_PRIVATE_KEY, GITHUB_TOKEN,
// REQUIRE_VERIFIED_COMMITS, ...) leak into the child and silently change
// which code path it takes - e.g. a developer with SIG_APP_ID/
// SIG_APP_PRIVATE_KEY set locally would flip the script from the plain
// GITHUB_TOKEN path into GitHub App authentication, which calls
// /repos/.../installation and /app/installations/.../access_tokens that
// this test's fake server doesn't implement, causing an unrelated failure
// that only reproduces on that one machine. Only a small, explicit
// allowlist of OS-level variables Node itself needs to actually run is
// passed through.
const OS_PASSTHROUGH_VARS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "windir",
];
const CLA_BOT_ENV_VARS = [
  "GITHUB_API_URL",
  "GITHUB_EVENT_NAME",
  "GITHUB_EVENT_PATH",
  "GITHUB_REPOSITORY",
  "GITHUB_TOKEN",
  "REQUIRE_VERIFIED_COMMITS",
  "SIG_APP_ID",
  "SIG_APP_PRIVATE_KEY",
  "SIG_OWNER",
  "SIG_REPO",
  "SIG_PATH",
  "CLA_DOCUMENT_URL",
  "ALLOWLIST",
];
function buildChildEnv(overrides) {
  const env = {};
  for (const key of OS_PASSTHROUGH_VARS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const key of CLA_BOT_ENV_VARS) {
    env[key] = "";
  }
  return { ...env, ...overrides };
}

// A minimal fake GitHub API, just enough to let a full run complete. Keeps
// real, mutable state for the signatures file and posted statuses (rather
// than always returning a fixed canned response) so a PUT actually changes
// what a later GET returns in the same run - otherwise a test could see
// "a write happened" and pass even if that write was never actually
// persisted or read back correctly by the rest of the flow.
function startFakeGitHub({ authorAlreadySigned }) {
  const requestsSeen = [];
  const statusesSeen = [];
  let signaturesState = {
    sha: "sig-sha-0",
    data: {
      version: 1,
      signatures: authorAlreadySigned ? [{ id: 42, login: "e2e-author" }] : [],
    },
  };
  const server = http.createServer((req, res) => {
    let rawBody = "";
    req.on("data", (c) => (rawBody += c));
    req.on("end", () => {
      requestsSeen.push({ method: req.method, url: req.url });
      const send = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(obj === null ? "" : JSON.stringify(obj));
      };
      if (req.url.includes("/pulls/1/commits")) {
        return send(200, [
          {
            sha: "e2e-commit-sha",
            author: { id: 42, login: "e2e-author" },
            committer: { id: 42 },
            parents: [{ sha: "parent" }],
            commit: {
              author: { email: "e2e-author@example.com" },
              verification: { verified: false },
            },
          },
        ]);
      }
      if (req.url.includes("/pulls/1") && !req.url.includes("/commits")) {
        return send(200, { head: { sha: "e2e-head-sha" } });
      }
      if (req.url.includes("/contents/signatures/cla.json")) {
        if (req.method === "GET") {
          const content = Buffer.from(
            JSON.stringify(signaturesState.data),
          ).toString("base64");
          return send(200, {
            sha: signaturesState.sha,
            content,
            encoding: "base64",
          });
        }
        if (req.method === "PUT") {
          let payload;
          try {
            payload = JSON.parse(rawBody);
          } catch {
            return send(400, { message: "malformed PUT body" });
          }
          // Real compare-and-swap semantics: reject a stale sha exactly
          // like GitHub does, so a PUT can't silently "succeed" against
          // state it never actually read.
          if ((payload.sha || null) !== signaturesState.sha) {
            return send(409, { message: "sha does not match" });
          }
          const newData = JSON.parse(
            Buffer.from(payload.content, "base64").toString("utf8"),
          );
          const newSha = `sig-sha-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          signaturesState = { sha: newSha, data: newData };
          return send(200, { content: { sha: newSha } });
        }
      }
      if (req.url.includes("/statuses/")) {
        let payload = {};
        try {
          payload = JSON.parse(rawBody);
        } catch {
          /* leave payload as {} - still record that a status was posted */
        }
        statusesSeen.push({ ...payload, sha: req.url.split("/statuses/")[1] });
        return send(201, {});
      }
      if (req.url.includes("/issues/1/comments")) {
        if (req.method === "GET") return send(200, []);
        if (req.method === "POST") {
          let payload = {};
          try {
            payload = JSON.parse(rawBody);
          } catch {
            /* leave payload as {} */
          }
          return send(201, { id: 1, body: payload.body || "" });
        }
      }
      if (/\/user$/.test(req.url)) {
        return send(404, { message: "Not Found" }); // forces the default bot-login fallback
      }
      // Anything unexpected: fail loudly so a broken assumption in this
      // fake server is obvious rather than silently hanging the child.
      return send(500, {
        message: `e2e fake server: unhandled ${req.method} ${req.url}`,
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requestsSeen,
        statusesSeen,
        getSignatures: () => signaturesState.data,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function baseEnv(apiUrl) {
  return {
    GITHUB_API_URL: apiUrl,
    GITHUB_TOKEN: "e2e-fake-token",
    GITHUB_REPOSITORY: "fossasia/e2e-test-repo",
    SIG_OWNER: "fossasia",
    SIG_REPO: "cla-signatures",
    SIG_PATH: "signatures/cla.json",
    CLA_DOCUMENT_URL: "https://example.com/CLA.md",
    ALLOWLIST: "",
  };
}

(async () => {
  await test("main() runs a full pull_request_target 'opened' event end-to-end via the real CLI entrypoint and exits 0 (author already signed -> success)", async () => {
    const server = await startFakeGitHub({ authorAlreadySigned: true });
    const eventFile = writeTempEventFile({
      action: "opened",
      pull_request: { number: 1, head: { sha: "e2e-head-sha" } },
    });
    try {
      const { code, stderr } = await runScript({
        ...baseEnv(server.url),
        GITHUB_EVENT_NAME: "pull_request_target",
        GITHUB_EVENT_PATH: eventFile,
      });
      assert.strictEqual(
        code,
        0,
        `expected exit code 0, got ${code}. stderr:\n${stderr}`,
      );
      assert.strictEqual(
        server.statusesSeen.length,
        1,
        "expected exactly one commit status to be posted",
      );
      assert.strictEqual(
        server.statusesSeen[0].state,
        "success",
        `expected a "success" status since the author already signed, got: ${JSON.stringify(server.statusesSeen[0])}`,
      );
      assert.strictEqual(
        server.statusesSeen[0].sha,
        "e2e-head-sha",
        "the status must be posted against the PR's actual head sha",
      );
    } finally {
      await server.close();
      fs.unlinkSync(eventFile);
    }
  });

  await test("main() does nothing but still exits 0 for an event type it doesn't handle (e.g. 'push')", async () => {
    const server = await startFakeGitHub({ authorAlreadySigned: true });
    const eventFile = writeTempEventFile({ ref: "refs/heads/main" });
    try {
      const { code, stdout } = await runScript({
        ...baseEnv(server.url),
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_PATH: eventFile,
      });
      assert.strictEqual(code, 0);
      assert.ok(
        /Nothing to do for event "push"/.test(stdout),
        `expected the "nothing to do" log line, got stdout:\n${stdout}`,
      );
      assert.strictEqual(
        server.requestsSeen.length,
        0,
        "an unhandled event type must not make any GitHub API calls at all",
      );
    } finally {
      await server.close();
      fs.unlinkSync(eventFile);
    }
  });

  // The test above only checks the event-name half of the "nothing to do"
  // log line - these pin down the exact `action "${payload.action}"`
  // interpolation too, for the two ways a real webhook payload can lack
  // a usable action: the field missing entirely (undefined) vs. present
  // but explicitly null.
  await test("main()'s 'nothing to do' log line renders action as the literal string \"undefined\" when payload.action is missing entirely", async () => {
    const server = await startFakeGitHub({ authorAlreadySigned: true });
    const eventFile = writeTempEventFile({ ref: "refs/heads/main" }); // no `action` key at all
    try {
      const { code, stdout } = await runScript({
        ...baseEnv(server.url),
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_PATH: eventFile,
      });
      assert.strictEqual(code, 0);
      assert.ok(
        stdout.includes('Nothing to do for event "push" / action "undefined".'),
        `expected the exact interpolated log line, got stdout:\n${stdout}`,
      );
    } finally {
      await server.close();
      fs.unlinkSync(eventFile);
    }
  });

  await test("main()'s 'nothing to do' log line renders action as the literal string \"null\" when payload.action is explicitly null", async () => {
    const server = await startFakeGitHub({ authorAlreadySigned: true });
    const eventFile = writeTempEventFile({
      ref: "refs/heads/main",
      action: null,
    });
    try {
      const { code, stdout } = await runScript({
        ...baseEnv(server.url),
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_PATH: eventFile,
      });
      assert.strictEqual(code, 0);
      assert.ok(
        stdout.includes('Nothing to do for event "push" / action "null".'),
        `expected the exact interpolated log line, got stdout:\n${stdout}`,
      );
    } finally {
      await server.close();
      fs.unlinkSync(eventFile);
    }
  });

  await test("the CLI entrypoint fails loudly and exits non-zero when GITHUB_EVENT_PATH doesn't point to a real file", async () => {
    const { code, stderr } = await runScript({
      ...baseEnv("http://127.0.0.1:1"), // unused - fails before any network call
      GITHUB_EVENT_NAME: "pull_request_target",
      GITHUB_EVENT_PATH: "/nonexistent/path/to/event.json",
    });
    assert.notStrictEqual(code, 0, "expected a non-zero exit code");
    assert.ok(
      /GITHUB_EVENT_PATH not found/.test(stderr),
      `expected a specific error about the missing event file, got stderr:\n${stderr}`,
    );
  });

  // The check is `if (!EVENT_PATH || !fs.existsSync(EVENT_PATH))` - the
  // test above exercises the RIGHT side (a real, non-empty path that just
  // doesn't exist). This one exercises the LEFT side specifically: no
  // GITHUB_EVENT_PATH at all (empty string, via buildChildEnv's default),
  // so `!EVENT_PATH` alone is true and short-circuits before
  // fs.existsSync() is ever called on it.
  await test("the CLI entrypoint fails loudly and exits non-zero when GITHUB_EVENT_PATH is entirely unset (as opposed to set-but-nonexistent)", async () => {
    const { code, stderr } = await runScript({
      ...baseEnv("http://127.0.0.1:1"), // unused - fails before any network call
      GITHUB_EVENT_NAME: "pull_request_target",
      // GITHUB_EVENT_PATH deliberately omitted - buildChildEnv() defaults
      // it to "", so `!EVENT_PATH` is the true operand here, not
      // `!fs.existsSync(EVENT_PATH)`.
    });
    assert.notStrictEqual(code, 0, "expected a non-zero exit code");
    assert.ok(
      /GITHUB_EVENT_PATH not found/.test(stderr),
      `expected the same specific error as the set-but-missing case, got stderr:\n${stderr}`,
    );
  });

  // ---------------------------------------------------------------------
  // This is the one path every other test in this file (and the rest of
  // the suite) misses: `main().catch((e) => fail(e.stack || e.message))`
  // at the very bottom of the file. Every OTHER fail() call in the source
  // (missing config, missing event file, ...) runs INSIDE main() itself
  // and calls process.exit(1) directly - main()'s promise never gets a
  // chance to reject, so that top-level .catch() handler never actually
  // runs for those cases. The only way to genuinely exercise it is an
  // exception main() throws itself and does NOT already catch - e.g. the
  // event file existing (so the fs.existsSync guard passes) but not being
  // valid JSON, so JSON.parse() inside main() throws a raw, unhandled
  // SyntaxError that only the top-level .catch() ever sees.
  // ---------------------------------------------------------------------
  await test("the CLI entrypoint's top-level main().catch() handler fires (and fails loudly) on a genuinely malformed - not just missing - GITHUB_EVENT_PATH file", async () => {
    const eventFile = path.join(
      TMP_DIR,
      `bad-event-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    // Deliberately invalid JSON, written to a file that DOES exist - this
    // must get past the fs.existsSync() check inside main() and fail only
    // once JSON.parse() itself throws.
    fs.writeFileSync(eventFile, "{ this is not valid json");
    try {
      const { code, stderr } = await runScript({
        ...baseEnv("http://127.0.0.1:1"), // unused - fails before any network call
        GITHUB_EVENT_NAME: "pull_request_target",
        GITHUB_EVENT_PATH: eventFile,
      });
      assert.notStrictEqual(
        code,
        0,
        `expected a non-zero exit code from the uncaught JSON.parse() rejection, got 0. stderr:\n${stderr}`,
      );
      assert.ok(
        /::error::/.test(stderr),
        `expected fail()'s "::error::"-prefixed output from the top-level catch handler, got stderr:\n${stderr}`,
      );
      assert.ok(
        /SyntaxError/.test(stderr),
        `expected the raw JSON.parse() SyntaxError (via e.stack) to surface through the catch handler, got stderr:\n${stderr}`,
      );
      // e.stack (not just e.message) is what fail() is given here - assert
      // the stack trace specifically, so this test can't quietly pass if a
      // future refactor swapped in e.message and lost the trace.
      assert.ok(
        /at main /.test(stderr) || /at main\(/.test(stderr),
        `expected a stack trace naming main() (proving e.stack, not just e.message, was used), got stderr:\n${stderr}`,
      );
    } finally {
      fs.unlinkSync(eventFile);
    }
  });

  // The test above exercises the LEFT side of `e.stack || e.message` - a
  // real thrown Error always has a `.stack`, so the RIGHT side is
  // genuinely unreachable through any real call path in this codebase:
  // every single `throw` here constructs a real `new Error(...)` (or
  // rethrows one), and every real Error has a truthy `.stack`. The only
  // honest way to exercise the fallback is to force something main()
  // calls to reject with a non-Error value - same wrapper-script technique
  // as the Node-version/fetch guard tests above, this time monkey-patching
  // fs.readFileSync (which main() calls unguarded, right after the
  // existsSync check) to throw a plain object that has a `.message` but
  // deliberately no `.stack` at all, proving the fallback itself is wired
  // correctly for the day something upstream ever does throw a
  // non-Error - not proving any current code path can trigger it.
  await test("the top-level main().catch() handler falls back to e.message when the rejection has no .stack at all (a non-Error throw)", async () => {
    const eventFile = path.join(
      TMP_DIR,
      `nonerror-event-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    // The file must genuinely exist so main()'s existsSync guard passes
    // and execution reaches the patched readFileSync call below.
    fs.writeFileSync(eventFile, JSON.stringify({ action: "opened" }));
    // A `-r`-preloaded module, NOT a wrapper that `require()`s the real
    // script - requiring cla-bot.js from another script would make THAT
    // script `require.main`, so `if (require.main === module)` inside
    // cla-bot.js would be false and main() would never even run. `-r`
    // preloads this file first but still runs cla-bot.js itself as the
    // actual entry point, keeping require.main correct.
    const preload = path.join(TMP_DIR, `nonerror-preload-${Date.now()}.js`);
    fs.writeFileSync(
      preload,
      [
        "const fs = require('fs');",
        "const originalReadFileSync = fs.readFileSync;",
        "fs.readFileSync = function (...args) {",
        `  if (args[0] === ${JSON.stringify(eventFile)}) {`,
        "    // A plain object, not an Error - no .stack property at all,",
        "    // only .message - exactly the shape that forces the RHS of",
        "    // `e.stack || e.message` to be the one actually used.",
        "    throw { message: 'synthetic non-Error rejection for e.message fallback test' };",
        "  }",
        "  return originalReadFileSync.apply(fs, args);",
        "};",
      ].join("\n"),
    );
    try {
      const { code, stderr } = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["-r", preload, SCRIPT], {
          cwd: REPO_ROOT,
          env: buildChildEnv({
            ...baseEnv("http://127.0.0.1:1"), // unused - fails before any network call
            GITHUB_EVENT_NAME: "pull_request_target",
            GITHUB_EVENT_PATH: eventFile,
          }),
        });
        let stderrOut = "";
        child.stderr.on("data", (d) => (stderrOut += d));
        child.on("error", reject);
        child.on("close", (c) => resolve({ code: c, stderr: stderrOut }));
      });
      assert.notStrictEqual(
        code,
        0,
        `expected a non-zero exit code, got 0. stderr:\n${stderr}`,
      );
      assert.ok(
        stderr.includes(
          "::error::synthetic non-Error rejection for e.message fallback test",
        ),
        `expected fail() to have used e.message verbatim (via the RHS of the ||, since .stack was absent), got stderr:\n${stderr}`,
      );
      assert.ok(
        !/at main/.test(stderr),
        "with no .stack on the thrown value, no stack trace naming main() should appear anywhere in the output - confirming the LHS (e.stack) was genuinely NOT what was used here",
      );
    } finally {
      fs.unlinkSync(eventFile);
      fs.unlinkSync(preload);
    }
  });

  // ===========================================================================
  // Two module-level `X || <default>` fallbacks, computed once at require
  // time from that process's own env - GITHUB_API (line ~67) and
  // REPO_OWNER/REPO_NAME (line ~184). Every other e2e test in this file
  // always sets both GITHUB_API_URL and GITHUB_REPOSITORY explicitly (via
  // baseEnv()), which only ever exercises the TRUTHY side of both. These
  // four force each side of each fallback independently, using
  // runScriptCapturingFirstFetchUrl() so the DEFAULT side (a real,
  // unset-env misconfiguration) can be observed without ever making a real
  // network call to the actual https://api.github.com.
  // ===========================================================================
  await test("GITHUB_API defaults to https://api.github.com when GITHUB_API_URL is unset", async () => {
    const eventFile = writeTempEventFile({
      action: "opened",
      pull_request: { number: 1, head: { sha: "test-sha" } },
    });
    try {
      const { capturedUrl } = await runScriptCapturingFirstFetchUrl({
        // GITHUB_API_URL deliberately omitted - buildChildEnv() defaults it
        // to "", so `"" || "https://api.github.com"` takes the RHS.
        GITHUB_TOKEN: "e2e-fake-token",
        GITHUB_REPOSITORY: "fossasia/e2e-test-repo",
        SIG_OWNER: "fossasia",
        SIG_REPO: "cla-signatures",
        SIG_PATH: "signatures/cla.json",
        CLA_DOCUMENT_URL: "https://example.com/CLA.md",
        ALLOWLIST: "",
        GITHUB_EVENT_NAME: "pull_request_target",
        GITHUB_EVENT_PATH: eventFile,
      });
      assert.ok(
        capturedUrl && capturedUrl.startsWith("https://api.github.com/"),
        `expected the default GitHub API host to be used, got: ${capturedUrl}`,
      );
    } finally {
      fs.unlinkSync(eventFile);
    }
  });

  await test("GITHUB_API uses GITHUB_API_URL verbatim when it's set, instead of the default host", async () => {
    const eventFile = writeTempEventFile({
      action: "opened",
      pull_request: { number: 1, head: { sha: "test-sha" } },
    });
    try {
      const { capturedUrl } = await runScriptCapturingFirstFetchUrl({
        GITHUB_API_URL: "https://custom-ghe-instance.example.test/api/v3",
        GITHUB_TOKEN: "e2e-fake-token",
        GITHUB_REPOSITORY: "fossasia/e2e-test-repo",
        SIG_OWNER: "fossasia",
        SIG_REPO: "cla-signatures",
        SIG_PATH: "signatures/cla.json",
        CLA_DOCUMENT_URL: "https://example.com/CLA.md",
        ALLOWLIST: "",
        GITHUB_EVENT_NAME: "pull_request_target",
        GITHUB_EVENT_PATH: eventFile,
      });
      assert.ok(
        capturedUrl &&
          capturedUrl.startsWith(
            "https://custom-ghe-instance.example.test/api/v3/",
          ),
        `expected the custom GITHUB_API_URL to be used verbatim (e.g. a GitHub Enterprise host), not the default, got: ${capturedUrl}`,
      );
    } finally {
      fs.unlinkSync(eventFile);
    }
  });

  await test('REPO_OWNER/REPO_NAME fall back to empty strings (via the "/" default) when GITHUB_REPOSITORY is unset - a real, if unlikely, misconfiguration', async () => {
    const eventFile = writeTempEventFile({
      action: "opened",
      pull_request: { number: 1, head: { sha: "test-sha" } },
    });
    try {
      const { capturedUrl } = await runScriptCapturingFirstFetchUrl({
        GITHUB_API_URL: "https://custom-ghe-instance.example.test/api/v3", // isolate this test to only the GITHUB_REPOSITORY fallback
        // GITHUB_REPOSITORY deliberately omitted - buildChildEnv() defaults
        // it to "", so `"" || "/"` takes the RHS, and "/".split("/")
        // yields ["", ""] for [REPO_OWNER, REPO_NAME].
        GITHUB_TOKEN: "e2e-fake-token",
        SIG_OWNER: "fossasia",
        SIG_REPO: "cla-signatures",
        SIG_PATH: "signatures/cla.json",
        CLA_DOCUMENT_URL: "https://example.com/CLA.md",
        ALLOWLIST: "",
        GITHUB_EVENT_NAME: "pull_request_target",
        GITHUB_EVENT_PATH: eventFile,
      });
      assert.ok(
        capturedUrl && capturedUrl.includes("/repos///pulls/"),
        `expected empty owner and repo segments (three consecutive slashes) from the "/" fallback, got: ${capturedUrl}`,
      );
    } finally {
      fs.unlinkSync(eventFile);
    }
  });

  await test('REPO_OWNER/REPO_NAME parse normally from a genuine "owner/repo" GITHUB_REPOSITORY', async () => {
    const eventFile = writeTempEventFile({
      action: "opened",
      pull_request: { number: 1, head: { sha: "test-sha" } },
    });
    try {
      const { capturedUrl } = await runScriptCapturingFirstFetchUrl({
        GITHUB_API_URL: "https://custom-ghe-instance.example.test/api/v3",
        GITHUB_REPOSITORY: "some-owner/some-repo",
        GITHUB_TOKEN: "e2e-fake-token",
        SIG_OWNER: "fossasia",
        SIG_REPO: "cla-signatures",
        SIG_PATH: "signatures/cla.json",
        CLA_DOCUMENT_URL: "https://example.com/CLA.md",
        ALLOWLIST: "",
        GITHUB_EVENT_NAME: "pull_request_target",
        GITHUB_EVENT_PATH: eventFile,
      });
      assert.ok(
        capturedUrl &&
          capturedUrl.includes("/repos/some-owner/some-repo/pulls/"),
        `expected REPO_OWNER="some-owner" and REPO_NAME="some-repo" to be parsed out correctly, got: ${capturedUrl}`,
      );
    } finally {
      fs.unlinkSync(eventFile);
    }
  });

  await test("main() runs a full issue_comment 'created' (sign phrase) event end-to-end via the real CLI entrypoint: the write is actually persisted and read back, ending in a 'success' status", async () => {
    const server = await startFakeGitHub({ authorAlreadySigned: false });
    const eventFile = writeTempEventFile({
      action: "created",
      issue: {
        number: 1,
        pull_request: {},
        user: { login: "e2e-author" },
      },
      comment: {
        user: { id: 42, login: "e2e-author" },
        body: "I have read the CLA Document and I hereby sign the CLA",
        html_url: "https://example.com/comment",
        author_association: "NONE",
      },
    });
    try {
      const { code, stderr } = await runScript({
        ...baseEnv(server.url),
        GITHUB_EVENT_NAME: "issue_comment",
        GITHUB_EVENT_PATH: eventFile,
      });
      assert.strictEqual(
        code,
        0,
        `expected exit code 0, got ${code}. stderr:\n${stderr}`,
      );

      // The PUT actually happened...
      assert.ok(
        server.requestsSeen.some(
          (r) =>
            r.method === "PUT" &&
            r.url.includes("/contents/signatures/cla.json"),
        ),
        "expected the sign phrase to result in a real write to the signatures file",
      );
      // ...and was genuinely persisted (not just accepted and discarded) -
      // the fake server's own state now has the signer in it.
      assert.ok(
        server
          .getSignatures()
          .signatures.some((s) => s.id === 42 && s.login === "e2e-author"),
        "the signer must actually be present in the (fake) signatures store after signing",
      );
      // ...and checkPR(), which re-reads signatures right after the write,
      // must have picked up that fresh state rather than a stale read -
      // the resulting status has to be "success", not "failure". This is
      // the part a test that only checks "a PUT happened" would miss
      // entirely if the write were silently discarded by a broken fake
      // server (or a broken real implementation).
      assert.strictEqual(
        server.statusesSeen.length,
        1,
        "expected exactly one commit status to be posted",
      );
      assert.strictEqual(
        server.statusesSeen[0].state,
        "success",
        `expected "success" after the only commit author signed, got: ${JSON.stringify(server.statusesSeen[0])}`,
      );
    } finally {
      await server.close();
      fs.unlinkSync(eventFile);
    }
  });

  await test("the Node-version guard fails loudly on an unsupported Node major version instead of hitting a confusing 'fetch is not defined' later", async () => {
    // src/cla-bot.js checks process.versions.node at require-time and exits
    // immediately on an unsupported major version. We can't literally run
    // this repo on Node 18 here, but process.versions.node is a plain,
    // overridable property - so a tiny wrapper script sets it to look like
    // an old Node before requiring the real file, exercising the exact
    // same code path a real old-Node run would hit.
    const wrapper = path.join(TMP_DIR, `oldnode-wrapper-${Date.now()}.js`);
    fs.writeFileSync(
      wrapper,
      [
        "Object.defineProperty(process, 'version', { value: 'v18.19.0', configurable: true });",
        "Object.defineProperty(process.versions, 'node', { value: '18.19.0', configurable: true });",
        `require(${JSON.stringify(SCRIPT)});`,
      ].join("\n"),
    );
    try {
      const { code, stderr } = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [wrapper], {
          cwd: REPO_ROOT,
          env: buildChildEnv(baseEnv("http://127.0.0.1:1")),
        });
        let stderrOut = "";
        child.stderr.on("data", (d) => (stderrOut += d));
        child.on("error", reject);
        child.on("close", (c) => resolve({ code: c, stderr: stderrOut }));
      });
      assert.notStrictEqual(
        code,
        0,
        "expected a non-zero exit code on an unsupported Node version",
      );
      assert.ok(
        /requires Node\.js >= 22/.test(stderr),
        `expected a specific version-requirement error, got stderr:\n${stderr}`,
      );
    } finally {
      fs.unlinkSync(wrapper);
    }
  });

  await test("the startup guard also fails loudly when global fetch is missing, independent of the Node-version check (the guard is `||`, not just a proxy for old Node)", async () => {
    // Same technique as the Node-version test above, but this time
    // process.versions.node is left alone (a real, supported version) and
    // only `fetch` itself is removed before the real file is required -
    // proving this is a genuinely separate condition in the `||`, not
    // something that only ever fires together with the version check.
    const wrapper = path.join(TMP_DIR, `nofetch-wrapper-${Date.now()}.js`);
    fs.writeFileSync(
      wrapper,
      ["delete globalThis.fetch;", `require(${JSON.stringify(SCRIPT)});`].join(
        "\n",
      ),
    );
    try {
      const { code, stderr } = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [wrapper], {
          cwd: REPO_ROOT,
          env: buildChildEnv(baseEnv("http://127.0.0.1:1")),
        });
        let stderrOut = "";
        child.stderr.on("data", (d) => (stderrOut += d));
        child.on("error", reject);
        child.on("close", (c) => resolve({ code: c, stderr: stderrOut }));
      });
      assert.notStrictEqual(
        code,
        0,
        "expected a non-zero exit code when global fetch is missing",
      );
      assert.ok(
        /requires Node\.js >= 22 with global fetch/.test(stderr),
        `expected the same specific version/fetch-requirement error, got stderr:\n${stderr}`,
      );
    } finally {
      fs.unlinkSync(wrapper);
    }
  });

  await test("main() is hermetic: an ambient SIG_APP_ID/SIG_APP_PRIVATE_KEY in the parent environment does NOT leak into the child and does NOT switch it into GitHub App auth", async () => {
    // Regression guard for the env-passthrough bug itself: temporarily set
    // these in *this* process's env (simulating a developer/CI machine
    // that happens to export them for unrelated reasons) and confirm the
    // child still takes the plain GITHUB_TOKEN path against a fake server
    // that would immediately 500 on the App-auth endpoints.
    const server = await startFakeGitHub({ authorAlreadySigned: true });
    const eventFile = writeTempEventFile({
      action: "opened",
      pull_request: { number: 1, head: { sha: "e2e-head-sha" } },
    });
    const previousAppId = process.env.SIG_APP_ID;
    const previousAppKey = process.env.SIG_APP_PRIVATE_KEY;
    process.env.SIG_APP_ID = "999999";
    process.env.SIG_APP_PRIVATE_KEY =
      "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----";
    try {
      const { code, stderr } = await runScript({
        ...baseEnv(server.url),
        GITHUB_EVENT_NAME: "pull_request_target",
        GITHUB_EVENT_PATH: eventFile,
      });
      assert.strictEqual(
        code,
        0,
        `expected exit code 0 (ambient SIG_APP_ID/KEY must not leak into the child), got ${code}. stderr:\n${stderr}`,
      );
      assert.ok(
        !server.requestsSeen.some((r) => r.url.includes("/installation")),
        "the child must not have attempted GitHub App installation lookup - SIG_APP_ID/KEY should not have leaked in",
      );
    } finally {
      if (previousAppId === undefined) delete process.env.SIG_APP_ID;
      else process.env.SIG_APP_ID = previousAppId;
      if (previousAppKey === undefined) delete process.env.SIG_APP_PRIVATE_KEY;
      else process.env.SIG_APP_PRIVATE_KEY = previousAppKey;
      await server.close();
      fs.unlinkSync(eventFile);
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
