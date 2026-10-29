/**
 * Touch-helper self-test (slice 19): every helper in touch.ts must drive the page with touch, and
 * a page that only answers the mouse must NOT answer it. Each fixture below holds two handlers on
 * the same control: one that only real touch input reaches, and one that only the mouse reaches.
 * A helper that fell back to the mouse (page.mouse, locator.click) turns these red.
 *
 * Runs on `selftest-touch` (iPhone SE, WebKit: synthetic gestures), `selftest-touch-chromium`
 * (Galaxy S24, Chromium: the browser's own touch input) and `selftest-desktop` (no touch: every
 * helper must refuse instead of clicking). No servers:
 *
 *   npm run test:mobile:selftest
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { longPressDrag, swipe, tap } from './touch';

const hasTouch = () => test.info().project.name !== 'selftest-desktop';

async function show(page: Page, body: string, script: string) {
  await page.setContent(
    `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fixture</title>
     <style>html,body{margin:0;font:16px sans-serif} button{font:16px sans-serif;min-width:48px;min-height:48px}</style></head>
     <body>${body}<script>window.log = [];${script}</script></body></html>`,
  );
}
const log = (page: Page) => page.evaluate(() => (window as unknown as { log: string[] }).log.slice());

// ── tap ────────────────────────────────────────────────────────────────────────────────────────
const TAP_BODY = `<main style="padding:24px;display:flex;gap:16px">
  <button id="touch-only">Touch</button><button id="mouse-only">Mouse</button></main>`;
const TAP_SCRIPT = `
  document.getElementById('touch-only').addEventListener('pointerup', (e) => { if (e.pointerType === 'touch') log.push('touch-tap'); });
  document.getElementById('touch-only').addEventListener('touchend', () => log.push('touchend'));
  // A mouse press: what a click() or page.mouse fallback would deliver.
  document.getElementById('mouse-only').addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') log.push('mouse-press'); });`;

test.describe('tap', () => {
  test('a control that answers only touch answers the tap', async ({ page }) => {
    test.skip(!hasTouch(), 'touch projects only');
    await show(page, TAP_BODY, TAP_SCRIPT);
    await tap(page.locator('#touch-only'));
    expect(await log(page)).toEqual(expect.arrayContaining(['touch-tap', 'touchend']));
  });
  test('a control that answers only the mouse does not answer the tap', async ({ page }) => {
    test.skip(!hasTouch(), 'touch projects only');
    await show(page, TAP_BODY, TAP_SCRIPT);
    await tap(page.locator('#mouse-only'));
    expect(await log(page)).not.toContain('mouse-press');
  });
  test('a tap that cannot reach its control still fails, and nothing reaches it (FG2)', async ({ page }) => {
    test.skip(!hasTouch(), 'touch projects only');
    // A sheet over the control: Playwright never gets to dispatch the touch (the sheet intercepts
    // it), so this is not a held touch and `tap` must rethrow at once, with the caller's timeout.
    await show(page, `${TAP_BODY}<div id="sheet" style="position:fixed;inset:0;background:rgba(0,0,0,.2)"></div>`, TAP_SCRIPT);
    let held = false;
    await expect(tap(page.locator('#touch-only'), { timeout: 1_500 }, { onHeld: () => { held = true; } })).rejects.toThrow(/Timeout 1500ms exceeded/);
    expect(held, 'the held-touch path did not run').toBe(false);
    expect(await log(page)).toEqual([]);
  });

  // The held-touch path (FG2). A browser cannot be made to hold a touch on demand, so these swap
  // the dispatch for one that behaves the way a held touch does: it times out "performing tap
  // action" with no touchstart on the page, and the browser delivers the touch later, or never.
  // Everything after the dispatch is `tap`'s real code against a real page.
  const heldDispatch = (deliverAfterMs: number | null) => async (t: Locator, timeout: number) => {
    await new Promise((r) => setTimeout(r, timeout));
    if (deliverAfterMs !== null) setTimeout(() => { void t.tap({ timeout: 10_000 }).catch(() => undefined); }, deliverAfterMs);
    throw new Error(`locator.tap: Timeout ${timeout}ms exceeded.\nCall log:\n  - performing tap action`);
  };
  const chromium = () => test.info().project.name === 'selftest-touch-chromium';

  test('a held touch that arrives late is waited for, nudged, and lands once (FG2)', async ({ page }) => {
    test.skip(!chromium(), 'the held-touch path is Chromium only');
    await show(page, TAP_BODY, TAP_SCRIPT);
    let nudges = -1;
    await tap(page.locator('#touch-only'), { timeout: 500 }, { dispatch: heldDispatch(2_500), onHeld: (n) => { nudges = n; } });
    expect(nudges, 'frames were nudged while the touch was held').toBeGreaterThan(0);
    const got = await log(page);
    expect(got.filter((e) => e === 'touchend'), 'the held touch landed exactly once').toHaveLength(1);
    expect(got).toContain('touch-tap');
  });

  test('a held touch that never arrives fails with the tap\'s own error after the budget (FG2)', async ({ page }) => {
    test.skip(!chromium(), 'the held-touch path is Chromium only');
    await show(page, TAP_BODY, TAP_SCRIPT);
    let nudges = -1;
    const t0 = Date.now();
    await expect(
      tap(page.locator('#touch-only'), { timeout: 500 }, { dispatch: heldDispatch(null), held: { budgetMs: 3_000, pollMs: 500 }, onHeld: (n) => { nudges = n; } }),
    ).rejects.toThrow(/held back and never reached the page[\s\S]*performing tap action/);
    expect(Date.now() - t0, 'it gave up at its budget').toBeLessThan(10_000);
    expect(nudges).toBeGreaterThan(0);
    expect(await log(page)).toEqual([]);
  });

  test('a touch that arrived and still timed out is rethrown, not waited for as held (FG2)', async ({ page }) => {
    test.skip(!hasTouch(), 'touch projects only');
    await show(page, TAP_BODY, TAP_SCRIPT);
    let held = false;
    const arrivedThenTimedOut = async (t: Locator, timeout: number) => {
      await t.tap({ timeout: 10_000 });
      throw new Error(`locator.tap: Timeout ${timeout}ms exceeded.\nCall log:\n  - performing tap action`);
    };
    await expect(tap(page.locator('#touch-only'), { timeout: 500 }, { dispatch: arrivedThenTimedOut, onHeld: () => { held = true; } })).rejects.toThrow(/^locator\.tap: Timeout 500ms exceeded/);
    expect(held).toBe(false);
  });

  test('on WebKit a held-looking timeout is rethrown as it was (FG2)', async ({ page }) => {
    test.skip(test.info().project.name !== 'selftest-touch', 'the WebKit phone only');
    await show(page, TAP_BODY, TAP_SCRIPT);
    let held = false;
    await expect(tap(page.locator('#touch-only'), { timeout: 500 }, { dispatch: heldDispatch(null), onHeld: () => { held = true; } })).rejects.toThrow(/^locator\.tap: Timeout 500ms exceeded/);
    expect(held).toBe(false);
  });
  test('without touch it refuses rather than clicking', async ({ page }) => {
    test.skip(hasTouch(), 'the desktop control only');
    await show(page, TAP_BODY, TAP_SCRIPT);
    await expect(tap(page.locator('#mouse-only'))).rejects.toThrow(/touch/);
    expect(await log(page)).toEqual([]);
  });
});

// ── swipe ──────────────────────────────────────────────────────────────────────────────────────
const SWIPE_BODY = `<div id="list" style="margin:24px;height:320px;overflow-y:auto;border:1px solid #999">
  ${Array.from({ length: 60 }, (_, i) => `<div style="height:50px;border-bottom:1px solid #eee">Row ${i + 1}</div>`).join('')}</div>`;
const SWIPE_SCRIPT = `
  const list = document.getElementById('list');
  list.addEventListener('touchmove', () => { if (log[log.length - 1] !== 'touchmove') log.push('touchmove'); }, { passive: true });
  // A mouse-only drag-to-scroll: if this is what moves the list, the helper used the mouse.
  let down = null, top0 = 0;
  list.addEventListener('mousedown', (e) => { down = e.clientY; top0 = list.scrollTop; });
  addEventListener('mousemove', (e) => { if (down === null) return; list.scrollTop = top0 - (e.clientY - down); if (!log.includes('mouse-drag')) log.push('mouse-drag'); });
  addEventListener('mouseup', () => { down = null; });`;

test.describe('swipe', () => {
  test('a swipe up scrolls the list by touch, not by a mouse drag', async ({ page }) => {
    test.skip(!hasTouch(), 'touch projects only');
    await show(page, SWIPE_BODY, SWIPE_SCRIPT);
    const box = (await page.locator('#list').boundingBox())!;
    const x = box.x + box.width / 2;
    await swipe(page, { x, y: box.y + box.height - 40 }, { x, y: box.y + 40 });
    const top = await page.locator('#list').evaluate((e) => e.scrollTop);
    expect(top, 'the list scrolled').toBeGreaterThan(120);
    const seen = await log(page);
    expect(seen).toContain('touchmove');
    expect(seen).not.toContain('mouse-drag');
  });
  test('without touch it refuses rather than dragging the mouse', async ({ page }) => {
    test.skip(hasTouch(), 'the desktop control only');
    await show(page, SWIPE_BODY, SWIPE_SCRIPT);
    await expect(swipe(page, { x: 100, y: 300 }, { x: 100, y: 60 })).rejects.toThrow(/touch/);
    expect(await log(page)).toEqual([]);
  });
});

// ── long-press drag ────────────────────────────────────────────────────────────────────────────
// Two cards, both dropped on the zone. `#card` is a touch-events sensor with a hold delay (the
// shape of a calendar's long-press drag); `#pcard` is a pointer-events sensor that ignores the
// mouse (the shape of a touch-only pointer sensor). Each also answers a mouse drag, which the
// helper must never be the one to trigger.
const LP_BODY = `<main style="padding:16px">
  <div id="card" style="width:200px;height:56px;background:#ddd">Job card</div>
  <div id="pcard" style="margin-top:12px;width:200px;height:56px;background:#cde;touch-action:none">Task card</div>
  <div id="zone" style="margin-top:160px;width:260px;height:120px;background:#efe">Drop here</div></main>`;
const LP_SCRIPT = `
  const card = document.getElementById('card'), pcard = document.getElementById('pcard'), zone = document.getElementById('zone');
  const inZone = (x, y) => { const z = zone.getBoundingClientRect(); return x >= z.left && x <= z.right && y >= z.top && y <= z.bottom; };
  // touch-events sensor: armed after a 400 ms hold without moving more than 8 px.
  let start = null, armed = false, last = null, timer = 0;
  card.addEventListener('touchstart', (e) => { const t = e.touches[0]; start = { x: t.clientX, y: t.clientY }; last = null; timer = setTimeout(() => { armed = true; log.push('armed'); }, 400); }, { passive: false });
  card.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (armed) { e.preventDefault(); last = { x: t.clientX, y: t.clientY }; return; }
    if (start && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 8) clearTimeout(timer);
  }, { passive: false });
  card.addEventListener('touchend', () => { clearTimeout(timer); if (armed && last && inZone(last.x, last.y)) log.push('dropped'); armed = false; start = null; });
  // pointer-events sensor that only takes touch pointers, with a 250 ms hold.
  let pArmed = false, pTimer = 0, pLast = null;
  pcard.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'touch') return; pLast = null; pTimer = setTimeout(() => { pArmed = true; log.push('p-armed'); }, 250); });
  pcard.addEventListener('pointermove', (e) => { if (pArmed && e.pointerType === 'touch') pLast = { x: e.clientX, y: e.clientY }; });
  pcard.addEventListener('pointerup', (e) => { clearTimeout(pTimer); if (pArmed && pLast && inZone(pLast.x, pLast.y)) log.push('p-dropped'); pArmed = false; });
  pcard.addEventListener('pointercancel', () => { clearTimeout(pTimer); pArmed = false; log.push('p-cancel'); });
  // The mouse-only path on both cards.
  let mdown = false;
  for (const c of [card, pcard]) c.addEventListener('mousedown', () => { mdown = true; });
  addEventListener('mouseup', (e) => { if (mdown && inZone(e.clientX, e.clientY)) log.push('mouse-drop'); mdown = false; });`;

test.describe('long-press drag', () => {
  test('a touch-events sensor with a hold delay picks the card up and drops it', async ({ page }) => {
    test.skip(!hasTouch(), 'touch projects only');
    await show(page, LP_BODY, LP_SCRIPT);
    await longPressDrag(page, page.locator('#card'), page.locator('#zone'));
    const seen = await log(page);
    expect(seen).toEqual(expect.arrayContaining(['armed', 'dropped']));
    expect(seen).not.toContain('mouse-drop');
  });
  test('a pointer-events sensor that ignores the mouse picks the card up and drops it', async ({ page }) => {
    test.skip(!hasTouch(), 'touch projects only');
    await show(page, LP_BODY, LP_SCRIPT);
    await longPressDrag(page, page.locator('#pcard'), page.locator('#zone'));
    const seen = await log(page);
    expect(seen).toEqual(expect.arrayContaining(['p-armed', 'p-dropped']));
    expect(seen).not.toContain('mouse-drop');
  });
  test('a swipe without the hold never picks the card up', async ({ page }) => {
    test.skip(!hasTouch(), 'touch projects only');
    await show(page, LP_BODY, LP_SCRIPT);
    const zone = (await page.locator('#zone').boundingBox())!;
    await swipe(page, page.locator('#card'), { x: zone.x + 40, y: zone.y + 40 });
    const seen = await log(page);
    expect(seen).not.toContain('armed');
    expect(seen).not.toContain('dropped');
    expect(seen).not.toContain('mouse-drop');
  });
  test('without touch it refuses rather than dragging the mouse', async ({ page }) => {
    test.skip(hasTouch(), 'the desktop control only');
    await show(page, LP_BODY, LP_SCRIPT);
    await expect(longPressDrag(page, page.locator('#card'), page.locator('#zone'))).rejects.toThrow(/touch/);
    expect(await log(page)).toEqual([]);
  });
});
