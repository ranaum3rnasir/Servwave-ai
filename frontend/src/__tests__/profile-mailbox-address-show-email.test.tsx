/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions security, M7 (ticket 36): a person whose Show Email is off cannot read their own mailbox address (the
// server refuses it), so their profile shows no address and does not ask for it. With the switch on it shows the address.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { MyMailboxAddress } from '@/components/communication/MyMailboxAddress';

vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => true,
  useEntitlementsReady: () => true,
}));

const mockApi = vi.mocked(api);
const ADDRESS = 'jane.smith.acme@mail.example.test';

function serve(showEmail: boolean) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/permission-switches/me') return { data: { admin_box: false, values: { show_email: showEmail, access_communication: true }, rules: [] } };
    if (url === '/api/communication/my-mailbox') return { data: { mailbox: { status: 'active', address: ADDRESS } } };
    return { data: {} };
  });
}
const asked = (url: string) => mockApi.get.mock.calls.some((c) => c[0] === url);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('the profile\'s own mailbox address follows Show Email', () => {
  it('shows the address, and asks for it, with Show Email on', async () => {
    serve(true);
    renderWithProviders(<MyMailboxAddress variant="field" />);
    expect(await screen.findByText(ADDRESS)).toBeInTheDocument();
    expect(asked('/api/communication/my-mailbox')).toBe(true);
  });

  it('shows nothing, and never asks for the address, with Show Email off', async () => {
    serve(false);
    renderWithProviders(<MyMailboxAddress variant="field" />);
    await waitFor(() => expect(asked('/api/permission-switches/me')).toBe(true));
    // Give a mistaken request every chance to be made before saying it was not.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByText(ADDRESS)).not.toBeInTheDocument();
    expect(asked('/api/communication/my-mailbox')).toBe(false);
  });
});
