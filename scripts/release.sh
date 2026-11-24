#!/usr/bin/env bash
set -euo pipefail

export GH_REPO="${GITHUB_REPOSITORY:?}"
api="repos/$GH_REPO"
version=$(jq -er '.version' public/manifest.json)
tag="v$version"
asset="uchikomi-extension-$tag.zip"

# The list includes drafts when the token has push access.
release=$(gh api --paginate "$api/releases?per_page=100" |
  jq -c --arg tag "$tag" '.[] | select(.tag_name == $tag)')
if [[ -n "$release" ]]; then
  if [[ $(jq -r '.draft' <<< "$release") == false ]]; then
    jq -e --arg name "$asset" 'any(.assets[]; .name == $name and .state == "uploaded")' <<< "$release" > /dev/null || {
      echo "Published release $tag is missing $asset." >&2
      exit 1
    }
    echo "$tag is already published."
    exit 0
  fi
  if [[ $(jq -r '.target_commitish' <<< "$release") != "$GITHUB_SHA" ]]; then
    echo "The existing draft for $tag targets another commit. Rerun its original workflow." >&2
    exit 1
  fi
fi

# GitHub uses an existing tag even when release create specifies --target.
refs=$(gh api "$api/git/matching-refs/tags/$tag")
if jq -e --arg ref "refs/tags/$tag" 'any(.[]; .ref == $ref)' <<< "$refs" > /dev/null; then
  tagged_commit=$(gh api "$api/commits/$tag" --jq '.sha')
  if [[ "$tagged_commit" != "$GITHUB_SHA" ]]; then
    echo "Tag $tag already points to $tagged_commit instead of $GITHUB_SHA." >&2
    exit 1
  fi
fi

file="${RUNNER_TEMP:?}/$asset"
gh api "$api/actions/artifacts/${ARTIFACT_ID:?}/zip" > "$file"
printf '%s  %s\n' "${ARTIFACT_DIGEST:?}" "$file" | sha256sum --check
if ! unzip -p "$file" manifest.json | jq -e --arg version "$version" '.version == $version' > /dev/null; then
  echo "The artifact must contain a root manifest.json with version $version." >&2
  exit 1
fi

if [[ -z "$release" ]]; then
  gh release create "$tag" --draft --target "$GITHUB_SHA" --title "UCHIKOMI $tag" --generate-notes
fi
gh release upload "$tag" "$file" --clobber
gh release edit "$tag" --draft=false
