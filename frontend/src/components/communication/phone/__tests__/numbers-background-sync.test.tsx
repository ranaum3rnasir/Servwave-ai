// Opening Communication -> Phone -> Phone numbers syncs in the background.
//
// The stored list shows at once; the screen asks the server to sync if the
// org has not synced in the last minute, and replaces the list only when the
// server says something changed. A failure is silent: no toast, no error, the
// list stays as it was.
//
// Only the HTTP client (and the page's other tabs) are mocked. The screen is
// the real Phone page on its Phone numbers tab: the page seeds its list from
// the shared numbers query, which the background sync writes, so these tests
// prove the list on screen is replaced through that path. It is rendered under
// React StrictMode, which runs mount effects twice in development - "exactly
// once" has to hold there too.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { Toaster as KitToaster, toast } from '@/ui-kit/components/ui/sonner';
import type { PhoneNumberRow } from '@/lib/api/communication';
import { BACKGROUND_SYNC_RETRY_MS } from '@/lib/api/backgroundNumberSync';

vi.mock('@/components/communication/phone/CallsView', () => ({ CallsView: () => null }));
vi.mock('@/components/communication/phone/DispatchView', () => ({ DispatchView: () => null }));
vi.mock('@/components/communication/phone/PerformanceView', () => ({ PerformanceView: () => null }));
vi.mock('@/components/communication/phone/TrainingView', () => ({ TrainingView: () => null }));
vi.mock('@/components/communication/phone/BlockedCallersView', () => ({ BlockedCallersView: () => null }));
vi.mock('@/components/communication/phone/CallFlows', () => ({ CallFlowsView: () => null }));
vi.mock('@/components/communication/phone/CallGroups', () => ({ CallGroupsView: () => null }));
vi.mock('@/components/communication/phone/CallMaskingView', () => ({ CallMaskingView: () => null }));
// Header chrome; it cannot render from the blanket GET stub below.
vi.mock('@/pages/v2/communication/components/planUsage', () => ({ PlanUsage: () => null }));

import { useAuthStore } from '@/stores/auth.store';
import PhonePage from '@/pages/v2/communication/PhonePage';

const mockApi = vi.mocked(api);
const SYNC_URL = '/api/communication/numbers/sync-if-stale';
const NUMBERS_URL = '/api/communication/numbers';
// A non-admin who can read the numbers list.
const READER = buildAbility([{ action: 'read', subject: 'Communication' }]);

const wire = (over: Partial<PhoneNumberRow>): PhoneNumberRow => ({
  id: 'num-1',
  e164: '+16097191235',
  formatted: '(609) 719-1235',
  label: null,
  type: 'local',
  sms_enabled: true,
  call_flow_id: null,
  forward_to: null,
  status: 'active',
  created_at: '2026-08-06T02:46:37.507Z',
  ...over,
});

function openScreen() {
  vi.mocked(useAuthStore).mockImplementation((sel: unknown) =>
    (sel as (s: unknown) => unknown)({
      user: {
        id: 'u1',
        email: 'reader@test.com',
        first_name: 'Test',
        last_name: 'Reader',
        role: 'DISPATCHER',
        organization_id: '00000000-0000-0000-0000-0000000000aa',
        org_is_demo: false,
        org_features: ['phone'],
      },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    }),
  );
  // Strict Mode at the ROOT: nested under the providers' wrapper, React does
  // not re-run mount effects, so the "exactly once" check would prove nothing.
  return renderWithProviders(
    <>
      <Routes>
        <Route path="/communication/phone/:tab" element={<PhonePage />} />
      </Routes>
      <KitToaster />
    </>,
    { initialEntries: ['/communication/phone/numbers'], ability: READER, reactStrictMode: true },
  );
}

const toastCount = () => document.querySelectorAll('[data-sonner-toast]').length;
const syncCalls = () => mockApi.post.mock.calls.filter(([url]) => url === SYNC_URL);

/** Answer the background sync when the test says so. */
function holdSync() {
  let answer!: (body: unknown) => void;
  let fail!: (err: unknown) => void;
  mockApi.post.mockImplementation((url: string) =>
    url === SYNC_URL
      ? new Promise((res, rej) => {
          answer = (body) => res({ data: body });
          fail = rej;
        })
      : Promise.resolve({ data: {} }),
  );
  return { answer: (body: unknown) => answer(body), fail: (err: unknown) => fail(err) };
}

beforeEach(() => {
  vi.clearAllMocks();
  // The org's stored list; every other read the page makes answers empty.
  mockApi.get.mockImplementation((url: string) =>
    Promise.resolve({
      data:
        url === NUMBERS_URL
          ? { numbers: [wire({})] }
          : { calls: [], threads: [], callFlows: [], callGroups: [], blocked: [], numbers: [], agents: [] },
    }),
  );
  mockApi.post.mockResolvedValue({ data: {} });
});

afterEach(() => {
  toast.dismiss();
});

describe('Phone numbers - background sync on open', () => {
  it('asks the server to sync exactly once when the screen opens, and shows the stored list meanwhile', async () => {
    holdSync();
    openScreen();

    expect(await screen.findByText('(609) 719-1235')).toBeInTheDocument();
    await waitFor(() => expect(syncCalls()).toHaveLength(1));
    // Give a second (StrictMode) mount effect every chance to fire.
    await new Promise((r) => setTimeout(r, 20));
    expect(syncCalls()).toHaveLength(1);
  });

  it('replaces the list when the sync reports a change', async () => {
    const sync = holdSync();
    openScreen();
    await screen.findByText('(609) 719-1235');
    await waitFor(() => expect(syncCalls()).toHaveLength(1));

    sync.answer({
      changed: true,
      numbers: [
        wire({ label: 'Website' }),
        wire({ id: 'num-2', e164: '+18555334801', formatted: '(855) 533-4801', type: 'tollfree' }),
      ],
    });

    expect(await screen.findByText('(855) 533-4801')).toBeInTheDocument();
    expect(screen.getByText('Website')).toBeInTheDocument();
    expect(screen.getByText('(609) 719-1235')).toBeInTheDocument();
  });

  it('keeps the list as it is when the sync reports no change', async () => {
    const sync = holdSync();
    openScreen();
    await screen.findByText('(609) 719-1235');
    await waitFor(() => expect(syncCalls()).toHaveLength(1));

    // Even a different list is ignored when the server says nothing changed.
    sync.answer({
      changed: false,
      numbers: [wire({ id: 'num-2', e164: '+18555334801', formatted: '(855) 533-4801' })],
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(screen.queryByText('(855) 533-4801')).toBeNull();
    expect(screen.getByText('(609) 719-1235')).toBeInTheDocument();
    expect(toastCount()).toBe(0);
  });

  it('stays silent and keeps the list when the sync fails', async () => {
    const sync = holdSync();
    openScreen();
    await screen.findByText('(609) 719-1235');
    await waitFor(() => expect(syncCalls()).toHaveLength(1));

    sync.fail(
      Object.assign(new Error('Request failed with status code 500'), {
        response: { status: 500, data: { error: 'Internal server error' } },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(toastCount()).toBe(0);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/internal server error|couldn.t|failed/i)).toBeNull();
    expect(screen.getByText('(609) 719-1235')).toBeInTheDocument();
  });
});

// The server waits 15 seconds for a sync; a slower one carries on after it
// answers `stillRunning: true` with the stored list. The screen asks once more
// a little later, so it still picks up the result.
describe('Phone numbers - a sync still running when the screen opens', () => {
  /** Each sync request gets the next queued answer (a body or an error). */
  function queueSyncAnswers(...answers: Array<{ body: unknown } | { error: unknown }>) {
    mockApi.post.mockImplementation((url: string) => {
      if (url !== SYNC_URL) return Promise.resolve({ data: {} });
      const next = answers.shift();
      if (!next) return new Promise(() => undefined);
      return 'error' in next ? Promise.reject(next.error) : Promise.resolve({ data: next.body });
    });
  }
  const ADDED = wire({ id: 'num-2', e164: '+18555334801', formatted: '(855) 533-4801', type: 'tollfree' });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks once more after 20 seconds and shows the numbers the late sync stored', async () => {
    queueSyncAnswers(
      { body: { changed: false, stillRunning: true, numbers: [wire({})] } },
      // The run finished in between, so the window answers with the stored
      // list (no change of its own) - which now holds the new number.
      { body: { changed: false, stillRunning: false, numbers: [wire({}), ADDED] } },
    );
    openScreen();
    await screen.findByText('(609) 719-1235');
    await waitFor(() => expect(syncCalls()).toHaveLength(1));

    await vi.advanceTimersByTimeAsync(BACKGROUND_SYNC_RETRY_MS - 1_000);
    expect(syncCalls()).toHaveLength(1);
    expect(screen.queryByText('(855) 533-4801')).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);

    await waitFor(() => expect(syncCalls()).toHaveLength(2));
    expect(await screen.findByText('(855) 533-4801')).toBeInTheDocument();
    // The second ask is as silent as the first.
    expect(syncCalls()[1]?.[2]).toEqual({ silentErrors: true });
  });

  it('does not apply the second answer when the sync is still running then', async () => {
    queueSyncAnswers(
      { body: { changed: false, stillRunning: true, numbers: [wire({})] } },
      // Still running: this list is the stored one mid-run, not the result.
      { body: { changed: false, stillRunning: true, numbers: [wire({}), ADDED] } },
    );
    openScreen();
    await screen.findByText('(609) 719-1235');
    await waitFor(() => expect(syncCalls()).toHaveLength(1));

    await vi.advanceTimersByTimeAsync(BACKGROUND_SYNC_RETRY_MS);
    await waitFor(() => expect(syncCalls()).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(50);

    expect(screen.queryByText('(855) 533-4801')).toBeNull();
    expect(screen.getByText('(609) 719-1235')).toBeInTheDocument();
  });

  it('asks only once more, even when the sync is still running then', async () => {
    queueSyncAnswers(
      { body: { changed: false, stillRunning: true, numbers: [wire({})] } },
      { body: { changed: false, stillRunning: true, numbers: [wire({})] } },
    );
    openScreen();
    await waitFor(() => expect(syncCalls()).toHaveLength(1));

    await vi.advanceTimersByTimeAsync(BACKGROUND_SYNC_RETRY_MS);
    await waitFor(() => expect(syncCalls()).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(BACKGROUND_SYNC_RETRY_MS * 3);

    expect(syncCalls()).toHaveLength(2);
  });

  it('does not ask again when the first answer says the sync is done', async () => {
    queueSyncAnswers({ body: { changed: false, stillRunning: false, numbers: [wire({})] } });
    openScreen();
    await waitFor(() => expect(syncCalls()).toHaveLength(1));

    await vi.advanceTimersByTimeAsync(BACKGROUND_SYNC_RETRY_MS * 2);

    expect(syncCalls()).toHaveLength(1);
  });

  it('does not ask again once the screen has closed', async () => {
    queueSyncAnswers({ body: { changed: false, stillRunning: true, numbers: [wire({})] } });
    const { unmount } = openScreen();
    await waitFor(() => expect(syncCalls()).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(10);

    unmount();
    await vi.advanceTimersByTimeAsync(BACKGROUND_SYNC_RETRY_MS * 2);

    expect(syncCalls()).toHaveLength(1);
  });

  it('stays silent and keeps the list when the second ask fails', async () => {
    queueSyncAnswers(
      { body: { changed: false, stillRunning: true, numbers: [wire({})] } },
      {
        error: Object.assign(new Error('Request failed with status code 500'), {
          response: { status: 500, data: { error: 'Internal server error' } },
        }),
      },
    );
    openScreen();
    await screen.findByText('(609) 719-1235');
    await waitFor(() => expect(syncCalls()).toHaveLength(1));

    await vi.advanceTimersByTimeAsync(BACKGROUND_SYNC_RETRY_MS);
    await waitFor(() => expect(syncCalls()).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(20);

    expect(toastCount()).toBe(0);
    expect(screen.queryByText(/internal server error|couldn.t|failed/i)).toBeNull();
    expect(screen.getByText('(609) 719-1235')).toBeInTheDocument();
  });
});
