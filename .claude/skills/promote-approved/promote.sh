#!/usr/bin/env bash
#
# promote.sh — selectively promote QA-approved fixes from `staging` to `main`.
#
# Reads the QA sheet for rows marked `approved`, maps each to its staging commit
# via docs/agents/promotion-ledger.jsonl, cherry-picks the approved subset onto a
# fresh branch off `main`, and opens ONE PR to `main`. Auto-finalizes (deletes the
# sheet row of) any approved fix whose issue is already CLOSED (= already promoted).
#
# Policy (decided with Ran):
#   - BLOCK-ON-CONFLICT: if ANY approved fix can't cherry-pick cleanly, build nothing
#     and report the blockers (the fix + conflicting files + the unapproved sibling
#     that owns them). No partial PR.
#   - Default is DRY-RUN. Pass --execute to actually push the branch, open the PR,
#     and call the sheet webhook. --execute is required for any side effect.
#
# Usage:  promote.sh [--execute]
#
set -euo pipefail

EXECUTE=0
OVERRIDE=""     # --issues "413 460": promote these specific issues, bypassing the sheet read
while [ $# -gt 0 ]; do
  case "$1" in
    --execute) EXECUTE=1 ;;
    --issues)  shift; OVERRIDE="${1:-}" ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

# ---- config ---------------------------------------------------------------
REPO="ranro1/ALPHA_CRM"
SHEET_ID="1RZxpcu7t2IkIRRpodjPb-SRMD7SUs1aA6ZUOHgcUZYA"     # FSM Bug Tracker
SHEET_GID="318890031"
GVIZ_URL="https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=${SHEET_GID}"
LEDGER_PATH="docs/agents/promotion-ledger.jsonl"

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

note()  { printf '%s\n' "$*"; }
warn()  { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die()   { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ $EXECUTE -eq 1 ] && note "MODE: EXECUTE (will push branch + open PR + update sheet)" \
                   || note "MODE: DRY-RUN (no pushes, no PR, no sheet writes) — pass --execute to act"

command -v gh  >/dev/null || die "gh CLI not found"
command -v python3 >/dev/null || die "python3 not found"

# webhook creds (best-effort; finalize is skipped if unset)
WEBHOOK_URL=$(grep -E '^SHEETS_WEBAPP_URL=' backend/.env 2>/dev/null | head -1 | cut -d= -f2- | sed -E 's/^["'\'']//; s/["'\'']$//' || true)
WEBHOOK_TOKEN=$(grep -E '^SHEETS_WEBAPP_TOKEN=' backend/.env 2>/dev/null | head -1 | cut -d= -f2- | sed -E 's/^["'\'']//; s/["'\'']$//' || true)

git fetch origin main staging --quiet

# ---- read the ledger from staging (authoritative, complete copy) ----------
LEDGER_JSON=$(git show "origin/staging:${LEDGER_PATH}" 2>/dev/null || true)
[ -n "$LEDGER_JSON" ] || die "ledger not found at origin/staging:${LEDGER_PATH} — has it been seeded?"

# issue -> commit  (and issue -> files) lookups, via python
ledger_commit() { printf '%s' "$LEDGER_JSON" | python3 -c "
import sys,json
want=int(sys.argv[1]); out=''
for l in sys.stdin:
    l=l.strip()
    if not l: continue
    e=json.loads(l)
    if e['issue']==want: out=e['stagingCommit']
print(out)" "$1"; }

ledger_files() { printf '%s' "$LEDGER_JSON" | python3 -c "
import sys,json
want=int(sys.argv[1])
for l in sys.stdin:
    l=l.strip()
    if not l: continue
    e=json.loads(l)
    if e['issue']==want: print('\n'.join(e['files']))" "$1"; }

# who (unapproved) owns these files? — for conflict diagnostics
owner_of_files() { # $1=newline-list of files ; uses globals APPROVED_SET
  printf '%s' "$LEDGER_JSON" | python3 -c "
import sys,json
conf=set(x for x in sys.argv[1].splitlines() if x)
approved=set(int(x) for x in sys.argv[2].split() if x)
hits=[]
for l in sys.stdin:
    l=l.strip()
    if not l: continue
    e=json.loads(l)
    if e['issue'] in approved: continue
    if conf & set(e['files']): hits.append('#%d (%s)' % (e['issue'], ', '.join(sorted(conf & set(e['files'])))))
print('; '.join(hits) if hits else '(no ledgered sibling owns those files — may be a base/main drift conflict)')" "$1" "$2"; }

# ---- determine the approved set (sheet, or --issues override) -------------
note ""
if [ -n "$OVERRIDE" ]; then
  APPROVED="$OVERRIDE"
  warn "Using --issues override (bypassing the sheet): $APPROVED"
else
  note "Reading QA sheet (approved rows)…"
  CSV=$(curl -sL -m 30 "$GVIZ_URL") || die "could not fetch sheet CSV"
  APPROVED=$(printf '%s' "$CSV" | python3 -c "
import sys,csv
r=csv.reader(sys.stdin)
rows=list(r)
out=[]
for row in rows[1:]:                       # skip header
    if len(row) < 6: continue
    issue=row[0].strip(); status=row[5].strip().lower()
    if status=='approved' and issue.isdigit():
        out.append(issue)
print(' '.join(out))")
fi

if [ -z "$APPROVED" ]; then
  note "No rows marked 'approved' in the sheet. Nothing to promote."
  exit 0
fi
note "Approved issues: $APPROVED"

# ---- Phase A: finalize already-promoted (issue CLOSED) --------------------
note ""
note "── Phase A: finalize already-promoted (closed issues) ──"
CANDIDATES=()
for iss in $APPROVED; do
  state=$(gh issue view "$iss" -R "$REPO" --json state --jq .state 2>/dev/null || echo "UNKNOWN")
  if [ "$state" = "CLOSED" ]; then
    note "  #$iss CLOSED → already promoted → finalize (delete sheet row)"
    if [ $EXECUTE -eq 1 ] && [ -n "$WEBHOOK_URL" ] && [ -n "$WEBHOOK_TOKEN" ]; then
      resp=$(curl -sL -m 25 "${WEBHOOK_URL}?token=${WEBHOOK_TOKEN}&action=delete&issue=${iss}" || true)
      note "      webhook: $resp"
    elif [ $EXECUTE -eq 1 ]; then
      warn "    webhook env unset — cannot delete row for #$iss (issue is closed; delete the row manually)"
    else
      note "      (dry-run) would call webhook action=delete issue=$iss"
    fi
  elif [ "$state" = "OPEN" ]; then
    CANDIDATES+=("$iss")
  else
    warn "  #$iss state=$state — skipping (couldn't read issue)"
  fi
done

if [ ${#CANDIDATES[@]} -eq 0 ]; then
  note ""
  note "No OPEN approved issues to promote (all approved rows were already promoted/finalized)."
  exit 0
fi
note ""
note "── Phase B: build promotion PR for: ${CANDIDATES[*]} ──"

# ---- resolve each candidate to its staging commit (+ ledger gaps) ---------
declare -a TO_PICK=()       # "issue commit"
declare -a NO_LEDGER=()
for iss in "${CANDIDATES[@]}"; do
  commit=$(ledger_commit "$iss")
  if [ -z "$commit" ]; then NO_LEDGER+=("$iss"); continue; fi
  TO_PICK+=("$iss $commit")
done
if [ ${#NO_LEDGER[@]} -gt 0 ]; then
  warn "Approved but NOT in ledger (can't locate their commit) — excluded: ${NO_LEDGER[*]}"
  warn "  (fixed before the ledger existed, or a non-pipeline merge — promote these by hand.)"
fi
[ ${#TO_PICK[@]} -gt 0 ] || die "No ledgered approved fixes to promote."

APPROVED_SET="${CANDIDATES[*]}"

# ---- cherry-pick the subset onto a fresh branch off main ------------------
BRANCH="promote/$(date +%Y%m%d-%H%M%S)"
WT="$(git rev-parse --show-toplevel)/../alpha_crm-worktrees/${BRANCH//\//-}"
note ""
note "Building $BRANCH off origin/main in a scratch worktree…"
git branch -D "$BRANCH" >/dev/null 2>&1 || true   # clear any stale same-name branch
git worktree add --quiet "$WT" -b "$BRANCH" origin/main || die "could not create worktree"
# cleanup removes the scratch worktree AND the local branch. In --execute mode the PR is
# served by the pushed REMOTE branch, which is independent of this local ref.
cleanup() { git worktree remove --force "$WT" >/dev/null 2>&1 || true; git branch -D "$BRANCH" >/dev/null 2>&1 || true; }
trap cleanup EXIT

PICKED=()    # "issue commit"
BLOCKED=0
for entry in "${TO_PICK[@]}"; do
  iss=${entry%% *}; commit=${entry##* }
  # auto-detect merge commit (>1 parent → cherry-pick -m 1) vs normal commit
  nparents=$(git -C "$WT" rev-list --parents -n1 "$commit" | wc -w)
  if [ "$nparents" -ge 3 ]; then mflag="-m 1"; else mflag=""; fi
  if git -C "$WT" cherry-pick $mflag -x "$commit" >/dev/null 2>&1; then
    note "  ✓ #$iss  (${commit:0:10})"
    PICKED+=("$entry")
  else
    # distinguish "already applied (empty)" from a real conflict
    unmerged=$(git -C "$WT" diff --name-only --diff-filter=U)
    if [ -z "$unmerged" ]; then
      git -C "$WT" cherry-pick --skip >/dev/null 2>&1 || git -C "$WT" cherry-pick --quit >/dev/null 2>&1 || true
      note "  ↷ #$iss already present in main — skipped"
    else
      git -C "$WT" cherry-pick --abort >/dev/null 2>&1 || true
      culprit_files=$(ledger_files "$iss")
      blockers=$(owner_of_files "$culprit_files" "$APPROVED_SET")
      warn "BLOCKED #$iss — conflicts in:"
      printf '%s\n' "$unmerged" | sed 's/^/        /' >&2
      warn "  needs first (unapproved sibling on staging): $blockers"
      BLOCKED=1
    fi
  fi
done

if [ $BLOCKED -eq 1 ]; then
  note ""
  die "BLOCK-ON-CONFLICT: at least one approved fix is entangled with an unapproved one. No PR opened. Approve the sibling(s) above (so they promote together) or resolve manually, then re-run."
fi
if [ ${#PICKED[@]} -eq 0 ]; then
  note ""
  note "Nothing new to promote (all approved fixes already in main)."
  exit 0
fi

# ---- compose PR body ------------------------------------------------------
ISSUE_LIST=$(for e in "${PICKED[@]}"; do echo "#${e%% *}"; done | paste -sd ', ' -)
BODY_FILE="$WT/.promote-body.md"
{
  echo "Promotes ${#PICKED[@]} QA-approved fix(es) from \`staging\` to \`main\` (prod)."
  echo
  echo "| Issue | Fix commit |"
  echo "|-------|-----------|"
  for e in "${PICKED[@]}"; do echo "| #${e%% *} | \`$(echo "${e##* }" | cut -c1-10)\` |"; done
  echo
  for e in "${PICKED[@]}"; do echo "Fixes #${e%% *}"; done   # auto-closes on merge to main (default branch)
  echo
  echo "_Cherry-picked onto fresh \`main\` by /promote-approved. On merge, each issue auto-closes; the sheet rows finalize on the next /promote-approved run._"
} > "$BODY_FILE"

note ""
note "Promotion set ready: ${#PICKED[@]} fix(es) → main  (${ISSUE_LIST})"
git -C "$WT" --no-pager log --oneline origin/main.."$BRANCH" | sed 's/^/    /'

if [ $EXECUTE -eq 0 ]; then
  note ""
  note "DRY-RUN complete. Re-run with --execute to push $BRANCH and open the PR."
  exit 0
fi

# ---- push + open PR -------------------------------------------------------
git -C "$WT" push -u origin "$BRANCH" --quiet
PR_URL=$(gh pr create -R "$REPO" --base main --head "$BRANCH" \
  --title "promote: ${#PICKED[@]} approved fix(es) to main (${ISSUE_LIST})" \
  --body-file "$BODY_FILE")
note ""
note "✓ Promotion PR opened: $PR_URL"
note "  Review + merge it to ship ${ISSUE_LIST} to prod. Issues auto-close on merge."
note "  Re-run /promote-approved afterward to finalize (delete) the sheet rows."
