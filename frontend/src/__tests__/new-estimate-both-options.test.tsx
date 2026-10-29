/**
 * #2027 slice 1 — the new-estimate dialog offers BOTH creation paths, always.
 *
 * "Create estimate without a lead" was rendered only in the branch where the picked customer has
 * no actionable leads. A customer with an open lead could therefore only be reached through a
 * lead, even though the direct-to-customer path exists end to end and the dialog's own handler
 * for it is already written and already navigates correctly. The entire defect is the conditional.
 *
 * There are TWO live copies of this dialog (see repro-1472.test.tsx): the v2 one behind
 * `/estimates`, and the legacy one behind the dashboard's quick-create menu. Both are asserted
 * here, and both entry paths — customer pre-selected, and customer found by searching — run the
 * same assertions, because the panel used to be written twice per file and the two copies drifted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { NewEstimateDialog as V2NewEstimateDialog } from '@/pages/v2/estimates/components/newEstimateDialog';
import { NewEstimateDialog as LegacyNewEstimateDialog } from '@/components/estimates/NewEstimateDialog';

const CUSTOMER_ID = 'c0000000-0000-0000-0000-0000000000aa';
const LEAD_ID = '10000000-0000-0000-0000-0000000000bb';

const CUSTOMER = {
  id: CUSTOMER_ID,
  first_name: 'Jane',
  last_name: 'Doe',
  company_name: null,
  phone: '5551234567',
  email: 'jane@doe.com',
};

const ACTIVE_LEAD = {
  id: LEAD_ID,
  status: 'NEW',
  service_request: 'Front door will not latch',
  created_at: '2026-09-01T00:00:00Z',
};

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

function setupMocks(leads: unknown[]) {
  vi.mocked(api.get).mockImplementation(async (url: string) => {
    // #2041 slice 1 moved BOTH dialogs off `/api/customers` onto the org-wide create-form picker
    // (Ran's carve-out: a rep must be able to start an estimate on a customer they have never
    // worked with). The dialog behaviour this file is about is unchanged — only the endpoint is.
    if (url === `/api/customers/picker/${CUSTOMER_ID}`) return { data: { customer: CUSTOMER } };
    if (url === '/api/customers/picker') return { data: { customers: [CUSTOMER] } };
    if (url === '/api/leads') return { data: { leads } };
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

const DIALOGS = [
  ['the /estimates dialog', V2NewEstimateDialog] as const,
  ['the dashboard quick-create dialog', LegacyNewEstimateDialog] as const,
];

/** Reach the customer's panel by the PRE-SELECTED path. */
async function openPreSelected(Dialog: typeof V2NewEstimateDialog) {
  renderWithProviders(
    <Dialog open onOpenChange={() => {}} preSelectedCustomerId={CUSTOMER_ID} />,
  );
  await screen.findByText('Jane Doe');
}

/** Reach the same customer's panel by SEARCHING for them. */
async function openBySearch(Dialog: typeof V2NewEstimateDialog) {
  const user = userEvent.setup();
  renderWithProviders(<Dialog open onOpenChange={() => {}} />);
  // The two dialogs use different search primitives: the kit's SearchInput reports
  // role="searchbox", the legacy one a plain textbox.
  const box = screen.queryByRole('searchbox') ?? screen.getByRole('textbox');
  await user.type(box, 'Jane');
  const row = await screen.findByText('Jane Doe', {}, { timeout: 3000 });
  await user.click(row);
}

const ENTRY_PATHS = [
  ['pre-selected', openPreSelected] as const,
  ['found by searching', openBySearch] as const,
];

describe.each(DIALOGS)('%s', (_label, Dialog) => {
  describe.each(ENTRY_PATHS)('with the customer %s', (_entry, open) => {
    it('offers both creation options when the customer has an active lead', async () => {
      setupMocks([ACTIVE_LEAD]);
      await open(Dialog);

      expect(await screen.findByText('Front door will not latch')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /create new lead/i })).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /create estimate without a lead/i }),
      ).toBeInTheDocument();
    });

    it('offers both creation options when the customer has no leads at all', async () => {
      setupMocks([]);
      await open(Dialog);

      expect(await screen.findByText('No active leads')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /create new lead/i })).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /create estimate without a lead/i }),
      ).toBeInTheDocument();
    });

    it('sends the direct option to a new estimate anchored to the customer, with no lead', async () => {
      const user = userEvent.setup();
      setupMocks([ACTIVE_LEAD]);
      await open(Dialog);
      await screen.findByText('Front door will not latch');

      await user.click(screen.getByRole('button', { name: /create estimate without a lead/i }));

      const target = mockNavigate.mock.calls.at(-1)?.[0] as string;
      expect(target).toContain(`/estimates/new?customer_id=${CUSTOMER_ID}`);
      expect(target).not.toContain('lead_id');
    });

    it('still sends a chosen lead to a new estimate on that lead', async () => {
      const user = userEvent.setup();
      setupMocks([ACTIVE_LEAD]);
      await open(Dialog);

      await user.click(await screen.findByText('Front door will not latch'));

      const target = mockNavigate.mock.calls.at(-1)?.[0] as string;
      expect(target).toContain(`/estimates/new?lead_id=${LEAD_ID}`);
    });

    it('leaves a terminal lead out of the picker', async () => {
      setupMocks([ACTIVE_LEAD, { ...ACTIVE_LEAD, id: 'won-1', status: 'WON', service_request: 'Already won' }]);
      await open(Dialog);

      expect(await screen.findByText('Front door will not latch')).toBeInTheDocument();
      expect(screen.queryByText('Already won')).not.toBeInTheDocument();
    });

    // Walkthrough lead statuses, slice 01: a lead with a walkthrough booked or done is still open.
    it.each([
      ['WALKTHROUGH_SCHEDULED', 'Walkthrough Scheduled'],
      ['WALKTHROUGH_COMPLETED', 'Walkthrough Completed'],
    ])('lists a lead in %s, and starts an estimate on it', async (status, label) => {
      const user = userEvent.setup();
      setupMocks([{ ...ACTIVE_LEAD, status, service_request: 'Walkthrough lead' }]);
      await open(Dialog);

      const row = await screen.findByText('Walkthrough lead');
      expect(screen.getByText(label)).toBeInTheDocument();
      await user.click(row);

      const target = mockNavigate.mock.calls.at(-1)?.[0] as string;
      expect(target).toContain(`/estimates/new?lead_id=${LEAD_ID}`);
    });
  });
});
