/// <reference types="@testing-library/jest-dom/vitest" />
// #2046 - the section-gated data hooks. `useMessageThreads`, `useEmails`, `useWhatsAppChats` and
// `useCalls` must not fire against the org-wide list/aggregate endpoints for a caller who lacks
// `access_inbox Communication`, even when every other condition (entitlement, demo org, CTM
// connection) is satisfied - isolating the ability as the ONLY variable under test.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import api from '@/lib/axios';
import { AbilityProvider } from '@/contexts/AbilityContext';
import { communicationSectionAbility, readOnlyCommunicationAbility } from '@/__tests__/helpers';
import { useAuthStore } from '@/stores/auth.store';
import { useCalls, useMessageThreads, useEmails, useWhatsAppChats } from '@/lib/api/communication';

const mockApi = vi.mocked(api);

vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => ({ data: { phone_connected: false, ctm_account_id: null } }),
}));
vi.mock('@/lib/useIsDemoOrg', () => ({ useIsDemoOrg: () => true }));

function wrapper(ability: ReturnType<typeof communicationSectionAbility>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <AbilityProvider ability={ability}>{children}</AbilityProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: {} });
  // Both comms entitlements on and the payload marked "arrived", so `entitlementsReady` and
  // `canAccess` are both true - the ability is the only thing left to vary below.
  vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
    selector({
      user: {
        id: '00000000-0000-0000-0000-000000000001',
        role: 'SALES',
        org_features: ['phone', 'email'],
      },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    } as never),
  );
});

describe('#2046 section-gated communication hooks', () => {
  it('useCalls stays disabled (fires nothing) for a read-only-Communication ability', async () => {
    const { result } = renderHook(() => useCalls(), { wrapper: wrapper(readOnlyCommunicationAbility()) });

    expect(result.current.fetchStatus).toBe('idle');
    await waitFor(() => expect(result.current.isPending).toBe(true));
    expect(mockApi.get).not.toHaveBeenCalledWith('/api/communication/calls');
  });

  it('useCalls fires for an ability holding the section gate', async () => {
    renderHook(() => useCalls(), { wrapper: wrapper(communicationSectionAbility()) });

    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/communication/calls'));
  });

  it('useMessageThreads stays disabled for a read-only-Communication ability', async () => {
    const { result } = renderHook(() => useMessageThreads(), {
      wrapper: wrapper(readOnlyCommunicationAbility()),
    });

    await waitFor(() => expect(result.current.isPending).toBe(true));
    expect(mockApi.get).not.toHaveBeenCalledWith('/api/communication/threads');
  });

  it('useMessageThreads fires for an ability holding the section gate', async () => {
    renderHook(() => useMessageThreads(), { wrapper: wrapper(communicationSectionAbility()) });

    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/communication/threads'));
  });

  it('useEmails stays disabled for a read-only-Communication ability', async () => {
    const { result } = renderHook(() => useEmails(), { wrapper: wrapper(readOnlyCommunicationAbility()) });

    await waitFor(() => expect(result.current.isPending).toBe(true));
    expect(mockApi.get).not.toHaveBeenCalledWith(
      '/api/communication/emails',
      expect.anything(),
    );
  });

  it('useEmails fires for an ability holding the section gate', async () => {
    renderHook(() => useEmails(), { wrapper: wrapper(communicationSectionAbility()) });

    await waitFor(() =>
      expect(mockApi.get).toHaveBeenCalledWith('/api/communication/emails', expect.anything()),
    );
  });

  it('useWhatsAppChats stays disabled for a read-only-Communication ability', async () => {
    const { result } = renderHook(() => useWhatsAppChats(), {
      wrapper: wrapper(readOnlyCommunicationAbility()),
    });

    await waitFor(() => expect(result.current.isPending).toBe(true));
    expect(mockApi.get).not.toHaveBeenCalledWith('/api/communication/whatsapp');
  });

  it('useWhatsAppChats fires for an ability holding the section gate', async () => {
    renderHook(() => useWhatsAppChats(), { wrapper: wrapper(communicationSectionAbility()) });

    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/communication/whatsapp'));
  });
});
