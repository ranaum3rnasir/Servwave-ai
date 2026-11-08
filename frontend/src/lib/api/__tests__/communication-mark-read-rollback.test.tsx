/**
 * #2049 (validator r1) - every markThreadRead/markThreadUnread/
 * useMarkEmailThreadRead/useMarkEmailThreadUnread `.mutate()` call site
 * applied its optimistic `unread` change with no rollback: a rejected PATCH
 * left the shared query cache stuck at the optimistic value forever, with no
 * surfaced failure. The rollback lives INSIDE each hook (onMutate snapshots,
 * onError restores + toasts, onSettled invalidates) so every call site
 * (SmsInboxView, EntitySmsDrawer, InboxPage) inherits it - one test per hook.
 *
 * The PATCH is held pending (a manually-controlled promise) rather than
 * rejected up front, so the test can observe the transient optimistic write
 * BEFORE rejecting it - an immediately-rejected mock settles in the same
 * microtask tick as onMutate, which would make the optimistic write and its
 * rollback indistinguishable from "never wrote anything at all".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import {
  useMarkThreadRead,
  useMarkThreadUnread,
  useMarkEmailThreadRead,
  useMarkEmailThreadUnread,
  useMarkWhatsAppChatRead,
  useMarkWhatsAppChatUnread,
  type MessageThread,
  type Email,
  type WAChat,
} from '@/lib/api/communication';

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn(), useToast: () => ({ toast: vi.fn() }) }));

const mockApi = vi.mocked(api);

function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

/** A PATCH the test controls the settlement of, so the optimistic write is
 *  observable before the rejection restores it. */
function pendingPatch() {
  let reject!: (err: unknown) => void;
  const promise = new Promise((_resolve, rej) => {
    reject = rej;
  });
  mockApi.patch.mockReturnValue(promise as ReturnType<typeof api.patch>);
  return { reject };
}

const THREAD_A: MessageThread = {
  id: 't1',
  customerId: 'cust-1',
  channel: 'sms',
  campaignType: 'customer_care',
  unread: 3,
  messages: [],
};

const EMAIL_A: Email = {
  id: 'e1',
  account: 'system',
  from: { name: null, email: 'a@example.com' },
  to: 'org@example.com',
  subject: 's',
  snippet: 's',
  body: ['s'],
  at: '1:00',
  ts: 1,
  unread: true,
  starred: false,
  folder: 'inbox',
  threadId: 't1',
};

const CHAT_A: WAChat = {
  id: 'chat-1',
  name: 'Jordan Lee',
  org: 'Lee HVAC',
  phone: '(212) 555-0100',
  unread: 3,
  lastAt: '9:00 AM',
  messages: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useMarkThreadRead rollback', () => {
  it('a rejected PATCH restores the previous unread count on both caches', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    qc.setQueryData(['communication', 'threads'], [THREAD_A]);
    qc.setQueryData(['communication', 'thread', 't1'], THREAD_A);
    const { reject } = pendingPatch();

    const { result } = renderHook(() => useMarkThreadRead(), { wrapper: wrapper(qc) });
    act(() => {
      result.current.mutate('t1');
    });

    // Optimistic write lands while the PATCH is still in flight.
    await waitFor(() =>
      expect(qc.getQueryData<MessageThread[]>(['communication', 'threads'])?.[0]?.unread).toBe(0),
    );
    expect(qc.getQueryData<MessageThread>(['communication', 'thread', 't1'])?.unread).toBe(0);

    act(() => reject(new Error('network down')));
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(qc.getQueryData<MessageThread[]>(['communication', 'threads'])?.[0]?.unread).toBe(3);
    expect(qc.getQueryData<MessageThread>(['communication', 'thread', 't1'])?.unread).toBe(3);
    expect(toast).toHaveBeenCalled();
  });
});

describe('useMarkThreadUnread rollback', () => {
  it('a rejected PATCH restores the previous unread count', async () => {
    const readThread = { ...THREAD_A, unread: 0 };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    qc.setQueryData(['communication', 'threads'], [readThread]);
    qc.setQueryData(['communication', 'thread', 't1'], readThread);
    const { reject } = pendingPatch();

    const { result } = renderHook(() => useMarkThreadUnread(), { wrapper: wrapper(qc) });
    act(() => {
      result.current.mutate('t1');
    });

    await waitFor(() =>
      expect(qc.getQueryData<MessageThread[]>(['communication', 'threads'])?.[0]?.unread).toBeGreaterThan(0),
    );

    act(() => reject(new Error('network down')));
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(qc.getQueryData<MessageThread[]>(['communication', 'threads'])?.[0]?.unread).toBe(0);
    expect(qc.getQueryData<MessageThread>(['communication', 'thread', 't1'])?.unread).toBe(0);
    expect(toast).toHaveBeenCalled();
  });
});

describe('useMarkEmailThreadRead rollback', () => {
  it('a rejected PATCH restores the previous read flag', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    qc.setQueryData(['communication', 'emails'], [EMAIL_A]);
    const { reject } = pendingPatch();

    const { result } = renderHook(() => useMarkEmailThreadRead(), { wrapper: wrapper(qc) });
    act(() => {
      result.current.mutate('t1');
    });

    await waitFor(() =>
      expect(qc.getQueryData<Email[]>(['communication', 'emails'])?.[0]?.unread).toBe(false),
    );

    act(() => reject(new Error('network down')));
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(qc.getQueryData<Email[]>(['communication', 'emails'])?.[0]?.unread).toBe(true);
    expect(toast).toHaveBeenCalled();
  });
});

describe('useMarkEmailThreadUnread rollback', () => {
  it('a rejected PATCH restores the previous read flag', async () => {
    const readEmail = { ...EMAIL_A, unread: false };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    qc.setQueryData(['communication', 'emails'], [readEmail]);
    const { reject } = pendingPatch();

    const { result } = renderHook(() => useMarkEmailThreadUnread(), { wrapper: wrapper(qc) });
    act(() => {
      result.current.mutate('t1');
    });

    await waitFor(() =>
      expect(qc.getQueryData<Email[]>(['communication', 'emails'])?.[0]?.unread).toBe(true),
    );

    act(() => reject(new Error('network down')));
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(qc.getQueryData<Email[]>(['communication', 'emails'])?.[0]?.unread).toBe(false);
    expect(toast).toHaveBeenCalled();
  });
});

// #2049 slice 2 - the WhatsApp mirror of the SMS rollback above. Only ONE
// cache key (`['communication','whatsapp']` - there is no by-id WhatsApp
// query on the frontend), unlike the SMS pair's two.
describe('useMarkWhatsAppChatRead rollback', () => {
  it('a rejected PATCH restores the previous unread count', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    qc.setQueryData(['communication', 'whatsapp'], [CHAT_A]);
    const { reject } = pendingPatch();

    const { result } = renderHook(() => useMarkWhatsAppChatRead(), { wrapper: wrapper(qc) });
    act(() => {
      result.current.mutate('chat-1');
    });

    await waitFor(() =>
      expect(qc.getQueryData<WAChat[]>(['communication', 'whatsapp'])?.[0]?.unread).toBe(0),
    );

    act(() => reject(new Error('network down')));
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(qc.getQueryData<WAChat[]>(['communication', 'whatsapp'])?.[0]?.unread).toBe(3);
    expect(toast).toHaveBeenCalled();
  });
});

describe('useMarkWhatsAppChatUnread rollback', () => {
  it('a rejected PATCH restores the previous unread count', async () => {
    const readChat = { ...CHAT_A, unread: 0 };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    qc.setQueryData(['communication', 'whatsapp'], [readChat]);
    const { reject } = pendingPatch();

    const { result } = renderHook(() => useMarkWhatsAppChatUnread(), { wrapper: wrapper(qc) });
    act(() => {
      result.current.mutate('chat-1');
    });

    await waitFor(() =>
      expect(qc.getQueryData<WAChat[]>(['communication', 'whatsapp'])?.[0]?.unread).toBeGreaterThan(0),
    );

    act(() => reject(new Error('network down')));
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(qc.getQueryData<WAChat[]>(['communication', 'whatsapp'])?.[0]?.unread).toBe(0);
    expect(toast).toHaveBeenCalled();
  });
});
