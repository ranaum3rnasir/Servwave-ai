/**
 * Every custom property a scheduler card paints with, for one org's colour map, in one hook.
 *
 * Two layers, built by lib/schedule/eventColors.ts:
 *  - the ALIASES (`--ev-job: var(--sage-700)`) for customised types only - what the swatches and anything else painting the raw seed resolve;
 *  - the DERIVED card colours (`--ev-job-surface`, `-text`, `-border`, `-solid`, `-on-solid`, and
 *    the in-progress / completed status groups) for every type - what the cards themselves paint,
 *    computed so every seed reads at WCAG AA (design-system/eventCardColors.ts).
 *
 * Two ways to use it:
 *  - `useScheduleEventColorVars(org.schedule_event_colors, { writeToRoot: true })` - the schedule
 *    page. Writes everything on documentElement (the portals - legend, editor, drop modal, drag
 *    chip - live outside the page's DOM subtree) and removes it again on unmount or change.
 *  - `const style = useScheduleEventColorVars(draftColors)` - a preview. Nothing is written
 *    anywhere; spread the returned object onto the preview's wrapper (`<div style={style}>`) and
 *    every ev-* utility inside it resolves against the draft, without repainting the rest of the
 *    app. The same classes the board uses then render the same card the board will.
 *
 * `colors` is compared by value, so an inline object literal does not re-derive every render.
 */
import { useEffect, useMemo, type CSSProperties } from 'react';
import { scheduleEventColorVars, scheduleEventCardVars } from './eventColors';

export interface UseScheduleEventColorVarsOptions {
  /** Write the properties on documentElement for as long as the caller is mounted. Default false. */
  writeToRoot?: boolean;
}

/** The pure half of the hook, for callers outside React (and for tests). */
export function buildScheduleEventColorVars(colors: unknown): CSSProperties {
  return { ...scheduleEventColorVars(colors), ...scheduleEventCardVars(colors) } as CSSProperties;
}

export function useScheduleEventColorVars(
  colors: unknown,
  { writeToRoot = false }: UseScheduleEventColorVarsOptions = {},
): CSSProperties {
  const key = JSON.stringify(colors ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by value on purpose (see above)
  const vars = useMemo(() => buildScheduleEventColorVars(colors), [key]);

  // Written on documentElement, NOT on a page div: custom properties inherit through the DOM, and
  // the Radix portals mount into document.body, a sibling of #root. Removed on unmount so the
  // properties do not outlive the page.
  useEffect(() => {
    if (!writeToRoot) return undefined;
    const root = document.documentElement;
    for (const [prop, value] of Object.entries(vars)) root.style.setProperty(prop, String(value));
    return () => {
      for (const prop of Object.keys(vars)) root.style.removeProperty(prop);
    };
  }, [vars, writeToRoot]);

  return vars;
}
