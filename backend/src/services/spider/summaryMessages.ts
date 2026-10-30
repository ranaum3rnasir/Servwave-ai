/**
 * Spider's starting summary (#2794): the words of the bell notification, the email and the two texts,
 * as Ran approved them in the demo (starting-summary-demo-v3, 17 Oct), and the email's table layout
 * rules (Ran, 17 Oct):
 *   - one list, most overdue first, at most 50 leads, then "And N more";
 *   - columns sized by their content: the short cells (lead number, status, "N over", owner) never
 *     wrap (`nowrap` plus white-space:nowrap), and the lead number carries a non-breaking hyphen;
 *     only the customer column wraps;
 *   - the grey line "In status X · limit Y" breaks only at the "·";
 *   - on phones (520px and narrower) each lead becomes a stacked block.
 *
 * One fix to the demo's words: "1 of your lead" reads "1 of your leads" (the count is always "of
 * your leads"; the verb and pronoun follow the count).
 *
 * Pure functions only: nothing here reads the database or sends anything. Every value is escaped.
 */
import { esc } from '../../lib/email';

/** The most leads one summary email lists; the rest are a link away. */
export const SUMMARY_EMAIL_CAP = 50;

const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * A duration as the summary writes it: "40 min", "3 hours 40 min", "8 days 6 hours". Never "0 min".
 * Rounded to the minute below a day and to the hour from a day on.
 */
export function summaryDuration(ms: number): string {
  const totalMin = Math.round(Math.max(0, ms) / MIN);
  if (totalMin < 60) return `${Math.max(1, totalMin)} min`;
  if (totalMin < 24 * 60) {
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${h} ${h === 1 ? 'hour' : 'hours'}${m ? ` ${m} min` : ''}`;
  }
  const totalHours = Math.round(Math.max(0, ms) / HOUR);
  const d = Math.floor(totalHours / 24);
  const r = totalHours % 24;
  return `${d} ${d === 1 ? 'day' : 'days'}${r ? ` ${r} ${r === 1 ? 'hour' : 'hours'}` : ''}`;
}

/** The starting trigger kinds (spider_settings.summary_trigger_kind). */
export const SPIDER_TRIGGER_KINDS = [
  'SWITCHED_ON',
  'STAGE_ADDED',
  'LIMIT_SHORTENED',
  'SCOPE_WIDENED',
  'SETTINGS_CHANGED',
] as const;
export type SpiderTriggerKind = (typeof SPIDER_TRIGGER_KINDS)[number];

export function isTriggerKind(v: unknown): v is SpiderTriggerKind {
  return typeof v === 'string' && (SPIDER_TRIGGER_KINDS as readonly string[]).includes(v);
}

/**
 * The email's opening clause for each trigger, before " today at 2:10 PM". Switching on is the
 * demo's sentence; the others say what actually started the summary.
 */
const EMAIL_TRIGGER_CLAUSE: Record<SpiderTriggerKind, string> = {
  SWITCHED_ON: "Spider started watching your company's leads",
  STAGE_ADDED: 'Spider started watching a new stage',
  LIMIT_SHORTENED: 'A Spider time limit was shortened',
  SCOPE_WIDENED: "Spider started watching more of your company's leads",
  SETTINGS_CHANGED: "Spider's settings changed",
};

/** One lead of a summary, as every channel names it. */
export interface SummaryLead {
  leadId: string;
  leadNumber: string;
  customerName: string;
  address: string;
  /** The stage name, as the alerts name it ("New", "Contacted", "Walkthrough Completed"). */
  stageName: string;
  /** Time in the stage when the summary was made. */
  inStageMs: number;
  limitMs: number;
  ownerName: string | null;
}

export const overByMs = (l: Pick<SummaryLead, 'inStageMs' | 'limitMs'>) => l.inStageMs - l.limitMs;

/** Most overdue first; the lead number breaks a tie, so the order never shuffles. */
export function mostOverdueFirst<T extends Pick<SummaryLead, 'inStageMs' | 'limitMs' | 'leadNumber'>>(leads: readonly T[]): T[] {
  return [...leads].sort((a, b) => overByMs(b) - overByMs(a) || a.leadNumber.localeCompare(b.leadNumber));
}

const wasWere = (n: number) => (n === 1 ? 'was' : 'were');
const itsTheir = (n: number) => (n === 1 ? 'its' : 'their');

/** "12 of your leads were already past their limit" - the bell, the email heading and the texts. */
export function pastLimitPhrase(n: number): string {
  return `${n} of your leads ${wasWere(n)} already past ${itsTheir(n)} limit`;
}

/** The bell notification's title. */
export function summaryBellTitle(n: number): string {
  return `Spider is on. ${pastLimitPhrase(n)}.`;
}

export const SUMMARY_BELL_BODY = 'Your starting summary';

/** The text when this person's summary email went out. */
export function summaryTextEmailed(n: number): string {
  return `Spider sent you an email with your starting summary: ${pastLimitPhrase(n)}.`;
}

/** The text when no email went out to this person: it carries the link to the summary page. */
export function summaryTextWithLink(n: number, summaryUrl: string): string {
  return `Spider found ${n} of your leads already past ${itsTheir(n)} limit. See ${n === 1 ? 'it' : 'them'}: ${summaryUrl}`;
}

/** "today at 2:10 PM", or "on Tue 14 Oct at 2:10 PM" when the trigger was on another day, in the company's zone. */
export function triggerWhen(triggeredAt: Date, now: Date, timeZone: string): string {
  const day = (d: Date) => d.toLocaleDateString('en-US', { timeZone });
  const time = triggeredAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone });
  if (day(triggeredAt) === day(now)) return `today at ${time}`;
  const parts = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone }).format(triggeredAt);
  return `on ${parts.replace(',', '')} at ${time}`;
}

export interface SummaryEmailInput {
  recipientFirstName: string;
  /** This person's leads, in any order: the email sorts them. */
  leads: readonly SummaryLead[];
  showOwner: boolean;
  triggerKind: SpiderTriggerKind;
  /** triggerWhen(...) */
  when: string;
  summaryUrl: string;
  leadUrl: (leadId: string) => string;
}

export function summaryEmailSubject(n: number): string {
  return `Spider's starting summary: ${n} of your leads ${n === 1 ? 'is' : 'are'} past ${itsTheir(n)} limit`;
}

function introSentence(i: SummaryEmailInput): string {
  const n = i.leads.length;
  return `${EMAIL_TRIGGER_CLAUSE[i.triggerKind]} ${i.when}. ${n === 1 ? 'This lead' : 'These leads'} had already been in ${itsTheir(n)} status longer than your company's limit${n > 1 ? ', most overdue first' : ''}:`;
}

const FROM_NOW_ON = 'From now on, Spider alerts you about each lead as soon as it passes its limit.';
const WHY_YOU = "You are receiving this because your company set up Spider, ServWave's lead watcher, to alert you.";

/** A lead number that never breaks: its hyphens are non-breaking hyphens (U+2011). */
const unbreakable = (leadNumber: string) => leadNumber.replace(/-/g, '‑');

/** The plain-text body. */
export function summaryEmailText(i: SummaryEmailInput): string {
  const sorted = mostOverdueFirst(i.leads);
  const shown = sorted.slice(0, SUMMARY_EMAIL_CAP);
  const rest = sorted.length - shown.length;
  const lines = shown.map((l) => {
    const owner = i.showOwner ? ` - ${l.ownerName ?? 'No owner'}` : '';
    return `${l.leadNumber} - ${l.customerName} - ${l.stageName} - ${summaryDuration(overByMs(l))} over (in status ${summaryDuration(l.inStageMs)}, limit ${summaryDuration(l.limitMs)})${owner}\n${i.leadUrl(l.leadId)}`;
  });
  return [
    `${pastLimitPhrase(sorted.length)}`,
    '',
    `Hi ${i.recipientFirstName},`,
    '',
    introSentence(i),
    '',
    lines.join('\n\n'),
    ...(rest > 0 ? ['', `And ${rest} more. See them all in ServWave.`] : []),
    '',
    `See the full summary: ${i.summaryUrl}`,
    '',
    FROM_NOW_ON,
    '',
    WHY_YOU,
  ].join('\n');
}

const INK = '#0F172A';
const MUTED = '#64748B';
const LINE = '#E2E8F0';
const HEAD = '#F8FAFC';
const LINK = '#4652D9';
const BUTTON = '#5B6DFF';

const TH = `text-align:left;background:${HEAD};color:${MUTED};font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;padding:8px;border-bottom:1px solid ${LINE};white-space:nowrap;`;
const TD = `padding:8px;border-bottom:1px solid ${LINE};color:${INK};vertical-align:top;`;
const NW = 'white-space:nowrap;';

/** The HTML document: the demo's layout, with the phone rules in a media query. */
export function summaryEmailHtml(i: SummaryEmailInput): string {
  const sorted = mostOverdueFirst(i.leads);
  const n = sorted.length;
  const shown = sorted.slice(0, SUMMARY_EMAIL_CAP);
  const rest = n - shown.length;
  const rows = shown
    .map(
      (l) => `<tr>
<td class="nw" nowrap style="${TD}${NW}"><a href="${esc(i.leadUrl(l.leadId))}" style="color:${LINK};font-weight:bold;text-decoration:none;">${esc(unbreakable(l.leadNumber))}</a></td>
<td style="${TD}">${esc(l.customerName)}<span class="sub" style="display:block;color:${MUTED};font-size:12px;">${esc(l.address)}</span></td>
<td class="nw" nowrap data-l="Status" style="${TD}${NW}">${esc(l.stageName)}</td>
<td data-l="Over by" style="${TD}"><b class="nw" style="${NW}">${esc(summaryDuration(overByMs(l)))}&nbsp;over</b><span class="sub" style="display:block;color:${MUTED};font-size:12px;"><span class="nw" style="${NW}">In status ${esc(summaryDuration(l.inStageMs))}</span> · <span class="nw" style="${NW}">limit ${esc(summaryDuration(l.limitMs))}</span></span></td>${
        i.showOwner ? `\n<td class="nw" nowrap data-l="Owner" style="${TD}${NW}">${esc(l.ownerName ?? 'No owner')}</td>` : ''
      }
</tr>`,
    )
    .join('\n');
  const heading = pastLimitPhrase(n);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(summaryEmailSubject(n))}</title>
<style>
.mt td .sub{color:${MUTED}}
@media (max-width:520px){
  .mt thead{display:none !important}
  .mt,.mt tbody,.mt tr,.mt td{display:block !important;width:auto !important}
  .mt tr{border-bottom:1px solid ${LINE};padding:8px 0}
  .mt td{border:0 !important;padding:2px 0 !important}
  .mt td[data-l]::before{content:attr(data-l) ': ';color:${MUTED};font-size:11.5px;text-transform:uppercase;letter-spacing:.04em}
}
</style>
</head>
<body style="margin:0;padding:18px 12px;background:${HEAD};">
<div style="max-width:600px;margin:0 auto;background:#FFFFFF;color:${INK};border:1px solid ${LINE};border-radius:10px;padding:24px 22px;font-family:Arial,Helvetica,sans-serif;font-size:14.5px;line-height:1.55;">
<div style="font-weight:bold;font-size:15px;letter-spacing:-.01em;margin-bottom:18px;color:${INK};">ServWave</div>
<h1 style="font-size:20px;margin:0 0 10px;line-height:1.3;color:${INK};">${esc(heading)}</h1>
<p style="margin:0 0 12px;">Hi ${esc(i.recipientFirstName)},</p>
<p style="margin:0 0 12px;">${esc(introSentence(i))}</p>
<table class="mt" role="table" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:13px;margin:6px 0 14px;">
<thead><tr><th style="${TH}">Lead</th><th style="${TH}">Customer</th><th style="${TH}">Status</th><th style="${TH}">Over the limit by</th>${i.showOwner ? `<th style="${TH}">Owner</th>` : ''}</tr></thead>
<tbody>
${rows}
</tbody>
</table>
${rest > 0 ? `<div style="background:${HEAD};border:1px solid ${LINE};border-radius:8px;padding:10px 12px;font-size:13.5px;margin-bottom:14px;"><b>And ${rest} more.</b> See them all in ServWave.</div>` : ''}
<a href="${esc(i.summaryUrl)}" style="display:inline-block;background:${BUTTON};color:#FFFFFF;text-decoration:none;font-weight:bold;padding:11px 18px;border-radius:8px;margin:4px 0 16px;font-size:14.5px;">See the full summary</a>
<p style="margin:0 0 12px;">${esc(FROM_NOW_ON)}</p>
<p style="font-size:12px;color:${MUTED};border-top:1px solid ${LINE};padding-top:12px;margin:6px 0 0;">${esc(WHY_YOU)}</p>
</div>
</body>
</html>`;
}
