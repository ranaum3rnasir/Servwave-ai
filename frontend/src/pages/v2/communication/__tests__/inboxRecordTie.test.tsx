/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions, PRD 10, slice S10.9 - the Email page names the job or lead a record conversation is about.
// The server answers at the API layer (the REAL email list query runs), so what is on screen is what the server sent:
// the number to show and the record to link to. Nothing here works the record out.
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import type { Email, MailboxList } from '@/lib/api/communication';

const ability = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'access_inbox', subject: 'Communication' },
]);

const NOTHING: unknown[] = [];

const mail = (over: Partial<Email> & { id: string; subject: string }): Email => ({
  account: 'system', from: { name: 'Pat Payer', email: 'pat@example.com' }, to: 'office@example.com', snippet: 'Thanks, that works.',
  body: ['Thanks, that works.'], at: '9:41 AM', ts: 1, unread: true, starred: false, folder: 'inbox', direction: 'in', ...over,
});

const ROWS: Email[] = [
  mail({ id: 'on-job', subject: 'Re: Your appointment', threadId: 't1', ts: 5, recordTie: { kind: 'job', id: 'job-1', label: 'J-1042' } }),
  mail({ id: 'on-lead', subject: 'Re: Your estimate', threadId: 't2', ts: 4, recordTie: { kind: 'lead', id: 'lead-1', label: 'L-0377' } }),
  mail({ id: 'plain', subject: 'Question about pricing', threadId: 't3', ts: 3 }),
];

const LIST: MailboxList = {
  scope: 'attached', selected: 'mine', selected_label: null, selected_unread: 3, total_unread: 3,
  mine: { id: 'box-mine', unread: 3 }, held: [], main: null, people: null,
};

vi.mock('@/lib/axios', () => ({
  default: {
    get: (url: string) => Promise.resolve({ data: url.endsWith('/mailboxes') ? LIST : { emails: ROWS } }),
  },
}));

vi.mock('@/lib/api/communication', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/communication')>();
  return {
    ...actual,
    useEmailGroups: () => ({ data: NOTHING }),
    useForwardRules: () => ({ data: NOTHING }),
    useTeamMembers: () => ({ data: NOTHING }),
    useSendingIdentity: () => ({ data: undefined }),
    useMarkEmailThreadRead: () => ({ mutate: vi.fn() }),
    useMarkEmailThreadUnread: () => ({ mutate: vi.fn() }),
    useSendEmail: () => ({ mutate: vi.fn(), isPending: false }),
    useMyMailbox: () => ({ data: { mailbox: null } }),
  };
});

vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => true,
  useEntitlementsReady: () => true,
}));

import InboxPage from '@/pages/v2/communication/InboxPage';


const rowOf = async (subject: string) => {
  const row = (await screen.findByText(subject)).closest('[data-email-row]');
  expect(row).not.toBeNull();
  return row as HTMLElement;
};

describe('the Email page names the job or lead a record conversation belongs to', () => {
  it('shows the job number and the lead number on their rows, and nothing on a conversation about no record', async () => {
    renderWithProviders(<InboxPage />, { ability, initialEntries: ['/communication/inbox'] });

    expect(within(await rowOf('Re: Your appointment')).getByText('J-1042')).toBeInTheDocument();
    expect(within(await rowOf('Re: Your estimate')).getByText('L-0377')).toBeInTheDocument();
    const plain = within(await rowOf('Question about pricing'));
    expect(plain.queryByText(/J-\d|L-\d/)).not.toBeInTheDocument();
    expect(plain.queryByText('no job')).not.toBeInTheDocument();
  });

  it('links the open conversation to its job or lead, from the number the server sent', async () => {
    const user = userEvent.setup();
    renderWithProviders(<InboxPage />, { ability, initialEntries: ['/communication/inbox'] });

    await user.click(await screen.findByText('Re: Your appointment'));
    expect(await screen.findByRole('link', { name: /J-1042/ })).toHaveAttribute('href', '/jobs/job-1');

    await user.click(await screen.findByText('Re: Your estimate'));
    expect(await screen.findByRole('link', { name: /L-0377/ })).toHaveAttribute('href', '/leads/lead-1');
  });
});
