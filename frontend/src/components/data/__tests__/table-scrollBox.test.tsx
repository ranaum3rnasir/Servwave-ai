import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Table as LegacyTable } from '@/components/data/table';

/**
 * Mobile slice 17: the legacy data Table's `scrollBox` switch. The kit tables'
 * cases live in src/ui-kit/__tests__/table-scrollBox.test.tsx; this one sits
 * outside the kit because the kit's import-purity guard forbids importing the app.
 */

const STICKY_FIRST = '[&_tr>:first-child]:sticky';

describe('legacy data Table scrollBox', () => {
  it('scrolls sideways only, marks the box and pins the first column', () => {
    const { container } = render(
      <LegacyTable scrollBox="settings-tax-rates">
        <tbody>
          <tr>
            <td>State</td>
            <td>8%</td>
          </tr>
        </tbody>
      </LegacyTable>,
    );
    const box = container.querySelector('[data-mobile-scroll-x]')!;
    expect(box).toHaveAttribute('data-mobile-scroll-x', 'settings-tax-rates');
    const classes = box.className.split(/\s+/);
    expect(classes).toContain('overflow-x-auto');
    expect(classes).toContain('max-w-full');
    // Pinned at EVERY width, not only below md: in the Settings two-pane layout the box overflows
    // at 768-838 px too (iPad Mini, a landscape phone), and an unpinned Name column scrolled away.
    expect(classes).toContain(STICKY_FIRST);
    expect(classes.some((c) => c.startsWith('max-md:') && c.includes('sticky'))).toBe(false);
  });

  it('draws each row rule on the cells, so the pinned cell keeps its rule', () => {
    const { container } = render(
      <LegacyTable scrollBox="settings-tax-rates">
        <tbody>
          <tr className="border-b border-border">
            <td>State</td>
          </tr>
        </tbody>
      </LegacyTable>,
    );
    const box = container.querySelector('[data-mobile-scroll-x]')!;
    // Separated borders: a pinned cell paints above a collapsed grid and would cover the row's rule.
    expect(container.querySelector('table')!.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['border-separate', 'border-spacing-0']),
    );
    // The row keeps declaring its rule; each cell draws it (a row cannot paint a separated border).
    expect(box.className.split(/\s+/)).toContain('[&_tr>*]:[border-bottom:inherit]');
  });

  it('is a named, keyboard-focusable region', () => {
    const { getByRole } = render(
      <LegacyTable scrollBox="settings-tax-rates">
        <tbody>
          <tr>
            <td>State</td>
          </tr>
        </tbody>
      </LegacyTable>,
    );
    const region = getByRole('region', { name: 'Tax rates table' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toHaveAttribute('data-mobile-scroll-x', 'settings-tax-rates');
  });

  it('leaves a table without scrollBox exactly as before', () => {
    const { container } = render(
      <LegacyTable>
        <tbody>
          <tr>
            <td>State</td>
          </tr>
        </tbody>
      </LegacyTable>,
    );
    expect(container.querySelector('table')!.className).toBe('w-full caption-bottom text-sm');
  });
});
