"use strict";
/**
 * dedupeIdenticalTrailingComments() deletes identical bot comments that a
 * race between two runs left behind. It also logs a ::warning:: when it finds
 * any, so a maintainer can notice a consuming workflow that is missing the
 * `concurrency:` group which is what actually prevents that race.
 *
 * The function is not exported, so it is exercised through postComment(),
 * the way the other dedupe tests do.
 *
 * Run: node test/duplicate-warning.test.js (also included in `npm test`)
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

const { postComment } = require("../src/cla-bot.js");

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

function resText(status, text) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    headers: { get: () => null },
  };
}

const BOT = { login: "github-actions[bot]" };
const MARKER = "<!-- fossasia-cla-bot:v1 -->";

// Runs postComment(PR 7, text) where the cleanup re-fetch (the 2nd GET) shows
// `extraIds` as byte-identical duplicates next to the comment just posted
// (id 100). `failDeleteIds` get a 403 on DELETE. `trackConcurrency` adds a
// small real delay to each DELETE so overlapping ones are actually
// observable, and the result reports the highest number seen in flight at
// once. Returns what was observed.
async function run({
  extraIds,
  postedId = 100,
  failDeleteIds = [],
  trackConcurrency = false,
  corruptSpool = false,
}) {
  const text = "dup-warning-body";
  const full = `${MARKER}\n${text}`;
  const warnings = [];
  const deleted = [];
  const originalWarn = console.warn;
  const originalCreateReadStream = fs.createReadStream;
  console.warn = (msg) => warnings.push(String(msg));
  if (corruptSpool) {
    fs.createReadStream = () => Readable.from(["not-a-comment-id"]);
  }
  let getCount = 0;
  let inFlightDeletes = 0;
  let maxInFlightDeletes = 0;
  global.fetch = async (url, opts = {}) => {
    const method = (opts.method || "GET").toUpperCase();
    if (url.includes("/issues/7/comments")) {
      if (method === "GET") {
        getCount += 1;
        if (getCount === 1) return res(200, []); // pre-check: nothing yet
        const history = [
          ...extraIds.map((id) => ({ id, body: full, user: BOT })),
          { id: postedId, body: full, user: BOT }, // the one just posted: newest
        ];
        // Model REST's numeric JSON ID tokens, including values that JSON.parse
        // would normally round. The production request opts into lossless ID
        // parsing for this endpoint.
        const json = JSON.stringify(history).replace(
          /("id":")([1-9]\d{15,})(")/g,
          (_match, prefix, decimalId) => `${prefix.slice(0, -1)}${decimalId}`,
        );
        return resText(200, json);
      }
      if (method === "POST")
        return res(201, { id: postedId, body: full, user: BOT });
    }
    if (url.includes("/issues/comments/") && method === "DELETE") {
      const rawId = url.split("/issues/comments/")[1];
      const numericId = Number(rawId);
      const id = Number.isSafeInteger(numericId) ? numericId : rawId;
      inFlightDeletes += 1;
      maxInFlightDeletes = Math.max(maxInFlightDeletes, inFlightDeletes);
      if (trackConcurrency) await new Promise((r) => setTimeout(r, 5));
      deleted.push(id);
      inFlightDeletes -= 1;
      return failDeleteIds.includes(id)
        ? res(403, { message: "Forbidden" })
        : res(204, null);
    }
    throw new Error(`unexpected call: ${method} ${url}`);
  };
  try {
    await postComment(7, text);
  } finally {
    console.warn = originalWarn;
    fs.createReadStream = originalCreateReadStream;
  }
  return {
    warnings,
    deleted: deleted.sort((a, b) => {
      const left = BigInt(a);
      const right = BigInt(b);
      return left < right ? -1 : left > right ? 1 : 0;
    }),
    maxInFlightDeletes,
  };
}

const isDupSummary = (w) => w.includes("duplicate bot comment(s)");

(async () => {
  await test("warns once, with the count and PR number, when duplicates are cleaned up", async () => {
    const { warnings, deleted } = await run({ extraIds: [98, 99] });
    assert.deepStrictEqual(
      deleted,
      [98, 99],
      "the older duplicates are deleted",
    );
    const summary = warnings.filter(isDupSummary);
    assert.strictEqual(summary.length, 1, `got: ${JSON.stringify(warnings)}`);
    assert.ok(
      summary[0].startsWith("::warning::"),
      "must be a workflow command",
    );
    assert.ok(summary[0].includes("Found 2 duplicate"), summary[0]);
    assert.ok(summary[0].includes("PR #7"), summary[0]);
  });

  await test("duplicate cleanup preserves unsafe comment IDs exactly through REST parsing, spool replay, and DELETE", async () => {
    const largeDuplicateIds = ["9007199254740993", "9007199254740994"];
    const { deleted, warnings } = await run({
      extraIds: largeDuplicateIds,
      postedId: "9007199254740995",
    });
    assert.deepStrictEqual(
      deleted,
      largeDuplicateIds,
      JSON.stringify({ deleted, warnings }),
    );
  });

  await test("duplicate cleanup refuses malformed IDs read from its private spool", async () => {
    const { deleted, warnings } = await run({
      extraIds: [98, 99],
      corruptSpool: true,
    });
    assert.deepStrictEqual(deleted, []);
    assert.ok(
      warnings.some((warning) =>
        warning.includes("invalid ID in its temporary file"),
      ),
      JSON.stringify(warnings),
    );
  });

  await test("the warning points the maintainer at the concurrency group", async () => {
    const { warnings } = await run({ extraIds: [99] });
    const [summary] = warnings.filter(isDupSummary);
    assert.ok(summary, "expected the summary warning");
    assert.ok(summary.includes("Found 1 duplicate"), summary);
    assert.ok(summary.includes("`concurrency:`"), summary);
    assert.ok(summary.includes("examples/consumer-workflow.yml"), summary);
    assert.ok(summary.includes("SECURITY.md"), summary);
  });

  await test("the warning never contains comment content", async () => {
    const { warnings } = await run({ extraIds: [99] });
    for (const w of warnings.filter(isDupSummary)) {
      assert.ok(!w.includes("dup-warning-body"), w);
      assert.ok(!w.includes(MARKER), w);
    }
  });

  await test("the warning is still logged when a delete then fails, next to the per-comment warning", async () => {
    const { warnings, deleted } = await run({
      extraIds: [98, 99],
      failDeleteIds: [98],
    });
    assert.deepStrictEqual(
      deleted,
      [98, 99],
      "a failed delete must not stop the rest",
    );
    assert.strictEqual(warnings.filter(isDupSummary).length, 1);
    assert.ok(
      warnings.some((w) => w.includes("Could not delete duplicate comment 98")),
      `got: ${JSON.stringify(warnings)}`,
    );
  });

  await test("many duplicates are still all deleted, but in batches of at most MAX_CONCURRENT_DELETES at once", async () => {
    const extraIds = Array.from({ length: 25 }, (_, i) => i + 1); // needs 3 batches (10/10/5)
    const { deleted, maxInFlightDeletes } = await run({
      extraIds,
      trackConcurrency: true,
    });
    assert.deepStrictEqual(
      deleted,
      extraIds,
      "every duplicate must still be deleted, not just the first batch",
    );
    assert.ok(
      maxInFlightDeletes <= 10,
      `at most 10 deletes should ever be in flight at once, saw ${maxInFlightDeletes}`,
    );
    assert.ok(
      maxInFlightDeletes >= 2,
      "this assertion is pointless unless deletes actually overlapped within a batch",
    );
  });

  await test("no warning (and no DELETE) when only the comment just posted is found", async () => {
    const { warnings, deleted } = await run({ extraIds: [] });
    assert.deepStrictEqual(deleted, []);
    assert.deepStrictEqual(warnings.filter(isDupSummary), []);
  });

  await test("no warning when the dedupe pre-check skips the post (identical comment already last)", async () => {
    const text = "already-there";
    const full = `${MARKER}\n${text}`;
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (msg) => warnings.push(String(msg));
    let calls = 0;
    global.fetch = async (url, opts = {}) => {
      calls += 1;
      const method = (opts.method || "GET").toUpperCase();
      if (method === "GET" && url.includes("/issues/7/comments")) {
        return res(200, [{ id: 5, body: full, user: BOT }]);
      }
      throw new Error(`unexpected call: ${method} ${url}`);
    };
    try {
      await postComment(7, text);
    } finally {
      console.warn = originalWarn;
    }
    assert.strictEqual(calls, 1, "only the pre-check GET; no POST, no cleanup");
    assert.deepStrictEqual(warnings, []);
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error("\nSOME TESTS FAILED.");
    process.exit(1);
  } else {
    console.log("ALL TESTS PASSED.");
  }
})();
