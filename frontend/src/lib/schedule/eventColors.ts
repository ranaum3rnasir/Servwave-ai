/**
 * Per-organization scheduler event colours.
 *
 * The board paints through four indirection tokens (--ev-job, --ev-walkthrough,
 * --ev-service-plan, --ev-calendar-entry, defined in design-system/tokens.css), each of which
 * aliases the status token that type has always used. This module is the only thing that ever
 * overrides them: it turns the org's saved `schedule_event_colors` map - palette TOKEN NAMES, see
 * design-system/scheduleEventPalette.ts - into custom properties that re-point each alias at the
 * chosen token (`--ev-job: var(--sage-700)`). SchedulePage writes them on documentElement so
 * every surface repaints together, portals included.
 *
 * Two properties of that design are load-bearing:
 *  - An UNSET type emits nothing, so it falls through to the token alias. "Never customised"
 *    stays distinguishable from "customised to today's colour", which is what lets the design
 *    system keep moving under orgs that have not opted out of it.
 *  - The values are `var(--…)` references, never resolved colours. The org's choice follows the
 *    token if the token is retuned, and nothing here is a literal the token guard has to police.
 *
 * Cards do not paint those aliases directly any more (2026-09-30): the accent as text on a tint of
 * itself failed WCAG AA for most picks. scheduleEventCardVars below turns every type's effective
 * token into DERIVED card colours (surface, text, border, solid fill) that do clear it; it
 * necessarily resolves the token to a value, since contrast is measured on values. Both sets are
 * delivered together by useScheduleEventColorVars.
 */
import type { CSSProperties } from 'react';
import type { EventType } from '@/components/schedule/scheduleModel';
import { isScheduleEventPaletteToken } from '@/design-system/scheduleEventPalette';
import { eventCardColors, cssColorToHex, hexToChannels } from '@/design-system/eventCardColors';
import { token } from '@/design-system/tokens';

/** The org's stored map. Partial: a missing key means "follow the design system". */
export type ScheduleEventColors = Partial<Record<EventType, string>>;

export const EVENT_COLOR_VAR: Record<EventType, string> = {
  job: '--ev-job',
  walkthrough: '--ev-walkthrough',
  'service-plan': '--ev-service-plan',
  'calendar-entry': '--ev-calendar-entry',
};

/**
 * Build the custom properties for the document root. Unknown keys and values outside the palette
 * are dropped rather than thrown on: this data round-trips through an API and a database, and a
 * board that silently falls back to its defaults is a far better failure than a board that does
 * not render.
 */
export function scheduleEventColorVars(colors: unknown): CSSProperties {
  if (!colors || typeof colors !== 'object' || Array.isArray(colors)) return {};
  const out: Record<string, string> = {};
  for (const [type, cssVar] of Object.entries(EVENT_COLOR_VAR)) {
    const raw = (colors as Record<string, unknown>)[type];
    if (!isScheduleEventPaletteToken(raw)) continue;
    out[cssVar] = `var(--${raw})`;
    // There used to be a `-fill` companion here, defined only for customised types so the drag
    // chip could fall back to the AA-corrected strong token. The chip now paints the derived
    // `-solid` pair (scheduleEventCardVars below), defined for every type, so nothing reads it.
  }
  return out as CSSProperties;
}

/**
 * The token each type paints with when the org has not picked one - the targets of the --ev-*
 * aliases in tokens.css. Mirrored here because the card-colour rule needs the seed's VALUE, and a
 * `var(--ev-job)` read back through getComputedStyle is only as reliable as the browser's
 * custom-property substitution; the token it aliases is a plain channel triple.
 */
export const DEFAULT_EVENT_COLOR_TOKEN: Record<EventType, string> = {
  job: 'info',
  walkthrough: 'warning',
  'service-plan': 'ai',
  'calendar-entry': 'event',
};

/**
 * Seeds for the two STATUS treatments, both painted as SOLID fills so they are hue-independent:
 * no palette pick can make a scheduled card (always a pale tint) look like either of them.
 * Completed is seeded from the grey it has always been (--text-soft), darkened just enough for
 * white text to clear 4.5:1 instead of being faded to 60%. Written with the `--` prefix and
 * stripped at use: a bare token name that looks like a utility class trips the unresolved-class
 * guard's extractor.
 */
const IN_PROGRESS_SEED_TOKEN = 'info';
const COMPLETED_SEED_VAR = '--text-soft';

/** Every type's effective token name: the org's pick where it made a valid one, the default otherwise. */
export function scheduleEventSeedTokens(colors: unknown): Record<EventType, string> {
  const picked = colors && typeof colors === 'object' && !Array.isArray(colors)
    ? (colors as Record<string, unknown>)
    : {};
  const out = {} as Record<EventType, string>;
  for (const type of Object.keys(EVENT_COLOR_VAR) as EventType[]) {
    const raw = picked[type];
    out[type] = isScheduleEventPaletteToken(raw) ? raw : DEFAULT_EVENT_COLOR_TOKEN[type];
  }
  return out;
}

/** A token name (no `--`) to its live `#RRGGBB`, via token() and so via FALLBACKS under jsdom. */
export function resolveTokenHex(name: string): string | null {
  return cssColorToHex(token(`--${name}`));
}

/**
 * The DERIVED card colours (design-system/eventCardColors.ts), as channel-triple custom properties
 * so Tailwind's `rgb(var(--x) / <alpha-value>)` works on them:
 *
 *   --ev-<type>-surface | -text | -border | -solid | -on-solid   for all four types
 *   --ev-in-progress-solid | -on-solid                            the Standard board's live card
 *   --ev-completed-solid | -on-solid                              the "done" card, every board
 *
 * Unlike scheduleEventColorVars this emits EVERY type, customised or not: the values are computed,
 * so there is no alias left to fall through to. tokens.css carries the same set for the defaults
 * (first paint, and any surface outside the page that set them); eventColors.test.ts pins the two
 * against each other. A seed that does not resolve to a colour emits nothing for that group, which
 * leaves the tokens.css default in charge rather than painting `rgb()` of nothing.
 */
export function scheduleEventCardVars(
  colors: unknown,
  resolveHex: (tokenName: string) => string | null = resolveTokenHex,
): Record<string, string> {
  const out: Record<string, string> = {};
  const derive = (tokenName: string) => {
    const hex = resolveHex(tokenName);
    return hex ? eventCardColors(hex) : null;
  };
  for (const [type, tokenName] of Object.entries(scheduleEventSeedTokens(colors))) {
    const c = derive(tokenName);
    if (!c) continue;
    const prefix = EVENT_COLOR_VAR[type as EventType];
    out[`${prefix}-surface`] = hexToChannels(c.surface);
    out[`${prefix}-text`] = hexToChannels(c.text);
    out[`${prefix}-border`] = hexToChannels(c.border);
    out[`${prefix}-solid`] = hexToChannels(c.solid);
    out[`${prefix}-on-solid`] = hexToChannels(c.onSolid);
  }
  const inProgress = derive(IN_PROGRESS_SEED_TOKEN);
  if (inProgress) {
    out['--ev-in-progress-solid'] = hexToChannels(inProgress.solid);
    out['--ev-in-progress-on-solid'] = hexToChannels(inProgress.onSolid);
  }
  const completed = derive(COMPLETED_SEED_VAR.slice(2));
  if (completed) {
    out['--ev-completed-solid'] = hexToChannels(completed.solid);
    out['--ev-completed-on-solid'] = hexToChannels(completed.onSolid);
  }
  return out;
}
