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
 *         3. package.json declares no runtime dependencies of ANY kind
 *            (dependencies, optionalDependencies, peerDependencies,
 *            bundleDependencies / bundledDependencies). The SBOM below only
 *            describes the action's own `uses:` dependencies, so an npm
 *            dependency would make it silently incomplete. Teach buildSbom
 *            about it before adding one (and see CONTRIBUTING.md).
 *         4. CHANGELOG.md has a non-empty "## [X.Y.Z]" section. It becomes
 *            the release notes, written to --notes.
 *         5. The tag is ANNOTATED, the tag object's own name is the tag being
 *            released, it points at GITHUB_SHA (the commit being built), and
 *            GitHub reports its signature as verified.
 *       Check 5 ties a release to an identifiable person: anyone who can push
 *       a tag can start this workflow, but only the holder of a signing key
 *       registered on their GitHub account can push a *verified* one. The
 *       SHA of the verified tag OBJECT is written to $GITHUB_OUTPUT as
 *       `tag-object-sha`: a tag object is content-addressed (commit,
 *       signature and message), so the publish job re-checks that the tag
 *       still resolves to exactly that object right before it releases. That
 *       closes the gap between "verified at build time" and "released later".
 *
 *   node release-check.js sbom --out <file>
 *       Writes a CycloneDX 1.6 SBOM listing what the action actually
 *       depends on at runtime: the third-party actions in action.yml, each
 *       pinned to a full commit SHA. action.yml is PARSED as YAML and the
 *       `uses` of every entry of `runs.steps` is read, so no layout (flow
 *       style, value on the next line, quoting) can hide one, while a
 *       `uses` key that is merely data (an input or `with:` value named
 *       "uses") is correctly not a dependency. Only composite actions are
 *       modelled; anything else (a node/docker action, a local `./` action) is
 *       an error rather than an incomplete SBOM.
 *       An unpinned `uses:` fails the command, so a release can never ship
 *       a mutable dependency. `sbom` ALSO refuses npm dependencies itself,
 *       so its completeness never relies on `verify` having run first.
 *
 * Environment (set by the workflow, never interpolated into shell text):
 *   RELEASE_TAG        e.g. v1.2.3 (github.ref_name)
 *   GITHUB_SHA         commit the tag points at
 *   GITHUB_REPOSITORY  owner/name
 *   GH_TOKEN           read-only token, `verify` only
 *   GITHUB_OUTPUT      optional, file `verify` appends tag-object-sha to
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
const ACTION_NAME_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
// Every package.json field through which npm can pull code in at install or
// pack time. All must be empty for the SBOM to be complete.
const NPM_DEPENDENCY_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundleDependencies",
  "bundledDependencies",
];
const HEADING_SUFFIX = /^(?: - \d{4}-\d{2}-\d{2})?[ \t\r]*$/;
const API_ROOT = "https://api.github.com";
const API_TIMEOUT_MS = 30_000;

const USAGE =
  "usage: release-check.js verify --notes <file> | release-check.js sbom --out <file>";

// Returns "X.Y.Z" for a valid tag, otherwise null.
function parseTag(tag) {
  const match = TAG_PATTERN.exec(String(tag));
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

// For each line: is it OUTSIDE a fenced code block (``` or ~~~)? A "## ..."
// line inside a fence is code, not a heading, and must neither start nor end a
// section. Follows CommonMark: a fence closes on the same character with at
// least the opening length and nothing after it.
function linesOutsideFences(lines) {
  let fence = null;
  return lines.map((line) => {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (match && fence === null) {
      fence = { char: match[1][0], length: match[1].length };
      return false;
    }
    if (
      match &&
      match[1][0] === fence.char &&
      match[1].length >= fence.length &&
      match[2].trim() === ""
    ) {
      fence = null;
      return false;
    }
    return fence === null;
  });
}

// Body of the "## [X.Y.Z]" (optionally "- YYYY-MM-DD") section, or null if
// there is no such heading. The version is compared as a literal string, never
// compiled into a pattern, so there is nothing to escape. Headings inside code
// fences are ignored.
function extractChangelogSection(changelog, version) {
  const lines = changelog.split("\n");
  const outside = linesOutsideFences(lines);
  const prefix = `## [${version}]`;
  const start = lines.findIndex(
    (line, i) =>
      outside[i] &&
      line.startsWith(prefix) &&
      HEADING_SUFFIX.test(line.slice(prefix.length)),
  );
  if (start === -1) return null;
  const next = lines.findIndex(
    (line, i) => i > start && outside[i] && line.startsWith("## "),
  );
  return lines
    .slice(start + 1, next === -1 ? undefined : next)
    .join("\n")
    .trim();
}

// true when an npm dependency field names anything at all. Anything that is
// not clearly empty counts (fail closed): a non-empty object or array, `true`
// (bundleDependencies: true bundles everything), or an unexpected scalar.
function declaresDependencies(value) {
  if (value === undefined || value === null || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

// The package.json dependency fields that name anything (empty if none).
function npmDependencyFields(packageJson) {
  return NPM_DEPENDENCY_FIELDS.filter((field) =>
    declaresDependencies(packageJson[field]),
  );
}

function npmDependencyMessage(fields) {
  return `package.json declares npm dependencies (${fields.join(", ")}), which the release SBOM does not describe; extend buildSbom first.`;
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
  const declared = npmDependencyFields(packageJson);
  if (declared.length > 0) problems.push(npmDependencyMessage(declared));
  const section = extractChangelogSection(changelog, version);
  if (section === null) {
    problems.push(`CHANGELOG.md has no "## [${version}]" heading.`);
  } else if (section === "") {
    problems.push(`CHANGELOG.md section "## [${version}]" is empty.`);
  }
  return problems;
}

// Asks GitHub (not git) about the tag, because GitHub is the one that checks
// the signature against the keys registered on the tagger's account. Returns
// the problems found plus the SHA of the tag object that was inspected (absent
// for a lightweight tag), which the publish job later pins the tag to.
async function inspectTag({
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
    return {
      problems: [
        `${tag} is a lightweight tag. Releases need a signed, annotated tag: git tag -s ${tag} -m "${tag}".`,
      ],
    };
  }
  const annotated = await api(`git/tags/${ref.object.sha}`);
  const problems = [];
  // The signature covers the tag object's OWN name. Without this check, a
  // validly signed tag object for another version (v1.2.2) could be re-pointed
  // by a new ref (refs/tags/v1.2.3) and be released under the wrong version.
  if (annotated.tag !== tag) {
    problems.push(
      `The signed tag object is named "${annotated.tag}", not "${tag}". A signed tag for another version cannot be released under this name.`,
    );
  }
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
  return { problems, tagObjectSha: ref.object.sha };
}

async function verifyTagSignature(options) {
  return (await inspectTag(options)).problems;
}

// The steps of a composite action, validated. Only `runs.steps[*].uses` can
// make a composite action run someone else's code, so that is the whole
// dependency surface; a `uses` anywhere else (an input, a `with:` value) is
// data and must not be mistaken for a dependency.
function compositeSteps(document) {
  const runs = document?.runs;
  if (runs?.using !== "composite") {
    throw new Error(
      'action.yml must be a composite action ("runs.using: composite"); the SBOM only models that.',
    );
  }
  if (!Array.isArray(runs.steps)) {
    throw new Error("action.yml runs.steps must be a list of steps.");
  }
  return runs.steps;
}

// "owner/repo@<sha>" -> the trailing "# v1.2.3" comment of the `uses:` LINE
// that names it, or null when its lines disagree. YAML parsing drops comments,
// so they are read from the text. Only a line that itself starts with `uses:`
// counts (a commented-out line starts with `#`), and the label is only ever
// metadata: the pinned commit, not the label, is the dependency's identity.
function versionComments(actionYml) {
  const usesLine =
    /^[ \t]*(?:-[ \t]+)?uses:[ \t]*["']?([\w./-]+@[0-9a-f]{40})["']?[ \t]*#[ \t]*(\S+)/;
  const comments = new Map();
  for (const line of actionYml.split("\n")) {
    const match = usesLine.exec(line);
    if (!match) continue;
    const [, target, comment] = match;
    comments.set(
      target,
      comments.has(target) && comments.get(target) !== comment ? null : comment,
    );
  }
  return comments;
}

// Third-party actions that action.yml runs, each as { name, ref, comment },
// de-duplicated. Throws if action.yml is not valid YAML or not a composite
// action, or if any `uses` is not pinned to a full commit SHA.
function listActionDependencies(actionYml) {
  // Loaded here, not at the top: `verify` runs before `npm ci` and must work
  // with Node built-ins alone. js-yaml is a pinned devDependency, available to
  // `sbom`, which the workflow runs after `npm ci`.
  const yaml = require("js-yaml");
  const comments = versionComments(actionYml);
  const dependencies = new Map();
  for (const step of compositeSteps(yaml.load(actionYml))) {
    if (step === null || typeof step !== "object" || Array.isArray(step)) {
      throw new Error("action.yml has a step that is not a mapping.");
    }
    if (!("uses" in step)) continue; // a `run:` step
    const target = step.uses;
    if (typeof target !== "string") {
      throw new Error(
        `action.yml has a "uses" value that is not a string (${JSON.stringify(target)}); refusing to describe it.`,
      );
    }
    if (target.startsWith("./")) {
      // In a composite action a `./` path is resolved against the CALLER's
      // workspace, not this repository (the portable form is
      // ${{ github.action_path }}), and a local action could hide further
      // third-party `uses:` that this SBOM would not list. Refuse rather than
      // skip; teach this function to recurse before ever allowing one.
      throw new Error(
        `action.yml uses the local path "${target}", which the SBOM does not model (and which resolves against the caller's workspace); refusing to produce an incomplete SBOM.`,
      );
    }
    const separator = target.indexOf("@");
    const name = separator === -1 ? "" : target.slice(0, separator);
    const ref = separator === -1 ? "" : target.slice(separator + 1);
    if (!name || !FULL_SHA_PATTERN.test(ref ?? "")) {
      throw new Error(
        `action.yml uses "${target}", which is not pinned to a full commit SHA; refusing to describe a mutable dependency.`,
      );
    }
    if (
      !ACTION_NAME_PATTERN.test(name) ||
      name.split("/").some((part) => part === "." || part === "..")
    ) {
      throw new Error(
        `action.yml uses "${target}" with an invalid owner/repository/action path; refusing to produce an incomplete SBOM.`,
      );
    }
    // Keyed by the full target, so a repeated action collapses to one entry.
    dependencies.set(target, {
      name,
      ref,
      comment: comments.get(target) ?? undefined,
    });
  }
  return [...dependencies.values()];
}

// package URL for a GitHub Action: pkg:github/owner/repo@sha#action-subpath.
// GitHub Actions are repositories (or paths in repositories), not a separate
// registered PURL ecosystem; `github` is the standardized type.
function actionPurl({ name, ref }) {
  const [owner, repo, ...subpath] = name.toLowerCase().split("/");
  const base = `pkg:github/${owner}/${repo}@${ref}`;
  return subpath.length > 0 ? `${base}#${subpath.join("/")}` : base;
}

function buildSbom({ packageJson, tag, repository, actionYml, timestamp }) {
  // Enforced here, at the point the SBOM is produced, so its completeness
  // never depends on `verify` having been run before it.
  const npmFields = npmDependencyFields(packageJson);
  if (npmFields.length > 0) throw new Error(npmDependencyMessage(npmFields));

  const rootRef = `pkg:github/${repository.toLowerCase()}@${tag}`;
  const components = listActionDependencies(actionYml).map((dep) => {
    const purl = actionPurl(dep);
    const component = {
      type: "library",
      "bom-ref": purl,
      name: dep.name,
      // The pinned commit is the verifiable version. The human label from the
      // source comment is an unverified annotation, kept in a property.
      version: dep.ref,
      purl,
    };
    if (dep.comment) {
      component.properties = [
        { name: "fossasia:cla-bot:ref-comment", value: dep.comment },
      ];
    }
    return component;
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

  const { problems: signatureProblems, tagObjectSha } = await inspectTag({
    repository: env.GITHUB_REPOSITORY,
    tag,
    commit: env.GITHUB_SHA,
    token: env.GH_TOKEN,
    fetchImpl,
  });
  if (signatureProblems.length > 0) return failures(signatureProblems, stderr);
  if (!FULL_SHA_PATTERN.test(tagObjectSha)) {
    return failures(
      [`GitHub returned an unexpected tag object id "${tagObjectSha}".`],
      stderr,
    );
  }

  const section = extractChangelogSection(changelog, parseTag(tag));
  const notes = `${section}\n\n---\n\nRelease payloads are individually signed or attested. Verify every signature and attestation before use: https://github.com/${env.GITHUB_REPOSITORY}/blob/${tag}/SECURITY.md#verifying-a-release\n`;
  fs.writeFileSync(notesFile, notes);
  if (env.GITHUB_OUTPUT) {
    fs.appendFileSync(env.GITHUB_OUTPUT, `tag-object-sha=${tagObjectSha}\n`);
  }
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
  declaresDependencies,
  npmDependencyFields,
  inspectTag,
  verifyTagSignature,
  listActionDependencies,
  actionPurl,
  buildSbom,
  main,
  TAG_PATTERN,
};
