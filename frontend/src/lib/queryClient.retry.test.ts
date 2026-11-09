import { describe, it, expect, afterEach, vi } from 'vitest';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { supabase, getAccessToken } from '@/lib/supabase';
import { queryClient } from './queryClient';

// Today's defaults, read from the code before this rule: queries `retry: 1` (so a failing
// query runs 2 times), mutations had no `retry` set, so React Query's own default 0 applies
// (a failing mutation runs 1 time).
const QUERY_CALLS_WHEN_RETRIED = 2;
const MUTATION_CALLS_WHEN_RETRIED = 1;

// The real error shape the app throws: an AxiosError from the shared axios instance.
function httpError(status: number): AxiosError {
  const config = { url: '/api/x' } as InternalAxiosRequestConfig;
  const response = { status, statusText: '', data: {}, headers: {}, config } as AxiosResponse;
  return new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, {}, response);
}
function networkError(): AxiosError {
  return new AxiosError('Network Error', 'ERR_NETWORK', { url: '/api/x' } as InternalAxiosRequestConfig, {});
}

const cases: Array<[string, () => AxiosError, boolean]> = [
  ['400', () => httpError(400), false],
  ['401 (session refresh keeps its retry)', () => httpError(401), true],
  ['404', () => httpError(404), false],
  ['429', () => httpError(429), false],
  ['500', () => httpError(500), true],
  ['network error', networkError, true],
];

afterEach(() => {
  vi.useRealTimers();
  queryClient.clear();
});

describe('shared query client retry rule', () => {
  it.each(cases)('query failing with %s', async (_label, make, retried) => {
    let calls = 0;
    await queryClient
      .fetchQuery({
        queryKey: ['retry-rule', _label],
        queryFn: () => { calls += 1; return Promise.reject(make()); },
        retryDelay: 0,
      })
      .catch(() => undefined);
    expect(calls).toBe(retried ? QUERY_CALLS_WHEN_RETRIED : 1);
  });

  it.each(cases)('mutation failing with %s', async (_label, make, retried) => {
    let calls = 0;
    await queryClient
      .getMutationCache()
      .build(queryClient, {
        mutationFn: () => { calls += 1; return Promise.reject(make()); },
        retryDelay: 0,
      })
      .execute(undefined)
      .catch(() => undefined);
    expect(calls).toBe(retried ? MUTATION_CALLS_WHEN_RETRIED : 1);
  });
});

// The journey the 401 row protects, through the REAL axios instance (its 401 interceptor) and the REAL
// shared client: two reads 401 together while the session refreshes. The interceptor resends only the
// first; the other is saved by the one query retry. Both must end with data.
describe('two reads that get a 401 during a session refresh', () => {
  it('both end with data', async () => {
    // A fake clock (real time still flows) steps over the 300 ms session refresh and the 400 ms retry delay.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { default: realApi } = await vi.importActual<typeof import('@/lib/axios')>('@/lib/axios');
    let token = 'old-token';
    vi.mocked(getAccessToken).mockImplementation(() => token);
    vi.mocked(supabase.auth.refreshSession).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => { token = 'new-token'; resolve({ data: {}, error: null } as never); }, 300)),
    );
    realApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const auth = String(config.headers?.Authorization ?? '');
      await new Promise((r) => setTimeout(r, 5));
      if (auth !== 'Bearer new-token') throw httpError(401);
      return { status: 200, statusText: 'OK', data: { ok: config.url }, headers: {}, config } as AxiosResponse;
    };
    const read = (key: string) =>
      queryClient
        .fetchQuery({ queryKey: ['retry-401', key], queryFn: async () => (await realApi.get(`/api/${key}`)).data, retryDelay: 400 })
        .then(() => 'data', (e: AxiosError) => `error ${e.response?.status}`);
    const both = Promise.all([read('a'), read('b')]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await both).toEqual(['data', 'data']);
  }, 15000);
});
