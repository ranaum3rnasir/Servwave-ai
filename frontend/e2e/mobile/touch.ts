/**
 * Touch helpers for the mobile gate (PRD module 12, slice 19; rubric TEST-05).
 *
 * `tap`, `swipe` and `longPressDrag` drive the page with touch input only. None of them ever falls
 * back to the mouse: on a project without touch (the desktop control) each one throws, and each
 * one checks that the page received touch input and no mouse press during the gesture.
 * touch-selftest.spec.ts proves each one against a control that only answers the mouse.
 *
 * How each engine is driven:
 * - tap: Playwright's own `locator.tap()`, a trusted browser touch on every engine (on Chromium,
 *   with the release of a touch the headless browser holds back; see `tap`).
 * - swipe and long-press drag on Chromium: the DevTools protocol's `Input.dispatchTouchEvent`,
 *   the browser's own touch pipeline. The page sees trusted pointer and touch events, the browser
 *   decides panning, `touch-action` and `pointercancel` itself, and a swipe scrolls natively.
 * - swipe and long-press drag on WebKit: Playwright has no touch-move input for WebKit, so the
 *   gesture is synthesised in the page: pointer events with pointerType "touch" and touch events,
 *   in the browser's order, with real time between them. The browser's default pan is emulated
 *   the way the platform decides it: when the first move past the slop was not cancelled by the
 *   page and `touch-action` allows a pan in that direction, a `pointercancel` is sent and the
 *   nearest scroller follows the finger. Synthetic events are untrusted (`isTrusted` false) and
 *   iOS momentum scrolling is not modelled; the real-device checklist covers what that leaves.
 *
 * Used by the task board (slice 32) and the scheduler's long-press drag (slice 58).
 */
import type { CDPSession, Locator, Page } from '@playwright/test';

export interface Point { x: number; y: number }
/** A gesture end: an element (its centre) or a point in viewport CSS pixels. */
export type Where = Locator | Point;

export interface SwipeOptions {
  /** Move events between the two ends (default 12). */
  steps?: number;
  /** Time the finger is moving, ms (default 240: a quick flick-free swipe). */
  durationMs?: number;
}
export interface LongPressOptions extends SwipeOptions {
  /** How long the finger rests before it moves, ms (default 700: past a 500 ms long-press). */
  holdMs?: number;
}

const isPoint = (w: Where): w is Point => typeof (w as Point).x === 'number' && typeof (w as Point).y === 'number';

async function centre(w: Where): Promise<Point> {
  if (isPoint(w)) return w;
  await w.scrollIntoViewIfNeeded();
  const b = await w.boundingBox();
  if (!b) throw new Error(`touch helper: ${String(w)} has no box on screen`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function requireTouch(page: Page, helper: string) {
  // Engines report it differently (WebKit: ontouchstart but maxTouchPoints 0; Chromium: the
  // reverse); a context without hasTouch has none of the three.
  const touch = await page.evaluate(() => navigator.maxTouchPoints > 0 || 'ontouchstart' in window || matchMedia('(any-pointer: coarse)').matches);
  if (!touch) {
    throw new Error(`${helper}: this project has no touch screen (hasTouch is off). The touch helpers never fall back to the mouse; run them on a touch device project.`);
  }
}

// ── the probe: what input actually reached the page ────────────────────────────────────────────
interface Probe { touchstart: number; touchmove: number; pointerTypes: string[]; mousedownBeforeTouch: boolean; mousedown: number }

async function startProbe(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __touchProbe?: Probe & { off: () => void } };
    w.__touchProbe?.off();
    const p: Probe = { touchstart: 0, touchmove: 0, pointerTypes: [], mousedownBeforeTouch: false, mousedown: 0 };
    const on: Array<[string, (e: Event) => void]> = [
      ['touchstart', () => { p.touchstart++; }],
      ['touchmove', () => { p.touchmove++; }],
      ['pointerdown', (e) => { p.pointerTypes.push((e as PointerEvent).pointerType); }],
      ['mousedown', () => { p.mousedown++; if (!p.touchstart) p.mousedownBeforeTouch = true; }],
    ];
    for (const [t, f] of on) window.addEventListener(t, f, { capture: true, passive: true });
    w.__touchProbe = Object.assign(p, { off: () => { for (const [t, f] of on) window.removeEventListener(t, f, { capture: true }); } });
  });
}

/** Read and remove the probe; undefined when the gesture navigated away (nothing to read). */
async function readProbe(page: Page): Promise<Probe | undefined> {
  try {
    return await page.evaluate(() => {
      const w = window as unknown as { __touchProbe?: Probe & { off: () => void } };
      const p = w.__touchProbe;
      if (!p) return undefined;
      p.off();
      delete w.__touchProbe;
      return { touchstart: p.touchstart, touchmove: p.touchmove, pointerTypes: p.pointerTypes, mousedownBeforeTouch: p.mousedownBeforeTouch, mousedown: p.mousedown };
    });
  } catch {
    return undefined;
  }
}

function assertTouch(helper: string, p: Probe | undefined, o: { moved: boolean; compatMouse: boolean }) {
  if (!p) return; // the gesture navigated; the new page holds no probe
  const bad: string[] = [];
  if (p.touchstart === 0) bad.push('no touchstart reached the page');
  if (o.moved && p.touchmove === 0) bad.push('no touchmove reached the page');
  if (p.pointerTypes.some((t) => t !== 'touch')) bad.push(`a pointerdown arrived as "${p.pointerTypes.find((t) => t !== 'touch')}"`);
  if (p.mousedownBeforeTouch) bad.push('a mousedown arrived before any touch');
  // A tap may be followed by the browser's compatibility mouse events; a drag never is.
  if (!o.compatMouse && p.mousedown > 0) bad.push('a mousedown arrived during the gesture');
  if (bad.length) throw new Error(`${helper}: the gesture did not arrive as touch input: ${bad.join('; ')}`);
}

// ── tap ────────────────────────────────────────────────────────────────────────────────────────
/** The probe's touchstart count without removing it; -1 when the page holds no probe (it navigated). */
async function touchstarts(page: Page): Promise<number> {
  try {
    return await page.evaluate(() => (window as unknown as { __touchProbe?: Probe }).__touchProbe?.touchstart ?? -1);
  } catch {
    return -1;
  }
}

/** What `tap` does with a touch Chromium holds back (FG2). */
export interface HeldTouchPolicy {
  /** How long to keep nudging frames and waiting for the held touch, ms (default 45 000). */
  budgetMs: number;
  /** How long each nudge waits for the touch before the next one, ms (default 2 000). */
  pollMs: number;
}
const HELD: HeldTouchPolicy = { budgetMs: 45_000, pollMs: 2_000 };

/**
 * Make the browser composite a frame: a capture of the visible surface, as cheap as the protocol
 * allows (JPEG at the lowest quality, the speed-optimised encoder, no font wait, unlike
 * `page.screenshot`). A nudge never waits longer than `capMs`, and a capture still running is not
 * duplicated: the next nudge waits on it again instead.
 */
function frameNudger(page: Page) {
  let cdp: CDPSession | undefined;
  let inFlight: Promise<unknown> | undefined;
  let count = 0;
  return {
    get count() { return count; },
    async nudge(capMs: number) {
      if (!inFlight) {
        cdp ??= await page.context().newCDPSession(page);
        count++;
        inFlight = cdp
          .send('Page.captureScreenshot', { format: 'jpeg', quality: 1, optimizeForSpeed: true, fromSurface: true, captureBeyondViewport: false })
          .catch(() => undefined)
          .finally(() => { inFlight = undefined; });
      }
      await Promise.race([inFlight, new Promise((r) => setTimeout(r, capMs))]);
    },
    async close() { await cdp?.detach().catch(() => undefined); },
  };
}

/**
 * Test seam, used only by touch-selftest.spec.ts: a browser cannot be made to hold a touch on
 * demand, so the self-test swaps the dispatch for one that behaves like a held touch and checks
 * what `tap` does with it. The gate never passes these.
 */
export interface TapInternals {
  /** How the touch is dispatched (default: `locator.tap`, Playwright's trusted browser touch). */
  dispatch?: (target: Locator, timeout: number) => Promise<void>;
  held?: Partial<HeldTouchPolicy>;
  /** Told how many frame nudges the held-touch path made; not called when it did not run. */
  onHeld?: (nudges: number) => void;
}

/**
 * Tap an element with a real touch (never a mouse click).
 *
 * Headless Chromium can hold a dispatched touch back (FG2, the Galaxy S24 project on a loaded
 * machine, mostly the first tap after a page load): `locator.tap()` sits in "performing tap
 * action" until it times out and no touchstart has reached the page. Making the browser composite
 * a frame lets the held touch through, once. So, only on Chromium and only in exactly that state
 * (timed out while performing, no touchstart received), `tap` keeps nudging frames with a cheap
 * capture and waits for that same touch, for up to 45 s. It does not use `page.screenshot` for
 * this: that waits for fonts and encodes a full-resolution PNG, and on a starved browser it hung
 * for its whole 30 s timeout (FG2 round 1), so the release itself failed. Nothing is tapped twice
 * and nothing is clicked. Any other failure is rethrown as it was: an element that never became
 * actionable, a touch that arrived and still did not finish, or a held touch that never arrived.
 */
export async function tap(target: Locator, o: { timeout?: number } = {}, internals: TapInternals = {}): Promise<void> {
  const page = target.page();
  await requireTouch(page, 'tap');
  await startProbe(page);
  const before = page.url();
  const timeout = o.timeout ?? 15_000;
  const dispatch = internals.dispatch ?? ((t: Locator, ms: number) => t.tap({ timeout: ms }));
  try {
    await dispatch(target, timeout);
  } catch (err) {
    const chromium = page.context().browser()?.browserType().name() === 'chromium';
    if (!chromium || !/performing tap action/.test(String(err)) || (await touchstarts(page)) !== 0) throw err;
    const policy = { ...HELD, ...internals.held };
    const nudger = frameNudger(page);
    let n = 0;
    const heldAt = Date.now();
    try {
      const deadline = heldAt + policy.budgetMs;
      while (n === 0 && Date.now() < deadline) {
        await nudger.nudge(Math.max(0, Math.min(policy.pollMs, deadline - Date.now())));
        const pollEnd = Math.min(deadline, Date.now() + policy.pollMs);
        n = await touchstarts(page);
        while (n === 0 && Date.now() < pollEnd) {
          await page.waitForTimeout(100);
          n = await touchstarts(page);
        }
      }
    } finally {
      // One line per held touch, so a run shows how often the path ran and whether it helped.
      if (!internals.dispatch) console.log(`[touch] held touch on ${String(target)}: ${n === 0 ? 'never arrived' : 'arrived'} after ${nudger.count} frame nudge(s), ${Date.now() - heldAt} ms`);
      internals.onHeld?.(nudger.count);
      await nudger.close();
    }
    // -1: the probe is gone, so the page navigated; only the held tap can have done that.
    if (n === 0 || (n === -1 && page.url() === before)) {
      const why = n === 0 ? `no touchstart after ${nudger.count} frame nudge(s) in ${policy.budgetMs} ms` : 'the page lost its probe without navigating';
      throw new Error(`tap: the touch was held back and never reached the page (${why}).\n${String(err)}`);
    }
  }
  assertTouch('tap', await readProbe(page), { moved: false, compatMouse: true });
}

/** Tap on a touch project, click on the desktop control. */
export function press(touch: boolean, target: Locator, o: { timeout?: number } = {}): Promise<void> {
  return touch ? tap(target, o) : target.click({ timeout: o.timeout ?? 15_000 });
}

// ── swipe and long-press drag ──────────────────────────────────────────────────────────────────
/**
 * A swipe: finger down at `from`, straight to `to` in `durationMs`, finger up, no rest. On a
 * scroller it scrolls it; on a long-press drag source it must NOT pick the item up.
 */
export async function swipe(page: Page, from: Where, to: Where, o: SwipeOptions = {}): Promise<void> {
  await gesture(page, 'swipe', from, to, { holdMs: 0, steps: o.steps ?? 12, durationMs: o.durationMs ?? 240 });
}

/**
 * A long-press drag: finger down at `from`, rests `holdMs` without moving, moves to `to`, rests
 * briefly so the drop target registers, finger up. What the scheduler and the task board use to
 * pick up and move a card.
 */
export async function longPressDrag(page: Page, from: Where, to: Where, o: LongPressOptions = {}): Promise<void> {
  await gesture(page, 'longPressDrag', from, to, { holdMs: o.holdMs ?? 700, steps: o.steps ?? 16, durationMs: o.durationMs ?? 400 });
}

interface Plan { holdMs: number; steps: number; durationMs: number }

async function gesture(page: Page, helper: string, fromW: Where, toW: Where, plan: Plan) {
  await requireTouch(page, helper);
  const from = await centre(fromW);
  const to = await centre(toW);
  await startProbe(page);
  const engine = page.context().browser()?.browserType().name();
  if (engine === 'chromium') await nativeGesture(page, from, to, plan);
  else await syntheticGesture(page, from, to, plan);
  assertTouch(helper, await readProbe(page), { moved: true, compatMouse: false });
}

const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** Chromium: the browser's own touch input through the DevTools protocol. */
async function nativeGesture(page: Page, from: Point, to: Point, plan: Plan) {
  const cdp = await page.context().newCDPSession(page);
  const point = (p: Point) => ({ x: Math.round(p.x), y: Math.round(p.y), id: 1, radiusX: 4, radiusY: 4, force: 1 });
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(from)] });
    if (plan.holdMs) await page.waitForTimeout(plan.holdMs);
    for (let i = 1; i <= plan.steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(lerp(from, to, i / plan.steps))] });
      await page.waitForTimeout(plan.durationMs / plan.steps);
    }
    if (plan.holdMs) await page.waitForTimeout(120);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    // Let the scroll the swipe started settle before the caller measures.
    await page.waitForTimeout(150);
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** WebKit: the gesture synthesised in the page, in the browser's event order, in real time. */
async function syntheticGesture(page: Page, from: Point, to: Point, plan: Plan) {
  await page.evaluate(async ({ from, to, plan }) => {
    const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
    const target = document.elementFromPoint(from.x, from.y);
    if (!target) throw new Error(`touch helper: nothing at ${from.x},${from.y}`);
    const id = 7;
    const makeTouch = (x: number, y: number): Touch => {
      try {
        return new Touch({ identifier: id, target, clientX: x, clientY: y, pageX: x + scrollX, pageY: y + scrollY, screenX: x, screenY: y, radiusX: 4, radiusY: 4, force: 1 });
      } catch {
        // WebKit has no Touch constructor; it still has the legacy factory.
        const d = document as unknown as { createTouch: (...a: unknown[]) => Touch };
        return d.createTouch(window, target, id, x + scrollX, y + scrollY, x, y, 4, 4, 0, 1);
      }
    };
    const touchList = (ts: Touch[]): TouchList => {
      const d = document as unknown as { createTouchList?: (...t: Touch[]) => TouchList };
      return (d.createTouchList ? d.createTouchList(...ts) : ts) as TouchList;
    };
    const touch = (type: string, x: number, y: number, cancelable: boolean) => {
      const t = makeTouch(x, y);
      const live = type === 'touchend' || type === 'touchcancel' ? [] : [t];
      const init = { bubbles: true, cancelable, composed: true, touches: touchList(live), targetTouches: touchList(live), changedTouches: touchList([t]) };
      return target.dispatchEvent(new TouchEvent(type, init as unknown as TouchEventInit)); // false = the page cancelled it
    };
    const pointer = (type: string, x: number, y: number) => {
      const down = type === 'pointerdown' || type === 'pointermove';
      target.dispatchEvent(new PointerEvent(type, {
        bubbles: type !== 'pointerenter' && type !== 'pointerleave', cancelable: type !== 'pointercancel', composed: true,
        pointerId: id, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, screenX: x, screenY: y,
        button: type === 'pointermove' ? -1 : 0, buttons: down ? 1 : 0, width: 8, height: 8, pressure: down ? 0.5 : 0,
      }));
    };

    // Which pans touch-action allows on the target's chain, and who scrolls.
    const allows = (axis: 'x' | 'y') => {
      for (let e: Element | null = target; e; e = e.parentElement) {
        const ta = getComputedStyle(e).touchAction;
        if (ta === 'none') return false;
        if (ta === 'auto' || ta === 'manipulation' || !ta) continue;
        if (!ta.includes(`pan-${axis}`) && !ta.includes(axis === 'x' ? 'pan-left' : 'pan-up') && !ta.includes(axis === 'x' ? 'pan-right' : 'pan-down')) return false;
      }
      return true;
    };
    const scrollerFor = (axis: 'x' | 'y'): Element => {
      for (let e: Element | null = target; e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        const ov = axis === 'y' ? cs.overflowY : cs.overflowX;
        const room = axis === 'y' ? e.scrollHeight > e.clientHeight + 1 : e.scrollWidth > e.clientWidth + 1;
        if (room && /(auto|scroll)/.test(ov)) return e;
      }
      return document.scrollingElement || document.documentElement;
    };

    pointer('pointerover', from.x, from.y);
    pointer('pointerenter', from.x, from.y);
    pointer('pointerdown', from.x, from.y);
    const startTaken = !touch('touchstart', from.x, from.y, true);
    if (plan.holdMs) await sleep(plan.holdMs);

    const SLOP = 10;
    let panning: { axis: 'x' | 'y'; el: Element; last: Point } | null = null;
    let decided = false;
    let at = from;
    for (let i = 1; i <= plan.steps; i++) {
      const p = { x: from.x + (to.x - from.x) * (i / plan.steps), y: from.y + (to.y - from.y) * (i / plan.steps) };
      if (panning) {
        // While the browser pans, the page gets uncancelable touchmoves and no pointer events.
        touch('touchmove', p.x, p.y, false);
        const dx = p.x - panning.last.x, dy = p.y - panning.last.y;
        if (panning.axis === 'y') panning.el.scrollTop -= dy; else panning.el.scrollLeft -= dx;
        panning.last = p;
      } else {
        pointer('pointermove', p.x, p.y);
        const moveTaken = !touch('touchmove', p.x, p.y, true);
        if (!decided && Math.hypot(p.x - from.x, p.y - from.y) > SLOP) {
          decided = true;
          const axis: 'x' | 'y' = Math.abs(p.y - from.y) >= Math.abs(p.x - from.x) ? 'y' : 'x';
          if (!startTaken && !moveTaken && allows(axis)) {
            // The browser takes the gesture as a pan: the pointer stream is cancelled.
            pointer('pointercancel', p.x, p.y);
            pointer('pointerout', p.x, p.y);
            pointer('pointerleave', p.x, p.y);
            const el = scrollerFor(axis);
            if (axis === 'y') el.scrollTop -= p.y - from.y; else el.scrollLeft -= p.x - from.x;
            panning = { axis, el, last: p };
          }
        }
      }
      at = p;
      await sleep(plan.durationMs / plan.steps);
    }
    if (plan.holdMs) await sleep(120);
    if (!panning) {
      pointer('pointerup', at.x, at.y);
      pointer('pointerout', at.x, at.y);
      pointer('pointerleave', at.x, at.y);
    }
    touch('touchend', at.x, at.y, !panning);
    await sleep(50);
  }, { from, to, plan });
}
