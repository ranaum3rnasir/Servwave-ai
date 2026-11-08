/// <reference types="@testing-library/jest-dom/vitest" />
// #2046 (R1, AC7b) - EntitySmsDrawer end-to-end, with NO mock on `@/lib/api/communication`: the
// real `useMessageThread(threadId)` hook, the real `GET /api/communication/threads/:id` route
// path, and a `read Communication`-only ability (the SALES shape the reproducer pins - no section
// gate). Proves the drawer keeps working off the anchor-filtered by-id read alone, and that it
// never touches the section-gated org-wide list.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import api from '@/lib/axios';
import { AbilityProvider } from '@/contexts/AbilityContext';
import { readOnlyCommunicationAbility } from './helpers';
import { EntitySmsDrawer } from '@/components/communication/shared/EntitySmsDrawer';

const mockApi = vi.mocked(api);

vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => ({ data: { timezone: 'America/New_York' } }),
}));

const THREAD_ID = 'th00000000-0000-0000-0000-000000000001';

function renderDrawer() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AbilityProvider ability={readOnlyCommunicationAbility()}>
        <EntitySmsDrawer threadId={THREAD_ID} customerName="qa-2046-customer" onClose={vi.fn()} />
      </AbilityProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('#2046 AC7b - EntitySmsDrawer via the by-id thread endpoint, read-only-Communication ability', () => {
  it('issues exactly one GET to /threads/:id and none to the org-wide list, and renders the thread', async () => {
    mockApi.get.mockResolvedValue({
      data: {
        thread: {
          id: THREAD_ID,
          channel: 'sms',
          campaignType: 'customer_care',
          unread: 0,
          messages: [
            { id: 'm1', direction: 'in', body: 'qa-2046 lead message', ts: '2026-07-15T14:00:00Z' },
          ],
        },
      },
    });
    // #2049 - opening the drawer also fires the persisting read PATCH; this
    // ability shape (`read Communication` alone, no `access_inbox`) is
    // exactly what the re-gated route is FOR.
    mockApi.patch.mockResolvedValue({ data: { updated: 1 } });

    renderDrawer();

    expect(await screen.findByText('qa-2046 lead message')).toBeInTheDocument();

    expect(mockApi.get).toHaveBeenCalledWith(`/api/communication/threads/${THREAD_ID}`);
    expect(mockApi.get).not.toHaveBeenCalledWith('/api/communication/threads');
    await waitFor(() => {
      expect(mockApi.patch).toHaveBeenCalledTimes(1);
      expect(mockApi.patch).toHaveBeenCalledWith(`/api/communication/threads/${THREAD_ID}/read`);
    });
  });

  it('fires no request at all when the row carries no thread id', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AbilityProvider ability={readOnlyCommunicationAbility()}>
          <EntitySmsDrawer customerName="qa-2046-customer" onClose={vi.fn()} />
        </AbilityProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByText(/no messages in this conversation yet/i)).toBeInTheDocument();
    expect(mockApi.get).not.toHaveBeenCalled();
  });
});
