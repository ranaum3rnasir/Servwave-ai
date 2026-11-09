/// <reference types="@testing-library/jest-dom/vitest" />
// V7-07a: the customer block and its one-click actions (house rules 23, 24). Nothing is dialled or sent: the phone
// hand-off is a stand-in and every other action is a link.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import type { PaymentCustomerBlock } from '@/lib/api/paymentsPage';

const state = vi.hoisted(() => ({
  switches: {} as Record<string, boolean>,
  features: { phone: true, email: true } as Record<string, boolean>,
  bridge: false,
}));

vi.mock('@/lib/api/shared/mySwitches', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/shared/mySwitches')>()),
  useMySwitches: () => ({ admin_box: false, values: state.switches }),
}));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: (key: string) => state.features[key] ?? false,
}));
vi.mock('@/lib/device/usesBridgeTransport', () => ({ usesBridgeTransport: () => state.bridge }));
vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));

import { requestCall } from '@/lib/communication/phoneTabHandoff';
import { CustomerBlock } from '../components/CustomerBlock';

const FULL: PaymentCustomerBlock = {
  restricted: false,
  id: 'cust-1',
  customer_number: 'C-1042',
  name: 'Dana Reyes',
  company: 'Reyes Hardware',
  address: '12 Oak St, Austin, TX 78701',
  phone: '5551234567',
  email: 'dana@example.com',
  job: { id: 'job-1', number: 'J-4100', type: 'Lock change' },
  lead: { id: 'lead-1', number: 'L-2200' },
  invoice: { id: 'inv-1', number: 'INV-1001' },
};
const EMPTY: PaymentCustomerBlock = { ...FULL, company: null, address: null, phone: null, email: null, job: null, lead: null };

const ALL_ACCESS = buildAbility([
  { action: 'access_inbox', subject: 'Communication' },
  { action: 'read', subject: 'Job' },
  { action: 'read', subject: 'Lead' },
  { action: 'read', subject: 'Invoice' },
]);
const NO_ACCESS = buildAbility([]);
const GOOD_SWITCHES = { view_customers: true, contact_customers: true, show_text: true, show_email: true };

const mockCall = vi.mocked(requestCall);
function draw(block: PaymentCustomerBlock, ability = ALL_ACCESS, email = {}) {
  return renderWithProviders(<CustomerBlock block={block} email={email} />, { ability });
}
const region = () => screen.getByRole('region', { name: 'Customer' });

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.switches = { ...GOOD_SWITCHES };
  state.features = { phone: true, email: true };
  state.bridge = false;
});

describe('a customer with everything', () => {
  it('shows name, ID, company, address, phone, email and the job, lead and invoice chips', () => {
    draw(FULL);
    const r = within(region());
    expect(r.getByText('DR')).toBeInTheDocument();
    expect(r.getByRole('link', { name: /Dana Reyes/ })).toHaveAttribute('href', '/customers/cust-1');
    expect(r.getByRole('link', { name: /C-1042/ })).toHaveAttribute('href', '/customers/cust-1');
    expect(r.getByText('Reyes Hardware')).toBeInTheDocument();
    expect(r.getByRole('button', { name: '12 Oak St, Austin, TX 78701' })).toBeInTheDocument();
    expect(r.getByText('(555) 123-4567')).toBeInTheDocument();
    expect(r.getByText('dana@example.com')).toBeInTheDocument();
    expect(r.getByRole('link', { name: /Job J-4100 · Lock change/ })).toHaveAttribute('href', '/jobs/job-1');
    expect(r.getByRole('link', { name: /Lead L-2200/ })).toHaveAttribute('href', '/leads/lead-1');
    expect(r.getByRole('link', { name: /Invoice INV-1001/ })).toHaveAttribute('href', '/invoices/inv-1');
  });

  it('every link opens a new tab safely', () => {
    draw(FULL);
    for (const link of within(region()).getAllByRole('link')) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });

  it('Call hands the number and its context to the phone tab, and carries the new-tab icon', async () => {
    draw(FULL);
    const call = within(region()).getByRole('button', { name: /^Call/ });
    expect(call.querySelector('svg.lucide-external-link')).not.toBeNull();
    await userEvent.setup().click(call);
    expect(mockCall).toHaveBeenCalledWith('5551234567', { customerId: 'cust-1', customerName: 'Dana Reyes', jobId: 'job-1', jobLabel: 'J-4100', leadId: 'lead-1' });
  });

  it('Call draws no new-tab icon where the phone opens in the page (the bridge transport)', () => {
    state.bridge = true;
    draw(FULL);
    expect(within(region()).getByRole('button', { name: /^Call/ }).querySelector('svg.lucide-external-link')).toBeNull();
  });

  it('Text and Email are new-tab links to the conversation and the filled compose window', () => {
    draw(FULL, ALL_ACCESS, { subject: 'Bank payment failed - Invoice INV-1001', body: 'Hello Dana' });
    const r = within(region());
    // Only the lead's own page carries the lead on a Text (SPEC-4 §6.8); Call still carries it (above).
    expect(r.getByRole('link', { name: /^Text/ })).toHaveAttribute('href', '/communication/text?customerId=cust-1');
    const href = new URL(r.getByRole('link', { name: /^Email/ }).getAttribute('href')!, 'http://h');
    expect(href.pathname).toBe('/communication/inbox');
    expect(Object.fromEntries(href.searchParams)).toEqual({
      compose: '1', to: 'dana@example.com', subject: 'Bank payment failed - Invoice INV-1001', body: 'Hello Dana',
      customerId: 'cust-1', jobId: 'job-1', invoiceId: 'inv-1',
    });
  });

  it('the address opens a dialog with the address, Open in Maps (new tab) and Close', async () => {
    draw(FULL);
    const u = userEvent.setup();
    await u.click(within(region()).getByRole('button', { name: '12 Oak St, Austin, TX 78701' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dana Reyes' });
    const maps = within(dialog).getByRole('link', { name: /Open in Maps/ });
    expect(maps.getAttribute('href')).toContain(encodeURIComponent('12 Oak St, Austin, TX 78701'));
    expect(maps).toHaveAttribute('target', '_blank');
    await u.click(within(dialog).getAllByRole('button', { name: 'Close' }).at(-1)!);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('a customer with nothing on file', () => {
  it('says so, dims the buttons with the reason, and shows no job or lead link', () => {
    draw(EMPTY);
    const r = within(region());
    expect(r.getByText('No address on file')).toBeInTheDocument();
    expect(r.getByText('No phone on file')).toBeInTheDocument();
    expect(r.getByText('No email on file')).toBeInTheDocument();
    for (const [name, why] of [['Call', 'No phone on file'], ['Text', 'No phone on file'], ['Email', 'No email on file']] as const) {
      const b = r.getByRole('button', { name });
      expect(b).toHaveAttribute('aria-disabled', 'true');
      expect(b).toHaveAttribute('title', why);
    }
    expect(r.getByText('No job linked')).toBeInTheDocument();
    expect(r.getByText('No lead linked')).toBeInTheDocument();
    expect(r.queryByRole('link', { name: /Job|Lead/ })).not.toBeInTheDocument();
    expect(r.getByRole('link', { name: /Invoice INV-1001/ })).toBeInTheDocument();
  });

  it('a dimmed Call does nothing', async () => {
    draw(EMPTY);
    await userEvent.setup().click(within(region()).getByRole('button', { name: 'Call' }));
    expect(mockCall).not.toHaveBeenCalled();
  });
});

describe('restricted and policy cases', () => {
  it('a restricted viewer reads one line and no details', () => {
    draw({ customer: null, restricted: true });
    expect(within(region()).getByText('Customer details are restricted for your role.')).toBeInTheDocument();
    expect(within(region()).queryByRole('link')).not.toBeInTheDocument();
  });

  it('name and ID are plain text for a viewer who may not view customers', () => {
    state.switches = { ...GOOD_SWITCHES, view_customers: false };
    draw(FULL);
    const r = within(region());
    expect(r.getByText('Dana Reyes')).toBeInTheDocument();
    expect(r.queryByRole('link', { name: /Dana Reyes|C-1042/ })).not.toBeInTheDocument();
    expect(r.getByText('C-1042')).toBeInTheDocument();
  });

  it('the job, lead and invoice chips are left out for a viewer who may not open those records', () => {
    draw(FULL, NO_ACCESS);
    const r = within(region());
    expect(r.queryByText(/J-4100/)).not.toBeInTheDocument();
    expect(r.queryByText(/L-2200/)).not.toBeInTheDocument();
    expect(r.queryByText(/INV-1001/)).not.toBeInTheDocument();
  });

  it('Text and Email are hidden without Access communication or the Show switch', () => {
    draw(FULL, NO_ACCESS);
    expect(within(region()).queryByRole('link', { name: /^Text|^Email/ })).not.toBeInTheDocument();
    cleanup();
    state.switches = { ...GOOD_SWITCHES, show_text: false, show_email: false };
    draw(FULL);
    expect(within(region()).queryByRole('link', { name: /^Text|^Email/ })).not.toBeInTheDocument();
    expect(within(region()).getByRole('button', { name: /^Call/ })).toBeInTheDocument();
  });

  it('no phone service: Call and Text are the device links, and Email follows the email service', () => {
    state.features = { phone: false, email: false };
    state.switches = { ...GOOD_SWITCHES, copy_customer_phone: true };
    draw(FULL);
    const r = within(region());
    expect(r.getByRole('link', { name: 'Call' })).toHaveAttribute('href', 'tel:5551234567');
    expect(r.getByRole('link', { name: 'Text' })).toHaveAttribute('href', 'sms:5551234567');
    expect(r.queryByRole('link', { name: /^Email/ })).not.toBeInTheDocument();
  });

  it('a viewer who may not contact customers (phone service on) gets no Call and no Text', () => {
    state.switches = { ...GOOD_SWITCHES, contact_customers: false };
    draw(FULL);
    expect(within(region()).queryByRole('button', { name: /^Call/ })).not.toBeInTheDocument();
    expect(within(region()).queryByRole('link', { name: /^Text/ })).not.toBeInTheDocument();
  });
});

describe('fix round 1', () => {
  it('the customer name link is 44px tall on a phone (12px padding) and keeps its new-tab icon beside the text', () => {
    draw(FULL);
    const name = within(region()).getByRole('link', { name: /Dana Reyes/ });
    expect(name.className).toContain('max-md:min-h-11');
    expect(name.className).toContain('max-md:py-3');
    expect(name.className).toContain('inline-flex');
    expect(name.className).not.toContain('overflow-wrap');
  });

  it('Escape on the address dialog puts focus back on the address button', async () => {
    draw(FULL);
    const u = userEvent.setup();
    const address = within(region()).getByRole('button', { name: '12 Oak St, Austin, TX 78701' });
    await u.click(address);
    await screen.findByRole('dialog', { name: 'Dana Reyes' });
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(address).toHaveFocus();
  });

  it('draws no links row (and no divider) when the viewer may open none of the records', () => {
    draw(FULL, NO_ACCESS);
    expect(within(region()).queryByRole('group', { name: 'Related records' })).not.toBeInTheDocument();
    cleanup();
    draw(FULL);
    expect(within(region()).getByRole('group', { name: 'Related records' })).toBeInTheDocument();
  });

  it('Call, Text and Email share one look', () => {
    draw(FULL);
    const r = within(region());
    const looks = [r.getByRole('button', { name: /^Call/ }), r.getByRole('link', { name: /^Text/ }), r.getByRole('link', { name: /^Email/ })]
      .map((el) => el.className.split(/\s+/).filter((c) => !c.startsWith('max-') && !c.startsWith('inline') && !c.startsWith('cursor') && !c.startsWith('opacity')).sort().join(' '));
    expect(new Set(looks).size).toBe(1);
  });
});
