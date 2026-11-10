/* =============================================================================
   #3017 - the job's header and buttons use the job's number.

   A job's effective number (#3016) is its changed number for the customer's primary, else the customer's primary. The
   job page shows it in the header, and every Call and Text the page draws for the customer's number uses it:
   - the header number, whose tap offers Call and Text;
   - the Overview customer card's Call and Text buttons.
   Call dials the number. Text opens the composer addressed to the number with the job attached, so the server's
   anchored send (#3016) picks the destination from the job and files the text on it.

   The ROUTED job page and the Text page's composer are drawn in one router, so a tap really navigates and the text
   really leaves through the composer. The API is mocked at the network edge only (the axios instance), and the call at
   the browser edge (the phone tab the call opens).

   Out of this table, and why:
   - the contact block's own number lines on the Overview card draw a changed number in the customer's number's place
     (#3016 "IN_PLACE"), and their Text on a changed or extra number is #3018's;
   - "Call customer" on the job's Communication tab is #3016's (record-communication-tabs-effective-number.test.tsx);
   - the crew's numbers (Team card) are not the customer's.
   ========================================================================== */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { ALL_JOB_ACTIONS } from './helpers';
import { renderJobDetail, serveJobDetail, stubBrowser } from '@/__tests__/harness/jobDetailPage';
import { SmsInboxView } from '@/components/communication/phone/SmsInboxView';
import type { MessageThread, PhoneCustomer } from '@/lib/api/communication';
import type { RecordContactEntry } from '@/lib/api/recordContactEntries';
import { catalogToggle } from './support/backendSwitchCatalog';

stubBrowser();

const mockApi = vi.mocked(api);
// The page draws from the person's switches, not from the ability.

const JOB_ID = 'b0000000-0000-0000-0000-000000003017';
const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000003017';

const CUSTOMER = {
  id: CUSTOMER_ID,
  first_name: 'Pat',
  last_name: 'Payer',
  company_name: null,
  email: null,
  phone: '5550103002',
  phones: [{ phone: '5550103002', label: null, extension: null, is_primary: true }],
  emails: [],
};

/** The job's own (555) 010-5252: the pencil's change of the customer's primary on this job, as the API answers it. */
const JOBS_OWN_NUMBER: RecordContactEntry = {
  id: '0e000000-0000-0000-0000-000000003017',
  kind: 'PHONE', intent: 'CHANGED', value: '5550105252', extension: null, label: null,
  overridden_field: 'phone', overridden_row_id: null, customer_value_at_change: '5550103002',
  created_by: { id: null, name: 'Riley Brooks' }, created_at: '2026-11-05T10:00:00.000Z',
  updated_by: { id: null, name: 'Riley Brooks' }, updated_at: '2026-11-05T10:00:00.000Z', source_entry_id: null,
};

const jobWith = (contact_entries: RecordContactEntry[]) => ({
  id: JOB_ID,
  job_number: 'J00742',
  status: 'SCHEDULED',
  scope_notes: null,
  estimated_duration: null,
  completion_notes: null,
  scheduled_start: null,
  scheduled_end: null,
  started_at: null,
  completed_at: null,
  cancelled_at: null,
  cancelled_reason: null,
  created_at: '2026-11-01T00:00:00.000Z',
  updated_at: '2026-11-01T00:00:00.000Z',
  customer: CUSTOMER,
  contact_entries,
  assignees: [],
  service_location: { id: 'l1', address_line1: '12 Main St', address_line2: null, city: 'Springfield', state: 'IL', zip: '62701' },
  estimate: null,
  invoices: [],
  linked_estimates: [],
  tags: [],
  source_plan_id: null,
  actions: ALL_JOB_ACTIONS,
  source_plan: null,
});

/** The customer as the directory lists it, for a person who may view customers. */
const DIRECTORY_PAT: PhoneCustomer = {
  id: CUSTOMER_ID,
  name: 'Pat Payer',
  type: 'residential',
  site: 'Springfield',
  contacts: [{ id: 'ct1', name: 'Pat Payer', preferredLang: 'en', channels: [{ id: 'ch1', kind: 'phone', value: '+15550103002' }] }],
};

/** A person who may contact customers and change a job's contact details, with or without View customers. */
function meAnswer(viewCustomers: boolean) {
  return {
    admin_box: false,
    values: {
      [catalogToggle('Copy customer phone').key]: true,
      [catalogToggle('Copy customer email').key]: true,
      [catalogToggle('Contact customers').key]: true,
      [catalogToggle('View customers').key]: viewCustomers,
      [catalogToggle('Edit job and lead contact details').key]: true,
    },
  };
}

function Inbox() {
  const [threads, setThreads] = useState<MessageThread[]>([]);
  return <SmsInboxView threads={threads} setThreads={setThreads} onToast={() => {}} />;
}

/** The API: the job with the entries it holds, the pencil's change answering the job's own number, and a sent text. */
function renderJob({ entries, viewCustomers = true }: { entries: RecordContactEntry[]; viewCustomers?: boolean }) {
  serveJobDetail({
    jobId: JOB_ID,
    job: jobWith(entries),
    routes: [
      { match: (url) => url === '/api/permission-switches/me', data: meAnswer(viewCustomers) },
      { match: (url) => url === `/api/jobs/${JOB_ID}/communications`, data: { items: [] } },
      { match: (url) => url === '/api/organization', data: { phone_connected: true, ctm_account_id: true, ctm_sms_ready: true } },
      {
        match: (url) => url === '/api/communication/contacts',
        data: () => {
          if (!viewCustomers) throw { response: { status: 403, data: { error: 'Insufficient permissions' } } };
          return { contacts: [DIRECTORY_PAT] };
        },
      },
      { match: (url) => url === '/api/communication/threads', data: { threads: [] } },
      { match: (url) => url === '/api/communication/numbers', data: { numbers: [{ id: 'num-1', e164: '+15550101111', sms_enabled: true, created_at: '2026-07-01T00:00:00Z' }] } },
    ],
  });
  mockApi.post.mockImplementation(async (url: string) => {
    if (url === `/api/jobs/${JOB_ID}/contact-entries/change`) return { data: { entries: [JOBS_OWN_NUMBER] } };
    return { data: { message: { id: 'm1', direction: 'out', body: 'On my way', ts: '2026-11-05T10:00:00Z' }, threadId: 'srv-th-1' } };
  });
  return renderJobDetail({
    entry: `/jobs/${JOB_ID}`,
    wrap: (page) => (
      <Routes>
        <Route path="/jobs/:id" element={page} />
        <Route path="/communication/text" element={<Inbox />} />
      </Routes>
    ),
  });
}

/** The Overview tab's Customer & Contact card. */
async function overviewCard(): Promise<HTMLElement> {
  return (await screen.findByText('Customer & Contact')).closest('div[class*="rounded-card"]') as HTMLElement;
}

/** The page has drawn the job: its Overview card shows the customer. */
async function jobDrawn() {
  await within(await overviewCard()).findByText('Pat Payer');
}

const A_NUMBER = /^\(555\) 010-\d{4}$/;

/** The numbers the page's header shows: every number drawn on the page outside the Overview card. */
async function headerNumbersShown(): Promise<string[]> {
  await jobDrawn();
  const card = await overviewCard();
  return screen
    .getAllByText(A_NUMBER)
    .filter((el) => !card.contains(el))
    .map((el) => el.textContent ?? '');
}

/** The header's number control: the one number control on the page outside the Overview card. */
async function headerNumber(): Promise<HTMLElement> {
  await jobDrawn();
  const card = await overviewCard();
  const [number] = screen.getAllByRole('button', { name: A_NUMBER }).filter((b) => !card.contains(b));
  return number!;
}

type Place = 'the header number' | "the Overview card's button";

async function tap(place: Place, action: 'Call' | 'Text') {
  const user = userEvent.setup();
  if (place === 'the header number') {
    await user.click(await headerNumber());
    await user.click(await screen.findByRole('menuitem', { name: action }));
  } else {
    await user.click(await within(await overviewCard()).findByRole('button', { name: action }));
  }
  return user;
}

/** The number the phone tab was opened to dial, read off the address it was opened at. */
function dialed(open: ReturnType<typeof vi.fn>): string | null {
  const url = open.mock.calls.at(-1)?.[0];
  return url ? new URL(String(url), 'https://app.test').searchParams.get('dial') : null;
}

/** Write a text in the composer the tap opened, and send it. */
async function sendFromComposer(user: ReturnType<typeof userEvent.setup>) {
  const dialog = (await screen.findByRole('dialog')) as HTMLElement;
  await user.type(within(dialog).getByPlaceholderText(/^Write a message to/), 'On my way');
  const send = within(dialog).getAllByRole('button', { name: /^send$/i }).at(-1)!;
  await waitFor(() => expect(send).toBeEnabled());
  await user.click(send);
}

let open: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  // The phone tab is a window the call opens; none is open yet, so each call opens one at the number it dials.
  open = vi.fn(() => null);
  vi.stubGlobal('open', open);
  // A company with the phone service: the inbox lists conversations once the person's entitlements are known.
  vi.mocked(useAuthStore).mockImplementation((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: {
        id: '00000000-0000-0000-0000-000000000001',
        email: 'admin@test.com',
        first_name: 'Test',
        last_name: 'Admin',
        role: 'ADMIN',
        is_admin: true,
        org_is_demo: true,
        organization_id: 'org-demo',
        org_features: ['phone'],
      },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    }),
  );
});

const PLACES: Place[] = ['the header number', "the Overview card's button"];

describe.each([
  { when: 'J00742 has its own (555) 010-5252, as the job is read after a refresh', entries: [JOBS_OWN_NUMBER], shown: '(555) 010-5252', digits: '5550105252', e164: '+15550105252' },
])('$when', ({ entries, shown, digits, e164 }) => {
  it(`the header shows ${shown}`, async () => {
    renderJob({ entries });

    expect(await headerNumbersShown()).toEqual([shown]);
  });

  it.each(PLACES)(`Call on %s dials ${shown}`, async (place) => {
    renderJob({ entries });

    await tap(place, 'Call');

    await waitFor(() => expect(dialed(open)).toBe(digits));
  });

  it.each(PLACES.flatMap((place) => [true, false].map((viewCustomers) => [place, viewCustomers] as const)))(
    `Text on %s texts ${shown} with the job attached (View customers: %s)`,
    async (place, viewCustomers) => {
      renderJob({ entries, viewCustomers });

      const user = await tap(place, 'Text');
      await sendFromComposer(user);

      await waitFor(() =>
        expect(mockApi.post).toHaveBeenCalledWith('/api/communication/sms', { toNumber: e164, body: 'On my way', jobId: JOB_ID }),
      );
    },
  );
});

describe('right after the pencil changes the job\'s phone to (555) 010-5252', () => {
  async function changeThePhone() {
    const user = userEvent.setup();
    await user.click(within(await overviewCard()).getByRole('button', { name: 'Change this phone for this job' }));
    const dialog = await screen.findByRole('dialog');
    const phone = within(dialog).getByLabelText('Phone number');
    await user.clear(phone);
    await user.type(phone, '5550105252');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  }

  it('the header shows (555) 010-5252', async () => {
    renderJob({ entries: [] });
    await jobDrawn();

    await changeThePhone();

    await within(await overviewCard()).findByText('Changed on this job');
    expect(await headerNumbersShown()).toEqual(['(555) 010-5252']);
  });

  it.each(PLACES)('Call on %s dials (555) 010-5252', async (place) => {
    renderJob({ entries: [] });
    await jobDrawn();

    await changeThePhone();
    await within(await overviewCard()).findByText('Changed on this job');
    await tap(place, 'Call');

    await waitFor(() => expect(dialed(open)).toBe('5550105252'));
  });
});
