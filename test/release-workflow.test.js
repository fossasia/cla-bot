"use strict";
/**
 * Offline guard for the signed-release pipeline (.github/workflows/release.yml,
 * and the docs consumers rely on). Nothing here runs the
 * workflow - it pins the properties that make the pipeline trustworthy, so a
 * later edit cannot quietly undo one:
 *
 *  - it only runs for pushed stable-semver tags (never a PR, branch or manual
 *    trigger), serialised and never cancelled, with an explicit max queue;
 *  - least privilege: workflow permissions are empty; `policy`, `build` and
 *    `checks` can only READ; only `publish` can sign/attest/write, and
 *    `publish` runs no repository or third-party code (no checkout, no
 *    node/npm), waits on the `release` environment, and re-checks the digests
 *    `build` and `checks` reported;
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
const { policy, build, checks, publish } = wf.jobs;
const triggers = wf.on ?? wf[true];
const allSteps = [
  ...policy.steps,
  ...build.steps,
  ...checks.steps,
  ...publish.steps,
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
const POLICY_REVIEWERS = "Require reviewers on the release environment";
const IMMUTABLE_CHECK = "Require the release to be immutable";
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
      extra: after(dir),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
// A fake `gh` that answers every call with one line.
const ghAnswers = (text) => `printf '%s\\n' '${text}'`;
const HAS_SHA256SUM = spawnSync("sha256sum", ["--version"]).status === 0;

// --- triggers and top-level hygiene -------------------------------------------

test("release.yml has exactly four jobs: policy, build, checks, publish, and is not a reusable workflow", () => {
  assert.deepStrictEqual(Object.keys(wf.jobs).sort(), [
    "build",
    "checks",
    "policy",
    "publish",
  ]);
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

test("release runs serialize without silently replacing pending runs", () => {
  assert.strictEqual(wf.concurrency.group, "release");
  assert.strictEqual(wf.concurrency.queue, "max");
  assert.strictEqual(wf.concurrency["cancel-in-progress"], false);
});

test("both source artifacts are retained for the maximum public-repository window", () => {
  const uploads = allSteps.filter(
    (step) => String(step.uses ?? "").startsWith("actions/upload-artifact@"),
  );
  assert.strictEqual(uploads.length, 2);
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
    '  *"--json name,tagName,isDraft,isPrerelease,isLatest"*) printf "%s\\n" "$FAKE_META" ;;',
    '  *"--json body"*) printf "%s\\n" "$FAKE_BODY" ;;',
    '  *) exit 99 ;;',
    "esac",
  ].join("\n");
  const metadata = runStep(step, {
    gh,
    env: {
      FAKE_META: "v1.2.3 v1.2.3 false false false",
      FAKE_BODY: "notes",
    },
  });
  assert.notStrictEqual(metadata.status, 0);
  assert.match(metadata.output, /expected the named release to be published, stable and latest/);
  assert.strictEqual(metadata.calls.length, 1, "must stop before touching assets");

  const notes = runStep(step, {
    gh,
    env: {
      FAKE_META: "v1.2.3 v1.2.3 false false true",
      FAKE_BODY: "altered notes",
    },
    setup: (dir) => {
      fs.mkdirSync(path.join(dir, "dist"));
      fs.writeFileSync(path.join(dir, "dist", "RELEASE_NOTES.md"), "verified notes\n");
    },
  });
  assert.notStrictEqual(notes.status, 0);
  assert.match(notes.output, /release notes differ from the verified notes/);
  assert.strictEqual(notes.calls.length, 2, "must stop before touching assets");
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
});

test("publish holds exactly the three permissions signing and publishing need", () => {
  assert.deepStrictEqual(publish.permissions, {
    contents: "write",
    "id-token": "write",
    attestations: "write",
  });
});

test("job graph: policy first; build and checks wait for it; publish needs BOTH build and checks", () => {
  assert.strictEqual(policy.needs, undefined);
  assert.strictEqual(build.needs, "policy");
  assert.strictEqual(checks.needs, "policy");
  assert.deepStrictEqual(publish.needs, ["build", "checks"]);
});

test("publish runs in the `release` environment, and the policy job reads that same environment", () => {
  assert.strictEqual(publish.environment.name, "release");
  assert.match(runText(policy.steps), /environments\/release"/);
});

test("publish executes no repository or third-party code: no checkout, no node/npm, no scripts from the tagged tree", () => {
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

test("publish verifies BOTH job-output digests and rejects stray files before signing, and is the only job that writes SHA256SUMS", () => {
  assert.match(
    build.outputs["source-digest"],
    /steps\.archive\.outputs\.source-digest/,
  );
  assert.match(
    checks.outputs["sbom-digest"],
    /steps\.sbom\.outputs\.sbom-digest/,
  );
  const idx = stepNamed(publish.steps, DIGEST_STEP);
  const step = publish.steps[idx];
  assert.strictEqual(
    step.env.EXPECTED_SOURCE_DIGEST,
    "${{ needs.build.outputs.source-digest }}",
  );
  assert.strictEqual(
    step.env.EXPECTED_SBOM_DIGEST,
    "${{ needs.checks.outputs.sbom-digest }}",
  );
  const downloads = publish.steps
    .map((s, i) =>
      String(s.uses ?? "").startsWith("actions/download-artifact@") ? i : -1,
    )
    .filter((i) => i >= 0);
  assert.strictEqual(downloads.length, 2);
  assert.ok(Math.max(...downloads) < idx, "downloads precede the digest check");
  assert.ok(idx < usesStartingWith(publish.steps, "actions/attest@"));
  assert.ok(
    idx < usesStartingWith(publish.steps, "sigstore/cosign-installer@"),
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
    /sha256sum "\$\{name\}\.tar\.gz" "\$\{name\}\.sbom\.cdx\.json" > SHA256SUMS/,
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

test("checkouts keep no credentials (build needs full history); every setup-node has caching disabled", () => {
  for (const job of [build, checks]) {
    const checkout =
      job.steps[usesStartingWith(job.steps, "actions/checkout@")];
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
  for (const job of [policy, build, publish]) {
    assert.ok(!/\bnpm\b/.test(runText(job.steps)));
  }
});

// --- order of operations --------------------------------------------------------------

test("publish: downloads, verifies digests, signs, self-verifies, drafts, checks the draft, re-checks the tag AND publishes, verifies the public copy, then requires immutability", () => {
  const steps = publish.steps;
  const order = [
    usesStartingWith(steps, "actions/download-artifact@"),
    stepNamed(steps, DIGEST_STEP),
    usesStartingWith(steps, "sigstore/cosign-installer@"),
    indexOfStep(steps, (s) => s.id === "provenance", "provenance attestation"),
    indexOfStep(steps, (s) => s.id === "sbom", "SBOM attestation"),
    runsMatching(steps, /cosign sign-blob/),
    runsMatching(steps, /cosign verify-blob[\s\S]*gh attestation verify/),
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
  const compareAt = script.indexOf('if [ -z "$EXPECTED_TAG_OBJECT"');
  const editAt = script.indexOf("gh release edit");
  assert.ok(
    checkAt >= 0 && checkAt < compareAt && compareAt < editAt,
    "look up, compare, then publish, in one script",
  );
  assert.strictEqual(script.match(/gh release edit/g).length, 1);
  assert.match(
    script,
    /gh release edit "\$RELEASE_TAG" --draft=false --latest/,
  );
  const between = script.slice(compareAt, editAt);
  assert.ok(
    !/\b(gh|git|curl|sleep|npm|node)\b/.test(between),
    "nothing else runs between the comparison and the publish call",
  );
});

test("after publishing, the tag is checked once more and the release is called compromised if it moved", () => {
  const finalStep =
    publish.steps[stepNamed(publish.steps, PUBLISHED_CHECK)].run;
  assert.match(finalStep, /git\/ref\/tags\/\$\{RELEASE_TAG\}/);
  assert.match(finalStep, /"tag \$\{EXPECTED_TAG_OBJECT\}"/);
  assert.match(finalStep, /compromised/);
});

test("re-check (real shell, fake gh): passes only while the tag still resolves to the verified tag object, and only then does the publish call happen", () => {
  for (const name of [CREATE_RECHECK, PUBLISH_STEP]) {
    const step = publish.steps[stepNamed(publish.steps, name)];
    const same = runStep(step, {
      gh: ghAnswers(`tag ${SHA_VERIFIED}`),
      env: { EXPECTED_TAG_OBJECT: SHA_VERIFIED },
    });
    assert.strictEqual(same.status, 0, `${name}\n${same.output}`);
    assert.match(
      same.calls[0],
      /^api repos\/fossasia\/cla-bot\/git\/ref\/tags\/v1\.2\.3 --jq /,
    );
    assert.deepStrictEqual(
      same.calls.filter((call) => call.startsWith("release edit")),
      name === PUBLISH_STEP
        ? ["release edit v1.2.3 --draft=false --latest"]
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
        gh: ghAnswers(current),
        env: { EXPECTED_TAG_OBJECT: SHA_VERIFIED },
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
      gh: ghAnswers("tag "),
      env: { EXPECTED_TAG_OBJECT: "" },
    });
    assert.notStrictEqual(
      noExpected.status,
      0,
      `${name}: empty EXPECTED_TAG_OBJECT must fail`,
    );
    const ghDown = runStep(step, {
      gh: "exit 1",
      env: { EXPECTED_TAG_OBJECT: SHA_VERIFIED },
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

const draftStep = publish.steps[stepNamed(publish.steps, DRAFT_CHECK)];
function runDraftCheck(
  mutate,
  { meta = "v1.2.3 v1.2.3 true false", body = "notes, never uploaded" } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "draft-check-"));
  try {
    const name = "cla-bot-v1.2.3";
    const assets = [
      `${name}.tar.gz`,
      `${name}.tar.gz.sigstore.json`,
      `${name}.sbom.cdx.json`,
      `${name}.provenance.intoto.jsonl`,
      `${name}.sbom.intoto.jsonl`,
      "SHA256SUMS",
      "SHA256SUMS.sigstore.json",
    ];
    fs.mkdirSync(path.join(dir, "dist"));
    fs.mkdirSync(path.join(dir, "served"));
    for (const asset of assets) {
      fs.writeFileSync(path.join(dir, "dist", asset), `content of ${asset}\n`);
      fs.writeFileSync(
        path.join(dir, "served", asset),
        `content of ${asset}\n`,
      );
    }
    fs.writeFileSync(
      path.join(dir, "dist", "RELEASE_NOTES.md"),
      "notes, never uploaded\n",
    );
    mutate({ served: path.join(dir, "served"), name });
    fs.mkdirSync(path.join(dir, "bin"));
    fs.writeFileSync(
      path.join(dir, "bin", "gh"),
      [
        "#!/bin/sh",
        'case "$1 $2" in',
        '  "release download") cp "$FAKE_DRAFT_DIR"/* "$5"/ ;;  # gh release download <tag> --dir <dir>',
        '  "release view")',
        '    case "$*" in',
        '      *"--json body"*) printf \'%s\\n\' "$FAKE_BODY" ;;',
        "      *) printf '%s\\n' \"$FAKE_META\" ;;",
        "    esac ;;",
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
        FAKE_META: meta,
        FAKE_BODY: body,
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
      "SHA256SUMS replaced",
      ({ served }) =>
        fs.writeFileSync(path.join(served, "SHA256SUMS"), "forged"),
    ],
    [
      "asset missing",
      ({ served }) => fs.rmSync(path.join(served, "SHA256SUMS.sigstore.json")),
    ],
    [
      "extra asset added",
      ({ served }) =>
        fs.writeFileSync(path.join(served, "backdoor.sh"), "#!/bin/sh"),
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
  for (const [label, mutate] of cases) {
    const result = runDraftCheck(mutate);
    assert.notStrictEqual(result.status, 0, label);
    assert.match(result.output, /Refusing to publish/, label);
  }
});

test("draft check (real shell, fake gh): changed title, tag, draft/pre-release flags or notes stop the release", () => {
  for (const [label, options] of [
    ["title changed", { meta: "v9.9.9 v1.2.3 true false" }],
    ["tag changed", { meta: "v1.2.3 v9.9.9 true false" }],
    ["no longer a draft", { meta: "v1.2.3 v1.2.3 false false" }],
    ["marked as a pre-release", { meta: "v1.2.3 v1.2.3 true true" }],
    ["extra metadata field", { meta: "v1.2.3 v1.2.3 true false extra" }],
    ["empty metadata", { meta: "" }],
    ["notes replaced", { body: "totally different notes" }],
    [
      "notes with text appended",
      { body: "notes, never uploaded\nplus a malicious link" },
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
    "notes, never uploaded\r",
    "notes, never uploaded\r\n\r\n",
    "notes, never uploaded\n\n\n",
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
      /^\s+"?(\$\{name\}[^"\s]*|SHA256SUMS[^"\s]*)"?$/gm,
    ),
  ].map((m) => m[1]);
  assert.strictEqual(uploaded.length, 7);
  assert.deepStrictEqual([...listed].sort(), [...uploaded].sort());
});

test("the immutability requirement is its own final step; the published-release check no longer carries it", () => {
  const published = stepNamed(publish.steps, PUBLISHED_CHECK);
  const immutable = stepNamed(publish.steps, IMMUTABLE_CHECK);
  assert.strictEqual(immutable, publish.steps.length - 1, "last step");
  assert.ok(published < immutable);
  assert.ok(!/gh release verify/.test(publish.steps[published].run));
  assert.deepStrictEqual(publish.steps[immutable].env, {
    RELEASE_IMMUTABILITY: "${{ vars.RELEASE_IMMUTABILITY }}",
  });
  // The ONLY failure that is turned into a message is the informational lookup
  // in the not-required branch; nothing in the release path swallows an error.
  assert.strictEqual(
    (runText(publish.steps).match(/\|\|\s*echo/g) ?? []).length,
    1,
  );
  assert.match(
    publish.steps[immutable].run,
    /not-required\)\s+state="\$\(gh release view .*\|\| echo unknown\)"/,
  );
});

test("the immutability check uses the release's own `isImmutable` flag AND GitHub's release attestation, with bounded retries", () => {
  const script = publish.steps[stepNamed(publish.steps, IMMUTABLE_CHECK)].run;
  assert.match(
    script,
    /gh release view "\$RELEASE_TAG" --json isImmutable --jq \.isImmutable/,
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

// A fake `gh` for the immutability step. `view` answers FAKE_IMMUTABLE (or fails);
// `verify` fails its first FAKE_VERIFY_FAILS calls, counting in ./counter.
const IMMUTABLE_GH = [
  'case "$1 $2" in',
  '  "release view")',
  '    [ -z "$FAKE_VIEW_FAIL" ] || exit 1',
  `    printf '%s\\n' "$FAKE_IMMUTABLE" ;;`,
  '  "release verify")',
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
    "release view v1.2.3 --json isImmutable --jq .isImmutable",
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
  assert.match(mutable.output, /RELEASE_IMMUTABILITY/);
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

test("immutability (real shell, fake gh): `not-required` is an explicit, visible opt-out; an undeclared or invalid policy fails", () => {
  const optOut = runImmutable({ policy: "not-required", immutable: "false" });
  assert.strictEqual(optOut.status, 0, optOut.output);
  assert.match(
    optOut.output,
    /::notice::.*not required here.*isImmutable=false/,
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

test("policy reads its declarations from repository variables, and only those", () => {
  assert.deepStrictEqual(policy.env, {
    GH_TOKEN: "${{ github.token }}",
    RELEASE_IMMUTABILITY: "${{ vars.RELEASE_IMMUTABILITY }}",
    RELEASE_APPROVAL: "${{ vars.RELEASE_APPROVAL }}",
  });
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

test("policy (real shell, fake gh): the `release` environment must have at least one required reviewer", () => {
  const step = policy.steps[stepNamed(policy.steps, POLICY_REVIEWERS)];
  const ok = runStep(step, { gh: ghAnswers("1 true") });
  assert.strictEqual(ok.status, 0, ok.output);
  assert.match(
    ok.calls[0],
    /^api repos\/fossasia\/cla-bot\/environments\/release --jq /,
  );
  assert.ok(
    !/::notice::/.test(ok.output),
    "self-review is off, nothing to point out",
  );

  const selfReview = runStep(step, { gh: ghAnswers("3 false") });
  assert.strictEqual(selfReview.status, 0, selfReview.output);
  assert.match(selfReview.output, /::notice::.*allows self-review/);

  for (const [label, answer] of [
    ["no reviewers", "0 false"],
    ["no reviewers, self-review off", "0 true"],
    ["empty answer", ""],
    ["a non-number", "garbage true"],
    ["a negative number", "-1 true"],
    ["a decimal", "1.5 true"],
    ["only whitespace", "   "],
  ]) {
    const r = runStep(step, { gh: ghAnswers(answer) });
    assert.notStrictEqual(r.status, 0, `${label} must NOT pass`);
    assert.match(r.output, /::error::/, label);
  }
  const unreadable = runStep(step, { gh: "exit 1" });
  assert.strictEqual(unreadable.status, 1);
  assert.match(unreadable.output, /Could not read the 'release' environment/);
});

test("policy (real shell, fake gh): `RELEASE_APPROVAL=not-required` is the only way to skip the reviewer check, and it is visible", () => {
  const step = policy.steps[stepNamed(policy.steps, POLICY_REVIEWERS)];
  const optOut = runStep(step, {
    gh: ghAnswers("0 false"),
    env: { RELEASE_APPROVAL: "not-required" },
  });
  assert.strictEqual(optOut.status, 0, optOut.output);
  assert.match(optOut.output, /::warning::.*No reviewer approval is required/);
  assert.deepStrictEqual(optOut.calls, [], "the environment is not even read");
  for (const value of ["yes", "true", "Not-Required", "none", "required"]) {
    const r = runStep(step, {
      gh: ghAnswers("5 true"),
      env: { RELEASE_APPROVAL: value },
    });
    assert.strictEqual(r.status, 1, value);
    assert.match(r.output, /RELEASE_APPROVAL must be unset or not-required/);
    assert.deepStrictEqual(
      r.calls,
      [],
      "an invalid value never reaches the API",
    );
  }
  // An EMPTY variable behaves as unset: the check is enforced.
  const empty = runStep(step, {
    gh: ghAnswers("0 false"),
    env: { RELEASE_APPROVAL: "" },
  });
  assert.strictEqual(empty.status, 1);
});

// --- the jq programs that ship in the workflow ---------------------------------------
//
// The fake `gh` in the tests above never evaluates `--jq`, but the real one does.
// These are the programs exactly as written in the workflow, run through a real
// jq (or gojq, which is what `gh` embeds) on payloads shaped like GitHub's.

const JQ = ["jq", "gojq"].find(
  (bin) => spawnSync(bin, ["--version"]).status === 0,
);
function jqProgram(job, stepName, anchor) {
  const step = job.steps[stepNamed(job.steps, stepName)];
  const match = new RegExp(`${escapeRegExp(anchor)}[^\n]*--jq '([^']*)'`).exec(
    step.run,
  );
  assert.ok(match, `no --jq program after ${anchor} in "${stepName}"`);
  return match[1];
}
function evalJq(program, payload) {
  const r = spawnSync(JQ, ["-r", program], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.replace(/\n$/, "");
}

test("the jq programs that ship in the workflow answer correctly on GitHub-shaped payloads (real jq/gojq, when installed)", () => {
  if (!JQ)
    return console.log(
      "  (skipped: neither jq nor gojq is installed on this machine)",
    );
  const reviewers = jqProgram(
    policy,
    POLICY_REVIEWERS,
    'environments/release"',
  );
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
    [
      "required_reviewers without a reviewers key",
      {
        protection_rules: [
          { type: "required_reviewers", prevent_self_review: true },
        ],
      },
      "0 true",
    ],
  ]) {
    assert.strictEqual(evalJq(reviewers, payload), want, label);
  }

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

  const meta = jqProgram(
    publish,
    DRAFT_CHECK,
    "--json name,tagName,isDraft,isPrerelease",
  );
  assert.strictEqual(
    evalJq(meta, {
      name: "v1.2.3",
      tagName: "v1.2.3",
      isDraft: true,
      isPrerelease: false,
    }),
    "v1.2.3 v1.2.3 true false",
  );
  assert.strictEqual(
    evalJq(meta, {
      name: "v1.2.3",
      tagName: "v1.2.3",
      isDraft: true,
      isPrerelease: true,
    }),
    "v1.2.3 v1.2.3 true true",
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
  const result = runStep(publish.steps[stepNamed(publish.steps, DIGEST_STEP)], {
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
    expectedSums: `${sha256hex(archive)}  ${DIGEST_NAME}.tar.gz\n${sha256hex(sbom)}  ${DIGEST_NAME}.sbom.cdx.json\n`,
  };
}

test("digest step (real shell): untouched files pass and SHA256SUMS is written over exactly the archive and the SBOM", () => {
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
