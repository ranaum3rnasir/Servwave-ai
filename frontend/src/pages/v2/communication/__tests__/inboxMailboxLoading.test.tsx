/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions, PRD 10, slice S10.7 (scenario pass 3 fix) - picking a mailbox on the ROUTED Email page
// (/communication/inbox renders this InboxPage).
//
// The REAL data hooks run; only the network layer is faked, and each mailbox's answer is held back until the test lets it
// go, as the hosted server does for a couple of seconds. While a picked mailbox loads, the list says it is loading: it
// never reads "Nothing here." (which a person takes for an empty mailbox) and never shows the previous mailbox's mail under
// the new mailbox's name. A mailbox that really is empty still reads "Nothing here."
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import api from '@/lib/axios';

const ability = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'update', subject: 'Communication' },
  { action: 'access_inbox', subject: 'Communication' },
]);

vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => true,
  useEntitlementsReady: () => true,
}));

import InboxPage from '@/pages/v2/communication/InboxPage';

const mail = (id: string, subject: string) => ({
  id, threadId: `t-${id}`, account: 'user', from: { name: 'Maria Garcia', email: 'maria.garcia@example.com' },
  to: 'office@example.test', subject, snippet: `${subject} snippet`, body: [subject], at: 'May 1', ts: 1,
  unread: false, starred: false, folder: 'inbox', direction: 'in',
});

type Held = { resolve: (rows: unknown[]) => void };
/** The emails answer per mailbox: a mailbox in `held` waits for the test, any other answers at once. */
let rowsOf: Record<string, unknown[]>;
let held: Record<string, Held | undefined>;
let heldMailboxList: Held | undefined;

function answerNetwork() {
  vi.mocked(api.get).mockImplementation(async (url: string, config?: { params?: unknown }) => {
    const params = (config?.params ?? {}) as { mailbox?: string; selected?: string };
    if (url === '/api/communication/mailboxes') {
      const selected = params.selected ?? 'mine';
      const body = {
        scope: 'linked_to_me', selected, selected_label: null, selected_unread: 0, total_unread: 0,
        mine: { id: 'box-mine', unread: 0 }, held: [{ id: 'box-handed', name: 'Jane Smith', unread: 0 }, { id: 'box-empty', name: 'Empty Person', unread: 0 }],
        main: null, people: null,
      };
      if (heldMailboxList && selected !== 'mine') return new Promise((resolve) => { heldMailboxList!.resolve = () => resolve({ data: body }); });
      return { data: body };
    }
    if (url === '/api/communication/emails') {
      const mailbox = params.mailbox ?? 'scope';
      const wait = held[mailbox];
      if (wait) return new Promise((resolve) => { wait.resolve = (rows) => resolve({ data: { emails: rows } }); });
      return { data: { emails: rowsOf[mailbox] ?? [] } };
    }
    if (url === '/api/communication/email-groups') return { data: { groups: [] } };
    if (url === '/api/communication/forward-rules') return { data: { rules: [] } };
    if (url === '/api/communication/team-members') return { data: { members: [] } };
    if (url === '/api/communication/sending-identity') return { data: { status: 'active', address: 'jane@mail.example.test', name: 'Jane at Acme', sendingEnabled: true } };
    if (url === '/api/communication/my-mailbox') return { data: { mailbox: { status: 'active', address: 'jane@mail.example.test' } } };
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rowsOf = { mine: [mail('m1', 'My own mail')], 'box-handed': [mail('h1', 'Handed mail')], 'box-empty': [] };
  held = {};
  heldMailboxList = undefined;
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: { id: 'u1', email: 'jane@test.com', first_name: 'Jane', last_name: 'Smith', role: 'DISPATCHER', organization_id: 'org-1', org_features: ['email', 'phone'] },
      isAuthenticated: true, isLoading: false, error: null,
    })) as typeof useAuthStore,
  );
  answerNetwork();
});

const render = (entry = '/communication/inbox') => renderWithProviders(<InboxPage />, { ability, initialEntries: [entry] });
const loading = () => screen.queryByRole('status', { name: 'Loading mail' });

describe('the Email page while a picked mailbox loads', () => {
  it('says it is loading, not "Nothing here.", and never shows the last mailbox\'s mail, until the picked mailbox answers', async () => {
    const user = userEvent.setup();
    held['box-handed'] = { resolve: () => undefined };
    render();
    expect(await screen.findByText('My own mail')).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: /Jane Smith's mailbox/ }));

    await waitFor(() => expect(loading()).toBeInTheDocument());
    expect(screen.queryByText('Nothing here.')).not.toBeInTheDocument();
    expect(screen.queryByText('My own mail')).not.toBeInTheDocument();

    await act(async () => held['box-handed']!.resolve([mail('h1', 'Handed mail')]));
    expect(await screen.findByText('Handed mail')).toBeInTheDocument();
    expect(loading()).not.toBeInTheDocument();
    expect(screen.queryByText('Nothing here.')).not.toBeInTheDocument();
  });

  it('says it is loading while the page address\'s mailbox is still being looked up, and again never "Nothing here."', async () => {
    heldMailboxList = { resolve: () => undefined };
    render('/communication/inbox?mailbox=box-handed');

    await waitFor(() => expect(loading()).toBeInTheDocument());
    expect(screen.queryByText('Nothing here.')).not.toBeInTheDocument();

    await act(async () => heldMailboxList!.resolve([]));
    expect(await screen.findByText('Handed mail')).toBeInTheDocument();
    expect(loading()).not.toBeInTheDocument();
  });

  it('still reads "Nothing here." for a mailbox that really is empty', async () => {
    const user = userEvent.setup();
    render();
    await screen.findByText('My own mail');

    await user.click(await screen.findByRole('button', { name: /Empty Person's mailbox/ }));

    expect(await screen.findByText('Nothing here.')).toBeInTheDocument();
    expect(loading()).not.toBeInTheDocument();
    expect(screen.queryByText('My own mail')).not.toBeInTheDocument();
  });

  it('shows the mail of a mailbox it has already read at once when the person goes back to it', async () => {
    const user = userEvent.setup();
    render();
    await screen.findByText('My own mail');
    await user.click(await screen.findByRole('button', { name: /Jane Smith's mailbox/ }));
    await screen.findByText('Handed mail');

    await user.click(screen.getByRole('button', { name: /My mailbox/ }));
    expect(await screen.findByText('My own mail')).toBeInTheDocument();
    expect(screen.queryByText('Handed mail')).not.toBeInTheDocument();
    expect(screen.queryByText('Nothing here.')).not.toBeInTheDocument();
  });
});
