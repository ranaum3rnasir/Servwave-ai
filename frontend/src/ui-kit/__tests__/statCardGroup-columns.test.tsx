import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StatCard, StatCardGroup } from '@/ui-kit/components/data/statCard';

/**
 * Mobile slice 03: KPI tiles are two per row below sm, so a list page's table
 * starts on the first phone screen instead of one to two screens down.
 *
 * Before this slice the group was `grid sm:grid-cols-2 xl:grid-cols-4`: one
 * implicit column below 640 px, so the Jobs page's six tiles stacked into six
 * rows at 320. The column count is a class, and jsdom has no layout, so the
 * classes are what is pinned here; the measured two-per-row at 320/360/393 and
 * four at 1280 are in the slice's Playwright check.
 */
function groupClasses(className?: string) {
  const { container } = render(
    <StatCardGroup className={className}>
      <StatCard label="Open" value="12" />
      <StatCard label="Scheduled" value="4" />
    </StatCardGroup>,
  );
  return container.querySelector('[data-slot="stat-card-group"]')!.className.split(/\s+/);
}

describe('StatCardGroup columns', () => {
  it('is two columns at the narrowest width, not one', () => {
    const classes = groupClasses();
    expect(classes).toContain('grid-cols-2');
    expect(classes).not.toContain('grid-cols-1');
  });

  it('keeps four columns at xl, as on desktop today', () => {
    expect(groupClasses()).toContain('xl:grid-cols-4');
  });

  it('lets a page widen the xl row without losing the two-up phone row', () => {
    const classes = groupClasses('xl:grid-cols-6');
    expect(classes).toContain('grid-cols-2');
    expect(classes).toContain('xl:grid-cols-6');
    expect(classes).not.toContain('xl:grid-cols-4');
  });

  // A long value no longer wraps inside its tile (that broke figures mid-number
  // at 320 px): it stays on one line and is fitted. See statCard-figure-fit.test.tsx.
});
