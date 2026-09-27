#!/usr/bin/env bash
# Writes the PR context the Jazz CI agents read to a static JSON file, so the agents never hold
# GITHUB_TOKEN themselves.
#
# Usage: snapshot-pr-context.sh <owner/repo> <pr-number> <output-file>
# Needs GH_TOKEN in the environment.
#
# Only text from trusted authors reaches the agent: comments, reviews and inline review comments
# whose author association is OWNER, MEMBER or COLLABORATOR, plus the github-actions bot (the
# workflow's own earlier reviews, so the reviewer can skip what it already raised). Anyone can
# comment on a public PR, and that text would otherwise be instructions to an agent with shell
# access. `omittedUntrusted` counts what was dropped.
set -uo pipefail

repo="$1"
pr_number="$2"
output="$3"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

if ! gh pr view "$pr_number" --repo "$repo" --json title,body,labels,comments,reviews \
  > "$scratch/pr.json" \
  || ! gh api "repos/$repo/pulls/$pr_number/comments?per_page=100" \
    > "$scratch/review-comments.json"; then
  echo '{"error":"Failed to fetch PR context; agent will proceed without it."}' > "$output"
  exit 0
fi

jq -s '
  def trusted_association: . as $association | ["OWNER", "MEMBER", "COLLABORATOR"] | index($association) != null;
  def trusted:
    ((.authorAssociation // .author_association // "") | trusted_association)
    or ((.author.login // .user.login // "") | IN("github-actions", "github-actions[bot]"));
  .[0] as $pr
  | .[1] as $inline
  | ($pr.comments | map(select(trusted))) as $comments
  | ($pr.reviews | map(select(trusted))) as $reviews
  | ($inline | map(select(trusted))) as $reviewComments
  | $pr
  + {
      comments: $comments,
      reviews: $reviews,
      reviewComments: $reviewComments,
      omittedUntrusted: (
        ($pr.comments | length) - ($comments | length)
        + ($pr.reviews | length) - ($reviews | length)
        + ($inline | length) - ($reviewComments | length)
      )
    }
' "$scratch/pr.json" "$scratch/review-comments.json" > "$output"

echo "--- PR context (first 200 lines) ---"
head -n 200 "$output"
