"use strict";
/**
 * Offline tests for .github/scripts/release-check.js - the pre-flight and
 * SBOM helper behind the signed-release workflow. GitHub is never contacted:
 * `fetch` is injected. The CLI (`require.main`) path is exercised by running
 * the real script in a child process on scratch directories.
 * Run: node test/release-check.test.js (also part of `npm test`).
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const SCRIPT = path.join(
  __dirname,
  "..",
  ".github",
  "scripts",
  "release-check.js",
);
const {
  parseTag,
  extractChangelogSection,
  findReleaseProblems,
  verifyTagSignature,
  listActionDependencies,
  actionPurl,
  buildSbom,
  main,
} = require(SCRIPT);

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const COMMIT = "c".repeat(40);
const TAG_OBJECT = "d".repeat(40);

const CHANGELOG = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "- not yet",
  "",
  "## [1.2.3] - 2026-10-06",
  "",
  "### Added",
  "",
  "- the thing",
  "",
  "## [1.2.2]",
  "",
  "- older",
  "",
].join("\n");

const ACTION_YML = [
  "runs:",
  '  using: "composite"',
  "  steps:",
  `    - uses: actions/setup-node@${SHA_A} # v7.0.0`,
  "      with:",
  '        node-version: "22"',
  "    - uses: ./local-step",
  `    - uses: github/codeql-action/analyze@${SHA_B}`,
  "    # uses: not/a-real-step@main",
  "",
].join("\n");

const PACKAGE = {
  name: "cla-bot",
  version: "1.2.3",
  license: "Apache-2.0",
  dependencies: {},
};

async function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cla-bot-release-"));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeProject(dir, { pkg = PACKAGE, changelog = CHANGELOG } = {}) {
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  fs.writeFileSync(path.join(dir, "CHANGELOG.md"), changelog);
  fs.writeFileSync(path.join(dir, "action.yml"), ACTION_YML);
}

// A fake GitHub: `routes` maps an API path to a JSON body or a status code.
function fakeFetch(routes, seen = []) {
  return async (url, init) => {
    const apiPath = url.replace(
      "https://api.github.com/repos/fossasia/cla-bot/",
      "",
    );
    seen.push({ apiPath, init });
    const hit = routes[apiPath];
    if (typeof hit === "number") return { ok: false, status: hit };
    return { ok: true, status: 200, json: async () => hit };
  };
}

const annotatedRoutes = (overrides = {}) => ({
  "git/ref/tags/v1.2.3": { object: { type: "tag", sha: TAG_OBJECT } },
  [`git/tags/${TAG_OBJECT}`]: {
    object: { type: "commit", sha: COMMIT },
    verification: { verified: true, reason: "valid" },
    ...overrides,
  },
});

const baseEnv = (extra = {}) => ({
  RELEASE_TAG: "v1.2.3",
  GITHUB_SHA: COMMIT,
  GITHUB_REPOSITORY: "fossasia/cla-bot",
  GH_TOKEN: "token",
  ...extra,
});

const capture = () => {
  const out = [];
  const err = [];
  return { out, err, stdout: (m) => out.push(m), stderr: (m) => err.push(m) };
};

// --- parseTag ---------------------------------------------------------------

test("parseTag accepts strict stable semver tags only", () => {
  assert.strictEqual(parseTag("v1.2.3"), "1.2.3");
  assert.strictEqual(parseTag("v0.0.0"), "0.0.0");
  assert.strictEqual(parseTag("v10.20.30"), "10.20.30");
  for (const bad of [
    "1.2.3",
    "v1.2",
    "v1.2.3.4",
    "v01.2.3",
    "v1.02.3",
    "v1.2.03",
    "v1.2.3-rc.1",
    "v1.2.3+build",
    "v1.2.3\n",
    "refs/tags/v1.2.3",
    "",
    undefined,
  ]) {
    assert.strictEqual(parseTag(bad), null, `should reject ${bad}`);
  }
});

// --- changelog --------------------------------------------------------------

test("extractChangelogSection returns exactly one version's body", () => {
  assert.strictEqual(
    extractChangelogSection(CHANGELOG, "1.2.3"),
    "### Added\n\n- the thing",
  );
  // The last section runs to the end of the file; heading without a date.
  assert.strictEqual(extractChangelogSection(CHANGELOG, "1.2.2"), "- older");
});

test("extractChangelogSection is exact: no prefix/regex confusion, missing -> null", () => {
  assert.strictEqual(extractChangelogSection(CHANGELOG, "1.2"), null);
  assert.strictEqual(extractChangelogSection(CHANGELOG, "1.2.30"), null);
  assert.strictEqual(extractChangelogSection(CHANGELOG, "9.9.9"), null);
  // "." must not behave like a regex wildcard.
  assert.strictEqual(
    extractChangelogSection("## [1x2x3]\n\n- body\n", "1.2.3"),
    null,
  );
  assert.strictEqual(
    extractChangelogSection("## [1.2.3] - tomorrow\n\n- body\n", "1.2.3"),
    null,
    "only an ISO date may follow the version",
  );
});

// --- findReleaseProblems ----------------------------------------------------

test("findReleaseProblems is empty for a consistent release", () => {
  assert.deepStrictEqual(
    findReleaseProblems({
      tag: "v1.2.3",
      packageJson: PACKAGE,
      changelog: CHANGELOG,
    }),
    [],
  );
});

test("findReleaseProblems rejects a malformed tag and stops there", () => {
  const problems = findReleaseProblems({
    tag: "release-1",
    packageJson: PACKAGE,
    changelog: CHANGELOG,
  });
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /not a stable semver tag/);
});

test("findReleaseProblems reports a package.json version mismatch", () => {
  const problems = findReleaseProblems({
    tag: "v1.2.3",
    packageJson: { ...PACKAGE, version: "1.2.2" },
    changelog: CHANGELOG,
  });
  assert.strictEqual(problems.length, 1);
  assert.match(
    problems[0],
    /package\.json version is "1\.2\.2" but the tag is v1\.2\.3/,
  );
});

test("findReleaseProblems refuses npm runtime dependencies (the SBOM would be incomplete) but tolerates an absent field", () => {
  const withDeps = findReleaseProblems({
    tag: "v1.2.3",
    packageJson: { ...PACKAGE, dependencies: { left: "1.0.0" } },
    changelog: CHANGELOG,
  });
  assert.strictEqual(withDeps.length, 1);
  assert.match(withDeps[0], /runtime "dependencies"/);

  const { dependencies, ...noField } = PACKAGE;
  assert.ok(dependencies);
  assert.deepStrictEqual(
    findReleaseProblems({
      tag: "v1.2.3",
      packageJson: noField,
      changelog: CHANGELOG,
    }),
    [],
  );
});

test("findReleaseProblems reports a missing and an empty changelog section", () => {
  const missing = findReleaseProblems({
    tag: "v1.2.3",
    packageJson: PACKAGE,
    changelog: "# Changelog\n\n## [Unreleased]\n\n- x\n",
  });
  assert.match(missing.join("\n"), /no "## \[1\.2\.3\]" heading/);

  const empty = findReleaseProblems({
    tag: "v1.2.3",
    packageJson: PACKAGE,
    changelog: "## [1.2.3]\n\n## [1.2.2]\n\n- older\n",
  });
  assert.match(empty.join("\n"), /section "## \[1\.2\.3\]" is empty/);
});

test("findReleaseProblems collects every problem at once", () => {
  const problems = findReleaseProblems({
    tag: "v1.2.3",
    packageJson: { ...PACKAGE, version: "0.0.1", dependencies: { x: "1" } },
    changelog: "",
  });
  assert.strictEqual(problems.length, 3);
});

// --- verifyTagSignature -----------------------------------------------------

test("verifyTagSignature passes for a verified annotated tag on the right commit, and sends a well-formed request", async () => {
  const seen = [];
  const problems = await verifyTagSignature({
    repository: "fossasia/cla-bot",
    tag: "v1.2.3",
    commit: COMMIT,
    token: "secret-token",
    fetchImpl: fakeFetch(annotatedRoutes(), seen),
  });
  assert.deepStrictEqual(problems, []);
  assert.deepStrictEqual(
    seen.map((s) => s.apiPath),
    ["git/ref/tags/v1.2.3", `git/tags/${TAG_OBJECT}`],
  );
  const { headers, signal } = seen[0].init;
  assert.strictEqual(headers.Authorization, "Bearer secret-token");
  assert.strictEqual(headers["X-GitHub-Api-Version"], "2022-11-28");
  assert.ok(signal instanceof AbortSignal, "every request has a timeout");
});

test("verifyTagSignature rejects a lightweight tag without a second request", async () => {
  const seen = [];
  const problems = await verifyTagSignature({
    repository: "fossasia/cla-bot",
    tag: "v1.2.3",
    commit: COMMIT,
    token: "t",
    fetchImpl: fakeFetch(
      { "git/ref/tags/v1.2.3": { object: { type: "commit", sha: COMMIT } } },
      seen,
    ),
  });
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /lightweight tag/);
  assert.strictEqual(seen.length, 1);
});

test("verifyTagSignature rejects an unverified signature and reports GitHub's reason", async () => {
  const problems = await verifyTagSignature({
    repository: "fossasia/cla-bot",
    tag: "v1.2.3",
    commit: COMMIT,
    token: "t",
    fetchImpl: fakeFetch(
      annotatedRoutes({
        verification: { verified: false, reason: "unsigned" },
      }),
    ),
  });
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /reason: unsigned/);
});

test("verifyTagSignature treats a missing verification object and a missing reason as unverified/unknown", async () => {
  const noObject = await verifyTagSignature({
    repository: "fossasia/cla-bot",
    tag: "v1.2.3",
    commit: COMMIT,
    token: "t",
    fetchImpl: fakeFetch(annotatedRoutes({ verification: undefined })),
  });
  assert.match(noObject.join("\n"), /reason: unknown/);

  const noReason = await verifyTagSignature({
    repository: "fossasia/cla-bot",
    tag: "v1.2.3",
    commit: COMMIT,
    token: "t",
    fetchImpl: fakeFetch(
      annotatedRoutes({ verification: { verified: false } }),
    ),
  });
  assert.match(noReason.join("\n"), /reason: unknown/);
});

test("verifyTagSignature requires verified === true exactly (truthy strings do not count)", async () => {
  const problems = await verifyTagSignature({
    repository: "fossasia/cla-bot",
    tag: "v1.2.3",
    commit: COMMIT,
    token: "t",
    fetchImpl: fakeFetch(
      annotatedRoutes({ verification: { verified: "true", reason: "valid" } }),
    ),
  });
  assert.strictEqual(problems.length, 1);
});

test("verifyTagSignature rejects a tag pointing at another commit or at a non-commit", async () => {
  const wrongCommit = await verifyTagSignature({
    repository: "fossasia/cla-bot",
    tag: "v1.2.3",
    commit: "e".repeat(40),
    token: "t",
    fetchImpl: fakeFetch(annotatedRoutes()),
  });
  assert.match(wrongCommit.join("\n"), /does not point directly at the commit/);

  const nested = await verifyTagSignature({
    repository: "fossasia/cla-bot",
    tag: "v1.2.3",
    commit: COMMIT,
    token: "t",
    fetchImpl: fakeFetch(
      annotatedRoutes({ object: { type: "tag", sha: COMMIT } }),
    ),
  });
  assert.match(nested.join("\n"), /does not point directly at the commit/);
});

test("verifyTagSignature reports every problem together", async () => {
  const problems = await verifyTagSignature({
    repository: "fossasia/cla-bot",
    tag: "v1.2.3",
    commit: "e".repeat(40),
    token: "t",
    fetchImpl: fakeFetch(
      annotatedRoutes({
        verification: { verified: false, reason: "bad_cert" },
      }),
    ),
  });
  assert.strictEqual(problems.length, 2);
});

test("verifyTagSignature throws on an API error instead of guessing", async () => {
  await assert.rejects(
    verifyTagSignature({
      repository: "fossasia/cla-bot",
      tag: "v1.2.3",
      commit: COMMIT,
      token: "t",
      fetchImpl: fakeFetch({ "git/ref/tags/v1.2.3": 404 }),
    }),
    /returned HTTP 404/,
  );
});

test("verifyTagSignature uses the global fetch by default (no injected implementation)", async () => {
  const realFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return { ok: false, status: 500 };
  };
  try {
    await assert.rejects(
      verifyTagSignature({
        repository: "fossasia/cla-bot",
        tag: "v1.2.3",
        commit: COMMIT,
        token: "t",
      }),
      /HTTP 500/,
    );
  } finally {
    global.fetch = realFetch;
  }
  assert.strictEqual(calls, 1);
});

// --- SBOM -------------------------------------------------------------------

test("listActionDependencies finds pinned third-party actions, skips local ones and comments", () => {
  assert.deepStrictEqual(listActionDependencies(ACTION_YML), [
    { name: "actions/setup-node", ref: SHA_A, comment: "v7.0.0" },
    { name: "github/codeql-action/analyze", ref: SHA_B, comment: undefined },
  ]);
  assert.deepStrictEqual(
    listActionDependencies("runs:\n  using: composite\n"),
    [],
  );
});

test("listActionDependencies fails closed on anything that is not a full-SHA pin", () => {
  for (const target of [
    "actions/checkout@v4",
    "actions/checkout@main",
    `actions/checkout@${SHA_A.slice(0, 7)}`,
    "actions/checkout",
    `@${SHA_A}`,
    `"actions/checkout@${SHA_A}"`,
    "docker://alpine:3",
  ]) {
    assert.throws(
      () => listActionDependencies(`steps:\n  - uses: ${target}\n`),
      /not pinned to a full commit SHA/,
      target,
    );
  }
});

test("listActionDependencies cannot be dodged by an odd trailing comment or an unpinned line after a pinned one", () => {
  const yml = `- uses: actions/setup-node@${SHA_A} # v7.0.0 and some more words\n- uses: evil/thing@main # looks fine\n`;
  assert.throws(() => listActionDependencies(yml), /evil\/thing@main/);
  assert.deepStrictEqual(
    listActionDependencies(`- uses: a/b@${SHA_A} # v1 extra words here\n`),
    [{ name: "a/b", ref: SHA_A, comment: "v1" }],
  );
});

test("actionPurl lowercases and handles sub-path actions", () => {
  assert.strictEqual(
    actionPurl({ name: "Actions/Setup-Node", ref: SHA_A }),
    `pkg:githubactions/actions/setup-node@${SHA_A}`,
  );
  assert.strictEqual(
    actionPurl({ name: "github/codeql-action/upload-sarif", ref: SHA_B }),
    `pkg:githubactions/github/codeql-action@${SHA_B}#upload-sarif`,
  );
});

test("buildSbom describes the app and its pinned action dependencies as CycloneDX 1.6", () => {
  const sbom = buildSbom({
    packageJson: PACKAGE,
    tag: "v1.2.3",
    repository: "fossasia/cla-bot",
    actionYml: ACTION_YML,
    timestamp: "2026-10-06T00:00:00Z",
  });
  assert.strictEqual(sbom.bomFormat, "CycloneDX");
  assert.strictEqual(sbom.specVersion, "1.6");
  assert.strictEqual(sbom.metadata.timestamp, "2026-10-06T00:00:00Z");
  assert.strictEqual(
    sbom.metadata.component.purl,
    "pkg:github/fossasia/cla-bot@v1.2.3",
  );
  assert.deepStrictEqual(sbom.metadata.component.licenses, [
    { license: { id: "Apache-2.0" } },
  ]);
  assert.deepStrictEqual(
    sbom.components.map((c) => [c.name, c.version]),
    [
      ["actions/setup-node", "v7.0.0"],
      ["github/codeql-action/analyze", SHA_B],
    ],
  );
  assert.deepStrictEqual(sbom.dependencies, [
    {
      ref: "pkg:github/fossasia/cla-bot@v1.2.3",
      dependsOn: sbom.components.map((c) => c["bom-ref"]),
    },
  ]);
});

test("buildSbom omits the timestamp when none is given and tolerates zero dependencies", () => {
  const sbom = buildSbom({
    packageJson: PACKAGE,
    tag: "v1.2.3",
    repository: "fossasia/cla-bot",
    actionYml: "runs:\n  using: composite\n",
  });
  assert.ok(!("timestamp" in sbom.metadata));
  assert.deepStrictEqual(sbom.components, []);
  assert.deepStrictEqual(sbom.dependencies[0].dependsOn, []);
});

// --- main() (in process) ----------------------------------------------------

test("main prints usage and exits 2 for no / unknown subcommand", async () => {
  for (const argv of [[], ["publish"]]) {
    const io = capture();
    assert.strictEqual(await main(argv, {}, io), 2);
    assert.match(io.err.join("\n"), /usage:/);
  }
});

test("main verify: success writes the notes (changelog section + verification footer)", async () => {
  await withTmpDir(async (dir) => {
    writeProject(dir);
    const notes = path.join(dir, "notes.md");
    const io = capture();
    const code = await main(["verify", "--notes", notes], baseEnv(), {
      ...io,
      cwd: dir,
      fetchImpl: fakeFetch(annotatedRoutes()),
    });
    assert.strictEqual(code, 0);
    const text = fs.readFileSync(notes, "utf8");
    assert.ok(text.startsWith("### Added\n\n- the thing\n\n---\n"));
    assert.match(
      text,
      /https:\/\/github\.com\/fossasia\/cla-bot\/blob\/v1\.2\.3\/SECURITY\.md#verifying-a-release/,
    );
    assert.ok(!text.includes("## [1.2.2]"), "must not leak other versions");
    assert.match(io.out.join("\n"), /v1\.2\.3: tag, version, changelog/);
  });
});

test("main verify: static problems fail before GitHub is ever asked", async () => {
  await withTmpDir(async (dir) => {
    writeProject(dir, { pkg: { ...PACKAGE, version: "9.9.9" } });
    const io = capture();
    let asked = false;
    const code = await main(
      ["verify", "--notes", path.join(dir, "n.md")],
      baseEnv(),
      {
        ...io,
        cwd: dir,
        fetchImpl: async () => {
          asked = true;
          throw new Error("must not be called");
        },
      },
    );
    assert.strictEqual(code, 1);
    assert.strictEqual(asked, false);
    assert.match(
      io.err.join("\n"),
      /^::error::package\.json version is "9\.9\.9"/,
    );
    assert.ok(!fs.existsSync(path.join(dir, "n.md")), "no notes on failure");
  });
});

test("main verify: a signature problem fails and writes no notes", async () => {
  await withTmpDir(async (dir) => {
    writeProject(dir);
    const io = capture();
    const code = await main(
      ["verify", "--notes", path.join(dir, "n.md")],
      baseEnv(),
      {
        ...io,
        cwd: dir,
        fetchImpl: fakeFetch(
          annotatedRoutes({
            verification: { verified: false, reason: "unsigned" },
          }),
        ),
      },
    );
    assert.strictEqual(code, 1);
    assert.match(
      io.err.join("\n"),
      /::error::GitHub does not report v1\.2\.3 as verified/,
    );
    assert.ok(!fs.existsSync(path.join(dir, "n.md")));
  });
});

test("main verify: usage errors (missing flag / env / malformed repository) exit 2", async () => {
  await withTmpDir(async (dir) => {
    writeProject(dir);
    const run = (argv, env) =>
      main(argv, env, { ...capture(), cwd: dir, fetchImpl: fakeFetch({}) });
    assert.strictEqual(await run(["verify"], baseEnv()), 2);
    assert.strictEqual(await run(["verify", "--notes"], baseEnv()), 2);
    assert.strictEqual(
      await run(["verify", "--notes", "--other"], baseEnv()),
      2,
    );
    assert.strictEqual(
      await run(["verify", "--notes", "n.md"], baseEnv({ GH_TOKEN: "" })),
      2,
    );
    const io = capture();
    assert.strictEqual(
      await main(
        ["verify", "--notes", "n.md"],
        baseEnv({ GITHUB_REPOSITORY: "no-slash" }),
        {
          ...io,
          cwd: dir,
        },
      ),
      2,
    );
    assert.match(io.err.join("\n"), /not owner\/name/);
    const missing = capture();
    await main(["verify", "--notes", "n.md"], baseEnv({ GH_TOKEN: "" }), {
      ...missing,
      cwd: dir,
    });
    assert.match(missing.err.join("\n"), /Missing environment: GH_TOKEN/);
  });
});

test("main sbom: writes the SBOM file", async () => {
  await withTmpDir(async (dir) => {
    writeProject(dir);
    const out = path.join(dir, "sbom.json");
    const io = capture();
    const code = await main(
      ["sbom", "--out", out],
      {
        RELEASE_TAG: "v1.2.3",
        GITHUB_REPOSITORY: "fossasia/cla-bot",
        SOURCE_DATE_ISO: "2026-10-06T00:00:00Z",
      },
      { ...io, cwd: dir },
    );
    assert.strictEqual(code, 0);
    const text = fs.readFileSync(out, "utf8");
    assert.ok(text.endsWith("}\n"));
    const sbom = JSON.parse(text);
    assert.strictEqual(sbom.components.length, 2);
    assert.strictEqual(sbom.metadata.timestamp, "2026-10-06T00:00:00Z");
    assert.match(io.out.join("\n"), /2 component\(s\)/);
  });
});

test("main sbom: unpinned action.yml dependency, bad tag and usage errors", async () => {
  await withTmpDir(async (dir) => {
    writeProject(dir);
    fs.writeFileSync(
      path.join(dir, "action.yml"),
      "steps:\n  - uses: a/b@v1\n",
    );
    const env = {
      RELEASE_TAG: "v1.2.3",
      GITHUB_REPOSITORY: "fossasia/cla-bot",
    };
    const out = path.join(dir, "sbom.json");

    const unpinned = capture();
    assert.strictEqual(
      await main(["sbom", "--out", out], env, { ...unpinned, cwd: dir }),
      1,
    );
    assert.match(
      unpinned.err.join("\n"),
      /::error::action\.yml uses "a\/b@v1"/,
    );
    assert.ok(!fs.existsSync(out));

    const badTag = capture();
    assert.strictEqual(
      await main(
        ["sbom", "--out", out],
        { ...env, RELEASE_TAG: "nightly" },
        { ...badTag, cwd: dir },
      ),
      1,
    );
    assert.match(badTag.err.join("\n"), /"nightly" is not vMAJOR/);

    const badRepo = capture();
    assert.strictEqual(
      await main(
        ["sbom", "--out", out],
        { ...env, GITHUB_REPOSITORY: "x" },
        { ...badRepo, cwd: dir },
      ),
      2,
    );

    const noOut = capture();
    assert.strictEqual(await main(["sbom"], env, { ...noOut, cwd: dir }), 2);
    assert.match(noOut.err.join("\n"), /usage:/);

    const noEnv = capture();
    assert.strictEqual(
      await main(["sbom", "--out", out], {}, { ...noEnv, cwd: dir }),
      2,
    );
    assert.match(
      noEnv.err.join("\n"),
      /Missing environment: RELEASE_TAG, GITHUB_REPOSITORY/,
    );
  });
});

test("main uses process defaults for cwd/stdout/stderr/fetch when none are injected", async () => {
  const realLog = console.error;
  const lines = [];
  console.error = (m) => lines.push(m);
  try {
    assert.strictEqual(await main([], {}), 2);
  } finally {
    console.error = realLog;
  }
  assert.match(lines.join("\n"), /usage:/);
});

// --- the real CLI, in a child process ---------------------------------------

const cli = (args, { cwd, env = {} } = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });

test("CLI: sbom exits 0 and writes the file; exit code mirrors main()", async () => {
  await withTmpDir(async (dir) => {
    writeProject(dir);
    const out = path.join(dir, "sbom.json");
    const ok = cli(["sbom", "--out", out], {
      cwd: dir,
      env: { RELEASE_TAG: "v1.2.3", GITHUB_REPOSITORY: "fossasia/cla-bot" },
    });
    assert.strictEqual(ok.status, 0, ok.stderr);
    assert.ok(fs.existsSync(out));

    const usage = cli([], { cwd: dir });
    assert.strictEqual(usage.status, 2);
    assert.match(usage.stderr, /usage:/);
  });
});

test("CLI: an unexpected error (missing CHANGELOG.md) becomes ::error:: and exit 1, not a stack trace", async () => {
  await withTmpDir(async (dir) => {
    const result = cli(["verify", "--notes", path.join(dir, "n.md")], {
      cwd: dir,
      env: baseEnv(),
    });
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /^::error::ENOENT/);
    assert.ok(!/\n\s+at /.test(result.stderr), "no stack trace");
  });
});

// --- runner -----------------------------------------------------------------

async function runAll() {
  let passed = 0;
  for (const { name, fn } of cases) {
    try {
      await fn();
      console.log(`PASS: ${name}`);
      passed += 1;
    } catch (e) {
      console.error(`FAIL: ${name}\n - ${e.stack}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}/${cases.length} test(s) passed.`);
  if (process.exitCode) {
    console.error("SOME TESTS FAILED.");
  } else {
    console.log("ALL TESTS PASSED.");
  }
}

runAll();
