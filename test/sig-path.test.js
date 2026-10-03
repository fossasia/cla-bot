"use strict";
/**
 * Tests for how SIG_PATH / SIG_OWNER / SIG_REPO become signature-store request
 * URLs: validation (findSigPathProblem), per-segment encoding
 * (encodeRepoPath / sigContentsApiPath), the defense-in-depth refusal in the
 * URL builders, and the real CLI entrypoint's behaviour on a bad value.
 *
 * Why this exists: Node's fetch() parses URLs with the WHATWG algorithm, so
 * an unencoded "#" or "?" silently truncates the request path, "%2e%2e" is
 * collapsed into a real ".." traversal, and tab/CR/LF are silently stripped.
 * Because readSignatures() treats a 404 as "no signatures yet", a truncated
 * path looks exactly like an empty store and the bot would read/write the
 * WRONG file without any error. These tests pin down that this can't happen.
 *
 * Backward compatibility is part of the contract too (see CONTRIBUTING.md,
 * rule 4): every SIG_PATH the old, un-normalized code accepted must address
 * EXACTLY the same file now (byte-identical request URL, or - for
 * sub-delimiters like "+" - a semantically identical one). The old code's
 * quirks were: fetch()'s URL parser strips TRAILING C0-control-or-space
 * characters and collapses a leading "./"; everything else - including
 * LEADING whitespace and Unicode whitespace like NBSP at either end - stayed
 * part of the file name. The compat tests below therefore compare against
 * the old code's behaviour on the RAW value (never a pre-trimmed one, which
 * would hide exactly the divergence they exist to catch).
 *
 * No network, no mocking library. Run: node test/sig-path.test.js
 * (also part of `npm test`).
 */
const assert = require("assert");
const crypto = require("crypto");
const path = require("path");
const { spawnSync } = require("child_process");

const BOT_PATH = path.join(__dirname, "..", "src", "cla-bot.js");
const API = "https://api.github.com";

const BASE_ENV = {
  GITHUB_TOKEN: "dummy",
  SIG_OWNER: "fossasia",
  SIG_REPO: "cla-signatures",
  CLA_DOCUMENT_URL: "https://example.com/CLA.md",
  GITHUB_API_URL: API,
};

// The module reads its config into top-level constants at require() time, so
// each scenario needs a fresh load with its own env. Ambient SIG_PATH /
// SIG_APP_* values from the developer's shell or CI must never leak in.
function loadBot(overrides = {}) {
  const env = { ...BASE_ENV, ...overrides };
  const keys = new Set([
    ...Object.keys(env),
    "SIG_PATH",
    "SIG_APP_ID",
    "SIG_APP_PRIVATE_KEY",
  ]);
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[require.resolve(BOT_PATH)];
  try {
    return require(BOT_PATH);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    delete require.cache[require.resolve(BOT_PATH)];
  }
}

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

function fakeResponse(status, jsonBody) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (jsonBody === null ? "" : JSON.stringify(jsonBody)),
    headers: { get: () => null },
  };
}

// A tiny in-memory "GitHub Contents API" that behaves like the real server in
// the ways that matter here: it parses the URL the same way fetch() did,
// refuses anything that isn't exactly /repos/{owner}/{repo}/contents/{path}
// with no query and no fragment, percent-DECODES each segment, and stores the
// file under the decoded path. If the bot built a URL that got truncated,
// traversed, or double-encoded, `files` would end up with the wrong key.
function installFakeContentsApi({ owner, repo }) {
  const files = new Map(); // decoded repo path -> { sha, text }
  const requests = [];
  let shaCounter = 0;
  const prefix = `/repos/${owner}/${repo}/contents/`;
  global.fetch = async (url, opts = {}) => {
    const method = (opts.method || "GET").toUpperCase();
    requests.push({ url, method });
    const u = new URL(url);
    assert.strictEqual(u.search, "", `unexpected query string in ${url}`);
    assert.strictEqual(u.hash, "", `unexpected fragment in ${url}`);
    assert.ok(
      u.pathname.startsWith(prefix),
      `request escaped the contents API: ${u.pathname}`,
    );
    const key = u.pathname
      .slice(prefix.length)
      .split("/")
      .map(decodeURIComponent)
      .join("/");
    if (method === "GET") {
      const f = files.get(key);
      if (!f) return fakeResponse(404, { message: "Not Found" });
      return fakeResponse(200, {
        sha: f.sha,
        content: Buffer.from(f.text).toString("base64"),
        encoding: "base64",
      });
    }
    if (method === "PUT") {
      const body = JSON.parse(opts.body);
      shaCounter += 1;
      files.set(key, {
        sha: `sha${shaCounter}`,
        text: Buffer.from(body.content, "base64").toString("utf8"),
      });
      return fakeResponse(200, {});
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { files, requests };
}

const { findSigPathProblem, encodeRepoPath } = loadBot();

// Paths that must be accepted: ordinary ones plus the awkward-but-legal ones
// (hidden dirs, non-ASCII, URL sub-delims, "..."-like names that are NOT
// dot-segments) that percent-encoding has to carry through unharmed.
const VALID_PATHS = [
  "cla.json",
  "signatures/cla.json",
  "nested/dir/signatures.json",
  "a/b/c/d/e.json",
  ".github/cla.json",
  "a-b_c.d/e+f@g~h=i,j.json",
  "it's/(ok)/a!b*c.json",
  "file..name.json",
  "..hidden/x.json",
  "...",
  "a/.../b.json",
  "签名/协议.json",
  "ünï/cöde.json",
  "😀/sig.json",
  // Whitespace inside a path always worked (fetch sent it as %20 / UTF-8
  // escapes) and must keep working.
  "signatures/my file.json",
  "dir with space/cla.json",
  "lead space/ x.json",
  "a\u00a0b/x.json",
  "a\u2028b.json",
  // Leading whitespace and Unicode whitespace at either end are part of the
  // file name (the old code percent-encoded them); they are NOT trimmed.
  " leading.json",
  "\u00a0nbsp-lead/x.json",
  "nbsp-trail\u00a0",
];

// Paths that must be rejected, each with the reason it matters.
const INVALID_PATHS = [
  ["a '#' (fragment: request would silently hit \"sig\")", "sig#path.json"],
  ["a '?' (query string truncates the path)", "sig?q=1.json"],
  ["a literal '%'", "100%.json"],
  ["%2e%2e (collapsed into '..' by the URL parser)", "a/%2e%2e/b.json"],
  ["%2E%2E (upper-case variant)", "a/%2E%2E/b.json"],
  ["a bare %2e segment", "a/%2e/b.json"],
  ["%2f (encoded slash)", "a%2fb.json"],
  ["%5c (encoded backslash)", "a%5cb.json"],
  ["an interior tab (URL parser silently strips it)", "a\tb.json"],
  ["an interior newline (URL parser silently strips it)", "a\nb.json"],
  ["a carriage return", "a\rb.json"],
  ["a NUL byte", "a\x00b.json"],
  ["a DEL character", "a\x7fb.json"],
  ["a C1 control character", "a\u0085b.json"],
  ["a backslash", "signatures\\cla.json"],
  ["a leading slash", "/signatures/cla.json"],
  ["a trailing slash (directory, not a file)", "signatures/"],
  ["an empty segment", "signatures//cla.json"],
  ["a '.' segment in the middle", "a/./b.json"],
  ["a '..' segment at the start", "../cla.json"],
  ["a '..' segment in the middle", "a/../b.json"],
  ["a trailing '..' segment", "a/b/.."],
  ["a '.git' segment", "a/.git/b.json"],
  ["a '.GIT' segment (case-insensitive)", ".GIT/b.json"],
  ["a lone UTF-16 surrogate", "a\ud800b.json"],
  ["an empty string", ""],
  ["whitespace only", "   "],
  ["a lone '.'", "."],
];

(async () => {
  // ---- findSigPathProblem: pure validator ---------------------------------
  for (const p of VALID_PATHS) {
    await test(`findSigPathProblem accepts ${JSON.stringify(p)}`, () => {
      assert.strictEqual(findSigPathProblem(p), null);
    });
  }

  for (const [why, p] of INVALID_PATHS) {
    await test(`findSigPathProblem rejects ${why}`, () => {
      const problem = findSigPathProblem(p);
      assert.strictEqual(
        typeof problem,
        "string",
        `expected ${JSON.stringify(p)} to be rejected`,
      );
      assert.ok(problem.length > 0);
    });
  }

  await test("findSigPathProblem rejects non-string input without throwing", () => {
    for (const bad of [null, undefined, 42, {}, [], true]) {
      assert.strictEqual(typeof findSigPathProblem(bad), "string");
    }
  });

  await test("findSigPathProblem's message names the offending character, JSON-escaped (so the log line stays a single, readable line)", () => {
    assert.ok(findSigPathProblem("a#b").includes('"#"'));
    assert.ok(findSigPathProblem("a\nb").includes('"\\n"'));
    assert.ok(!findSigPathProblem("a\nb").includes("\n"));
  });

  // ---- encodeRepoPath -----------------------------------------------------
  await test("encodeRepoPath leaves ordinary paths byte-for-byte unchanged (no regression for the default and any existing config)", () => {
    for (const p of [
      "signatures/cla.json",
      "nested/dir/signatures.json",
      ".github/cla.json",
      "a-b_c.d/e.json",
    ]) {
      assert.strictEqual(encodeRepoPath(p), p);
    }
  });

  await test("encodeRepoPath keeps '/' separators literal and percent-encodes non-ASCII per segment", () => {
    assert.strictEqual(
      encodeRepoPath("ünï/cöde.json"),
      "%C3%BCn%C3%AF/c%C3%B6de.json",
    );
    assert.strictEqual(
      encodeRepoPath("签名/a.json"),
      "%E7%AD%BE%E5%90%8D/a.json",
    );
    assert.strictEqual(encodeRepoPath("a+b/c@d.json"), "a%2Bb/c%40d.json");
  });

  await test("encodeRepoPath encodes URL-significant characters that validation still allows ('=' ',' ';' space, non-ASCII): no raw '#', '?' or whitespace in the output, every '%' starts a well-formed escape, and decoding gives the input back", () => {
    const input = "a=b,c;d e/é.json";
    const out = encodeRepoPath(input);
    assert.ok(!/[#?\s]/.test(out), out);
    assert.ok(!/%(?![0-9A-F]{2})/.test(out), `malformed escape in ${out}`);
    assert.ok(
      out.includes("%20") && out.includes("%C3%A9") && out.includes("%3D"),
    );
    assert.strictEqual(out.split("/").map(decodeURIComponent).join("/"), input);
  });

  await test("encodeRepoPath throws (does not silently produce a URL) for every rejected path", () => {
    for (const [why, p] of INVALID_PATHS) {
      assert.throws(
        () => encodeRepoPath(p),
        /Refusing to build a request URL/,
        `expected encodeRepoPath to refuse ${why}`,
      );
    }
  });

  await test("encodeRepoPath round-trips every valid path (decode(encode(p)) === p) with each segment preserved", () => {
    for (const p of VALID_PATHS) {
      const enc = encodeRepoPath(p);
      assert.strictEqual(enc.split("/").length, p.split("/").length);
      assert.strictEqual(enc.split("/").map(decodeURIComponent).join("/"), p);
    }
  });

  // ---- URL builders -------------------------------------------------------
  await test("sigContentsApiPath: the default SIG_PATH yields exactly the URL the bot used before this change", () => {
    const bot = loadBot();
    assert.strictEqual(
      bot.sigContentsApiPath(),
      "/repos/fossasia/cla-signatures/contents/signatures/cla.json",
    );
  });

  await test("sigContentsApiPath: every valid path produces a URL that parses to exactly that path - no truncation, no query, no fragment, no traversal", () => {
    for (const p of VALID_PATHS) {
      const bot = loadBot({ SIG_PATH: p });
      const u = new URL(`${API}${bot.sigContentsApiPath()}`);
      assert.strictEqual(u.search, "", p);
      assert.strictEqual(u.hash, "", p);
      const prefix = "/repos/fossasia/cla-signatures/contents/";
      assert.ok(u.pathname.startsWith(prefix), `${p} -> ${u.pathname}`);
      const decoded = u.pathname
        .slice(prefix.length)
        .split("/")
        .map(decodeURIComponent)
        .join("/");
      assert.strictEqual(decoded, p);
    }
  });

  await test("sigInstallationApiPath encodes REPO too (a '/' can't smuggle in an extra path segment when the builder is reached without validateConfig)", () => {
    const bot = loadBot({ SIG_REPO: "we ird/repo" });
    assert.strictEqual(
      bot.sigInstallationApiPath(),
      "/repos/fossasia/we%20ird%2Frepo/installation",
    );
  });

  await test("sigInstallationApiPath encodes OWNER too, symmetrically with REPO", () => {
    const bot = loadBot({ SIG_OWNER: "we ird/owner" });
    assert.strictEqual(
      bot.sigInstallationApiPath(),
      "/repos/we%20ird%2Fowner/cla-signatures/installation",
    );
  });

  await test("sigContentsApiPath encodes both owner AND repo as well as the path", () => {
    const bot = loadBot({
      SIG_OWNER: "o/x",
      SIG_REPO: "r#y",
      SIG_PATH: "d e/f.json",
    });
    assert.strictEqual(
      bot.sigContentsApiPath(),
      "/repos/o%2Fx/r%23y/contents/d%20e/f.json",
    );
  });

  await test("the sig URL builders leave valid owner/repo names untouched (including '.', '-', '_' and a leading-dot repo like .github)", () => {
    assert.strictEqual(
      loadBot({ SIG_REPO: ".github" }).sigInstallationApiPath(),
      "/repos/fossasia/.github/installation",
    );
    assert.strictEqual(
      loadBot({
        SIG_OWNER: "a-b",
        SIG_REPO: "r_1.x-y",
      }).sigInstallationApiPath(),
      "/repos/a-b/r_1.x-y/installation",
    );
  });

  await test("both URL builders refuse a '.' or '..' owner/repo (dot-segments the URL parser would collapse)", () => {
    for (const [k, v] of [
      ["SIG_REPO", ".."],
      ["SIG_REPO", "."],
      ["SIG_OWNER", ".."],
      ["SIG_OWNER", "."],
    ]) {
      const bot = loadBot({ [k]: v });
      assert.throws(
        () => bot.sigInstallationApiPath(),
        /dot-segment/,
        `${k}=${v}`,
      );
      assert.throws(() => bot.sigContentsApiPath(), /dot-segment/, `${k}=${v}`);
    }
  });

  await test("the removed generic helper stays removed: the module exposes no 'base + arbitrary suffix' URL builder that could be misused with a dynamic value", () => {
    const bot = loadBot();
    assert.strictEqual(bot.sigRepoApiPath, undefined);
    assert.strictEqual(bot.sigRepoBasePath, undefined);
  });

  // ---- backward compatibility (CONTRIBUTING.md rule 4) --------------------
  // `oldUrl` is exactly what the pre-fix code built: raw interpolation,
  // normalized by fetch()'s own URL parsing.
  const oldPathname = (raw) =>
    new URL(`${API}/repos/fossasia/cla-signatures/contents/${raw}`).pathname;

  await test("compat: for paths containing spaces / Unicode whitespace / non-ASCII, the request pathname is BYTE-IDENTICAL to what the old, un-encoded code sent", () => {
    for (const raw of [
      "signatures/my file.json",
      "dir with space/cla.json",
      "lead space/ x.json",
      "a\u00a0b/x.json",
      "a\u2028b.json",
      "ünï/cöde.json",
      "签名/协议.json",
    ]) {
      const bot = loadBot({ SIG_PATH: raw });
      assert.strictEqual(
        new URL(`${API}${bot.sigContentsApiPath()}`).pathname,
        oldPathname(raw),
        raw,
      );
    }
  });

  await test("compat: for paths containing URL sub-delimiters ('+', '@', '=', ','), the request is semantically identical to the old one (same decoded path; only the redundant escaping differs)", () => {
    for (const raw of ["a+b/c@d.json", "x=y,z.json", "it's/(ok)!.json"]) {
      const bot = loadBot({ SIG_PATH: raw });
      const decode = (pn) =>
        pn
          .slice("/repos/fossasia/cla-signatures/contents/".length)
          .split("/")
          .map(decodeURIComponent)
          .join("/");
      assert.strictEqual(
        decode(new URL(`${API}${bot.sigContentsApiPath()}`).pathname),
        decode(oldPathname(raw)),
        raw,
      );
    }
  });

  // The exact whitespace contract, spelled out against the OLD behaviour on
  // the raw value. Each row: [raw SIG_PATH, what the old code actually
  // addressed (as a request-path tail)].
  const COMPAT_ROWS = [
    // trailing ASCII whitespace / C0 controls: stripped by the URL parser
    ["signatures/cla.json ", "signatures/cla.json"],
    ["signatures/cla.json   ", "signatures/cla.json"],
    ["signatures/cla.json\n", "signatures/cla.json"],
    ["signatures/cla.json\r\n\t ", "signatures/cla.json"],
    // (U+001F: another C0 control. NUL itself can't be exercised here -
    // process.env truncates a value at a NUL byte, so it would pass trivially.)
    ["signatures/cla.json\x1f", "signatures/cla.json"],
    // leading "./": collapsed by the URL parser
    ["./signatures/cla.json", "signatures/cla.json"],
    ["././signatures/cla.json", "signatures/cla.json"],
    ["./signatures/cla.json\n", "signatures/cla.json"],
    // LEADING whitespace: part of the file name, NOT stripped
    [" signatures/cla.json", "%20signatures/cla.json"],
    ["  signatures/cla.json  ", "%20%20signatures/cla.json"],
    ["\u00a0signatures/cla.json", "%C2%A0signatures/cla.json"],
    // Unicode whitespace at the END: encoded, NOT stripped
    ["signatures/cla.json\u00a0", "signatures/cla.json%C2%A0"],
    ["signatures/cla.json\u2003", "signatures/cla.json%E2%80%83"],
    // " ./x": the first segment is " ." (a real name), not a dot-segment
    [" ./signatures/cla.json", "%20./signatures/cla.json"],
  ];

  await test("compat: for every row, the OLD code's behaviour is what the table says (guards the table itself against being wrong)", () => {
    for (const [raw, expectedTail] of COMPAT_ROWS) {
      assert.strictEqual(
        oldPathname(raw),
        `/repos/fossasia/cla-signatures/contents/${expectedTail}`,
        JSON.stringify(raw),
      );
    }
  });

  await test("compat: the NEW code addresses exactly what the old code did for every row - compared on the RAW value, never a pre-trimmed one", () => {
    for (const [raw] of COMPAT_ROWS) {
      const bot = loadBot({ SIG_PATH: raw });
      assert.strictEqual(
        new URL(`${API}${bot.sigContentsApiPath()}`).pathname,
        oldPathname(raw),
        JSON.stringify(raw),
      );
    }
  });

  await test("leading whitespace is preserved as part of the path (percent-encoded), never trimmed - a blanket .trim() would silently address a different file", () => {
    assert.strictEqual(
      loadBot({ SIG_PATH: " signatures/cla.json" }).sigContentsApiPath(),
      "/repos/fossasia/cla-signatures/contents/%20signatures/cla.json",
    );
    assert.strictEqual(
      loadBot({ SIG_PATH: "\u00a0signatures/cla.json" }).sigContentsApiPath(),
      "/repos/fossasia/cla-signatures/contents/%C2%A0signatures/cla.json",
    );
    assert.notStrictEqual(
      loadBot({ SIG_PATH: "  signatures/cla.json  " }).sigContentsApiPath(),
      loadBot({ SIG_PATH: "signatures/cla.json" }).sigContentsApiPath(),
    );
  });

  await test("Unicode whitespace at the END is preserved (percent-encoded), not stripped - only trailing U+0000..U+0020 is", () => {
    assert.strictEqual(
      loadBot({ SIG_PATH: "signatures/cla.json\u00a0" }).sigContentsApiPath(),
      "/repos/fossasia/cla-signatures/contents/signatures/cla.json%C2%A0",
    );
  });

  await test("trailing ASCII whitespace/control characters ARE ignored (that is what the old URL parser did), including a mixed run", () => {
    const plain = loadBot({
      SIG_PATH: "signatures/cla.json",
    }).sigContentsApiPath();
    for (const raw of [
      "signatures/cla.json ",
      "signatures/cla.json\n",
      "signatures/cla.json \r\n\t ",
    ]) {
      assert.strictEqual(
        loadBot({ SIG_PATH: raw }).sigContentsApiPath(),
        plain,
        JSON.stringify(raw),
      );
    }
  });

  await test("normalization does not over-reach: '.' / './' / whitespace-only / an interior './' segment / a stripped-to-empty value are still refused by the builder", () => {
    for (const raw of [".", "./", "   ", " \n", "a/./b.json", ".//x.json"]) {
      assert.throws(
        () => loadBot({ SIG_PATH: raw }).sigContentsApiPath(),
        /Refusing to build a request URL/,
        JSON.stringify(raw),
      );
    }
  });

  await test("normalization is linear-time: a 200k-character run of spaces in the MIDDLE of the value does not stall (no polynomial-ReDoS)", () => {
    const raw = `a${" ".repeat(200_000)}b/${"x".repeat(10)}.json`;
    const t0 = Date.now();
    loadBot({ SIG_PATH: raw });
    assert.ok(Date.now() - t0 < 2000, "normalization took suspiciously long");
  });

  await test("test-data hygiene: VALID_PATHS and INVALID_PATHS contain no duplicates and share no entry", () => {
    const dup = (arr) => arr.filter((v, i) => arr.indexOf(v) !== i);
    const invalidValues = INVALID_PATHS.map(([, v]) => v);
    assert.deepStrictEqual(dup(VALID_PATHS), []);
    assert.deepStrictEqual(dup(invalidValues), []);
    assert.deepStrictEqual(
      VALID_PATHS.filter((v) => invalidValues.includes(v)),
      [],
    );
  });

  // ---- direct builder: absent / empty owner-repo -------------------------
  await test("both URL builders refuse an empty owner or repo (no silent '/repos//x' or '/repos/undefined/...')", () => {
    for (const k of ["SIG_OWNER", "SIG_REPO"]) {
      const bot = loadBot({ [k]: "" });
      assert.throws(() => bot.sigInstallationApiPath(), /missing or empty/, k);
      assert.throws(() => bot.sigContentsApiPath(), /missing or empty/, k);
    }
  });

  // ---- full read/write round trip against the fake Contents API ----------
  const originalFetch = global.fetch;
  for (const p of VALID_PATHS) {
    await test(`write then read round-trips through the real fetch URL for SIG_PATH ${JSON.stringify(p)} (file lands at exactly that repo path)`, async () => {
      try {
        const bot = loadBot({ SIG_PATH: p });
        const api = installFakeContentsApi({
          owner: "fossasia",
          repo: "cla-signatures",
        });
        const written = await bot.writeSignatures(
          "tok",
          (d) => ({
            ...d,
            signatures: [...d.signatures, { id: 1, login: "alice" }],
          }),
          "msg",
        );
        assert.deepStrictEqual([...api.files.keys()], [p]);
        assert.strictEqual(written.signatures.length, 1);
        const { sha, data } = await bot.readSignatures("tok");
        assert.strictEqual(sha, "sha1");
        assert.deepStrictEqual(data.signatures, [{ id: 1, login: "alice" }]);
      } finally {
        global.fetch = originalFetch;
      }
    });
  }

  await test("readSignatures' large-file fallback (empty content -> second raw GET) hits the identical, correctly-encoded URL both times", async () => {
    const valid = "ünï/sig-file.json"; // non-ASCII, so encoding is observable
    const bot = loadBot({ SIG_PATH: valid });
    const seen = [];
    try {
      global.fetch = async (url, opts = {}) => {
        seen.push({ url, accept: opts.headers && opts.headers.Accept });
        if (seen.length === 1) {
          return fakeResponse(200, {
            sha: "big",
            content: "",
            encoding: "none",
          });
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ version: 1, signatures: [] }),
          headers: { get: () => null },
        };
      };
      const { sha } = await bot.readSignatures("tok");
      assert.strictEqual(sha, "big");
      assert.strictEqual(seen.length, 2);
      const expected = `${API}/repos/fossasia/cla-signatures/contents/${encodeRepoPath(valid)}`;
      assert.strictEqual(seen[0].url, expected);
      assert.strictEqual(seen[1].url, expected);
      assert.match(seen[0].url, /%C3%BC/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test("GET and PUT both send the exact percent-encoded URL for a path containing characters fetch() would otherwise leave raw ('+', '@', '=', ',', non-ASCII)", async () => {
    const bot = loadBot({ SIG_PATH: "d+e/a@b=c,d-é.json" });
    const api = installFakeContentsApi({
      owner: "fossasia",
      repo: "cla-signatures",
    });
    try {
      await bot.writeSignatures("tok", (d) => ({ ...d }), "msg");
      const expected = `${API}/repos/fossasia/cla-signatures/contents/d%2Be/a%40b%3Dc%2Cd-%C3%A9.json`;
      assert.deepStrictEqual(
        api.requests.map((r) => [r.method, r.url]),
        [
          ["GET", expected],
          ["PUT", expected],
        ],
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test("findSigPathProblem gives a specific, actionable reason for the structural cases (not a generic one)", () => {
    assert.match(findSigPathProblem(""), /must not be empty/);
    assert.match(findSigPathProblem("   "), /must not be empty/);
    assert.match(findSigPathProblem("/a.json"), /relative/);
    assert.match(findSigPathProblem("a/"), /directory/);
    assert.match(findSigPathProblem("a//b"), /empty segment/);
    assert.match(findSigPathProblem("a/../b"), /"\.\."/);
    assert.match(findSigPathProblem("a/./b"), /"\."/);
    assert.match(findSigPathProblem("a/.git/b"), /\.git/);
    assert.match(findSigPathProblem("a\ud800"), /Unicode/);
  });

  await test("the default-path GET and PUT hit exactly https://api.github.com/repos/fossasia/cla-signatures/contents/signatures/cla.json", async () => {
    const bot = loadBot();
    const api = installFakeContentsApi({
      owner: "fossasia",
      repo: "cla-signatures",
    });
    try {
      await bot.writeSignatures("tok", (d) => ({ ...d }), "msg");
      const expected = `${API}/repos/fossasia/cla-signatures/contents/signatures/cla.json`;
      assert.deepStrictEqual(
        api.requests.map((r) => [r.method, r.url]),
        [
          ["GET", expected],
          ["PUT", expected],
        ],
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  // ---- defense in depth: bad value reaches the builder WITHOUT validateConfig
  // process.env can't carry every value a JS string can: a NUL byte truncates
  // the C string and a lone surrogate is rewritten to U+FFFD on the way in. A
  // real deployment's SIG_PATH can't contain those either, so those inputs are
  // covered at the pure-function level above (findSigPathProblem /
  // encodeRepoPath) and skipped in the env-driven scenarios here.
  const survivesEnv = (v) => {
    process.env.__SIG_PATH_PROBE = v;
    const ok = process.env.__SIG_PATH_PROBE === v;
    delete process.env.__SIG_PATH_PROBE;
    return ok;
  };
  for (const [why, p] of INVALID_PATHS) {
    if (p.trim() === "") continue; // "" falls back to the default via `||`; "   " is covered below
    if (!survivesEnv(p)) continue;
    await test(`readSignatures/writeSignatures refuse ${why} - no network call, and NOT mistaken for the 404 'empty store' case`, async () => {
      const bot = loadBot({ SIG_PATH: p });
      let calls = 0;
      try {
        // Every request would 404 - if the bad path were swallowed by the
        // 404 handler, readSignatures would wrongly resolve to an empty
        // store instead of rejecting.
        global.fetch = async () => {
          calls += 1;
          return fakeResponse(404, { message: "Not Found" });
        };
        await assert.rejects(
          bot.readSignatures("tok"),
          /Refusing to build a request URL/,
        );
        await assert.rejects(
          bot.writeSignatures("tok", (d) => ({ ...d }), "m"),
          /Refusing to build a request URL/,
        );
        assert.strictEqual(calls, 0, "no request may be sent for a bad path");
      } finally {
        global.fetch = originalFetch;
      }
    });
  }

  await test("whitespace-only SIG_PATH is refused by the builders too", async () => {
    const bot = loadBot({ SIG_PATH: "   " });
    let calls = 0;
    try {
      global.fetch = async () => {
        calls += 1;
        return fakeResponse(404, {});
      };
      await assert.rejects(bot.readSignatures("tok"), /Refusing/);
      assert.strictEqual(calls, 0);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test("a dot-segment SIG_REPO is refused by readSignatures and getSignaturesToken before any request is made", async () => {
    const key = crypto
      .generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs1", format: "pem" });
    const bot = loadBot({
      SIG_REPO: "..",
      SIG_APP_ID: "123",
      SIG_APP_PRIVATE_KEY: key,
    });
    let calls = 0;
    try {
      global.fetch = async () => {
        calls += 1;
        return fakeResponse(404, {});
      };
      await assert.rejects(bot.readSignatures("tok"), /dot-segment/);
      await assert.rejects(bot.getSignaturesToken(), /dot-segment/);
      assert.strictEqual(calls, 0);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test("getSignaturesToken's installation lookup still uses the repo-scoped URL for valid config (unchanged)", async () => {
    const key = crypto
      .generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs1", format: "pem" });
    const bot = loadBot({ SIG_APP_ID: "123", SIG_APP_PRIVATE_KEY: key });
    const urls = [];
    try {
      global.fetch = async (url) => {
        urls.push(url);
        if (url.endsWith("/installation")) return fakeResponse(200, { id: 9 });
        return fakeResponse(200, { token: "t0k" });
      };
      assert.strictEqual(await bot.getSignaturesToken(), "t0k");
      assert.strictEqual(
        urls[0],
        `${API}/repos/fossasia/cla-signatures/installation`,
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  // ---- real CLI entrypoint ------------------------------------------------
  function runCli(overrides) {
    return spawnSync(process.execPath, [BOT_PATH], {
      encoding: "utf8",
      timeout: 15_000,
      env: {
        PATH: process.env.PATH,
        ...BASE_ENV,
        // Nothing listens here: validateConfig() must fail first, so no
        // request should ever be attempted.
        GITHUB_API_URL: "http://127.0.0.1:1",
        ...overrides,
      },
    });
  }

  for (const p of [
    "sig#path.json",
    "sig?q=1.json",
    "a/%2e%2e/b.json",
    "my%20file.json",
  ]) {
    await test(`CLI exits 1 with a clear ::error:: naming SIG_PATH for ${JSON.stringify(p)}`, () => {
      const r = runCli({ SIG_PATH: p });
      assert.strictEqual(r.status, 1, r.stderr);
      assert.match(r.stderr, /^::error::SIG_PATH /m);
      assert.ok(
        r.stderr.includes(JSON.stringify(p)),
        `expected the JSON-quoted value in: ${r.stderr}`,
      );
    });
  }

  await test("CLI: a SIG_PATH containing a newline plus a forged workflow command cannot inject a second log line", () => {
    const r = runCli({ SIG_PATH: "a\n::warning::pwned" });
    assert.strictEqual(r.status, 1);
    for (const line of r.stderr.split("\n")) {
      assert.ok(
        !line.startsWith("::warning::pwned"),
        `injected command line found: ${line}`,
      );
    }
    assert.match(r.stderr, /^::error::SIG_PATH /m);
  });

  await test("CLI: a dot-segment SIG_REPO is rejected up front", () => {
    for (const repo of ["..", "."]) {
      const r = runCli({ SIG_REPO: repo });
      assert.strictEqual(r.status, 1, r.stderr);
      assert.match(r.stderr, /^::error::SIG_REPO /m);
    }
  });

  await test("CLI: the '%' rejection explains WHY and what to write instead (the migration path for 'my%20file.json')", () => {
    const r = runCli({ SIG_PATH: "my%20file.json" });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /^::error::SIG_PATH /m);
    assert.match(
      r.stderr,
      /encoding it again would silently address a different file/,
    );
    assert.match(
      r.stderr,
      /write the literal character instead \(a space, not "%20"\)/,
    );
  });

  // Previously-working values pass validateConfig (they reach the NEXT check,
  // the missing event file). Those that normalization changed also announce
  // it with a ::warning:: - never silently.
  for (const [p, normalized] of [
    ["signatures/my file.json", null],
    [" leading/space.json", null],
    ["\u00a0nbsp-lead.json", null],
    ["signatures/cla.json\u00a0", null],
    ["signatures/cla.json\n", "signatures/cla.json"],
    ["signatures/cla.json   ", "signatures/cla.json"],
    ["./signatures/cla.json", "signatures/cla.json"],
  ]) {
    await test(`CLI: previously-working SIG_PATH ${JSON.stringify(p)} still passes validateConfig${normalized ? " (with a normalization warning)" : " (no warning - used as-is)"}`, () => {
      const r = runCli({ SIG_PATH: p });
      assert.strictEqual(r.status, 1); // no GITHUB_EVENT_PATH - the NEXT check
      assert.match(r.stderr, /GITHUB_EVENT_PATH not found/);
      assert.ok(!/::error::SIG_PATH/.test(r.stderr), r.stderr);
      if (normalized) {
        assert.ok(
          r.stderr.includes(
            `::warning::SIG_PATH ${JSON.stringify(p)} was normalized to ${JSON.stringify(normalized)}`,
          ),
          r.stderr,
        );
        // The warning is one line even though the raw value had a newline.
        for (const line of r.stderr.split("\n")) {
          assert.ok(!line.startsWith("::warning::pwned"), line);
        }
      } else {
        assert.ok(!/normalized/.test(r.stderr), r.stderr);
      }
    });
  }

  await test("CLI: a default / already-clean SIG_PATH produces no normalization warning", () => {
    assert.ok(!/normalized/.test(runCli({}).stderr));
    assert.ok(
      !/normalized/.test(runCli({ SIG_PATH: "signatures/cla.json" }).stderr),
    );
  });

  for (const p of [".", "./", "   "]) {
    await test(`CLI: ${JSON.stringify(p)} is still rejected after normalization`, () => {
      const r = runCli({ SIG_PATH: p });
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /^::error::SIG_PATH /m);
    });
  }

  await test("CLI: a valid awkward-but-legal SIG_PATH passes validateConfig (proceeds to the event-file check instead)", () => {
    const r = runCli({ SIG_PATH: "签名/a+b@c.json" }); // no GITHUB_EVENT_PATH
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /GITHUB_EVENT_PATH not found/);
    assert.ok(!/SIG_PATH/.test(r.stderr));
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error("\nSOME TESTS FAILED.");
    process.exit(1);
  } else {
    console.log("ALL TESTS PASSED.");
  }
})();
