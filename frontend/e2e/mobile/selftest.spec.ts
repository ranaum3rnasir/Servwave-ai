/**
 * Gate self-test: every check goes RED on a deliberately broken page and stays green on a clean
 * one, through the same measure() the real routes use. Needs no servers:
 *
 *   MOBILE_GATE_SERVERS=off npx playwright test -c e2e/playwright.mobile.config.ts --project=selftest-touch --project=selftest-desktop
 *
 * If a change to checks.ts makes a check unable to fail, this file fails.
 */
import { test, expect, type Page } from '@playwright/test';
import { isNavigationRace, measure } from './measure';
import { decide, type Allowlist } from './allowlist';
import { findVendorTerms } from './vendor-terms';
import { isFromVendorFrame, originOf, recordConsole } from './console-lines';

const isTouch = (name: string) => name === 'selftest-touch';

async function show(page: Page, body: string, extraHead = '') {
  await page.setContent(
    `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fixture</title>
     <style>html,body{margin:0;font:16px sans-serif} button{font:16px sans-serif;min-width:48px;min-height:48px} input{font-size:16px;height:48px}</style>${extraHead}</head>
     <body>${body}</body></html>`,
  );
}

async function run(page: Page, o: { overlay?: boolean; console?: string[] } = {}) {
  return measure(page, { touch: isTouch(test.info().project.name), onlyInOverlays: !!o.overlay, consoleLines: o.console ?? [] });
}

const CLEAN = `<main><h1>Clean page</h1><p>Short text that fits.</p><button>Save</button></main>`;

test.describe('check 1: overflow', () => {
  test('red: a row wider than the viewport (the top bar at 320 shape)', async ({ page }) => {
    await show(page, `<header style="display:flex;gap:8px;white-space:nowrap"><span style="flex:none;width:calc(100vw + 120px)">Brand and every action</span></header>${CLEAN}`);
    const m = await run(page);
    expect(m.overflow.offenders.length).toBeGreaterThan(0);
    expect(m.overflow.offenders.join('\n')).toMatch(/page scrolls sideways|past the edge/);
  });
  test('red: an undocumented sideways scroller', async ({ page }) => {
    await show(page, `<div style="overflow-x:auto;width:200px"><div style="width:600px;height:50px">wide strip</div></div>${CLEAN}`);
    expect((await run(page)).overflow.offenders.join('\n')).toMatch(/undocumented sideways scroller/);
  });
  // A wide admin table: 600 px of columns in a 200 px box. `sticky` pins the identifying column.
  const adminTable = (marker: string, firstCell = 'position:sticky;left:0;background:#fff') =>
    `<div ${marker} style="overflow-x:auto;width:200px"><table style="width:600px;border-spacing:0"><tr><td style="${firstCell};width:120px">Name</td><td style="width:480px">wide columns</td></tr></table></div>${CLEAN}`;
  test('green: the same scroller documented as a listed admin table, first column pinned', async ({ page }) => {
    await show(page, adminTable('data-mobile-scroll-x="settings-users"'));
    expect((await run(page)).overflow.offenders).toEqual([]);
  });
  test('red: a marker with no name, or a name the exemption list does not hold (slice 17)', async ({ page }) => {
    await show(page, adminTable('data-mobile-scroll-x'));
    expect((await run(page)).overflow.offenders.join('\n')).toMatch(/undocumented sideways scroller/);
    await show(page, adminTable('data-mobile-scroll-x="some-other-table"'));
    expect((await run(page)).overflow.offenders.join('\n')).toMatch(/undocumented sideways scroller/);
  });
  test('red: a listed admin table whose first column scrolls out of its box (slice 17)', async ({ page }) => {
    await show(page, adminTable('data-mobile-scroll-x="settings-users"', 'background:#fff'));
    expect((await run(page)).overflow.offenders.join('\n')).toMatch(/first column scrolls out of its box: settings-users/);
  });
  test('green: the one-row tab strip is a listed non-table scroller', async ({ page }) => {
    await show(page, `<div data-mobile-scroll-x="tab-strip" style="overflow-x:auto;width:200px;display:flex"><button style="flex:none;width:300px">Tab one</button><button style="flex:none;width:300px">Tab two</button></div>${CLEAN}`);
    expect((await run(page)).overflow.offenders).toEqual([]);
  });
  test('green: a closed side sheet parked past the right edge', async ({ page }) => {
    await show(page, `${CLEAN}<div style="position:fixed;top:0;bottom:0;left:100%;width:320px;background:#eee">Activity</div>`);
    expect((await run(page)).overflow.offenders).toEqual([]);
  });
  test('red: a fixed panel cut by the right edge', async ({ page }) => {
    await show(page, `${CLEAN}<div style="position:fixed;top:0;bottom:0;right:-100px;width:200px;background:#eee">Activity</div>`);
    expect((await run(page)).overflow.offenders.join('\n')).toMatch(/past the edge/);
  });
  // Slice 75: two shapes that are clipped by their own box and widen nothing. A progress fill is
  // slid out of its track by a transform (the left part is cut), and a chart's reference line
  // runs past the edge of its svg. Neither is overflow, and the gate no longer reports them.
  test('green: a progress bar fill slid left inside its clipping track (slice 75)', async ({ page }) => {
    await show(page, `<div role="progressbar" aria-label="Progress" style="margin-left:16px;width:262px;height:8px;overflow:hidden;background:#ddd"><div style="width:100%;height:100%;background:#06c;transform:translateX(-80%)"></div></div>${CLEAN}`);
    expect((await run(page)).overflow.offenders).toEqual([]);
  });
  test('green: a chart line that runs past the edge of its own svg (slice 75)', async ({ page }) => {
    await show(page, `<svg width="280" height="40" role="img" aria-label="Chart"><rect x="100" y="10" width="3000" height="4" fill="#06c" /></svg>${CLEAN}`);
    expect((await run(page)).overflow.offenders).toEqual([]);
  });
  test('red: a plain block cut by the left edge inside an overflow:hidden wrapper is still overflow (slice 75)', async ({ page }) => {
    await show(page, `<div style="overflow:hidden;margin-left:0;width:100%"><div style="margin-left:-80px;width:200px;height:40px;background:#eee">Cut off title</div></div>${CLEAN}`);
    expect((await run(page)).overflow.offenders.join('\n')).toMatch(/past the edge/);
  });
  test('green: a clean page', async ({ page }) => {
    await show(page, CLEAN);
    expect((await run(page)).overflow.offenders).toEqual([]);
  });
});

test.describe('check 1b: top bar fits', () => {
  const bar = (inner: string) =>
    `<header data-slot="topbar" style="display:flex;align-items:center;gap:8px;height:50px;padding:0 12px;white-space:nowrap">${inner}</header>`;
  test('red: a top bar whose actions run past the right edge (the 320 px shape)', async ({ page }) => {
    await show(page, `${bar('<span style="flex:none">Brand</span><span style="flex:none;width:calc(100vw - 40px)">Search</span><button aria-label="Inbox">i</button><button aria-label="Notifications">n</button>')}${CLEAN}`);
    const r = (await run(page)).topbarOverflow.offenders.join('\n');
    expect(r).toMatch(/top bar item past the edge: button \[\d+\.\.\d+\] in \d+px "Notifications"/);
  });
  test('red: a top bar wider than its own box, inside a clipping page', async ({ page }) => {
    await show(page, `<div style="overflow:hidden">${bar('<span style="flex:none;width:calc(100vw + 50px)">Every action</span>')}</div>${CLEAN}`);
    expect((await run(page)).topbarOverflow.offenders.join('\n')).toMatch(/top bar content is \d+px wide/);
  });
  test('green: a top bar whose title truncates and whose actions fit', async ({ page }) => {
    await show(page, `${bar('<button aria-label="Open navigation">=</button><span style="flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis">A very long organisation name that has to truncate</span><button aria-label="More">...</button>')}${CLEAN}`);
    expect((await run(page)).topbarOverflow.offenders).toEqual([]);
  });
  test('not applicable on a page with no top bar (public pages, sign-in)', async ({ page }) => {
    await show(page, CLEAN);
    expect((await run(page)).topbarOverflow).toMatchObject({ offenders: [], notApplicable: true });
  });
});

test.describe('check 2: targets', () => {
  const tiny = (label: string) => `<button aria-label="${label}" style="min-width:0;min-height:0;width:16px;height:16px;padding:0;margin:0;display:inline-block;vertical-align:top"></button>`;
  test('red: crowded 16 px icon buttons, on every project', async ({ page }) => {
    await show(page, `${CLEAN}<div>${tiny('Tiny one')}${tiny('Tiny two')}</div>`);
    expect((await run(page)).targets.offenders.join('\n')).toMatch(/under 24px and crowded: button "Tiny one" 16x16/);
  });
  test('green: a lone 16 px button meets the WCAG 2.5.8 spacing exception', async ({ page }) => {
    await show(page, `<main><h1>Clean page</h1><div style="padding:40px">${tiny('Alone')}</div></main>`);
    expect((await run(page)).targets.offenders).toEqual([]);
  });
  test('green on touch: a small checkbox whose label makes a 44 px target', async ({ page }) => {
    await show(page, `<main><h1>Clean page</h1><label style="display:flex;align-items:center;gap:12px;min-height:48px;padding:0 12px">
      <button role="checkbox" aria-checked="false" style="min-width:0;min-height:0;width:24px;height:24px;padding:0"></button>Select this lead</label></main>`);
    expect((await run(page)).targets.offenders).toEqual([]);
  });
  test('red on touch only: a 30 px switch is a primary touch control', async ({ page }) => {
    await show(page, `${CLEAN}<button role="switch" aria-checked="false" aria-label="Notify" style="min-width:0;min-height:0;width:30px;height:30px;padding:0"></button>`);
    const offenders = (await run(page)).targets.offenders.join('\n');
    if (isTouch(test.info().project.name)) expect(offenders).toMatch(/primary touch control under 44px/);
    else expect(offenders).toBe('');
  });
  test('top bar: a 32 px icon is a primary control on touch, the copilot pill is not', async ({ page }) => {
    await show(page, `${CLEAN}<header data-slot="topbar" style="display:flex;gap:40px;padding:20px">
      <button aria-label="Inbox" style="min-width:0;min-height:0;width:32px;height:32px;padding:0"></button>
      <button data-slot="topbar-pill" style="min-width:0;min-height:0;width:80px;height:32px;padding:0">Assistant</button></header>`);
    const offenders = (await run(page)).targets.offenders.join('\n');
    if (isTouch(test.info().project.name)) expect(offenders).toMatch(/primary touch control under 44px: button "Inbox"/);
    expect(offenders).not.toMatch(/Assistant/);
  });
  test('measured on touch (not asserted): two sub-44 px targets closer than 8 px', async ({ page }) => {
    const small = (label: string) => `<button aria-label="${label}" style="min-width:0;min-height:0;width:30px;height:30px;padding:0;margin:0 2px"></button>`;
    await show(page, `${CLEAN}<div style="display:flex">${small('Left')}${small('Right')}</div>`);
    const t = (await run(page)).targets;
    const info = t.info as { tooCloseCount?: number; tooClose?: string[] };
    if (isTouch(test.info().project.name)) {
      expect(info.tooCloseCount).toBeGreaterThanOrEqual(1);
      expect(info.tooClose?.join('\n')).toMatch(/"Left" ~ "Right"/);
    } else {
      expect(info.tooCloseCount).toBeUndefined();
    }
  });
  test('green: a stretched card-open button does not crowd the 20 px link on top of it; unmarked, it does', async ({ page }) => {
    const card = (attr: string) => `<main><h1>Clean page</h1><div style="position:relative;padding:24px;width:280px">
      <button ${attr} aria-label="Open record" style="position:absolute;inset:0;min-width:0;min-height:0;padding:0"></button>
      <a href="#c" style="position:relative;z-index:10;display:block;height:20px;width:180px">Customer</a></div></main>`;
    await show(page, card('data-stretched-link'));
    expect((await run(page)).targets.offenders).toEqual([]);
    await show(page, card(''));
    expect((await run(page)).targets.offenders.join('\n')).toMatch(/under 24px and crowded: a "Customer"/);
  });
  test('green: an inline link inside a sentence is exempt', async ({ page }) => {
    await show(page, `<main><p>Read the <a href="#terms">terms</a> before you sign.</p><button>Sign</button></main>`);
    expect((await run(page)).targets.offenders).toEqual([]);
  });
});

test.describe('check 3: input font size', () => {
  test('red on touch: a 14 px text input (desktop control: not applicable)', async ({ page }) => {
    await show(page, `${CLEAN}<label>Name <input name="name" style="font-size:14px"></label>`);
    const r = (await run(page)).inputFont;
    if (isTouch(test.info().project.name)) expect(r.offenders.join('\n')).toMatch(/input "name" text is 14px/);
    else expect(r).toMatchObject({ offenders: [], notApplicable: true });
  });
  test('green: a 16 px input', async ({ page }) => {
    await show(page, `${CLEAN}<label>Name <input name="name"></label>`);
    expect((await run(page)).inputFont.offenders).toEqual([]);
  });
});

test.describe('check 4: overlays', () => {
  test('red: a popover wider than the viewport (the filter popover at 320x568 shape)', async ({ page }) => {
    await show(page, `${CLEAN}<div role="dialog" aria-label="Filter" style="position:fixed;top:40px;left:8px;width:calc(100vw + 300px);height:200px;background:#fff"><button>Done</button></div>`);
    expect((await run(page, { overlay: true })).overlays.offenders.join('\n')).toMatch(/dialog\[Filter\] outside the viewport/);
  });
  test('red: an overlay whose last item cannot be reached', async ({ page }) => {
    await show(page, `${CLEAN}<div role="menu" aria-label="Create" style="position:fixed;top:0;left:0;width:200px;height:120px;overflow:hidden;background:#fff">
      ${Array.from({ length: 8 }, (_, i) => `<button role="menuitem" style="display:block">Item ${i + 1}</button>`).join('')}</div>`);
    expect((await run(page, { overlay: true })).overlays.offenders.join('\n')).toMatch(/menu\[Create\] last item "Item 8" not reachable/);
  });
  test('green: a fitting overlay that scrolls to its last item', async ({ page }) => {
    await show(page, `${CLEAN}<div role="menu" aria-label="Create" style="position:fixed;top:0;left:0;width:200px;height:120px;overflow-y:auto;background:#fff">
      ${Array.from({ length: 8 }, (_, i) => `<button role="menuitem" style="display:block">Item ${i + 1}</button>`).join('')}</div>`);
    expect((await run(page, { overlay: true })).overlays.offenders).toEqual([]);
  });
});

test.describe('check 5: main scroller reaches its last control', () => {
  test('red: the last control sits under a fixed bottom bar', async ({ page }) => {
    await show(page, `<main><div style="height:1500px">Long page</div><button>Last action</button></main>
      <div style="position:fixed;left:0;right:0;bottom:0;height:120px;background:#333;z-index:5"></div>`);
    expect((await run(page)).scrollReach.offenders.join('\n')).toMatch(/last control "Last action" is covered by/);
  });
  // Slice 75: a user scrolls to the END of the page, so a last control that the minimal scroll
  // leaves under a fixed bar is reachable when the page has room (bottom padding) to scroll it
  // clear. The red case above has no such room.
  test('green: the page keeps bottom padding, so the last control scrolls clear of a fixed bottom bar (slice 75)', async ({ page }) => {
    await show(page, `<main style="height:100vh;overflow-y:auto"><div style="height:1500px">Long page</div><button>Last action</button><div style="height:160px"></div></main>
      <div style="position:fixed;left:0;right:0;bottom:0;height:120px;background:#333;z-index:5"></div>`);
    expect((await run(page)).scrollReach.offenders).toEqual([]);
  });
  test('red: an unbounded page frame that cannot scroll to its last control', async ({ page }) => {
    await show(page, `<div style="height:100vh;overflow:hidden"><main style="height:2000px"><div style="height:1900px">Clipped</div><button>Hidden save</button></main></div>`);
    expect((await run(page)).scrollReach.offenders.join('\n')).toMatch(/"Hidden save" stays off screen/);
  });
  test('green: a disabled pager button at the end is not the last interactive control', async ({ page }) => {
    await show(page, `<main><div style="height:1500px">Long page</div><div><button>Next</button><button disabled style="pointer-events:none">Last page</button></div></main>`);
    expect((await run(page)).scrollReach.offenders).toEqual([]);
  });
  test('green: a bounded app scroller stays judged on its own when the document also overflows', async ({ page }) => {
    await show(page, `<main style="height:100vh;overflow-y:auto"><div style="height:1500px">Long list</div><button>Rows</button></main>
      <div style="position:absolute;top:0;left:0;width:1px;height:3000px"></div>`);
    expect((await run(page)).scrollReach.offenders).toEqual([]);
  });
  test('green: the last control sits above a long run of plain text', async ({ page }) => {
    await show(page, `<main style="height:100vh;overflow-y:auto"><button>Download PDF</button><div style="height:3000px">Terms and conditions</div></main>`);
    expect((await run(page)).scrollReach.offenders).toEqual([]);
  });
  test('red: a bounded scroller whose box runs past the bottom of the screen', async ({ page }) => {
    await show(page, `<main style="height:calc(100vh + 300px);overflow-y:auto"><div style="height:3000px">List</div><button>Send</button></main>`);
    expect((await run(page)).scrollReach.offenders.join('\n')).toMatch(/"Send" stays off screen/);
  });
  // Mobile slice 29: a wide table's far column, clipped by its own sideways box (narrower than
  // the screen), is out of view sideways like one past the screen edge; the overflow check owns it.
  test('green: the last row\'s far-column control is clipped by its own sideways scroller', async ({ page }) => {
    await show(page, `<main><div style="height:1500px">Long page</div><div style="width:60vw;overflow-x:auto"><div style="width:90vw;display:flex;justify-content:space-between"><button>Near</button><button>Far column</button></div></div></main>`);
    expect((await run(page)).scrollReach.offenders).toEqual([]);
  });
  test('red: a covered last control in a sideways scroller is still judged when it is inside the box', async ({ page }) => {
    await show(page, `<main><div style="height:1500px">Long page</div><div style="width:60vw;overflow-x:auto"><div style="width:200vw"><button>Near</button></div></div><div style="position:relative;height:40px;margin-top:-40px;background:#fff"></div></main>`);
    expect((await run(page)).scrollReach.offenders.join('\n')).toMatch(/last control "Near" is covered by/);
  });
  // Slice 75 round 3: a user taps the part of a control they can see. In a sideways scroll box that
  // also scrolls up and down (the users table on a tablet) the box's own scrollbar takes a strip of its
  // right edge; a select whose raw centre sits under that strip hit-tests as the box, though the part
  // of it a finger reaches is plainly the control. The judge uses the centre of the visible part.
  test('green: a control whose centre sits under its scroller\'s own scrollbar is judged on its visible part', async ({ page }) => {
    await show(page, `<style>.sb{width:60vw;height:120px;overflow:auto;border:1px solid #ccc;box-sizing:border-box}.sb::-webkit-scrollbar{width:11px;height:11px}</style>
      <main><div class="sb"><div style="width:90vw;height:240px;position:relative"><button style="position:absolute;top:150px;width:40px;height:30px;left:calc(60vw - 34px)">Cut</button></div></div></main>`);
    expect((await run(page)).scrollReach.offenders).toEqual([]);
  });
  test('green: a long page whose last control scrolls into view', async ({ page }) => {
    await show(page, `<main><div style="height:1500px">Long page</div><button>Last action</button></main>`);
    expect((await run(page)).scrollReach.offenders).toEqual([]);
  });
  // Slice 75: a list that scrolls INSIDE a bounded box on the page (a thread list beside its
  // composer) is reached by scrolling that box, so its far rows are not "off screen". The box
  // itself must be on screen.
  const rows = (n: number) => Array.from({ length: n }, (_, i) => `<button style="display:block">Row ${i + 1}</button>`).join('');
  test('green: the last row of a bounded list is inside a scroller whose box is on screen (slice 75)', async ({ page }) => {
    await show(page, `<main style="height:100vh;overflow-y:auto"><h1>Threads</h1><div style="height:900px">Summary cards</div><div data-testid="list" style="height:240px;overflow-y:auto">${rows(80)}</div><button>New message</button></main>`);
    expect((await run(page)).scrollReach.offenders).toEqual([]);
  });
  test('red: a list scroller whose box runs past the bottom of the screen is still unreachable (slice 75)', async ({ page }) => {
    await show(page, `<div style="height:100vh;overflow:hidden"><main style="height:100%"><div style="height:calc(100vh + 400px);overflow-y:auto">${rows(80)}</div></main></div>`);
    expect((await run(page)).scrollReach.offenders.join('\n')).toMatch(/stays off screen/);
  });
});

test.describe('check 6: vendor terms', () => {
  test('red: a fixture that renders a vendor term, in text, a placeholder, a label and the console', async ({ page }) => {
    await show(page, `<main><p>Phone service by CTM</p><input placeholder="Your Twilio number"><button aria-label="Open Supabase">x</button></main>`);
    const m = await run(page, { console: ['stripe.js loaded'] });
    const r = m.vendorTerms.offenders.join('\n');
    expect(r).toMatch(/"CTM" in text/);
    expect(r).toMatch(/"Twilio" in placeholder/);
    expect(r).toMatch(/"Supabase" in accessible name/);
    expect(m.vendorConsole.offenders.join('\n')).toMatch(/"Stripe" in browser console/);
  });
  test('red: a console line our own page writes that names a vendor fails; a vendor frame\'s own line is the documented exception', async ({ page }) => {
    // Our page at one origin embeds a frame from another. Both log a line naming a vendor.
    await page.route('https://own.example/**', (route) => route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Own</title><iframe src="https://frame.example/embed"></iframe><script>console.error("socket to supabase.co failed")</script>',
    }));
    await page.route('https://frame.example/**', (route) => route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><script>console.log("Stripe frame says hello")</script>',
    }));
    const record = recordConsole(page);
    await page.goto('https://own.example/');
    await expect.poll(() => record.frameLines.length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(record.lines.join('\n')).toMatch(/supabase\.co failed/);
    expect(record.lines.join('\n')).not.toMatch(/Stripe frame/);
    expect(record.frameLines.map((l) => l.text).join('\n')).toMatch(/Stripe frame says hello/);
    // The judged lines still go red through the same measure() the real routes use.
    const m = await run(page, { console: record.lines });
    expect(m.vendorConsole.offenders.join('\n')).toMatch(/"Supabase" in browser console/);
    // And the exempt lines, kept out of the judged list, leave the check green.
    const clean = await run(page, { console: record.lines.filter((l) => !/supabase/i.test(l)) });
    expect(clean.vendorConsole.offenders).toEqual([]);
  });
  test('the frame attribution compares origins, not hosts that merely contain one', () => {
    const frames = new Set(['https://frame.example']);
    expect(isFromVendorFrame('https://frame.example/embed.js', frames)).toBe(true);
    expect(isFromVendorFrame('https://frame.example.evil.test/x.js', frames)).toBe(false);
    expect(isFromVendorFrame('https://own.example/app.js', frames)).toBe(false);
    expect(isFromVendorFrame('', frames)).toBe(false);
    expect(isFromVendorFrame('about:blank', frames)).toBe(false);
    expect(originOf('wss://socket.example/realtime')).toBe('https://socket.example');
  });
  test('red: a vendor term in the page title', async ({ page }) => {
    await show(page, CLEAN, '<script>document.title = "Vercel preview"</script>');
    expect((await run(page)).vendorTerms.offenders.join('\n')).toMatch(/"Vercel" in title/);
  });
  test('green: ordinary words that are also vendor names stay legal', async ({ page }) => {
    await show(page, `<main><p>Resend invite. We render your estimate as a PDF.</p><button>Resend deposit preview</button></main>`);
    expect((await run(page)).vendorTerms.offenders).toEqual([]);
  });
  test('the URL is checked too (path and query, not the deployment host)', () => {
    expect(findVendorTerms([{ source: 'url', text: '/settings/supabase-keys' }]).map((h) => h.term)).toEqual(['Supabase']);
  });
});

test.describe('check 7: accessibility scan (WCAG 2.2 AA, touch projects)', () => {
  const touchOnly = () => isTouch(test.info().project.name);
  test('red on touch: an unnamed icon button and an image with no text alternative', async ({ page }) => {
    await show(page, `${CLEAN}<button style="width:48px;height:48px"><svg width="16" height="16"></svg></button><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="40" height="40">`);
    const r = (await run(page)).a11y;
    if (!touchOnly()) { expect(r).toMatchObject({ offenders: [], notApplicable: true }); return; }
    const all = r.offenders.join('\n');
    expect(all).toMatch(/^button-name \(critical\)/m);
    expect(all).toMatch(/^image-alt \(critical\)/m);
  });
  test('red on touch: a WCAG 2.2-only rule runs (2.5.8 target size)', async ({ page }) => {
    test.skip(!touchOnly(), 'the scan runs on touch projects only');
    const tiny = (n: string) => `<button aria-label="${n}" style="min-width:0;min-height:0;width:12px;height:12px;padding:0;margin:0;display:inline-block;vertical-align:top"></button>`;
    await show(page, `${CLEAN}<div>${tiny('One')}${tiny('Two')}${tiny('Three')}</div>`);
    expect((await run(page)).a11y.offenders.join('\n')).toMatch(/^target-size /m);
  });
  test('green: the clean page', async ({ page }) => {
    await show(page, CLEAN);
    expect((await run(page)).a11y.offenders).toEqual([]);
  });
  test('an overlay state scans the overlay, not the page under it', async ({ page }) => {
    test.skip(!touchOnly(), 'the scan runs on touch projects only');
    const page_ = `<main><h1>Clean page</h1><button style="width:48px;height:48px"><svg width="16" height="16"></svg></button></main>`;
    await show(page, `${page_}<div role="dialog" aria-label="Filter" style="position:fixed;top:40px;left:8px;width:200px;background:#fff"><button>Done</button></div>`);
    expect((await run(page, { overlay: true })).a11y.offenders).toEqual([]);
    await show(page, `${page_}<div role="dialog" aria-label="Filter" style="position:fixed;top:40px;left:8px;width:200px;background:#fff"><input type="text"><button>Done</button></div>`);
    expect((await run(page, { overlay: true })).a11y.offenders.join('\n')).toMatch(/^label /m);
  });
});

test.describe('check 8: scrim blur (touch projects)', () => {
  const scrim = (blur: boolean) =>
    `<div style="position:fixed;inset:0;background:rgba(0,0,0,.5);${blur ? 'backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);' : ''}"></div>`;
  test('red on touch: a full-viewport scrim with a backdrop blur (desktop control: not applicable)', async ({ page }) => {
    await show(page, `${CLEAN}${scrim(true)}`);
    const r = (await run(page)).scrimBlur;
    if (isTouch(test.info().project.name)) expect(r.offenders.join('\n')).toMatch(/full-viewport backdrop blur: div .*blur\(3px\)/);
    else expect(r).toMatchObject({ offenders: [], notApplicable: true });
  });
  test('green: the same scrim without the blur', async ({ page }) => {
    await show(page, `${CLEAN}${scrim(false)}`);
    expect((await run(page)).scrimBlur.offenders).toEqual([]);
  });
  test('green: a small blurred chip is not a scrim', async ({ page }) => {
    await show(page, `${CLEAN}<span style="position:absolute;top:8px;left:8px;padding:2px 6px;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)">Default</span>`);
    expect((await run(page)).scrimBlur.offenders).toEqual([]);
  });
});

test.describe('check: chromeRatio (slice 34)', () => {
  const bar = (px: number) => `<header data-slot="topbar" style="height:${px}px;display:flex;align-items:center">Bar</header>`;
  test('red: a two-row top bar on a short viewport', async ({ page }) => {
    await page.setViewportSize({ width: 838, height: 390 });
    await show(page, `${bar(104)}${CLEAN}`);
    expect((await run(page)).chromeRatio.offenders.join('\n')).toMatch(/top bar is 104 px tall/);
  });
  test('red: a fixed band under a one-row bar pushes the chrome past a fifth of a short screen', async ({ page }) => {
    await page.setViewportSize({ width: 838, height: 390 });
    await show(page, `${bar(50)}<div style="position:fixed;bottom:0;left:0;right:0;height:60px">Call bar</div>${CLEAN}`);
    expect((await run(page)).chromeRatio.offenders.join('\n')).toMatch(/chrome covers 28%/);
  });
  test('red: a band that sticks to the top counts as chrome', async ({ page }) => {
    await page.setViewportSize({ width: 838, height: 390 });
    await show(page, `${bar(50)}<div style="position:sticky;top:0;height:110px">Sticky header</div>${CLEAN}`);
    expect((await run(page)).chromeRatio.offenders.join('\n')).toMatch(/chrome covers 4\d%/);
  });
  test('green: an element that sticks only sideways is not chrome (a table empty state pinned to the left edge)', async ({ page }) => {
    await page.setViewportSize({ width: 838, height: 390 });
    await show(page, `${bar(50)}<div style="position:sticky;left:0;width:100%;height:110px">Nothing here yet</div>${CLEAN}`);
    expect((await run(page)).chromeRatio.offenders).toEqual([]);
  });
  test('green: a one-row bar on a short viewport', async ({ page }) => {
    await page.setViewportSize({ width: 838, height: 390 });
    await show(page, `${bar(50)}${CLEAN}`);
    expect((await run(page)).chromeRatio.offenders).toEqual([]);
  });
  test('not applicable on a tall viewport, whatever the bar is', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await show(page, `${bar(104)}${CLEAN}`);
    expect((await run(page)).chromeRatio).toMatchObject({ offenders: [], notApplicable: true });
  });
});

test.describe('check: dialogScrollers (slice 65)', () => {
  // A phone dialog: a fixed frame whose body is the one scroller; `list` is what the body holds.
  const dialog = (presentation: string, list: string) =>
    `${CLEAN}<div role="dialog" aria-label="Pick" data-presentation="${presentation}" style="position:fixed;inset:0;display:flex;flex-direction:column;overflow:hidden;background:#fff">
       <div style="flex:none;height:56px">Title</div>
       <div data-slot="dialog-body" style="flex:1;min-height:0;overflow-y:auto"><p>Intro</p>${list}</div>
       <div style="flex:none;height:56px"><button>Save</button></div>
     </div>`;
  const rows = (n: number) => Array.from({ length: n }, (_, i) => `<li style="height:40px">Row ${i}</li>`).join('');
  const capped = `<ul style="max-height:120px;overflow-y:auto;margin:0">${rows(12)}</ul>`;

  test('red: a capped list that scrolls inside a full-screen dialog\'s body', async ({ page }) => {
    await show(page, dialog('fullscreen', capped));
    const r = (await run(page, { overlay: true })).dialogScrollers;
    expect(r.offenders.join('\n')).toMatch(/ul scrolls inside div\.?.* in Pick dialog/);
  });
  test('red: the same list in a bottom sheet, and a capped list that has few rows today', async ({ page }) => {
    await show(page, dialog('bottom-sheet', capped));
    expect((await run(page, { overlay: true })).dialogScrollers.offenders.length).toBeGreaterThan(0);
    await show(page, dialog('fullscreen', `<ul style="max-height:120px;overflow-y:auto;margin:0">${rows(1)}</ul>`));
    expect((await run(page, { overlay: true })).dialogScrollers.offenders.length).toBeGreaterThan(0);
  });
  test('green: the body is the only scroller (the list flows)', async ({ page }) => {
    await show(page, dialog('fullscreen', `<ul style="margin:0">${rows(30)}</ul>`));
    expect((await run(page, { overlay: true })).dialogScrollers.offenders).toEqual([]);
  });
  test('green: a card keeps its capped list (the rule is for the phone presentations)', async ({ page }) => {
    await show(page, dialog('card', capped));
    expect((await run(page, { overlay: true })).dialogScrollers.offenders).toEqual([]);
  });
  test('green: a textarea and a sideways scroll box are not list scrollers', async ({ page }) => {
    await show(page, dialog('fullscreen', `<textarea style="height:60px">${'x\n'.repeat(40)}</textarea><div style="overflow-x:auto;width:200px"><div style="width:600px">wide</div></div>`));
    expect((await run(page, { overlay: true })).dialogScrollers.offenders).toEqual([]);
  });
  test('not applicable on a page with no dialog', async ({ page }) => {
    await show(page, CLEAN);
    expect((await run(page)).dialogScrollers).toMatchObject({ offenders: [], notApplicable: true });
  });
});

test.describe('a navigation under a check', () => {
  // The first evaluate dies the way Playwright reports a page that navigated under it; measure()
  // must measure the page that is there now, and a different error must still be thrown.
  const failFirstEvaluate = (page: Page, err: Error) => {
    let first = true;
    return new Proxy(page, {
      get(target, prop) {
        if (prop === 'evaluate') {
          return (...args: unknown[]) => {
            if (first) { first = false; return Promise.reject(err); }
            return (target.evaluate as (...a: unknown[]) => Promise<unknown>)(...args);
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  };
  test('green: a destroyed context is measured again on the page that is there now', async ({ page }) => {
    await show(page, CLEAN);
    const m = await measure(failFirstEvaluate(page, new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation')), { touch: isTouch(test.info().project.name), onlyInOverlays: false, consoleLines: [] });
    expect(m.overflow.offenders).toEqual([]);
  });
  test('red: any other error is not swallowed', async ({ page }) => {
    await show(page, CLEAN);
    const broken = failFirstEvaluate(page, new Error('something else broke'));
    await expect(measure(broken, { touch: false, onlyInOverlays: false, consoleLines: [] })).rejects.toThrow('something else broke');
  });
  test('only the navigation errors count as a race', () => {
    expect(isNavigationRace(new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation'))).toBe(true);
    expect(isNavigationRace(new Error('Protocol error: Cannot find context with specified id'))).toBe(true);
    expect(isNavigationRace(new Error('Timeout 30000ms exceeded'))).toBe(false);
  });
});

test.describe('allow-list decisions', () => {
  const list: Allowlist = {
    entries: {
      leads: { overflow: { mode: 'report', devices: ['iphone-se'] }, targets: { mode: 'enforce', devices: ['iphone-se'] } },
    },
  };
  test('a clean check passes whatever the list says', () => {
    expect(decide(list, 'leads', 'targets', 'iphone-se', [], false).status).toBe('pass');
  });
  test('a listed report-mode offender is reported, not failed', () => {
    expect(decide(list, 'leads', 'overflow', 'iphone-se', ['x'], false).status).toBe('allowed');
  });
  test('a new offender on an unlisted route fails', () => {
    expect(decide(list, 'customers', 'overflow', 'iphone-se', ['x'], false).status).toBe('fail');
  });
  test('a listed pair on a device it was not seen on fails (desktop control)', () => {
    expect(decide(list, 'leads', 'overflow', 'desktop', ['x'], false).status).toBe('fail');
  });
  test('a pair switched to enforce fails', () => {
    expect(decide(list, 'leads', 'targets', 'iphone-se', ['x'], false).status).toBe('fail');
  });
  test('a vendor term in the copy fails even when the pair is listed', () => {
    const listed: Allowlist = { entries: { leads: { vendorTerms: { mode: 'report', devices: ['iphone-se'] } } } };
    expect(decide(listed, 'leads', 'vendorTerms', 'iphone-se', ['x'], false).status).toBe('fail');
  });
  test('a console vendor hit fails on every route, listed or not (vendorConsole is enforced)', () => {
    expect(decide(list, 'customers', 'vendorConsole', 'iphone-se', ['x'], false).status).toBe('fail');
    const listed: Allowlist = { entries: { customers: { vendorConsole: { mode: 'report', devices: ['iphone-se'] } } } };
    expect(decide(listed, 'customers', 'vendorConsole', 'iphone-se', ['x'], false).status).toBe('fail');
    expect(decide(list, 'customers', 'vendorConsole', 'iphone-se', [], false).status).toBe('pass');
  });
  test('an a11y pair is listed per rule: a known rule is reported, a new rule on the same route fails', () => {
    const a11y: Allowlist = { entries: { leads: { a11y: { mode: 'report', devices: ['iphone-se'], rules: ['color-contrast'] } } } };
    expect(decide(a11y, 'leads', 'a11y', 'iphone-se', ['color-contrast (serious): 3 node(s) ...'], false).status).toBe('allowed');
    const v = decide(a11y, 'leads', 'a11y', 'iphone-se', ['color-contrast (serious): 3 node(s) ...', 'button-name (critical): 1 node(s) ...'], false);
    expect(v).toMatchObject({ status: 'fail', reason: expect.stringMatching(/button-name/) });
  });
  test('an a11y violation on an unlisted route fails', () => {
    expect(decide(list, 'customers', 'a11y', 'iphone-se', ['button-name (critical): 1 node(s) ...'], false).status).toBe('fail');
  });
  test('MOBILE_GATE_ENFORCE_ALL fails every offender', () => {
    expect(decide(list, 'leads', 'overflow', 'iphone-se', ['x'], true).status).toBe('fail');
  });
});
