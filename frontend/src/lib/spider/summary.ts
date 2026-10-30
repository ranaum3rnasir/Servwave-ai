/**
 * Spider's starting summary (#2794) on screen and in the CSV: the words of the summary page, the
 * Spider page's card and the download, as Ran approved them in the demo (starting-summary-demo-v3,
 * 17 Oct). Durations arrive written by the server, so the page, the email and the CSV agree.
 */
import { exportCsvFile } from '@/lib/csv';
import type { SpiderSummary, SpiderTriggerKind } from '@/lib/api/spider';

/** Where the bell, the email button and the text link lead. */
export const SPIDER_SUMMARY_PATH = '/spider/summary';
/** The company-wide view, opened from the Spider page's card (Admins). */
export const SPIDER_COMPANY_SUMMARY_PATH = `${SPIDER_SUMMARY_PATH}?scope=company`;

/** "Tue 14 Oct, 2:12 PM", in the viewer's own time. */
export function summaryWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(d).replace(',', '');
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${time}`;
}

/** "when Spider was turned on": what made the summary, for the page's subtitle. */
const MADE_WHEN: Record<SpiderTriggerKind, string> = {
  SWITCHED_ON: 'when Spider was turned on',
  STAGE_ADDED: 'when a stage was switched on',
  LIMIT_SHORTENED: 'when a time limit was shortened',
  SCOPE_WIDENED: 'when more leads came under watch',
  SETTINGS_CHANGED: "when Spider's settings changed",
};

export function summaryMadeWhen(kind: SpiderTriggerKind): string {
  return MADE_WHEN[kind];
}

/** The card's sentence: "12 leads were already past their limit when Spider started watching. 9 are still waiting." */
export function summaryCardSentence(s: Pick<SpiderSummary, 'total' | 'still_waiting' | 'trigger_kind'>): string {
  const n = s.total;
  const w = s.still_waiting;
  const when =
    s.trigger_kind === 'LIMIT_SHORTENED' || s.trigger_kind === 'SETTINGS_CHANGED' ? MADE_WHEN[s.trigger_kind] : 'when Spider started watching';
  return `${n} ${n === 1 ? 'lead was' : 'leads were'} already past ${n === 1 ? 'its' : 'their'} limit ${when}. ${w} ${w === 1 ? 'is' : 'are'} still waiting.`;
}

/** "Still waiting", or "Moved on to Contacted". */
export function summaryNow(l: { moved_on: boolean; moved_to: string | null }): string {
  if (!l.moved_on) return 'Still waiting';
  return l.moved_to ? `Moved on to ${l.moved_to}` : 'Moved on';
}

export const SUMMARY_CSV_HEADERS = [
  'Lead',
  'Customer',
  'Address',
  'Status then',
  'Entered that status',
  'Time in status',
  'Limit',
  'Over the limit by',
  'Owner',
  'Now',
  'Link',
] as const;

/** "Oct 9, 2:10 PM", in the viewer's own time. */
function enteredAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

export function summaryCsvRows(s: SpiderSummary, origin: string): string[][] {
  return s.leads.map((l) => [
    l.lead_number,
    l.customer_name,
    l.address,
    l.stage_name,
    enteredAt(l.entered_stage_at),
    l.in_stage,
    l.limit,
    l.over_by,
    l.owner_name ?? '',
    summaryNow(l),
    `${origin}/leads/${l.lead_id}`,
  ]);
}

/** "spider-starting-summary-2026-10-14.csv": the day the summary was made, in the viewer's time. */
export function summaryCsvFileName(s: Pick<SpiderSummary, 'created_at'>): string {
  const d = new Date(s.created_at);
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = Number.isNaN(d.getTime()) ? 'latest' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `spider-starting-summary-${day}.csv`;
}

/** Saves the summary as a spreadsheet file, one row per lead. "Now" is as of this moment. */
export function downloadSummaryCsv(s: SpiderSummary): void {
  exportCsvFile(summaryCsvFileName(s), SUMMARY_CSV_HEADERS, summaryCsvRows(s, window.location.origin));
}
