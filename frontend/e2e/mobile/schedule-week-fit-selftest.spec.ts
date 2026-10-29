/**
 * Slice 75 staging fix: the week grid never becomes a sideways scroller, however many cards stack.
 *
 * `.rbc-time-content` scrolls vertically (`overflow-y: auto`), which makes its x overflow `auto`
 * too. A double-booked card is laid out side by side in its day column (`width: calc(N% - 3px)`
 * with a left offset), but its own padding is a floor under that width, so with enough cards at
 * one time the last card in the last column ends a few pixels past the column and past the grid:
 * a 2 px sideways scroller on a tablet, which the gate's `overflow` check names as undocumented.
 * That only happens with many cards at once, which the quiet org of one project never has and the
 * six projects together do.
 *
 * This renders react-big-calendar's own DOM with the repo's REAL stylesheets (the library's CSS and
 * styles/schedule-dark.css), so it needs no servers and cannot drift from the page:
 *
 *   MOBILE_GATE_SERVERS=off npx playwright test -c e2e/playwright.mobile.config.ts --project=selftest-desktop e2e/mobile/schedule-week-fit-selftest.spec.ts
 *
 * Red/green: with the fix's rule stripped from the stylesheet the same markup scrolls sideways.
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT = path.resolve(__dirname, '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.resolve(ROOT, ...p), 'utf8');
const rbcCss = () => {
  for (const base of [path.resolve(ROOT, 'node_modules'), path.resolve(ROOT, '..', 'node_modules')]) {
    const f = path.join(base, 'react-big-calendar', 'lib', 'css', 'react-big-calendar.css');
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  }
  throw new Error('react-big-calendar css not found');
};

/** The markers the fix's rule sits between, so the red case can strip exactly that rule. */
const FIT_RULE = /\/\* week-grid-fit:start \*\/[\s\S]*?\/\* week-grid-fit:end \*\//;

const DAYS = 7;
/** Cards stacked at one time in one column: the last of them is the one that overshoots. */
const STACK = 16;

function weekMarkup(): string {
  const cards = Array.from({ length: STACK }, (_, i) => {
    const left = i === 0 ? '0%' : `calc(${(100 / STACK) * i}% + 3px)`;
    return `<div class="rbc-event" style="padding:4px 8px;top:20%;height:calc(10% - 2px);width:calc(${100 / STACK}% - 3px);left:${left}">Job ${i}</div>`;
  }).join('');
  const hours = Array.from({ length: 12 }, () => `<div class="rbc-timeslot-group"><div class="rbc-time-slot"></div></div>`).join('');
  const slot = (withCards: boolean) =>
    `<div class="rbc-day-slot rbc-time-column">${hours}<div class="rbc-events-container">${withCards ? cards : ''}</div></div>`;
  const days = Array.from({ length: DAYS }, (_, i) => slot(i === DAYS - 1)).join('');
  return `<div class="schedule-cal" style="width:700px;height:360px"><div class="rbc-calendar"><div class="rbc-time-view">
    <div class="rbc-time-content"><div class="rbc-time-gutter rbc-time-column">${hours}</div>${days}</div></div></div></div>`;
}

async function show(page: Page, css: string) {
  await page.setContent(
    `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fixture</title>
     <style>*,*::before,*::after{box-sizing:border-box} html,body{margin:0;font:16px sans-serif}</style>
     <style>${rbcCss()}</style><style>${css}</style></head><body>${weekMarkup()}</body></html>`,
  );
}

/** What the gate's overflow check calls an undocumented sideways scroller. */
const sidewaysScroller = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('.rbc-time-content')!;
    const box = el.getBoundingClientRect();
    const scrollbar = box.width - el.clientWidth - 0; // classic scrollbar, if any
    return {
      userScrollable: /(auto|scroll)/.test(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      cardsOvershoot: Math.max(...[...el.querySelectorAll('.rbc-event')].map((e) => e.getBoundingClientRect().right)) - (box.right - scrollbar),
    };
  });

test.describe('week grid fit (slice 75 staging fix)', () => {
  const css = read('src', 'styles', 'schedule-dark.css');

  test('the fixture is faithful: stacked cards really end past the grid', async ({ page }) => {
    await show(page, css);
    expect((await sidewaysScroller(page)).cardsOvershoot, 'the last card ends past the grid, as on staging').toBeGreaterThan(0);
  });

  test('red: without the rule, the grid scrolls sideways by a few pixels', async ({ page }) => {
    expect(FIT_RULE.test(css), 'schedule-dark.css carries the week-grid-fit rule between its markers').toBe(true);
    await show(page, css.replace(FIT_RULE, ''));
    const r = await sidewaysScroller(page);
    expect(r.userScrollable, `scrollWidth ${r.scrollWidth} in ${r.clientWidth}`).toBe(true);
  });

  test('green: with the rule, the grid is not a sideways scroller', async ({ page }) => {
    await show(page, css);
    const r = await sidewaysScroller(page);
    expect(r.userScrollable, `scrollWidth ${r.scrollWidth} in ${r.clientWidth}`).toBe(false);
  });
});
