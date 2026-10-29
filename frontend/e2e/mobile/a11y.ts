/**
 * The gate's accessibility scan (PRD module 12, slice 19; rubric TEST-04): axe-core with the
 * WCAG 2.0, 2.1 and 2.2 level A and AA rules, on the touch projects. The desktop control reports
 * it as not applicable (the PRD asks for the scan on the touch projects).
 *
 * One offender per violated rule: `<rule id> (<impact>): <n> node(s): <first targets>`. The rule
 * id comes first so the allow-list can list known rules per route (allowlist.ts, `rules`): a new
 * rule on a listed route fails like a new route does.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { scheduleCardProbe, type CheckResult } from './checks';
import { A11Y_RULE, SCHEDULE_CARD_SELECTOR, SCHEDULE_COLUMN_SELECTOR, splitA11yNodes } from './schedule-double-booked';

/** WCAG 2.2 AA is the union of these tags (axe tags each rule with the version that added it). */
export const A11Y_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** The same overlay set the other checks scope an overlay state to. */
const OVERLAYS = ['[role=dialog]', '[role=alertdialog]', '[role=menu]', '[role=listbox]', '[data-radix-popper-content-wrapper]', '[cmdk-root]', 'aside[data-drawer="open"]'];

const SCAN_TIMEOUT_MS = 90_000;

export async function a11yCheck(page: Page, o: { touch: boolean; onlyInOverlays: boolean; scheduleDoubleBooked?: boolean }): Promise<CheckResult> {
  if (!o.touch) return { offenders: [], notApplicable: true };
  // Frames are not ours to fix (the phone service's frame, embedded documents); the page is.
  let builder = new AxeBuilder({ page }).withTags(A11Y_TAGS).exclude('iframe');
  if (o.onlyInOverlays) {
    const present: string[] = [];
    for (const sel of OVERLAYS) if (await page.locator(sel).count()) present.push(sel);
    if (!present.length) return { offenders: [], info: { scanned: 'no open overlay' } };
    for (const sel of present) builder = builder.include(sel);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const results = await Promise.race([
    builder.analyze(),
    new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error(`a11y scan did not finish in ${SCAN_TIMEOUT_MS / 1000}s`)), SCAN_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
  // The Schedule's accepted exception (schedule-double-booked.ts): of the `target-size` rule only, the
  // nodes that are double-booked event cards are set aside (counted, printed as EXEMPT); the rule's other
  // nodes, and every other rule, are judged as before. A rule left with no node is no longer an offender.
  const exempt: string[] = [];
  const violations = results.violations.map((v) => ({ v, keep: v.nodes.map((_, i) => i) }));
  if (o.scheduleDoubleBooked && !o.onlyInOverlays) {
    for (const entry of violations) {
      if (entry.v.id !== A11Y_RULE) continue;
      // Only a plain selector names a node on this page; a nested one (a frame, a shadow root) is not ours to excuse.
      const selectors = entry.v.nodes.map((n) => (n.target.length === 1 ? String(n.target[0]) : ''));
      const { cards, ofSelector } = await page.evaluate(scheduleCardProbe, { cardSelector: SCHEDULE_CARD_SELECTOR, columnSelector: SCHEDULE_COLUMN_SELECTOR, selectors });
      const split = splitA11yNodes(entry.v.id, ofSelector.map((card, i) => (selectors[i] ? card : -1)), cards);
      entry.keep = split.keep;
      for (const i of split.exempt) exempt.push(`${entry.v.id}: ${String(entry.v.nodes[i]!.target.join(' ')).slice(0, 80)}`);
    }
  }
  const offenders = violations.filter(({ keep }) => keep.length).map(({ v, keep }) => {
    const nodes = keep.map((i) => v.nodes[i]!);
    // MOBILE_GATE_A11Y_NODES=<n> lists up to n nodes per rule (default 3), with the measured
    // colours of a contrast failure, so a fix can be aimed at every node. The offender text is
    // what the allow-list matches by rule id only, so listing more never changes a verdict.
    const shown = Number(process.env.MOBILE_GATE_A11Y_NODES || 3);
    const targets = nodes.slice(0, shown).map((n) => {
      const d = (n.any[0]?.data ?? {}) as { fgColor?: string; bgColor?: string; contrastRatio?: number };
      const colours = shown > 3 ? (d.fgColor ? ` [${d.fgColor} on ${d.bgColor}, ${d.contrastRatio}]` : n.any[0]?.data ? ` ${JSON.stringify(n.any[0].data).slice(0, 200)} ~ ${(n.any[0].relatedNodes ?? []).slice(0, 2).map((r) => String(r.target.join(' ')).slice(0, 100)).join(' | ')}` : '') : '';
      return String(n.target.join(' ')).slice(0, shown > 3 ? 160 : 80) + colours;
    });
    return `${v.id} (${v.impact ?? 'n/a'}): ${nodes.length} node(s): ${targets.join(' | ')}`;
  });
  return { offenders, ...(exempt.length ? { exempt } : {}), info: { incomplete: results.incomplete.map((v) => `${v.id}: ${v.nodes.length}`) } };
}
