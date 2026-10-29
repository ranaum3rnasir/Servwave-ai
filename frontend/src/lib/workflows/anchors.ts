/**
 * anchors.ts — the AnchorKey type: entity DATE fields an anchored WAIT step or
 * a date-anchored trigger can target ("wait until 1 day before the
 * walkthrough" instead of "wait 1 day"). Mirrors backend/src/services/
 * automations/anchors.ts's AnchorKey (Task A1).
 *
 * The DATA this used to hand-sync (which anchors exist, their labels, which
 * entity offers which) is no longer duplicated here — it's served by the
 * catalog (GET /api/workflows/catalog → `anchors`, sourced from backend
 * catalog.ts's ANCHOR_OPTIONS) and read via `WorkflowCatalog['anchors']`
 * (lib/api/workflows.ts). This file is types only, so the anchor vocabulary
 * has a single source of truth (the catalog) while the shapes that reference
 * an anchor key (DateAnchorTriggerConfig, WaitForm's `anchor` prop) stay
 * compiler-checked against the real 8-member set.
 */

export type AnchorKey =
  | 'job.scheduled_start'
  | 'lead.walkthrough_scheduled_at'
  // Lead stage clocks (spec #1751 D8). The OPTIONS and LABELS still come from the served
  // catalog, as the note above says — only the compiler-checked key set lives here.
  | 'lead.created_at'
  | 'lead.contacted_at'
  | 'lead.last_visit_completed_at'
  | 'invoice.due_date'
  | 'estimate.valid_until'
  // Spec B slice 5: the task due date. One anchor giving an entity BOTH directions from a
  // single trigger - a reminder before it, an overdue chase after it.
  | 'task.due_at';

export type WaitDirection = 'before' | 'after';

/**
 * Which directions a served anchor option may be used in.
 *
 * The catalog gained `directions` when the lead stage clocks became selectable: those record a
 * moment as it happens, so "two hours BEFORE first contact" can never fire, and the backend
 * validator refuses to save one. Reading it through here rather than off the option directly keeps
 * one rule for the absent case — a fixture or a cached catalog written before the field existed
 * means "both", never "neither", so an older catalog degrades to today's behaviour instead of
 * emptying the picker.
 */
export function anchorDirections(option: { directions?: WaitDirection[] } | undefined): WaitDirection[] {
  const served = option?.directions;
  return served && served.length > 0 ? served : ['before', 'after'];
}
