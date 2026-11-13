/// <reference types="@testing-library/jest-dom/vitest" />
// Mobile slice 13: on a phone the notifications panel is a bottom sheet, and it must fit the
// VISIBLE screen. A fixed share of `vh` is measured against the largest viewport (browser bars
// retracted), so on iOS Safari with its toolbars showing the sheet's top ran under the address bar.
// The cap is the dynamic viewport height, and the list scrolls inside the sheet instead of the
// sheet growing past it.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationBell } from '../NotificationBell';

vi.mock('@/lib/api/notifications', () => ({
  useUnreadCount: () => ({ data: { unseen: 2 } }),
  useMarkSeen: () => ({ mutate: vi.fn() }),
  useNotifications: () => ({ data: { pages: [{ items: [] }] }, isLoading: false, hasNextPage: false }),
  useReadAll: () => ({ mutate: vi.fn(), isPending: false }),
  useBellLiveUpdates: () => {},
}));
vi.mock('@/lib/notifications/useNotificationRefresh', () => ({ useNotificationRefresh: () => {} }));
vi.mock('@/lib/notifications/useInterruptToasts', () => ({ useInterruptToasts: () => {} }));

const REAL_MATCH_MEDIA = window.matchMedia;

beforeEach(() => {
  // A phone: every max-width query matches.
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('max-width'),
    media: query,
    onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
});
afterEach(() => {
  window.matchMedia = REAL_MATCH_MEDIA;
});

describe('NotificationBell on a phone held sideways (wide, but short)', () => {
  it('opens the height-capped sheet, not the popover that runs off the bottom', async () => {
    // 838x390: no max-width query matches; only the short-height condition does.
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('max-height'),
      media: query,
      onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
    render(<NotificationBell />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Notifications' }));
    const panel = await screen.findByRole('dialog');
    expect(panel.className.split(/\s+/).some((c) => /^max-h-\[\d+dvh\]$/.test(c))).toBe(true);
  });
});

describe('NotificationBell on a phone', () => {
  it('keeps its unread badge on the inline trigger', () => {
    render(<NotificationBell />);
    expect(screen.getByRole('button', { name: 'Notifications' })).toHaveTextContent('2');
  });

  it('opens a bottom sheet capped by the dynamic viewport height, with the list scrolling inside it', async () => {
    render(<NotificationBell />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Notifications' }));
    const sheet = await screen.findByRole('dialog');

    const classes = sheet.className.split(/\s+/);
    expect(classes.some((c) => /^max-h-\[\d+dvh\]$/.test(c))).toBe(true);
    expect(classes.some((c) => /^max-h-\[\d+vh\]$/.test(c))).toBe(false);
    // The sheet is a column whose body can shrink, so a long list scrolls inside the cap.
    expect(classes).toEqual(expect.arrayContaining(['flex', 'flex-col']));
    // The list loads as its own chunk the first time the bell opens (it is kept out of the entry bundle).
    await waitFor(() => expect(sheet.querySelector('[data-slot="notification-list"]')).not.toBeNull());
    const body = sheet.querySelector('[data-slot="notification-list"]')!;
    expect(body.className).toMatch(/\bmin-h-0\b/);
    expect(body.className).toMatch(/\boverflow-y-auto\b/);
  });
});

describe('NotificationBell on a desktop', () => {
  it('loads the list into the popover the first time the bell opens', async () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
    render(<NotificationBell />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Notifications' }));
    expect(await screen.findByText("You're all caught up.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark all read' })).toBeInTheDocument();
  });
});
