import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderHook } from '@testing-library/react';
import { scheduleEventColorVars, scheduleEventCardVars, EVENT_COLOR_VAR } from './eventColors';
import { buildScheduleEventColorVars, useScheduleEventColorVars } from './useScheduleEventColorVars';
import { eventCardColors, hexToChannels } from '@/design-system/eventCardColors';
import { token } from '@/design-system/tokens';
import { contrastRatio, rgbDistance } from '@/design-system/contrast';
import { SCHEDULE_EVENT_PALETTE } from '@/design-system/scheduleEventPalette';
import { EVENT_TYPE_META } from '@/components/schedule/scheduleModel';

describe('scheduleEventColorVars', () => {
  it('re-points the accent alias at the chosen token by reference, never by value', () => {
    expect(scheduleEventColorVars({ job: 'sage-700' })['--ev-job' as never]).toBe('var(--sage-700)');
  });

  it('emits NOTHING for an uncustomised type, so it falls through to the token alias', () => {
    const vars = scheduleEventColorVars({ job: 'sage-700' });
    expect(vars).not.toHaveProperty('--ev-walkthrough');
    expect(vars).not.toHaveProperty('--ev-service-plan');
    expect(vars).not.toHaveProperty('--ev-calendar-entry');
  });

  it('covers all four board event types', () => {
    const vars = scheduleEventColorVars({
      job: 'info', walkthrough: 'amber-700', 'service-plan': 'indigo-600', 'calendar-entry': 'olive-700',
    });
    for (const cssVar of Object.values(EVENT_COLOR_VAR)) expect(vars).toHaveProperty(cssVar);
  });

  // The map round-trips through an API and a JSONB column. A board that quietly falls back to
  // its defaults is a far better failure than a board that throws on render - or one that paints
  // `rgb(var(--nothing))` and loses its colour.
  it('drops a value outside the palette rather than emitting an undefined var()', () => {
    expect(scheduleEventColorVars({ job: '#2563EB', walkthrough: 'sage-700' })).toEqual({
      '--ev-walkthrough': 'var(--sage-700)',
    });
    expect(scheduleEventColorVars({ job: 'terracotta' })).toEqual({});
    expect(scheduleEventColorVars({ job: 42 })).toEqual({});
  });

  it('ignores keys that are not board event types', () => {
    expect(scheduleEventColorVars({ 'time-off': 'sage-700' })).toEqual({});
  });

  it('survives null, undefined, arrays and non-objects', () => {
    expect(scheduleEventColorVars(null)).toEqual({});
    expect(scheduleEventColorVars(undefined)).toEqual({});
    expect(scheduleEventColorVars([])).toEqual({});
    expect(scheduleEventColorVars('sage-700')).toEqual({});
  });

  it('keys the same four types EVENT_TYPE_META does - the two must not drift', () => {
    expect(Object.keys(EVENT_COLOR_VAR).sort()).toEqual(Object.keys(EVENT_TYPE_META).sort());
  });
});

// The `-fill` companion is gone: its one consumer, the drag chip, paints the derived `-solid`
// pair, which is defined for every type. Pinned so a stale reader cannot quietly come back to an
// undefined property.
describe('scheduleEventColorVars - no -fill companion', () => {
  it('emits only the accent alias for a customised type', () => {
    expect(scheduleEventColorVars({ job: 'ocean-700' })).toEqual({ '--ev-job': 'var(--ocean-700)' });
  });
});

describe('scheduleEventCardVars - the derived card colours', () => {
  const PARTS = ['surface', 'text', 'border', 'solid', 'on-solid'];

  it('emits every part for EVERY type, customised or not - there is no alias to fall through to', () => {
    const vars = scheduleEventCardVars({ job: 'sage-500' });
    for (const prefix of Object.values(EVENT_COLOR_VAR)) {
      for (const part of PARTS) expect(vars[`${prefix}-${part}`], `${prefix}-${part}`).toMatch(/^\d+ \d+ \d+$/);
    }
    for (const v of ['--ev-in-progress-solid', '--ev-in-progress-on-solid', '--ev-completed-solid', '--ev-completed-on-solid']) {
      expect(vars[v], v).toMatch(/^\d+ \d+ \d+$/);
    }
  });

  it('derives a customised type from the org\'s pick and an uncustomised one from its default', () => {
    const vars = scheduleEventCardVars({ job: 'sage-500' });
    // sage-500 (#6BAA8F): the lightest pick in the palette, 2.48:1 as text on its old tint.
    expect(vars['--ev-job-text']).toBe(hexToChannels(eventCardColors(token('--sage-500'))!.text));
    expect(vars['--ev-walkthrough-text']).toBe(hexToChannels(eventCardColors(token('--warning'))!.text));
  });

  it('treats a value outside the palette as unset, exactly as the aliases do', () => {
    expect(scheduleEventCardVars({ job: 'terracotta' })).toEqual(scheduleEventCardVars({}));
    expect(scheduleEventCardVars(null)).toEqual(scheduleEventCardVars({}));
  });

  it('emits nothing for a group whose seed does not resolve, so the tokens.css default stays in charge', () => {
    const vars = scheduleEventCardVars({}, (name) => (name === 'info' ? null : '#5A5A2E'));
    expect(vars).not.toHaveProperty('--ev-job-surface');
    expect(vars).not.toHaveProperty('--ev-in-progress-solid');
    expect(vars).toHaveProperty('--ev-walkthrough-surface');
  });
});

/**
 * tokens.css carries the DEFAULT seeds' derived colours as literals (first paint, and anything
 * rendered without the page's hook). They are generated, not designed - this is the generator's
 * check: every literal must equal what the rule derives from today's default tokens.
 */
describe('tokens.css derived defaults match the rule', () => {
  const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../design-system/tokens.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const declared = new Map(
    [...css.matchAll(/(--ev-[\w-]+-(?:surface|text|border|solid|on-solid))\s*:\s*([^;]+);/g)]
      .map(([, name, value]) => [name!, value!.trim().replace(/\s+/g, ' ')]),
  );

  it('declares exactly the set the hook writes, each equal to the derivation', () => {
    const derived = scheduleEventCardVars({});
    expect(Object.fromEntries(declared)).toEqual(derived);
  });
});

describe('buildScheduleEventColorVars / useScheduleEventColorVars', () => {
  it('is the aliases plus the derived colours', () => {
    const vars = buildScheduleEventColorVars({ job: 'sage-500' }) as Record<string, string>;
    expect(vars['--ev-job']).toBe('var(--sage-500)');
    expect(vars).not.toHaveProperty('--ev-job-fill');
    expect(vars['--ev-job-surface']).toMatch(/^\d+ \d+ \d+$/);
  });

  it('writes to documentElement only when asked, and removes what it wrote on unmount', () => {
    const root = document.documentElement;
    const preview = renderHook(() => useScheduleEventColorVars({ job: 'sage-500' }));
    expect(preview.result.current).toHaveProperty('--ev-job-surface');
    expect(root.style.getPropertyValue('--ev-job-surface')).toBe('');
    preview.unmount();

    const page = renderHook(({ c }) => useScheduleEventColorVars(c, { writeToRoot: true }), {
      initialProps: { c: { job: 'sage-500' } as unknown },
    });
    expect(root.style.getPropertyValue('--ev-job')).toBe('var(--sage-500)');
    expect(root.style.getPropertyValue('--ev-job-text')).toBe(hexToChannels(eventCardColors(token('--sage-500'))!.text));
    // Un-customising drops the alias (the tokens.css alias takes over) but keeps a derived value.
    page.rerender({ c: {} });
    expect(root.style.getPropertyValue('--ev-job')).toBe('');
    expect(root.style.getPropertyValue('--ev-job-text')).toBe(hexToChannels(eventCardColors(token('--info'))!.text));
    page.unmount();
    expect(root.style.getPropertyValue('--ev-job-text')).toBe('');
  });

  it('compares the map by value: a fresh but equal object does not re-derive', () => {
    const { result, rerender } = renderHook(({ c }) => useScheduleEventColorVars(c), {
      initialProps: { c: { job: 'sage-500' } as unknown },
    });
    const first = result.current;
    rerender({ c: { job: 'sage-500' } });
    expect(result.current).toBe(first);
  });
});

/**
 * A done card must never read as a scheduled one, whatever colour the org picks. The completed
 * card was briefly a pale tint derived from a grey seed - which, with Job set to Slate, landed 2.4
 * away from the scheduled Job surface on the 0-441 RGB scale: the same card. It is now a SOLID
 * mid-grey with white text, a fill no scheduled card uses (their fills are all pale tints).
 */
describe('the completed card stays distinguishable from every scheduled card', () => {
  const vars = scheduleEventCardVars({});
  const channelsHex = (v: string) =>
    `#${v.split(' ').map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
  const completedFill = channelsHex(vars['--ev-completed-solid']!);
  const completedText = channelsHex(vars['--ev-completed-on-solid']!);

  it('carries its own text at WCAG AA, with no fade to undo it', () => {
    expect(contrastRatio(completedText, completedFill)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(SCHEDULE_EVENT_PALETTE.map((e) => e.token))('vs a scheduled card painted %s', (pick) => {
    const scheduled = eventCardColors(token(`--${pick}`))!;
    // The fills: solid mid-grey against a pale tint - far apart, and far darker.
    expect(rgbDistance(completedFill, scheduled.surface)).toBeGreaterThan(120);
    expect(contrastRatio(completedFill, scheduled.surface)).toBeGreaterThan(3);
    // It does not depend on the pick at all.
    expect(scheduleEventCardVars({ job: pick })['--ev-completed-solid']).toBe(vars['--ev-completed-solid']);
  });

  it('and from the solid in-progress card', () => {
    expect(rgbDistance(completedFill, channelsHex(vars['--ev-in-progress-solid']!))).toBeGreaterThan(80);
  });
});
