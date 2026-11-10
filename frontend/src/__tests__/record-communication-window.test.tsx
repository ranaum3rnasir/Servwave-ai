// #3022 - a lead's or job's Communication tab shows every text with its numbers (Q39).
//
// The server lists the texts with the record's numbers from its creation until it closes, plus every text tied to the record
// (proven over HTTP in the backend's record-communication-window-db.test.ts). The tab lists every text the read answers,
// tied or not, and its numbers are the ones the record's card shows now: when the pencil changes the card, the tab reads its
// texts again at once.
//
// Each tab is drawn on its record the way the record page holds it: the record read from the API, and the pencil's real
// change hook. The API is mocked at the network edge only (the axios instance).
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
import type { CommItem } from '@/lib/api/jobCommunications';

const mockApi = vi.mocked(api);

const LEAD_ID = 'e0000000-0000-0000-0000-000000003022';
const JOB_ID = 'b0000000-0000-0000-0000-000000003022';
const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000003022';
const CUSTOMER = {
  id: CUSTOMER_ID, first_name: 'Pat', last_name: 'Payer', company_name: null, email: null, phone: '5550103002',
  phones: [{ phone: '5550103002', label: null, extension: null, is_primary: true }],
};

/** A reply from (555) 010-5252 tied to no lead or job. */
const UNTIED_REPLY: CommItem = {
  id: 'aa000000-0000-0000-0000-000000003022', channel: 'sms', direction: 'in', who: 'Pat Payer', title: 'Text message',
  preview: 'Tuesday works for me', at: '2026-11-03T15:00:00.000Z', threadId: 'ab000000-0000-0000-0000-000000003022',
};

/** A review request tied to the record, sent after it closed. */
function reviewRequest(record: 'lead' | 'job'): CommItem {
  return {
    id: 'ac000000-0000-0000-0000-000000003022', channel: 'sms', direction: 'out', who: 'Pat Payer', title: 'Text message',
    preview: 'How did we do?', at: '2026-11-04T15:00:00.000Z', threadId: 'ab000000-0000-0000-0000-000000003022',
    ...(record === 'lead' ? { leadId: LEAD_ID, leadLabel: 'L19835' } : { jobId: JOB_ID, jobLabel: 'J00742' }),
  };
}

/** The pencil's change of the customer's primary to (555) 010-5252 on this record, as the API answers it. */
function changedPrimary(record: 'lead' | 'job'): RecordContactEntry {
  return {
    id: `0e000000-0000-0000-0000-00000000${record === 'lead' ? '3001' : '3002'}`,
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

/**
 * The API: the record, and its Communication read answering `texts()` (asked afresh on every read). The pencil's change
 * answers the new entry and, from then on, the record's card carries (555) 010-5252.
 */
function serve(record: 'lead' | 'job', texts: (changed: boolean) => CommItem[]) {
  const id = record === 'lead' ? LEAD_ID : JOB_ID;
  let changed = false;
  mockApi.get.mockImplementation((url: string) => {
    if (url === `/api/${record}s/${id}`) {
      return Promise.resolve({ data: { [record]: { id, customer: CUSTOMER, contact_entries: changed ? [changedPrimary(record)] : [] } } });
    }
    if (url === `/api/${record}s/${id}/communications`) return Promise.resolve({ data: { items: texts(changed) } });
    return Promise.resolve({ data: {} });
  });
  mockApi.post.mockImplementation((url: string) => {
    if (url === `/api/${record}s/${id}/contact-entries/change`) {
      changed = true;
      return Promise.resolve({ data: { entries: [changedPrimary(record)] } });
    }
    return Promise.resolve({ data: {} });
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

describe.each(['lead', 'job'] as const)('the %s Communication tab shows every text with its numbers', (record) => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists an untied reply from (555) 010-5252 and a review request tied to it after it closed', async () => {
    serve(record, () => [UNTIED_REPLY, reviewRequest(record)]);
    renderWithProviders(<OnRecord record={record} />, { ability });

    expect(await screen.findByText('Tuesday works for me')).toBeInTheDocument();
    expect(screen.getByText('How did we do?')).toBeInTheDocument();
  });

  it('reads its texts again as soon as the pencil changes the number on its card', async () => {
    // Before the change the card carries (555) 010-3002 only, so the read has no reply from (555) 010-5252 to list.
    serve(record, (changed) => (changed ? [UNTIED_REPLY] : []));
    const user = userEvent.setup();
    renderWithProviders(<OnRecord record={record} />, { ability });
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith(`/api/${record}s/${record === 'lead' ? LEAD_ID : JOB_ID}/communications`));
    expect(screen.queryByText('Tuesday works for me')).not.toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: 'Pencil: change the phone' }));

    // At once: well before the tab's own refresh, which comes every 15 seconds.
    expect(await screen.findByText('Tuesday works for me', {}, { timeout: 3_000 })).toBeInTheDocument();
  });
});
