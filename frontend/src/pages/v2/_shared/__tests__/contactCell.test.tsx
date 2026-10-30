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
 *
 * The cell draws through the contact display policy (Roles & Permissions S05.5); these cases run as a person who holds
 * both copy switches and Contact customers, so the containment is checked on the fullest version of the cell. What
 * each switch takes away is in __tests__/list-contact-cell-policy.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { renderWithProviders, seedMySwitches } from '@/__tests__/helpers';
import { catalogToggle } from '@/__tests__/support/backendSwitchCatalog';
import { requestCall } from '@/lib/communication/phoneTabHandoff';

import { buildCustomerColumns } from '../../customers/customersColumns';
import { buildLeadColumns } from '../../leads/leadsColumns';
import { ContactCell } from '../contactCell';

vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));

// Whether the company has the phone service, toggled per test.
const phoneService = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/entitlements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements')>();
  return {
    ...actual,
    useFeature: (feature: Parameters<typeof actual.useFeature>[0]) =>
      feature === 'phone' ? phoneService.value : actual.useFeature(feature),
  };
});

const LONG_EMAIL = 'accounts.receivable.department@really-long-company-domain.example.com';

/** A person who holds both copy switches and Contact customers. */
const EVERYTHING_ON = {
  [catalogToggle('Copy customer phone').key]: true,
  [catalogToggle('Copy customer email').key]: true,
  [catalogToggle('Contact customers').key]: true,
  [catalogToggle('View customers').key]: true,
};

function renderCell(ui: React.ReactElement) {
  seedMySwitches(EVERYTHING_ON);
  vi.mocked(api.get).mockImplementation(async (url: string) =>
    url === '/api/permission-switches/me' ? { data: { admin_box: false, values: EVERYTHING_ON } } : { data: {} },
  );
  return renderWithProviders(ui);
}

beforeEach(() => {
  localStorage.clear();
  phoneService.value = true;
  vi.mocked(requestCall).mockClear();
  // Not implemented in jsdom, and the copy control reaches for it on click.
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true,
  });
});

/** The control that carries the value itself, not the copy button beside it. */
function valueControl(label: string): HTMLElement {
  return screen.getByRole('link', { name: label });
}

describe('ContactCell containment', () => {
  it('clips the value with an ellipsis instead of letting it leave the cell', () => {
    renderCell(<ContactCell type="email" value={LONG_EMAIL} />);

    const clipped = valueControl(LONG_EMAIL).querySelector('.truncate');
    expect(clipped).not.toBeNull();
    expect(clipped).toHaveTextContent(LONG_EMAIL);
  });

  it('lets every level of the flex chain shrink, or the truncation cannot happen', () => {
    const { container } = renderCell(<ContactCell type="email" value={LONG_EMAIL} />);

    // The wrapper is clamped to the cell's content box AND allowed to shrink
    // below its content; the value control zeroes the automatic minimum size
    // that a flex item gets by default.
    const wrapper = container.firstElementChild;
    expect(wrapper).toHaveClass('min-w-0');
    expect(wrapper).toHaveClass('max-w-full');
    expect(wrapper?.firstElementChild).toHaveClass('min-w-0');
    expect(wrapper?.firstElementChild).toHaveClass('max-w-full');
    expect(valueControl(LONG_EMAIL)).toHaveClass('min-w-0');
  });

  it('makes the value yield the width, not the copy control', () => {
    renderCell(<ContactCell type="email" value={LONG_EMAIL} />);

    expect(screen.getByRole('button', { name: 'Copy email address' })).toHaveClass('shrink-0');
  });

  it('keeps the full value reachable on title once it is clipped', () => {
    renderCell(<ContactCell type="email" value={LONG_EMAIL} />);

    expect(valueControl(LONG_EMAIL)).toHaveAttribute('title', LONG_EMAIL);
  });

  it('titles a phone with the formatted value it displays, not the raw store', () => {
    renderCell(<ContactCell type="phone" value="5551234567" />);

    expect(screen.getByText('(555) 123-4567')).toHaveAttribute('title', '(555) 123-4567');
  });
});

/**
 * The phone in a table is the contact display policy's: with the phone service and Contact customers a tap offers
 * Call or Text in the app (never a bare dial), attributed to the row's record, and a tap never reaches the row's own
 * click handler.
 */
describe('ContactCell phone: tap action', () => {
  it('offers Call and Text, and Call opens the dialer attributed to the row', async () => {
    const onRow = vi.fn();
    const user = userEvent.setup();
    renderCell(
      <div onClick={onRow}>
        <ContactCell type="phone" value="5551234567" context={{ customerId: 'cust-1', customerName: 'Dana Reyes' }} />
      </div>,
    );

    await user.click(screen.getByRole('button', { name: '(555) 123-4567' }));
    expect(await screen.findByRole('menuitem', { name: /Text/ })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: /Call/ }));

    expect(requestCall).toHaveBeenCalledWith('5551234567', { customerId: 'cust-1', customerName: 'Dana Reyes' });
    expect(onRow).not.toHaveBeenCalled();
  });

  it('an org without the phone service gets a native call link when the person may copy the number', () => {
    phoneService.value = false;
    renderCell(<ContactCell type="phone" value="5551234567" />);

    expect(screen.getByRole('link', { name: '(555) 123-4567' })).toHaveAttribute('href', 'tel:5551234567');
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
