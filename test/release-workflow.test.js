"use strict";
/**
 * Offline guard for the signed-release pipeline (.github/workflows/release.yml,
 * and the docs consumers rely on). Nothing here runs the
 * workflow - it pins the properties that make the pipeline trustworthy, so a
 * later edit cannot quietly undo one:
 *
 *  - it publishes on stable-semver tag pushes and supports manual Latest
 *    recovery; same-tag runs serialize, and Latest reconciliation is globally
 *    serialized without dropping the publication of other versions;
 *  - least privilege: workflow permissions are empty; `policy`, `build` and
 *    `checks` can only READ; `sign` can sign/attest but cannot publish, and
 *    `publish` has contents:write but runs no third-party action or repo code;
 *    both jobs verify digests delivered through job outputs;
 *  - third-party code (npm packages) only ever runs in `checks`, never on the
 *    machine that builds the archive;
 *  - the release policy (immutability declared, reviewers on the environment)
 *    is enforced before anything is built;
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
const crypto = require("crypto");
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

const raw = read(".github", "workflows", "release.yml");
const wf = yaml.load(raw);
const { policy, build, checks, sign, publish } = wf.jobs;
const verifyLatest = wf.jobs["verify-latest"];
const triggers = wf.on ?? wf[true];
const allSteps = [
  ...policy.steps,
  ...build.steps,
  ...checks.steps,
  ...sign.steps,
  ...publish.steps,
  ...verifyLatest.steps,
];
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
const stepNamed = (steps, name) => {
  const i = steps.findIndex((s) => s.name === name);
  assert.ok(i >= 0, `missing step named: ${name}`);
  return i;
};
const DRAFT_CHECK =
  "Verify the draft's assets and metadata are exactly what was verified";
const DIGEST_STEP =
  "Verify the files are exactly what build and checks produced, then write SHA256SUMS";
const PUBLISH_STEP = "Re-check the tag and publish the release";
const CREATE_RECHECK = "Re-check the tag before creating the release";
const POLICY_IMMUTABILITY = "Require the immutability policy to be declared";
const POLICY_REVIEWERS = "Check the release environment approval policy";
const IMMUTABLE_CHECK = "Check the release immutability policy";
const PUBLISHED_CHECK = "Verify the published release end to end";
const usesStartingWith = (steps, prefix) =>
  indexOfStep(
    steps,
    (s) => String(s.uses ?? "").startsWith(prefix),
    `uses ${prefix}`,
  );

// Runs a step's REAL shell in a scratch directory with a fake `gh` first on the
// PATH. `gh` is shell text for the fake; every call it receives is logged and
// returned as `calls`. `setup(dir)` prepares files; `after(dir)` is read before
// cleanup. Environment values that are undefined are simply not set.
function runStep(
  step,
  { gh = "exit 0", env = {}, setup = () => {}, after = () => null } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "step-"));
  try {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    const log = path.join(dir, "gh-calls.log");
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/bin/sh\necho "$@" >> "${log}"\n${gh}\n`,
      { mode: 0o755 },
    );
    setup(dir);
    const environment = {
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "fossasia/cla-bot",
      GITHUB_OUTPUT: path.join(dir, "github-output"),
      RELEASE_TAG: "v1.2.3",
    };
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) environment[key] = value;
    }
    const result = spawnSync("bash", ["-c", step.run], {
      cwd: dir,
      env: environment,
      encoding: "utf8",
    });
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      calls: fs.existsSync(log)
        ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
        : [],
      githubOutput: fs.existsSync(environment.GITHUB_OUTPUT)
        ? fs.readFileSync(environment.GITHUB_OUTPUT, "utf8")
        : "",
      extra: after(dir),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
// A fake `gh` that answers every call with one line.
const ghAnswers = (text) => `printf '%s\\n' '${text}'`;
const HAS_SHA256SUM = spawnSync("sha256sum", ["--version"]).status === 0;
const releaseAssets = (tag = "v1.2.3") => {
  const name = `cla-bot-${tag}`;
  return [
    "RELEASE_NOTES.md",
    "RELEASE_NOTES.md.sigstore.json",
    `${name}.tar.gz`,
    `${name}.tar.gz.sigstore.json`,
    `${name}.sbom.cdx.json`,
    `${name}.sbom.cdx.json.sigstore.json`,
    `${name}.provenance.intoto.jsonl`,
    `${name}.sbom.intoto.jsonl`,
    "SHA256SUMS",
    "SHA256SUMS.sigstore.json",
  ];
};
const releasePayload = (
  meta = "123 v1.2.3 v1.2.3 true false",
  body = "notes",
  assets = releaseAssets(),
  assetIds = {},
) => {
  const [id, tag_name, name, draft, prerelease] = meta.split(" ");
  return JSON.stringify({
    id: Number(id),
    tag_name,
    name,
    draft: draft === "true",
    prerelease: prerelease === "true",
    body,
    assets: assets.map((asset, index) => ({
      id: assetIds[asset] ?? 100 + index,
      name: asset,
      state: "uploaded",
      size: 1,
      digest: null,
    })),
  });
};
function setupPublishDraft(dir, mutate = () => {}) {
  fs.mkdirSync(path.join(dir, "dist"));
  fs.mkdirSync(path.join(dir, "served"));
  for (const asset of releaseAssets()) {
    const bytes = asset === "RELEASE_NOTES.md" ? "notes\n" : `content of ${asset}\n`;
    fs.writeFileSync(path.join(dir, "dist", asset), bytes);
    fs.writeFileSync(path.join(dir, "served", asset), bytes);
  }
  mutate(path.join(dir, "served"));
}
const publishTagGh = (
  answer,
  {
    meta = "123 v1.2.3 v1.2.3 true false",
    body = "notes",
    assets = releaseAssets(),
  } = {},
) =>
  [
    'case "$*" in',
    '  *"--method PATCH"*) exit 0 ;;',
    '  *"releases/123"*)',
    '    reads=0; [ ! -f release-read-count ] || reads=$(cat release-read-count); reads=$((reads + 1)); printf "%s\\n" "$reads" > release-read-count',
    `    if [ "$reads" -gt 1 ] && [ "\${FAKE_FINAL_RELEASE_FAILURE:-}" = true ]; then exit 1; fi`,
    `    if [ "$reads" -gt 1 ] && [ -f tag-checked ] && [ -n "\${FAKE_RELEASE_AFTER_TAG:-}" ]; then printf '%s\\n' "$FAKE_RELEASE_AFTER_TAG"; elif [ "$reads" -gt 1 ] && [ -n "\${FAKE_FINAL_RELEASE_JSON:-}" ]; then printf '%s\\n' "$FAKE_FINAL_RELEASE_JSON"; else printf '%s\\n' '${releasePayload(meta, body, assets)}'; fi ;;`,
    '  *"release download"*) printf \'wrong release 999\' > "$5/wrong-release-999" ;;',
    ...assets.map((asset, index) =>
      `  *"releases/assets/${100 + index} "*) touch assets-downloaded; cat "$FAKE_DRAFT_DIR/${asset}" 2>/dev/null || : ;;`,
    ),
    `  *"git/ref/tags/"*) touch tag-checked; if [ -f assets-downloaded ] && [ "\${FAKE_TAG_API_FAILURE_AFTER_ASSETS:-}" = true ]; then exit 1; elif [ -f assets-downloaded ] && [ -n "\${FAKE_TAG_AFTER_ASSETS:-}" ]; then printf '%s\\n' "$FAKE_TAG_AFTER_ASSETS"; else printf '%s\\n' '${answer}'; fi ;;`,
    '  *) exit 99 ;;',
    "esac",
  ].join("\n");

// --- triggers and top-level hygiene -------------------------------------------

test("release.yml has seven jobs, including isolated signing, candidate verification and Latest reconciliation", () => {
  assert.deepStrictEqual(Object.keys(wf.jobs).sort(), [
    "build",
    "checks",
    "latest",
    "policy",
    "publish",
    "sign",
    "verify-latest",
  ]);
  assert.ok(!Object.keys(triggers).includes("workflow_call"));
});

test("release publication is tag-push only, and manual dispatch is available for safe Latest recovery", () => {
  assert.deepStrictEqual(Object.keys(triggers), ["push", "workflow_dispatch"]);
  assert.deepStrictEqual(Object.keys(triggers.push), ["tags"]);
  assert.strictEqual(triggers.push.tags.length, 1);
  // Keep the Actions glob deliberately simple. Do not emulate GitHub's matcher
  // here; the release validator is the authoritative strict SemVer gate.
  assert.strictEqual(triggers.push.tags[0], "v*.*.*");
  const { TAG_PATTERN } = require(
    path.join(ROOT, ".github", "scripts", "release-check.js"),
  );
  for (const tag of ["v0.0.1", "v1.0.0", "v12.34.56"]) {
    assert.ok(TAG_PATTERN.test(tag), tag);
  }
  for (const tag of ["1.0.0", "v1.0", "v1.0.0-rc.1", "latest", "main"]) {
    assert.ok(!TAG_PATTERN.test(tag), `${tag} must be rejected by strict release validation`);
  }
});

test("release runs serialize per tag without replacing another version's pending run", () => {
  assert.strictEqual(wf.concurrency.group, "release-${{ github.ref }}");
  assert.ok(!Object.hasOwn(wf.concurrency, "queue"));
  assert.strictEqual(wf.concurrency["cancel-in-progress"], false);
});

test("all inter-job artifacts are retained for the maximum public-repository window", () => {
  const uploads = allSteps.filter(
    (step) => String(step.uses ?? "").startsWith("actions/upload-artifact@"),
  );
  assert.strictEqual(uploads.length, 3);
  for (const upload of uploads) {
    assert.strictEqual(upload.with["retention-days"], 90);
  }
});

test("release tag ruleset leaves creation open but blocks tag updates and deletions", () => {
  const ruleset = readJson(".github", "rulesets", "release-tags.json");
  assert.strictEqual(ruleset.target, "tag");
  assert.strictEqual(ruleset.enforcement, "active");
  assert.deepStrictEqual(ruleset.bypass_actors, []);
  assert.deepStrictEqual(ruleset.conditions.ref_name.include, ["refs/tags/v*"]);
  assert.deepStrictEqual(
    ruleset.rules.map((rule) => rule.type).sort(),
    ["deletion", "update"],
  );
  assert.ok(!ruleset.rules.some((rule) => rule.type === "creation"));
});

test("the release verifier refuses GitHub CLI versions below v2.102.0 and parses build metadata safely", () => {
  const step = publish.steps[stepNamed(publish.steps, "Require a patched GitHub CLI")];
  for (const version of ["2.102.0", "2.102.1", "2.110.0", "3.0.0"]) {
    const result = runStep(step, {
      gh: `printf '%s\\n' 'gh version ${version} (2026-10-01)'`,
    });
    assert.strictEqual(result.status, 0, `${version}: ${result.output}`);
  }
  for (const version of ["2.101.99", "1.999.0", "unknown", "2.102"]) {
    const result = runStep(step, {
      gh: `printf '%s\\n' 'gh version ${version} (2026-10-01)'`,
    });
    assert.notStrictEqual(result.status, 0, version);
    assert.match(result.output, /require 2\.102\.0 or newer/);
  }
});

test("published release verification fails closed on changed metadata or notes", () => {
  const step = publish.steps[stepNamed(publish.steps, PUBLISHED_CHECK)];
  const gh = [
    'case "$*" in',
    '  *"releases/123"*) printf "%s\\n" "$FAKE_RELEASE_JSON" ;;',
    '  *) exit 99 ;;',
    "esac",
  ].join("\n");
  const metadata = runStep(step, {
    gh,
    env: {
      EXPECTED_RELEASE_ID: "123",
      FAKE_RELEASE_JSON: releasePayload("123 v1.2.3 v1.2.3 true false", "notes"),
    },
  });
  assert.notStrictEqual(metadata.status, 0);
  assert.match(metadata.output, /expected the named release to be published and stable/);
  assert.strictEqual(metadata.calls.length, 1, "must stop before touching assets");

  const notes = runStep(step, {
    gh,
    env: {
      EXPECTED_RELEASE_ID: "123",
      FAKE_RELEASE_JSON: releasePayload("123 v1.2.3 v1.2.3 false false", "altered notes"),
    },
    setup: (dir) => {
      fs.mkdirSync(path.join(dir, "dist"));
      fs.writeFileSync(path.join(dir, "dist", "RELEASE_NOTES.md"), "verified notes\n");
    },
  });
  assert.notStrictEqual(notes.status, 0);
  assert.match(notes.output, /release notes differ from the verified notes/);
  assert.strictEqual(notes.calls.length, 1, "must stop before touching assets");
});

test("workflow-level permissions are empty and jobs must opt in", () => {
  assert.deepStrictEqual(wf.permissions, {});
  for (const [id, job] of Object.entries(wf.jobs)) {
    assert.ok(job.permissions, `job ${id} must declare its own permissions`);
  }
});

test("same-tag release runs are serialised and never cancelled mid-flight", () => {
  assert.strictEqual(wf.concurrency.group, "release-${{ github.ref }}");
  assert.strictEqual(wf.concurrency["cancel-in-progress"], false);
});

test("Latest reconciliation is globally serialized, least-privilege, and runs after publication", () => {
  assert.strictEqual(wf.jobs.latest.needs, "verify-latest");
  assert.strictEqual(wf.jobs.latest.concurrency.group, "release-latest-marker");
  assert.strictEqual(wf.jobs.latest.concurrency["cancel-in-progress"], false);
  assert.deepStrictEqual(wf.jobs.latest.permissions, { contents: "write" });
  assert.ok(!/\b(checkout|npm|node)\b/.test(runText(wf.jobs.latest.steps)));
});

test("candidate verification is read-only, checks published releases after a publish failure, and supports manual recovery", () => {
  assert.deepStrictEqual(verifyLatest.permissions, {
    contents: "read",
    attestations: "read",
  });
  assert.deepStrictEqual(verifyLatest.needs, ["policy", "publish"]);
  assert.match(verifyLatest.if, /always\(\)/);
  assert.match(verifyLatest.if, /needs\.policy\.result == 'success'/);
  assert.ok(
    verifyLatest.if.indexOf("needs.policy.result == 'success'") <
      verifyLatest.if.indexOf("github.event_name == 'workflow_dispatch'"),
    "manual dispatch must not bypass the release policy gate",
  );
  assert.match(runText(verifyLatest.steps), /verify-release-candidate\.sh/);
  assert.match(runText(verifyLatest.steps), /sort_by\(.tag_name \| semver_key\) \| reverse/);
  const verifier = read(".github", "scripts", "verify-release-candidate.sh");
  assert.match(verifier, /releases\/\$\{RELEASE_ID\}/);
  assert.match(verifier, /releases\/assets\/\$\{asset_id\}/);
  assert.doesNotMatch(verifier, /gh release download "\$RELEASE_TAG"/);
  assert.match(verifier, /verified-asset-digest=%s/);
  assert.match(verifier, /verified-tag-object=%s/);
  assert.match(verifier, /verified-commit=%s/);
  assert.match(wf.jobs.latest.env.VERIFIED_ASSET_DIGEST, /verify-latest\.outputs\.asset-digest/);
  assert.match(wf.jobs.latest.env.VERIFIED_TAG_OBJECT, /verify-latest\.outputs\.tag-object/);
  assert.match(wf.jobs.latest.env.VERIFIED_COMMIT, /verify-latest\.outputs\.commit/);
  const checkout = verifyLatest.steps.find((step) =>
    String(step.uses ?? "").startsWith("actions/checkout@"),
  );
  assert.strictEqual(checkout.with.ref, "${{ github.workflow_sha }}");
  assert.ok(
    !/github\.event\.repository\.default_branch/.test(checkout.with.ref),
    "the verifier must not come from a moving default-branch ref",
  );
});

test("candidate selector tries releases in numeric SemVer order and skips an unverified higher manual release", () => {
  const step = verifyLatest.steps.find((candidate) => candidate.id === "select");
  const releases = [
    { id: 2, tag_name: "v2.10.0", draft: false, prerelease: false },
    { id: 10, tag_name: "v10.0.0", draft: false, prerelease: false },
    { id: 99, tag_name: "v999.0.0", draft: false, prerelease: false },
    { id: 100, tag_name: "v1000.0.0-rc.1", draft: false, prerelease: true },
    { id: 101, tag_name: "v1001.0.0", draft: true, prerelease: false },
  ];
  const result = runStep(step, {
    gh: 'printf \'%s\\n\' "$FAKE_RELEASES"',
    env: {
      FAKE_RELEASES: JSON.stringify([releases]),
      DEFAULT_BRANCH: "main",
      GH_TOKEN: "test-token",
      RELEASE_IMMUTABILITY: "not-required",
    },
    setup: (dir) => {
      const helper = path.join(dir, ".github", "scripts");
      fs.mkdirSync(helper, { recursive: true });
      fs.writeFileSync(
        path.join(helper, "verify-release-candidate.sh"),
        '#!/bin/bash\necho "$RELEASE_ID:$RELEASE_TAG" >> attempts.log\n[ "$RELEASE_TAG" != v999.0.0 ] || exit 1\nprintf "verified-asset-digest=%064d\\nverified-tag-object=%040d\\nverified-commit=%040d\\n" 0 0 0 >> "$GITHUB_OUTPUT"\n',
        { mode: 0o755 },
      );
    },
    after: (dir) => fs.existsSync(path.join(dir, "attempts.log"))
      ? fs.readFileSync(path.join(dir, "attempts.log"), "utf8").trim().split("\n")
      : [],
  });
  assert.strictEqual(result.status, 0, result.output);
  assert.deepStrictEqual(result.extra, ["99:v999.0.0", "10:v10.0.0"]);
  assert.match(result.githubOutput, /release-id=10/);
  assert.match(result.githubOutput, /release-tag=v10\.0\.0/);
});

test("Latest revalidates the verified release fingerprint before promotion", () => {
  const step = wf.jobs.latest.steps[0];
  const assets = [
    "RELEASE_NOTES.md",
    "RELEASE_NOTES.md.sigstore.json",
    "cla-bot-v10.0.0.tar.gz",
    "cla-bot-v10.0.0.tar.gz.sigstore.json",
    "cla-bot-v10.0.0.sbom.cdx.json",
    "cla-bot-v10.0.0.sbom.cdx.json.sigstore.json",
    "cla-bot-v10.0.0.provenance.intoto.jsonl",
    "cla-bot-v10.0.0.sbom.intoto.jsonl",
    "SHA256SUMS",
    "SHA256SUMS.sigstore.json",
  ];
  const releaseJson = JSON.stringify({
    id: 10,
    tag_name: "v10.0.0",
    draft: false,
    prerelease: false,
    body: "verified:RELEASE_NOTES.md",
    assets: assets.map((name, index) => ({ id: 200 + index, name, state: "uploaded" })),
  });
  const gh = [
    'case "$*" in',
    '  *"releases/latest"*) if [ -s fake-latest.txt ]; then cat fake-latest.txt; else exit 1; fi ;;',
    '  *"releases/10") printf \'%s\\n\' "$FAKE_RELEASE_JSON" ;;',
    '  *"release download"*) printf \'wrong release 999\' > "$5/wrong-release-999" ;;',
    '  *"--paginate --slurp"*) cat public-releases.json ;;',
    '  *"git/ref/tags/v10.0.0"*) printf "tag %s\\n" "$VERIFIED_TAG_OBJECT" ;;',
    '  *"git/tags/"*) printf "commit %s\\n" "$VERIFIED_COMMIT" ;;',
    '  *"branches/main"*) printf "%s\\n" "$DEFAULT_SHA" ;;',
    '  *"compare/"*) printf "ahead\\n" ;;',
    ...assets.map((asset, index) =>
      `  *"releases/assets/${200 + index} "*) cat "fake-assets/${asset}"${index === 2 ? ' ; [ "$TAMPER_ASSET" != yes ] || printf changed' : ""} ;;`,
    ),
    '  *"--method PATCH"*) printf \'%s\\n\' "$VERIFIED_RELEASE_TAG" > fake-latest.txt ;;',
    '  *) exit 99 ;;',
    "esac",
  ].join("\n");
  const contents = Object.fromEntries(assets.map((name) => [name, name === "RELEASE_NOTES.md" ? "verified:RELEASE_NOTES.md\n" : `verified:${name}\n`]));
  const fingerprint = assets
    .map((name) => `${crypto.createHash("sha256").update(contents[name]).digest("hex")}  ${name}`)
    .join("\n") + "\n";
  const assetDigest = crypto.createHash("sha256").update(fingerprint).digest("hex");
  const run = (
    currentLatest,
    highestPublicTag = "v10.0.0",
    publicBody = "verified:RELEASE_NOTES.md",
  ) =>
    runStep(step, {
      gh,
      env: {
        VERIFIED_RELEASE_ID: "10",
        VERIFIED_RELEASE_TAG: "v10.0.0",
        VERIFIED_ASSET_DIGEST: assetDigest,
        VERIFIED_TAG_OBJECT: "b".repeat(40),
        VERIFIED_COMMIT: "c".repeat(40),
        DEFAULT_BRANCH: "main",
        DEFAULT_SHA: "d".repeat(40),
        FAKE_RELEASE_JSON: JSON.stringify({ ...JSON.parse(releaseJson), body: publicBody }),
      },
      setup: (dir) => {
        fs.mkdirSync(path.join(dir, "fake-assets"));
        for (const [name, body] of Object.entries(contents)) {
          fs.writeFileSync(path.join(dir, "fake-assets", name), body);
        }
        if (currentLatest) fs.writeFileSync(path.join(dir, "fake-latest.txt"), `${currentLatest}\n`);
        fs.writeFileSync(
          path.join(dir, "public-releases.json"),
          JSON.stringify([[{ id: 10, tag_name: "v10.0.0", draft: false, prerelease: false },
            ...(highestPublicTag === "v10.0.0" ? [] : [{ id: 11, tag_name: highestPublicTag, draft: false, prerelease: false }])]]),
        );
      },
      after: (dir) => fs.readFileSync(path.join(dir, "fake-latest.txt"), "utf8").trim(),
    });

  const backfill = run("v2.10.0");
  assert.strictEqual(backfill.status, 0, backfill.output);
  assert.strictEqual(backfill.extra, "v10.0.0");
  assert.ok(backfill.calls.some((call) => call.includes("releases/10 -f make_latest=true")));
  assert.ok(backfill.calls.includes("api repos/fossasia/cla-bot/releases/10"));
  assert.ok(
    !backfill.calls.some((call) => /release (view|download)|releases\/tags\//.test(call)),
    "Latest reconciliation keeps metadata and assets bound to release ID 10",
  );

  const alreadyCorrect = run("v10.0.0");
  assert.strictEqual(alreadyCorrect.status, 0, alreadyCorrect.output);
  assert.deepStrictEqual(
    alreadyCorrect.calls.filter((call) => call.includes("--method PATCH")),
    [],
  );

  const firstRelease = run("");
  assert.strictEqual(firstRelease.status, 0, firstRelease.output);
  assert.strictEqual(firstRelease.extra, "v10.0.0");
  assert.ok(firstRelease.calls.some((call) => call.includes("releases/10 -f make_latest=true")));

  const changedBody = run("v10.0.0", "v10.0.0", "untrusted edited release body");
  assert.notStrictEqual(changedBody.status, 0);
  assert.match(changedBody.output, /public release body differs from its signed RELEASE_NOTES.md asset/);
  assert.ok(!changedBody.calls.some((call) => call.includes("--method PATCH")));

  const changedAssets = runStep(step, {
    gh,
    env: {
      VERIFIED_RELEASE_ID: "10",
      VERIFIED_RELEASE_TAG: "v10.0.0",
      VERIFIED_ASSET_DIGEST: assetDigest,
      VERIFIED_TAG_OBJECT: "b".repeat(40),
      VERIFIED_COMMIT: "c".repeat(40),
      DEFAULT_BRANCH: "main",
      DEFAULT_SHA: "d".repeat(40),
      FAKE_RELEASE_JSON: releaseJson,
      TAMPER_ASSET: "yes",
    },
    setup: (dir) => {
      fs.mkdirSync(path.join(dir, "fake-assets"));
      for (const [name, body] of Object.entries(contents)) fs.writeFileSync(path.join(dir, "fake-assets", name), body);
      fs.writeFileSync(
        path.join(dir, "public-releases.json"),
        JSON.stringify([[{ id: 10, tag_name: "v10.0.0", draft: false, prerelease: false }]]),
      );
    },
  });
  assert.notStrictEqual(changedAssets.status, 0);
  assert.match(changedAssets.output, /assets changed before Latest reconciliation/);
  assert.ok(!changedAssets.calls.some((call) => call.includes("--method PATCH")));

  const newerReleasePublished = run("v9.0.0", "v11.0.0");
  assert.notStrictEqual(newerReleasePublished.status, 0);
  assert.match(newerReleasePublished.output, /highest public stable release changed/);
  assert.ok(!newerReleasePublished.calls.some((call) => call.includes("--method PATCH")));
});

test("every job has a timeout", () => {
  for (const [id, job] of Object.entries(wf.jobs)) {
    assert.ok(job["timeout-minutes"] > 0, `job ${id}`);
  }
});

// --- least privilege -------------------------------------------------------------

test("policy, build and checks can only read; none of them can sign, attest or write", () => {
  assert.deepStrictEqual(policy.permissions, { actions: "read" });
  assert.deepStrictEqual(build.permissions, { contents: "read" });
  assert.deepStrictEqual(checks.permissions, { contents: "read" });
  for (const job of [policy, build, checks]) {
    assert.strictEqual(job.environment, undefined);
    for (const [scope, level] of Object.entries(job.permissions)) {
      assert.strictEqual(level, "read", scope);
    }
  }
  assert.strictEqual(sign.environment, undefined);
  assert.strictEqual(sign.permissions.contents, "read");
  assert.strictEqual(publish.permissions.contents, "write");
});

test("signing and publishing permissions are isolated by job", () => {
  assert.deepStrictEqual(sign.permissions, {
    contents: "read",
    actions: "read",
    "id-token": "write",
    attestations: "write",
  });
  assert.deepStrictEqual(publish.permissions, {
    contents: "write",
    actions: "read",
  });
  assert.strictEqual(publish.permissions["id-token"], undefined);
  assert.strictEqual(publish.permissions.attestations, undefined);
});

test("job graph: build/checks feed signing; publish waits for all verified producers", () => {
  assert.strictEqual(policy.needs, undefined);
  assert.strictEqual(build.needs, "policy");
  assert.strictEqual(checks.needs, "policy");
  assert.deepStrictEqual(sign.needs, ["build", "checks"]);
  assert.deepStrictEqual(publish.needs, ["build", "checks", "sign"]);
});

test("publish uses the `release` environment, and policy reads its reviewers and exact deployment restrictions", () => {
  assert.strictEqual(publish.environment.name, "release");
  assert.match(runText(policy.steps), /environments\/release"/);
  assert.match(runText(policy.steps), /deployment-branch-policies\?per_page=100/);
  assert.match(runText(policy.steps), /protected_branches == false/);
  assert.match(runText(policy.steps), /custom_branch_policies == true/);
  assert.match(runText(policy.steps), /\.type == "tag"/);
  assert.match(runText(policy.steps), /\.name == "v\*"/);
});

test("publish runs no repository code or third-party actions", () => {
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
  assert.strictEqual(publish.steps.filter((s) => s.uses).length, 0);
  assert.match(runText(publish.steps), /gh run download/);
  assert.strictEqual(publish.env.GH_REPO, "${{ github.repository }}");
});

test("build executes NO third-party code: no npm/npx/node_modules, only first-party actions, Node only for the repository's own verify script", () => {
  const text = runText(build.steps);
  assert.ok(
    !/\b(npm|npx|yarn|pnpm)\b/.test(text),
    "no package manager in build",
  );
  assert.ok(!/node_modules/.test(text));
  for (const step of build.steps) {
    if (step.uses)
      assert.match(
        step.uses,
        /^actions\/(checkout|setup-node|upload-artifact)@/,
        step.uses,
      );
  }
  assert.deepStrictEqual(text.match(/\bnode\b[^\n]*/g), [
    "node .github/scripts/release-check.js verify --notes dist/RELEASE_NOTES.md",
  ]);
});

test("build verifies the tag first (default branch, read-only token), then builds the archive, then uploads it", () => {
  const onMain = runsMatching(build.steps, /merge-base --is-ancestor/);
  const verify = runsMatching(build.steps, /release-check\.js verify/);
  const archive = indexOfStep(
    build.steps,
    (s) => s.id === "archive",
    "archive step",
  );
  const upload = usesStartingWith(build.steps, "actions/upload-artifact@");
  assert.ok(onMain < verify && verify < archive && archive < upload);
  assert.strictEqual(
    build.steps[verify].env.RELEASE_TAG,
    "${{ github.ref_name }}",
  );
  assert.strictEqual(build.steps[verify].env.GH_TOKEN, "${{ github.token }}");
  assert.match(build.steps[archive].run, /git -c tar\.umask=0022 archive/);
  assert.strictEqual(build.steps[upload].with.name, "release-source");
});

test("checks (where third-party code runs) installs from the lockfile without scripts, builds the SBOM, runs the coverage gate, and uploads only the SBOM", () => {
  const install = runsMatching(checks.steps, /npm ci --ignore-scripts/);
  const sbom = indexOfStep(checks.steps, (s) => s.id === "sbom", "sbom step");
  const tests = runsMatching(checks.steps, /npm run coverage/);
  const upload = usesStartingWith(checks.steps, "actions/upload-artifact@");
  assert.ok(
    install < sbom && sbom < tests && tests < upload,
    "a failing test must stop the job before anything is uploaded",
  );
  assert.strictEqual(checks.steps[upload].with.name, "release-sbom");
  assert.match(checks.steps[sbom].run, /release-check\.js sbom --out/);
  assert.ok(
    !/git archive|\.tar\.gz|SHA256SUMS/.test(runText(checks.steps)),
    "checks never touches the archive or the checksums",
  );
  assert.deepStrictEqual(Object.keys(checks.outputs), ["sbom-digest"]);
});

test("sign verifies BOTH producer job-output digests and rejects stray files before signing", () => {
  assert.match(
    build.outputs["source-digest"],
    /steps\.archive\.outputs\.source-digest/,
  );
  assert.match(
    checks.outputs["sbom-digest"],
    /steps\.sbom\.outputs\.sbom-digest/,
  );
  const idx = stepNamed(sign.steps, DIGEST_STEP);
  const step = sign.steps[idx];
  assert.strictEqual(
    step.env.EXPECTED_SOURCE_DIGEST,
    "${{ needs.build.outputs.source-digest }}",
  );
  assert.strictEqual(
    step.env.EXPECTED_SBOM_DIGEST,
    "${{ needs.checks.outputs.sbom-digest }}",
  );
  assert.match(runText(sign.steps), /gh run download .*release-source/);
  assert.match(runText(sign.steps), /gh run download .*release-sbom/);
  assert.ok(idx < usesStartingWith(sign.steps, "actions/attest@"));
  assert.ok(
    idx < usesStartingWith(sign.steps, "sigstore/cosign-installer@"),
  );
  assert.match(
    step.run,
    /\[ -z "\$EXPECTED_SOURCE_DIGEST" \]/,
    "an empty digest must fail",
  );
  assert.match(
    step.run,
    /\[ -z "\$EXPECTED_SBOM_DIGEST" \]/,
    "an empty digest must fail",
  );
  // Producer and verifier must use the very same formulas.
  const sourceFormula =
    "sha256sum dist/RELEASE_NOTES.md \"dist/${name}.tar.gz\" | sha256sum | cut -d' ' -f1";
  const sbomFormula =
    "sha256sum \"dist/${name}.sbom.cdx.json\" | cut -d' ' -f1";
  assert.ok(
    build.steps[
      indexOfStep(build.steps, (s) => s.id === "archive", "archive")
    ].run.includes(sourceFormula),
  );
  assert.ok(step.run.includes(sourceFormula));
  assert.ok(
    checks.steps[
      indexOfStep(checks.steps, (s) => s.id === "sbom", "sbom")
    ].run.includes(sbomFormula),
  );
  assert.ok(step.run.includes(sbomFormula));
  assert.ok(
    !/SHA256SUMS/.test(runText(build.steps)) &&
      !/SHA256SUMS/.test(runText(checks.steps)),
  );
  assert.match(
    step.run,
    /sha256sum RELEASE_NOTES\.md "\$\{name\}\.tar\.gz" "\$\{name\}\.sbom\.cdx\.json" > SHA256SUMS/,
  );
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
    sign.steps[
      usesStartingWith(sign.steps, "sigstore/cosign-installer@")
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

test("checkouts keep no credentials (build needs full history); every setup-node has caching disabled", () => {
  for (const job of [build, checks]) {
    const checkout =
      job.steps[usesStartingWith(job.steps, "actions/checkout@")];
    assert.strictEqual(
      checkout.with.ref,
      "${{ github.sha }}",
      `${job.name} must validate/build the exact event commit`,
    );
    assert.strictEqual(checkout.with["persist-credentials"], false);
    const node = job.steps[usesStartingWith(job.steps, "actions/setup-node@")];
    assert.strictEqual(node.with["package-manager-cache"], false);
    assert.strictEqual(node.with.cache, undefined);
  }
  assert.strictEqual(
    build.steps[usesStartingWith(build.steps, "actions/checkout@")].with[
      "fetch-depth"
    ],
    0,
  );
  assert.ok(!/actions\/cache@/.test(raw), "no cache in a release workflow");
});

test("npm runs only in `checks`, from the lockfile, with lifecycle scripts disabled", () => {
  assert.match(runText(checks.steps), /npm ci --ignore-scripts/);
  for (const job of [policy, build, sign, publish]) {
    assert.ok(!/\bnpm\b/.test(runText(job.steps)));
  }
});

// --- order of operations --------------------------------------------------------------

test("sign verifies producer outputs, signs, self-verifies and uploads; publish verifies that artifact, drafts, publishes and verifies the public copy", () => {
  const steps = publish.steps;
  const order = [
    stepNamed(steps, "Download the signed release files"),
    stepNamed(steps, "Verify the signed artifact digest before publishing"),
    stepNamed(steps, "Require a patched GitHub CLI"),
    runsMatching(steps, /gh release create/),
    stepNamed(steps, DRAFT_CHECK),
    stepNamed(steps, PUBLISH_STEP),
    stepNamed(steps, PUBLISHED_CHECK),
    stepNamed(steps, IMMUTABLE_CHECK),
  ];
  assert.deepStrictEqual(
    [...order].sort((a, b) => a - b),
    order,
    "steps are out of order",
  );
  assert.strictEqual(new Set(order).size, order.length);
  assert.strictEqual(
    order[order.length - 1],
    steps.length - 1,
    "the immutability requirement is the last step",
  );
  const signingOrder = [
    stepNamed(sign.steps, DIGEST_STEP),
    usesStartingWith(sign.steps, "sigstore/cosign-installer@"),
    indexOfStep(sign.steps, (s) => s.id === "provenance", "provenance attestation"),
    indexOfStep(sign.steps, (s) => s.id === "sbom", "SBOM attestation"),
    runsMatching(sign.steps, /cosign sign-blob/),
    runsMatching(sign.steps, /cosign verify-blob[\s\S]*gh attestation verify/),
    stepNamed(sign.steps, "Record the exact signed artifact digest"),
    usesStartingWith(sign.steps, "actions/upload-artifact@"),
  ];
  assert.deepStrictEqual(signingOrder, [...signingOrder].sort((a, b) => a - b));
});

test("the release is created as a DRAFT bound to the pushed tag, and only a later step publishes it", () => {
  const create =
    publish.steps[stepNamed(publish.steps, "Find or create the draft release")].run;
  assert.match(create, /--draft\b/);
  assert.match(create, /--verify-tag\b/);
  assert.ok(!/--latest/.test(create), "creation must not publish");
  const publishCall =
    publish.steps[runsMatching(publish.steps, /gh api --method PATCH/)].run;
  assert.match(publishCall, /-F draft=false/);
  assert.match(publishCall, /-f make_latest=false/);
});

test("draft lookup uses the authenticated release listing and classifies lookup failures separately", () => {
  const createIndex = stepNamed(publish.steps, "Find or create the draft release");
  const create = publish.steps[createIndex].run;
  assert.match(create, /gh api --paginate --slurp .*releases\?per_page=100/);
  assert.match(create, /jq -ce --arg tag "\$RELEASE_TAG"/);
  assert.match(create, /gh release create "\$RELEASE_TAG"/);
  assert.match(create, /published releases are never overwritten/i);
  assert.doesNotMatch(create, /gh release view/);
  assert.ok(createIndex < stepNamed(publish.steps, DRAFT_CHECK));

  const runLookup = (
    initial,
    { listingFails = false, postCreateListingFails = false, duplicate = false } = {},
  ) => {
    const afterCreate = [[{ id: 123, tag_name: "v1.2.3", draft: true }]];
    const initialPages = duplicate
      ? [[
          { id: 123, tag_name: "v1.2.3", draft: true },
          { id: 124, tag_name: "v1.2.3", draft: true },
        ]]
      : initial;
    return runStep(publish.steps[createIndex], {
      gh: [
        'case "$*" in',
        '  *"releases?per_page=100"*)',
        '    if [ -f created.txt ]; then [ "$FAIL_POST_CREATE_LISTING" != yes ] || exit 1; cat after-create.json; else',
        '      [ "$FAIL_LISTING" != yes ] || exit 1',
        '      cat initial.json',
        "    fi ;;",
        '  *"release create"*) touch created.txt ;;',
        '  *) exit 99 ;;',
        "esac",
      ].join("\n"),
      env: {
        FAIL_LISTING: listingFails ? "yes" : "no",
        FAIL_POST_CREATE_LISTING: postCreateListingFails ? "yes" : "no",
        RELEASE_TAG: "v1.2.3",
        GITHUB_REPOSITORY: "fossasia/cla-bot",
      },
      setup: (dir) => {
        fs.writeFileSync(path.join(dir, "initial.json"), JSON.stringify(initialPages));
        fs.writeFileSync(path.join(dir, "after-create.json"), JSON.stringify(afterCreate));
      },
      after: (dir) => fs.existsSync(path.join(dir, "created.txt")),
    });
  };

  const absent = runLookup([[]]);
  assert.strictEqual(absent.status, 0, absent.output);
  assert.strictEqual(absent.extra, true, "an absent release is created");
  assert.match(absent.githubOutput, /release-id=123/);

  const matchingDraft = runLookup([[{ id: 123, tag_name: "v1.2.3", draft: true }]]);
  assert.strictEqual(matchingDraft.status, 0, matchingDraft.output);
  assert.strictEqual(matchingDraft.extra, false, "an existing draft is reused");
  assert.match(matchingDraft.githubOutput, /release-id=123/);

  const published = runLookup([[{ id: 123, tag_name: "v1.2.3", draft: false }]]);
  assert.strictEqual(published.status, 1, published.output);
  assert.match(published.output, /already published/);
  assert.strictEqual(published.extra, false, "a published release is never recreated");

  const failedLookup = runLookup([[]], { listingFails: true });
  assert.strictEqual(failedLookup.status, 1, failedLookup.output);
  assert.match(failedLookup.output, /Could not list releases/);
  assert.strictEqual(failedLookup.extra, false, "API failure is not treated as absence");

  const malformed = runLookup({ unexpected: "shape" });
  assert.strictEqual(malformed.status, 1, malformed.output);
  assert.match(malformed.output, /listing response was invalid/);
  assert.strictEqual(malformed.extra, false, "invalid response is not treated as absence");

  const postCreateFailure = runLookup([[]], { postCreateListingFails: true });
  assert.strictEqual(postCreateFailure.status, 1, postCreateFailure.output);
  assert.match(postCreateFailure.output, /release ID could not be confirmed/);
  assert.strictEqual(postCreateFailure.extra, true, "the created draft remains for a safe retry");

  const multiple = runLookup([[]], { duplicate: true });
  assert.strictEqual(multiple.status, 1, multiple.output);
  assert.match(multiple.output, /Multiple releases are associated/);
  assert.strictEqual(multiple.extra, false);

  const exactDraftCheck = runDraftCheck(() => {});
  assert.strictEqual(exactDraftCheck.status, 0, exactDraftCheck.output);
  const mismatchedDraft = runDraftCheck(({ served, name }) =>
    fs.appendFileSync(path.join(served, `${name}.tar.gz`), "changed"),
  );
  assert.notStrictEqual(mismatchedDraft.status, 0);
  assert.match(mismatchedDraft.output, /Refusing to publish/);
});

test("release creation never deletes or overwrites an existing release", () => {
  const create =
    publish.steps[runsMatching(publish.steps, /gh release create/)].run;
  assert.match(create, /gh release create "\$RELEASE_TAG"/);
  assert.doesNotMatch(create, /gh release delete/);
  assert.doesNotMatch(raw, /gh release delete/);
  assert.ok(!/--clobber/.test(raw), "no --clobber anywhere");
});

test("each attest step's bundle is copied to its final name immediately (the action may reuse one path)", () => {
  const prov = indexOfStep(
    sign.steps,
    (s) => s.id === "provenance",
    "provenance",
  );
  const sbom = indexOfStep(sign.steps, (s) => s.id === "sbom", "sbom");
  assert.match(
    sign.steps[prov + 1].env.BUNDLE,
    /steps\.provenance\.outputs\.bundle-path/,
  );
  assert.match(sign.steps[prov + 1].run, /provenance\.intoto\.jsonl/);
  assert.match(
    sign.steps[sbom + 1].env.BUNDLE,
    /steps\.sbom\.outputs\.bundle-path/,
  );
  assert.match(sign.steps[sbom + 1].run, /sbom\.intoto\.jsonl/);
  for (const i of [prov, sbom]) {
    assert.strictEqual(sign.steps[i].with["create-storage-record"], false);
  }
});

test("verification pins WHO may have signed: this exact workflow file, on this tag, this commit", () => {
  const text = runText(sign.steps);
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

test("the tag is re-checked right before the draft is created, and in the SAME STEP as the publish call", () => {
  const create = runsMatching(publish.steps, /gh release create/);
  assert.strictEqual(
    stepNamed(publish.steps, CREATE_RECHECK),
    create - 1,
    "no step between that check and the create",
  );
  const draft = stepNamed(publish.steps, DRAFT_CHECK);
  const pub = stepNamed(publish.steps, PUBLISH_STEP);
  assert.ok(
    create < draft && draft < pub,
    "create, then the draft check, then the check-and-publish step",
  );
  const script = publish.steps[pub].run;
  const checkAt = script.indexOf("git/ref/tags/");
  const editAt = script.indexOf("gh api --method PATCH");
  const finalAssetsAt = script.indexOf('releases/assets/${asset_id}');
  const finalCompareAt = script.indexOf('cmp -s -- "dist/${asset}" "final-draft/${asset}"');
  const finalSnapshotAt = script.indexOf('final_release_json="$(gh api');
  const finalSnapshotCompareAt = script.indexOf('if [ "$final_meta"');
  assert.ok(
    finalCompareAt >= 0 && finalCompareAt < checkAt &&
      checkAt < finalSnapshotAt && finalSnapshotAt < finalSnapshotCompareAt &&
      finalSnapshotCompareAt < editAt,
    "compare bytes, check tag, re-read release state, then publish in one script",
  );
  assert.ok(
    finalAssetsAt >= 0 && finalAssetsAt < finalCompareAt &&
      finalCompareAt < finalSnapshotAt,
    "download and compare the exact assets before a final release snapshot check",
  );
  assert.strictEqual((script.match(/gh api --method PATCH/g) ?? []).length, 1);
  assert.match(script, /gh api --method PATCH[\s\S]*-F draft=false[\s\S]*-f make_latest=false/);
  const between = script.slice(finalSnapshotCompareAt, editAt);
  assert.ok(
    !/\b(gh|git|curl|sleep|npm|node)\b/.test(
      between.replace(/gh api --method PATCH[^\n]+/, ""),
    ),
    "the final release snapshot comparison is followed directly by the publish call",
  );
});

test("after publishing, the tag is checked once more and the release is called compromised if it moved", () => {
  const finalStep =
    publish.steps[stepNamed(publish.steps, PUBLISHED_CHECK)].run;
  assert.match(finalStep, /git\/ref\/tags\/\$\{RELEASE_TAG\}/);
  assert.match(finalStep, /"tag \$\{EXPECTED_TAG_OBJECT\}"/);
  assert.match(finalStep, /compromised/);
});

test("post-publish verification compares the exact expected asset set and every asset byte for byte", () => {
  const finalStep =
    publish.steps[stepNamed(publish.steps, PUBLISHED_CHECK)].run;
  assert.match(finalStep, /releases\/assets\/\$\{asset_id\}/);
  assert.match(finalStep, /EXPECTED_RELEASE_ID/);
  assert.doesNotMatch(finalStep, /gh release (view|download) "\$RELEASE_TAG"/);
  assert.match(finalStep, /find published -maxdepth 1 -type f/);
  assert.match(finalStep, /Published release has \$\{count\} assets/);
  assert.match(finalStep, /for asset in "\$\{assets\[@\]\}"/);
  assert.match(finalStep, /cmp -s -- "dist\/\$\{asset\}" "published\/\$\{asset\}"/);
  assert.ok(
    finalStep.indexOf("cmp -s") < finalStep.indexOf("sha256sum --check"),
    "all files must match before checksum/signature validation proceeds",
  );
});

test("post-publish verification downloads assets only by the retained release and asset IDs", () => {
  const step = publish.steps[stepNamed(publish.steps, PUBLISHED_CHECK)];
  const gh = [
    'case "$*" in',
    '  *"releases/123"*) printf \'%s\\n\' "$FAKE_RELEASE_JSON" ;;',
    '  *"release download"*) printf \'wrong release 999\' > "$5/wrong-release-999" ;;',
    ...releaseAssets().map((asset, index) =>
      `  *"releases/assets/${100 + index} "*) cat "$FAKE_DRAFT_DIR/${asset}" 2>/dev/null || : ;;`,
    ),
    '  *"git/ref/tags/"*) printf \'%s\\n\' "tag $EXPECTED_TAG_OBJECT" ;;',
    '  "attestation verify"*) exit 0 ;;',
    '  *) exit 99 ;;',
    "esac",
  ].join("\n");
  const result = runStep(step, {
    gh,
    env: {
      EXPECTED_RELEASE_ID: "123",
      EXPECTED_TAG_OBJECT: SHA_VERIFIED,
      FAKE_RELEASE_JSON: releasePayload("123 v1.2.3 v1.2.3 false false", "notes"),
      FAKE_DRAFT_DIR: "served",
      GITHUB_REF: "refs/tags/v1.2.3",
      GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
    },
    setup: (dir) => {
      setupPublishDraft(dir);
      const checksum = spawnSync(
        "sha256sum",
        ["RELEASE_NOTES.md", "cla-bot-v1.2.3.tar.gz", "cla-bot-v1.2.3.sbom.cdx.json"],
        { cwd: path.join(dir, "dist"), encoding: "utf8" },
      );
      assert.strictEqual(checksum.status, 0, checksum.stderr);
      for (const destination of ["dist", "served"]) {
        fs.writeFileSync(path.join(dir, destination, "SHA256SUMS"), checksum.stdout);
      }
    },
  });
  assert.strictEqual(result.status, 0, `${result.output}\n${result.calls.join("\n")}`);
  assert.ok(result.calls.includes("api repos/fossasia/cla-bot/releases/123"));
  for (let assetId = 100; assetId < 110; assetId += 1) {
    assert.ok(
      result.calls.some((call) => call.startsWith(`api repos/fossasia/cla-bot/releases/assets/${assetId} `)),
      `downloads asset ID ${assetId}`,
    );
  }
  assert.ok(
    !result.calls.some((call) => /release (view|download)|releases\/tags\//.test(call)),
    "verification never resolves an asset or release again by tag",
  );
});

test("re-check (real shell, fake gh): passes only while the tag still resolves to the verified tag object, and only then does the publish call happen", () => {
  for (const name of [CREATE_RECHECK, PUBLISH_STEP]) {
    const step = publish.steps[stepNamed(publish.steps, name)];
    const same = runStep(step, {
      gh:
        name === PUBLISH_STEP
          ? publishTagGh(`tag ${SHA_VERIFIED}`)
          : ghAnswers(`tag ${SHA_VERIFIED}`),
      env: {
        EXPECTED_TAG_OBJECT: SHA_VERIFIED,
        EXPECTED_RELEASE_ID: "123",
        FAKE_DRAFT_DIR: "served",
      },
      setup: name === PUBLISH_STEP ? setupPublishDraft : undefined,
    });
    assert.strictEqual(same.status, 0, `${name}\n${same.output}\n${same.calls.join("\n")}`);
    assert.ok(
      same.calls.some((call) =>
        /^api repos\/fossasia\/cla-bot\/git\/ref\/tags\/v1\.2\.3 --jq /.test(
          call,
        ),
      ),
      "the verified tag ref is queried",
    );
    assert.deepStrictEqual(
      same.calls.filter((call) => call.startsWith("api --method PATCH")),
      name === PUBLISH_STEP
        ? [
            "api --method PATCH repos/fossasia/cla-bot/releases/123 -F draft=false -f make_latest=false",
          ]
        : [],
      name,
    );
  }
});

test("re-check (real shell, fake gh): a MOVED, re-created-as-lightweight, or unexpected tag stops the release and never reaches the publish call", () => {
  for (const name of [CREATE_RECHECK, PUBLISH_STEP]) {
    const step = publish.steps[stepNamed(publish.steps, name)];
    for (const [label, current] of [
      ["tag moved to another tag object", `tag ${SHA_MOVED}`],
      [
        "tag replaced by a lightweight tag at the same commit",
        `commit ${SHA_VERIFIED}`,
      ],
      ["tag replaced by a lightweight tag elsewhere", `commit ${SHA_MOVED}`],
      ["empty answer", ""],
    ]) {
      const r = runStep(step, {
        gh: name === PUBLISH_STEP ? publishTagGh(current) : ghAnswers(current),
        env: {
          EXPECTED_TAG_OBJECT: SHA_VERIFIED,
          EXPECTED_RELEASE_ID: "123",
          FAKE_DRAFT_DIR: "served",
        },
        setup: name === PUBLISH_STEP ? setupPublishDraft : undefined,
      });
      assert.notStrictEqual(r.status, 0, `${name}: ${label}`);
      assert.match(
        r.output,
        /no longer resolves to the signed tag object/,
        `${name}: ${label}`,
      );
      assert.ok(
        !r.calls.some((call) => call.startsWith("release edit")),
        `${name}: ${label}: must not publish`,
      );
    }
  }
});

test("re-check (real shell, fake gh): an empty expected value or a failing gh can never pass, and never publishes", () => {
  for (const name of [CREATE_RECHECK, PUBLISH_STEP]) {
    const step = publish.steps[stepNamed(publish.steps, name)];
    const noExpected = runStep(step, {
      gh: name === PUBLISH_STEP ? publishTagGh("tag ") : ghAnswers("tag "),
      env: { EXPECTED_TAG_OBJECT: "", EXPECTED_RELEASE_ID: "123", FAKE_DRAFT_DIR: "served" },
      setup: name === PUBLISH_STEP ? setupPublishDraft : undefined,
    });
    assert.notStrictEqual(
      noExpected.status,
      0,
      `${name}: empty EXPECTED_TAG_OBJECT must fail`,
    );
    const ghDown = runStep(step, {
      gh: "exit 1",
      env: { EXPECTED_TAG_OBJECT: SHA_VERIFIED, EXPECTED_RELEASE_ID: "123" },
      setup: name === PUBLISH_STEP ? setupPublishDraft : undefined,
    });
    assert.notStrictEqual(
      ghDown.status,
      0,
      `${name}: an API failure must fail the step`,
    );
    for (const r of [noExpected, ghDown]) {
      assert.ok(
        !r.calls.some((call) => call.startsWith("release edit")),
        `${name}: must not publish`,
      );
    }
  }
});

test("final publish step rechecks the draft bytes and metadata after the earlier draft check", () => {
  const step = publish.steps[stepNamed(publish.steps, PUBLISH_STEP)];
  for (const [label, options] of [
    ["asset changed", {
      mutate: (served) => fs.appendFileSync(path.join(served, "SHA256SUMS"), "changed\n"),
    }],
    ["asset missing", {
      mutate: (served) => fs.rmSync(path.join(served, "SHA256SUMS")),
    }],
    ["extra asset", {
      mutate: (served) => fs.writeFileSync(path.join(served, "unexpected.txt"), "extra"),
      assets: [...releaseAssets(), "unexpected.txt"],
    }],
    ["metadata changed", {
      meta: "123 v1.2.3 v1.2.3 false false",
    }],
    ["notes changed", { body: "altered notes" }],
  ]) {
    const result = runStep(step, {
      gh: publishTagGh(`tag ${SHA_VERIFIED}`, {
        ...(options.meta ? { meta: options.meta } : {}),
        ...(options.body ? { body: options.body } : {}),
        ...(options.assets ? { assets: options.assets } : {}),
      }),
      env: {
        EXPECTED_TAG_OBJECT: SHA_VERIFIED,
        EXPECTED_RELEASE_ID: "123",
        FAKE_DRAFT_DIR: "served",
      },
      setup: (dir) => setupPublishDraft(dir, options.mutate),
    });
    assert.notStrictEqual(result.status, 0, label);
    assert.match(result.output, /Refusing to publish/);
    assert.ok(
      !result.calls.some((call) => call.startsWith("api --method PATCH")),
      `${label}: must stop before publishing`,
    );
  }
});

test("final publish detects same-name asset replacement after the verified download", () => {
  const step = publish.steps[stepNamed(publish.steps, PUBLISH_STEP)];
  const replacedIds = Object.fromEntries(
    releaseAssets().map((asset, index) => [asset, index === 0 ? 999 : 100 + index]),
  );
  const replacement = releasePayload(
    "123 v1.2.3 v1.2.3 true false",
    "notes",
    releaseAssets(),
    replacedIds,
  );
  const result = runStep(step, {
    gh: publishTagGh(`tag ${SHA_VERIFIED}`),
    env: {
      EXPECTED_TAG_OBJECT: SHA_VERIFIED,
      EXPECTED_RELEASE_ID: "123",
      FAKE_DRAFT_DIR: "served",
      FAKE_FINAL_RELEASE_JSON: replacement,
    },
    setup: setupPublishDraft,
  });
  assert.notStrictEqual(result.status, 0, result.output);
  assert.match(result.output, /asset objects changed while verifying/);
  assert.ok(
    result.calls.some((call) => call.includes("releases/assets/100 ")),
    "bytes were fetched from the asset ID in the first release snapshot",
  );
  assert.ok(
    !result.calls.some((call) => call.startsWith("api --method PATCH")),
    "a same-name replacement detected in the fresh release snapshot is never published",
  );
});

test("final publish requires an unchanged release snapshot after downloading assets", () => {
  const step = publish.steps[stepNamed(publish.steps, PUBLISH_STEP)];
  const unchanged = releasePayload();
  const variants = [
    ["asset removed", releasePayload(undefined, "notes", releaseAssets().slice(1))],
    ["asset added", releasePayload(undefined, "notes", [...releaseAssets(), "unexpected.txt"])],
    ["asset upload state changed", unchanged.replace('"state":"uploaded"', '"state":"starter"')],
    ["asset name changed", unchanged.replace('"name":"cla-bot-v1.2.3.tar.gz"', '"name":"replaced.tar.gz"')],
    ["asset size changed", unchanged.replace('"size":1', '"size":2')],
    ["asset digest changed", unchanged.replace('"digest":null', '"digest":"sha256:changed"')],
    ["release notes changed", releasePayload(undefined, "edited notes")],
    ["release title changed", releasePayload("123 v1.2.3 altered-title true false")],
    ["release tag changed", releasePayload("123 v1.2.4 v1.2.3 true false")],
    ["release ID changed", releasePayload("999 v1.2.3 v1.2.3 true false")],
    ["release became published", releasePayload("123 v1.2.3 v1.2.3 false false")],
    ["release became a prerelease", releasePayload("123 v1.2.3 v1.2.3 true true")],
  ];
  for (const [label, finalReleaseJson] of variants) {
    const result = runStep(step, {
      gh: publishTagGh(`tag ${SHA_VERIFIED}`),
      env: {
        EXPECTED_TAG_OBJECT: SHA_VERIFIED,
        EXPECTED_RELEASE_ID: "123",
        FAKE_DRAFT_DIR: "served",
        FAKE_FINAL_RELEASE_JSON: finalReleaseJson,
      },
      setup: setupPublishDraft,
    });
    assert.notStrictEqual(result.status, 0, `${label}: ${result.output}`);
    assert.match(result.output, /metadata or asset objects changed/);
    assert.ok(
      !result.calls.some((call) => call.startsWith("api --method PATCH")),
      `${label}: never publishes`,
    );
  }
});

test("final release snapshot API errors fail closed, while an unchanged snapshot publishes", () => {
  const step = publish.steps[stepNamed(publish.steps, PUBLISH_STEP)];
  const stableJson = releasePayload();
  const stable = runStep(step, {
    gh: publishTagGh(`tag ${SHA_VERIFIED}`),
    env: {
      EXPECTED_TAG_OBJECT: SHA_VERIFIED,
      EXPECTED_RELEASE_ID: "123",
      FAKE_DRAFT_DIR: "served",
      FAKE_FINAL_RELEASE_JSON: stableJson,
    },
    setup: setupPublishDraft,
  });
  assert.strictEqual(stable.status, 0, `${stable.output}\n${stable.calls.join("\n")}`);
  assert.strictEqual(
    stable.calls.filter((call) => call.startsWith("api --method PATCH")).length,
    1,
  );
  assert.strictEqual(
    stable.calls.filter((call) => call === "api repos/fossasia/cla-bot/releases/123").length,
    2,
    "one release read provides asset IDs; a second read confirms the objects remained attached",
  );

  const unavailable = runStep(step, {
    gh: publishTagGh(`tag ${SHA_VERIFIED}`),
    env: {
      EXPECTED_TAG_OBJECT: SHA_VERIFIED,
      EXPECTED_RELEASE_ID: "123",
      FAKE_DRAFT_DIR: "served",
      FAKE_FINAL_RELEASE_FAILURE: "true",
    },
    setup: setupPublishDraft,
  });
  assert.notStrictEqual(unavailable.status, 0);
  assert.ok(
    !unavailable.calls.some((call) => call.startsWith("api --method PATCH")),
    "failure to establish the final snapshot must never publish",
  );
});

test("publication rechecks the tag after asset and release verification, catching a late tag move", () => {
  const step = publish.steps[stepNamed(publish.steps, PUBLISH_STEP)];
  const result = runStep(step, {
    gh: publishTagGh(`tag ${SHA_VERIFIED}`),
    env: {
      EXPECTED_TAG_OBJECT: SHA_VERIFIED,
      EXPECTED_RELEASE_ID: "123",
      FAKE_DRAFT_DIR: "served",
      FAKE_TAG_AFTER_ASSETS: `tag ${SHA_MOVED}`,
    },
    setup: setupPublishDraft,
  });
  assert.notStrictEqual(result.status, 0, result.output);
  assert.match(result.output, /no longer resolves to the signed tag object/);
  const lastAssetRead = result.calls.reduce(
    (last, call, index) => call.includes("releases/assets/") ? index : last,
    -1,
  );
  const tagRead = result.calls.findIndex((call) => call.includes("git/ref/tags/"));
  assert.ok(lastAssetRead >= 0 && lastAssetRead < tagRead, "tag is checked after every asset download");
  const lastReleaseRead = result.calls.reduce(
    (last, call, index) => call === "api repos/fossasia/cla-bot/releases/123" ? index : last,
    -1,
  );
  assert.ok(lastReleaseRead < tagRead, "a moved tag fails before the final release snapshot");
  assert.ok(
    !result.calls.some((call) => call.startsWith("api --method PATCH")),
    "a tag move during final verification prevents publication",
  );
});

test("a failed final tag lookup after asset verification cannot publish", () => {
  const step = publish.steps[stepNamed(publish.steps, PUBLISH_STEP)];
  const result = runStep(step, {
    gh: publishTagGh(`tag ${SHA_VERIFIED}`),
    env: {
      EXPECTED_TAG_OBJECT: SHA_VERIFIED,
      EXPECTED_RELEASE_ID: "123",
      FAKE_DRAFT_DIR: "served",
      FAKE_TAG_API_FAILURE_AFTER_ASSETS: "true",
    },
    setup: setupPublishDraft,
  });
  assert.notStrictEqual(result.status, 0);
  assert.ok(result.calls.some((call) => call.includes("git/ref/tags/")));
  assert.ok(
    !result.calls.some((call) => call.startsWith("api --method PATCH")),
    "a failed final tag lookup fails closed",
  );
});

test("asset replacement during the final tag lookup is caught by the post-tag release snapshot", () => {
  const step = publish.steps[stepNamed(publish.steps, PUBLISH_STEP)];
  const replacedIds = Object.fromEntries(
    releaseAssets().map((asset, index) => [asset, index === 0 ? 999 : 100 + index]),
  );
  const replacement = releasePayload(
    "123 v1.2.3 v1.2.3 true false",
    "notes",
    releaseAssets(),
    replacedIds,
  );
  const result = runStep(step, {
    gh: publishTagGh(`tag ${SHA_VERIFIED}`),
    env: {
      EXPECTED_TAG_OBJECT: SHA_VERIFIED,
      EXPECTED_RELEASE_ID: "123",
      FAKE_DRAFT_DIR: "served",
      FAKE_RELEASE_AFTER_TAG: replacement,
    },
    setup: setupPublishDraft,
  });
  assert.notStrictEqual(result.status, 0, result.output);
  assert.match(result.output, /asset objects changed while verifying/);
  const tagRead = result.calls.findIndex((call) => call.includes("git/ref/tags/"));
  const finalReleaseRead = result.calls.findLastIndex(
    (call) => call === "api repos/fossasia/cla-bot/releases/123",
  );
  assert.ok(tagRead >= 0 && tagRead < finalReleaseRead);
  assert.ok(
    !result.calls.some((call) => call.startsWith("api --method PATCH")),
    "replacement detected after the tag lookup is never published",
  );
});

const draftStep = publish.steps[stepNamed(publish.steps, DRAFT_CHECK)];
function runDraftCheck(
  mutate,
  {
    meta = "123 v1.2.3 v1.2.3 true false",
    body = "signed release notes",
    apiAssets = releaseAssets(),
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "draft-check-"));
  try {
    const name = "cla-bot-v1.2.3";
    const assets = [
      "RELEASE_NOTES.md",
      "RELEASE_NOTES.md.sigstore.json",
      `${name}.tar.gz`,
      `${name}.tar.gz.sigstore.json`,
      `${name}.sbom.cdx.json`,
      `${name}.sbom.cdx.json.sigstore.json`,
      `${name}.provenance.intoto.jsonl`,
      `${name}.sbom.intoto.jsonl`,
      "SHA256SUMS",
      "SHA256SUMS.sigstore.json",
    ];
    fs.mkdirSync(path.join(dir, "dist"));
    fs.mkdirSync(path.join(dir, "served"));
    for (const asset of assets) {
      const bytes = asset === "RELEASE_NOTES.md" ? "signed release notes\n" : `content of ${asset}\n`;
      fs.writeFileSync(path.join(dir, "dist", asset), bytes);
      fs.writeFileSync(
        path.join(dir, "served", asset),
        bytes,
      );
    }
    mutate({ served: path.join(dir, "served"), name });
    fs.mkdirSync(path.join(dir, "bin"));
    fs.writeFileSync(
      path.join(dir, "bin", "gh"),
      [
        "#!/bin/sh",
        'case "$*" in',
        '  *"releases/123"*) printf \'%s\\n\' "$FAKE_RELEASE_JSON" ;;',
        '  *"release download"*) printf \'wrong release 999\' > "$5/wrong-release-999" ;;',
        ...assets.map((asset, index) =>
          `  *"releases/assets/${100 + index} "*) cat "$FAKE_DRAFT_DIR/${asset}" 2>/dev/null || : ;;`,
        ),
        "  *) exit 9 ;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const result = spawnSync("bash", ["-c", draftStep.run], {
      cwd: dir,
      env: {
        PATH: `${path.join(dir, "bin")}:${process.env.PATH}`,
        RELEASE_TAG: "v1.2.3",
        FAKE_DRAFT_DIR: path.join(dir, "served"),
        EXPECTED_RELEASE_ID: "123",
        GITHUB_REPOSITORY: "fossasia/cla-bot",
        FAKE_RELEASE_JSON: releasePayload(meta, body, apiAssets),
      },
      encoding: "utf8",
    });
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("draft check (real shell, fake gh): passes only when the draft holds exactly the verified bytes", () => {
  const ok = runDraftCheck(() => {});
  assert.strictEqual(ok.status, 0, ok.output);
});

test("draft check (real shell, fake gh): a changed byte, a swapped, missing or extra asset all stop the release", () => {
  const cases = [
    [
      "one byte appended to the archive",
      ({ served, name }) =>
        fs.appendFileSync(path.join(served, `${name}.tar.gz`), "x"),
    ],
    [
      "signature bundle replaced",
      ({ served, name }) =>
        fs.writeFileSync(
          path.join(served, `${name}.tar.gz.sigstore.json`),
          "forged",
      ),
    ],
    [
      "signed release notes altered",
      ({ served }) =>
        fs.appendFileSync(path.join(served, "RELEASE_NOTES.md"), "tampered\n"),
    ],
    [
      "release notes signature bundle replaced",
      ({ served }) =>
        fs.writeFileSync(path.join(served, "RELEASE_NOTES.md.sigstore.json"), "forged"),
    ],
    [
      "SBOM signature bundle replaced",
      ({ served, name }) =>
        fs.writeFileSync(path.join(served, `${name}.sbom.cdx.json.sigstore.json`), "forged"),
    ],
    [
      "SHA256SUMS replaced",
      ({ served }) =>
        fs.writeFileSync(path.join(served, "SHA256SUMS"), "forged"),
    ],
    [
      "asset missing",
      ({ served }) => fs.rmSync(path.join(served, "SHA256SUMS.sigstore.json")),
      { apiAssets: releaseAssets().filter((asset) => asset !== "SHA256SUMS.sigstore.json") },
    ],
    [
      "signed notes asset missing",
      ({ served }) => fs.rmSync(path.join(served, "RELEASE_NOTES.md")),
      { apiAssets: releaseAssets().filter((asset) => asset !== "RELEASE_NOTES.md") },
    ],
    [
      "extra asset added",
      ({ served }) =>
        fs.writeFileSync(path.join(served, "backdoor.sh"), "#!/bin/sh"),
      { apiAssets: [...releaseAssets(), "backdoor.sh"] },
    ],
    [
      "asset swapped for another name",
      ({ served, name }) => {
        fs.renameSync(
          path.join(served, `${name}.sbom.cdx.json`),
          path.join(served, "other.json"),
        );
      },
    ],
  ];
  for (const [label, mutate, options] of cases) {
    const result = runDraftCheck(mutate, options);
    assert.notStrictEqual(result.status, 0, label);
    assert.match(result.output, /Refusing to publish/, label);
  }
});

test("draft check (real shell, fake gh): changed title, tag, draft/pre-release flags or notes stop the release", () => {
  for (const [label, options] of [
    ["title changed", { meta: "123 v9.9.9 v1.2.3 true false" }],
    ["tag changed", { meta: "123 v1.2.3 v9.9.9 true false" }],
    ["no longer a draft", { meta: "123 v1.2.3 v1.2.3 false false" }],
    ["marked as a pre-release", { meta: "123 v1.2.3 v1.2.3 true true" }],
    ["invalid release ID", { meta: "not-a-number v1.2.3 v1.2.3 true false" }],
    ["empty metadata", { meta: "" }],
    ["notes replaced", { body: "totally different notes" }],
    [
      "notes with text appended",
      { body: "signed release notes\nplus a malicious link" },
    ],
    ["empty notes", { body: "" }],
  ]) {
    const result = runDraftCheck(() => {}, options);
    assert.notStrictEqual(result.status, 0, label);
    assert.match(result.output, /Refusing to publish/, label);
  }
});

test("draft check (real shell, fake gh): harmless storage differences in the notes (CRLF, trailing newlines) do not cause false alarms", () => {
  for (const body of [
    "signed release notes\r",
    "signed release notes\r\n\r\n",
    "signed release notes\n\n\n",
  ]) {
    const result = runDraftCheck(() => {}, { body });
    assert.strictEqual(
      result.status,
      0,
      JSON.stringify(body) + "\n" + result.output,
    );
  }
});

test("the draft check compares the same asset set that is uploaded", () => {
  const create =
    publish.steps[runsMatching(publish.steps, /gh release create/)].run;
  const uploaded = [
    ...create.matchAll(/^\s+"?dist\/([^"\s\\]+)"?\s*\\?$/gm),
  ].map((m) => m[1]);
  const listed = [
    ...draftStep.run.matchAll(
      /^\s+"?(RELEASE_NOTES\.md(?:\.sigstore\.json)?|\$\{name\}[^"\s]*|SHA256SUMS[^"\s]*)"?$/gm,
    ),
  ].map((m) => m[1]);
  assert.strictEqual(uploaded.length, 10);
  assert.deepStrictEqual([...listed].sort(), [...uploaded].sort());
});

test("the immutability requirement is its own final step; the published-release check no longer carries it", () => {
  const published = stepNamed(publish.steps, PUBLISHED_CHECK);
  const immutable = stepNamed(publish.steps, IMMUTABLE_CHECK);
  assert.strictEqual(immutable, publish.steps.length - 1, "last step");
  assert.ok(published < immutable);
  assert.ok(!/gh release verify/.test(publish.steps[published].run));
  assert.deepStrictEqual(publish.steps[immutable].env, {
    EXPECTED_RELEASE_ID: "${{ steps.draft.outputs.release-id }}",
    RELEASE_IMMUTABILITY: "not-required",
  });
  // The ONLY failure that is turned into a message is the informational lookup
  // in the not-required branch; nothing in the release path swallows an error.
  assert.strictEqual(
    (runText(publish.steps).match(/\|\|\s*echo/g) ?? []).length,
    1,
  );
  assert.match(
    publish.steps[immutable].run,
    /not-required\)\s+state="\$\(gh api .*releases\/\$\{EXPECTED_RELEASE_ID\}.*\|\| echo unknown\)"/,
  );
});

test("the immutability check uses the release's own `isImmutable` flag AND GitHub's release attestation, with bounded retries", () => {
  const script = publish.steps[stepNamed(publish.steps, IMMUTABLE_CHECK)].run;
  assert.match(
    script,
    /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/releases\/\$\{EXPECTED_RELEASE_ID\}" --jq \.immutable/,
  );
  assert.match(
    script,
    /\[ "\$immutable" != "true" \]/,
    "only the exact string true passes",
  );
  assert.match(script, /gh release verify "\$RELEASE_TAG"/);
  assert.match(script, /attempts=6/);
  assert.match(script, /sleep "\$\{RETRY_DELAY:-10\}"/);
});

// A fake `gh` for the immutability step. The release-ID API read answers
// FAKE_IMMUTABLE (or fails); `verify` fails its first FAKE_VERIFY_FAILS calls,
// counting in ./counter.
const IMMUTABLE_GH = [
  'case "$*" in',
  '  *"releases/123"*)',
  '    [ -z "$FAKE_VIEW_FAIL" ] || exit 1',
  `    printf '%s\\n' "$FAKE_IMMUTABLE" ;;`,
  '  "release verify"*)',
  '    n=$(cat counter 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > counter',
  '    [ "$n" -gt "$FAKE_VERIFY_FAILS" ] ;;',
  "  *) exit 9 ;;",
  "esac",
].join("\n");

function runImmutable({
  policy: declared,
  immutable = "true",
  verifyFails = 0,
  viewFails = false,
}) {
  return runStep(publish.steps[stepNamed(publish.steps, IMMUTABLE_CHECK)], {
    gh: IMMUTABLE_GH,
    env: {
      RELEASE_IMMUTABILITY: declared,
      EXPECTED_RELEASE_ID: "123",
      FAKE_IMMUTABLE: immutable,
      FAKE_VERIFY_FAILS: String(verifyFails),
      FAKE_VIEW_FAIL: viewFails ? "1" : "",
      RETRY_DELAY: "0",
    },
  });
}
const verifyCalls = (r) =>
  r.calls.filter((call) => call.startsWith("release verify")).length;

test("immutability (real shell, fake gh): `required` passes only for a release that GitHub reports as immutable AND whose attestation verifies", () => {
  const ok = runImmutable({ policy: "required" });
  assert.strictEqual(ok.status, 0, ok.output);
  assert.match(
    ok.output,
    /is immutable and its GitHub release attestation verifies/,
  );
  assert.deepStrictEqual(ok.calls, [
    "api repos/fossasia/cla-bot/releases/123 --jq .immutable",
    "release verify v1.2.3",
  ]);

  for (const [label, options] of [
    ["isImmutable false", { immutable: "false" }],
    ["isImmutable empty", { immutable: "" }],
    ["isImmutable null", { immutable: "null" }],
    ["isImmutable TRUE (wrong case)", { immutable: "TRUE" }],
    ["the lookup itself fails", { viewFails: true }],
  ]) {
    const r = runImmutable({ policy: "required", ...options });
    assert.notStrictEqual(r.status, 0, label);
    assert.strictEqual(
      verifyCalls(r),
      0,
      `${label}: the attestation is not even consulted`,
    );
  }
  const mutable = runImmutable({ policy: "required", immutable: "false" });
  assert.match(
    mutable.output,
    /::error::.*NOT immutable \(isImmutable=false\)/,
  );
  assert.match(mutable.output, /workflow policy requires immutable releases/);
});

test("immutability (real shell, fake gh): the release attestation may take a moment (retried), but never passes without verifying", () => {
  const eventually = runImmutable({ policy: "required", verifyFails: 2 });
  assert.strictEqual(eventually.status, 0, eventually.output);
  assert.strictEqual(verifyCalls(eventually), 3);

  const lastChance = runImmutable({ policy: "required", verifyFails: 5 });
  assert.strictEqual(lastChance.status, 0, "the sixth attempt still counts");
  assert.strictEqual(verifyCalls(lastChance), 6);

  const never = runImmutable({ policy: "required", verifyFails: 99 });
  assert.strictEqual(never.status, 1);
  assert.strictEqual(verifyCalls(never), 6, "bounded: exactly six attempts");
  assert.match(
    never.output,
    /attestation could not be verified after 6 attempts/,
  );
});

test("immutability (real shell, fake gh): the workflow's `not-required` policy is visible and an invalid policy fails", () => {
  const optOut = runImmutable({ policy: "not-required", immutable: "false" });
  assert.strictEqual(optOut.status, 0, optOut.output);
  assert.match(
    optOut.output,
    /::notice::.*Mutable releases are allowed.*isImmutable=false/,
  );
  assert.strictEqual(verifyCalls(optOut), 0);
  const lookupFails = runImmutable({ policy: "not-required", viewFails: true });
  assert.strictEqual(
    lookupFails.status,
    0,
    "an informational lookup never fails the opt-out",
  );
  assert.match(lookupFails.output, /isImmutable=unknown/);

  for (const declared of [
    undefined,
    "",
    "yes",
    "Required",
    "true",
    "not required",
  ]) {
    const r = runImmutable({ policy: declared });
    assert.strictEqual(r.status, 1, `policy=${JSON.stringify(declared)}`);
    assert.match(r.output, /must be required or not-required/);
    assert.deepStrictEqual(r.calls, [], "gh is never called");
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
  // Compare the flag's whole value, never a substring of a URL.
  const predicateTypes = commands
    .map((c) => /--predicate-type "([^"]*)"/.exec(c)?.[1])
    .filter((value) => value !== undefined);
  assert.deepStrictEqual(predicateTypes, [
    "https://cyclonedx.org/bom",
    "https://cyclonedx.org/bom",
  ]);
  assert.strictEqual(
    commands.filter((command) => command.includes(".provenance.intoto.jsonl")).length,
    2,
    "provenance uses the persisted bundle both before and after publication",
  );
  assert.strictEqual(
    commands.filter((command) => command.includes(".sbom.intoto.jsonl")).length,
    2,
    "SBOM attestation uses the persisted bundle both before and after publication",
  );
});

test("consumer verification pins the resolved tag commit to both attestations and reuses that SHA", () => {
  const security = read("SECURITY.md");
  assert.match(security, /SOURCE_SHA=.*git ls-remote/);
  assert.strictEqual((security.match(/--source-digest "\$SOURCE_SHA"/g) ?? []).length, 2);
  assert.match(security, /pin the exact `SOURCE_SHA` used above/);
  assert.match(security, /not a freshly resolved tag/);
  const example = read("examples", "consumer-workflow.yml");
  assert.ok(example.includes("resolved ONCE during the"));
  assert.ok(example.includes("verification procedure in SECURITY.md"));
  assert.match(example, /Do not resolve the tag again/);
});

// --- the release policy gate (runs before anything is built) -----------------------

test("mutable releases are the reviewed policy in preflight, publish, Latest and the security docs", () => {
  assert.deepStrictEqual(policy.env, {
    GH_TOKEN: "${{ github.token }}",
    RELEASE_IMMUTABILITY: "not-required",
    RELEASE_APPROVAL: "${{ vars.RELEASE_APPROVAL }}",
  });
  assert.strictEqual(publish.steps[stepNamed(publish.steps, IMMUTABLE_CHECK)].env.RELEASE_IMMUTABILITY, "not-required");
  assert.strictEqual(verifyLatest.env.RELEASE_IMMUTABILITY, "not-required");
  assert.match(read("CONTRIBUTING.md"), /Mutability is intentionally `not-required`/);
  assert.match(read("SECURITY.md"), /reviewed `not-required` policy does not fail for mutable releases/);
  assert.match(read("SECURITY.md"), /Release notes, the source archive and the SBOM\s+each have a direct Cosign signature/);
  assert.match(read("SECURITY.md"), /Mutable metadata such as the title\s+is not signed/);
});

test("release setup documentation describes the exact environment policy the workflow enforces", () => {
  const contributing = read("CONTRIBUTING.md");
  assert.match(contributing, /Selected\s+branches and tags/);
  assert.match(contributing, /exactly one rule: tag pattern `v\*`/);
  assert.match(contributing, /no branch\s+rules and no additional patterns/);
  assert.match(contributing, /complete paginated rules list/);
});

test("policy (real shell): the immutability policy must be declared as `required` or `not-required`, otherwise nothing is built", () => {
  const step = policy.steps[stepNamed(policy.steps, POLICY_IMMUTABILITY)];
  const required = runStep(step, { env: { RELEASE_IMMUTABILITY: "required" } });
  assert.strictEqual(required.status, 0, required.output);
  assert.match(required.output, /declared as enabled/);
  const optOut = runStep(step, {
    env: { RELEASE_IMMUTABILITY: "not-required" },
  });
  assert.strictEqual(optOut.status, 0, optOut.output);
  assert.match(optOut.output, /::warning::.*NOT required/);
  for (const declared of [
    undefined,
    "",
    "yes",
    "Required",
    "REQUIRED",
    "true",
    "not required",
  ]) {
    const r = runStep(step, { env: { RELEASE_IMMUTABILITY: declared } });
    assert.strictEqual(r.status, 1, `policy=${JSON.stringify(declared)}`);
    assert.match(r.output, /Nothing has been built or published/);
  }
});

const releaseEnvironment = ({
  reviewers = 1,
  preventSelfReview = true,
  deploymentBranchPolicy = {
    protected_branches: false,
    custom_branch_policies: true,
  },
} = {}) => ({
  protection_rules: reviewers === 0
    ? []
    : [{
        type: "required_reviewers",
        reviewers: Array.from({ length: reviewers }, (_, id) => ({
          type: "User",
          reviewer: { login: `reviewer-${id}`, id },
        })),
        prevent_self_review: preventSelfReview,
      }],
  deployment_branch_policy: deploymentBranchPolicy,
});
const deploymentPolicies = (...branchPolicies) => ({
  total_count: branchPolicies.length,
  branch_policies: branchPolicies,
});
const releasePolicyGh = [
  'case "$*" in',
  '  *"deployment-branch-policies"*) printf "%s\\n" "$FAKE_DEPLOYMENT_POLICIES" ;;',
  '  *"environments/release"*) printf "%s\\n" "$FAKE_RELEASE_ENVIRONMENT" ;;',
  '  *) exit 9 ;;',
  'esac',
].join("\n");
const validReleasePolicy = {
  gh: releasePolicyGh,
  env: {
    FAKE_RELEASE_ENVIRONMENT: JSON.stringify(releaseEnvironment()),
    FAKE_DEPLOYMENT_POLICIES: JSON.stringify(
      deploymentPolicies({ name: "v*", type: "tag" }),
    ),
  },
};

test("policy (real shell, fake gh): unset RELEASE_APPROVAL requires reviewers and the exact release tag policy", () => {
  const step = policy.steps[stepNamed(policy.steps, POLICY_REVIEWERS)];
  const ok = runStep(step, { ...validReleasePolicy });
  assert.strictEqual(ok.status, 0, ok.output);
  assert.match(
    ok.calls[0],
    /^api repos\/fossasia\/cla-bot\/environments\/release$/,
  );
  assert.match(ok.calls[1], /--paginate repos\/fossasia\/cla-bot\/environments\/release\/deployment-branch-policies\?per_page=100/);
  assert.match(ok.output, /Verified the 'release' environment deployment restriction: tag v\*/);
  assert.ok(
    !/::notice::/.test(ok.output),
    "self-review is off, nothing to point out",
  );

  const selfReview = runStep(step, {
    ...validReleasePolicy,
    env: {
      ...validReleasePolicy.env,
      FAKE_RELEASE_ENVIRONMENT: JSON.stringify(
        releaseEnvironment({ reviewers: 3, preventSelfReview: false }),
      ),
    },
  });
  assert.strictEqual(selfReview.status, 0, selfReview.output);
  assert.match(selfReview.output, /::notice::.*allows self-review/);

  const noReviewers = runStep(step, {
    ...validReleasePolicy,
    env: {
      ...validReleasePolicy.env,
      FAKE_RELEASE_ENVIRONMENT: JSON.stringify(releaseEnvironment({ reviewers: 0 })),
    },
  });
  assert.strictEqual(noReviewers.status, 1, noReviewers.output);
  assert.match(noReviewers.output, /has no required reviewers/);

  const malformedReviewers = runStep(step, {
    ...validReleasePolicy,
    env: {
      ...validReleasePolicy.env,
      FAKE_RELEASE_ENVIRONMENT: JSON.stringify({
        protection_rules: [{ type: "required_reviewers", reviewers: "unexpected" }],
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      }),
    },
  });
  assert.strictEqual(malformedReviewers.status, 1);
  assert.match(malformedReviewers.output, /Could not parse the 'release' environment approval rules/);

  const unreadable = runStep(step, { gh: "exit 1" });
  assert.strictEqual(unreadable.status, 1);
  assert.match(unreadable.output, /Could not read the 'release' environment/);
});

test("policy (real shell, fake gh): `not-required` must match an environment with no reviewers", () => {
  const step = policy.steps[stepNamed(policy.steps, POLICY_REVIEWERS)];
  const optOut = runStep(step, {
    ...validReleasePolicy,
    env: { ...validReleasePolicy.env, RELEASE_APPROVAL: "not-required",
      FAKE_RELEASE_ENVIRONMENT: JSON.stringify(releaseEnvironment({ reviewers: 0 })) },
  });
  assert.strictEqual(optOut.status, 0, optOut.output);
  assert.match(optOut.output, /No required reviewers are configured/);
  assert.strictEqual(optOut.calls.length, 2, "inspect environment and deployment rules");

  const conflict = runStep(step, {
    ...validReleasePolicy,
    env: { ...validReleasePolicy.env, RELEASE_APPROVAL: "not-required",
      FAKE_RELEASE_ENVIRONMENT: JSON.stringify(releaseEnvironment({ reviewers: 2, preventSelfReview: false })) },
  });
  assert.strictEqual(conflict.status, 1, conflict.output);
  assert.match(conflict.output, /conflicts with the 'release' environment/);
  assert.strictEqual(conflict.calls.length, 1);
  for (const value of ["yes", "true", "Not-Required", "none", "required"]) {
    const r = runStep(step, {
      ...validReleasePolicy,
      env: { RELEASE_APPROVAL: value },
    });
    assert.strictEqual(r.status, 1, value);
    assert.match(r.output, /RELEASE_APPROVAL must be unset or not-required/);
    assert.deepStrictEqual(r.calls, [], "invalid value never reaches the API");
  }
  // An EMPTY variable behaves as unset: the check is enforced.
  const empty = runStep(step, {
    ...validReleasePolicy,
    env: { ...validReleasePolicy.env, RELEASE_APPROVAL: "",
      FAKE_RELEASE_ENVIRONMENT: JSON.stringify(releaseEnvironment({ reviewers: 0 })) },
  });
  assert.strictEqual(empty.status, 1);
});

test("release environment deployment policy fails closed for absent, broad, branch, extra, or malformed restrictions", () => {
  const step = policy.steps[stepNamed(policy.steps, POLICY_REVIEWERS)];
  const cases = [
    ["no custom policy mode", releaseEnvironment({ deploymentBranchPolicy: null }), deploymentPolicies({ name: "v*", type: "tag" })],
    ["protected branches enabled", releaseEnvironment({ deploymentBranchPolicy: { protected_branches: true, custom_branch_policies: true } }), deploymentPolicies({ name: "v*", type: "tag" })],
    ["custom policies disabled", releaseEnvironment({ deploymentBranchPolicy: { protected_branches: false, custom_branch_policies: false } }), deploymentPolicies({ name: "v*", type: "tag" })],
    ["no rules", releaseEnvironment(), deploymentPolicies()],
    ["branch rule", releaseEnvironment(), deploymentPolicies({ name: "v*", type: "branch" })],
    ["broad tag rule", releaseEnvironment(), deploymentPolicies({ name: "*", type: "tag" })],
    ["different tag pattern", releaseEnvironment(), deploymentPolicies({ name: "v[0-9]*", type: "tag" })],
    ["additional branch rule", releaseEnvironment(), deploymentPolicies({ name: "v*", type: "tag" }, { name: "main", type: "branch" })],
    ["missing policy type", releaseEnvironment(), deploymentPolicies({ name: "v*" })],
  ];
  for (const [label, environment, policies] of cases) {
    const result = runStep(step, {
      ...validReleasePolicy,
      env: {
        ...validReleasePolicy.env,
        FAKE_RELEASE_ENVIRONMENT: JSON.stringify(environment),
        FAKE_DEPLOYMENT_POLICIES: JSON.stringify(policies),
      },
    });
    assert.strictEqual(result.status, 1, `${label}: ${result.output}`);
    assert.match(result.output, /::error::/);
    assert.strictEqual(
      result.calls.length,
      label === "no custom policy mode" || label === "protected branches enabled" || label === "custom policies disabled" ? 1 : 2,
      `${label}: stop at the invalid environment mode, otherwise read both configuration endpoints`,
    );
  }
});

test("release environment policy rejects failed, malformed, and incomplete paginated policy reads", () => {
  const step = policy.steps[stepNamed(policy.steps, POLICY_REVIEWERS)];
  const failure = runStep(step, {
    ...validReleasePolicy,
    gh: [
      'case "$*" in',
      '  *"deployment-branch-policies"*) exit 1 ;;',
      '  *"environments/release"*) printf "%s\\n" "$FAKE_RELEASE_ENVIRONMENT" ;;',
      '  *) exit 9 ;;',
      'esac',
    ].join("\n"),
  });
  assert.strictEqual(failure.status, 1);
  assert.match(failure.output, /exactly one deployment policy/);

  for (const invalid of ["not-json", JSON.stringify({ total_count: 2, branch_policies: [{ name: "v*", type: "tag" }] })]) {
    const result = runStep(step, {
      ...validReleasePolicy,
      env: { ...validReleasePolicy.env, FAKE_DEPLOYMENT_POLICIES: invalid },
    });
    assert.strictEqual(result.status, 1, invalid);
    assert.match(result.output, /exactly one deployment policy/);
  }

  const malformedEnvironment = runStep(step, {
    ...validReleasePolicy,
    env: { ...validReleasePolicy.env, FAKE_RELEASE_ENVIRONMENT: "not-json" },
  });
  assert.strictEqual(malformedEnvironment.status, 1);
  assert.match(malformedEnvironment.output, /Could not parse the 'release' environment approval rules/);
});

// --- the jq programs that ship in the workflow ---------------------------------------
//
// The fake `gh` in the tests above never evaluates `--jq`, but the real one does.
// These are the programs exactly as written in the workflow, run through a real
// jq (or gojq, which is what `gh` embeds) on payloads shaped like GitHub's.

const JQ = ["jq", "gojq"].find(
  (bin) =>
    spawnSync(bin, ["-r", ".x"], {
      input: '{"x":1}',
      encoding: "utf8",
      timeout: 3000,
    }).status === 0,
);
function jqProgram(job, stepName, anchor) {
  const step = job.steps[stepNamed(job.steps, stepName)];
  const match = new RegExp(`${escapeRegExp(anchor)}[^\n]*--jq '([^']*)'`).exec(
    step.run,
  );
  assert.ok(match, `no --jq program after ${anchor} in "${stepName}"`);
  return match[1];
}
function localJqProgram(job, stepName, assignment) {
  const step = job.steps[stepNamed(job.steps, stepName)];
  const match = /summary="\$\(jq -er '([\s\S]*?)' <<< "\$environment"\)"/.exec(step.run);
  assert.ok(match, `no local jq program assigned to ${assignment} in "${stepName}"`);
  return match[1];
}
function evalJq(program, payload) {
  const r = spawnSync(JQ, ["-r", program], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 3000,
  });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.replace(/\n$/, "");
}

test("the jq programs that ship in the workflow answer correctly on GitHub-shaped payloads (real jq/gojq, when installed)", () => {
  if (!JQ)
    return console.log(
      "  (skipped: neither jq nor gojq is installed on this machine)",
    );
  const reviewers = localJqProgram(policy, POLICY_REVIEWERS, "summary");
  const user = { type: "User", reviewer: { login: "octo", id: 1 } };
  for (const [label, payload, want] of [
    [
      "two reviewers, self-review blocked",
      {
        protection_rules: [
          { type: "wait_timer" },
          {
            type: "required_reviewers",
            prevent_self_review: true,
            reviewers: [user, user],
          },
        ],
      },
      "2 true",
    ],
    [
      "one reviewer, self-review allowed",
      {
        protection_rules: [
          {
            type: "required_reviewers",
            prevent_self_review: false,
            reviewers: [user],
          },
        ],
      },
      "1 false",
    ],
    [
      "no protection rules",
      { name: "release", protection_rules: [] },
      "0 false",
    ],
    ["protection_rules absent", { name: "release" }, "0 false"],
    [
      "only a wait timer",
      { protection_rules: [{ type: "wait_timer" }] },
      "0 false",
    ],
    [
      "required_reviewers with an empty list",
      {
        protection_rules: [
          {
            type: "required_reviewers",
            prevent_self_review: true,
            reviewers: [],
          },
        ],
      },
      "0 true",
    ],
  ]) {
    assert.strictEqual(evalJq(reviewers, payload), want, label);
  }
  const malformedReviewer = spawnSync(JQ, ["-r", reviewers], {
    input: JSON.stringify({
      protection_rules: [{ type: "required_reviewers", prevent_self_review: true }],
    }),
    encoding: "utf8",
  });
  assert.notStrictEqual(malformedReviewer.status, 0, "malformed reviewer rule is rejected");

  const tagRef = jqProgram(
    publish,
    PUBLISH_STEP,
    'git/ref/tags/${RELEASE_TAG}"',
  );
  assert.strictEqual(
    evalJq(tagRef, { object: { type: "tag", sha: SHA_VERIFIED } }),
    `tag ${SHA_VERIFIED}`,
  );
  assert.strictEqual(
    evalJq(tagRef, { object: { type: "commit", sha: SHA_VERIFIED } }),
    `commit ${SHA_VERIFIED}`,
  );

  const draftMetaScript = publish.steps[stepNamed(publish.steps, DRAFT_CHECK)].run;
  const metaMatch = /meta="\$\(jq -r '([^']+)' <<< "\$release_json"\)"/.exec(
    draftMetaScript,
  );
  assert.ok(metaMatch, "draft metadata must be extracted from the release-ID response");
  const meta = metaMatch[1];
  assert.strictEqual(
    evalJq(meta, {
      id: 123,
      name: "v1.2.3",
      tag_name: "v1.2.3",
      draft: true,
      prerelease: false,
    }),
    "123 v1.2.3 v1.2.3 true false",
  );
  assert.strictEqual(
    evalJq(meta, {
      id: 123,
      name: "v1.2.3",
      tag_name: "v1.2.3",
      draft: true,
      prerelease: true,
    }),
    "123 v1.2.3 v1.2.3 true true",
  );
});

// --- digests between jobs (real shell) ----------------------------------------------

const sha256hex = (buffer) =>
  crypto.createHash("sha256").update(buffer).digest("hex");
const DIGEST_NAME = "cla-bot-v1.2.3";

// Runs the publish job's digest step over a dist/ built to match the digests
// the two jobs would have reported (computed here independently, in JS).
function runDigestStep({ tamper = () => {}, expected = {} } = {}) {
  const notes = Buffer.from("release notes\n");
  const archive = Buffer.from("pretend tarball bytes");
  const sbom = Buffer.from('{"bomFormat":"CycloneDX"}\n');
  const sourceDigest = sha256hex(
    Buffer.from(
      `${sha256hex(notes)}  dist/RELEASE_NOTES.md\n${sha256hex(archive)}  dist/${DIGEST_NAME}.tar.gz\n`,
    ),
  );
  const files = {
    "RELEASE_NOTES.md": notes,
    [`${DIGEST_NAME}.tar.gz`]: archive,
    [`${DIGEST_NAME}.sbom.cdx.json`]: sbom,
  };
  const result = runStep(sign.steps[stepNamed(sign.steps, DIGEST_STEP)], {
    env: {
      EXPECTED_SOURCE_DIGEST: expected.source ?? sourceDigest,
      EXPECTED_SBOM_DIGEST: expected.sbom ?? sha256hex(sbom),
    },
    setup: (dir) => {
      const dist = path.join(dir, "dist");
      fs.mkdirSync(dist);
      for (const [file, content] of Object.entries(files))
        fs.writeFileSync(path.join(dist, file), content);
      tamper(dist);
    },
    after: (dir) => {
      const sums = path.join(dir, "dist", "SHA256SUMS");
      return fs.existsSync(sums) ? fs.readFileSync(sums, "utf8") : null;
    },
  });
  return {
    ...result,
    expectedSums: `${sha256hex(notes)}  RELEASE_NOTES.md\n${sha256hex(archive)}  ${DIGEST_NAME}.tar.gz\n${sha256hex(sbom)}  ${DIGEST_NAME}.sbom.cdx.json\n`,
  };
}

test("digest step (real shell): untouched files pass and SHA256SUMS covers notes, archive, and SBOM", () => {
  if (!HAS_SHA256SUM)
    return console.log("  (skipped: sha256sum not available on this machine)");
  const r = runDigestStep();
  assert.strictEqual(r.status, 0, r.output);
  assert.strictEqual(r.extra, r.expectedSums);
});

test("digest step (real shell): any altered, missing, extra or mismatching file stops the release before SHA256SUMS exists", () => {
  if (!HAS_SHA256SUM)
    return console.log("  (skipped: sha256sum not available on this machine)");
  const zeros = "0".repeat(64);
  for (const [label, options] of [
    [
      "archive altered",
      {
        tamper: (dist) =>
          fs.appendFileSync(path.join(dist, `${DIGEST_NAME}.tar.gz`), "x"),
      },
    ],
    [
      "notes altered",
      {
        tamper: (dist) =>
          fs.appendFileSync(path.join(dist, "RELEASE_NOTES.md"), "evil link\n"),
      },
    ],
    [
      "SBOM altered",
      {
        tamper: (dist) =>
          fs.writeFileSync(
            path.join(dist, `${DIGEST_NAME}.sbom.cdx.json`),
            "{}",
          ),
      },
    ],
    [
      "archive missing",
      { tamper: (dist) => fs.rmSync(path.join(dist, `${DIGEST_NAME}.tar.gz`)) },
    ],
    [
      "SBOM missing",
      {
        tamper: (dist) =>
          fs.rmSync(path.join(dist, `${DIGEST_NAME}.sbom.cdx.json`)),
      },
    ],
    [
      "extra file",
      {
        tamper: (dist) =>
          fs.writeFileSync(path.join(dist, "backdoor.sh"), "#!/bin/sh"),
      },
    ],
    [
      "extra file replacing a real one",
      {
        tamper: (dist) =>
          fs.renameSync(
            path.join(dist, "RELEASE_NOTES.md"),
            path.join(dist, "other.md"),
          ),
      },
    ],
    [
      "source digest reported by build is wrong",
      { expected: { source: zeros } },
    ],
    ["SBOM digest reported by checks is wrong", { expected: { sbom: zeros } }],
    ["source digest missing", { expected: { source: "" } }],
    ["SBOM digest missing", { expected: { sbom: "" } }],
  ]) {
    const r = runDigestStep(options);
    assert.notStrictEqual(r.status, 0, label);
    assert.match(r.output, /Refusing to sign/, label);
    assert.strictEqual(
      r.extra,
      null,
      `${label}: SHA256SUMS must not be written`,
    );
  }
});

const SIGNED_ARTIFACT_FILES = [
  "RELEASE_NOTES.md",
  "RELEASE_NOTES.md.sigstore.json",
  `${DIGEST_NAME}.tar.gz`,
  `${DIGEST_NAME}.tar.gz.sigstore.json`,
  `${DIGEST_NAME}.sbom.cdx.json`,
  `${DIGEST_NAME}.sbom.cdx.json.sigstore.json`,
  `${DIGEST_NAME}.provenance.intoto.jsonl`,
  `${DIGEST_NAME}.sbom.intoto.jsonl`,
  "SHA256SUMS",
  "SHA256SUMS.sigstore.json",
];

function runSignedArtifactCheck({ tamper = () => {}, mismatch = false } = {}) {
  const content = new Map(
    SIGNED_ARTIFACT_FILES.map((name) => [name, Buffer.from(`verified ${name}\n`)]),
  );
  const digestInput = SIGNED_ARTIFACT_FILES.map(
    (name) => `${sha256hex(content.get(name))}  ${name}\n`,
  ).join("");
  const expected = sha256hex(Buffer.from(digestInput));
  return runStep(
    publish.steps[
      stepNamed(publish.steps, "Verify the signed artifact digest before publishing")
    ],
    {
      env: { EXPECTED_SIGNED_DIGEST: mismatch ? "0".repeat(64) : expected },
      setup: (dir) => {
        const dist = path.join(dir, "dist");
        fs.mkdirSync(dist);
        for (const [name, bytes] of content)
          fs.writeFileSync(path.join(dist, name), bytes);
        tamper(dist);
      },
    },
  );
}

test("publisher accepts only the complete, unchanged signed artifact reported by the signing job", () => {
  if (!HAS_SHA256SUM)
    return console.log("  (skipped: sha256sum not available on this machine)");
  const valid = runSignedArtifactCheck();
  assert.strictEqual(valid.status, 0, valid.output);

  for (const [label, options] of [
    ["artifact digest output is missing or wrong", { mismatch: true }],
    ["a signed file changed in transit", {
      tamper: (dist) => fs.appendFileSync(path.join(dist, "SHA256SUMS"), "tampered\n"),
    }],
    ["an extra file appeared in transit", {
      tamper: (dist) => fs.writeFileSync(path.join(dist, "unexpected"), "extra"),
    }],
    ["a symlink appeared in transit", {
      tamper: (dist) => fs.symlinkSync("SHA256SUMS", path.join(dist, "unexpected-link")),
    }],
  ]) {
    const result = runSignedArtifactCheck(options);
    assert.notStrictEqual(result.status, 0, label);
    assert.match(result.output, /Refusing to publish/);
  }
});

// --- assets, docs, Scorecard -----------------------------------------------------------

const ASSET_SUFFIXES = [
  ".tar.gz",
  ".tar.gz.sigstore.json",
  ".sbom.cdx.json",
  ".sbom.cdx.json.sigstore.json",
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
      "dist/RELEASE_NOTES.md",
      "dist/RELEASE_NOTES.md.sigstore.json",
      // "${name}" is the shell variable the step defines: cla-bot-${RELEASE_TAG}
      ...ASSET_SUFFIXES.map((suffix) => "dist/${name}" + suffix),
      "dist/SHA256SUMS",
      "dist/SHA256SUMS.sigstore.json",
    ].sort(),
  );
  assert.ok(uploaded.some((f) => f.endsWith(".sigstore.json")));
  assert.ok(uploaded.some((f) => f.endsWith(".intoto.jsonl")));
  const signScript = runText(sign.steps);
  for (const payload of [
    "RELEASE_NOTES.md",
    "${name}.tar.gz",
    "${name}.sbom.cdx.json",
    "SHA256SUMS",
  ]) {
    assert.match(signScript, new RegExp(`cosign sign-blob[^\\n]*${escapeRegExp(payload)}`));
  }
  for (const payload of [
    "RELEASE_NOTES.md",
    "${name}.tar.gz",
    "${name}.sbom.cdx.json",
    "SHA256SUMS",
  ]) {
    assert.match(signScript, new RegExp(`cosign verify-blob[\\s\\S]*?${escapeRegExp(payload)}`));
  }
});

test("SECURITY.md documents every released asset and the commands that verify them", () => {
  const security = read("SECURITY.md");
  assert.match(security, /^## Verifying a release$/m);
  for (const suffix of [
    ...ASSET_SUFFIXES,
    "RELEASE_NOTES.md",
    "RELEASE_NOTES.md.sigstore.json",
    "cla-bot-<tag>.sbom.cdx.json.sigstore.json",
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
    "covers those three payloads",
    "release body differs from the signed RELEASE_NOTES.md asset",
    "cla-bot-<tag>.sbom.cdx.json.sigstore.json",
  ]) {
    assert.ok(security.includes(needle), `SECURITY.md is missing: ${needle}`);
  }
});

test("the release notes footer link points at an anchor that exists in SECURITY.md", () => {
  const script = read(".github", "scripts", "release-check.js");
  assert.match(script, /SECURITY\.md#verifying-a-release/);
  assert.match(script, /Release payloads are individually signed or attested/);
  assert.doesNotMatch(script, /Every asset is signed/);
  assert.match(read("SECURITY.md"), /^## Verifying a release$/m);
});

test("CONTRIBUTING.md documents the release procedure, the one-time setup and failure recovery", () => {
  const contributing = read("CONTRIBUTING.md");
  for (const needle of [
    "git tag -s",
    "git push origin vX.Y.Z",
    "Immutable releases",
    "`release` environment",
    "RELEASE_NOTES.md",
    "SHA256SUMS` manifest covering all",
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

// --- release tag ruleset --------------------------------------------------------------------

test("the release tag ruleset lets writers create versions but blocks moving/deleting them", () => {
  const dir = path.join(ROOT, ".github", "rulesets");
  const rulesets = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  assert.deepStrictEqual(rulesets, ["main.json", "release-tags.json"]);
  assert.strictEqual(
    readJson(".github", "rulesets", "main.json").target,
    "branch",
  );
  assert.deepStrictEqual(
    readJson(".github", "rulesets", "main.json").bypass_actors,
    [],
  );
  const releaseTags = readJson(".github", "rulesets", "release-tags.json");
  assert.strictEqual(releaseTags.target, "tag");
  assert.strictEqual(releaseTags.enforcement, "active");
  assert.deepStrictEqual(releaseTags.bypass_actors, []);
  assert.deepStrictEqual(releaseTags.conditions.ref_name.include, ["refs/tags/v*"]);
  assert.deepStrictEqual(
    releaseTags.rules.map((rule) => rule.type).sort(),
    ["deletion", "update"],
  );
  assert.ok(!releaseTags.rules.some((rule) => rule.type === "creation"));
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
