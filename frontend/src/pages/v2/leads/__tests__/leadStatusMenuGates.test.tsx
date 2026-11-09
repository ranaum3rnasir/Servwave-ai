import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth.store';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { LEAD_FIXTURE } from '@/__tests__/helpers';
import { DESKTOP, emulateDevice } from '@/__tests__/support/deviceShape';
import { renderLeadDetail, serveLeadDetail, stubBrowser } from '@/__tests__/harness/leadDetailPage';

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/components/communication/LeadCommunicationsTab', () => ({ LeadCommunicationsTab: () => null }));
vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => false,
}));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: LEAD_FIXTURE.id }), useNavigate: () => vi.fn() };
});

// Each test starts from the setup file's signed-in user and bare client calls: reset them here, so a test states its own user
// and answers in its own `beforeEach` (`clearAllMocks` keeps implementations).
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockReset();
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.patch).mockReset();
  vi.mocked(api.put).mockReset();
  vi.mocked(api.delete).mockReset();
});

describe('leadReopen', () => {
  /* =============================================================================
     Roles & Permissions, PRD 5, slice S05.19 - Reopen lead on a Won or Lost lead, and the status menu that locks a
     closed lead. Renders the ROUTED lead page (pages/v2/leads/LeadDetailPage).

     Whether this person may reopen THIS lead is the server's per-lead answer, the lead's `actions` (it lists "reopen"
     for a person holding Reopen leads who can open the lead). The button shows on a Won or a Lost lead only, never on an
     open one, in the page's action row and in the closed-lead line on the customer block. The dialog keeps Reopen
     disabled until a reason is typed. The words are the PRD's own, written out here rather than read from the code.
     ========================================================================== */

  stubBrowser();

  const mockApi = vi.mocked(api);
  const REOPEN_PATH = `/api/leads/${LEAD_FIXTURE.id}/reopen`;
  const LOCK_TEXT = 'To change the status, reopen the lead first.';
  const CLOSED_LINE = 'This lead is closed. Reopen it to change its details.';

  type Rules = Parameters<typeof buildAbility>[0];
  const READ: Rules = [{ action: 'read', subject: 'Lead' }, { action: 'update', subject: 'Lead' }];
  const REOPENER: Rules = [...READ, { action: 'reopen', subject: 'Lead' }];

  const STATUS_ORDER = ['NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED', 'WON', 'LOST'];
  /** The options the server returns for a closed lead: every other status locked with the PRD's sentence. */
  const closedOptions = (current: string) =>
    STATUS_ORDER.map((status) => ({ status, available: status === current, reason: status === current ? null : LOCK_TEXT }));

  function leadWith(over: Record<string, unknown> = {}) {
    return { ...LEAD_FIXTURE, estimates: [], contact_entries: [], ...over };
  }

  function renderLeadPage(lead: Record<string, unknown>, rules: Rules = REOPENER) {
    serveLeadDetail({ lead });
    return renderLeadDetail({ ability: buildAbility(rules) });
  }

  const reopenButtons = () => screen.queryAllByRole('button', { name: 'Reopen lead' });
  const loaded = () => screen.findByRole('heading', { level: 1 });

  let restoreDevice: (() => void) | undefined;
  beforeEach(() => {
    vi.clearAllMocks();
    restoreDevice = emulateDevice(DESKTOP);
  });
  afterEach(() => {
    restoreDevice?.();
  });

  describe('where Reopen lead shows', () => {
    it.each(['WON', 'LOST'])('shows Reopen lead on a %s lead the server says this person may reopen, in the header and in the closed-lead line', async (status) => {
      renderLeadPage(leadWith({ status, actions: ['reopen'], status_options: closedOptions(status) }));
      await loaded();

      expect(await screen.findByText(CLOSED_LINE)).toBeInTheDocument();
      // One in the page's action row, one beside the closed-lead line on the block.
      expect(reopenButtons()).toHaveLength(2);
      const line = screen.getByText(CLOSED_LINE).parentElement as HTMLElement;
      expect(within(line).getByRole('button', { name: 'Reopen lead' })).toBeInTheDocument();
    });

    it.each(['NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED'])(
      'never shows Reopen lead on a %s lead, even for a person who holds Reopen leads',
      async (status) => {
        renderLeadPage(leadWith({ status, actions: ['reopen'] }));
        await loaded();

        expect(reopenButtons()).toHaveLength(0);
      },
    );

    it.each(['WON', 'LOST'])('shows no Reopen lead on a %s lead when the server does not list it for this person', async (status) => {
      renderLeadPage(leadWith({ status, actions: ['edit', 'change_status'] }), REOPENER);
      await loaded();

      expect(await screen.findByText(CLOSED_LINE)).toBeInTheDocument();
      expect(reopenButtons()).toHaveLength(0);
    });

    it('falls back to what the person holds when an older answer carries no action list', async () => {
      renderLeadPage(leadWith({ status: 'LOST' }), REOPENER);
      await loaded();
      expect(reopenButtons().length).toBeGreaterThan(0);
    });

    it('shows none to a person who holds nothing to reopen with, on an answer with no action list', async () => {
      renderLeadPage(leadWith({ status: 'LOST' }), READ);
      await loaded();
      expect(await screen.findByText(CLOSED_LINE)).toBeInTheDocument();
      expect(reopenButtons()).toHaveLength(0);
    });
  });

  describe('the Reopen dialog', () => {
    async function openDialog(status = 'LOST') {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      renderLeadPage(leadWith({ status, actions: ['reopen'], status_options: closedOptions(status) }));
      await loaded();
      await user.click((await screen.findAllByRole('button', { name: 'Reopen lead' }))[0]!);
      return { user, dialog: await screen.findByRole('dialog') };
    }

    it('asks "Reopen this lead?" with a required reason, and keeps Reopen disabled until one is typed', async () => {
      const { user, dialog } = await openDialog();

      expect(within(dialog).getByText('Reopen this lead?')).toBeInTheDocument();
      const box = within(dialog).getByLabelText('Why is this lead being reopened?');
      const reopen = within(dialog).getByRole('button', { name: 'Reopen' });
      expect(within(dialog).getByRole('button', { name: 'Go back' })).toBeEnabled();
      expect(reopen).toBeDisabled();

      await user.type(box, '   ');
      expect(reopen).toBeDisabled();
      await user.type(box, 'Customer called back');
      expect(reopen).toBeEnabled();
    });

    it('opens from the closed-lead line on the block too', async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      renderLeadPage(leadWith({ status: 'WON', actions: ['reopen'], status_options: closedOptions('WON') }));
      await loaded();
      const line = (await screen.findByText(CLOSED_LINE)).parentElement as HTMLElement;

      await user.click(within(line).getByRole('button', { name: 'Reopen lead' }));

      expect(await screen.findByText('Reopen this lead?')).toBeInTheDocument();
    });

    it('posts the reason to the reopen endpoint, then closes', async () => {
      mockApi.post.mockResolvedValue({ data: { lead: {} } });
      const { user, dialog } = await openDialog('WON');

      await user.type(within(dialog).getByLabelText('Why is this lead being reopened?'), 'Customer called back');
      await user.click(within(dialog).getByRole('button', { name: 'Reopen' }));

      await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith(REOPEN_PATH, { reason: 'Customer called back' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('sends nothing when the person goes back', async () => {
      const { user, dialog } = await openDialog();

      await user.click(within(dialog).getByRole('button', { name: 'Go back' }));

      expect(mockApi.post).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it("shows the server's words when the reopen is refused, and stays open", async () => {
      mockApi.post.mockRejectedValue({ response: { status: 403, data: { error: 'Insufficient permissions' } } });
      const { user, dialog } = await openDialog();

      await user.type(within(dialog).getByLabelText('Why is this lead being reopened?'), 'Back again');
      await user.click(within(dialog).getByRole('button', { name: 'Reopen' }));

      expect(await within(dialog).findByText('Insufficient permissions')).toBeInTheDocument();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });

  describe('the status menu on a closed lead', () => {
    it.each(['WON', 'LOST'])('locks every other status of a %s lead for a role that changes statuses by hand, and sends nothing when one is clicked', async (status) => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      renderLeadPage(
        leadWith({ status, actions: ['edit', 'change_status', 'reopen'], status_options: closedOptions(status) }),
        [...REOPENER, { action: 'mark_lost', subject: 'Lead' }],
      );
      await loaded();

      await user.click(await screen.findByRole('button', { name: new RegExp(`lead status: ${status.toLowerCase()}`, 'i') }));
      const items = await screen.findAllByRole('menuitem');
      const locked = items.filter((i) => i.getAttribute('aria-disabled') === 'true');
      expect(locked).toHaveLength(items.length - 1);

      await user.hover(locked[0]!);
      expect(await screen.findByRole('tooltip')).toHaveTextContent(LOCK_TEXT);
      await user.click(locked[0]!);
      expect(mockApi.patch).not.toHaveBeenCalled();
    });

    it('never prints the old "Use Reopen lead" sentence', async () => {
      renderLeadPage(leadWith({ status: 'LOST', actions: ['reopen'], status_options: closedOptions('LOST') }));
      await loaded();
      expect(document.body.textContent).not.toContain('Use Reopen lead to bring a closed lead back.');
    });
  });
});
