/**
 * Mobile slice 50 at the sites: a vendor's, a team member's and a customer's number each offer Call
 * and Text; on a computer Call opens the dialer pre-filled and attributed, and Text opens that
 * conversation. The component's own behaviour is in components/contact/__tests__; this file is the
 * proof that the screens that used to hold a bare `tel:` link now hand their number to it.
 *
 * RED before the migration: each of these screens rendered an `<a href="tel:...">` (a link, with no
 * menu, no dialer and no attribution), so none of the `menuitem` assertions could be met.
 *
 * Nothing here places a call or sends a text: the dial handoff is a stand-in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';

import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { requestCall } from '@/lib/communication/phoneTabHandoff';
import { VendorCard } from '@/components/inventory/VendorCard';
import { TeamCard } from '@/components/jobs/TeamCard';
import { CustomerHeader } from '@/features/estimate-workspace/components/CustomerHeader';
import type { Vendor } from '@/lib/api/inventory';
import type { VendorSpend } from '@/lib/inventory/vendor-spend';
import type { PanelEstimate } from '@/features/estimate-workspace/lib/panelEstimate';

vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));
vi.mock('@/lib/axios', () => ({
  default: { get: vi.fn().mockResolvedValue({ data: { users: [] } }), post: vi.fn() },
}));

const dialer = buildAbility([{ action: 'create', subject: 'Communication' }]);

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{loc.pathname + loc.search}</p>;
}

beforeEach(() => {
  vi.mocked(requestCall).mockClear();
});

describe('a vendor card', () => {
  const vendor = {
    id: 'v1',
    name: 'Northside Supply',
    category: 'Security',
    status: 'active',
    contactPhone: '5551230000',
  } as unknown as Vendor;
  const spend = { ytd: 0, ytdPoCount: 0, lastOrderedAt: null } as unknown as VendorSpend;

  it('offers Call and Text on the vendor number, and a tap does not open the vendor', async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <VendorCard vendor={vendor} spend={spend} shareOfYTD={0} topShareOfYTD={1} onClick={onOpen} />
        <Where />
      </>,
      { ability: dialer },
    );

    await user.click(screen.getByRole('button', { name: '(555) 123-0000' }));
    expect(await screen.findByRole('menuitem', { name: /Call/ })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: /Text/ }));

    expect(screen.getByTestId('where')).toHaveTextContent('/communication/text?to=5551230000');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('Call on a vendor opens the dialer pre-filled with the number', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <VendorCard vendor={vendor} spend={spend} shareOfYTD={0} topShareOfYTD={1} onClick={() => {}} />,
      { ability: dialer },
    );

    await user.click(screen.getByRole('button', { name: '(555) 123-0000' }));
    await user.click(await screen.findByRole('menuitem', { name: /Call/ }));

    expect(requestCall).toHaveBeenCalledWith('5551230000', undefined);
  });
});

describe('a job team card', () => {
  const job = {
    id: 'job-1',
    dispatcher: { first_name: 'Dana', last_name: 'Brooks', phone: '5551234567' },
  };

  it('has explicit Call and Text buttons that skip the choice', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <TeamCard job={job} />
        <Where />
      </>,
      { ability: dialer },
    );

    await user.click(screen.getByRole('button', { name: 'Call Dana Brooks' }));
    expect(requestCall).toHaveBeenCalledWith('5551234567', undefined);
    expect(screen.queryByRole('menuitem')).toBeNull();

    await user.click(screen.getByRole('link', { name: 'Text Dana Brooks' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/communication/text?to=5551234567');
  });
});

describe('the estimate customer header', () => {
  const estimate = {
    id: 'e1',
    estimate_number: 'E00123',
    status: 'DRAFT',
    tax_rate: 0,
    created_at: '2026-07-20T00:00:00.000Z',
    lead_id: null,
    lead: null,
    customer_id: 'cust-1',
    customer: { first_name: 'Dana', last_name: 'Whitfield', phone: '5550001111' },
  } as unknown as PanelEstimate;

  it('offers Call and Text on the customer number, attributed to the customer', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <CustomerHeader estimate={estimate} />
        <Where />
      </>,
      { ability: dialer },
    );

    await user.click(screen.getByRole('button', { name: '5550001111' }));
    await user.click(await screen.findByRole('menuitem', { name: /Call/ }));
    expect(requestCall).toHaveBeenCalledWith('5550001111', {
      customerId: 'cust-1',
      customerName: 'Dana Whitfield',
      leadId: undefined,
      leadLabel: undefined,
    });

    await user.click(screen.getByRole('button', { name: '5550001111' }));
    await user.click(await screen.findByRole('menuitem', { name: /Text/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('/communication/text?customerId=cust-1');
  });

  it('is a plain device call link for a user who may not place calls', () => {
    renderWithProviders(<CustomerHeader estimate={estimate} />, {
      ability: buildAbility([{ action: 'read', subject: 'Communication' }]),
    });

    expect(screen.getByRole('link', { name: '5550001111' })).toHaveAttribute('href', 'tel:5550001111');
  });
});
