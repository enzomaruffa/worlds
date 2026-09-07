#!/usr/bin/env bash
# Deploy the bundled example sites to an instance.
#
# `examples/` is in .dockerignore and only the universe is seeded on boot, so shipping a
# new server build does not put these sites on an instance — worlds ship through the
# blobstore, not the image. This pushes them the same way a person would.
#
#   scripts/deploy-examples.sh                              # every example
#   scripts/deploy-examples.sh latency retro                # just these
#   WORLDS_URL=https://world.plex.bz scripts/deploy-examples.sh
#
# Run `bun cli/worlds.ts login` first for anything behind Cloudflare Access.
set -uo pipefail

cd "$(dirname "$0")/.."
CLI="$PWD/cli/worlds.ts"
: "${WORLDS_URL:=http://worlds.localhost:8420}"
export WORLDS_URL

# No mapfile/associative arrays: macOS still ships bash 3.2.
all=""
while IFS= read -r dir; do all="$all$dir"$'\n'; done < <(
  find examples -mindepth 3 -maxdepth 3 -name index.html -exec dirname {} \; | sort
)

targets=""
while IFS= read -r dir; do
  [ -n "$dir" ] || continue
  name=$(basename "$dir")
  if [ $# -eq 0 ]; then
    targets="$targets$dir"$'\n'
  else
    for w in "$@"; do [ "$w" = "$name" ] && targets="$targets$dir"$'\n'; done
  fi
done <<< "$all"

count=$(printf '%s' "$targets" | grep -c . || true)
if [ "$count" -eq 0 ]; then
  echo "no matching examples (have: $(printf '%s' "$all" | xargs -n1 basename | tr '\n' ' '))" >&2
  exit 1
fi

echo "→ $WORLDS_URL  ($count sites)"
failed=""
while IFS= read -r dir; do
  [ -n "$dir" ] || continue
  name=$(basename "$dir")
  printf '%-12s ' "$name"
  # Each deploy is independent: a name already owned by someone else must not stop the rest.
  if out=$(cd "$dir" && bun "$CLI" deploy 2>&1); then
    echo "${out##*$'\n'}"
  else
    echo "FAILED — ${out##*$'\n'}"
    failed="$failed $name"
  fi
done <<< "$targets"

if [ -n "$failed" ]; then
  echo
  echo "failed:$failed" >&2
  exit 1
fi
echo
echo "done"
