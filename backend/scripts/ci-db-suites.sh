#!/bin/bash
# One shard of CI's "every other *-db.test.ts" real-Postgres suites.
#
#   scripts/ci-db-suites.sh <shard> <shards>           run shard <shard> of <shards> (1-based)
#   scripts/ci-db-suites.sh <shard> <shards> --list    print that shard's files, run nothing
#
# DB_SUITES_SKIP is the |-separated names of the suites that have a step of their own (the same
# list the workflow always carried); they are left out of every shard.
#
# The suites are every tracked *-db.test.ts file, so a new one runs the day it lands with no list
# to update. They are sorted by path and dealt out one by one (the Nth file goes to shard N mod
# <shards>), so the shards differ by at most one file and the slow permission suites, which sit
# side by side in the sorted list, are spread over all of them. Every shard computes the same
# split from the same checkout, so between them they run each suite exactly once.
#
# Written for the macOS runner's bash 3.2: no mapfile, no associative arrays.
set -euo pipefail

SHARD="${1:-}"
SHARDS="${2:-}"
MODE="${3:-run}"
for n in "$SHARD" "$SHARDS"; do
  case "$n" in
    '' | *[!0-9]*) echo "usage: $0 <shard> <shards> [--list]" >&2; exit 2 ;;
  esac
done
if [ "$SHARD" -lt 1 ] || [ "$SHARDS" -lt 1 ] || [ "$SHARD" -gt "$SHARDS" ]; then
  echo "shard must be between 1 and the number of shards ($SHARD of $SHARDS)" >&2
  exit 2
fi

cd "$(dirname "$0")/.."
SKIP="${DB_SUITES_SKIP:-}"

ALL=()
while IFS= read -r f; do ALL+=("$f"); done < <(
  git ls-files -- '*-db.test.ts' | LC_ALL=C sort |
    if [ -n "$SKIP" ]; then grep -vE "(^|/)(${SKIP})-db\.test\.ts$" || true; else cat; fi
)
if [ "${#ALL[@]}" -eq 0 ]; then
  echo "::error::No *-db.test.ts files left to run - the skip list or the glob is wrong"
  exit 1
fi

FILES=()
i=0
for f in "${ALL[@]}"; do
  if [ $(( i % SHARDS + 1 )) -eq "$SHARD" ]; then FILES+=("$f"); fi
  i=$(( i + 1 ))
done
if [ "${#FILES[@]}" -eq 0 ]; then
  echo "Shard $SHARD of $SHARDS has no suites (only ${#ALL[@]} exist); nothing to run"
  exit 0
fi

if [ "$MODE" = "--list" ]; then
  printf '%s\n' "${FILES[@]}"
  exit 0
fi

printf 'Shard %s of %s: running %s of %s suites:\n' "$SHARD" "$SHARDS" "${#FILES[@]}" "${#ALL[@]}"
printf '  %s\n' "${FILES[@]}"
exec npx vitest run "${FILES[@]}" --no-file-parallelism --retry=2
