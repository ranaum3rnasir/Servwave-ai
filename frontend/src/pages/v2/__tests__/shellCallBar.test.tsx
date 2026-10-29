/// <reference types="@testing-library/jest-dom/vitest" />
// Mobile slice 63, in the REAL staff shell: on a phone Call opens the same-tab dialer over whatever
// page the user is on, and a minimised call shows as a call bar under the top bar that stays across
// navigation (the job page, the schedule). Nothing here places a call: the bar is driven by the
// dialer's own store, and the one Call that is pressed goes to a stand-in HTTP client.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';

import { AbilityProvider } from '@/contexts/AbilityContext';
import { buildAbility } from '@/lib/ability';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/axios', () => ({ default: http }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: vi.fn(() => true),
}));
vi.mock('@/lib/api/myOutboundNumber', () => ({
  useMyOutboundNumber: () => ({ data: undefined }),
}));
vi.mock('@/lib/api/communication', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/communication')>()),
  useUnreadCounts: () => ({ sms: 0, email: 0 }),
  usePhoneCustomers: () => ({ data: [] }),
  useCallOutcome: () => ({ data: null }),
  useStashCallAttribution: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue({ queued: true }),
    isPending: false,
  }),
}));
vi.mock('@/components/copilot/CopilotProvider', () => ({ default: () => null }));
vi.mock('@/components/ai-center/AiCenterModal', () => ({ AiCenterModal: () => null }));
vi.mock('@/components/notifications/NotificationBell', () => ({ NotificationBell: () => null }));
vi.mock('@/components/layout/GlobalSearch', () => ({ default: () => null }));
vi.mock('@/components/timeclock/ClockInOutMenu', () => ({ ClockInOutMenu: () => null }));
vi.mock('@/lib/api/organization', () => ({ useOrganization: () => ({ data: undefined }) }));

import { PHONE_PORTRAIT, emulateDevice } from '@/__tests__/support/deviceShape';
import { requestCall } from '@/lib/communication/phoneTabHandoff';
import { usePhoneSheetStore } from '@/stores/phoneSheet.store';
import V2AppLayout from '../V2AppLayout';

const ability = buildAbility([{ action: 'manage', subject: 'all' }]);

function renderShell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}>
        <AbilityProvider ability={ability}>
          <Routes>
            <Route element={<V2AppLayout />}>
              <Route
                path="/"
                element={
                  <>
                    <h1>Dashboard</h1>
                    <Link to="/jobs/1">Go to the job</Link>
                  </>
                }
              />
              <Route
                path="/jobs/1"
                element={
                  <>
                    <h1>The job</h1>
                    <Link to="/schedule">Go to the schedule</Link>
                  </>
                }
              />
              <Route path="/schedule" element={<h1>The schedule</h1>} />
            </Route>
          </Routes>
        </AbilityProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

let restoreDevice: (() => void) | null = null;
beforeEach(() => {
  usePhoneSheetStore.getState().reset();
  restoreDevice = emulateDevice(PHONE_PORTRAIT);
  http.get.mockResolvedValue({ data: { contacts: [] } });
  http.post.mockResolvedValue({ data: { outcome_since: '2026-10-05T10:00:00.000Z' } });
});
afterEach(() => {
  restoreDevice?.();
  restoreDevice = null;
  usePhoneSheetStore.getState().reset();
});

describe('the call bar in the staff shell', () => {
  it('shows nothing until a call is minimised', () => {
    renderShell();
    expect(screen.queryByRole('region', { name: 'Call in progress' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Dialer' })).not.toBeInTheDocument();
  });

  it('a minimised call is a bar under the top bar, in the page flow, and it stays on the job page and the schedule', async () => {
    renderShell();
    act(() => {
      const store = usePhoneSheetStore.getState();
      store.open('5551234567', { jobId: 'job-1', jobLabel: 'J00042' });
      store.reportCall({ phase: 'placed', number: '+15551234567' });
      store.collapse();
    });

    const bar = await screen.findByRole('region', { name: 'Call in progress' });
    // In flow: a sibling of the top bar and the page frame inside the shell, not a floating overlay.
    const shell = document.querySelector('[data-slot="app-shell"]')!;
    expect(bar.parentElement).toBe(shell);
    expect(bar.compareDocumentPosition(shell.querySelector('[data-slot="app-body"]')!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(within(bar).getByText('(555) 123-4567')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('link', { name: 'Go to the job' }));
    expect(await screen.findByRole('heading', { name: 'The job' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Call in progress' })).toBeVisible();

    await userEvent.click(screen.getByRole('link', { name: 'Go to the schedule' }));
    expect(await screen.findByRole('heading', { name: 'The schedule' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Call in progress' })).toBeVisible();
  });
});

describe('Call in the staff shell on a phone', () => {
  it('opens the dialer as a sheet over the page, opens no window, and Call rings the user first', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    renderShell();

    act(() => requestCall('5551234567', { customerId: 'cust-1', customerName: 'Dana Reyes' }));

    const dialog = await screen.findByRole('dialog', { name: 'Dialer' });
    expect(openSpy).not.toHaveBeenCalled();
    // The page underneath is still the page the user was on.
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Call' }));
    expect(http.post.mock.calls.filter(([url]) => url === '/api/communication/calls')).toHaveLength(1);

    await userEvent.click(await within(dialog).findByRole('button', { name: 'Minimise dialer' }));
    expect(await screen.findByRole('region', { name: 'Call in progress' })).toBeVisible();
    openSpy.mockRestore();
  });
});
