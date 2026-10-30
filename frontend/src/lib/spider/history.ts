/**
 * The contractor's History tab rules (his SpiderWatcherPage.tsx at 3bb6606), with the data coming
 * from our server:
 *   - his "last viewed History" time, under his own browser key (Ran, 15 Oct: keep it), for the
 *     tab's count badge. Every read and write is guarded: a private window or blocked site data
 *     only means the badge counts every alert, never a broken page.
 *   - his filter registry (spiderHistoryRegistry), with the Stage list limited to the three stages
 *     Spider alerts on (his also offered Estimate Sent, Won, Lost and Cancelled, which Spider never
 *     alerts on, so they could only ever match nothing).
 *   - his Date / Time presets as ranges, worked out in the browser's clock as his were, and sent
 *     to the server with the rest of his toolbar, so search and filters reach every page (his
 *     filtered only the page on screen).
 *   - his CSV columns.
 */
import type { FacetConfig, FilterState } from '@/lib/filters/types';
import type { SpiderHistoryItem, SpiderHistoryParams } from '@/lib/api/spider';

export const SPIDER_LAST_VIEWED_HISTORY_KEY = 'servwave_spider_last_viewed_history_at';

/** When this browser last opened History, or null (never, or storage unavailable). */
export function readLastViewedHistoryAt(): number | null {
  try {
    const saved = localStorage.getItem(SPIDER_LAST_VIEWED_HISTORY_KEY);
    if (!saved) return null;
    const ms = Number(saved);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  } catch {
    return null;
  }
}

export function writeLastViewedHistoryAt(ms: number): void {
  try {
    localStorage.setItem(SPIDER_LAST_VIEWED_HISTORY_KEY, String(ms));
  } catch {
    // Storage unavailable: the badge simply keeps counting from the last time it could be saved.
  }
}

export const spiderHistoryRegistry: FacetConfig[] = [
  {
    key: 'stage',
    kind: 'multi',
    param: 'stage',
    label: 'Stage',
    icon: 'M21.801 10A10 10 0 1 1 17 3.335 M9 11 3 3L22 4',
    options: [
      { value: 'NEW', label: 'New' },
      { value: 'CONTACTED', label: 'Contacted' },
      { value: 'WALKTHROUGH', label: 'Walkthrough' },
    ],
  },
  {
    key: 'dateTime',
    kind: 'multi',
    param: 'dateTime',
    label: 'Date / Time',
    icon: 'M8 2v4 M16 2v4 M5 4H19A2 2 0 0 1 21 6V20A2 2 0 0 1 19 22H5A2 2 0 0 1 3 20V6A2 2 0 0 1 5 4Z M3 10h18',
    options: [
      { value: 'today', label: 'Today' },
      { value: 'this_week', label: 'This week' },
      { value: 'this_month', label: 'This month' },
      { value: 'last_7_days', label: 'Last 7 days' },
      { value: 'last_30_days', label: 'Last 30 days' },
      { value: 'last_90_days', label: 'Last 90 days' },
      { value: 'this_year', label: 'This year' },
      { value: 'custom_date', label: 'Custom Date' },
    ],
  },
  {
    key: 'recipients',
    kind: 'multi',
    param: 'recipients',
    label: 'Recipients',
    icon: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2 M16 7A4 4 0 1 1 8 7A4 4 0 1 1 16 7Z',
    optionSource: 'recipients',
  },
  {
    key: 'customers',
    kind: 'multi',
    param: 'customers',
    label: 'Customers',
    icon: 'M3 21h18 M3 7v14 M21 7v14 M4 10h4 M4 14h4 M4 18h4 M9 4h6a2 2 0 0 1 2 2v15H7V6a2 2 0 0 1 2-2z',
    optionSource: 'customers',
  },
  {
    key: 'role',
    kind: 'multi',
    param: 'role',
    label: 'Role',
    icon: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
    options: [
      { value: 'admin', label: 'Administrator (Owner)' },
      { value: 'sales', label: 'Sales' },
      { value: 'dispatcher', label: 'Dispatcher' },
      { value: 'technician', label: 'Technician' },
    ],
  },
];

export const CUSTOM_DATE = 'custom_date';
const DAY_MS = 24 * 60 * 60 * 1000;

export interface DateRange {
  from: Date;
  to: Date;
}

/**
 * His Date / Time presets as instant ranges (any of them matches), in the browser's clock as his
 * were: Today, This week (from Sunday), This month, This year, and Last 7 / 30 / 90 days from now,
 * each up to the end of today. Custom Date is the one day picked. As in his, Custom Date with no
 * day picked filters nothing - so no range at all is sent.
 */
export function historyDateRanges(values: readonly string[], customDate: string, now: Date): DateRange[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfToday = new Date(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - 1);
  const ranges: DateRange[] = [];
  for (const v of values) {
    switch (v) {
      case 'today':
        ranges.push({ from: startOfToday, to: endOfToday });
        break;
      case 'this_week':
        ranges.push({ from: new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay()), to: endOfToday });
        break;
      case 'this_month':
        ranges.push({ from: new Date(now.getFullYear(), now.getMonth(), 1), to: endOfToday });
        break;
      case 'last_7_days':
        ranges.push({ from: new Date(now.getTime() - 7 * DAY_MS), to: endOfToday });
        break;
      case 'last_30_days':
        ranges.push({ from: new Date(now.getTime() - 30 * DAY_MS), to: endOfToday });
        break;
      case 'last_90_days':
        ranges.push({ from: new Date(now.getTime() - 90 * DAY_MS), to: endOfToday });
        break;
      case 'this_year':
        ranges.push({ from: new Date(now.getFullYear(), 0, 1), to: endOfToday });
        break;
      case CUSTOM_DATE: {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(customDate);
        if (!m) return [];
        const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        const next = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1);
        ranges.push({ from: start, to: new Date(next.getTime() - 1) });
        break;
      }
      default:
        break;
    }
  }
  return ranges;
}

const multi = (state: FilterState, key: string): string[] => {
  const v = state[key];
  return v?.kind === 'multi' ? v.values : [];
};

/** How many options a dynamic facet offers: every one ticked is the same as no filter. */
export interface HistoryOptionCounts {
  recipients?: number;
  customers?: number;
}

/**
 * His toolbar as the History request's body: only what is set. Call it when the request is made,
 * so a date preset is worked out from the current time. A Recipients or Customers list with every
 * option ticked (his "Select all") filters nothing, so it is not sent.
 */
export function historyQueryParams(
  search: string,
  state: FilterState,
  customDate: string,
  now: Date,
  optionCounts: HistoryOptionCounts = {},
): SpiderHistoryParams {
  const params: SpiderHistoryParams = {};
  const q = search.trim();
  if (q) params.search = q;
  const stage = multi(state, 'stage');
  if (stage.length) params.stage = stage;
  const ranges = historyDateRanges(multi(state, 'dateTime'), customDate, now);
  if (ranges.length) params.ranges = ranges.map((r) => `${r.from.toISOString()}~${r.to.toISOString()}`);
  const everyOption = (key: 'recipients' | 'customers', values: string[]) => {
    const count = optionCounts[key] ?? 0;
    return count > 0 && new Set(values).size >= count;
  };
  const recipients = multi(state, 'recipients');
  if (recipients.length && !everyOption('recipients', recipients)) params.recipients = recipients;
  const customers = multi(state, 'customers');
  if (customers.length && !everyOption('customers', customers)) params.customers = customers;
  const roles = multi(state, 'role');
  if (roles.length) params.roles = roles.map((r) => r.toUpperCase());
  return params;
}

/** Whether any of his search or filters is set (his `isFiltered`). */
export function isHistoryFiltered(search: string, state: FilterState): boolean {
  return Boolean(
    search.trim() ||
      Object.values(state).some((v) =>
        v ? (v.kind === 'multi' ? v.values.length > 0 : v.kind === 'dateRange' ? Boolean(v.from || v.to) : false) : false,
      ),
  );
}

// ─── His formats ─────────────────────────────────────────────────────────────

/** His table time: "07:55 PM". */
export function historyTimeStr(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(iso));
}

/** His table date: "Oct 15, 2026". */
export function historyDateStr(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso));
}

const DAY_WORDS: [string, string] = ['day', 'days'];
const UNIT_WORD: Record<string, [string, string]> = {
  MINUTE: ['minute', 'minutes'],
  HOUR: ['hour', 'hours'],
  DAY: DAY_WORDS,
};

/**
 * His "inactive for {n} days", in the unit the stage's limit was set in. His always said "days",
 * even for a limit in minutes or hours.
 */
export function elapsedText(elapsed: { value: number; unit: string } | null): string {
  if (!elapsed) return '—';
  const [one, many] = UNIT_WORD[elapsed.unit] ?? DAY_WORDS;
  return `${elapsed.value} ${elapsed.value === 1 ? one : many}`;
}

export const HISTORY_CSV_HEADERS = ['Date', 'Time', 'Lead ID', 'Lead Address', 'Customer', 'Stage', 'Recipients', 'Status'] as const;

/** His export rows (handleExportLogs). An outcome that cannot be known is left empty. */
export function historyCsvRows(items: readonly SpiderHistoryItem[]): string[][] {
  return items.map((l) => {
    const dateObj = new Date(l.alerted_at);
    // Date formatted as MM/DD/YYYY — Excel auto-detects this as a Date type cell
    const excelDate = `${String(dateObj.getMonth() + 1).padStart(2, '0')}/${String(dateObj.getDate()).padStart(2, '0')}/${dateObj.getFullYear()}`;
    // Time formatted in 12-hour format with AM/PM (e.g. 07:55 PM)
    let hours = dateObj.getHours();
    const minutes = String(dateObj.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;
    const excelTime = `${String(hours).padStart(2, '0')}:${minutes} ${ampm}`;
    return [
      excelDate,
      excelTime,
      l.lead_number,
      l.service_location || '',
      l.customer_name || '',
      l.stage_name || '',
      l.recipients.map((r) => r.name).join(', '),
      l.outcome ?? '',
    ];
  });
}
