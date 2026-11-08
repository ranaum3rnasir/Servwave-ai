/**
 * ContactCell has to stay inside its own column.
 *
 * RED before the fix: on /v2/customers a long email address rendered outside the
 * Email column and painted over the Address values beside it. The kit Button is
 * `inline-flex` + `whitespace-nowrap`, so the address could not wrap and
 * `break-words` on the `<td>` had nothing it was allowed to break; the wrapper's
 * min-content size was therefore the whole address and it refused to shrink to
 * the column, and a `<td>` does not clip.
 *
 * jsdom performs no layout, so these cases pin the MECHANISM rather than the
 * geometry: the flex chain that carries the value may shrink, the value clips
 * itself with an ellipsis, the copy control does not take the width from the
 * value, and the full value stays reachable on `title`. Whether the ellipsis
 * lands in the right place is a browser check.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { buildCustomerColumns } from '../../customers/customersColumns';
import { buildLeadColumns } from '../../leads/leadsColumns';
import { ContactCell } from '../contactCell';

const LONG_EMAIL = 'accounts.receivable.department@really-long-company-domain.example.com';

beforeEach(() => {
  // Not implemented in jsdom, and the copy control reaches for it on click.
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true,
  });
});

/** The control that carries the value itself, not the copy button beside it. */
function valueControl(label: string): HTMLElement {
  return screen.getByRole('button', { name: label });
}

describe('ContactCell containment', () => {
  it('clips the value with an ellipsis instead of letting it leave the cell', () => {
    render(<ContactCell type="email" value={LONG_EMAIL} />);

    const clipped = valueControl(LONG_EMAIL).querySelector('.truncate');
    expect(clipped).not.toBeNull();
    expect(clipped).toHaveTextContent(LONG_EMAIL);
  });

  it('lets every level of the flex chain shrink, or the truncation cannot happen', () => {
    const { container } = render(<ContactCell type="email" value={LONG_EMAIL} />);

    // The wrapper is clamped to the cell's content box AND allowed to shrink
    // below its content; the value control zeroes the automatic minimum size
    // that a flex item gets by default.
    const wrapper = container.firstElementChild;
    expect(wrapper).toHaveClass('min-w-0');
    expect(wrapper).toHaveClass('max-w-full');
    expect(valueControl(LONG_EMAIL)).toHaveClass('min-w-0');
  });

  it('makes the value yield the width, not the copy control', () => {
    render(<ContactCell type="email" value={LONG_EMAIL} />);

    expect(screen.getByRole('button', { name: 'Copy email address' })).toHaveClass('shrink-0');
  });

  it('keeps the full value reachable on title once it is clipped', () => {
    render(<ContactCell type="email" value={LONG_EMAIL} />);

    expect(valueControl(LONG_EMAIL)).toHaveAttribute('title', LONG_EMAIL);
  });

  it('titles a phone with the formatted value it displays, not the raw store', () => {
    render(<ContactCell type="phone" value="5551234567" />);

    expect(valueControl('(555) 123-4567')).toHaveAttribute('title', '(555) 123-4567');
  });
});

describe('the columns that use ContactCell leave room for a phone', () => {
  /**
   * Coupled to the truncation above: a formatted US number measures ~99px at
   * this type size and the cell also carries the 24px copy control plus its 4px
   * gap, so a 140px column (108px of content box) is short. It never showed
   * while the cell overhung its own padding instead of truncating.
   */
  it.each([
    ['customers', () => buildCustomerColumns([], () => {}, true)],
    // The third argument is the org tz (#1634), not a `selectable` flag - the
    // selection column stays dropped from this list. A fixed literal stands
    // in for the tz since this assertion is unrelated to date rendering.
    ['leads', () => buildLeadColumns([], () => {}, 'America/New_York')],
  ])('%s sizes Phone for the number plus the copy control', (_name, build) => {
    const phone = build().find((column) => column.id === 'phone');
    expect(phone?.size).toBe(160);
  });
});
