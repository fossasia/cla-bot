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

function candidate({ extra = false, body = "fixture:RELEASE_NOTES.md" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-candidate-"));
  const bin = path.join(dir, "bin");
  const assets = path.join(dir, "assets");
  fs.mkdirSync(bin);
  fs.mkdirSync(assets);
  const assetNames = [
    "RELEASE_NOTES.md",
    "RELEASE_NOTES.md.sigstore.json",
    archiveName,
    `${archiveName}.sigstore.json`,
    `cla-bot-${tag}.sbom.cdx.json`,
    `cla-bot-${tag}.sbom.cdx.json.sigstore.json`,
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
  const notesHash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(assets, "RELEASE_NOTES.md")))
    .digest("hex");
  fs.writeFileSync(
    path.join(assets, "SHA256SUMS"),
    `${notesHash}  RELEASE_NOTES.md\n${archiveHash}  ${archiveName}\n${sbomHash}  ${sbom}\n`,
  );
  if (extra) fs.writeFileSync(path.join(assets, "unexpected.txt"), "extra\n");
  const releaseAssetNames = extra ? [...assetNames, "unexpected.txt"] : assetNames;
  const releaseJson = path.join(dir, "release.json");
  fs.writeFileSync(
    releaseJson,
    JSON.stringify({
      id: 123,
      name: tag,
      tag_name: tag,
      draft: false,
      prerelease: false,
      immutable: false,
      body,
      assets: releaseAssetNames.map((name, index) => ({
        id: 100 + index,
        name,
        state: "uploaded",
      })),
    }),
  );

  fs.writeFileSync(
    path.join(bin, "gh"),
`#!/bin/bash
set -e
case "$*" in
  *"version"*) echo "gh version $FAKE_GH_VERSION (2026-10-01)" ;;
  *"release verify"*) [ "$FAKE_GH_RELEASE_VERIFY" = pass ] || { echo 'release verification failed' >&2; exit 1; } ;;
  *"releases/123"*) jq --argjson immutable "$FAKE_IMMUTABLE" '.immutable = $immutable' "$FAKE_RELEASE_JSON" ;;
  *"release download"*) echo 'tag lookup resolved to unrelated release 999' > "$FAKE_ASSETS/wrong-release-999" ;;
  *"releases/assets/"*)
    asset_id="\${2##*/}"
    asset_name="$(jq -er --argjson id "$asset_id" '.assets[] | select(.id == $id) | .name' "$FAKE_RELEASE_JSON")"
    cat "$FAKE_ASSETS/$asset_name"
    ;;
  *"git/ref/tags/"*) echo '{"object":{"type":"tag","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}' ;;
  *"git/tags/"*) printf '{"tag":"${tag}","object":{"type":"commit","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"verification":{"verified":%s}}\\n' "$FAKE_VERIFIED" ;;
  *"branches/main"*) echo '{"commit":{"sha":"cccccccccccccccccccccccccccccccccccccccc"}}' ;;
  *"compare/"*) printf '%s\\n' "$FAKE_COMPARE" ;;
  *"attestation verify"*) [ "$FAKE_ATTESTATION" = pass ] || { echo 'attestation failed' >&2; exit 1; } ;;
  *) echo "unexpected gh call: $*" >&2; exit 98 ;;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "cosign"),
    '#!/bin/bash\necho "$*" >> "$FAKE_COSIGN_LOG"\nif [ "${FAKE_COSIGN:-pass}" != pass ] || { [ -n "${FAKE_COSIGN_BAD_FILE:-}" ] && [[ "$*" == *"$FAKE_COSIGN_BAD_FILE"* ]]; }; then echo "signature failed" >&2; exit 1; fi\n',
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
        RELEASE_ID: "123",
        GITHUB_REPOSITORY: "fossasia/cla-bot",
        DEFAULT_BRANCH: "main",
        GH_TOKEN: "test-token",
        FAKE_ASSETS: assets,
        FAKE_COSIGN_LOG: path.join(dir, "cosign.log"),
        FAKE_RELEASE_JSON: releaseJson,
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
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      cosignCalls: fs.existsSync(path.join(dir, "cosign.log"))
        ? fs.readFileSync(path.join(dir, "cosign.log"), "utf8").trim().split("\n")
        : [],
    };
  }

  return { run, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }), assets };
}

const valid = candidate();
try {
  const result = valid.run();
  assert.strictEqual(result.status, 0, result.output);
  assert.match(result.output, /is a verified release from/);
  assert.deepStrictEqual(
    result.cosignCalls
      .filter((call) => call.startsWith("verify-blob"))
      .map((call) => path.basename(call.split(" ").at(-1))),
    [
      "RELEASE_NOTES.md",
      archiveName,
      `cla-bot-${tag}.sbom.cdx.json`,
      "SHA256SUMS",
    ],
  );

  const changedBody = candidate({ body: "unverified edited release body" });
  try {
    const failed = changedBody.run();
    assert.notStrictEqual(failed.status, 0);
    assert.match(failed.output, /release body differs from its signed RELEASE_NOTES.md asset/);
  } finally {
    changedBody.cleanup();
  }

  for (const value of [undefined, "", "unexpected"]) {
    const undeclaredPolicy = valid.run({ RELEASE_IMMUTABILITY: value });
    assert.notStrictEqual(undeclaredPolicy.status, 0, "policy must be explicit");
    assert.match(undeclaredPolicy.output, /must be explicitly set/);
  }

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

  for (const file of [
    "RELEASE_NOTES.md",
    archiveName,
    `cla-bot-${tag}.sbom.cdx.json`,
    "SHA256SUMS",
  ]) {
    const badSignature = valid.run({ FAKE_COSIGN_BAD_FILE: file });
    assert.notStrictEqual(badSignature.status, 0, `${file} signature must be checked`);
    assert.match(badSignature.output, /signature failed/, file);
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
