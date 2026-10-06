#!/usr/bin/env node
"use strict";
/**
 * Pre-flight checks and metadata generation for a signed release. Used by
 * .github/workflows/release.yml; has no dependencies beyond Node built-ins
 * (same rule as the action itself, see CONTRIBUTING.md).
 *
 *   node release-check.js verify --notes <file>
 *       Refuses to continue (exit 1) unless ALL of these hold:
 *         1. RELEASE_TAG is a strict stable semver tag: vMAJOR.MINOR.PATCH.
 *         2. package.json's "version" equals the tag without its "v".
 *         3. package.json has no runtime "dependencies". The SBOM below only
 *            describes the action's own `uses:` dependencies, so an npm
 *            runtime dependency would make it silently incomplete. Teach
 *            buildSbom about it before adding one (and see CONTRIBUTING.md).
 *         4. CHANGELOG.md has a non-empty "## [X.Y.Z]" section. It becomes
 *            the release notes, written to --notes.
 *         5. The tag is ANNOTATED, points at GITHUB_SHA (the commit being
 *            built), and GitHub reports its signature as verified.
 *       Check 5 ties a release to an identifiable person: anyone who can push
 *       a tag can start this workflow, but only the holder of a signing key
 *       registered on their GitHub account can push a *verified* one.
 *
 *   node release-check.js sbom --out <file>
 *       Writes a CycloneDX 1.6 SBOM listing what the action actually
 *       depends on at runtime: the third-party actions in action.yml, each
 *       pinned to a full commit SHA. An unpinned `uses:` fails the command,
 *       so a release can never ship a mutable dependency.
 *
 * Environment (set by the workflow, never interpolated into shell text):
 *   RELEASE_TAG        e.g. v1.2.3 (github.ref_name)
 *   GITHUB_SHA         commit the tag points at
 *   GITHUB_REPOSITORY  owner/name
 *   GH_TOKEN           read-only token, `verify` only
 *   SOURCE_DATE_ISO    optional, commit time for the SBOM (reproducible)
 *
 * Exit codes: 0 ok, 1 a check failed, 2 bad usage.
 */
const fs = require("fs");
const path = require("path");

// Strict semver without pre-release/build metadata, no leading zeros. Only
// stable releases are published; widening this means widening the
// workflow's tag filter and the docs together.
const TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const REPOSITORY_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const API_ROOT = "https://api.github.com";
const API_TIMEOUT_MS = 30_000;

const USAGE =
  "usage: release-check.js verify --notes <file> | release-check.js sbom --out <file>";

// Returns "X.Y.Z" for a valid tag, otherwise null.
function parseTag(tag) {
  const match = TAG_PATTERN.exec(String(tag));
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

// Body of the "## [X.Y.Z]" (optionally "- YYYY-MM-DD") section, or null if
// there is no such heading. `version` comes from parseTag, so it only holds
// digits and dots and is safe to put in a pattern.
function extractChangelogSection(changelog, version) {
  const escaped = version.replace(/\./g, "\\.");
  const heading = new RegExp(
    `^## \\[${escaped}\\](?: - \\d{4}-\\d{2}-\\d{2})?[ \\t]*$`,
    "m",
  );
  const match = heading.exec(changelog);
  if (!match) return null;
  const rest = changelog.slice(match.index + match[0].length);
  const next = /^## /m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

// Static consistency checks between the tag and the files it releases.
function findReleaseProblems({ tag, packageJson, changelog }) {
  const version = parseTag(tag);
  if (version === null) {
    return [
      `Tag "${tag}" is not a stable semver tag of the form vMAJOR.MINOR.PATCH (no leading zeros, no pre-release suffix).`,
    ];
  }
  const problems = [];
  if (packageJson.version !== version) {
    problems.push(
      `package.json version is "${packageJson.version}" but the tag is ${tag}; bump package.json before tagging.`,
    );
  }
  if (Object.keys(packageJson.dependencies ?? {}).length > 0) {
    problems.push(
      'package.json declares runtime "dependencies", which the release SBOM does not describe; extend buildSbom first.',
    );
  }
  const section = extractChangelogSection(changelog, version);
  if (section === null) {
    problems.push(`CHANGELOG.md has no "## [${version}]" heading.`);
  } else if (section === "") {
    problems.push(`CHANGELOG.md section "## [${version}]" is empty.`);
  }
  return problems;
}

// Asks GitHub (not git) about the tag, because GitHub is the one that checks
// the signature against the keys registered on the tagger's account.
async function verifyTagSignature({
  repository,
  tag,
  commit,
  token,
  fetchImpl = fetch,
}) {
  const api = async (apiPath) => {
    const res = await fetchImpl(`${API_ROOT}/repos/${repository}/${apiPath}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "fossasia-cla-bot-release-check",
      },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`GitHub API ${apiPath} returned HTTP ${res.status}`);
    }
    return res.json();
  };

  const ref = await api(`git/ref/tags/${tag}`);
  if (ref.object.type !== "tag") {
    return [
      `${tag} is a lightweight tag. Releases need a signed, annotated tag: git tag -s ${tag} -m "${tag}".`,
    ];
  }
  const annotated = await api(`git/tags/${ref.object.sha}`);
  const problems = [];
  if (annotated.object.type !== "commit" || annotated.object.sha !== commit) {
    problems.push(
      `${tag} does not point directly at the commit being released (${commit}).`,
    );
  }
  const verification = annotated.verification ?? {};
  if (verification.verified !== true) {
    problems.push(
      `GitHub does not report ${tag} as verified (reason: ${verification.reason ?? "unknown"}). Sign it with a key registered on your GitHub account.`,
    );
  }
  return problems;
}

// Third-party actions that action.yml runs, each as { name, ref, comment }.
// Throws if any is not pinned to a full commit SHA.
function listActionDependencies(actionYml) {
  const dependencies = [];
  // Matches the WHOLE line (`.*` swallows whatever follows the comment's
  // first word), so no `uses:` line can be skipped by an odd trailing
  // comment; a quoted or otherwise odd target then fails the pin check below
  // instead of being ignored.
  const usesLine =
    /^[ \t]*(?:-[ \t]+)?uses:[ \t]*(\S+)[ \t]*(?:#[ \t]*(\S+))?.*$/gm;
  for (const [, target, comment] of actionYml.matchAll(usesLine)) {
    if (target.startsWith("./")) continue; // local to this repo, not a dependency
    const [name, ref] = target.split("@");
    if (!name || !FULL_SHA_PATTERN.test(ref ?? "")) {
      throw new Error(
        `action.yml uses "${target}", which is not pinned to a full commit SHA; refusing to describe a mutable dependency.`,
      );
    }
    dependencies.push({ name, ref, comment });
  }
  return dependencies;
}

// package URL for a GitHub Action: pkg:githubactions/owner/repo@sha#subpath
function actionPurl({ name, ref }) {
  const [owner, repo, ...subpath] = name.toLowerCase().split("/");
  const base = `pkg:githubactions/${owner}/${repo}@${ref}`;
  return subpath.length > 0 ? `${base}#${subpath.join("/")}` : base;
}

function buildSbom({ packageJson, tag, repository, actionYml, timestamp }) {
  const rootRef = `pkg:github/${repository.toLowerCase()}@${tag}`;
  const components = listActionDependencies(actionYml).map((dep) => {
    const purl = actionPurl(dep);
    return {
      type: "library",
      "bom-ref": purl,
      name: dep.name,
      version: dep.comment ?? dep.ref,
      purl,
    };
  });
  const metadata = {
    component: {
      type: "application",
      "bom-ref": rootRef,
      name: packageJson.name,
      version: tag,
      purl: rootRef,
      licenses: [{ license: { id: packageJson.license } }],
      externalReferences: [
        { type: "vcs", url: `https://github.com/${repository}` },
      ],
    },
  };
  if (timestamp) metadata.timestamp = timestamp;
  return {
    $schema: "http://cyclonedx.org/schema/bom-1.6.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata,
    components,
    dependencies: [
      { ref: rootRef, dependsOn: components.map((c) => c["bom-ref"]) },
    ],
  };
}

function flagValue(argv, flag) {
  const i = argv.indexOf(flag);
  const value = i === -1 ? undefined : argv[i + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function missingEnv(env, names) {
  return names.filter((name) => !env[name]);
}

function readText(cwd, file) {
  return fs.readFileSync(path.join(cwd, file), "utf8");
}

const failures = (problems, stderr) => {
  for (const problem of problems) stderr(`::error::${problem}`);
  return 1;
};

async function runVerify({ argv, env, cwd, stdout, stderr, fetchImpl }) {
  const notesFile = flagValue(argv, "--notes");
  const missing = missingEnv(env, [
    "RELEASE_TAG",
    "GITHUB_SHA",
    "GITHUB_REPOSITORY",
    "GH_TOKEN",
  ]);
  if (!notesFile || missing.length > 0) {
    stderr(
      missing.length > 0
        ? `Missing environment: ${missing.join(", ")}. ${USAGE}`
        : USAGE,
    );
    return 2;
  }
  if (!REPOSITORY_PATTERN.test(env.GITHUB_REPOSITORY)) {
    stderr(`GITHUB_REPOSITORY "${env.GITHUB_REPOSITORY}" is not owner/name.`);
    return 2;
  }

  const tag = env.RELEASE_TAG;
  const changelog = readText(cwd, "CHANGELOG.md");
  const problems = findReleaseProblems({
    tag,
    packageJson: JSON.parse(readText(cwd, "package.json")),
    changelog,
  });
  if (problems.length > 0) return failures(problems, stderr);

  const signatureProblems = await verifyTagSignature({
    repository: env.GITHUB_REPOSITORY,
    tag,
    commit: env.GITHUB_SHA,
    token: env.GH_TOKEN,
    fetchImpl,
  });
  if (signatureProblems.length > 0) return failures(signatureProblems, stderr);

  const section = extractChangelogSection(changelog, parseTag(tag));
  const notes = `${section}\n\n---\n\nEvery asset is signed. Verify before use: https://github.com/${env.GITHUB_REPOSITORY}/blob/${tag}/SECURITY.md#verifying-a-release\n`;
  fs.writeFileSync(notesFile, notes);
  stdout(`${tag}: tag, version, changelog and tag signature all check out.`);
  return 0;
}

function runSbom({ argv, env, cwd, stdout, stderr }) {
  const outFile = flagValue(argv, "--out");
  const missing = missingEnv(env, ["RELEASE_TAG", "GITHUB_REPOSITORY"]);
  if (!outFile || missing.length > 0) {
    stderr(
      missing.length > 0
        ? `Missing environment: ${missing.join(", ")}. ${USAGE}`
        : USAGE,
    );
    return 2;
  }
  if (parseTag(env.RELEASE_TAG) === null) {
    return failures(
      [`Tag "${env.RELEASE_TAG}" is not vMAJOR.MINOR.PATCH.`],
      stderr,
    );
  }
  if (!REPOSITORY_PATTERN.test(env.GITHUB_REPOSITORY)) {
    stderr(`GITHUB_REPOSITORY "${env.GITHUB_REPOSITORY}" is not owner/name.`);
    return 2;
  }
  let sbom;
  try {
    sbom = buildSbom({
      packageJson: JSON.parse(readText(cwd, "package.json")),
      tag: env.RELEASE_TAG,
      repository: env.GITHUB_REPOSITORY,
      actionYml: readText(cwd, "action.yml"),
      timestamp: env.SOURCE_DATE_ISO,
    });
  } catch (error) {
    return failures([error.message], stderr);
  }
  fs.writeFileSync(outFile, `${JSON.stringify(sbom, null, 2)}\n`);
  stdout(
    `Wrote SBOM with ${sbom.components.length} component(s) to ${outFile}.`,
  );
  return 0;
}

async function main(
  argv,
  env,
  {
    cwd = process.cwd(),
    stdout = console.log,
    stderr = console.error,
    fetchImpl = fetch,
  } = {},
) {
  const io = { argv, env, cwd, stdout, stderr, fetchImpl };
  if (argv[0] === "verify") return runVerify(io);
  if (argv[0] === "sbom") return runSbom(io);
  stderr(USAGE);
  return 2;
}

if (require.main === module) {
  main(process.argv.slice(2), process.env).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`::error::${error.message}`);
      process.exitCode = 1;
    },
  );
}

module.exports = {
  parseTag,
  extractChangelogSection,
  findReleaseProblems,
  verifyTagSignature,
  listActionDependencies,
  actionPurl,
  buildSbom,
  main,
  TAG_PATTERN,
};
