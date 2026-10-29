#!/usr/bin/env bash
#
# record-ledger.sh <issue> <stagingCommit>
#
# Appends one promotion-ledger line for a fix just merged to `staging`, then commits
# + pushes the ledger to `staging`. Called by fix-issues-pipeline (Mode A) and
# merge-train right after a fix lands on staging, so /promote-approved can later ship
# the approved subset to `main`.
#
#   <issue>         the SHEET-canonical GitHub issue number (e.g. 460, not a closed dup 350)
#   <stagingCommit> the new staging tip (merge commit for --no-ff, squash commit for --squash);
#                   $COMMIT^1..$COMMIT is the fix's net change either way.
#
# Branch-independent: it commits onto origin/staging in a detached temp worktree, so the
# caller's checked-out branch does not matter.
#
set -euo pipefail
[ $# -eq 2 ] || { echo "usage: record-ledger.sh <issue> <stagingCommit>" >&2; exit 2; }
ISSUE="$1"; COMMIT="$2"
ROOT=$(git rev-parse --show-toplevel)
REL="docs/agents/promotion-ledger.jsonl"

git -C "$ROOT" fetch -q origin staging

# idempotent: already recorded on staging?
if git -C "$ROOT" show "origin/staging:$REL" 2>/dev/null | grep -q "\"stagingCommit\": \"$COMMIT\""; then
  echo "ledger: $COMMIT already recorded — skipping"; exit 0
fi

FILES=$(git -C "$ROOT" diff --name-only "$COMMIT^1" "$COMMIT" 2>/dev/null \
        | grep -vE '(^|/)node_modules$' \
        | python3 -c "import sys,json;print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))")
MERGED_AT=$(git -C "$ROOT" log -1 --format=%cI "$COMMIT")
LINE=$(python3 -c "import json,sys;print(json.dumps({'issue':int(sys.argv[1]),'stagingCommit':sys.argv[2],'files':json.loads(sys.argv[3]),'mergedAt':sys.argv[4]}))" \
        "$ISSUE" "$COMMIT" "$FILES" "$MERGED_AT")

# commit the appended ledger on top of origin/staging in a detached temp worktree (branch-independent)
TMP="$ROOT/../alpha_crm-worktrees/.ledger-$$"
git -C "$ROOT" worktree add -q --detach "$TMP" origin/staging
trap 'git -C "$ROOT" worktree remove --force "$TMP" >/dev/null 2>&1 || true' EXIT
mkdir -p "$TMP/$(dirname "$REL")"
printf '%s\n' "$LINE" >> "$TMP/$REL"
git -C "$TMP" add "$REL"
git -C "$TMP" commit -q -m "chore(ledger): record #$ISSUE for staging→main promotion"
git -C "$TMP" push -q origin HEAD:staging
echo "ledger: recorded #$ISSUE -> ${COMMIT:0:10}"
