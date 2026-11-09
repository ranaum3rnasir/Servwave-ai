/// <reference types="@testing-library/jest-dom/vitest" />
// Mobile slice 46 (rubric CMP-02, CMP-03, A11Y-04): the inbox below lg.
//
//   - the folder rail is closed by default below lg (it used to take 208 px of a 393 px screen);
//   - the reader is ONE content overlay, a real modal dialog that traps focus and gives focus
//     back to the message in the list; it used to be a second copy of the pane in a plain div;
//   - below md the reader's bar keeps Back, Archive, Delete and Reply and moves every other action
//     into the More menu; from md up the bar is the full one, and at lg and up nothing changes;
//   - a reply popped out of the reader is a full-screen form below md, and it stays usable while
//     the reader is open.
//
// jsdom applies no CSS, so width is simulated by answering the kit's own media queries.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderInbox } from '@/__tests__/harness/inboxPage';
import { buildAbility } from '@/lib/ability';
import { MEDIA } from '@/ui-kit/lib/breakpoints';
import type { Email } from '@/lib/api/communication';

const ability = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'update', subject: 'Communication' },
]);

const EMAILS: Email[] = [
  {
    id: 'e_inbox_1',
    account: 'system',
    from: { name: 'Dana Lee', email: 'dana@example.com' },
    to: 'office@example.com',
    subject: 'AC still not cooling',
    snippet: 'Following up on the visit from last week...',
    body: ['Following up on the visit from last week.'],
    at: '9:41 AM',
    ts: 3,
    unread: true,
    starred: false,
    folder: 'inbox',
  },
  {
    id: 'e_inbox_2',
    account: 'system',
    from: { name: 'Sam Ortiz', email: 'sam@example.com' },
    to: 'office@example.com',
    subject: 'Gate code changed',
    snippet: 'The new code is on the back of the card.',
    body: ['The new code is on the back of the card.'],
    at: '8:02 AM',
    ts: 2,
    unread: false,
    starred: false,
    folder: 'inbox',
  },
];

// The standard stubs hold stable references: the page re-seeds state from these in effects keyed on the value, so a
// fresh `[]` per render would loop forever.
vi.mock('@/lib/api/communication', async (importOriginal) =>
  (await import('@/__tests__/harness/inboxApiStub')).communicationStubs(await importOriginal<typeof import('@/lib/api/communication')>(), {
    leave: ['useMyMailbox'],
    hooks: { useEmails: () => ({ data: EMAILS }) },
  }));

type Width = 'phone' | 'tablet' | 'desktop';

/** phone: below md (and so below lg). tablet: md up to lg. desktop: lg and up (jsdom's default). */
function mockWidth(width: Width) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches:
      (query === MEDIA.belowLg && width !== 'desktop') || (query === MEDIA.belowMd && width === 'phone'),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
  mockWidth('desktop');
});

/**
 * `findByRole` / `getByRole` build a dump of every accessible role when they fail, which exhausts
 * the worker's heap on this page. Poll with the quiet `queryByRole` instead, so a red test fails
 * with a short message and not a crashed worker.
 */
async function dialogNamed(name: string): Promise<HTMLElement> {
  await waitFor(() => expect(screen.queryByRole('dialog', { name }), `dialog "${name}"`).not.toBeNull());
  return screen.getByRole('dialog', { name });
}
async function actionBar(): Promise<HTMLElement> {
  await waitFor(() => expect(screen.queryByRole('toolbar', { name: 'Message actions' }), 'action bar').not.toBeNull());
  return screen.getByRole('toolbar', { name: 'Message actions' });
}

function rowFor(subject: string): HTMLElement {
  const row = screen.queryByRole('button', { name: new RegExp(subject) });
  if (!row) throw new Error(`no list row for "${subject}"`);
  return row;
}
const SUBJECT = 'AC still not cooling';

/** Every action the reader's bar has at desktop width, by the name a user hears. */
const ALL_ACTIONS = [
  'Archive', 'Report spam', 'Delete', 'Mark as unread', 'Snooze', 'Add to tasks', 'Reply', 'Forward',
  'Star',
];

describe('inbox rail below lg (CMP-02)', () => {
  it.each(['phone', 'tablet'] as const)('is closed by default at %s width', (width) => {
    mockWidth(width);
    renderInbox({ ability });
    expect(screen.queryByRole('button', { name: 'Open menu' }), 'Open menu').not.toBeNull();
    expect(screen.queryByRole('button', { name: /^Drafts/ }), 'Drafts').toBeNull();
  });

  it('is open by default at desktop width', () => {
    renderInbox({ ability });
    expect(screen.queryByRole('button', { name: /^Drafts/ }), 'Drafts').not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Collapse menu' }), 'Collapse menu').not.toBeNull();
  });

  it('can still be opened by hand on a phone', async () => {
    mockWidth('phone');
    const user = userEvent.setup();
    renderInbox({ ability });
    const openMenu = screen.queryByRole('button', { name: 'Open menu' });
    expect(openMenu, 'Open menu').not.toBeNull();
    await user.click(openMenu!);
    expect(screen.queryByRole('button', { name: /^Drafts/ }), 'Drafts').not.toBeNull();
  });
});

describe('the reader as a content overlay below lg (CMP-03, A11Y-04)', () => {
  it.each(['phone', 'tablet'] as const)('opens as a dialog named by the subject at %s width', async (width) => {
    mockWidth(width);
    const user = userEvent.setup();
    renderInbox({ ability });
    await user.click(rowFor(SUBJECT));
    const dialog = await dialogNamed(SUBJECT);
    expect(dialog).toHaveAttribute('data-slot', 'dialog-content');
    // Full-screen at both widths: below lg it replaces the list, it is not a card over it.
    expect(dialog.className).toContain('inset-0');
    expect(dialog.className).toContain('h-dvh');
    expect(dialog.className).toContain('rounded-none');
  });

  it('puts focus inside and traps it there', async () => {
    mockWidth('phone');
    const user = userEvent.setup();
    renderInbox({ ability });
    await user.click(rowFor(SUBJECT));
    const dialog = await dialogNamed(SUBJECT);
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    for (let i = 0; i < 25; i += 1) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    for (let i = 0; i < 25; i += 1) {
      await user.tab({ shift: true });
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
  });

  it('gives focus back to the message in the list when Back closes it', async () => {
    mockWidth('phone');
    const user = userEvent.setup();
    renderInbox({ ability });
    await user.click(rowFor(SUBJECT));
    const dialog = await dialogNamed(SUBJECT);
    await user.click(within(dialog).getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(rowFor(SUBJECT)));
  });

  it('gives focus back to the message in the list when Escape closes it', async () => {
    mockWidth('phone');
    const user = userEvent.setup();
    renderInbox({ ability });
    // The second message, so the test cannot pass by focusing the first row.
    await user.click(rowFor('Gate code changed'));
    await dialogNamed('Gate code changed');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(rowFor('Gate code changed')));
  });

  it('mounts no dialog and one reader at desktop width', async () => {
    const user = userEvent.setup();
    renderInbox({ ability });
    await user.click(rowFor(SUBJECT));
    expect(await screen.findAllByText(/Following up on the visit/)).not.toHaveLength(0);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // The pane used to be mounted twice (a desktop column and a hidden overlay copy).
    expect(screen.queryAllByRole('toolbar', { name: 'Message actions' })).toHaveLength(1);
  });
});

describe('the reader action bar (CMP-03)', () => {
  const namesIn = (el: HTMLElement) =>
    within(el)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim() ?? '');

  it('keeps four buttons and a More menu on a phone', async () => {
    mockWidth('phone');
    const user = userEvent.setup();
    renderInbox({ ability });
    await user.click(rowFor(SUBJECT));
    const bar = await actionBar();
    expect(namesIn(bar)).toEqual(['Back', 'Archive', 'Delete', 'Reply', 'More']);
  });

  it('reaches every other action through More on a phone', async () => {
    mockWidth('phone');
    const user = userEvent.setup();
    renderInbox({ ability });
    await user.click(rowFor(SUBJECT));
    const bar = await actionBar();
    await user.click(within(bar).getByRole('button', { name: 'More' }));
    const menu = await screen.findByRole('menu');
    const items = within(menu)
      .getAllByRole('menuitem')
      .map((i) => i.textContent?.trim());
    // Every action of the desktop bar is either on the phone bar or in this menu.
    for (const wanted of ['Forward', 'Mark as unread', 'Add to tasks', 'Report spam', 'Add star']) {
      expect(items, wanted).toContain(wanted);
    }
    // Snooze keeps its four choices.
    for (const when of ['Later today', 'Tomorrow', 'This weekend', 'Next week']) {
      expect(items, when).toContain(when);
    }
    // The actions the desktop More menu already held are still in it.
    for (const wanted of ['Mark as important', 'Create event', 'Mute']) {
      expect(items, wanted).toContain(wanted);
    }
  });

  it('runs an action from the menu: Report spam closes the reader', async () => {
    mockWidth('phone');
    const user = userEvent.setup();
    renderInbox({ ability });
    await user.click(rowFor(SUBJECT));
    const bar = await actionBar();
    await user.click(within(bar).getByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Report spam' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('Reported spam & removed from inbox')).toBeInTheDocument();
  });

  it('runs an action from the bar: Archive closes the reader', async () => {
    mockWidth('phone');
    const user = userEvent.setup();
    renderInbox({ ability });
    await user.click(rowFor(SUBJECT));
    const bar = await actionBar();
    await user.click(within(bar).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('Conversation archived')).toBeInTheDocument();
  });

  it('keeps the full bar from md up (tablet)', async () => {
    mockWidth('tablet');
    const user = userEvent.setup();
    renderInbox({ ability });
    await user.click(rowFor(SUBJECT));
    const bar = await actionBar();
    const names = namesIn(bar);
    for (const a of ALL_ACTIONS) expect(names, a).toContain(a);
    expect(names).toContain('More');
  });

  it('keeps the full bar at desktop width', async () => {
    const user = userEvent.setup();
    renderInbox({ ability });
    await user.click(rowFor(SUBJECT));
    const bar = await actionBar();
    const names = namesIn(bar);
    for (const a of ALL_ACTIONS) expect(names, a).toContain(a);
    expect(names).toContain('More');
  });
});

describe('the compose window', () => {
  it('stays a docked card at desktop width, not a dialog', async () => {
    const user = userEvent.setup();
    renderInbox({ ability });
    await user.click(screen.getByRole('button', { name: /Compose/ }));
    await waitFor(() => expect(screen.queryByPlaceholderText('Subject')).not.toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: /Send/ })).not.toBeNull();
  });

  it('is a full-screen form dialog on a phone, with Send inside it', async () => {
    mockWidth('phone');
    const user = userEvent.setup();
    renderInbox({ ability });
    await user.click(screen.getByRole('button', { name: /Compose/ }));
    const compose = await dialogNamed('New message');
    expect(compose).toHaveAttribute('data-presentation', 'fullscreen');
    expect(within(compose).queryByRole('button', { name: /Send/ })).not.toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('a reply popped out of the reader on a phone', () => {
  it('is a full-screen form dialog, and the reader closes so it is not left inert beneath', async () => {
    mockWidth('phone');
    const user = userEvent.setup();
    renderInbox({ ability });
    await user.click(rowFor(SUBJECT));
    const bar = await actionBar();
    await user.click(within(bar).getByRole('button', { name: 'Reply' }));
    await user.click(await screen.findByRole('button', { name: 'Pop out into a window' }));

    const compose = await dialogNamed('Reply');
    expect(compose).toHaveAttribute('data-presentation', 'fullscreen');
    // Send is in the pinned footer, inside the dialog.
    expect(within(compose).getByRole('button', { name: /Send/ })).toBeInTheDocument();
    // Only the compose dialog is open (the reader would have made it inert), so typing works.
    expect(screen.queryAllByRole('dialog')).toHaveLength(1);
    const subject = within(compose).getByPlaceholderText('Subject');
    await user.clear(subject);
    await user.type(subject, 'Re: hello');
    expect(subject).toHaveValue('Re: hello');
  });
});
