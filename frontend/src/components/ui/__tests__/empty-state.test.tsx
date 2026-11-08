/**
 * EmptyState `padY` - phase 8, W2 primitive vocabulary.
 *
 * The hard constraint on this whole phase is that no EXISTING default moves
 * a pixel. EmptyState has 132 in-scope call sites: ~104 pass no `density` at
 * all, 12 pass `density="flush"`, 14 pass `density="compact"`, 2 pass
 * `density="roomy"` (measured per this session's spec). Every one of them
 * must render exactly what it rendered before this file existed, so the
 * first two blocks below assert the literal class string rather than a
 * loose `toContain`.
 *
 * `padY` is a 4px-grid numeric step (settled vocabulary rev 3), not a size
 * word - `0`/`6`/`12`/`24` reach the exact pixels the old `density` word
 * scale already shipped, per the vocabulary's explicit EmptyState remap
 * table. `12` is the default. No fifth or sixth step is minted - rule 5
 * ("only add where measured demand exists") applies and none of the 132
 * real call sites need one.
 */
import type { ReactElement } from 'react';

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { EmptyState } from '@/components/ui/empty-state';

/** The exact string EmptyState has rendered since 6b, for a call site passing nothing. */
const BASELINE = 'flex flex-col items-center justify-center gap-2 text-center py-12';

function classOf(ui: ReactElement): string {
  const { container } = render(ui);
  return (container.firstElementChild as HTMLElement).className;
}

describe('EmptyState - existing defaults are unchanged (hard constraint)', () => {
  it('renders the pre-phase-8 baseline string when no props are passed', () => {
    expect(classOf(<EmptyState title="Nothing here" />)).toBe(BASELINE);
  });

  it('padY={12} is byte-identical to the implicit default', () => {
    expect(classOf(<EmptyState title="Nothing here" padY={12} />)).toBe(BASELINE);
  });

  it('density="default" is byte-identical to the implicit default', () => {
    expect(classOf(<EmptyState title="Nothing here" density="default" />)).toBe(BASELINE);
  });

  it.each([
    ['flush', 'py-0', 0],
    ['compact', 'py-6', 6],
    ['roomy', 'py-24', 24],
  ] as const)(
    'density="%s" still renders %s, and equals the padY step it maps to',
    (word, cls, step) => {
      const legacy = classOf(<EmptyState title="Nothing here" density={word} />);
      expect(legacy).toContain(cls);
      expect(legacy).toBe(classOf(<EmptyState title="Nothing here" padY={step} />));
    },
  );

  it('variant="card" chrome and className pass-through behave exactly as before', () => {
    const t = classOf(
      <EmptyState title="Nothing here" variant="card" className="mt-4 max-w-sm" />,
    );
    expect(t).toContain('rounded-card');
    expect(t).toContain('border-dashed');
    expect(t).toContain('bg-surface-light');
    expect(t).toContain('px-6');
    expect(t).toContain('mt-4');
    expect(t).toContain('max-w-sm');
    // variant="card" never owns vertical padding - still the padY default.
    expect(t).toContain('py-12');
  });
});

describe('EmptyState - new `padY` values', () => {
  it.each([
    [0, 'py-0'],
    [6, 'py-6'],
    [12, 'py-12'],
    [24, 'py-24'],
  ] as const)('padY={%s} renders %s', (padY, cls) => {
    const t = classOf(<EmptyState title="Nothing here" padY={padY} />).split(/\s+/);
    expect(t).toContain(cls);
    // exactly one py-* token - never two competing padding classes.
    expect(t.filter((c) => c.startsWith('py-'))).toEqual([cls]);
  });

  it('padY overrides density when both are passed', () => {
    const t = classOf(<EmptyState title="Nothing here" density="roomy" padY={0} />);
    expect(t).toContain('py-0');
    expect(t).not.toContain('py-24');
  });
});
