"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const script = path.join(ROOT, ".github/scripts/verify-release-candidate.sh");
const tag = "v1.2.3";
const archiveName = `cla-bot-${tag}.tar.gz`;

function candidate({ extra = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-candidate-"));
  const bin = path.join(dir, "bin");
  const assets = path.join(dir, "assets");
  fs.mkdirSync(bin);
  fs.mkdirSync(assets);
  const assetNames = [
    archiveName,
    `${archiveName}.sigstore.json`,
    `cla-bot-${tag}.sbom.cdx.json`,
    `cla-bot-${tag}.provenance.intoto.jsonl`,
    `cla-bot-${tag}.sbom.intoto.jsonl`,
    "SHA256SUMS",
    "SHA256SUMS.sigstore.json",
  ];
  for (const name of assetNames.filter((asset) => asset !== "SHA256SUMS")) {
    fs.writeFileSync(path.join(assets, name), `fixture:${name}\n`);
  }
  const sbom = `cla-bot-${tag}.sbom.cdx.json`;
  const archiveHash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(assets, archiveName)))
    .digest("hex");
  const sbomHash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(assets, sbom)))
    .digest("hex");
  fs.writeFileSync(
    path.join(assets, "SHA256SUMS"),
    `${archiveHash}  ${archiveName}\n${sbomHash}  ${sbom}\n`,
  );
  if (extra) fs.writeFileSync(path.join(assets, "unexpected.txt"), "extra\n");

  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!/bin/bash
set -e
case "$*" in
  *"version"*) echo "gh version $FAKE_GH_VERSION (2026-10-01)" ;;
  *"release view"*) echo '${tag} ${tag} false false '$FAKE_IMMUTABLE ;;
  *"release verify"*) [ "$FAKE_GH_RELEASE_VERIFY" = pass ] || { echo 'release verification failed' >&2; exit 1; } ;;
  *"releases/tags/"*)
    if [ "$FAKE_EXTRA" = true ]; then
      echo '["${archiveName}","${archiveName}.sigstore.json","cla-bot-${tag}.sbom.cdx.json","cla-bot-${tag}.provenance.intoto.jsonl","cla-bot-${tag}.sbom.intoto.jsonl","SHA256SUMS","SHA256SUMS.sigstore.json","unexpected.txt"]' | jq -c sort
    else
      echo '["${archiveName}","${archiveName}.sigstore.json","cla-bot-${tag}.sbom.cdx.json","cla-bot-${tag}.provenance.intoto.jsonl","cla-bot-${tag}.sbom.intoto.jsonl","SHA256SUMS","SHA256SUMS.sigstore.json"]' | jq -c sort
    fi
    ;;
  *"git/ref/tags/"*) echo '{"object":{"type":"tag","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}' ;;
  *"git/tags/"*) printf '{"tag":"${tag}","object":{"type":"commit","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"verification":{"verified":%s}}\\n' "$FAKE_VERIFIED" ;;
  *"branches/main"*) echo '{"commit":{"sha":"cccccccccccccccccccccccccccccccccccccccc"}}' ;;
  *"compare/"*) printf '%s\\n' "$FAKE_COMPARE" ;;
  *"release download"*)
    while [ "$#" -gt 0 ]; do if [ "$1" = --dir ]; then dest="$2"; shift 2; else shift; fi; done
    cp "$FAKE_ASSETS"/* "$dest"/
    ;;
  *"attestation verify"*) [ "$FAKE_ATTESTATION" = pass ] || { echo 'attestation failed' >&2; exit 1; } ;;
  *) echo "unexpected gh call: $*" >&2; exit 98 ;;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "cosign"),
    '#!/bin/bash\n[ "${FAKE_COSIGN:-pass}" = pass ] || { echo "signature failed" >&2; exit 1; }\n',
    { mode: 0o755 },
  );

  function run(overrides = {}) {
    const result = spawnSync("bash", [script], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        RELEASE_TAG: tag,
        GITHUB_REPOSITORY: "fossasia/cla-bot",
        DEFAULT_BRANCH: "main",
        GH_TOKEN: "test-token",
        FAKE_ASSETS: assets,
        FAKE_GH_VERSION: "2.102.0",
        FAKE_VERIFIED: "true",
        FAKE_COMPARE: "ahead",
        FAKE_ATTESTATION: "pass",
        FAKE_IMMUTABLE: "false",
        FAKE_GH_RELEASE_VERIFY: "pass",
        FAKE_EXTRA: "false",
        RELEASE_IMMUTABILITY: "not-required",
        ...overrides,
      },
    });
    return { status: result.status, output: result.stdout + result.stderr };
  }

  return { run, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }), assets };
}

const valid = candidate();
try {
  const result = valid.run();
  assert.strictEqual(result.status, 0, result.output);
  assert.match(result.output, /is a verified release from/);

  const oldCli = valid.run({ FAKE_GH_VERSION: "2.101.99" });
  assert.notStrictEqual(oldCli.status, 0);
  assert.match(oldCli.output, /require 2\.102\.0 or newer/);

  const immutableRequired = valid.run({
    RELEASE_IMMUTABILITY: "required",
    FAKE_IMMUTABLE: "false",
  });
  assert.notStrictEqual(immutableRequired.status, 0);
  assert.match(immutableRequired.output, /metadata is not public, stable/);

  const immutableRelease = valid.run({
    RELEASE_IMMUTABILITY: "required",
    FAKE_IMMUTABLE: "true",
  });
  assert.strictEqual(immutableRelease.status, 0, immutableRelease.output);

  const unverifiableImmutableRelease = valid.run({
    RELEASE_IMMUTABILITY: "required",
    FAKE_IMMUTABLE: "true",
    FAKE_GH_RELEASE_VERIFY: "fail",
  });
  assert.notStrictEqual(unverifiableImmutableRelease.status, 0);
  assert.match(unverifiableImmutableRelease.output, /release verification failed/);

  for (const [name, overrides, message] of [
    ["unsigned tag", { FAKE_VERIFIED: "false" }, /GitHub-verified signed tag/],
    ["non-ancestor commit", { FAKE_COMPARE: "behind" }, /not an ancestor/],
    ["bad asset signature", { FAKE_COSIGN: "fail" }, /Command failed|failed/],
    ["invalid attestation", { FAKE_ATTESTATION: "fail" }, /Command failed|failed/],
  ]) {
    const failed = valid.run(overrides);
    assert.notStrictEqual(failed.status, 0, name);
    assert.match(failed.output, message, name);
  }

  const extra = candidate({ extra: true });
  try {
    const failed = extra.run({ FAKE_EXTRA: "true" });
    assert.notStrictEqual(failed.status, 0);
    assert.match(failed.output, /missing or unexpected release asset/);
  } finally {
    extra.cleanup();
  }

  fs.appendFileSync(path.join(valid.assets, archiveName), "tampered\n");
  const badDigest = valid.run();
  assert.notStrictEqual(badDigest.status, 0);
  assert.match(badDigest.output, /FAILED/);

  fs.appendFileSync(path.join(valid.assets, "SHA256SUMS"), "broken\n");
  const badChecksums = valid.run();
  assert.notStrictEqual(badChecksums.status, 0);
} finally {
  valid.cleanup();
}

console.log("PASS: release-candidate verification accepts valid provenance and rejects invalid tags, ancestry, assets, checksums, signatures and attestations");
