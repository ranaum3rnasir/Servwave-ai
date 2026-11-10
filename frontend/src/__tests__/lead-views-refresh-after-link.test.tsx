/**
 * SPEC-4 §6.10 / §7.5: attaching a communication to a lead can now move that lead from New to
 * Contacted on the server, so the lead's own screens must refetch after the attach: the lead page
 * (`['lead', id]`), the leads list (`['leads', ...]`, every page and filter) and the lead's History
 * panel (`['timeline', 'LEAD', id]`). Without it, Contacted shows only after a reload.
 *
 * Observed through the cache itself: each view is seeded as a cached query, and the test reads
 * whether the attach left it marked stale.
 *
 * This file holds the text attach (slice 4.1). The call, email and logged-entry doors add their
 * own describes in the slices that change them.
 *
 * D7 (slice 4.5, SPEC-4 §6.12.6): a detach, a move away, an edit or a delete can also move the lead
 * the entry LEFT back to New, and the hooks do not know which lead that was. So after any of them
 * every lead view refreshes, by prefix (`['lead']`, `['leads']`, `['timeline', 'LEAD']`): only the
 * queries on screen refetch, the rest are marked stale. This replaces slice 4.1's "a detach does
 * not refresh a lead's views" and its "another lead's views are not this attach's business".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import api from '@/lib/axios';
import { useReassignSmsJob, useReassignSmsLead } from '@/lib/api/communication';
import { useReassignEmailLead } from '@/lib/api/communication';
import { useReassignCallJob, useReassignCallLead } from '@/lib/api/callJob';
import { useDeleteCommunicationLog, useUpdateCommunicationLog } from '@/lib/api/jobCommunications';

const patch = vi.mocked(api.patch);
const put = vi.mocked(api.put);
const del = vi.mocked(api.delete);

const LEAD = 'l1';
const OTHER_LEAD = 'l2';

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

/** The lead views, cached and fresh before the attach. */
const LEAD_VIEWS = (id: string) => [
  ['lead', id],
  ['leads', { page: 1, status: 'NEW' }],
  ['timeline', 'LEAD', id],
] as const;

function seed(...keys: readonly (readonly unknown[])[]) {
  for (const key of keys) queryClient.setQueryData(key, { seeded: true });
}

const isStale = (key: readonly unknown[]) => queryClient.getQueryState(key)?.isInvalidated ?? false;

beforeEach(() => {
  vi.clearAllMocks();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  patch.mockResolvedValue({ data: { message: { id: 'm1' } } });
});

describe('the lead views refresh after a text is attached to a lead', () => {
  it('attaching a text to a lead refreshes that lead\'s page, the leads list and its History', async () => {
    seed(...LEAD_VIEWS(LEAD), ['lead', OTHER_LEAD], ['timeline', 'LEAD', OTHER_LEAD]);
    const { result } = renderHook(() => useReassignSmsLead(), { wrapper });

    result.current.mutate({ messageId: 'm1', leadId: LEAD });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(patch).toHaveBeenCalledWith('/api/communication/sms/m1/lead', { lead_id: LEAD });
    for (const key of LEAD_VIEWS(LEAD)) expect(isStale(key)).toBe(true);
    // D7: the lead the text came from may have moved back to New, so its views refresh too.
    expect(isStale(['lead', OTHER_LEAD])).toBe(true);
    expect(isStale(['timeline', 'LEAD', OTHER_LEAD])).toBe(true);
  });

  it('a detach refreshes every lead\'s views: the lead it left may have moved back to New', async () => {
    seed(...LEAD_VIEWS(LEAD), ...LEAD_VIEWS(OTHER_LEAD));
    const { result } = renderHook(() => useReassignSmsLead(), { wrapper });

    result.current.mutate({ messageId: 'm1', leadId: null });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    for (const key of [...LEAD_VIEWS(LEAD), ...LEAD_VIEWS(OTHER_LEAD)]) expect(isStale(key)).toBe(true);
  });

  it('a refused attach does not refresh the lead\'s views', async () => {
    seed(...LEAD_VIEWS(LEAD));
    patch.mockRejectedValue(Object.assign(new Error('Request failed'), { response: { status: 404, data: { error: 'Lead not found' } } }));
    const { result } = renderHook(() => useReassignSmsLead(), { wrapper });

    result.current.mutate({ messageId: 'm1', leadId: LEAD });

    await waitFor(() => expect(result.current.isError).toBe(true));
    for (const key of LEAD_VIEWS(LEAD)) expect(isStale(key)).toBe(false);
  });
});

// Slice 4.2: the call and email attach doors move a New lead to Contacted too (SPEC-4 §6.3, §6.4).
describe.each([
  {
    door: 'an email',
    useHook: () => useReassignEmailLead(),
    run: (m: ReturnType<typeof useReassignEmailLead>, leadId: string | null) => m.mutate({ emailId: 'e1', leadId }),
    url: '/api/communication/emails/e1/lead',
  },
  {
    door: 'a call',
    useHook: () => useReassignCallLead(),
    run: (m: ReturnType<typeof useReassignCallLead>, leadId: string | null) => m.mutate({ callId: 'c1', leadId }),
    url: '/api/communication/calls/c1/lead',
  },
] as const)('the lead views refresh after $door is attached to a lead', ({ useHook, run, url }) => {
  it('attaching it to a lead refreshes that lead\'s page, the leads list and its History', async () => {
    seed(...LEAD_VIEWS(LEAD), ['lead', OTHER_LEAD], ['timeline', 'LEAD', OTHER_LEAD]);
    const { result } = renderHook(useHook, { wrapper });

    run(result.current as never, LEAD);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(patch).toHaveBeenCalledWith(url, { lead_id: LEAD });
    for (const key of LEAD_VIEWS(LEAD)) expect(isStale(key)).toBe(true);
    // D7: the lead it came from may have moved back to New.
    expect(isStale(['lead', OTHER_LEAD])).toBe(true);
    expect(isStale(['timeline', 'LEAD', OTHER_LEAD])).toBe(true);
  });

  it('a detach refreshes every lead\'s views: the lead it left may have moved back to New', async () => {
    seed(...LEAD_VIEWS(LEAD), ...LEAD_VIEWS(OTHER_LEAD));
    const { result } = renderHook(useHook, { wrapper });

    run(result.current as never, null);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    for (const key of [...LEAD_VIEWS(LEAD), ...LEAD_VIEWS(OTHER_LEAD)]) expect(isStale(key)).toBe(true);
  });

  it('a refused attach does not refresh the lead\'s views', async () => {
    seed(...LEAD_VIEWS(LEAD));
    patch.mockRejectedValue(Object.assign(new Error('Request failed'), { response: { status: 404, data: { error: 'Lead not found' } } }));
    const { result } = renderHook(useHook, { wrapper });

    run(result.current as never, LEAD);

    await waitFor(() => expect(result.current.isError).toBe(true));
    for (const key of LEAD_VIEWS(LEAD)) expect(isStale(key)).toBe(false);
  });
});

// Slice 4.3: saving a logged entry onto a lead (from the customer, a job or another lead) can move
// that lead from New to Contacted on the server.
describe('the lead views refresh after a logged entry is saved onto a lead', () => {
  const LOG_EDIT = {
    channel: 'call' as const,
    direction: 'out' as const,
    occurredAt: '2026-10-20T09:30',
    notes: 'Called about the quote.',
    performedBy: 'u1',
  };

  beforeEach(() => {
    put.mockResolvedValue({ data: { entry: { id: 'e1' } } });
  });

  it('saving an entry onto a lead refreshes that lead\'s page, the leads list and its History', async () => {
    seed(...LEAD_VIEWS(LEAD), ['lead', OTHER_LEAD], ['timeline', 'LEAD', OTHER_LEAD]);
    const { result } = renderHook(() => useUpdateCommunicationLog('e1'), { wrapper });

    result.current.mutate({ ...LOG_EDIT, anchor: { kind: 'lead', id: LEAD } });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(put).toHaveBeenCalledWith('/api/communication/manual-log/e1', expect.objectContaining({ lead_id: LEAD }));
    for (const key of LEAD_VIEWS(LEAD)) expect(isStale(key)).toBe(true);
    // D7: the lead it came from may have moved back to New.
    expect(isStale(['lead', OTHER_LEAD])).toBe(true);
    expect(isStale(['timeline', 'LEAD', OTHER_LEAD])).toBe(true);
  });

  it.each([
    ['a job', { kind: 'job', id: 'j1' }],
    ['the customer', { kind: 'customer', id: 'c1' }],
  ] as const)('saving an entry onto %s refreshes every lead\'s views: the lead it left may have moved back to New', async (_label, anchor) => {
    seed(...LEAD_VIEWS(LEAD), ...LEAD_VIEWS(OTHER_LEAD));
    const { result } = renderHook(() => useUpdateCommunicationLog('e1'), { wrapper });

    result.current.mutate({ ...LOG_EDIT, anchor });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    for (const key of [...LEAD_VIEWS(LEAD), ...LEAD_VIEWS(OTHER_LEAD)]) expect(isStale(key)).toBe(true);
  });

  it('a refused save does not refresh the lead\'s views', async () => {
    seed(...LEAD_VIEWS(LEAD));
    put.mockRejectedValue(Object.assign(new Error('Request failed'), { response: { status: 404, data: { error: 'Lead not found' } } }));
    const { result } = renderHook(() => useUpdateCommunicationLog('e1'), { wrapper });

    result.current.mutate({ ...LOG_EDIT, anchor: { kind: 'lead', id: LEAD } });

    await waitFor(() => expect(result.current.isError).toBe(true));
    for (const key of LEAD_VIEWS(LEAD)) expect(isStale(key)).toBe(false);
  });
});

// D7 (slice 4.5): filing a call (and, #3024, a text) on a job re-points (or clears) its lead, and deleting a logged entry
// takes it off its lead. Either can move the lead it left back to New.
describe('the lead views refresh after a call or a text is filed on a job or a logged entry is deleted', () => {
  it.each([
    ['filing a call on a job', 'j1'],
    ['detaching a call from its job', null],
  ] as const)('%s refreshes every lead\'s views', async (_label, jobId) => {
    seed(...LEAD_VIEWS(LEAD), ...LEAD_VIEWS(OTHER_LEAD));
    patch.mockResolvedValue({ data: { call: { id: 'c1' } } });
    const { result } = renderHook(() => useReassignCallJob(), { wrapper });

    result.current.mutate({ callId: 'c1', jobId });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(patch).toHaveBeenCalledWith('/api/communication/calls/c1/job', { job_id: jobId });
    for (const key of [...LEAD_VIEWS(LEAD), ...LEAD_VIEWS(OTHER_LEAD)]) expect(isStale(key)).toBe(true);
  });

  // #3024 (Ran, 2026-11-06): a text filed on a job takes the job's own lead, or none, as a call does.
  it.each([
    ['filing a text on a job', 'j1'],
    ['detaching a text from its job', null],
  ] as const)('%s refreshes every lead\'s views', async (_label, jobId) => {
    seed(...LEAD_VIEWS(LEAD), ...LEAD_VIEWS(OTHER_LEAD));
    const { result } = renderHook(() => useReassignSmsJob(), { wrapper });

    result.current.mutate({ messageId: 'm1', jobId });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(patch).toHaveBeenCalledWith('/api/communication/sms/m1/job', { job_id: jobId });
    for (const key of [...LEAD_VIEWS(LEAD), ...LEAD_VIEWS(OTHER_LEAD)]) expect(isStale(key)).toBe(true);
  });

  it('deleting a logged entry refreshes every lead\'s views', async () => {
    seed(...LEAD_VIEWS(LEAD), ...LEAD_VIEWS(OTHER_LEAD));
    del.mockResolvedValue({ data: undefined });
    const { result } = renderHook(() => useDeleteCommunicationLog('e1'), { wrapper });

    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(del).toHaveBeenCalledWith('/api/communication/manual-log/e1');
    for (const key of [...LEAD_VIEWS(LEAD), ...LEAD_VIEWS(OTHER_LEAD)]) expect(isStale(key)).toBe(true);
  });

  it('a refused delete or job filing refreshes no lead view', async () => {
    seed(...LEAD_VIEWS(LEAD));
    const refused = Object.assign(new Error('Request failed'), { response: { status: 404, data: { error: 'Entry not found' } } });
    del.mockRejectedValue(refused);
    patch.mockRejectedValue(refused);
    const deleted = renderHook(() => useDeleteCommunicationLog('e1'), { wrapper });
    const filed = renderHook(() => useReassignCallJob(), { wrapper });

    deleted.result.current.mutate();
    filed.result.current.mutate({ callId: 'c1', jobId: 'j1' });

    await waitFor(() => expect(deleted.result.current.isError).toBe(true));
    await waitFor(() => expect(filed.result.current.isError).toBe(true));
    for (const key of LEAD_VIEWS(LEAD)) expect(isStale(key)).toBe(false);
  });
});
