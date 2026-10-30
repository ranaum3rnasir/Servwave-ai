// Roles & Permissions S08.9 - the customer's estimate decisions as entries on the record's Communication tab.
// An entry says what the customer did on their own link: "estimate approved" or "estimate declined", the latter
// with the reason they picked and their own words. It offers no reply, no attach menu and no open-detail action,
// carries no total, and reads the same on a job's tab, a lead's tab and a customer's tab.
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

const APPROVED: CommItem = {
  id: 'ev000000-0000-0000-0000-000000000001',
  channel: 'portal',
  direction: 'in',
  who: 'Daniel Cohen',
  title: 'Estimate E00012 approved by the customer',
  preview: '',
  at: '2026-06-01T14:32:00.000Z',
  jobId: JOB_ID,
  jobLabel: 'J00042',
  entry: 'estimate_approved',
};
const DECLINED: CommItem = {
  id: 'ev000000-0000-0000-0000-000000000002',
  channel: 'portal',
  direction: 'in',
  who: 'Daniel Cohen',
  title: 'Estimate E00013 declined by the customer',
  preview: 'Price - Another quote came in lower',
  at: '2026-06-02T09:30:00.000Z',
  jobId: JOB_ID,
  jobLabel: 'J00042',
  entry: 'estimate_declined',
  reason: 'Price',
  reasonNote: 'Another quote came in lower',
};
const DECLINED_BARE: CommItem = { ...DECLINED, id: 'ev000000-0000-0000-0000-000000000003', title: 'Estimate E00014 declined by the customer', preview: '', reason: undefined, reasonNote: undefined };

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
  // No total, no money of any kind.
  expect(li.textContent).not.toMatch(/\$|\btotal\b|\bdeposit\b/i);
}

describe('the customer\'s estimate decisions on a job\'s tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.get.mockResolvedValue({ data: { items: [APPROVED, DECLINED, DECLINED_BARE] } });
  });

  it('shows the approval and the decline with the reason the customer picked and their own words', async () => {
    renderWithProviders(
      <JobCommunicationsTab jobId={JOB_ID} jobNumber="J00042" customerId={CUSTOMER_ID} customerName="Daniel Cohen" />,
      { ability },
    );
    expect(await screen.findByText(APPROVED.title)).toBeInTheDocument();

    const declined = rowOf(DECLINED.title);
    expect(within(declined).getByText(/Price/)).toBeInTheDocument();
    expect(within(declined).getByText(/Another quote came in lower/)).toBeInTheDocument();
    // It says whose action it was, not that something came in.
    expect(within(declined).getByText(/Customer/)).toBeInTheDocument();
    expect(within(declined).queryByText(/Inbound/)).toBeNull();
  });

  it('offers no reply, attach or open action on an entry, and no total', async () => {
    renderWithProviders(
      <JobCommunicationsTab jobId={JOB_ID} jobNumber="J00042" customerId={CUSTOMER_ID} customerName="Daniel Cohen" />,
      { ability },
    );
    await screen.findByText(APPROVED.title);
    for (const title of [APPROVED.title, DECLINED.title, DECLINED_BARE.title]) expectAPlainEntry(rowOf(title));
  });

  it('says nothing about a reason when the customer gave none', async () => {
    renderWithProviders(
      <JobCommunicationsTab jobId={JOB_ID} jobNumber="J00042" customerId={CUSTOMER_ID} customerName="Daniel Cohen" />,
      { ability },
    );
    await screen.findByText(APPROVED.title);
    expect(within(rowOf(DECLINED_BARE.title)).queryByText(/reason/i)).toBeNull();
  });
});

describe('the customer\'s estimate decisions on a lead\'s tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.get.mockResolvedValue({ data: { items: [{ ...DECLINED, jobId: undefined, jobLabel: undefined, leadId: LEAD_ID, leadLabel: 'L00007' }] } });
  });

  it('renders the decline with its reason and words and no reply or attach control', async () => {
    renderWithProviders(
      <LeadCommunicationsTab leadId={LEAD_ID} leadLabel="L00007" customerId={CUSTOMER_ID} customerName="Daniel Cohen" />,
      { ability },
    );
    const row = (await screen.findByText(DECLINED.title)).closest('li') as HTMLElement;
    expect(within(row).getByText(/Another quote came in lower/)).toBeInTheDocument();
    expectAPlainEntry(row);
  });
});

describe('the customer\'s estimate decisions on a customer\'s tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.get.mockResolvedValue({ data: { items: [APPROVED] } });
  });

  it('renders the approval as a plain entry', async () => {
    renderWithProviders(<CustomerCommunicationsTab customerId={CUSTOMER_ID} />, { ability });
    const row = (await screen.findByText(APPROVED.title)).closest('li') as HTMLElement;
    expectAPlainEntry(row);
  });
});

describe('an entry row on its own', () => {
  it('does not claim to be an inbound conversation or a hand-entered record', () => {
    renderWithProviders(
      <ol>
        <CommRow item={DECLINED} formatTimestamp={(at) => at} tz="America/New_York" customerId={CUSTOMER_ID} />
      </ol>,
      { ability },
    );
    const li = screen.getByText(DECLINED.title).closest('li') as HTMLElement;
    expect(within(li).queryByText('Logged')).toBeNull();
    expect(within(li).queryByText(/auto · transactional/)).toBeNull();
    expect(within(li).queryByText(/Inbound/)).toBeNull();
  });
});
