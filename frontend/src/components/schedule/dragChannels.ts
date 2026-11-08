// frontend/src/components/schedule/dragChannels.ts
// The one codec for the scheduler's HTML5 drag payloads. Three id shapes travel
// across the board today:
//   - bare job id            (sidebar job cards → 'job-id')
//   - bare LEAD id           (sidebar walkthrough cards → 'walkthrough-id')
//   - BOARD id               ('grid-event-id' + draggingJobIdRef: job id, `jv-${visitId}`,
//                             `wt-${leadId}` (bucket), `wv-${visitId}` (board walkthrough),
//                             `pv-${planId}`, `ce-${entryId}`)
// Drop handlers must speak ONE language — the BOARD id — so `resolveBoardDropId`
// normalizes (restoring the wt- prefix the 'walkthrough-id' channel strips) and
// `parseBoardDragId` routes a board id to its entity kind + id.
//
// Slice 08 (calendar-entries spec §3/§4) — the `ce-` case below is the other half of turning
// drag ON for a calendar entry. Slice 03 deliberately left it OUT: with no `ce-` case,
// `parseBoardDragId` fell through to `{ kind: 'job' }` for a `ce-<uuid>` board id, so
// `draggableAccessor`/`resizableAccessor` in SchedulePage.tsx had to refuse the drag entirely
// (a since-deleted `isDragInert` predicate) — a board id that could never be correctly routed must never
// be allowed to start a drag in the first place. Both halves flip together, in this slice.

export const JOB_ID = 'job-id';
export const WALKTHROUGH_ID = 'walkthrough-id';
export const GRID_EVENT_ID = 'grid-event-id';
// Write-only today (kind is derived from the id prefix); kept for external drop targets.
export const GRID_EVENT_TYPE = 'grid-event-type';
export const FROM_MEMBER = 'from-member';
export const PLAN_VISIT_PLAN_ID = 'plan-visit-plan-id';

export type BoardDragKind = 'job' | 'walkthrough' | 'walkthrough-visit' | 'plan-visit' | 'calendar-entry';

export interface ParsedBoardDragId {
  kind: BoardDragKind;
  entityId: string; // the real row id (lead id for walkthroughs, visit id for walkthrough visits, plan id for plan visits, entry id for calendar entries)
}

/** Decode a BOARD id: `wt-` → walkthrough (lead id - the bucket's lead-keyed card),
 *  `wv-` → walkthrough-visit (visit id - a board card is ONE trip since visits slice 03),
 *  `pv-` → plan-visit (plan id), `ce-` → calendar-entry (entry id), else job. */
export function parseBoardDragId(id: string): ParsedBoardDragId {
  if (id.startsWith('wt-')) return { kind: 'walkthrough', entityId: id.slice(3) };
  if (id.startsWith('wv-')) return { kind: 'walkthrough-visit', entityId: id.slice(3) };
  if (id.startsWith('pv-')) return { kind: 'plan-visit', entityId: id.slice(3) };
  if (id.startsWith('ce-')) return { kind: 'calendar-entry', entityId: id.slice(3) };
  return { kind: 'job', entityId: id };
}

/**
 * Read a drop's payload channels and normalize to a BOARD id. The walkthrough
 * channel carries a bare lead id — restore the `wt-` prefix so downstream
 * routing can't mistake it for a job id (the pre-codec misroute).
 */
export function resolveBoardDropId(
  dt: Pick<DataTransfer, 'getData'>,
  fallback?: string | null,
): string | null {
  const jobId = dt.getData(JOB_ID);
  if (jobId) return jobId;
  const leadId = dt.getData(WALKTHROUGH_ID);
  if (leadId) return `wt-${leadId}`;
  const gridEventId = dt.getData(GRID_EVENT_ID);
  if (gridEventId) return gridEventId;
  return fallback ?? null;
}

/** Does a drag-over carry any board payload? (Plan-visit cards target the standard calendar only.) */
export function hasBoardDragPayload(types: readonly string[]): boolean {
  return types.includes(JOB_ID) || types.includes(WALKTHROUGH_ID) || types.includes(GRID_EVENT_ID);
}
