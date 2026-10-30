// Roles & Permissions S08.10 - the payments received as entries on the record's Communication tab.
// An entry says what was paid and whether the customer paid online or the office recorded it, with the amount the server
// sent (the server leaves the entry out for anyone who cannot open the invoice). It offers no reply, no attach menu and no
// open-detail action, reads the same on a job's, a lead's and a customer's tab, and names no payment provider.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { JobCommunicationsTab } from '@/components/communication/JobCommunicationsTab';
import { LeadCommunicationsTab } from '@/components/communication/LeadCommunicationsTab';
import { CustomerCommunicationsTab } from '@/components/communication/CustomerCommunicationsTab';
import { CommRow } from '@/components/communication/shared/CommRow';
import type { CommItem } from '@/lib/api/jobCommunications';

const mockApi = vi.mocked(api);

// A phone-enabled organization, so the attach menu WOULD render on a platform row for a person who may attach.
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => true,
}));
vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));
vi.mock('@/components/communication/shared/EntityCallDrawer', () => ({
  EntityCallDrawer: () => <div data-testid="entity-call-drawer" />,
}));
vi.mock('@/components/communication/shared/EntitySmsDrawer', () => ({
  EntitySmsDrawer: () => <div data-testid="entity-sms-drawer" />,
}));

const JOB_ID = 'b0000000-0000-0000-0000-000000000001';
const LEAD_ID = 'e0000000-0000-0000-0000-000000000007';
const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';

const ONLINE: CommItem = {
  id: 'pay00000-0000-0000-0000-000000000001',
  channel: 'portal',
  direction: 'in',
  who: 'Daniel Cohen',
  title: 'Payment received on invoice INV-0042',
  preview: 'Paid online',
  at: '2026-06-03T14:32:00.000Z',
  jobId: JOB_ID,
  jobLabel: 'J00042',
  entry: 'payment_received',
  amount: 1250.5,
  paidVia: 'online',
};
const OFFICE: CommItem = {
  ...ONLINE,
  id: 'pay00000-0000-0000-0000-000000000002',
  title: 'Payment received on deposit D-0007',
  preview: 'Recorded by the office',
  amount: 300,
  paidVia: 'office',
};

// A person who may attach conversations: every platform row would carry the attach menu.
const ability = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'create', subject: 'Communication' },
  { action: 'attach', subject: 'Communication' },
]);

const rowOf = (title: string) => screen.getByText(title).closest('li') as HTMLElement;

function expectAPlainEntry(li: HTMLElement) {
  // No reply, attach or open-detail control: nothing in the row can be pressed except the record chips' links.
  expect(within(li).queryByRole('button')).toBeNull();
  expect(li).not.toHaveAttribute('role', 'button');
  // Words only a customer would use: the payment provider is never named.
  expect(li.textContent).not.toMatch(/stripe|square|paypal|processor/i);
}

describe('the payments received on a job\'s tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.get.mockResolvedValue({ data: { items: [ONLINE, OFFICE] } });
  });

  it('shows each payment with its amount and whether it was paid online or recorded by the office', async () => {
    renderWithProviders(
      <JobCommunicationsTab jobId={JOB_ID} jobNumber="J00042" customerId={CUSTOMER_ID} customerName="Daniel Cohen" />,
      { ability },
    );
    expect(await screen.findByText(ONLINE.title)).toBeInTheDocument();

    const online = rowOf(ONLINE.title);
    expect(within(online).getByText('$1,250.50')).toBeInTheDocument();
    expect(within(online).getByText('Paid online')).toBeInTheDocument();

    const office = rowOf(OFFICE.title);
    expect(within(office).getByText('$300.00')).toBeInTheDocument();
    expect(within(office).getByText('Recorded by the office')).toBeInTheDocument();
  });

  it('offers no reply, attach or open action on an entry, and names no provider', async () => {
    renderWithProviders(
      <JobCommunicationsTab jobId={JOB_ID} jobNumber="J00042" customerId={CUSTOMER_ID} customerName="Daniel Cohen" />,
      { ability },
    );
    await screen.findByText(ONLINE.title);
    for (const title of [ONLINE.title, OFFICE.title]) expectAPlainEntry(rowOf(title));
  });

  it('does not call a payment an inbound message', async () => {
    renderWithProviders(
      <JobCommunicationsTab jobId={JOB_ID} jobNumber="J00042" customerId={CUSTOMER_ID} customerName="Daniel Cohen" />,
      { ability },
    );
    await screen.findByText(ONLINE.title);
    expect(within(rowOf(ONLINE.title)).queryByText(/Inbound/)).toBeNull();
    expect(within(rowOf(ONLINE.title)).getByText('Payment')).toBeInTheDocument();
  });
});

describe('the payments received on a lead\'s tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.get.mockResolvedValue({ data: { items: [{ ...OFFICE, jobId: undefined, jobLabel: undefined, leadId: LEAD_ID, leadLabel: 'L00007' }] } });
  });

  it('renders a lead-stage deposit as a plain entry with its amount', async () => {
    renderWithProviders(
      <LeadCommunicationsTab leadId={LEAD_ID} leadLabel="L00007" customerId={CUSTOMER_ID} customerName="Daniel Cohen" />,
      { ability },
    );
    const row = (await screen.findByText(OFFICE.title)).closest('li') as HTMLElement;
    expect(within(row).getByText('$300.00')).toBeInTheDocument();
    expectAPlainEntry(row);
  });
});

describe('the payments received on a customer\'s tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.get.mockResolvedValue({ data: { items: [ONLINE] } });
  });

  it('renders the payment as a plain entry', async () => {
    renderWithProviders(<CustomerCommunicationsTab customerId={CUSTOMER_ID} />, { ability });
    const row = (await screen.findByText(ONLINE.title)).closest('li') as HTMLElement;
    expect(within(row).getByText('$1,250.50')).toBeInTheDocument();
    expectAPlainEntry(row);
  });
});

describe('a payment row on its own', () => {
  it('does not claim to be a hand-entered record or a transactional email, and its icon is not the estimate decision\'s', () => {
    renderWithProviders(
      <ol>
        <CommRow item={ONLINE} formatTimestamp={(at) => at} tz="America/New_York" customerId={CUSTOMER_ID} />
      </ol>,
      { ability },
    );
    const li = screen.getByText(ONLINE.title).closest('li') as HTMLElement;
    expect(within(li).queryByText('Logged')).toBeNull();
    expect(within(li).queryByText(/auto · transactional/)).toBeNull();
    expect(within(li).queryByText(/Inbound/)).toBeNull();
    expect(li.querySelector('svg.lucide-banknote')).not.toBeNull();
    expect(li.querySelector('svg.lucide-clipboard-check')).toBeNull();
  });
});
