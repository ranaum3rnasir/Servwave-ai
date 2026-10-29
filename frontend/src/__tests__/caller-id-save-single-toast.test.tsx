// A failed Caller ID save shows exactly ONE toast, whatever the failure.
//
// The app-wide HTTP client toasts plan gates (402), rate limits (429) and
// server errors (500) for every request. The Caller ID save hooks toast their
// own failure too, so a 402 or 429 used to show two toasts for one save (and a
// 500 was only de-duplicated by dropping the save's own, more specific toast).
//
// Every Caller ID save now opts out of the app-wide toasts (`silentErrors`) and
// its own toast is the one that stays: it says WHICH save failed ("Couldn't
// save the default number") plus the reason in words. A 500 or a dropped
// connection gets the neutral "may not have saved" reason, never the server's
// raw text.
//
// The people panel's Save is several calls reported as one outcome, and its
// message says WHICH part failed ("People saved, but the default number was
// not").
//
// The REAL HTTP client runs here, interceptors included; only its transport
// adapter is replaced, so nothing leaves the test.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';

vi.unmock('@/lib/axios');
vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));

import api from '@/lib/axios';
import { toast as appWideToast } from '@/components/ui/use-toast';
import { Toaster as KitToaster, toast } from '@/ui-kit/components/ui/sonner';
import { __resetHandle500Throttle } from '@/lib/handle500';
import { __resetHandle429Throttle } from '@/lib/handle429';
import { __resetHandle402Throttle } from '@/lib/handle402';
import {
  useSaveNumberPeople,
  useSetNumberAssignments,
  useSetOrgDefaultNumber,
  useSetUserDefaultNumber,
} from '@/lib/api/phoneNumbers';

/** Every request fails the way the server (or the network) would fail it. */
function everyRequestFails(
  how: { status: number; error?: string; body?: Record<string, unknown> } | 'network',
) {
  const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
    if (how === 'network') throw new AxiosError('Network Error', 'ERR_NETWORK', config, null, undefined);
    throw new AxiosError(`Request failed with status code ${how.status}`, 'ERR_BAD_RESPONSE', config, null, {
      status: how.status,
      statusText: '',
      headers: {},
      config,
      data: how.body ?? { error: how.error ?? 'Internal server error' },
    });
  };
  api.defaults.adapter = adapter;
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      {children}
      <KitToaster />
    </QueryClientProvider>
  );
}

const kitToasts = () => document.querySelectorAll('[data-sonner-toast]').length;
const appWideToasts = () => vi.mocked(appWideToast).mock.calls.length;
const flush = () => new Promise((r) => setTimeout(r, 30));

/** Each Caller ID save, run once through its hook. */
const SAVES = {
  'the organization default': () => {
    const { result } = renderHook(() => useSetOrgDefaultNumber(), { wrapper });
    return () => result.current.mutateAsync({ id: 'num-1', isOrgDefault: true });
  },
  'who can use a number': () => {
    const { result } = renderHook(() => useSetNumberAssignments(), { wrapper });
    return () => result.current.mutateAsync({ id: 'num-1', userIds: ['u-1'] });
  },
  "a person's default number": () => {
    const { result } = renderHook(() => useSetUserDefaultNumber(), { wrapper });
    return () => result.current.mutateAsync({ userId: 'u-1', phoneNumberId: 'num-1' });
  },
  'the people panel': () => {
    const { result } = renderHook(() => useSaveNumberPeople(), { wrapper });
    return () => result.current.mutateAsync({ id: 'num-1', userIds: ['u-1'], defaultChanges: [] });
  },
} as const;
const cases = Object.keys(SAVES) as Array<keyof typeof SAVES>;

/** The title of each save's own error toast: it names the save that failed. */
const FAILED_TITLE: Record<keyof typeof SAVES, string> = {
  'the organization default': "Couldn't change the organization default",
  'who can use a number': "Couldn't save who can use this number",
  "a person's default number": "Couldn't save the default number",
  'the people panel': "Couldn't save who can use this number",
};

const MAY_NOT_HAVE_SAVED = 'The change may not have saved. Check the list and try again.';

/** Each way a save can fail, the reason its toast gives in words, and the raw
 *  text the server (or the client) produced, which must never be shown. A
 *  refusal's raw text IS its reason - the server words a refusal for people. */
const FAILURES = {
  'a refusal (400)': {
    how: { status: 400, error: 'Only an active number can be the default' },
    reason: 'Only an active number can be the default',
    raw: null,
  },
  'a plan gate (402)': {
    how: { status: 402, body: { error: 'FEATURE_NOT_IN_PLAN', feature: 'phone', required_plan: 'PRO' } },
    reason: 'Phone & Messaging is available on the Pro plan.',
    raw: 'FEATURE_NOT_IN_PLAN',
  },
  'a rate limit (429)': {
    // The body the backend's rate limiter sends.
    how: { status: 429, body: { error: 'Too many requests', retryAfter: 30 } },
    reason: "You're doing that too quickly. Please wait a moment and try again.",
    raw: 'Too many requests',
  },
  'a server error (500)': {
    how: { status: 500, error: 'Internal server error' },
    reason: MAY_NOT_HAVE_SAVED,
    raw: 'Internal server error',
  },
  'a dropped connection': { how: 'network', reason: MAY_NOT_HAVE_SAVED, raw: 'Network Error' },
} as const;
const failures = Object.keys(FAILURES) as Array<keyof typeof FAILURES>;

/** The first `okCalls` requests succeed; every later one fails with `status`. */
function failAfter(okCalls: number, status: number) {
  let call = 0;
  api.defaults.adapter = (async (config: InternalAxiosRequestConfig) => {
    call += 1;
    if (call <= okCalls) return { status: 200, statusText: 'OK', headers: {}, config, data: { ok: true } };
    throw new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_RESPONSE', config, null, {
      status,
      statusText: '',
      headers: {},
      config,
      data: { error: 'Internal server error' },
    });
  }) as AxiosAdapter;
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetHandle500Throttle();
  __resetHandle429Throttle();
  __resetHandle402Throttle();
});
afterEach(() => {
  toast.dismiss();
});

describe('a Caller ID save that fails', () => {
  // Both toasters are counted: the app-wide one (mocked, so each call is one
  // toast) and the save's own (rendered).
  describe.each(cases)('saving %s', (save) => {
    it.each(failures)('shows exactly one toast, naming the save and the reason, on %s', async (failure) => {
      const { how, reason, raw } = FAILURES[failure];
      everyRequestFails(how);
      const run = SAVES[save]();

      await act(() => run().catch(() => undefined));
      const shown = await screen.findByText(FAILED_TITLE[save]);
      await flush();

      expect(appWideToasts() + kitToasts()).toBe(1);
      const toastEl = shown.closest('[data-sonner-toast]') as HTMLElement;
      expect(toastEl).not.toBeNull();
      expect(within(toastEl).getByText(reason)).toBeInTheDocument();
      if (raw) expect(document.body.textContent).not.toContain(raw);
    });
  });

  it('shows only the panel toast, with the partial-save title, when a default gets a server error after the people saved', async () => {
    failAfter(1, 500);
    const { result } = renderHook(() => useSaveNumberPeople(), { wrapper });

    await act(() =>
      result.current
        .mutateAsync({ id: 'num-1', userIds: ['u-1'], defaultChanges: [{ userId: 'u-1', isDefault: true }] })
        .catch(() => undefined),
    );

    expect(await screen.findByText('People saved, but the default number was not')).toBeInTheDocument();
    await flush();
    expect(kitToasts()).toBe(1);
    expect(appWideToasts()).toBe(0);
  });

  it('shows only the panel toast when saving the people gets a server error', async () => {
    failAfter(0, 500);
    const { result } = renderHook(() => useSaveNumberPeople(), { wrapper });

    await act(() =>
      result.current
        .mutateAsync({ id: 'num-1', userIds: ['u-1'], defaultChanges: [{ userId: 'u-1', isDefault: true }] })
        .catch(() => undefined),
    );

    expect(await screen.findByText("Couldn't save who can use this number")).toBeInTheDocument();
    await flush();
    expect(kitToasts()).toBe(1);
    expect(appWideToasts()).toBe(0);
  });

  it('keeps the partial-save message when a default fails with a refusal after the people saved', async () => {
    let call = 0;
    api.defaults.adapter = (async (config: InternalAxiosRequestConfig) => {
      call += 1;
      if (call === 1) return { status: 200, statusText: 'OK', headers: {}, config, data: { ok: true } };
      throw new AxiosError('Request failed with status code 400', 'ERR_BAD_REQUEST', config, null, {
        status: 400,
        statusText: '',
        headers: {},
        config,
        data: { error: 'That person cannot use this number' },
      });
    }) as AxiosAdapter;
    const { result } = renderHook(() => useSaveNumberPeople(), { wrapper });

    await act(() =>
      result.current
        .mutateAsync({ id: 'num-1', userIds: ['u-1'], defaultChanges: [{ userId: 'u-1', isDefault: true }] })
        .catch(() => undefined),
    );

    expect(await screen.findByText('People saved, but the default number was not')).toBeInTheDocument();
    expect(kitToasts()).toBe(1);
  });
});
