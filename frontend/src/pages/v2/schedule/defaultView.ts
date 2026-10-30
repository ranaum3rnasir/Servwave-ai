/**
 * Which view the scheduler opens on, and what its empty state may honestly say.
 *
 * Mobile slice 02 (PRD module 8, "Scheduler phone mode"). The opening view is a pure
 * function of three inputs, in this order of precedence:
 *
 *   1. an explicit view in the URL (`/schedule?view=day|week|month`) - a link wins;
 *   2. the view the user picked earlier in this browser session;
 *   3. the width class - below Tailwind `md` (a phone) it is Day, otherwise Week.
 *
 * A technician's landing page is the scheduler, and a seven-column week on a 320-393 px
 * phone is unreadable; Day is one readable column. A dispatcher who picks Week on a phone
 * keeps Week until the tab is closed, so looking ahead is not undone by every navigation.
 *
 * The session choice lives in `sessionStorage` because "kept for the session" is exactly
 * that store's lifetime. Every access is guarded: private windows and blocked site data
 * make the accessor throw, and the board must still open on its default.
 */

export type ScheduleView = 'day' | 'week' | 'month';

/** `phone` is below Tailwind `md` (768 px); everything else is `wide`. */
export type ScheduleWidthClass = 'phone' | 'wide';

export const SCHEDULE_VIEW_SESSION_KEY = 'servwave.schedule.view';

const VIEWS: readonly ScheduleView[] = ['day', 'week', 'month'];

/** A board view, or null for anything else (absent, junk, or a view the board does not offer). */
export function parseScheduleView(value: string | null | undefined): ScheduleView | null {
  return (VIEWS as readonly string[]).includes(value ?? '') ? (value as ScheduleView) : null;
}

/**
 * `noCrew` is the "No crew" filter (S09.12), which is about the next 7 days: a link to it opens on Week at every
 * width, ahead of a view picked earlier in the session (but behind a view the link itself names).
 */
export function resolveScheduleView(input: {
  widthClass: ScheduleWidthClass;
  urlView: ScheduleView | null;
  sessionView: ScheduleView | null;
  noCrew?: boolean;
}): ScheduleView {
  if (input.noCrew) return input.urlView ?? 'week';
  return input.urlView ?? input.sessionView ?? (input.widthClass === 'phone' ? 'day' : 'week');
}

export function readSessionView(): ScheduleView | null {
  try {
    return parseScheduleView(window.sessionStorage.getItem(SCHEDULE_VIEW_SESSION_KEY));
  } catch {
    return null;
  }
}

export function writeSessionView(view: ScheduleView): void {
  try {
    window.sessionStorage.setItem(SCHEDULE_VIEW_SESSION_KEY, view);
  } catch {
    // Storage unavailable: the choice still holds for this page view, it just is not
    // remembered for the next one.
  }
}

const EMPTY_TITLE: Record<ScheduleView, string> = {
  day: 'No jobs scheduled this day',
  week: 'No jobs scheduled this week',
  month: 'No jobs scheduled this month',
};

/**
 * The board's empty-state copy. The drag hint names "the panel on the left", so it is
 * only offered where that panel is on screen (it renders from Tailwind `lg` up, and only
 * while open) and where the viewer may drag at all (the technician board is read-only).
 */
export function scheduleEmptyStateCopy(input: {
  view: ScheduleView;
  panelVisible: boolean;
  canDrag: boolean;
  /** The "No crew" filter is on: an empty board is good news, not a quiet week. */
  noCrew?: boolean;
}): { title: string; description?: string } {
  if (input.noCrew) {
    return { title: 'No visits without a crew', description: 'Every booked visit you can see in the next 7 days has someone on it.' };
  }
  const title = EMPTY_TITLE[input.view];
  return input.panelVisible && input.canDrag
    ? { title, description: 'Drag a job from the panel on the left to assign it' }
    : { title };
}
