// EntitySmsDrawer — the entity-tab wrapper behind a clicked SMS row on the
// Job / Customer / Lead Communication tabs: a right-side slide-in showing the
// customer's SMS conversation (chat parity with the call detail drawer).
//
// #2046 (R1) — rewritten, not extended: the drawer used to key off `customerId`
// and read the section-gated org-wide `useMessageThreads()` list; it now keys
// off `threadId` (`CommItem.threadId`) and reads the anchor-filtered by-id
// `useMessageThread(threadId)`, which stays reachable for a caller holding
// `read Communication` alone. `useMessageThread` is mocked so this suite stays
// focused on the drawer.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const useMessageThreadMock = vi.hoisted(() => vi.fn());
// #2049 - the persisting read-state mutation the drawer fires on open.
const markThreadReadMutate = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/communication', async () => ({
  useMessageThread: useMessageThreadMock,
  useMarkThreadRead: () => ({ mutate: markThreadReadMutate }),
  fmtPhone: (n: string) => n,
  // Real (pure) delivery-presentation helpers - stubbing these would make the
  // bubble assertions test the stub instead of the honest-status mapping.
  ...(await vi.importActual<
    typeof import('@/lib/api/communication-shared/messageDelivery')
  >('@/lib/api/communication-shared/messageDelivery')),
}));

// Bubble times render on the ORG's clock, so the drawer reads the org query. This
// suite renders it bare (no QueryClientProvider), so the zone is pinned here.
vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => ({ data: { timezone: 'America/New_York' } }),
}));

import { EntitySmsDrawer } from '@/components/communication/shared/EntitySmsDrawer';

const THREAD_ID = 't1';

const THREAD = {
  id: THREAD_ID,
  customerId: 'cust-1',
  channel: 'sms',
  campaignType: 'customer_care',
  unread: 0,
  messages: [
    { id: 'm1', direction: 'in', body: 'Is my tech still coming?', ts: '2026-07-15T14:00:00Z' },
    { id: 'm2', direction: 'out', body: 'Yes — ETA 2pm.', ts: '2026-07-15T14:01:00Z' },
  ],
};

describe('EntitySmsDrawer', () => {
  beforeEach(() => {
    markThreadReadMutate.mockClear();
  });

  it('renders the conversation bubbles (both directions) from the by-id thread', () => {
    useMessageThreadMock.mockReturnValue({ data: THREAD, isLoading: false });
    render(<EntitySmsDrawer threadId={THREAD_ID} customerName="Jane Doe" onClose={vi.fn()} />);

    expect(useMessageThreadMock).toHaveBeenCalledWith(THREAD_ID);
    expect(screen.getByText('Is my tech still coming?')).toBeInTheDocument();
    expect(screen.getByText('Yes — ETA 2pm.')).toBeInTheDocument();
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
  });

  // #2049 - opening the drawer fires exactly one persisting read PATCH.
  it('fires exactly one mark-thread-read mutation for this threadId on open', () => {
    useMessageThreadMock.mockReturnValue({ data: THREAD, isLoading: false });
    render(<EntitySmsDrawer threadId={THREAD_ID} customerName="Jane Doe" onClose={vi.fn()} />);

    expect(markThreadReadMutate).toHaveBeenCalledTimes(1);
    expect(markThreadReadMutate).toHaveBeenCalledWith(THREAD_ID);
  });

  // No threadId (an optimistic row still in flight) - nothing to mark read yet.
  it('does not fire the mutation when the row carries no threadId', () => {
    useMessageThreadMock.mockReturnValue({ data: undefined, isLoading: false });
    render(<EntitySmsDrawer customerName="Jane Doe" onClose={vi.fn()} />);

    expect(markThreadReadMutate).not.toHaveBeenCalled();
  });

  it('shows an empty state when the thread has no messages', () => {
    useMessageThreadMock.mockReturnValue({
      data: { ...THREAD, messages: [] },
      isLoading: false,
    });
    render(<EntitySmsDrawer threadId={THREAD_ID} customerName="Bob" onClose={vi.fn()} />);

    expect(screen.getByText(/no messages in this conversation yet/i)).toBeInTheDocument();
    expect(screen.queryByText('Yes — ETA 2pm.')).not.toBeInTheDocument();
  });

  it('shows a loading state while the thread loads', () => {
    useMessageThreadMock.mockReturnValue({ data: undefined, isLoading: true });
    render(<EntitySmsDrawer threadId={THREAD_ID} onClose={vi.fn()} />);

    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('closes on Escape (Sheet dismiss)', async () => {
    const onClose = vi.fn();
    useMessageThreadMock.mockReturnValue({ data: THREAD, isLoading: false });
    render(<EntitySmsDrawer threadId={THREAD_ID} onClose={onClose} />);

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
