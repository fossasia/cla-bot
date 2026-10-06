"use strict";
/**
 * Offline guard for the signed-release pipeline (.github/workflows/release.yml,
 * and the docs consumers rely on). Nothing here runs the
 * workflow - it pins the properties that make the pipeline trustworthy, so a
 * later edit cannot quietly undo one:
 *
 *  - it only runs for pushed stable-semver tags (never a PR, branch or manual
 *    trigger), serialised and never cancelled;
 *  - least privilege: workflow permissions are empty; `build` can only READ;
 *    only `publish` can sign/attest/write, and `publish` runs no repository
 *    code (no checkout, no node/npm), waits on the `release` environment,
 *    and re-checks the digest `build` reported;
 *  - every action is pinned to a full commit SHA, cosign to an exact
 *    version, and no expression is interpolated into shell text;
 *  - caching is off (cache poisoning) and checkout keeps no credentials;
 *  - the steps run in the safe order: verify -> sign -> self-verify ->
 *    DRAFT -> publish -> verify the published copy (a published immutable
 *    release can never be fixed);
 *  - the assets match what SECURITY.md tells consumers to verify, and include
 *    the file types OpenSSF Scorecard's Signed-Releases check looks for;
 *
 * Run: node test/release-workflow.test.js (also part of `npm test`).
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const yaml = require("js-yaml");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const readJson = (...p) => JSON.parse(read(...p));

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

// Escapes EVERY regular-expression metacharacter, backslash included.
const escapeRegExp = (text) => text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

// Turns a GitHub tag filter into a RegExp. Supports exactly the syntax
// release.yml uses (literal characters, `[0-9]`-style classes, `+`) and throws
// on anything else, so the matcher can never silently disagree with GitHub.
// Nothing is concatenated unescaped.
function filterToRegExp(pattern) {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "[") {
      const end = pattern.indexOf("]", i);
      const body = end === -1 ? "" : pattern.slice(i + 1, end);
      assert.match(
        body,
        /^[0-9a-zA-Z-]+$/,
        `unsupported character class in ${pattern}`,
      );
      source += `[${body}]`;
      i = end;
    } else if (char === "+") {
      source += "+";
    } else {
      assert.ok(
        !"*?!\\]".includes(char),
        `unsupported filter syntax "${char}" in ${pattern}`,
      );
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`);
}

const raw = read(".github", "workflows", "release.yml");
const wf = yaml.load(raw);
const { build, publish } = wf.jobs;
const triggers = wf.on ?? wf[true];
const allSteps = [...build.steps, ...publish.steps];
const runText = (steps) =>
  steps
    .filter((s) => typeof s.run === "string")
    .map((s) => s.run)
    .join("\n");
const indexOfStep = (steps, predicate, label) => {
  const i = steps.findIndex(predicate);
  assert.ok(i >= 0, `missing step: ${label}`);
  return i;
};
const runsMatching = (steps, re) =>
  indexOfStep(
    steps,
    (s) => typeof s.run === "string" && re.test(s.run),
    String(re),
  );
const usesStartingWith = (steps, prefix) =>
  indexOfStep(
    steps,
    (s) => String(s.uses ?? "").startsWith(prefix),
    `uses ${prefix}`,
  );

// --- triggers and top-level hygiene -------------------------------------------

test("release.yml has exactly two jobs, build and publish, and is not a reusable workflow", () => {
  assert.deepStrictEqual(Object.keys(wf.jobs).sort(), ["build", "publish"]);
  assert.ok(!Object.keys(triggers).includes("workflow_call"));
});

test("the only trigger is a push of stable-semver tags: no PR, no branch, no manual run", () => {
  assert.deepStrictEqual(Object.keys(triggers), ["push"]);
  assert.deepStrictEqual(Object.keys(triggers.push), ["tags"]);
  assert.strictEqual(triggers.push.tags.length, 1);
  // GitHub's filter syntax: "+" repeats the previous character class, "." is literal.
  const filter = filterToRegExp(triggers.push.tags[0]);
  const { TAG_PATTERN } = require(
    path.join(ROOT, ".github", "scripts", "release-check.js"),
  );
  for (const tag of ["v0.0.1", "v1.0.0", "v12.34.56"]) {
    assert.ok(TAG_PATTERN.test(tag) && filter.test(tag), tag);
  }
  for (const tag of ["1.0.0", "v1.0", "v1.0.0-rc.1", "latest", "main"]) {
    assert.ok(!filter.test(tag), `${tag} must not start a release`);
  }
});

test("the tag-filter matcher escapes everything and rejects syntax it does not model", () => {
  assert.strictEqual(escapeRegExp("a\\b.c+d"), "a\\\\b\\.c\\+d");
  const f = filterToRegExp("v[0-9]+.[0-9]+");
  assert.ok(f.test("v1.2") && f.test("v10.20"));
  assert.ok(!f.test("v1x2"), "'.' is literal");
  assert.ok(!f.test("v1.2\n"), "anchored");
  // A backslash is GitHub's escape character, which this matcher does not model.
  for (const unsupported of [
    "v*",
    "v?",
    "!v1",
    "v[0-9",
    "v[]",
    "v]",
    "v[^a]",
    "a\\b",
  ]) {
    assert.throws(() => filterToRegExp(unsupported), undefined, unsupported);
  }
});

test("workflow-level permissions are empty and jobs must opt in", () => {
  assert.deepStrictEqual(wf.permissions, {});
  for (const [id, job] of Object.entries(wf.jobs)) {
    assert.ok(job.permissions, `job ${id} must declare its own permissions`);
  }
});

test("releases are serialised and never cancelled mid-flight", () => {
  assert.strictEqual(wf.concurrency.group, "release");
  assert.strictEqual(wf.concurrency["cancel-in-progress"], false);
});

test("every job has a timeout", () => {
  for (const [id, job] of Object.entries(wf.jobs)) {
    assert.ok(job["timeout-minutes"] > 0, `job ${id}`);
  }
});

// --- least privilege -------------------------------------------------------------

test("build can only read; it holds no signing, attestation or write permission", () => {
  assert.deepStrictEqual(build.permissions, { contents: "read" });
  assert.strictEqual(build.environment, undefined);
});

test("publish holds exactly the three permissions signing and publishing need", () => {
  assert.deepStrictEqual(publish.permissions, {
    contents: "write",
    "id-token": "write",
    attestations: "write",
  });
});

test("publish waits for build and runs in the `release` environment (where reviewers can be required)", () => {
  assert.strictEqual(publish.needs, "build");
  assert.strictEqual(publish.environment.name, "release");
});

test("publish executes no repository code: no checkout, no node/npm, no scripts from the tagged tree", () => {
  assert.ok(
    !publish.steps.some((s) =>
      String(s.uses ?? "").startsWith("actions/checkout@"),
    ),
    "publish must not check out the repository",
  );
  const text = runText(publish.steps);
  assert.ok(!/\b(node|npm|npx)\b/.test(text), "publish must not run node/npm");
  assert.ok(
    !/\.github\/scripts/.test(text),
    "publish must not run repo scripts",
  );
  assert.strictEqual(publish.env.GH_REPO, "${{ github.repository }}");
});

test("publish re-checks the digest build reported through a job output, before signing anything", () => {
  assert.match(
    build.outputs["dist-digest"],
    /steps\.build\.outputs\.dist-digest/,
  );
  const check = indexOfStep(
    publish.steps,
    (s) =>
      /needs\.build\.outputs\.dist-digest/.test(s.env?.EXPECTED_DIGEST ?? ""),
    "digest re-check",
  );
  assert.ok(check < usesStartingWith(publish.steps, "actions/attest@"));
  assert.ok(
    check < usesStartingWith(publish.steps, "sigstore/cosign-installer@"),
  );
  assert.match(
    publish.steps[check].run,
    /\[ -z "\$EXPECTED_DIGEST" \]/,
    "an empty digest must fail",
  );
});

test("build verifies the tag first, on the default branch, from a read-only token", () => {
  const onMain = runsMatching(build.steps, /merge-base --is-ancestor/);
  const verify = runsMatching(build.steps, /release-check\.js verify/);
  const tests = runsMatching(build.steps, /npm run coverage/);
  const buildAssets = indexOfStep(
    build.steps,
    (s) => s.id === "build",
    "build step",
  );
  assert.ok(onMain < verify && verify < tests && tests < buildAssets);
  assert.strictEqual(
    build.steps[verify].env.RELEASE_TAG,
    "${{ github.ref_name }}",
  );
  assert.strictEqual(build.steps[verify].env.GH_TOKEN, "${{ github.token }}");
});

// --- supply-chain hygiene ----------------------------------------------------------

test("every `uses:` is pinned to a full commit SHA with a version comment", () => {
  const lines = raw.split("\n").filter((l) => /^\s*(- )?uses:/.test(l));
  assert.ok(lines.length >= 6, "expected the release actions to be present");
  for (const line of lines) {
    assert.match(
      line,
      /uses:\s+[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+# v\d+\.\d+\.\d+\s*$/,
      line.trim(),
    );
  }
});

test("cosign is pinned to an exact version, and signing is keyless (no key material anywhere)", () => {
  const installer =
    publish.steps[
      usesStartingWith(publish.steps, "sigstore/cosign-installer@")
    ];
  assert.match(installer.with["cosign-release"], /^v\d+\.\d+\.\d+$/);
  assert.ok(
    !/secrets\./.test(raw),
    "the release workflow must not use any secret",
  );
  assert.ok(!/--key\b|COSIGN_PRIVATE_KEY|COSIGN_PASSWORD/.test(raw));
});

test("no `${{ }}` expression is interpolated into any shell script (template injection)", () => {
  for (const step of allSteps) {
    if (typeof step.run === "string") {
      assert.ok(
        !/\$\{\{/.test(step.run),
        `step "${step.name}" interpolates an expression into shell text`,
      );
    }
  }
});

test("every shell step fails fast (set -euo pipefail), except one-liners with a single command", () => {
  for (const step of allSteps) {
    if (typeof step.run !== "string") continue;
    const lines = step.run.trim().split("\n");
    if (lines.length === 1) continue;
    assert.match(step.run, /^set -euo pipefail$/m, `step "${step.name}"`);
  }
});

test("checkout keeps no credentials and fetches full history; setup-node has caching disabled", () => {
  const checkout =
    build.steps[usesStartingWith(build.steps, "actions/checkout@")];
  assert.strictEqual(checkout.with["persist-credentials"], false);
  assert.strictEqual(checkout.with["fetch-depth"], 0);
  const node =
    build.steps[usesStartingWith(build.steps, "actions/setup-node@")];
  assert.strictEqual(node.with["package-manager-cache"], false);
  assert.strictEqual(node.with.cache, undefined);
  assert.ok(!/actions\/cache@/.test(raw), "no cache in a release workflow");
});

test("dependencies are installed from the lockfile with scripts disabled", () => {
  assert.match(runText(build.steps), /npm ci --ignore-scripts/);
});

// --- order of operations --------------------------------------------------------------

test("publish signs, then verifies its own output, then drafts, then publishes, then verifies the public copy", () => {
  const steps = publish.steps;
  const order = [
    usesStartingWith(steps, "actions/download-artifact@"),
    indexOfStep(
      steps,
      (s) => s.env?.EXPECTED_DIGEST !== undefined,
      "digest check",
    ),
    usesStartingWith(steps, "sigstore/cosign-installer@"),
    indexOfStep(steps, (s) => s.id === "provenance", "provenance attestation"),
    indexOfStep(steps, (s) => s.id === "sbom", "SBOM attestation"),
    runsMatching(steps, /cosign sign-blob/),
    runsMatching(steps, /cosign verify-blob[\s\S]*gh attestation verify/),
    runsMatching(steps, /gh release create/),
    runsMatching(steps, /gh release edit/),
    runsMatching(steps, /gh release download/),
  ];
  assert.deepStrictEqual(
    [...order].sort((a, b) => a - b),
    order,
    "steps are out of order",
  );
  assert.strictEqual(new Set(order).size, order.length);
});

test("the release is created as a DRAFT bound to the pushed tag, and only a later step publishes it", () => {
  const create =
    publish.steps[runsMatching(publish.steps, /gh release create/)].run;
  assert.match(create, /--draft\b/);
  assert.match(create, /--verify-tag\b/);
  assert.ok(!/--latest/.test(create), "creation must not publish");
  const edit =
    publish.steps[runsMatching(publish.steps, /gh release edit/)].run;
  assert.match(edit, /--draft=false/);
});

test("a published release is never overwritten; only a leftover draft is replaced", () => {
  const create =
    publish.steps[runsMatching(publish.steps, /gh release create/)].run;
  assert.match(create, /already published and is never overwritten/);
  assert.match(create, /gh release delete "\$RELEASE_TAG" --yes/);
  assert.ok(!/--clobber/.test(raw), "no --clobber anywhere");
});

test("each attest step's bundle is copied to its final name immediately (the action may reuse one path)", () => {
  const prov = indexOfStep(
    publish.steps,
    (s) => s.id === "provenance",
    "provenance",
  );
  const sbom = indexOfStep(publish.steps, (s) => s.id === "sbom", "sbom");
  assert.match(
    publish.steps[prov + 1].env.BUNDLE,
    /steps\.provenance\.outputs\.bundle-path/,
  );
  assert.match(publish.steps[prov + 1].run, /provenance\.intoto\.jsonl/);
  assert.match(
    publish.steps[sbom + 1].env.BUNDLE,
    /steps\.sbom\.outputs\.bundle-path/,
  );
  assert.match(publish.steps[sbom + 1].run, /sbom\.intoto\.jsonl/);
  for (const i of [prov, sbom]) {
    assert.strictEqual(publish.steps[i].with["create-storage-record"], false);
  }
});

test("verification pins WHO may have signed: this exact workflow file, on this tag, this commit", () => {
  const text = runText(publish.steps);
  assert.match(
    text,
    /--certificate-identity "https:\/\/github\.com\/\$\{workflow\}@\$\{GITHUB_REF\}"/,
  );
  assert.match(
    text,
    /--certificate-oidc-issuer "https:\/\/token\.actions\.githubusercontent\.com"/,
  );
  assert.match(text, /--signer-workflow "\$workflow"/);
  assert.match(text, /--source-ref "\$GITHUB_REF"/);
  assert.match(text, /--source-digest "\$GITHUB_SHA"/);
  assert.match(
    text,
    /workflow="\$\{GITHUB_REPOSITORY\}\/\.github\/workflows\/release\.yml"/,
  );
  assert.match(text, /--predicate-type "https:\/\/cyclonedx\.org\/bom"/);
  assert.ok(
    !/--certificate-identity-regexp|--cert-identity-regex/.test(text),
    "identity must be matched exactly, never by regex",
  );
});

// --- tag movement between verification and release (TOCTOU) ----------------------------

const SHA_VERIFIED = "a".repeat(40);
const SHA_MOVED = "b".repeat(40);
const recheckSteps = publish.steps.filter((s) =>
  /^Re-check the tag/.test(s.name ?? ""),
);

test("build hands the verified tag object's SHA to publish through a job output (not the artifact store)", () => {
  const verify = indexOfStep(
    build.steps,
    (s) => s.id === "verify",
    "verify step",
  );
  assert.match(build.steps[verify].run, /release-check\.js verify/);
  assert.strictEqual(
    build.outputs["tag-object-sha"],
    "${{ steps.verify.outputs.tag-object-sha }}",
  );
  assert.strictEqual(
    publish.env.EXPECTED_TAG_OBJECT,
    "${{ needs.build.outputs.tag-object-sha }}",
  );
});

test("the tag is re-checked right before the release is created AND right before it is published", () => {
  assert.strictEqual(recheckSteps.length, 2);
  const create = runsMatching(publish.steps, /gh release create/);
  const edit = runsMatching(publish.steps, /gh release edit/);
  const [first, second] = recheckSteps.map((s) => publish.steps.indexOf(s));
  assert.ok(first < create, "re-check must precede creating the release");
  assert.ok(
    create < second && second < edit,
    "re-check must sit between creating and publishing",
  );
  assert.strictEqual(
    first,
    create - 1,
    "no step may sit between the check and the create",
  );
  assert.strictEqual(
    second,
    edit - 1,
    "no step may sit between the check and the publish",
  );
});

test("after publishing, the tag is checked once more and the release is called compromised if it moved", () => {
  const finalStep =
    publish.steps[runsMatching(publish.steps, /gh release download/)].run;
  assert.match(finalStep, /git\/ref\/tags\/\$\{RELEASE_TAG\}/);
  assert.match(finalStep, /"tag \$\{EXPECTED_TAG_OBJECT\}"/);
  assert.match(finalStep, /compromised/);
});

// Runs the REAL shell of a re-check step, with a fake `gh` that returns
// whatever the tag "currently" resolves to.
function runRecheck(step, { current, expected, ghFails = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-gh-"));
  try {
    const log = path.join(dir, "args.log");
    fs.writeFileSync(
      path.join(dir, "gh"),
      ghFails
        ? "#!/bin/sh\nexit 1\n"
        : `#!/bin/sh\necho "$@" >> "${log}"\nprintf '%s\\n' "$FAKE_GH_OUTPUT"\n`,
      { mode: 0o755 },
    );
    const result = spawnSync("bash", ["-c", step.run], {
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        GITHUB_REPOSITORY: "fossasia/cla-bot",
        RELEASE_TAG: "v1.2.3",
        EXPECTED_TAG_OBJECT: expected,
        FAKE_GH_OUTPUT: current ?? "",
      },
      encoding: "utf8",
    });
    const args = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      args,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("re-check (real shell, fake gh): passes only while the tag still resolves to the verified tag object", () => {
  for (const step of recheckSteps) {
    const same = runRecheck(step, {
      current: `tag ${SHA_VERIFIED}`,
      expected: SHA_VERIFIED,
    });
    assert.strictEqual(same.status, 0, same.output);
    assert.match(
      same.args,
      /api repos\/fossasia\/cla-bot\/git\/ref\/tags\/v1\.2\.3 --jq /,
    );
  }
});

test("re-check (real shell, fake gh): a MOVED, re-created-as-lightweight, or unexpected tag stops the release", () => {
  for (const step of recheckSteps) {
    for (const [label, current] of [
      ["tag moved to another tag object", `tag ${SHA_MOVED}`],
      [
        "tag replaced by a lightweight tag at the same commit",
        `commit ${SHA_VERIFIED}`,
      ],
      ["tag replaced by a lightweight tag elsewhere", `commit ${SHA_MOVED}`],
      ["empty answer", ""],
    ]) {
      const r = runRecheck(step, { current, expected: SHA_VERIFIED });
      assert.notStrictEqual(r.status, 0, label);
      assert.match(
        r.output,
        /no longer resolves to the signed tag object/,
        label,
      );
    }
  }
});

test("re-check (real shell, fake gh): an empty expected value or a failing gh can never pass", () => {
  for (const step of recheckSteps) {
    const noExpected = runRecheck(step, { current: "tag ", expected: "" });
    assert.notStrictEqual(
      noExpected.status,
      0,
      "empty EXPECTED_TAG_OBJECT must fail",
    );
    const ghDown = runRecheck(step, {
      current: `tag ${SHA_VERIFIED}`,
      expected: SHA_VERIFIED,
      ghFails: true,
    });
    assert.notStrictEqual(
      ghDown.status,
      0,
      "an API failure must fail the step",
    );
  }
});

test("every `gh attestation verify` pins repo, signer workflow, tag ref AND commit digest (before and after publishing)", () => {
  const commands = [
    ...raw.matchAll(/gh attestation verify(?:[^\n]*\\\n)*[^\n]*/g),
  ].map((m) => m[0]);
  assert.strictEqual(
    commands.length,
    4,
    "pre-publish: provenance + SBOM; post-publish: provenance + SBOM",
  );
  for (const command of commands) {
    for (const flag of [
      "--repo",
      "--signer-workflow",
      "--source-ref",
      "--source-digest",
    ]) {
      assert.ok(command.includes(flag), `missing ${flag} in:\n${command}`);
    }
  }
  assert.strictEqual(
    commands.filter((c) => c.includes("https://cyclonedx.org/bom")).length,
    2,
  );
});

// --- assets, docs, Scorecard -----------------------------------------------------------

const ASSET_SUFFIXES = [
  ".tar.gz",
  ".tar.gz.sigstore.json",
  ".sbom.cdx.json",
  ".provenance.intoto.jsonl",
  ".sbom.intoto.jsonl",
];

test("the assets uploaded are exactly the documented set, and include what Scorecard's Signed-Releases looks for", () => {
  const create =
    publish.steps[runsMatching(publish.steps, /gh release create/)].run;
  const uploaded = [
    ...create.matchAll(/^\s+"?(dist\/[^"\s\\]+)"?\s*\\?$/gm),
  ].map((m) => m[1]);
  assert.deepStrictEqual(
    uploaded.sort(),
    [
      // "${name}" is the shell variable the step defines: cla-bot-${RELEASE_TAG}
      ...ASSET_SUFFIXES.map((suffix) => "dist/${name}" + suffix),
      "dist/SHA256SUMS",
      "dist/SHA256SUMS.sigstore.json",
    ].sort(),
  );
  assert.ok(uploaded.some((f) => f.endsWith(".sigstore.json")));
  assert.ok(uploaded.some((f) => f.endsWith(".intoto.jsonl")));
});

test("SECURITY.md documents every released asset and the commands that verify them", () => {
  const security = read("SECURITY.md");
  assert.match(security, /^## Verifying a release$/m);
  for (const suffix of [
    ...ASSET_SUFFIXES,
    "SHA256SUMS",
    "SHA256SUMS.sigstore.json",
  ]) {
    assert.ok(
      security.includes(suffix),
      `SECURITY.md never mentions ${suffix}`,
    );
  }
  for (const needle of [
    "cosign verify-blob",
    "gh attestation verify",
    "sha256sum --check",
    "--certificate-identity",
    ".github/workflows/release.yml",
    "https://token.actions.githubusercontent.com",
    "gh release verify",
  ]) {
    assert.ok(security.includes(needle), `SECURITY.md is missing: ${needle}`);
  }
});

test("the release notes footer link points at an anchor that exists in SECURITY.md", () => {
  const script = read(".github", "scripts", "release-check.js");
  assert.match(script, /SECURITY\.md#verifying-a-release/);
  assert.match(read("SECURITY.md"), /^## Verifying a release$/m);
});

test("CONTRIBUTING.md documents the release procedure, the one-time setup and failure recovery", () => {
  const contributing = read("CONTRIBUTING.md");
  for (const needle of [
    "git tag -s",
    "git push origin vX.Y.Z",
    "Immutable releases",
    "`release` environment",
    "If a release run fails",
  ]) {
    assert.ok(
      contributing.includes(needle),
      `CONTRIBUTING.md is missing: ${needle}`,
    );
  }
});

test("the consumer example and setup docs recommend pinning to a full commit SHA, not a mutable tag", () => {
  const example = read("examples", "consumer-workflow.yml");
  assert.match(example, /uses: fossasia\/cla-bot@\S+ # vX\.Y\.Z/);
  assert.match(example, /full commit SHA/);
  assert.match(read("SETUP_GUIDE.md"), /full commit SHA/);
  assert.match(read("README.md"), /full commit SHA/);
});

test("CHANGELOG.md keeps an [Unreleased] section for the next release", () => {
  assert.match(read("CHANGELOG.md"), /^## \[Unreleased\]$/m);
});

// --- no tag rulesets ------------------------------------------------------------------------

test("no ruleset restricts who may create, move or delete release tags (main.json is the only ruleset, with no bypass)", () => {
  const dir = path.join(ROOT, ".github", "rulesets");
  const rulesets = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.deepStrictEqual(rulesets, ["main.json"]);
  assert.strictEqual(
    readJson(".github", "rulesets", "main.json").target,
    "branch",
  );
  assert.deepStrictEqual(
    readJson(".github", "rulesets", "main.json").bypass_actors,
    [],
  );
});

// --- the release is not part of the PR gate --------------------------------------------------

test("ci.yml neither calls nor needs release.yml (a tag-only workflow can never be a required check)", () => {
  const ci = yaml.load(read(".github", "workflows", "ci.yml"));
  for (const job of Object.values(ci.jobs)) {
    assert.ok(!String(job.uses ?? "").includes("release.yml"));
  }
  assert.ok(!Object.keys(ci.jobs).includes("release"));
});

// --- runner ----------------------------------------------------------------------------------------

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
