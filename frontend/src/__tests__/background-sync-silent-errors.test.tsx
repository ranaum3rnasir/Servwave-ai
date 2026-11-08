// The background number sync is silent even when the server errors.
//
// Every other test mocks the HTTP client away. This one runs the REAL client,
// interceptors included, because the interceptor is what shows "Something went
// wrong on our end" for a 500 (and a toast for a 429 or a 402) on any request.
// A sync the viewer never asked for must not do that; only the transport
// adapter is replaced, so nothing leaves the test.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';

vi.unmock('@/lib/axios');
vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));

import api from '@/lib/axios';
import { supabase } from '@/lib/supabase';
import { toast } from '@/components/ui/use-toast';
import { __resetHandle500Throttle } from '@/lib/handle500';
import { __resetHandle429Throttle } from '@/lib/handle429';
import { __resetHandle402Throttle } from '@/lib/handle402';
import { useBackgroundNumberSync } from '@/lib/api/backgroundNumberSync';
import { renderWithProviders } from './helpers';

const SYNC_URL = '/api/communication/numbers/sync-if-stale';
const requested: string[] = [];

/** Every request fails with this status, as the server would answer it. */
function serverAnswers(status: number) {
  const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
    requested.push(String(config.url));
    throw new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_RESPONSE', config, null, {
      status,
      statusText: '',
      headers: {},
      config,
      data: { error: 'Internal server error' },
    });
  };
  api.defaults.adapter = adapter;
}

function NumbersScreen() {
  useBackgroundNumberSync();
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  requested.length = 0;
  // The interceptor de-dupes its toasts for a few seconds; start each test
  // clean so a quiet result cannot be a de-dupe.
  __resetHandle500Throttle();
  __resetHandle429Throttle();
  __resetHandle402Throttle();
});

describe('background number sync - errors stay silent', () => {
  it('control: an ordinary request that gets a 500 does show the error toast', async () => {
    serverAnswers(500);

    await api.post('/api/communication/numbers/refresh').catch(() => undefined);

    expect(vi.mocked(toast)).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Something went wrong on our end' }),
    );
  });

  it.each([500, 429, 402])('shows no toast when the sync answers %s', async (status) => {
    serverAnswers(status);

    renderWithProviders(<NumbersScreen />);
    await waitFor(() => expect(requested).toContain(SYNC_URL));
    await new Promise((r) => setTimeout(r, 20));

    expect(vi.mocked(toast)).not.toHaveBeenCalled();
  });
});

describe('background number sync - an expired session still refreshes', () => {
  // Silence covers the toasts, not the session: a background sync that meets an
  // expired session must refresh it and retry like any other request, or the
  // first thing an idle tab does on return is fail its sync for no reason.
  it('refreshes the session and retries the sync after a 401', async () => {
    let calls = 0;
    const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
      requested.push(String(config.url));
      calls += 1;
      if (calls === 1) {
        throw new AxiosError('Request failed with status code 401', 'ERR_BAD_REQUEST', config, null, {
          status: 401,
          statusText: '',
          headers: {},
          config,
          data: { error: 'Unauthorized' },
        });
      }
      return { status: 200, statusText: 'OK', headers: {}, config, data: { changed: false, numbers: [] } };
    };
    api.defaults.adapter = adapter;
    vi.mocked(supabase.auth.refreshSession).mockResolvedValue({ data: {}, error: null } as never);

    renderWithProviders(<NumbersScreen />);

    await waitFor(() => expect(requested).toEqual([SYNC_URL, SYNC_URL]));
    expect(vi.mocked(supabase.auth.refreshSession)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast)).not.toHaveBeenCalled();
  });
});
