// #2995: the client's SMS send takes an optional per-call timeout and attempt cap. Spider's staff
// alert text passes 10 s / 1 attempt; a caller that passes nothing keeps 30 s / 3 attempts.
// This file tests the REAL client, so it undoes the global mock from setup.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.unmock('../lib/ctm/client');

const mockEnv = vi.hoisted(() => ({
  env: {
    CTM_ACCESS_KEY: 'test-access-key',
    CTM_SECRET_KEY: 'test-secret-key',
    CTM_API_BASE: undefined as string | undefined,
    CTM_RECORDINGS_BUCKET: 'call-recordings',
  },
}));
vi.mock('../config/env', () => mockEnv);
vi.mock('../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { CtmApiError, isOptedOut, sendSms } from '../lib/ctm/client';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const ARGS = { from: 'TPN1', to: '+12015551234', msg: 'hello' };
const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

let timeoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchMock.mockReset();
  vi.useFakeTimers();
  timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
});
afterEach(() => {
  timeoutSpy.mockRestore();
  vi.useRealTimers();
});

describe('sendSms limits (no real 10 s wait: the abort signal is inspected and fetch fails as a timeout would)', () => {
  it('with the staff-alert limits: a 10 s signal and ONE attempt on a timeout', async () => {
    fetchMock.mockRejectedValue(timeoutError());
    const p = sendSms('596375', ARGS, { timeoutMs: 10_000, maxAttempts: 1 });
    const assertion = expect(p).rejects.toMatchObject({ name: 'CtmApiError', httpStatus: 0 });
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(timeoutSpy.mock.calls.map((c: unknown[]) => c[0])).toEqual([10_000]);
  });

  it('with the staff-alert limits: a 503 is not retried', async () => {
    fetchMock.mockResolvedValue(new Response('{"reason":"busy"}', { status: 503 }));
    const p = sendSms('596375', ARGS, { timeoutMs: 10_000, maxAttempts: 1 });
    const assertion = expect(p).rejects.toBeInstanceOf(CtmApiError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('with the staff-alert limits: a 429 is not retried', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 429 }));
    const p = sendSms('596375', ARGS, { timeoutMs: 10_000, maxAttempts: 1 });
    const assertion = expect(p).rejects.toBeInstanceOf(CtmApiError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('with no limits: a 30 s signal and THREE attempts on a timeout (unchanged)', async () => {
    fetchMock.mockRejectedValue(timeoutError());
    const p = sendSms('596375', ARGS);
    const assertion = expect(p).rejects.toMatchObject({ name: 'CtmApiError', httpStatus: 0 });
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(timeoutSpy.mock.calls.map((c: unknown[]) => c[0])).toEqual([30_000, 30_000, 30_000]);
  });

  it('with no limits: a 503 is still retried up to three attempts (unchanged)', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 503 }));
    const p = sendSms('596375', ARGS);
    const assertion = expect(p).rejects.toBeInstanceOf(CtmApiError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('empty limits object behaves as no limits', async () => {
    fetchMock.mockRejectedValue(timeoutError());
    const p = sendSms('596375', ARGS, {});
    const assertion = expect(p).rejects.toBeInstanceOf(CtmApiError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('isOptedOut limits and the shared deadline', () => {
  const ok = () => new Response(JSON.stringify({ opt_out_texts: [] }), { status: 200 });

  it('with limits: a 10 s signal and ONE attempt on a timeout; with none: 30 s x 3', async () => {
    fetchMock.mockRejectedValue(timeoutError());
    let p = isOptedOut('596375', '+12015551234', { timeoutMs: 10_000, maxAttempts: 1 });
    let assertion = expect(p).rejects.toBeInstanceOf(CtmApiError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(timeoutSpy.mock.calls.map((c: unknown[]) => c[0])).toEqual([10_000]);

    fetchMock.mockClear();
    timeoutSpy.mockClear();
    p = isOptedOut('596375', '+12015551234');
    assertion = expect(p).rejects.toBeInstanceOf(CtmApiError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(timeoutSpy.mock.calls.map((c: unknown[]) => c[0])).toEqual([30_000, 30_000, 30_000]);
  });

  it('a call capped by a deadline gets only the time that is left', async () => {
    fetchMock.mockResolvedValue(ok());
    const p = isOptedOut('596375', '+12015551234', { timeoutMs: 10_000, maxAttempts: 1, deadlineAt: Date.now() + 4_000 });
    await vi.runAllTimersAsync();
    await p;
    expect(timeoutSpy.mock.calls[0][0]).toBeLessThanOrEqual(4_000);
    expect(timeoutSpy.mock.calls[0][0]).toBeGreaterThan(0);
  });

  it('a call that starts after the deadline makes no request at all', async () => {
    const p = sendSms('596375', ARGS, { timeoutMs: 10_000, maxAttempts: 1, deadlineAt: Date.now() - 1 });
    const assertion = expect(p).rejects.toMatchObject({ name: 'CtmApiError', httpStatus: 0 });
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
