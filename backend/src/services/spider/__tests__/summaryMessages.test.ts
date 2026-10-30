/**
 * Spider's starting summary (#2794): the words of every channel, as Ran approved them in the demo
 * (starting-summary-demo-v3, 17 Oct), the email's layout rules, and what counts as a starting trigger.
 */
import { describe, it, expect } from 'vitest';
import {
  SUMMARY_EMAIL_CAP,
  summaryBellTitle,
  summaryDuration,
  summaryEmailHtml,
  summaryEmailSubject,
  summaryEmailText,
  summaryTextEmailed,
  summaryTextWithLink,
  triggerWhen,
  type SummaryEmailInput,
  type SummaryLead,
} from '../summaryMessages';
import { mergeTriggerKind, settingsTriggerKind, type WatchedScope } from '../summary';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('summaryDuration - the demo\'s durations', () => {
  it('writes minutes, hours and minutes, days and hours, never "0 min"', () => {
    expect(summaryDuration(0)).toBe('1 min');
    expect(summaryDuration(40 * MIN)).toBe('40 min');
    expect(summaryDuration(HOUR)).toBe('1 hour');
    expect(summaryDuration(3 * HOUR + 40 * MIN)).toBe('3 hours 40 min');
    expect(summaryDuration(DAY)).toBe('1 day');
    expect(summaryDuration(8 * DAY + 6 * HOUR)).toBe('8 days 6 hours');
    expect(summaryDuration(2 * DAY + HOUR)).toBe('2 days 1 hour');
    // Rounding never reads "60 min" or "24 hours".
    expect(summaryDuration(59 * MIN + 50_000)).toBe('1 hour');
    expect(summaryDuration(3 * DAY + 23 * HOUR + 40 * MIN)).toBe('4 days');
  });
});

describe('the bell and the texts', () => {
  it('say the count in the demo\'s words, singular and plural', () => {
    expect(summaryBellTitle(12)).toBe('Spider is on. 12 of your leads were already past their limit.');
    expect(summaryBellTitle(1)).toBe('Spider is on. 1 of your leads was already past its limit.');
    expect(summaryTextEmailed(12)).toBe('Spider sent you an email with your starting summary: 12 of your leads were already past their limit.');
    expect(summaryTextWithLink(12, 'https://app.test/spider/summary')).toBe(
      'Spider found 12 of your leads already past their limit. See them: https://app.test/spider/summary',
    );
    expect(summaryTextWithLink(1, 'https://app.test/spider/summary')).toBe(
      'Spider found 1 of your leads already past its limit. See it: https://app.test/spider/summary',
    );
  });
});

function leads(n: number, owner: string | null = 'Maya Ortiz'): SummaryLead[] {
  return Array.from({ length: n }, (_, i) => ({
    leadId: `lead-${i}`,
    leadNumber: `L-${1000 + i}`,
    customerName: `Customer ${i}`,
    address: `${i} Main St`,
    stageName: i % 2 ? 'Contacted' : 'New',
    // Lead i is i hours over a 2-day limit, so the last one is the most overdue.
    inStageMs: 2 * DAY + i * HOUR,
    limitMs: 2 * DAY,
    ownerName: owner,
  }));
}

function input(over: Partial<SummaryEmailInput> = {}): SummaryEmailInput {
  return {
    recipientFirstName: 'Dana',
    leads: leads(12),
    showOwner: true,
    triggerKind: 'SWITCHED_ON',
    when: 'today at 2:10 PM',
    summaryUrl: 'https://app.test/spider/summary',
    leadUrl: (id) => `https://app.test/leads/${id}`,
    ...over,
  };
}

const rowsOf = (html: string) => html.split('<tbody>')[1]!.split('</tbody>')[0]!.match(/<tr>/g) ?? [];

describe('the email', () => {
  it('has the demo\'s subject, heading, greeting, intro, button and footer', () => {
    const html = summaryEmailHtml(input());
    expect(summaryEmailSubject(12)).toBe("Spider's starting summary: 12 of your leads are past their limit");
    expect(summaryEmailSubject(1)).toBe("Spider's starting summary: 1 of your leads is past its limit");
    expect(html).toContain('12 of your leads were already past their limit</h1>');
    expect(html).toContain('Hi Dana,');
    expect(html).toContain(
      'Spider started watching your company&#39;s leads today at 2:10 PM. These leads had already been in their status longer than your company&#39;s limit, most overdue first:',
    );
    expect(html).toContain('href="https://app.test/spider/summary"');
    expect(html).toContain('See the full summary</a>');
    expect(html).toContain('From now on, Spider alerts you about each lead as soon as it passes its limit.');
    expect(html).toContain('You are receiving this because your company set up Spider, ServWave&#39;s lead watcher, to alert you.');
  });

  it('is one list, most overdue first, each lead linked', () => {
    const html = summaryEmailHtml(input());
    const order = [...html.matchAll(/leads\/(lead-\d+)/g)].map((m) => m[1]);
    expect(order[0]).toBe('lead-11');
    expect(order[order.length - 1]).toBe('lead-0');
    expect(html).not.toContain('And ');
  });

  it('stops at 50 leads, then "And N more"', () => {
    const html = summaryEmailHtml(input({ leads: leads(63) }));
    expect(SUMMARY_EMAIL_CAP).toBe(50);
    expect(rowsOf(html)).toHaveLength(50);
    expect(html).toContain('<b>And 13 more.</b> See them all in ServWave.');
    expect(summaryEmailText(input({ leads: leads(63) }))).toContain('And 13 more. See them all in ServWave.');
  });

  it('follows the 17 Oct layout rules: nowrap short cells, a non-breaking hyphen, the grey line breaking at "·", stacked on phones', () => {
    const html = summaryEmailHtml(input());
    // The lead number never breaks: its hyphen is U+2011, in a nowrap cell.
    expect(html).toContain('L‑1011</a>');
    expect(html).toMatch(/<td class="nw" nowrap style="[^"]*white-space:nowrap;[^"]*"><a href="https:\/\/app.test\/leads\/lead-11"/);
    expect(html).toMatch(/<td class="nw" nowrap data-l="Status" style="[^"]*white-space:nowrap;/);
    expect(html).toMatch(/<td class="nw" nowrap data-l="Owner" style="[^"]*white-space:nowrap;[^"]*">Maya Ortiz<\/td>/);
    // "N over" is bold and never wraps; the grey line breaks only at the middle dot.
    expect(html).toContain('<b class="nw" style="white-space:nowrap;">11 hours&nbsp;over</b>');
    expect(html).toContain(
      '<span class="nw" style="white-space:nowrap;">In status 2 days 11 hours</span> · <span class="nw" style="white-space:nowrap;">limit 2 days</span>',
    );
    // The grey lines are the demo's 12px.
    expect(html.match(/class="sub" style="display:block;color:#64748B;font-size:12px;"/g)).toHaveLength(24);
    // No fixed column widths anywhere in the table.
    const table = html.slice(html.indexOf('<table'), html.indexOf('</table>'));
    expect(table).not.toMatch(/width:\s*\d+(px|%)(?!;?\s*border-collapse)/);
    expect(table).not.toMatch(/\swidth="/);
    // Phones: each lead becomes a stacked block.
    expect(html).toContain('@media (max-width:520px)');
    expect(html).toContain(".mt td[data-l]::before{content:attr(data-l) ': '");
  });

  it('shows the Owner column only when asked, and "No owner" for an unowned lead', () => {
    expect(summaryEmailHtml(input({ showOwner: false }))).not.toContain('>Owner</th>');
    const unowned = summaryEmailHtml(input({ leads: leads(2, null) }));
    expect(unowned).toContain('>Owner</th>');
    expect(unowned).toContain('>No owner</td>');
  });

  it('names the trigger that started it, and one lead in the singular', () => {
    const one = summaryEmailHtml(input({ leads: leads(1), triggerKind: 'STAGE_ADDED' }));
    expect(one).toContain('Spider started watching a new stage today at 2:10 PM. This lead had already been in its status longer than your company&#39;s limit:');
    expect(summaryEmailHtml(input({ triggerKind: 'LIMIT_SHORTENED' }))).toContain('A Spider time limit was shortened today at 2:10 PM.');
    expect(summaryEmailHtml(input({ triggerKind: 'SCOPE_WIDENED' }))).toContain('Spider started watching more of your company&#39;s leads today at 2:10 PM.');
  });

  it('escapes every value', () => {
    const html = summaryEmailHtml(input({ recipientFirstName: '<b>x</b>', leads: [{ ...leads(1)[0]!, customerName: '<script>' }] }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('names the time of the trigger in the company\'s zone: "today", or the day when it was another one', () => {
    const at = new Date('2026-10-14T18:10:00.000Z');
    expect(triggerWhen(at, new Date('2026-10-14T18:12:00.000Z'), 'America/New_York')).toBe('today at 2:10 PM');
    expect(triggerWhen(at, new Date('2026-10-15T18:12:00.000Z'), 'America/New_York')).toBe('on Wed 14 Oct at 2:10 PM');
  });
});

describe('what starts watching something new', () => {
  const limits = (newLimit: object | null, contacted: object | null = null) => ({
    NEW: newLimit ?? { enabled: false, value: 1, unit: 'MINUTE' },
    CONTACTED: contacted ?? { enabled: false, value: 1, unit: 'MINUTE' },
    WALKTHROUGH_COMPLETED: { enabled: false, value: 1, unit: 'MINUTE' },
  });
  const scope = (over: Partial<WatchedScope> = {}): WatchedScope => ({
    status_limits: limits({ enabled: true, value: 2, unit: 'DAY' }),
    watch_all_leads: true,
    selected_lead_ids: [],
    ...over,
  });

  it('a stage switched on, a limit shortened, or more leads watched', () => {
    expect(settingsTriggerKind(scope(), scope({ status_limits: limits({ enabled: true, value: 2, unit: 'DAY' }, { enabled: true, value: 1, unit: 'DAY' }) }))).toBe('STAGE_ADDED');
    expect(settingsTriggerKind(scope(), scope({ status_limits: limits({ enabled: true, value: 36, unit: 'HOUR' }) }))).toBe('LIMIT_SHORTENED');
    expect(settingsTriggerKind(scope({ watch_all_leads: false, selected_lead_ids: ['a'] }), scope())).toBe('SCOPE_WIDENED');
    expect(settingsTriggerKind(scope({ watch_all_leads: false, selected_lead_ids: ['a'] }), scope({ watch_all_leads: false, selected_lead_ids: ['a', 'b'] }))).toBe('SCOPE_WIDENED');
  });

  it('not a longer limit, a stage switched off, fewer leads, or the same settings', () => {
    expect(settingsTriggerKind(scope(), scope())).toBeNull();
    expect(settingsTriggerKind(scope(), scope({ status_limits: limits({ enabled: true, value: 3, unit: 'DAY' }) }))).toBeNull();
    expect(settingsTriggerKind(scope(), scope({ status_limits: limits(null) }))).toBeNull();
    expect(settingsTriggerKind(scope(), scope({ watch_all_leads: false, selected_lead_ids: ['a'] }))).toBeNull();
    expect(settingsTriggerKind(scope({ watch_all_leads: false, selected_lead_ids: ['a', 'b'] }), scope({ watch_all_leads: false, selected_lead_ids: ['a'] }))).toBeNull();
  });

  it('several kinds at once, or one after another, read as settings changed; switching on wins', () => {
    expect(settingsTriggerKind(scope({ watch_all_leads: false }), scope({ status_limits: limits({ enabled: true, value: 1, unit: 'DAY' }) }))).toBe('SETTINGS_CHANGED');
    expect(mergeTriggerKind(null, 'STAGE_ADDED')).toBe('STAGE_ADDED');
    expect(mergeTriggerKind('STAGE_ADDED', 'STAGE_ADDED')).toBe('STAGE_ADDED');
    expect(mergeTriggerKind('STAGE_ADDED', 'LIMIT_SHORTENED')).toBe('SETTINGS_CHANGED');
    expect(mergeTriggerKind('SWITCHED_ON', 'LIMIT_SHORTENED')).toBe('SWITCHED_ON');
    expect(mergeTriggerKind('STAGE_ADDED', 'SWITCHED_ON')).toBe('SWITCHED_ON');
  });
});
