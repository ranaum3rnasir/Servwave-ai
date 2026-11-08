import type { SearchResult } from '@/components/layout/search-shared';
import type { BoardEvent } from '@/components/schedule/scheduleModel';
import { toWallClock } from '@/lib/schedule-tz';

/**
 * What a scheduler search result points at on the board.
 *
 * A job or lead result names the PARENT and the one trip it found: `date` is that trip's start
 * (the job's first live visit, the lead's current walkthrough). Cards are one per trip
 * (`jv-<visitId>`, `wv-<visitId>`), so the result lights the parent's card that starts then -
 * each walkthrough visit is searched on its own (PRD story 9). An Event or a service plan result
 * names its card directly.
 */
export type SearchHighlightTarget =
  | { kind: 'card'; boardId: string }
  | { kind: 'trip'; type: 'job' | 'walkthrough'; parentId: string; at: number | null };

export function searchHighlightTarget(result: SearchResult, tz: string): SearchHighlightTarget {
  if (result.entity_type === 'calendar-entry') return { kind: 'card', boardId: `ce-${result.id}` };
  if (result.entity_type === 'job' || result.entity_type === 'lead') {
    return {
      kind: 'trip',
      type: result.entity_type === 'lead' ? 'walkthrough' : 'job',
      parentId: result.id,
      // The board's own clock: cards carry wall-clock starts (eventAdapters / boardProjection).
      at: result.date ? toWallClock(new Date(result.date), tz).getTime() : null,
    };
  }
  return { kind: 'card', boardId: result.id };
}

/**
 * The board ids to light for `target` among the cards on the board. For a trip: the parent's card
 * starting at the result's date; if none does (the trip moved since the search ran), every card of
 * that parent rather than none. Plan-mode ghosts are drafts, not the record found, and never light.
 */
export function highlightedBoardIds(events: readonly BoardEvent[], target: SearchHighlightTarget | null): Set<string> {
  if (!target) return new Set();
  if (target.kind === 'card') return new Set(events.filter((e) => e.boardId === target.boardId).map((e) => e.boardId));
  const ofParent = events.filter((e) => !e.isGhost && e.type === target.type && e.parentId === target.parentId);
  const atDate = ofParent.filter((e) => e.start !== null && e.start.getTime() === target.at);
  return new Set((atDate.length > 0 ? atDate : ofParent).map((e) => e.boardId));
}
