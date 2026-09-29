#!/usr/bin/env bash
# Commit history/YYYY-MM-DD.json: the pipeline's day.json plus when and where
# it was deployed. One small commit per day keeps the repository "active", so
# GitHub does not disable the scheduled workflow after 60 quiet days.
#
#   record-day.sh <day.json> <page_url>
#
# Run from the root of a checkout of the branch to commit to (BRANCH, default
# main), with push credentials. Skips the commit when history/<date>.json
# already holds the same day.json (e.g. a manual rebuild of a recorded day).
# Guards against push races: rebase on the remote and retry once.
set -euo pipefail

DAY_JSON="$1"
PAGE_URL="${2:-}"
BRANCH="${BRANCH:-main}"

date=$(jq -r '.date' "$DAY_JSON")
[[ "$date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "::error::no date in $DAY_JSON"; exit 1; }
out="history/$date.json"
mkdir -p history

if [[ -f "$out" ]] && jq -e --slurpfile new "$DAY_JSON" '.day == $new[0]' "$out" >/dev/null; then
  echo "$out already records this day; nothing to commit"
  exit 0
fi

jq --arg deployed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
   --arg page_url "$PAGE_URL" \
   --arg run_url "${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}" \
   --arg sha "${GITHUB_SHA:-}" \
   '{date: .date, deployed_at: $deployed_at, page_url: $page_url, run_url: $run_url, built_from: $sha, day: .}' \
   "$DAY_JSON" > "$out"

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add "$out"
if git diff --cached --quiet; then
  echo "no change to $out"
  exit 0
fi
summary=$(jq -r '"\(.weekday // "") \(.date): \(.clean_trips // "?") trips"' "$DAY_JSON")
git commit -q -m "history: $summary"

for attempt in 1 2; do
  git pull -q --rebase origin "$BRANCH"
  if git push -q origin "HEAD:$BRANCH"; then
    echo "committed $out"
    exit 0
  fi
  echo "push attempt $attempt failed; retrying"
  sleep 5
done
echo "::error::could not push $out"
exit 1
