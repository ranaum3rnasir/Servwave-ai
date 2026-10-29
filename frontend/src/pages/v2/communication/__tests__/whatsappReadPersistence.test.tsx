/// <reference types="@testing-library/jest-dom/vitest" />
// #2049 slice 2 - `WhatsAppPage`'s `openChat` used to zero `unread` in local
// React state only, with no network call (the same bug SMS's `openThread` had
// before slice 1). Opening a chat now also fires the persisting
// `useMarkWhatsAppChatRead` mutation, mirroring `EntitySmsDrawer`'s
// mount-time mutation and `SmsInboxView.openThread`.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import type { WAChat } from '@/lib/api/communication-shared';

const hoisted = vi.hoisted(() => ({
  markChatReadMutate: vi.fn(),
}));

const CHATS_FIXTURE: WAChat[] = [
  {
    id: 'chat-1',
    name: 'Jordan Lee',
    org: 'Lee HVAC',
    phone: '(212) 555-0100',
    unread: 2,
    lastAt: '9:00 AM',
    messages: [{ id: 'm1', from: 'them', text: 'hey there', at: '8:59 AM' }],
  },
  {
    id: 'chat-2',
    name: 'Alex Rivera',
    org: 'Rivera Plumbing',
    phone: '(212) 555-0101',
    unread: 0,
    lastAt: '8:00 AM',
    messages: [],
  },
];

vi.mock('@/lib/api/communication', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/communication')>();
  return {
    ...actual,
    useWhatsAppChats: () => ({ data: CHATS_FIXTURE }),
    useSendWhatsApp: () => ({ mutate: vi.fn() }),
    useMarkWhatsAppChatRead: () => ({ mutate: hoisted.markChatReadMutate }),
    useMarkWhatsAppChatUnread: () => ({ mutate: vi.fn() }),
  };
});

import WhatsAppPage from '@/pages/v2/communication/WhatsAppPage';

describe('v2 WhatsAppPage — openChat persists read state (#2049 slice 2)', () => {
  beforeEach(() => {
    hoisted.markChatReadMutate.mockClear();
  });

  it('fires the persisting mutation for the chat that was opened', async () => {
    renderWithProviders(<WhatsAppPage />);

    fireEvent.click(await screen.findByText('Alex Rivera'));

    expect(hoisted.markChatReadMutate).toHaveBeenCalledWith('chat-2');
  });

  it('fires exactly once per open, keyed to the clicked chat id', async () => {
    renderWithProviders(<WhatsAppPage />);

    // "Jordan Lee" (chat-1) renders TWICE once it hydrates as the active
    // chat - once in the list row, once in the conversation header. The list
    // row is the first match in DOM order (the list panel precedes the
    // thread panel in the JSX).
    const rows = await screen.findAllByText('Jordan Lee');
    fireEvent.click(rows[0]!);

    expect(hoisted.markChatReadMutate).toHaveBeenCalledTimes(1);
    expect(hoisted.markChatReadMutate).toHaveBeenCalledWith('chat-1');
  });
});
