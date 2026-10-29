// Opening Settings -> Caller ID syncs in the background.
//
// The stored list shows at once; the page asks the server to sync if the org
// has not synced in the last minute. The Caller ID list comes from its own
// admin endpoint (numbers plus who can use them), so when the sync reports a
// change the page refetches that list rather than patching it. When nothing
// changed it does nothing, and a failure is silent: no toast, no error, the
// list stays as it was.
//
// Only the HTTP client is mocked; the hooks are the real ones, and the page is
// rendered under React StrictMode, which runs mount effects twice in
// development - "exactly once" has to hold there too.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { buildAbility } from '@/lib/ability';
import { Toaster as KitToaster, toast } from '@/ui-kit/components/ui/sonner';
import PhoneNumbersSettingsPage from '@/pages/v2/settings/PhoneNumbersSettingsPage';
import { BACKGROUND_SYNC_RETRY_MS } from '@/lib/api/backgroundNumberSync';
import { renderWithProviders } from './helpers';

const mockApi = vi.mocked(api);
const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
const READ_ONLY = buildAbility([{ action: 'read', subject: 'Organization' }]);
const LIST_URL = '/api/communication/number-assignments';
const SYNC_URL = '/api/communication/numbers/sync-if-stale';

const OFFICE = {
  id: 'num-office', e164: '+15552014410', label: 'Office line', is_org_default: true,
  sms_enabled: true, status: 'active', type: 'local', assignments: [],
};
// What the phone system holds and ServWave has not stored yet.
const ADDED = {
  id: 'num-added', e164: '+18555334801', label: 'Paid search', is_org_default: false,
  sms_enabled: true, status: 'active', type: 'tollfree', assignments: [],
};
const USERS = [{ id: 'u-dana', name: 'Dana Okafor' }];

let server: Array<typeof OFFICE> = [];

function mockCommAdmin() {
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: {
        id: 'u-dana', email: 'admin@test.com', first_name: 'Test', last_name: 'Admin',
        role: 'ADMIN', org_is_demo: true, organization_id: 'org-demo', org_features: ['phone'],
      },
      isAuthenticated: true, isLoading: false, error: null,
    })) as never,
  );
}

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

function openPage(ability = ADMIN) {
  // Strict Mode at the ROOT: nested under the providers' wrapper, React does
  // not re-run mount effects, so the "exactly once" check would prove nothing.
  return renderWithProviders(
    <>
      <PhoneNumbersSettingsPage />
      <KitToaster />
    </>,
    { ability, reactStrictMode: true },
  );
}

const syncCalls = () => mockApi.post.mock.calls.filter(([url]) => url === SYNC_URL);
const listFetches = () => mockApi.get.mock.calls.filter(([url]) => url === LIST_URL).length;
const toastCount = () => document.querySelectorAll('[data-sonner-toast]').length;
/** The org-wide numbers list as the sync endpoint returns it. */
const wire = (rows: Array<typeof OFFICE>) =>
  rows.map((r) => ({
    id: r.id, e164: r.e164, formatted: null, label: r.label, source: 'ctm', type: r.type,
    sms_enabled: r.sms_enabled, call_flow_id: null, forward_to: null, status: r.status,
    created_at: '2026-08-06T02:46:37.507Z',
  }));

beforeEach(() => {
  vi.clearAllMocks();
  mockCommAdmin();
  server = [OFFICE];
  mockApi.get.mockImplementation((url: string) =>
    url === LIST_URL
      ? Promise.resolve({ data: { numbers: structuredClone(server), users: USERS } })
      : Promise.resolve({ data: {} }),
  );
});

afterEach(() => {
  toast.dismiss();
});

describe('Caller ID - background sync on open', () => {
  it('asks the server to sync exactly once when the page opens, and shows the stored list meanwhile', async () => {
    holdSync();
    openPage();

    expect(await screen.findByText('(555) 201-4410')).toBeInTheDocument();
    await waitFor(() => expect(syncCalls()).toHaveLength(1));
    // Give a second (StrictMode) mount effect every chance to fire.
    await new Promise((r) => setTimeout(r, 20));
    expect(syncCalls()).toHaveLength(1);
  });

  it('reloads the list when the sync reports a change', async () => {
    const sync = holdSync();
    openPage();
    await screen.findByText('(555) 201-4410');
    await waitFor(() => expect(syncCalls()).toHaveLength(1));

    server = [OFFICE, ADDED];
    sync.answer({ changed: true, numbers: wire(server) });

    expect(await screen.findByText('(855) 533-4801')).toBeInTheDocument();
    expect(screen.getByText('(555) 201-4410')).toBeInTheDocument();
  });

  it('leaves the list alone when the sync reports no change', async () => {
    const sync = holdSync();
    openPage();
    await screen.findByText('(555) 201-4410');
    await waitFor(() => expect(syncCalls()).toHaveLength(1));
    const fetchesBefore = listFetches();

    sync.answer({ changed: false, numbers: wire([OFFICE]) });
    await new Promise((r) => setTimeout(r, 20));

    expect(listFetches()).toBe(fetchesBefore);
    expect(screen.queryByText('(855) 533-4801')).toBeNull();
  });

  it('stays silent and keeps the list when the sync fails', async () => {
    const sync = holdSync();
    openPage();
    await screen.findByText('(555) 201-4410');
    await waitFor(() => expect(syncCalls()).toHaveLength(1));
    const fetchesBefore = listFetches();

    sync.fail(
      Object.assign(new Error('Request failed with status code 500'), {
        response: { status: 500, data: { error: 'Internal server error' } },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(toastCount()).toBe(0);
    expect(screen.queryByText(/internal server error|couldn.t load/i)).toBeNull();
    expect(screen.getByText('(555) 201-4410')).toBeInTheDocument();
    expect(listFetches()).toBe(fetchesBefore);
  });

  it('does not sync for someone the page is not open to', async () => {
    openPage(READ_ONLY);
    await new Promise((r) => setTimeout(r, 20));

    expect(syncCalls()).toHaveLength(0);
  });
});

// The server waits 15 seconds for a sync; a slower one carries on after it
// answers `stillRunning: true` with the stored list. The page asks once more a
// little later, so the open screen still picks up the result.
describe('Caller ID - a sync still running when the page opens', () => {
  /** Each sync request gets the next queued answer (a body or an error). */
  function queueSyncAnswers(...answers: Array<{ body: unknown } | { error: unknown }>) {
    mockApi.post.mockImplementation((url: string) => {
      if (url !== SYNC_URL) return Promise.resolve({ data: {} });
      const next = answers.shift();
      if (!next) return new Promise(() => undefined);
      return 'error' in next ? Promise.reject(next.error) : Promise.resolve({ data: next.body });
    });
  }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks once more after 20 seconds and shows the numbers the late sync stored', async () => {
    queueSyncAnswers(
      { body: { changed: false, stillRunning: true, numbers: wire([OFFICE]) } },
      // The run finished in between, so the window answers with the stored
      // list (no change of its own) - which now holds the new number.
      { body: { changed: false, stillRunning: false, numbers: wire([OFFICE, ADDED]) } },
    );
    openPage();
    await screen.findByText('(555) 201-4410');
    await waitFor(() => expect(syncCalls()).toHaveLength(1));

    server = [OFFICE, ADDED];
    await vi.advanceTimersByTimeAsync(BACKGROUND_SYNC_RETRY_MS - 1_000);
    expect(syncCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);

    await waitFor(() => expect(syncCalls()).toHaveLength(2));
    expect(await screen.findByText('(855) 533-4801')).toBeInTheDocument();
    // The second ask is as silent as the first.
    expect(syncCalls()[1]?.[2]).toEqual({ silentErrors: true });
  });

  it('does not apply the second answer when the sync is still running then', async () => {
    queueSyncAnswers(
      { body: { changed: false, stillRunning: true, numbers: wire([OFFICE]) } },
      // Still running: this list is the stored one mid-run, not the result.
      { body: { changed: false, stillRunning: true, numbers: wire([OFFICE, ADDED]) } },
    );
    openPage();
    await screen.findByText('(555) 201-4410');
    await waitFor(() => expect(syncCalls()).toHaveLength(1));
    const fetchesBefore = listFetches();

    server = [OFFICE, ADDED];
    await vi.advanceTimersByTimeAsync(BACKGROUND_SYNC_RETRY_MS);
    await waitFor(() => expect(syncCalls()).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(50);

    expect(listFetches()).toBe(fetchesBefore);
    expect(screen.queryByText('(855) 533-4801')).toBeNull();
  });

  it('asks only once more, even when the sync is still running then', async () => {
    queueSyncAnswers(
      { body: { changed: false, stillRunning: true, numbers: wire([OFFICE]) } },
      { body: { changed: false, stillRunning: true, numbers: wire([OFFICE]) } },
    );
    openPage();
    await waitFor(() => expect(syncCalls()).toHaveLength(1));

    await vi.advanceTimersByTimeAsync(BACKGROUND_SYNC_RETRY_MS);
    await waitFor(() => expect(syncCalls()).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(BACKGROUND_SYNC_RETRY_MS * 3);

    expect(syncCalls()).toHaveLength(2);
  });

  it('does not ask again when the first answer says the sync is done', async () => {
    queueSyncAnswers({ body: { changed: false, stillRunning: false, numbers: wire([OFFICE]) } });
    openPage();
    await waitFor(() => expect(syncCalls()).toHaveLength(1));

    await vi.advanceTimersByTimeAsync(BACKGROUND_SYNC_RETRY_MS * 2);

    expect(syncCalls()).toHaveLength(1);
  });

  it('does not ask again once the page has closed', async () => {
    queueSyncAnswers({ body: { changed: false, stillRunning: true, numbers: wire([OFFICE]) } });
    const { unmount } = openPage();
    await waitFor(() => expect(syncCalls()).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(10);

    unmount();
    await vi.advanceTimersByTimeAsync(BACKGROUND_SYNC_RETRY_MS * 2);

    expect(syncCalls()).toHaveLength(1);
  });

  it('stays silent and keeps the list when the second ask fails', async () => {
    queueSyncAnswers(
      { body: { changed: false, stillRunning: true, numbers: wire([OFFICE]) } },
      {
        error: Object.assign(new Error('Request failed with status code 500'), {
          response: { status: 500, data: { error: 'Internal server error' } },
        }),
      },
    );
    openPage();
    await screen.findByText('(555) 201-4410');
    await waitFor(() => expect(syncCalls()).toHaveLength(1));
    const fetchesBefore = listFetches();

    await vi.advanceTimersByTimeAsync(BACKGROUND_SYNC_RETRY_MS);
    await waitFor(() => expect(syncCalls()).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(20);

    expect(toastCount()).toBe(0);
    expect(listFetches()).toBe(fetchesBefore);
    expect(screen.getByText('(555) 201-4410')).toBeInTheDocument();
  });
});
