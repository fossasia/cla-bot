"use strict";
/**
 * Offline guard for the "one required check, no required review" setup.
 * Branch protection only requires the single job `Required checks pass`
 * from ci.yml, and nothing else - no CODEOWNERS, no approval count. This
 * file is what stops that gate from silently rotting or silently growing a
 * review requirement nobody decided on:
 *
 *  - the gate fans in EVERY other job of ci.yml (a new job that is not in
 *    `needs:` would be unprotected), always runs, and nothing it needs can
 *    be skipped (GitHub treats a skipped required check as passing);
 *  - every reusable workflow in .github/workflows is actually called from
 *    ci.yml, and every called file exists and is reusable;
 *  - the called workflows have no triggers of their own (they would run
 *    twice) and no `concurrency:` (a group built from `github.workflow`
 *    deadlocks against the caller's and GitHub cancels the run);
 *  - coverage-comment.yml still listens to the workflow that now carries
 *    the coverage artifact;
 *  - any `astral-sh/setup-uv` step (zizmor.yml) pins an exact uv version
 *    plus its SHA-256 and disables the cache, so a compromised uv release
 *    cannot silently alter a required check;
 *  - the ruleset-as-code requires exactly the gate's check name and
 *    nothing else, and does NOT require any approvals or code-owner
 *    review - this repository's deliberate choice (see
 *    .github/rulesets/README.md, "Branch protection has exactly one
 *    required condition"). If a future change wants that trade-off back,
 *    it should update this test and the README alongside main.json, not
 *    drift silently.
 *
 * Run: node test/ci-gate.test.js (also part of `npm test`).
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const ROOT = path.join(__dirname, "..");
const WORKFLOWS = path.join(ROOT, ".github", "workflows");
const GATE_JOB = "required-checks-pass";
const GATE_CHECK_NAME = "Required checks pass";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

const readYaml = (file) => yaml.load(fs.readFileSync(file, "utf8"));
// YAML 1.1 parsers turn the bare key `on` into boolean true; accept both.
const triggersOf = (doc) => doc.on ?? doc[true] ?? {};
const triggerNames = (doc) => {
  const on = triggersOf(doc);
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on;
  return Object.keys(on);
};

const ci = readYaml(path.join(WORKFLOWS, "ci.yml"));
const ciJobs = ci.jobs;
const gate = ciJobs[GATE_JOB];
const otherJobIds = Object.keys(ciJobs).filter((id) => id !== GATE_JOB);

const workflowFiles = fs
  .readdirSync(WORKFLOWS)
  .filter((f) => /\.ya?ml$/.test(f));
const reusableFiles = workflowFiles.filter((f) =>
  triggerNames(readYaml(path.join(WORKFLOWS, f))).includes("workflow_call"),
);
const calledFiles = Object.values(ciJobs)
  .filter((job) => typeof job.uses === "string")
  .map((job) => job.uses);

const readRuleset = () =>
  JSON.parse(
    fs.readFileSync(
      path.join(ROOT, ".github", "rulesets", "main.json"),
      "utf8",
    ),
  );

test("the gate job exists, has the exact check name the ruleset requires, and holds no permissions", () => {
  assert.ok(gate, `ci.yml must define a job with id "${GATE_JOB}"`);
  assert.strictEqual(gate.name, GATE_CHECK_NAME);
  assert.deepStrictEqual(gate.permissions, {});
});

test("the gate always runs (otherwise a failed dependency makes it SKIPPED, which GitHub counts as passing)", () => {
  const condition = String(gate.if ?? "").replace(/\s+/g, "");
  assert.ok(
    condition === "always()" || condition === "${{always()}}",
    `gate "if" must be exactly always(), got: ${JSON.stringify(gate.if)}`,
  );
});

test("the gate needs EVERY other job in ci.yml, no more and no less", () => {
  const needs = [].concat(gate.needs ?? []);
  assert.deepStrictEqual([...needs].sort(), [...otherJobIds].sort());
});

test("no job the gate depends on is conditional (a skipped job fails the gate by design)", () => {
  for (const id of otherJobIds) {
    assert.strictEqual(
      ciJobs[id].if,
      undefined,
      `job "${id}" has an "if:"; a skipped job fails the gate`,
    );
  }
});

test("the gate treats anything but `success` as a failure and reads needs through an env var", () => {
  const step = gate.steps.find((s) => typeof s.run === "string");
  assert.ok(step, "gate needs a run step");
  assert.match(step.run, /\.result == "success"/);
  assert.ok(step.env && /toJSON\(needs\)/.test(step.env.NEEDS_JSON));
  assert.ok(
    !/\$\{\{/.test(step.run),
    "no ${{ }} expression may be interpolated into the gate's shell script",
  );
});

test("every `uses: ./.github/workflows/x.yml` in ci.yml points at an existing reusable workflow", () => {
  assert.ok(calledFiles.length > 0, "ci.yml should call the check workflows");
  for (const uses of calledFiles) {
    // "./" today; "$/" (GitHub's self-repository syntax) is accepted too so
    // switching once actionlint supports it needs no test change.
    assert.match(uses, /^(\.|\$)\/\.github\/workflows\/[\w.-]+\.ya?ml$/, uses);
    const file = path.join(ROOT, uses.slice(2));
    assert.ok(fs.existsSync(file), `${uses} does not exist`);
    assert.ok(
      triggerNames(readYaml(file)).includes("workflow_call"),
      `${uses} must declare on.workflow_call`,
    );
  }
});

test("every reusable workflow is called from ci.yml (a check nobody calls is not enforced)", () => {
  const called = new Set(calledFiles.map((u) => path.basename(u)));
  for (const f of reusableFiles) {
    assert.ok(called.has(f), `${f} is reusable but ci.yml never calls it`);
  }
});

test("called workflows have no triggers of their own beyond workflow_call/workflow_dispatch", () => {
  for (const f of reusableFiles) {
    const extra = triggerNames(readYaml(path.join(WORKFLOWS, f))).filter(
      (t) => t !== "workflow_call" && t !== "workflow_dispatch",
    );
    assert.deepStrictEqual(
      extra,
      [],
      `${f} has extra triggers ${extra} - the check would run twice`,
    );
  }
});

test("called workflows declare no concurrency (github.workflow is the CALLER's name there and deadlocks)", () => {
  for (const f of reusableFiles) {
    const doc = readYaml(path.join(WORKFLOWS, f));
    assert.strictEqual(doc.concurrency, undefined, `${f}: workflow-level`);
    for (const [id, job] of Object.entries(doc.jobs)) {
      assert.strictEqual(job.concurrency, undefined, `${f}: job ${id}`);
    }
  }
});

test("only ci.yml carries a concurrency group among workflows that run the checks", () => {
  assert.ok(ci.concurrency && ci.concurrency.group);
});

test("scorecard.yml and coverage-comment.yml are intentionally outside the gate and must not be reusable", () => {
  for (const f of ["scorecard.yml", "coverage-comment.yml"]) {
    assert.ok(
      !reusableFiles.includes(f),
      `${f} must stay a standalone workflow`,
    );
  }
});

test("coverage-comment.yml listens to the workflow that now owns the coverage artifact", () => {
  const doc = readYaml(path.join(WORKFLOWS, "coverage-comment.yml"));
  assert.deepStrictEqual(triggersOf(doc).workflow_run.workflows, [ci.name]);
});

test("the ruleset requires exactly the gate's check name, pinned to GitHub Actions, and nothing else", () => {
  const ruleset = readRuleset();
  const rule = ruleset.rules.find((r) => r.type === "required_status_checks");
  assert.ok(rule, "ruleset must contain a required_status_checks rule");
  assert.deepStrictEqual(
    rule.parameters.required_status_checks.map((c) => c.context),
    [GATE_CHECK_NAME],
  );
  for (const c of rule.parameters.required_status_checks) {
    assert.strictEqual(
      c.integration_id,
      15368,
      "pin to the GitHub Actions app",
    );
  }
});

test("the ruleset requires a pull request (blocks direct pushes) but NO approvals and NO code-owner review", () => {
  const ruleset = readRuleset();
  const pr = ruleset.rules.find((r) => r.type === "pull_request");
  assert.ok(
    pr,
    "ruleset must contain a pull_request rule (it also blocks direct pushes)",
  );
  assert.strictEqual(
    pr.parameters.required_approving_review_count,
    0,
    "this repository merges on CI alone - no required approvals",
  );
  assert.strictEqual(
    pr.parameters.require_code_owner_review,
    false,
    "this repository deliberately does not use CODEOWNERS/code-owner review - see .github/rulesets/README.md",
  );
  assert.deepStrictEqual(
    ruleset.bypass_actors,
    [],
    "nobody may bypass the gate, not even admins",
  );
});

test("no CODEOWNERS file is shipped (an unused one invites someone to half-enable review later by accident)", () => {
  const codeowners = path.join(ROOT, ".github", "CODEOWNERS");
  if (fs.existsSync(codeowners)) {
    const body = fs.readFileSync(codeowners, "utf8").trim();
    assert.strictEqual(
      body,
      "",
      "CODEOWNERS must stay empty/absent: this repository does not require code-owner review (see .github/rulesets/README.md)",
    );
  }
});

test("every setup-uv step pins an exact uv version AND its SHA-256 (no unverified `latest` uv in a required check)", () => {
  let found = 0;
  for (const file of workflowFiles) {
    const doc = readYaml(path.join(WORKFLOWS, file));
    for (const [jobId, job] of Object.entries(doc.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (
          typeof step.uses !== "string" ||
          !step.uses.startsWith("astral-sh/setup-uv@")
        ) {
          continue;
        }
        found += 1;
        const where = `${file} > ${jobId} > ${step.name ?? step.uses}`;
        const w = step.with ?? {};
        assert.match(
          String(w.version ?? ""),
          /^\d+\.\d+\.\d+$/,
          `${where}: \`version\` must be an exact uv release (not unset, \`latest\` or a range): setup-uv only verifies checksums for versions it knows`,
        );
        assert.match(
          String(w.checksum ?? ""),
          /^[0-9a-f]{64}$/,
          `${where}: \`checksum\` must be the lowercase SHA-256 of the uv release archive so a tampered download fails closed`,
        );
        assert.strictEqual(
          w["enable-cache"],
          false,
          `${where}: \`enable-cache\` must be false (a restored cache must not influence a security check)`,
        );
      }
    }
  }
  assert.ok(
    found > 0,
    "expected zizmor.yml to install uv via astral-sh/setup-uv",
  );
});

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
