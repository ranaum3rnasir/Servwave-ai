/**
 * The contractor's History tab rules (lib/spider/history.ts): his "last viewed" badge key, his
 * Date / Time presets turned into ranges the server applies, his toolbar as query parameters, his
 * CSV rows, and his "inactive for" wording in the limit's own unit.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SPIDER_LAST_VIEWED_HISTORY_KEY,
  elapsedText,
  historyCsvRows,
  historyDateRanges,
  historyQueryParams,
  readLastViewedHistoryAt,
  spiderHistoryRegistry,
  writeLastViewedHistoryAt,
  HISTORY_CSV_HEADERS,
} from '../history';
import type { SpiderHistoryItem } from '@/lib/api/spider';

// A Wednesday, mid-afternoon, local time.
const NOW = new Date(2026, 9, 14, 15, 30, 0);
const day = (y: number, m: number, d: number) => new Date(y, m, d, 0, 0, 0, 0);
const endOfToday = new Date(day(2026, 9, 15).getTime() - 1);

describe("his 'last viewed History' key", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('is his exact key, read back as a number', () => {
    expect(SPIDER_LAST_VIEWED_HISTORY_KEY).toBe('servwave_spider_last_viewed_history_at');
    expect(readLastViewedHistoryAt()).toBeNull();
    writeLastViewedHistoryAt(1_700_000_000_000);
    expect(localStorage.getItem('servwave_spider_last_viewed_history_at')).toBe('1700000000000');
    expect(readLastViewedHistoryAt()).toBe(1_700_000_000_000);
  });

  it('a stored value that is not a time reads as never viewed', () => {
    localStorage.setItem(SPIDER_LAST_VIEWED_HISTORY_KEY, 'soon');
    expect(readLastViewedHistoryAt()).toBeNull();
  });

  it('storage that throws (private window, blocked site data) never breaks the page', () => {
    // A value that would read back, so a null proves the throw was caught.
    localStorage.setItem(SPIDER_LAST_VIEWED_HISTORY_KEY, '1700000000000');
    // The prototype of the storage the helpers really use: jsdom's Storage on Node 22 (CI), Node's own
    // on newer Node, where a spy on jsdom's Storage.prototype sees nothing.
    vi.spyOn(Object.getPrototypeOf(globalThis.localStorage) as Storage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Object.getPrototypeOf(globalThis.localStorage) as Storage, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readLastViewedHistoryAt()).toBeNull();
    expect(() => writeLastViewedHistoryAt(1)).not.toThrow();
  });
});

describe('his filter registry', () => {
  it('has his five facets in his order, all multi-select', () => {
    expect(spiderHistoryRegistry.map((f) => [f.key, f.label, f.kind])).toEqual([
      ['stage', 'Stage', 'multi'],
      ['dateTime', 'Date / Time', 'multi'],
      ['recipients', 'Recipients', 'multi'],
      ['customers', 'Customers', 'multi'],
      ['role', 'Role', 'multi'],
    ]);
  });

  it('offers only the three stages Spider alerts on, with his labels', () => {
    expect(spiderHistoryRegistry[0]?.options).toEqual([
      { value: 'NEW', label: 'New' },
      { value: 'CONTACTED', label: 'Contacted' },
      { value: 'WALKTHROUGH', label: 'Walkthrough' },
    ]);
  });

  it('keeps his Date / Time presets and his Role labels', () => {
    expect(spiderHistoryRegistry[1]?.options?.map((o) => o.label)).toEqual([
      'Today', 'This week', 'This month', 'Last 7 days', 'Last 30 days', 'Last 90 days', 'This year', 'Custom Date',
    ]);
    expect(spiderHistoryRegistry[4]?.options?.map((o) => o.label)).toEqual(['Administrator (Owner)', 'Sales', 'Dispatcher', 'Technician']);
  });
});

describe('historyDateRanges - his presets, in the browser clock', () => {
  it('turns each preset into the range he matched (up to the end of today)', () => {
    expect(historyDateRanges(['today'], '', NOW)).toEqual([{ from: day(2026, 9, 14), to: endOfToday }]);
    // His week starts on Sunday.
    expect(historyDateRanges(['this_week'], '', NOW)).toEqual([{ from: day(2026, 9, 11), to: endOfToday }]);
    expect(historyDateRanges(['this_month'], '', NOW)).toEqual([{ from: day(2026, 9, 1), to: endOfToday }]);
    expect(historyDateRanges(['this_year'], '', NOW)).toEqual([{ from: day(2026, 0, 1), to: endOfToday }]);
    expect(historyDateRanges(['last_7_days'], '', NOW)).toEqual([{ from: new Date(NOW.getTime() - 7 * 86_400_000), to: endOfToday }]);
    expect(historyDateRanges(['last_90_days'], '', NOW)[0]?.from).toEqual(new Date(NOW.getTime() - 90 * 86_400_000));
  });

  it('Custom Date is the one day picked; with no day picked it filters nothing, as his did', () => {
    expect(historyDateRanges(['custom_date'], '2026-10-02', NOW)).toEqual([
      { from: day(2026, 9, 2), to: new Date(day(2026, 9, 3).getTime() - 1) },
    ]);
    expect(historyDateRanges(['custom_date'], '', NOW)).toEqual([]);
    expect(historyDateRanges(['today', 'custom_date'], '', NOW)).toEqual([]);
  });

  it('several presets are any of them', () => {
    expect(historyDateRanges(['today', 'custom_date'], '2026-10-02', NOW)).toHaveLength(2);
  });
});

describe('historyQueryParams - his toolbar, for the server', () => {
  it('sends only what is set, as comma lists, with his role values as our roles', () => {
    expect(historyQueryParams('', {}, '', NOW)).toEqual({});
    expect(
      historyQueryParams(
        '  payer ',
        {
          stage: { kind: 'multi', values: ['NEW', 'WALKTHROUGH'] },
          dateTime: { kind: 'multi', values: ['today'] },
          recipients: { kind: 'multi', values: ['u1', 'u2'] },
          customers: { kind: 'multi', values: ['c1'] },
          role: { kind: 'multi', values: ['admin', 'technician'] },
        },
        '',
        NOW,
      ),
    ).toEqual({
      search: 'payer',
      stage: ['NEW', 'WALKTHROUGH'],
      ranges: [`${day(2026, 9, 14).toISOString()}~${endOfToday.toISOString()}`],
      recipients: ['u1', 'u2'],
      customers: ['c1'],
      roles: ['ADMIN', 'TECHNICIAN'],
    });
  });

  it('every Recipient or Customer ticked (his "Select all") is no filter, so nothing is sent', () => {
    const customers = Array.from({ length: 250 }, (_, i) => `c${i}`);
    const state = { customers: { kind: 'multi' as const, values: customers }, recipients: { kind: 'multi' as const, values: ['u1'] } };
    expect(historyQueryParams('', state, '', NOW, { customers: 250, recipients: 4 })).toEqual({ recipients: ['u1'] });
    expect(historyQueryParams('', state, '', NOW, { customers: 251, recipients: 4 }).customers).toHaveLength(250);
  });

  it('works the date range out from the time it is called, so Today moves on after midnight', () => {
    const state = { dateTime: { kind: 'multi' as const, values: ['today'] } };
    const before = historyQueryParams('', state, '', new Date(2026, 9, 14, 23, 59));
    const after = historyQueryParams('', state, '', new Date(2026, 9, 15, 0, 1));
    expect(before.ranges).not.toEqual(after.ranges);
    expect(after.ranges?.[0]).toContain(day(2026, 9, 15).toISOString());
  });
});

function item(over: Partial<SpiderHistoryItem> = {}): SpiderHistoryItem {
  return {
    id: 'a1',
    lead_id: 'lead-1',
    lead_number: 'L00042',
    customer_id: 'c1',
    customer_name: 'Pat Payer',
    company_name: null,
    service_request: null,
    service_location: '1 Test Way, Testville',
    status: 'NEW',
    stage_name: 'New',
    elapsed: { value: 3, unit: 'HOUR' },
    alerted_at: new Date(2026, 9, 14, 19, 5).toISOString(),
    outcome: 'SENT',
    outcomes: { email: null, sms: null, in_app: null },
    recipients: [
      { id: 'u1', name: 'Ann Admin', email: 'ann@example.test', role: 'ADMIN', type: 'admin' },
      { id: 'u2', name: 'Sam Sales', email: 'sam@example.test', role: 'SALES', type: 'owner' },
    ],
    in_starting_summary: false,
    email_subject: null,
    email_body: null,
    sms_message: null,
    in_app_message: null,
    ...over,
  };
}

describe('historyCsvRows - his export columns', () => {
  it('Date as MM/DD/YYYY, Time as hh:mm AM/PM, then lead, address, customer, stage, recipients, status', () => {
    expect(HISTORY_CSV_HEADERS).toEqual(['Date', 'Time', 'Lead ID', 'Lead Address', 'Customer', 'Stage', 'Recipients', 'Status']);
    expect(historyCsvRows([item()])).toEqual([
      ['10/14/2026', '07:05 PM', 'L00042', '1 Test Way, Testville', 'Pat Payer', 'New', 'Ann Admin, Sam Sales', 'SENT'],
    ]);
  });

  it('an outcome that cannot be known is left empty, never "SENT"', () => {
    expect(historyCsvRows([item({ outcome: null })])[0]?.[7]).toBe('');
  });
});

describe('elapsedText - his "inactive for" in the unit the limit was set in', () => {
  it('reads "—" when the time is not known (an older server)', () => {
    expect(elapsedText(null)).toBe('—');
  });

  it('names the unit, one or many', () => {
    expect(elapsedText({ value: 1, unit: 'DAY' })).toBe('1 day');
    expect(elapsedText({ value: 3, unit: 'HOUR' })).toBe('3 hours');
    expect(elapsedText({ value: 45, unit: 'MINUTE' })).toBe('45 minutes');
  });
});
