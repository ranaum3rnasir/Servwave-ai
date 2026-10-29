import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { CallSession, PhoneAgent, PhoneCustomer } from '@/lib/api/communication';
import { useCallsPipeline, EMPTY_FILTERS, type CallFilters } from './useCallsPipeline';

function makeCall(overrides: Partial<CallSession> = {}): CallSession {
  return {
    id: 'c-default',
    direction: 'inbound',
    fromNumber: '+12125550000',
    toNumber: '+17185550100',
    status: 'completed',
    answeredBy: { kind: 'csr', id: 'agent_1' },
    startedAt: '2026-06-03T12:00:00.000Z',
    ...overrides,
  };
}

const agents: PhoneAgent[] = [];
const customers: PhoneCustomer[] = [];

// In range (2026-06-01..2026-06-07)
const completed = makeCall({ id: 'completed', fromNumber: '+12125551111', startedAt: '2026-06-03T12:00:00.000Z', revenue: 100 });
const missed = makeCall({ id: 'missed', fromNumber: '+12125552222', status: 'missed', answeredBy: { kind: 'none' }, startedAt: '2026-06-04T12:00:00.000Z' });
const voicemail = makeCall({ id: 'voicemail', fromNumber: '+12125553333', status: 'voicemail', answeredBy: { kind: 'voicemail' }, startedAt: '2026-06-05T12:00:00.000Z' });
const attentionCall = makeCall({ id: 'attention', fromNumber: '+12125554444', status: 'completed', sentiment: 'negative', startedAt: '2026-06-06T12:00:00.000Z' });
// Repeat caller — same fromNumber as `completed`, also in range
const repeatA = makeCall({ id: 'repeatA', fromNumber: '+12125551111', startedAt: '2026-06-02T12:00:00.000Z' });
// Out of range (before window)
const outOfRange = makeCall({ id: 'outOfRange', fromNumber: '+12125559999', startedAt: '2026-05-01T12:00:00.000Z' });

const allCalls = [completed, missed, voicemail, attentionCall, repeatA, outOfRange];

const range = {
  start: new Date('2026-06-01T00:00:00.000Z'),
  end: new Date('2026-06-07T23:59:59.999Z'),
};

const noFilters: CallFilters = EMPTY_FILTERS;

describe('useCallsPipeline', () => {
  it('visible removes dismissed calls', () => {
    const { result } = renderHook(() =>
      useCallsPipeline({
        calls: allCalls,
        agents,
        customers,
        range: { start: null, end: null },
        focus: 'all',
        filters: noFilters,
        statKey: null,
        query: '',
        sort: null,
        dismissed: new Set(['missed']),
      }),
    );
    expect(result.current.visible.map((c) => c.id)).not.toContain('missed');
  });

  it('ranged clips calls outside the date window by startedAt', () => {
    const { result } = renderHook(() =>
      useCallsPipeline({
        calls: allCalls,
        agents,
        customers,
        range,
        focus: 'all',
        filters: noFilters,
        statKey: null,
        query: '',
        sort: null,
        dismissed: new Set(),
      }),
    );
    expect(result.current.ranged.map((c) => c.id)).not.toContain('outOfRange');
    expect(result.current.ranged.map((c) => c.id)).toContain('completed');
  });

  it('focus "callback" keeps only missed + voicemail', () => {
    const { result } = renderHook(() =>
      useCallsPipeline({
        calls: allCalls,
        agents,
        customers,
        range,
        focus: 'callback',
        filters: noFilters,
        statKey: null,
        query: '',
        sort: null,
        dismissed: new Set(),
      }),
    );
    expect(result.current.focused.map((c) => c.id).sort()).toEqual(['missed', 'voicemail']);
  });

  it('focus "attention" uses callNeedsAttention', () => {
    const { result } = renderHook(() =>
      useCallsPipeline({
        calls: allCalls,
        agents,
        customers,
        range,
        focus: 'attention',
        filters: noFilters,
        statKey: null,
        query: '',
        sort: null,
        dismissed: new Set(),
      }),
    );
    expect(result.current.focused.map((c) => c.id)).toEqual(['attention']);
  });

  it('repeatNumbers flags numbers appearing in >= 2 calls of the dated set', () => {
    const { result } = renderHook(() =>
      useCallsPipeline({
        calls: allCalls,
        agents,
        customers,
        range,
        focus: 'all',
        filters: noFilters,
        statKey: null,
        query: '',
        sort: null,
        dismissed: new Set(),
      }),
    );
    // completed + repeatA share +12125551111
    expect(result.current.repeatNumbers.has('+12125551111')).toBe(true);
    expect(result.current.repeatNumbers.has('+12125552222')).toBe(false);
  });

  it('statKey "repeat" scopes statScoped to repeat numbers', () => {
    const { result } = renderHook(() =>
      useCallsPipeline({
        calls: allCalls,
        agents,
        customers,
        range,
        focus: 'all',
        filters: noFilters,
        statKey: 'repeat',
        query: '',
        sort: null,
        dismissed: new Set(),
      }),
    );
    expect(result.current.statScoped.map((c) => c.id).sort()).toEqual(['completed', 'repeatA']);
  });

  it('query searches the haystack (fromNumber)', () => {
    const { result } = renderHook(() =>
      useCallsPipeline({
        calls: allCalls,
        agents,
        customers,
        range,
        focus: 'all',
        filters: noFilters,
        statKey: null,
        query: '2222',
        sort: null,
        dismissed: new Set(),
      }),
    );
    // fmtPhone of +12125552222 contains 2222 -> only `missed`
    expect(result.current.filtered.map((c) => c.id)).toEqual(['missed']);
  });

  it('sort orders by callSortValue (revenue desc)', () => {
    const { result } = renderHook(() =>
      useCallsPipeline({
        calls: [completed, missed],
        agents,
        customers,
        range,
        focus: 'all',
        filters: noFilters,
        statKey: null,
        query: '',
        sort: { key: 'revenue', dir: 'desc' },
        dismissed: new Set(),
      }),
    );
    // completed has revenue 100, missed has none (0) -> completed first
    expect(result.current.sorted.map((c) => c.id)).toEqual(['completed', 'missed']);
  });
});
