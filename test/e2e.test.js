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
        body: "> <!-- fossasia-cla-bot:v1 -->\n> Please comment on this PR to sign.\n\nI have read the CLA Document and I hereby sign the CLA",
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
