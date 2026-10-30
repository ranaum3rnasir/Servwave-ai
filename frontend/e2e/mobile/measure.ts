import type { Page } from '@playwright/test';
import { CHECKS, collectVisibleCopy, measuredOnly, runCheck, scheduleCardProbe, type CheckName, type CheckResult } from './checks';
import { SCHEDULE_CARD_SELECTOR, SCHEDULE_COLUMN_SELECTOR, splitScrollReachOffenders, splitTargetOffenders } from './schedule-double-booked';
import { findVendorTerms, gateTestInboxIn } from './vendor-terms';
import { a11yCheck } from './a11y';

export interface MeasureOptions {
  touch: boolean;
  onlyInOverlays: boolean;
  consoleLines: string[];
  withMeasuredOnly?: boolean;
  scheduleDoubleBooked?: boolean;
  /** Apply the accepted exception `gateTestInbox` to the copy check (never to the console). */
  gateTestInbox?: boolean;
}

export type Measurement = Record<CheckName, CheckResult> & { measured?: Record<string, unknown> };

/**
 * Run the asserted checks on what the page shows now. The gate spec and the self-test both go
 * through here, so the self-test exercises exactly the code that judges the real routes.
 *
 * `consoleLines` are the browser-console messages seen since the page opened: the copy rule
 * covers the console too.
 *
 * `scheduleDoubleBooked`: apply the Schedule's accepted exception (schedule-double-booked.ts; Ran,
 * 2026-10-08, Option A). Only the gate asks for it, and only on the Schedule page when
 * allowlist.json records it. An offender it excuses moves from `offenders` to `exempt`; nothing else changes.
 *
 * `gateTestInbox`: apply the accepted exception of that name (vendor-terms.ts; Ran, 13 Oct 2026) to the
 * rendered-copy check: the gate's own test-inbox address is ignored, listed in `vendorTerms.gateTestInbox`,
 * and nothing else about the provider is. The console check never gets it.
 */
export async function measure(
  page: Page,
  o: MeasureOptions,
): Promise<Measurement> {
  try {
    return await measureOnce(page, o);
  } catch (err) {
    // A page that navigates under a check (a dev-server reload after it finds a new dependency, a
    // late redirect) destroys the context the check was running in. That says nothing about the
    // page: measure the page that is there now, once. A second failure is real and is thrown.
    if (!isNavigationRace(err)) throw err;
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await settle(page, []);
    return measureOnce(page, o);
  }
}

/** True for the error Playwright throws when a navigation destroys the page context under an evaluate. */
export const isNavigationRace = (err: unknown) =>
  /Execution context was destroyed|Cannot find context with specified id/i.test(String(err instanceof Error ? err.message : err));

async function measureOnce(
  page: Page,
  o: MeasureOptions,
): Promise<Measurement> {
  const out = {} as Measurement;
  for (const check of CHECKS) {
    if (check === 'vendorTerms' || check === 'vendorConsole' || check === 'a11y') continue;
    out[check] = await runCheck(page, check, o);
  }
  if (o.scheduleDoubleBooked && !o.onlyInOverlays) {
    // The cards are read once, after both checks ran: the page has not changed between them.
    const { cards } = await page.evaluate(scheduleCardProbe, { cardSelector: SCHEDULE_CARD_SELECTOR, columnSelector: SCHEDULE_COLUMN_SELECTOR });
    const t = splitTargetOffenders(out.targets.offenders, out.targets.offenderCard, cards);
    out.targets = { ...out.targets, offenders: t.offenders, exempt: t.exempt };
    const r = splitScrollReachOffenders(out.scrollReach.offenders, out.scrollReach.cover, cards);
    out.scrollReach = { ...out.scrollReach, offenders: r.offenders, exempt: r.exempt };
  }
  const copy = await page.evaluate(collectVisibleCopy, { onlyInOverlays: o.onlyInOverlays });
  const fmt = (h: { term: string; source: string; excerpt: string }) => `"${h.term}" in ${h.source}: ...${h.excerpt}...`;
  out.vendorTerms = {
    offenders: findVendorTerms(copy, { gateTestInbox: o.gateTestInbox }).map(fmt),
    ...(o.gateTestInbox ? { gateTestInbox: gateTestInboxIn(copy) } : {}),
  };
  out.a11y = await a11yCheck(page, { touch: o.touch, onlyInOverlays: o.onlyInOverlays, scheduleDoubleBooked: o.scheduleDoubleBooked });
  out.vendorConsole = { offenders: [...new Set(findVendorTerms(o.consoleLines.map((text) => ({ source: 'browser console', text }))).map(fmt))] };
  if (o.withMeasuredOnly) {
    // Context only, never asserted: it must not be able to hang or fail a run (focusing fields
    // can open pickers that keep the page busy).
    out.measured = await Promise.race([
      page.evaluate(measuredOnly).catch((e) => ({ error: String(e).slice(0, 200) })),
      new Promise<Record<string, unknown>>((ok) => setTimeout(() => ok({ error: 'timed out after 15s' }), 15_000)),
    ]);
  }
  return out;
}

/** Wait until the page has rendered real content: no skeletons/spinners, text in main. */
export async function settle(page: Page, notes: string[]) {
  try {
    await page.waitForLoadState('networkidle', { timeout: 5_000 });
  } catch {
    notes.push('network never went idle within 5s (polling page)');
  }
  try {
    await page.waitForFunction(
      () => {
        const vis = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const busy = [...document.querySelectorAll('[data-slot="skeleton"], .animate-pulse, [aria-busy="true"], .animate-spin')].some(vis);
        const txt = ((document.querySelector('main') || document.body) as HTMLElement).innerText.trim().length;
        const bodyTxt = document.body.innerText.trim();
        return !busy && txt > 0 && !/^Loading\b[^\n]*$/.test(bodyTxt) && document.querySelectorAll('*').length > 20;
      },
      null,
      { timeout: 15_000, polling: 250 },
    );
  } catch {
    notes.push('a loading indicator or an empty main was still showing after 15s');
  }
  await page.waitForTimeout(400);
}
