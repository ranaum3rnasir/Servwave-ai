# Phase 4 `/goal` condition - ready to paste

One goal for the whole of phase 4 (4a through 4d), per the spec's own "one goal per phase"
model. Paste the block between the rules below after `/goal clear`. It doubles as the opening
directive, so setting it starts work immediately.

Sizing note: the sub-phase detail, measured baseline and residual rules live in the spec's
phase 4 section, which the condition's first line orders read. That is deliberate - the
condition is capped at 4,000 characters and the evaluator cannot run tools, so the condition
carries the end state and the evidence commands, and the spec carries the detail.

---

Phase 4 (all of it: 4a, 4b, 4c, 4d) of
`md_files/specs/frontend/2026-07-26-ui-single-source-of-truth-goal.md`, in the worktree
`../alpha_crm-worktrees/shared-components` on `refactor/shared-component-library`. Read that
spec's phase 4 section before anything else: it carries the measured baseline, the sub-phase
split and the residual rules. Run the sub-phases in order; 4b depends on 4a.

4a. Reclaim the stale ceilings in `frontend/src/design-system/__tests__/tokens-guard.test.ts`:
`MAX_PALETTE_TREE` 897 -> 852, `MAX_WHITE_BLACK_TREE` 1212 -> 1184. These are free, phase 3
already did the work. Then close raw hex in `.ts`/`.tsx`: `MAX_TS_HEX` 139 -> its real floor.
Start at `pages/reports/arAging.data.ts`, which hardcodes six bucket colours as hex while
`ArAgingReport.tsx` computes the same six from `severityRamp` - a live duplicate with drift.

4b. Inline appearance styles: `MAX_INLINE_APPEARANCE` 31 -> its real floor. Three clusters,
not 31 one-offs: the copilot glow/gradients (8), an identical chart-axis `fontSize: 10|11`
repeated across 8 report files (one shared constant, not 8 edits), and `SchedulePage` (6).

4c. Bare white/black: 1184 -> its real floor. Mechanical: `bg-white` (740) -> `bg-surface-light`
and `text-white` (387) -> `text-on-fill`; both tokens exist, are already in use, and cover
1127 of the 1184. Parallelise by file, never by utility.

4d. Palette classes: 852 -> its real floor. FIRST write one family-and-role -> token mapping
table into the spec, then apply it everywhere. Deciding per area re-decides what `amber-50`
means in every area and rebuilds the exact drift this effort exists to remove. Execute by
family group: neutrals (298), status (390), brand/info + misc (164). The 390 status-family
classes are the risk bucket: any that encodes a domain state is a phase-1 registry leak phase
3 could not see, because phase 3 fenced shared components only and these sit in pages. Route
those through `design-system/status-registry.ts`. Substituting a token for a palette class
and calling it done is the failure mode here.

DONE when every ratchet in `tokens-guard.test.ts` sits at its real floor, every unconverted
site is enumerated in the spec with a written reason it is legitimate, and this evidence is
printed in full:
- `cd frontend && npx tsc --noEmit` - clean
- `cd frontend && npx vitest run` - baseline is 325 files / 2699 passed / 7 skipped; report
  the real numbers and account for any difference
- `cd frontend && npx vitest run src/design-system/__tests__/tokens-guard.test.ts` - green,
  with all five final counts printed

Append a DONE entry per sub-phase to the spec's phase 4 list: real conversions vs residuals,
each residual with its reason, and the ratchet movement.

CONSTRAINTS
- Measure with the guard, never an ad hoc grep. Re-verify every count by running it. Every
  count in that spec was wrong at least once before it was verified.
- Never raise a ratchet. If a number rises, fix the code, not the number.
- Introduce no raw hex and no raw Tailwind palette class anywhere.
- Never narrow scope silently. If a sub-phase is too large, say so and propose the split;
  scaling down is the owner's call.
- Plain hyphens only, never em or en dashes, in prose, comments, code and commit text.
- No AI attribution in any git artifact.
- Worktree only: do not push, do not open a PR, do not commit unless asked.
- Record every judgment call in the spec. Do not silently drop or silently keep a value.

Stop after 90 turns and report.
