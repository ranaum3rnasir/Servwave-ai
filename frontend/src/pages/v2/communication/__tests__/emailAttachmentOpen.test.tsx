/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions, PRD 10, slice S10.17 (fix) - an email attachment opens from the Email page's reading pane.
// Nobody could open one: the chip was a plain label and nothing called GET /emails/:id/attachments/:index, which signs a
// short-lived link under the message's own reach rule. The page runs for real here (the real email list query, the
// real open hook); only the network answers, so what is on screen is what the server said.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderInbox, serveInbox } from '@/__tests__/harness/inboxPage';
import { buildAbility } from '@/lib/ability';
import type { Email, MailboxList } from '@/lib/api/communication';

const ability = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'access_inbox', subject: 'Communication' },
]);

const hoisted = vi.hoisted(() => ({ attachmentGet: vi.fn() }));

const MAIL: Email = {
  id: 'mail-1', account: 'system', from: { name: 'Pat Payer', email: 'pat@example.com' }, to: 'office@example.com',
  subject: 'Photos of the damaged door', snippet: 'Here are the photos.', body: ['Here are the photos.'], at: '9:41 AM',
  ts: 1, unread: false, starred: false, folder: 'inbox', direction: 'in', threadId: 't1', hasAttachment: true,
  attachments: [
    { name: 'door-front.jpg', size: '2.1 MB', sizeBytes: 2_100_000, mimeType: 'image/jpeg', index: 0 },
    { name: 'quote.pdf', size: '70 KB', sizeBytes: 70_000, mimeType: 'application/pdf', index: 1 },
  ],
};

const LIST: MailboxList = {
  scope: 'attached', selected: 'mine', selected_label: null, selected_unread: 0, total_unread: 0,
  mine: { id: 'box-mine', unread: 0 }, held: [], main: null, people: null,
};

let rows: Email[] = [MAIL];

vi.mock('@/lib/api/communication', async (importOriginal) =>
  (await import('@/__tests__/harness/inboxApiStub')).communicationStubs(await importOriginal<typeof import('@/lib/api/communication')>()));

vi.mock('@/lib/entitlements', async (importOriginal) =>
  (await import('@/__tests__/harness/inboxApiStub')).inboxEntitlements(await importOriginal<typeof import('@/lib/entitlements')>()));

const refusal = (status: number) => Promise.reject({ response: { status, data: { error: 'Insufficient permissions' } } });

type FakeTab = { location: { href: string }; opener: unknown; close: ReturnType<typeof vi.fn> };
let tabs: FakeTab[];
const originalOpen = window.open;
const tabAt = (n: number): FakeTab => {
  const tab = tabs[n];
  if (!tab) throw new Error(`No tab was opened at position ${n}`);
  return tab;
};

async function openMail() {
  const user = userEvent.setup();
  renderInbox({ ability, entry: '/communication/inbox' });
  await user.click(await screen.findByText('Photos of the damaged door'));
  return user;
}

beforeEach(() => {
  rows = [MAIL];
  tabs = [];
  hoisted.attachmentGet.mockReset();
  serveInbox({
    // An attachment's bytes come from the test's own spy, which answers the whole client response (or refuses).
    routes: [{ match: (url) => url.includes('/attachments/'), data: (url, config) => hoisted.attachmentGet(url, config), raw: true }],
    mailboxes: LIST,
    emails: () => rows,
    otherwise: () => ({ emails: rows }),
  });
  window.open = vi.fn(() => {
    const tab: FakeTab = { location: { href: '' }, opener: {}, close: vi.fn() };
    tabs.push(tab);
    return tab as unknown as Window;
  });
});

afterEach(() => {
  window.open = originalOpen;
});

describe('an email attachment opens from the reading pane', () => {
  it('is a real button named for the file, and asks for no link until it is clicked', async () => {
    await openMail();

    expect(await screen.findByRole('button', { name: 'Open door-front.jpg' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open quote.pdf' })).toBeInTheDocument();
    expect(hoisted.attachmentGet).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toMatch(/token=|signed/i);
  });

  it('asks the route for the clicked file and opens the link it answers in a new tab', async () => {
    hoisted.attachmentGet.mockResolvedValue({ data: { url: 'https://files.example.com/door-front.jpg?token=one' } });
    const user = await openMail();

    await user.click(await screen.findByRole('button', { name: 'Open door-front.jpg' }));

    await waitFor(() => expect(tabs[0]?.location.href).toBe('https://files.example.com/door-front.jpg?token=one'));
    expect(hoisted.attachmentGet).toHaveBeenCalledTimes(1);
    expect(hoisted.attachmentGet.mock.calls[0]?.[0]).toBe('/api/communication/emails/mail-1/attachments/0');
    expect(tabAt(0).opener).toBeNull();
  });

  it('asks for the second file by its own position', async () => {
    hoisted.attachmentGet.mockResolvedValue({ data: { url: 'https://files.example.com/quote.pdf?token=pdf' } });
    const user = await openMail();

    await user.click(await screen.findByRole('button', { name: 'Open quote.pdf' }));

    await waitFor(() => expect(tabs[0]?.location.href).toBe('https://files.example.com/quote.pdf?token=pdf'));
    expect(hoisted.attachmentGet.mock.calls[0]?.[0]).toBe('/api/communication/emails/mail-1/attachments/1');
  });

  it('asks for a fresh link on every click, never reusing the last one', async () => {
    hoisted.attachmentGet
      .mockResolvedValueOnce({ data: { url: 'https://files.example.com/door-front.jpg?token=one' } })
      .mockResolvedValueOnce({ data: { url: 'https://files.example.com/door-front.jpg?token=two' } });
    const user = await openMail();
    const chip = await screen.findByRole('button', { name: 'Open door-front.jpg' });

    await user.click(chip);
    await waitFor(() => expect(tabs[0]?.location.href).toMatch(/token=one$/));
    await user.click(chip);
    await waitFor(() => expect(tabs[1]?.location.href).toMatch(/token=two$/));

    expect(hoisted.attachmentGet).toHaveBeenCalledTimes(2);
    expect(document.body.innerHTML).not.toMatch(/token=/);
  });

  it('says "You don\'t have access" on a refusal and closes the tab it opened', async () => {
    hoisted.attachmentGet.mockImplementation(() => refusal(403));
    const user = await openMail();

    await user.click(await screen.findByRole('button', { name: 'Open door-front.jpg' }));

    expect(await screen.findByText("You don't have access to this attachment")).toBeInTheDocument();
    expect(tabAt(0).close).toHaveBeenCalled();
    expect(tabAt(0).location.href).toBe('');
    expect(screen.getByRole('button', { name: 'Open door-front.jpg' })).toBeInTheDocument();
  });

  it('says the file is gone on a not-found, and shows the server text nowhere', async () => {
    hoisted.attachmentGet.mockImplementation(() => refusal(404));
    const user = await openMail();

    await user.click(await screen.findByRole('button', { name: 'Open door-front.jpg' }));

    expect(await screen.findByText('This attachment is no longer available')).toBeInTheDocument();
    expect(screen.queryByText(/Insufficient permissions/)).not.toBeInTheDocument();
    expect(tabAt(0).close).toHaveBeenCalled();
  });

  it('hides the chips when the plan has no Email (402)', async () => {
    hoisted.attachmentGet.mockImplementation(() => refusal(402));
    const user = await openMail();

    await user.click(await screen.findByRole('button', { name: 'Open door-front.jpg' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open door-front.jpg' })).not.toBeInTheDocument());
    expect(tabAt(0).close).toHaveBeenCalled();
  });

  it('offers a retry when the fetch fails, and opens the file when the retry works', async () => {
    hoisted.attachmentGet
      .mockImplementationOnce(() => refusal(500))
      .mockResolvedValueOnce({ data: { url: 'https://files.example.com/door-front.jpg?token=again' } });
    const user = await openMail();

    await user.click(await screen.findByRole('button', { name: 'Open door-front.jpg' }));
    const retry = await screen.findByRole('button', { name: 'Retry opening door-front.jpg' });
    expect(tabAt(0).close).toHaveBeenCalled();

    await user.click(retry);

    await waitFor(() => expect(tabs[1]?.location.href).toBe('https://files.example.com/door-front.jpg?token=again'));
    expect(screen.queryByRole('button', { name: /Retry opening/ })).not.toBeInTheDocument();
  });

  it('treats an answer with no link as a failed fetch, not a blank tab', async () => {
    hoisted.attachmentGet.mockResolvedValue({ data: { url: '' } });
    const user = await openMail();

    await user.click(await screen.findByRole('button', { name: 'Open quote.pdf' }));

    expect(await screen.findByRole('button', { name: 'Retry opening quote.pdf' })).toBeInTheDocument();
    expect(tabAt(0).location.href).toBe('');
  });

  it('falls back to a plain link open when the browser blocks the new tab', async () => {
    window.open = vi.fn().mockReturnValueOnce(null).mockReturnValue(null);
    hoisted.attachmentGet.mockResolvedValue({ data: { url: 'https://files.example.com/quote.pdf?token=late' } });
    const user = await openMail();

    await user.click(await screen.findByRole('button', { name: 'Open quote.pdf' }));

    await waitFor(() =>
      expect(window.open).toHaveBeenLastCalledWith('https://files.example.com/quote.pdf?token=late', '_blank', 'noopener,noreferrer'),
    );
  });

  it('leaves a file with no stored copy behind it as a plain label', async () => {
    rows = [{ ...MAIL, attachments: [{ name: 'old-scan.pdf', size: '12 KB' }] }];
    await openMail();

    expect(await screen.findByText('old-scan.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /old-scan\.pdf/ })).not.toBeInTheDocument();
  });
});
