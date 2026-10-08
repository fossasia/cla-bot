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
const CDX = require("@cyclonedx/cyclonedx-library");

const SCRIPT = path.join(
  __dirname,
  "..",
  ".github",
  "scripts",
  "release-check.js",
);
const {
  parseTag,
  declaresDependencies,
  npmDependencyFields,
  inspectTag,
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
    tag: "v1.2.3",
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

test("extractChangelogSection handles Windows line endings and never compiles the version into a pattern", () => {
  const crlf = CHANGELOG.replace(/\n/g, "\r\n");
  assert.strictEqual(
    extractChangelogSection(crlf, "1.2.3"),
    "### Added\r\n\r\n- the thing",
  );
  // Only the literal heading counts: not indented, not a deeper heading,
  // not a different bracket text.
  assert.strictEqual(
    extractChangelogSection(" ## [1.2.3]\n- x\n", "1.2.3"),
    null,
  );
  assert.strictEqual(
    extractChangelogSection("### [1.2.3]\n- x\n", "1.2.3"),
    null,
  );
  assert.strictEqual(
    extractChangelogSection("## [1.2.3] extra\n- x\n", "1.2.3"),
    null,
  );
});

test("extractChangelogSection ignores headings inside fenced code blocks (backtick and tilde fences)", () => {
  const fenced = [
    "## [Unreleased]",
    "",
    "## [1.2.3]",
    "",
    "```md",
    "## [1.2.2]",
    "## Not a boundary",
    "```",
    "",
    "~~~~",
    "## Also not a boundary",
    "~~~",
    "still inside the longer tilde fence",
    "~~~~",
    "",
    "- real notes",
    "",
    "## [1.2.2]",
    "",
    "- older",
    "",
  ].join("\n");
  const section = extractChangelogSection(fenced, "1.2.3");
  assert.match(section, /## Not a boundary/);
  assert.match(section, /## Also not a boundary/);
  assert.match(section, /still inside the longer tilde fence/);
  assert.match(section, /- real notes$/);
  assert.ok(!section.includes("- older"));
  assert.strictEqual(extractChangelogSection(fenced, "1.2.2"), "- older");
  // A heading that only exists inside a fence is not a heading.
  assert.strictEqual(
    extractChangelogSection("```\n## [9.9.9]\n- x\n```\n", "9.9.9"),
    null,
  );
  // A ~~~ line does not close a ``` fence (and the other way round), however long.
  const wrongChar =
    "## [1.2.3]\n```\n~~~\n## still code\n~~~~~~\n```\n- after\n## [1.2.2]\n- old\n";
  assert.strictEqual(
    extractChangelogSection(wrongChar, "1.2.3"),
    "```\n~~~\n## still code\n~~~~~~\n```\n- after",
  );
  const wrongChar2 =
    "## [1.2.3]\n~~~\n```\n## still code\n````\n~~~\n- after\n## [1.2.2]\n- old\n";
  assert.strictEqual(
    extractChangelogSection(wrongChar2, "1.2.3"),
    "~~~\n```\n## still code\n````\n~~~\n- after",
  );
  // A closing fence needs the same character, enough length and nothing after it;
  // an unclosed fence runs to the end of the file.
  const notClosed = "## [1.2.3]\n```\n~~~\n``` js\n## [1.2.2]\n- hidden\n";
  assert.strictEqual(
    extractChangelogSection(notClosed, "1.2.3"),
    "```\n~~~\n``` js\n## [1.2.2]\n- hidden",
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

test("declaresDependencies: empty means empty, anything else counts (fail closed)", () => {
  for (const empty of [undefined, null, false, {}, []]) {
    assert.strictEqual(
      declaresDependencies(empty),
      false,
      JSON.stringify(empty),
    );
  }
  for (const declared of [{ left: "1.0.0" }, ["left"], true, "left", 1]) {
    assert.strictEqual(
      declaresDependencies(declared),
      true,
      JSON.stringify(declared),
    );
  }
});

test("findReleaseProblems refuses npm dependencies in EVERY field that can pull code in, but tolerates absent fields", () => {
  for (const [field, value] of [
    ["dependencies", { left: "1.0.0" }],
    ["optionalDependencies", { left: "1.0.0" }],
    ["peerDependencies", { left: "1.0.0" }],
    ["bundleDependencies", ["left"]],
    ["bundleDependencies", true],
    ["bundledDependencies", ["left"]],
  ]) {
    const problems = findReleaseProblems({
      tag: "v1.2.3",
      packageJson: { ...PACKAGE, [field]: value },
      changelog: CHANGELOG,
    });
    assert.strictEqual(problems.length, 1, field);
    assert.match(problems[0], new RegExp(`npm dependencies \\(${field}\\)`));
  }
  const several = findReleaseProblems({
    tag: "v1.2.3",
    packageJson: {
      ...PACKAGE,
      dependencies: { a: "1" },
      peerDependencies: { b: "1" },
    },
    changelog: CHANGELOG,
  });
  assert.match(several[0], /\(dependencies, peerDependencies\)/);

  // devDependencies are not shipped and stay allowed; absent fields are fine.
  const { dependencies, ...bare } = PACKAGE;
  assert.ok(dependencies);
  assert.deepStrictEqual(
    findReleaseProblems({
      tag: "v1.2.3",
      packageJson: { ...bare, devDependencies: { c8: "1" } },
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

test("verifyTagSignature rejects a validly signed tag object that carries a DIFFERENT tag name (replayed under a new ref)", async () => {
  for (const [label, overrides] of [
    ["another version", { tag: "v1.2.2" }],
    ["prefix of the name", { tag: "v1.2" }],
    ["suffix-extended name", { tag: "v1.2.30" }],
    ["different case", { tag: "V1.2.3" }],
    ["missing name field", { tag: undefined }],
  ]) {
    const problems = await verifyTagSignature({
      repository: "fossasia/cla-bot",
      tag: "v1.2.3",
      commit: COMMIT,
      token: "t",
      // signature valid, commit right: ONLY the name is wrong
      fetchImpl: fakeFetch(annotatedRoutes(overrides)),
    });
    assert.strictEqual(problems.length, 1, label);
    assert.match(
      problems[0],
      /signed tag object is named .* not "v1\.2\.3"/,
      label,
    );
  }
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
        tag: "v9.9.9",
        verification: { verified: false, reason: "bad_cert" },
      }),
    ),
  });
  assert.strictEqual(problems.length, 3);
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

test("inspectTag returns the inspected tag object's SHA (what the publish job later pins) and none for a lightweight tag", async () => {
  const ok = await inspectTag({
    repository: "fossasia/cla-bot",
    tag: "v1.2.3",
    commit: COMMIT,
    token: "t",
    fetchImpl: fakeFetch(annotatedRoutes()),
  });
  assert.deepStrictEqual(ok, { problems: [], tagObjectSha: TAG_OBJECT });

  const light = await inspectTag({
    repository: "fossasia/cla-bot",
    tag: "v1.2.3",
    commit: COMMIT,
    token: "t",
    fetchImpl: fakeFetch({
      "git/ref/tags/v1.2.3": { object: { type: "commit", sha: COMMIT } },
    }),
  });
  assert.strictEqual(light.problems.length, 1);
  assert.strictEqual(light.tagObjectSha, undefined);
});

// --- SBOM -------------------------------------------------------------------

// A minimal composite action.yml around some steps (given as already-indented
// YAML lines), so each test states only what it is about.
const composite = (stepsYaml) =>
  `runs:\n  using: composite\n  steps:\n${stepsYaml}\n`;

test("listActionDependencies finds pinned third-party actions and ignores commented-out ones", () => {
  assert.deepStrictEqual(listActionDependencies(ACTION_YML), [
    { name: "actions/setup-node", ref: SHA_A, comment: "v7.0.0" },
    { name: "github/codeql-action/analyze", ref: SHA_B, comment: undefined },
  ]);
  assert.deepStrictEqual(
    listActionDependencies(composite("    - run: echo hi")),
    [],
  );
  assert.deepStrictEqual(
    listActionDependencies("runs:\n  using: composite\n  steps: []\n"),
    [],
  );
});

test("listActionDependencies fails closed on anything that is not a full-SHA pin", () => {
  for (const target of [
    "actions/checkout@v4",
    "actions/checkout@main",
    `actions/checkout@${SHA_A}@extra`,
    `actions/checkout@${SHA_A.slice(0, 7)}`,
    "actions/checkout",
    `"@${SHA_A}"`,
    "docker://alpine:3",
  ]) {
    assert.throws(
      () => listActionDependencies(composite(`    - uses: ${target}`)),
      /not pinned to a full commit SHA/,
      target,
    );
  }
});

test("listActionDependencies parses YAML: no layout of a step can hide a dependency (flow style, next-line value, quoting, alias)", () => {
  const unpinned = "evil/thing@main";
  for (const [label, yml] of [
    [
      "flow-style steps",
      `runs: {using: composite, steps: [{uses: ${unpinned}}]}\n`,
    ],
    ["flow-style step", composite(`    - {name: x, uses: ${unpinned}}`)],
    ["value on the next line", composite(`    - uses:\n        ${unpinned}`)],
    ["quoted value", composite(`    - uses: "${unpinned}"`)],
    ["single-quoted value", composite(`    - uses: '${unpinned}'`)],
    [
      "step reused through an alias",
      `x: &s {uses: ${unpinned}}\nruns:\n  using: composite\n  steps:\n    - *s\n`,
    ],
  ]) {
    assert.throws(() => listActionDependencies(yml), /evil\/thing@main/, label);
  }
  // Valid YAML quoting of a PINNED action is understood, not rejected.
  assert.deepStrictEqual(
    listActionDependencies(
      composite(`    - uses: "actions/checkout@${SHA_A}" # v7.0.1`),
    ),
    [{ name: "actions/checkout", ref: SHA_A, comment: "v7.0.1" }],
  );
  assert.deepStrictEqual(
    listActionDependencies(
      composite(`    - uses:\n        actions/checkout@${SHA_A}`),
    ),
    [{ name: "actions/checkout", ref: SHA_A, comment: undefined }],
  );
});

test("a local `./` action is refused, not skipped (it resolves against the caller's workspace and could hide dependencies)", () => {
  for (const target of ["./local-step", "./.github/actions/thing", "./"]) {
    assert.throws(
      () =>
        listActionDependencies(
          composite(`    - uses: ${target}\n    - uses: a/b@${SHA_A}`),
        ),
      /local path .* does not model/s,
      target,
    );
  }
  // ...but a path that merely contains "./" is just an unpinned reference.
  assert.throws(
    () => listActionDependencies(composite("    - uses: a/./b@main")),
    /not pinned/,
  );
});

test("a `uses` key that is data, not a step, is NOT a dependency (inputs, with:, env)", () => {
  const yml = [
    "inputs:",
    "  uses:",
    "    description: an input that happens to be called uses",
    "runs:",
    "  using: composite",
    "  steps:",
    "    - run: echo hi",
    "      env:",
    "        uses: evil/thing@main",
    `    - uses: actions/setup-node@${SHA_A}`,
    "      with:",
    "        uses: also-not-a-dependency@main",
    "",
  ].join("\n");
  assert.deepStrictEqual(listActionDependencies(yml), [
    { name: "actions/setup-node", ref: SHA_A, comment: undefined },
  ]);
});

test("listActionDependencies only models composite actions and well-formed steps", () => {
  for (const [label, yml, message] of [
    [
      "node action",
      "runs:\n  using: node20\n  main: index.js\n",
      /must be a composite action/,
    ],
    [
      "docker action",
      "runs:\n  using: docker\n  image: docker://alpine:3\n",
      /must be a composite action/,
    ],
    ["no runs", "name: x\n", /must be a composite action/],
    ["steps missing", "runs:\n  using: composite\n", /steps must be a list/],
    [
      "steps not a list",
      "runs:\n  using: composite\n  steps: nope\n",
      /steps must be a list/,
    ],
    ["step is a string", composite("    - just a string"), /not a mapping/],
    ["step is null", composite("    - null"), /not a mapping/],
    ["step is a list", composite("    - [a, b]"), /not a mapping/],
  ]) {
    assert.throws(() => listActionDependencies(yml), message, label);
  }
});

test("listActionDependencies de-duplicates, rejects non-string `uses`, and rejects invalid or empty YAML", () => {
  const twice = composite(
    [
      `    - uses: a/b@${SHA_A}`,
      `    - uses: a/b@${SHA_A} # v1`,
      `    - uses: a/b@${SHA_B}`,
    ].join("\n"),
  );
  assert.deepStrictEqual(listActionDependencies(twice), [
    { name: "a/b", ref: SHA_A, comment: "v1" },
    { name: "a/b", ref: SHA_B, comment: undefined },
  ]);
  assert.throws(
    () => listActionDependencies(composite("    - uses: {nested: thing}")),
    /not a string/,
  );
  assert.throws(
    () => listActionDependencies("steps: [unclosed\n"),
    /YAMLException|end of the stream|unexpected/i,
  );
  // An empty document is an error (js-yaml throws), never "no dependencies".
  assert.throws(() => listActionDependencies(""), /empty/i);
});

test("version labels come only from real `uses:` lines and are dropped when ambiguous", () => {
  // A commented-out line must not label the real dependency.
  assert.deepStrictEqual(
    listActionDependencies(
      `# uses: actions/foo@${SHA_A} # v9.9.9\n` +
        composite(`    - uses: actions/foo@${SHA_A}`),
    ),
    [{ name: "actions/foo", ref: SHA_A, comment: undefined }],
  );
  // The same pin labelled differently on two lines: no label rather than a guess.
  assert.deepStrictEqual(
    listActionDependencies(
      composite(
        [
          `    - uses: actions/foo@${SHA_A} # v1.0.0`,
          `    - uses: actions/foo@${SHA_A} # v2.0.0`,
        ].join("\n"),
      ),
    ),
    [{ name: "actions/foo", ref: SHA_A, comment: undefined }],
  );
  // Disagreement stays disagreement even with a third, agreeing line.
  assert.deepStrictEqual(
    listActionDependencies(
      composite(
        [
          `    - uses: actions/foo@${SHA_A} # v1.0.0`,
          `    - uses: actions/foo@${SHA_A} # v2.0.0`,
          `    - uses: actions/foo@${SHA_A} # v2.0.0`,
        ].join("\n"),
      ),
    ),
    [{ name: "actions/foo", ref: SHA_A, comment: undefined }],
  );
  // Agreeing labels, and labels for a quoted target, are kept.
  assert.deepStrictEqual(
    listActionDependencies(
      composite(
        [
          `    - uses: actions/foo@${SHA_A} # v1.0.0`,
          `    - uses: "actions/foo@${SHA_A}" # v1.0.0`,
        ].join("\n"),
      ),
    ),
    [{ name: "actions/foo", ref: SHA_A, comment: "v1.0.0" }],
  );
});

test("listActionDependencies cannot be dodged by an odd trailing comment or an unpinned line after a pinned one", () => {
  const yml = composite(
    `    - uses: actions/setup-node@${SHA_A} # v7.0.0 and some more words\n    - uses: evil/thing@main # looks fine`,
  );
  assert.throws(() => listActionDependencies(yml), /evil\/thing@main/);
  assert.deepStrictEqual(
    listActionDependencies(
      composite(`    - uses: a/b@${SHA_A} # v1 extra words here`),
    ),
    [{ name: "a/b", ref: SHA_A, comment: "v1" }],
  );
});

test("listActionDependencies rejects malformed owner/repository/action identifiers", () => {
  for (const name of [
    "/repo",
    "owner/",
    "owner/repo/",
    "owner//repo",
    "../owner/repo",
    "owner/../repo",
    "owner/repo/..",
    "owner/repo?query",
    "owner/repo name",
  ]) {
    assert.throws(
      () => listActionDependencies(composite(`    - uses: ${name}@${SHA_A}`)),
      /invalid owner\/repository\/action path/,
      name,
    );
  }
  assert.deepStrictEqual(
    listActionDependencies(
      composite(`    - uses: github/codeql-action/upload-sarif@${SHA_A}`),
    ),
    [
      {
        name: "github/codeql-action/upload-sarif",
        ref: SHA_A,
        comment: undefined,
      },
    ],
  );
});

test("actionPurl lowercases and handles sub-path actions", () => {
  assert.strictEqual(
    actionPurl({ name: "Actions/Setup-Node", ref: SHA_A }),
    `pkg:github/actions/setup-node@${SHA_A}`,
  );
  assert.strictEqual(
    actionPurl({ name: "github/codeql-action/upload-sarif", ref: SHA_B }),
    `pkg:github/github/codeql-action@${SHA_B}#upload-sarif`,
  );
});

test("buildSbom describes the app and its pinned action dependencies as CycloneDX 1.6, versioned by pinned commit", () => {
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
  // version is the verifiable commit; the source comment is only an annotation
  assert.deepStrictEqual(
    sbom.components.map((c) => [c.name, c.version, c.properties]),
    [
      [
        "actions/setup-node",
        SHA_A,
        [{ name: "fossasia:cla-bot:ref-comment", value: "v7.0.0" }],
      ],
      ["github/codeql-action/analyze", SHA_B, undefined],
    ],
  );
  assert.ok(sbom.components.every((c) => c.purl.includes(`@${c.version}`)));
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
    actionYml: "runs:\n  using: composite\n  steps: []\n",
  });
  assert.ok(!("timestamp" in sbom.metadata));
  assert.deepStrictEqual(sbom.components, []);
  assert.deepStrictEqual(sbom.dependencies[0].dependsOn, []);
});

test("generated SBOM validates against the official CycloneDX 1.6 JSON schema", async () => {
  const sbom = buildSbom({
    packageJson: PACKAGE,
    tag: "v1.2.3",
    repository: "fossasia/cla-bot",
    actionYml: ACTION_YML,
    timestamp: "2026-10-06T00:00:00Z",
  });
  const validator = new CDX.Validation.JsonStrictValidator(
    CDX.Spec.Spec1dot6.version,
  );
  const errors = await validator.validate(JSON.stringify(sbom));
  assert.strictEqual(errors, null, JSON.stringify(errors));

  const invalid = { ...sbom };
  delete invalid.bomFormat;
  const invalidErrors = await validator.validate(JSON.stringify(invalid));
  assert.notStrictEqual(invalidErrors, null, "missing required bomFormat must be rejected");
});

test("buildSbom itself refuses npm dependencies in every field, independent of `verify` having run", () => {
  assert.deepStrictEqual(npmDependencyFields(PACKAGE), []);
  assert.deepStrictEqual(
    npmDependencyFields({
      ...PACKAGE,
      optionalDependencies: { a: "1" },
      bundleDependencies: true,
    }),
    ["optionalDependencies", "bundleDependencies"],
  );
  for (const [field, value] of [
    ["dependencies", { left: "1.0.0" }],
    ["optionalDependencies", { left: "1.0.0" }],
    ["peerDependencies", { left: "1.0.0" }],
    ["bundleDependencies", ["left"]],
    ["bundledDependencies", true],
  ]) {
    assert.throws(
      () =>
        buildSbom({
          packageJson: { ...PACKAGE, [field]: value },
          tag: "v1.2.3",
          repository: "fossasia/cla-bot",
          actionYml: ACTION_YML,
        }),
      new RegExp(`npm dependencies \\(${field}\\)`),
      field,
    );
  }
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

test("main verify writes tag-object-sha to GITHUB_OUTPUT when set, and only then", async () => {
  await withTmpDir(async (dir) => {
    writeProject(dir);
    const output = path.join(dir, "gh-output");
    fs.writeFileSync(output, "existing=1\n");
    const code = await main(
      ["verify", "--notes", path.join(dir, "n.md")],
      baseEnv({ GITHUB_OUTPUT: output }),
      { ...capture(), cwd: dir, fetchImpl: fakeFetch(annotatedRoutes()) },
    );
    assert.strictEqual(code, 0);
    assert.strictEqual(
      fs.readFileSync(output, "utf8"),
      `existing=1\ntag-object-sha=${TAG_OBJECT}\n`,
      "appended, never truncated",
    );
  });
});

test("main verify refuses to emit a malformed tag object id as a step output", async () => {
  await withTmpDir(async (dir) => {
    writeProject(dir);
    const output = path.join(dir, "gh-output");
    const io = capture();
    const code = await main(
      ["verify", "--notes", path.join(dir, "n.md")],
      baseEnv({ GITHUB_OUTPUT: output }),
      {
        ...io,
        cwd: dir,
        fetchImpl: fakeFetch({
          "git/ref/tags/v1.2.3": { object: { type: "tag", sha: "x\nevil=1" } },
          "git/tags/x\nevil=1": {
            tag: "v1.2.3",
            object: { type: "commit", sha: COMMIT },
            verification: { verified: true, reason: "valid" },
          },
        }),
      },
    );
    assert.strictEqual(code, 1);
    assert.match(io.err.join("\n"), /unexpected tag object id/);
    assert.ok(!fs.existsSync(output), "nothing is written to GITHUB_OUTPUT");
    assert.ok(!fs.existsSync(path.join(dir, "n.md")));
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
      composite("    - uses: a/b@v1"),
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

test("main sbom: refuses to write an SBOM when package.json declares npm dependencies (no reliance on `verify`)", async () => {
  await withTmpDir(async (dir) => {
    writeProject(dir, {
      pkg: { ...PACKAGE, optionalDependencies: { left: "1.0.0" } },
    });
    const out = path.join(dir, "sbom.json");
    const io = capture();
    const code = await main(
      ["sbom", "--out", out],
      { RELEASE_TAG: "v1.2.3", GITHUB_REPOSITORY: "fossasia/cla-bot" },
      { ...io, cwd: dir },
    );
    assert.strictEqual(code, 1);
    assert.match(
      io.err.join("\n"),
      /::error::package\.json declares npm dependencies \(optionalDependencies\)/,
    );
    assert.ok(!fs.existsSync(out), "no SBOM may be written");
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

// The release workflow runs `verify` on a fresh runner BEFORE `npm ci`, so
// `verify` must work with Node built-ins alone. This runs the REAL command in a
// directory with no node_modules (the script is copied out of the repo, so
// nothing can resolve js-yaml), with `fetch` stubbed by a preloaded module.
test("CLI bootstrap: `verify` runs to success with NO node_modules; only `sbom` needs js-yaml", async () => {
  await withTmpDir(async (dir) => {
    writeProject(dir);
    fs.copyFileSync(SCRIPT, path.join(dir, "release-check.js"));
    fs.writeFileSync(
      path.join(dir, "stub-fetch.js"),
      [
        `const COMMIT = ${JSON.stringify(COMMIT)}, TAG = ${JSON.stringify(TAG_OBJECT)};`,
        "global.fetch = async (url) => ({ ok: true, status: 200, json: async () =>",
        '  url.includes("git/ref/tags")',
        '    ? { object: { type: "tag", sha: TAG } }',
        '    : { tag: "v1.2.3", object: { type: "commit", sha: COMMIT }, verification: { verified: true, reason: "valid" } } });',
        "",
      ].join("\n"),
    );
    const env = { PATH: process.env.PATH };
    const node = (args, extraEnv) =>
      spawnSync(process.execPath, args, {
        cwd: dir,
        env: { ...env, ...extraEnv },
        encoding: "utf8",
      });

    // Precondition: the test is only meaningful if js-yaml really is unresolvable here.
    const probe = node(["-e", 'require("js-yaml")']);
    assert.notStrictEqual(
      probe.status,
      0,
      "js-yaml must not be resolvable in the scratch dir",
    );
    assert.match(probe.stderr, /MODULE_NOT_FOUND/);

    const output = path.join(dir, "gh-output");
    const verify = node(
      [
        "--require",
        "./stub-fetch.js",
        "release-check.js",
        "verify",
        "--notes",
        "notes.md",
      ],
      baseEnv({ GITHUB_OUTPUT: output }),
    );
    assert.strictEqual(verify.status, 0, verify.stderr);
    assert.strictEqual(
      fs.readFileSync(output, "utf8"),
      `tag-object-sha=${TAG_OBJECT}\n`,
    );
    assert.ok(fs.existsSync(path.join(dir, "notes.md")));

    // `sbom` is the only command that needs js-yaml (the workflow runs it after `npm ci`).
    const sbom = node(["release-check.js", "sbom", "--out", "sbom.json"], {
      RELEASE_TAG: "v1.2.3",
      GITHUB_REPOSITORY: "fossasia/cla-bot",
    });
    assert.strictEqual(sbom.status, 1);
    assert.match(sbom.stderr, /Cannot find module 'js-yaml'/);
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
