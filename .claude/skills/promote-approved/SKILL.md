---
name: promote-approved
description: "Promote the QA-approved subset of staging fixes to main (prod) as one small PR. Reads the QA sheet for rows marked 'approved', maps each to its staging commit via the promotion ledger, cherry-picks the approved subset onto a fresh branch off main, blocks if any approved fix is entangled with an unapproved one, and opens ONE PR to main. Also auto-finalizes (deletes the sheet row of) any approved fix whose issue is already closed (= already promoted). Use when the user wants to 'promote approved fixes', 'ship the approved ones to main', 'build a promotion PR', or do a selective staging→main release."
---

# Promote approved fixes to `main`

Selective `staging → main` promotion. `staging` accumulates every merged fix; this skill ships
only the **QA-approved** subset to prod, instead of wholesale-promoting all of `staging`.

> **Topology:** `staging` = TESTING (demo `servwave-demo.vercel.app`); `main` = LIVE/prod
> (`app.servwave.com`). QA verifies on the demo and types `approved` / `not fixed` in the sheet.
> An `approved` row that is **still present** = verified-but-not-yet-in-prod (rows are deleted only
> after promotion). The set of such rows is the promote queue.

## How it works
- **Ledger** (`docs/agents/promotion-ledger.jsonl`, read from `origin/staging`) maps each issue →
  its `staging` commit. Written at merge time by `fix-issues-pipeline` (Mode A) and `merge-train`.
  Keyed on the **sheet's** canonical issue number (e.g. phone-search is `#460`, not the closed dup
  `#350`), so the mapping is robust to dup-consolidation.
- **Phase A — finalize:** for each `approved` sheet row whose GH issue is already **CLOSED**, the fix
  is already in `main` (the promotion PR's `Fixes #N` closed it on merge) → call the sheet webhook
  to delete that row. Idempotent.
- **Phase B — build:** the `approved` rows whose issue is still **OPEN** are candidates. Look each up
  in the ledger, cherry-pick the subset onto a fresh branch off `main`, and open ONE PR to `main`
  whose body lists `Fixes #N` per issue (so merge auto-closes them), each with a link to its video proof
  from staging (`pr-video-proof` skill) or "No video: <reason>".
- **BLOCK-ON-CONFLICT:** if any approved fix can't cherry-pick cleanly (it shares files with a
  still-unapproved fix on `staging`), build nothing and report the blocker + the sibling that must be
  approved first. No partial PR.

## Run it
The skill is the script `promote.sh` (next to this file). **Dry-run by default** — it prints exactly
what would promote / finalize / block, with no pushes, no PR, no sheet writes:

```bash
bash "$(git rev-parse --show-toplevel)/.claude/skills/promote-approved/promote.sh"
```

Review the dry-run. When it looks right, execute for real:

```bash
bash "$(git rev-parse --show-toplevel)/.claude/skills/promote-approved/promote.sh" --execute
```

Then: review + merge the promotion PR on GitHub (ships to prod; issues auto-close). **Re-run the
skill afterward** (dry-run is fine) so Phase A deletes the now-closed rows from the sheet.

## Requirements / preconditions
- Run from inside the repo (any branch); the script `git fetch`es `origin/main` + `origin/staging`.
- `gh` authenticated; `python3` available.
- `backend/.env` present (for the sheet webhook `SHEETS_WEBAPP_URL` + `SHEETS_WEBAPP_TOKEN`). If
  unset, Phase B still works; Phase A prints which rows to delete by hand.
- The sheet webhook must support `action=delete` (added to `qa-sheet-sync-Code.gs` — re-paste into
  the live Apps Script). Until then, Phase A reports closed rows but can't delete them.

## Red flags — STOP
| Thought | Reality |
|---|---|
| "I'll just merge all of `staging` into `main`" | That ships **unapproved** fixes to prod. Promote only the approved subset — that's the whole point. |
| "One approved fix is blocked, I'll force the rest" | Policy is BLOCK-ON-CONFLICT. A blocked fix means it's entangled with an unapproved sibling; promoting half could ship a broken/partial change. Approve the sibling or resolve, then re-run. |
| "I'll cherry-pick by hand to save time" | Use the script — it auto-detects merge vs squash commits, dedups already-promoted changes, and composes the `Fixes #` body correctly. |
| "Run with --execute first to see what happens" | No. Dry-run is the default and shows everything. `--execute` pushes a **prod** PR. |
| "After merge I'll leave the sheet rows" | Re-run the skill so Phase A deletes them. Stale `approved` rows pollute the promote queue. |
