/**
 * The colours an organization may paint its scheduler event types with.
 *
 * Every entry is a TOKEN the design system already ships (tokens.css / tokens-v2.css), named
 * without its `--` prefix. There is no hex here and no custom colour anywhere in the feature
 * (owner, 2026-09-15): the org picks from the app's own palette, and the board resolves the name
 * at paint time through `var(--<token>)`, so a retuned token repaints every org's board. That is
 * also why this file is NOT on the token guard's exemption list any more - it has nothing to
 * exempt.
 *
 * This list is the contract with SCHEDULE_EVENT_COLOR_TOKENS in
 * backend/src/controllers/organization.controller.ts, which is what the API accepts. The two must
 * match entry for entry; scheduleEventPalette.test.ts pins every token here to a real definition
 * in the token sheets.
 *
 * Deliberately absent: terracotta (it is --danger and the needs-crew notch - a Job painted in it
 * would make the board's one red mean two things), notify-rose (reserved for notification badges)
 * and every surface/text neutral.
 */
export interface ScheduleEventPaletteEntry {
  /** The token name, `--` dropped. What is stored and sent. */
  token: string;
  /** The word a screen reader and a tooltip use for it. */
  label: string;
}

export const SCHEDULE_EVENT_PALETTE: readonly ScheduleEventPaletteEntry[] = [
  { token: 'info', label: 'Blue' },
  { token: 'status-blue', label: 'Deep blue' },
  { token: 'ocean-700', label: 'Ocean' },
  { token: 'sage-700', label: 'Sage' },
  { token: 'status-green', label: 'Green' },
  { token: 'sage-500', label: 'Light sage' },
  { token: 'amber-700', label: 'Amber' },
  { token: 'status-amber', label: 'Gold' },
  { token: 'indigo-600', label: 'Indigo' },
  { token: 'status-purple', label: 'Purple' },
  { token: 'olive-700', label: 'Olive' },
  { token: 'status-slate', label: 'Slate' },
];

const TOKENS = new Set(SCHEDULE_EVENT_PALETTE.map((e) => e.token));

/** True for a value the palette offers - the frontend half of the API's enum. */
export function isScheduleEventPaletteToken(value: unknown): value is string {
  return typeof value === 'string' && TOKENS.has(value);
}
