#!/usr/bin/env bash
# Verify a published release before it can become GitHub's Latest marker.
set -euo pipefail

: "${RELEASE_TAG:?RELEASE_TAG is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${DEFAULT_BRANCH:?DEFAULT_BRANCH is required}"

if [[ ! "$RELEASE_TAG" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "Not a stable SemVer release tag: ${RELEASE_TAG}" >&2
  exit 1
fi

gh_version="$(gh version | awk 'NR == 1 { sub(/^gh version /, ""); print $1 }')"
if [[ ! "$gh_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "GitHub CLI version '${gh_version:-unknown}' is too old for release attestation verification; require 2.102.0 or newer." >&2
  exit 1
fi
IFS=. read -r gh_major gh_minor _ <<< "$gh_version"
if (( 10#$gh_major < 2 || (10#$gh_major == 2 && 10#$gh_minor < 102) )); then
  echo "GitHub CLI version ${gh_version} is too old for release attestation verification; require 2.102.0 or newer." >&2
  exit 1
fi

name="cla-bot-${RELEASE_TAG}"
workflow="${GITHUB_REPOSITORY}/.github/workflows/release.yml"
identity="https://github.com/${workflow}@refs/tags/${RELEASE_TAG}"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT

meta="$(gh release view "$RELEASE_TAG" --json name,tagName,isDraft,isPrerelease,isImmutable --jq '[.name, .tagName, .isDraft, .isPrerelease, .isImmutable] | join(" ")')"
if [[ "$meta" != "${RELEASE_TAG} ${RELEASE_TAG} false false true" && \
      ("${RELEASE_IMMUTABILITY:-not-required}" != not-required || \
       "$meta" != "${RELEASE_TAG} ${RELEASE_TAG} false false false") ]]; then
  echo "Release metadata is not public, stable, and correctly named: ${meta}" >&2
  exit 1
fi
if [[ "${RELEASE_IMMUTABILITY:-not-required}" == required ]]; then
  gh release verify "$RELEASE_TAG"
fi

ref="$(gh api "repos/${GITHUB_REPOSITORY}/git/ref/tags/${RELEASE_TAG}")"
ref_type="$(jq -r '.object.type' <<< "$ref")"
tag_object="$(jq -r '.object.sha' <<< "$ref")"
if [[ "$ref_type" != tag || ! "$tag_object" =~ ^[0-9a-f]{40}$ ]]; then
  echo "${RELEASE_TAG} is not an annotated tag." >&2
  exit 1
fi
tag="$(gh api "repos/${GITHUB_REPOSITORY}/git/tags/${tag_object}")"
tag_name="$(jq -r '.tag' <<< "$tag")"
commit_type="$(jq -r '.object.type' <<< "$tag")"
commit="$(jq -r '.object.sha' <<< "$tag")"
verified="$(jq -r '.verification.verified' <<< "$tag")"
if [[ "$tag_name" != "$RELEASE_TAG" || "$commit_type" != commit || ! "$commit" =~ ^[0-9a-f]{40}$ || "$verified" != true ]]; then
  echo "${RELEASE_TAG} does not resolve to its own directly-targeted, GitHub-verified signed tag." >&2
  exit 1
fi

default_sha="$(gh api "repos/${GITHUB_REPOSITORY}/branches/${DEFAULT_BRANCH}" --jq .commit.sha)"
comparison="$(gh api "repos/${GITHUB_REPOSITORY}/compare/${commit}...${default_sha}" --jq .status)"
if [[ "$comparison" != ahead && "$comparison" != identical ]]; then
  echo "${RELEASE_TAG} commit ${commit} is not an ancestor of ${DEFAULT_BRANCH} (comparison: ${comparison})." >&2
  exit 1
fi

mkdir "$temporary/assets"
expected_assets=(
  "${name}.tar.gz"
  "${name}.tar.gz.sigstore.json"
  "${name}.sbom.cdx.json"
  "${name}.provenance.intoto.jsonl"
  "${name}.sbom.intoto.jsonl"
  SHA256SUMS
  SHA256SUMS.sigstore.json
)
expected_assets_json="$(jq -cn --args '$ARGS.positional | sort' -- "${expected_assets[@]}")"
actual_assets_json="$(gh api "repos/${GITHUB_REPOSITORY}/releases/tags/${RELEASE_TAG}" --jq '[.assets[].name] | sort')"
if [[ "$actual_assets_json" != "$expected_assets_json" ]]; then
  echo "${RELEASE_TAG} has a missing or unexpected release asset." >&2
  exit 1
fi
gh release download "$RELEASE_TAG" --dir "$temporary/assets"
entry_count="$(find "$temporary/assets" -mindepth 1 -maxdepth 1 | wc -l)"
file_count="$(find "$temporary/assets" -mindepth 1 -maxdepth 1 -type f | wc -l)"
if [[ "$entry_count" -ne "${#expected_assets[@]}" || "$file_count" -ne "${#expected_assets[@]}" ]]; then
  echo "${RELEASE_TAG} download contains a non-file or unexpected asset entry." >&2
  exit 1
fi
for asset in "${expected_assets[@]}"; do
  if [[ ! -f "$temporary/assets/${asset}" || -L "$temporary/assets/${asset}" ]]; then
    echo "${RELEASE_TAG} is missing regular asset ${asset}." >&2
    exit 1
  fi
done

mapfile -t checksum_assets < <(awk '{ print $2 }' "$temporary/assets/SHA256SUMS" | sort)
mapfile -t expected_checksums < <(printf '%s\n' "${name}.tar.gz" "${name}.sbom.cdx.json" | sort)
if [[ "${checksum_assets[*]}" != "${expected_checksums[*]}" ]]; then
  echo "${RELEASE_TAG} SHA256SUMS does not list exactly the archive and SBOM." >&2
  exit 1
fi
(cd "$temporary/assets" && sha256sum --check --strict SHA256SUMS)

for file in "${name}.tar.gz" SHA256SUMS; do
  cosign verify-blob \
    --bundle "${temporary}/assets/${file}.sigstore.json" \
    --certificate-identity "$identity" \
    --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
    "${temporary}/assets/${file}"
done

gh attestation verify "${temporary}/assets/${name}.tar.gz" \
  --bundle "${temporary}/assets/${name}.provenance.intoto.jsonl" \
  --repo "$GITHUB_REPOSITORY" \
  --signer-workflow "$workflow" \
  --source-ref "refs/tags/${RELEASE_TAG}" \
  --source-digest "$commit"
gh attestation verify "${temporary}/assets/${name}.tar.gz" \
  --bundle "${temporary}/assets/${name}.sbom.intoto.jsonl" \
  --repo "$GITHUB_REPOSITORY" \
  --signer-workflow "$workflow" \
  --source-ref "refs/tags/${RELEASE_TAG}" \
  --source-digest "$commit" \
  --predicate-type "https://cyclonedx.org/bom"

echo "${RELEASE_TAG} is a verified release from ${commit} on ${DEFAULT_BRANCH}."
