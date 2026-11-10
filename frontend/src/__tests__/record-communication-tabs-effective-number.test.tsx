// #3016 - a lead or job texts and calls the number it shows.
//
// A lead's or job's effective number is its changed number for the customer's primary, else the customer's primary.
// On both Communication tabs "Call customer" dials it, before and after a refresh, and the text box sends the text
// anchored on the record, naming no number: the server takes the destination from the record.
//
// Each tab is drawn on its record the way the record page holds it: the record read from the API, and the pencil's real
// change hook writing the record's entries into the same cache. The API is mocked at the network edge only (the axios
// instance), and the call at the browser edge (the phone tab the call opens).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { LeadCommunicationsTab } from '@/components/communication/LeadCommunicationsTab';
import { JobCommunicationsTab } from '@/components/communication/JobCommunicationsTab';
import { useChangeContactEntry, type RecordContactEntry } from '@/lib/api/recordContactEntries';

const mockApi = vi.mocked(api);

// The composer and "Call customer" render only when the org has the phone service. The setup's signed-in user carries no
// org_features, and the real useFeature reads that as available, so nothing here stands in for the entitlements module.

const LEAD_ID = 'e0000000-0000-0000-0000-000000003016';
const JOB_ID = 'b0000000-0000-0000-0000-000000003016';
const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000003016';
const CUSTOMER = {
  id: CUSTOMER_ID, first_name: 'Pat', last_name: 'Payer', company_name: null, email: null, phone: '5550103002',
  phones: [{ phone: '5550103002', label: null, extension: null, is_primary: true }],
};

/** The pencil's change of the customer's primary to (555) 010-5252 on this record, as the API answers it. */
function changedPrimary(record: 'lead' | 'job'): RecordContactEntry {
  return {
    id: `0e000000-0000-0000-0000-00000000${record === 'lead' ? '0001' : '0002'}`,
    kind: 'PHONE', intent: 'CHANGED', value: '5550105252', extension: null, label: null,
    overridden_field: 'phone', overridden_row_id: null, customer_value_at_change: '5550103002',
    created_by: { id: null, name: 'Riley Brooks' }, created_at: '2026-11-05T10:00:00.000Z',
    updated_by: { id: null, name: 'Riley Brooks' }, updated_at: '2026-11-05T10:00:00.000Z', source_entry_id: null,
  };
}

const ability = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'create', subject: 'Communication' },
]);

/** The API: the record with the entries it holds, an empty timeline, and the pencil's change answering the new entry. */
function serve(record: 'lead' | 'job', entries: RecordContactEntry[]) {
  const id = record === 'lead' ? LEAD_ID : JOB_ID;
  mockApi.get.mockImplementation((url: string) => {
    if (url === `/api/${record}s/${id}`) {
      return Promise.resolve({ data: { [record]: { id, customer: CUSTOMER, contact_entries: entries } } });
    }
    if (url === `/api/${record}s/${id}/communications`) return Promise.resolve({ data: { items: [] } });
    return Promise.resolve({ data: {} });
  });
  mockApi.post.mockImplementation((url: string) => {
    if (url === `/api/${record}s/${id}/contact-entries/change`) return Promise.resolve({ data: { entries: [changedPrimary(record)] } });
    return Promise.resolve({ data: { message: { id: 'm1', direction: 'out', status: 'sent' }, delivery: 'sent' } });
  });
}

type RecordRow = { customer: typeof CUSTOMER; contact_entries: RecordContactEntry[] };

/** The record's page around its tab: the record from the API, and the pencil changing the customer's primary. */
function OnRecord({ record }: { record: 'lead' | 'job' }) {
  const id = record === 'lead' ? LEAD_ID : JOB_ID;
  const { data } = useQuery({
    queryKey: [record, id],
    queryFn: () => api.get(`/api/${record}s/${id}`).then((r) => r.data[record] as RecordRow),
  });
  const change = useChangeContactEntry({ kind: record, id });
  if (!data) return null;
  return (
    <>
      <button type="button" onClick={() => change.mutate({ kind: 'PHONE', replaces: '5550103002', value: '5550105252' })}>
        Pencil: change the phone
      </button>
      {record === 'lead' ? (
        <LeadCommunicationsTab
          leadId={LEAD_ID} leadLabel="L19835" customerId={CUSTOMER_ID} customerName="Pat Payer"
          customerPhone={data.customer.phone} contactEntries={data.contact_entries}
        />
      ) : (
        <JobCommunicationsTab
          jobId={JOB_ID} jobNumber="J00742" customerId={CUSTOMER_ID} customerName="Pat Payer"
          customerPhone={data.customer.phone} contactEntries={data.contact_entries}
        />
      )}
    </>
  );
}

/** The number the phone tab was opened to dial, read off the address it was opened at. */
function dialed(open: ReturnType<typeof vi.fn>): string | null {
  const url = open.mock.calls.at(-1)?.[0];
  return url ? new URL(String(url), 'https://app.test').searchParams.get('dial') : null;
}

describe.each(['lead', 'job'] as const)('the %s Communication tab uses the number the record shows', (record) => {
  let open: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    // The phone tab is a window the call opens; none is open yet, so each call opens one at the number it dials.
    open = vi.fn(() => null);
    vi.stubGlobal('open', open);
  });

  it('"Call customer" dials the customer\'s primary when the record changed no phone', async () => {
    serve(record, []);
    const user = userEvent.setup();
    renderWithProviders(<OnRecord record={record} />, { ability });

    await user.click(await screen.findByRole('button', { name: /call customer/i }));

    expect(dialed(open)).toBe('5550103002');
  });

  it('"Call customer" dials (555) 010-5252 right after the pencil changes the phone to it', async () => {
    serve(record, []);
    const user = userEvent.setup();
    renderWithProviders(<OnRecord record={record} />, { ability });
    await screen.findByRole('button', { name: /call customer/i });

    await user.click(screen.getByRole('button', { name: 'Pencil: change the phone' }));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith(`/api/${record}s/${record === 'lead' ? LEAD_ID : JOB_ID}/contact-entries/change`, expect.anything()));
    await user.click(screen.getByRole('button', { name: /call customer/i }));

    await waitFor(() => expect(dialed(open)).toBe('5550105252'));
  });

  it('"Call customer" dials (555) 010-5252 after a refresh', async () => {
    serve(record, [changedPrimary(record)]);
    const user = userEvent.setup();
    renderWithProviders(<OnRecord record={record} />, { ability });

    await user.click(await screen.findByRole('button', { name: /call customer/i }));

    expect(dialed(open)).toBe('5550105252');
  });

  it('the text box sends the text on the record and names no number: the server takes it from the record', async () => {
    serve(record, [changedPrimary(record)]);
    const user = userEvent.setup();
    renderWithProviders(<OnRecord record={record} />, { ability });

    await user.type(await screen.findByPlaceholderText(/text pat payer/i), 'About your quote');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    const anchor = record === 'lead' ? { leadId: LEAD_ID } : { jobId: JOB_ID };
    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/communication/sms', { customerId: CUSTOMER_ID, body: 'About your quote', ...anchor }),
    );
  });
});
