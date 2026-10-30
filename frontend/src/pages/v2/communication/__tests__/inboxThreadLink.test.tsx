/// <reference types="@testing-library/jest-dom/vitest" />
// The bell of a received email opens the conversation it is about: the ROUTED Email page (/communication/inbox renders this
// InboxPage) reads `?thread=` from the page address, opens that conversation in the reader once the mailbox's mail is in, marks it
// read, and takes the ask out of the address so a reload does not open it again. A conversation the person's list does not hold
// leaves the page as it is.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import type { Email } from '@/lib/api/communication';

const hoisted = vi.hoisted(() => ({ markThreadReadMutate: vi.fn() }));

const message = (id: string, threadId: string, extra: Partial<Email> = {}): Email => ({
  id, threadId, account: 'system', from: { name: 'Dana Lee', email: 'dana@example.com' }, to: 'main@mail.test',
  subject: `Subject of ${threadId}`, snippet: 'snippet', body: [`Body of ${id}`], at: '9:41 AM', ts: 1, unread: true, starred: false,
  folder: 'inbox', ...extra,
});

const EMAILS: Email[] = [
  message('m-other', 'thr-other', { ts: 9 }),
  message('m-old', 'thr-asked', { ts: 2 }),
  message('m-new', 'thr-asked', { ts: 3 }),
];
const NOTHING: unknown[] = [];

vi.mock('@/lib/api/communication', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/communication')>();
  return {
    ...actual,
    useEmails: () => ({ data: EMAILS }),
    useEmailGroups: () => ({ data: NOTHING }),
    useForwardRules: () => ({ data: NOTHING }),
    useTeamMembers: () => ({ data: NOTHING }),
    useSendingIdentity: () => ({ data: { status: 'active', address: 'me@mail.test', name: 'Me', sendingEnabled: true } }),
    useMarkEmailThreadRead: () => ({ mutate: hoisted.markThreadReadMutate }),
    useMarkEmailThreadUnread: () => ({ mutate: vi.fn() }),
    useSendEmail: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

import InboxPage from '@/pages/v2/communication/InboxPage';

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}
const ability = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'access_inbox', subject: 'Communication' },
]);
const renderAt = (entry: string) => renderWithProviders(<><InboxPage /><Where /></>, { ability, initialEntries: [entry] });

beforeEach(() => hoisted.markThreadReadMutate.mockClear());

describe('the Email page opened by a received-email bell (?thread=)', () => {
  it('opens the conversation the address names, marks it read and takes the ask out of the address', async () => {
    renderAt('/communication/inbox?thread=thr-asked');

    expect(await screen.findByText('Body of m-new')).toBeInTheDocument();
    expect(hoisted.markThreadReadMutate).toHaveBeenCalledWith('thr-asked');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/communication\/inbox$/));
  });

  it('leaves no conversation open when the list does not hold the one asked for, and still clears the address', async () => {
    renderAt('/communication/inbox?thread=thr-missing');

    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/communication\/inbox$/));
    expect(screen.queryByText(/^Body of /)).not.toBeInTheDocument();
    expect(hoisted.markThreadReadMutate).not.toHaveBeenCalled();
  });
});
