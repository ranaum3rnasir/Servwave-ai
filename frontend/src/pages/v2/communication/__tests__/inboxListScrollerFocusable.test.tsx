/// <reference types="@testing-library/jest-dom/vitest" />
// Mobile slice 46 follow-up: the inbox list scroller must be keyboard-reachable on a landscape phone.
//
// At 568x320 the page header, search box and the "Nothing here." empty state are taller than the
// list's box, so the list scrolls, and with no message rows in it there is nothing focusable inside
// (axe `scrollable-region-focusable`, WCAG 2.1.1). While it scrolls AND holds no rows, the list is a
// named, focusable region. With rows (each is a button) or while it fits, it adds no tab stop, so a
// desktop tab order is as it was.
//
// jsdom lays nothing out, so overflow is simulated through scrollHeight / clientHeight.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderInbox } from '@/__tests__/harness/inboxPage';
import { buildAbility } from '@/lib/ability';
import type { Email } from '@/lib/api/communication';

const ability = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'update', subject: 'Communication' },
]);

const ROW: Email = {
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
};

const state = { emails: [] as Email[] };

vi.mock('@/lib/api/communication', async (importOriginal) =>
  (await import('@/__tests__/harness/inboxApiStub')).communicationStubs(await importOriginal<typeof import('@/lib/api/communication')>(), {
    leave: ['useMyMailbox'],
    hooks: { useEmails: () => ({ data: state.emails }) },
  }));

const restore: Array<() => void> = [];
afterEach(() => {
  while (restore.length) restore.pop()!();
  vi.unstubAllGlobals();
  state.emails = [];
});

/** Every element reports this scroll size, so whichever element the page measures sees it. */
function layout(scrollHeight: number, clientHeight: number) {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  for (const [key, value] of [['scrollHeight', scrollHeight], ['clientHeight', clientHeight]] as const) {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, key);
    Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => value });
    restore.push(() => {
      if (original) Object.defineProperty(HTMLElement.prototype, key, original);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
    });
  }
}

const render = () => renderInbox({ ability });

describe('inbox list scroller keyboard access (axe scrollable-region-focusable)', () => {
  it('is a focusable, named region while an empty list scrolls', () => {
    layout(400, 120);
    render();
    const region = screen.queryByRole('region', { name: 'Messages' });
    expect(region, 'region named Messages').not.toBeNull();
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toHaveTextContent('Nothing here.');
    expect(region!.className).toContain('overflow-y-auto');
    // Keyboard focus only: a tap draws no ring.
    expect(region!.className).toContain('focus-visible:outline');
  });

  it('adds no tab stop while the empty list fits (a desktop looks and tabs as before)', () => {
    layout(120, 120);
    render();
    expect(screen.queryByRole('region', { name: 'Messages' })).toBeNull();
    const list = screen.getByText('Nothing here.').closest('.overflow-y-auto')!;
    expect(list).toHaveAttribute('tabindex', '-1');
  });

  it('adds no tab stop when it scrolls but holds message rows (each row is already focusable)', () => {
    state.emails = [ROW];
    layout(900, 120);
    render();
    expect(screen.queryByRole('region', { name: 'Messages' })).toBeNull();
    const row = screen.getByText('AC still not cooling').closest('button')!;
    expect(row).toBeInTheDocument();
    expect(row.closest('[tabindex="-1"]')).not.toBeNull();
  });
});
