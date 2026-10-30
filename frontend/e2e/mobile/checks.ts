/**
 * Mobile-gate measurements, run inside the page.
 *
 * Ported from the 2026-10-01 audit harness (rubric appendix A1-A8 plus its scroller and overlay
 * probes): the overflow finder (A1), tap-target audit (A2), input font-size audit (A3),
 * nested-scroller check (A4), chrome ratio (A5), sticky check (A6), focus-obscured check (A7) and
 * orphan-input check (A8), plus last-control reachability and overlay geometry.
 *
 * Six of them are ASSERTED (see CHECKS below); A4, A5, A6, A7 and A8 are measured and attached to
 * every result as `info`, so the slices that own them can turn them into assertions later.
 *
 * Every function here is passed to `page.evaluate`, so each one must be self-contained: no
 * references to anything outside its own body.
 */
import type { Page } from '@playwright/test';
import { ADMIN_SCROLL_TABLES, INTENDED_X_SCROLLERS } from '../../src/ui-kit/lib/intendedScrollers';
import { SCHEDULE_CARD_SELECTOR, type CardFact } from './schedule-double-booked';

/**
 * The asserted checks. Keys are the check names used in allowlist.json.
 * The first six are the slice's six; `vendorConsole` splits the browser-console half of the copy
 * rule out of `vendorTerms`, because the console also carries messages the BROWSER writes, and the
 * vendors' embedded frames print their own lines (excluded, console-lines.ts). `scrimBlur` is mobile slice 16's
 * (PERF-06): no full-viewport backdrop blur on a touch device.
 * `a11y` (slice 19) is the axe-core WCAG 2.2 AA scan on the touch projects; it lives in a11y.ts
 * because it runs through @axe-core/playwright, not a page function.
 *
 * `chromeRatio` (slice 34, rubric VP-12) is the short-height rule: on a phone held sideways (a viewport at
 * most 500 px tall) the top bar stays one row and the chrome takes no more than a fifth of the screen.
 * It is not on the allow-list anywhere, so any offender fails.
 *
 * `dialogScrollers` (slice 65, rubric SCR-02) is the dialog half of A4: on a phone a full-screen
 * dialog or a bottom sheet has ONE scroller, its body, and no capped list scrolls inside it. It is
 * not on the allow-list anywhere, so any offender fails.
 *
 * `topbarOverflow` (slice 13) is the top-bar half of `overflow`, judged on its own: the top bar is
 * the same shell on every signed-in route, so once it fits it is enforced on EVERY route, while the
 * page-content half of `overflow` stays in report mode for the slices that own each page. It is not
 * on the allow-list anywhere, so any offender fails.
 */
export const CHECKS = ['overflow', 'topbarOverflow', 'targets', 'inputFont', 'overlays', 'scrollReach', 'vendorTerms', 'vendorConsole', 'a11y', 'scrimBlur', 'chromeRatio', 'dialogScrollers'] as const;
export type CheckName = (typeof CHECKS)[number];
/**
 * Enforced from day one: the allow-list cannot hold these (the copy rule in CLAUDE.md).
 * `vendorConsole` joined `vendorTerms` here in the notification-bell follow-up to mobile slice 75:
 * the one source of vendor lines in our own document, a failed realtime socket, is gone (the bell
 * polls), so any vendor name in the console from our own document fails. Lines from the vendors'
 * embedded frames (phone dialer, payment form) are excluded before the check runs (console-lines.ts);
 * Ran accepted that as a documented exception on 2026-10-08 (`acceptedExceptions` in allowlist.json).
 */
export const ALWAYS_ENFORCED: readonly CheckName[] = ['vendorTerms', 'vendorConsole'];
/**
 * Reported on every run, never failed unless a pair is switched to `enforce` (or
 * MOBILE_GATE_ENFORCE_ALL=1). Empty since `vendorConsole` was enforced; a check added here needs a
 * `reportOnlyChecks` entry (src/__tests__/mobile-gate-allowlist.test.ts).
 */
export const REPORT_ONLY: readonly CheckName[] = [];

export interface CheckResult {
  offenders: string[];
  /** Not asserted; context for whoever reads the report. */
  info?: unknown;
  /** True when the check does not apply here (e.g. 16 px inputs on the desktop control). */
  notApplicable?: boolean;
  /**
   * `targets` only: per offender, the index (into the page's time-grid event cards, SCHEDULE_CARD_SELECTOR)
   * of the card it is or sits inside, -1 when it is not in one. Read by the Schedule's accepted exception
   * (schedule-double-booked.ts); nothing else uses it.
   */
  offenderCard?: number[];
  /**
   * `scrollReach` only: the last control and the element covering it, as event-card indexes (-1 when that
   * element is not in a card). Read by the Schedule's accepted exception; nothing else uses it.
   */
  cover?: { last: number; hit: number };
  /**
   * Offenders the Schedule's accepted exception excused (allowlist.json acceptedExceptions.scheduleDoubleBooked).
   * They are NOT in `offenders`, so they never fail; the gate prints them as EXEMPT. Set by measure(), only
   * when the caller asked for the exception.
   */
  exempt?: string[];
  /**
   * `vendorTerms` only: the gate's own test-inbox addresses the accepted exception `gateTestInbox` ignored
   * (allowlist.json; vendor-terms.ts). Not offenders; the gate prints them as EXEMPT. Set by measure(), only
   * when the caller asked for the exception.
   */
  gateTestInbox?: string[];
}

/**
 * Elements that are primary touch controls (PRD module 12): the drawer trigger, top-bar icons,
 * dialog close, the detail-page primary action, list-card checkboxes, switches, the signature
 * Clear, Send and pagination. On touch projects they must be at least 44x44 px.
 *
 * `[data-touch-primary]` is the opt-in marker: a slice that adds a primary action the selectors
 * below cannot recognise (for example a detail page's Complete job) puts it on that control.
 */
export const PRIMARY_TOUCH_SELECTORS = [
  '[data-touch-primary]',
  'button[aria-label="Open navigation"]',
  '[data-slot="topbar"] button',
  '[data-slot="topbar"] a[href]',
  '[role="dialog"] button[aria-label^="Close" i]',
  '[role="alertdialog"] button[aria-label^="Close" i]',
  '[role="checkbox"]',
  'input[type="checkbox"]',
  '[role="switch"]',
  'nav[aria-label*="pagination" i] button',
  'nav[aria-label*="pagination" i] a[href]',
  'button[aria-label*="next page" i]',
  'button[aria-label*="previous page" i]',
];

/**
 * The marker that documents an intended horizontal scroller. Its VALUE must be a name on the
 * exemption list, `src/ui-kit/lib/intendedScrollers.ts` (slice 17): the wide admin tables that
 * scroll inside their own box, plus the one-row tab strip. A bare or unlisted marker documents
 * nothing.
 */
export { INTENDED_X_SCROLLER_ATTR } from '../../src/ui-kit/lib/intendedScrollers';

/** What the overflow check is told about the exemption list (passed into the page). */
export interface OverflowOpts {
  onlyInOverlays?: boolean;
  /** Names accepted on `data-mobile-scroll-x`. */
  intended?: readonly string[];
  /** The listed names that are admin tables: their first column must stay inside the box. */
  adminTables?: readonly string[];
}

// ── check 1: horizontal overflow ────────────────────────────────────────────────────────────────
export function overflowCheck(opts: OverflowOpts = {}): CheckResult {
  const vw = document.documentElement.clientWidth;
  const intended = opts.intended ?? [];
  const adminTables = opts.adminTables ?? [];
  const inScope = (el: Element) => !opts.onlyInOverlays || !!el.closest('[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[data-radix-popper-content-wrapper],[cmdk-root],aside[data-drawer="open"]');
  const sig = (el: Element) =>
    el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (el.classList.length ? `.${[...el.classList].slice(0, 4).join('.')}` : '');
  const text = (el: Element) => ((el as HTMLElement).innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30);
  const isXScroller = (el: Element) => /(auto|scroll)/.test(getComputedStyle(el).overflowX);
  const markerOf = (el: Element) => el.closest('[data-mobile-scroll-x]')?.getAttribute('data-mobile-scroll-x') ?? null;
  const documented = (el: Element) => { const name = markerOf(el); return name !== null && intended.includes(name); };
  const deliberatelyHidden = (el: Element) =>
    !!el.closest('[inert],[aria-hidden="true"],aside[data-drawer="closed"]');
  const fixedAncestor = (el: Element) => {
    for (let p: Element | null = el; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).position === 'fixed') return true;
    return false;
  };
  const offenders: string[] = [];

  const docW = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  if (docW > vw + 1 && !opts.onlyInOverlays) offenders.push(`page scrolls sideways: content ${docW}px wide in a ${vw}px viewport`);

  // Elements past either edge that are not inside a horizontal scroller.
  const past = new Set<Element>();
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue;
    const pastRight = r.right > vw + 1;
    const cutLeft = r.left < -1 && r.right > 0; // wholly off-left is invisible, not overflow
    if (!pastRight && !cutLeft) continue;
    if (deliberatelyHidden(el) || !inScope(el)) continue;
    // A fixed panel parked wholly past the right edge (a closed side sheet) widens nothing and
    // cannot be seen; one that is cut by the edge is still an offender.
    if (r.left >= vw - 1 && fixedAncestor(el)) continue;
    // Slice 75: two shapes are clipped by their own box and widen nothing. The fill of a progress
    // bar is slid out of its track by a transform, and a chart draws a line past the edge of its
    // own svg (the svg clips it). A plain block cut by an overflow:hidden wrapper is NOT exempt:
    // that is real content a user cannot read.
    if (el.closest('[role=progressbar]') && el.closest('[role=progressbar]') !== el) continue;
    const svg = el.closest('svg');
    if (svg && svg !== el) {
      const sr = svg.getBoundingClientRect();
      if (sr.left >= -1 && sr.right <= vw + 1) continue;
    }
    let p = el.parentElement;
    let inX = false;
    while (p && p !== document.body) {
      if (isXScroller(p)) { inX = true; break; }
      p = p.parentElement;
    }
    if (!inX) past.add(el);
  }
  for (const el of past) {
    if (el.parentElement && past.has(el.parentElement)) continue; // report the outermost only
    const r = el.getBoundingClientRect();
    offenders.push(`past the edge: ${sig(el)} [${Math.round(r.left)}..${Math.round(r.right)}] "${text(el)}"`);
  }

  // Horizontal scrollers that actually scroll, unless documented as intended.
  for (const el of document.querySelectorAll('body *')) {
    if (!isXScroller(el)) continue;
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue;
    if (deliberatelyHidden(el) || !inScope(el)) continue;
    if (!documented(el)) {
      const name = markerOf(el);
      const why = name === null ? '' : name === '' ? ' (marker has no name)' : ` (marker "${name}" is not on the exemption list)`;
      offenders.push(`undocumented sideways scroller: ${sig(el)} content ${el.scrollWidth}px in ${el.clientWidth}px${why}`);
      continue;
    }
    // A documented admin table must keep its identifying first column in view while it scrolls:
    // scroll it to its far end, check the first row's first cell still starts inside the box,
    // and put the scroll back.
    const name = el.getAttribute('data-mobile-scroll-x');
    if (name === null || !adminTables.includes(name)) continue;
    const firstCell = el.querySelector('tr')?.firstElementChild;
    if (!firstCell) continue;
    const before = el.scrollLeft;
    el.scrollLeft = el.scrollWidth;
    const box = el.getBoundingClientRect();
    const cell = firstCell.getBoundingClientRect();
    el.scrollLeft = before;
    if (cell.left < box.left - 1 || cell.right <= box.left + 1) {
      offenders.push(`admin table's first column scrolls out of its box: ${name} (${sig(el)})`);
    }
  }

  // A4: nested vertical scrollers (measured, not asserted).
  const isY = (el: Element) => { const s = getComputedStyle(el); return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1; };
  const ys = [...document.querySelectorAll('body *')].filter(isY);
  const nestedScrollers = ys.filter((el) => ys.some((o) => o !== el && o.contains(el))).map(sig).slice(0, 10);
  return { offenders, info: { viewportWidth: vw, documentWidth: docW, nestedScrollers } };
}

// ── check 1b: the top bar fits the screen (slice 13) ────────────────────────────────────────────
export function topbarOverflowCheck(): CheckResult {
  const bar = document.querySelector('[data-slot="topbar"]');
  if (!bar) return { offenders: [], notApplicable: true }; // public pages and sign-in have no top bar
  const vw = document.documentElement.clientWidth;
  const b = bar.getBoundingClientRect();
  const left = Math.max(0, b.left);
  const right = Math.min(vw, b.right);
  const sig = (el: Element) =>
    el.tagName.toLowerCase() + (el.getAttribute('data-slot') ? `[${el.getAttribute('data-slot')}]` : '') + (el.classList.length ? `.${[...el.classList].slice(0, 3).join('.')}` : '');
  const name = (el: Element) =>
    (el.getAttribute('aria-label') || (el as HTMLElement).innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30);
  const offenders: string[] = [];
  // Anything drawn in the bar counts, decorative or not: a clipped glyph is still a broken bar.
  const past = new Set<Element>();
  for (const el of [bar, ...bar.querySelectorAll('*')]) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue;
    if (r.right > right + 1 || r.left < left - 1) past.add(el);
  }
  for (const el of past) {
    if (el.parentElement && past.has(el.parentElement)) continue; // the outermost only
    const r = el.getBoundingClientRect();
    offenders.push(`top bar item past the edge: ${sig(el)} [${Math.round(r.left)}..${Math.round(r.right)}] in ${vw}px "${name(el)}"`);
  }
  // Content squeezed past the bar's own box (a row that cannot shrink) even where nothing has
  // reached the screen edge yet.
  if (bar.scrollWidth > bar.clientWidth + 1) {
    offenders.push(`top bar content is ${bar.scrollWidth}px wide in a ${bar.clientWidth}px bar`);
  }
  // The bar's direct children and their widths: what to read when a later change makes it crowd.
  const items = [...bar.children].map((c) => `${sig(c)} ${Math.round(c.getBoundingClientRect().width)}px`);
  return { offenders, info: { viewportWidth: vw, barWidth: Math.round(b.width), items } };
}

// ── check 2: target sizes ───────────────────────────────────────────────────────────────────────
export function targetsCheck(opts: { touch: boolean; primary: string[]; onlyInOverlays?: boolean; cardSelector?: string }): CheckResult {
  const vw = innerWidth;
  const inScope = (el: Element) => !opts.onlyInOverlays || !!el.closest('[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[data-radix-popper-content-wrapper],[cmdk-root],aside[data-drawer="open"]');
  const sel =
    'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=menuitem],[role=tab],[role=checkbox],[role=radio],[role=switch],[role=option],[tabindex]:not([tabindex="-1"])';
  const name = (e: Element) =>
    (e.getAttribute('aria-label') || (e as HTMLElement).innerText || e.getAttribute('title') || e.getAttribute('placeholder') || '')
      .trim().replace(/\s+/g, ' ').slice(0, 30);
  const visuallyHidden = (e: Element, cs: CSSStyleDeclaration) =>
    /rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)/.test(cs.clip) || /inset\(50%\)/.test(cs.clipPath);
  const isInlineTextLink = (e: Element) => {
    if (e.tagName !== 'A') return false;
    if (getComputedStyle(e).display !== 'inline') return false;
    const parent = e.parentElement;
    if (!parent) return false;
    // A link inside a sentence: its block has text of its own besides the link.
    const own = [...parent.childNodes].some((n) => n.nodeType === 3 && (n.textContent || '').trim().length > 0);
    return own || !!e.closest('p,li');
  };
  const primary = opts.primary.join(',');
  const targets: Array<{ e: Element; r: DOMRect; small: boolean; inScope: boolean }> = [];
  for (const e of document.querySelectorAll(sel)) {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    if (r.width <= 1 || r.height <= 1) continue;
    if (cs.visibility === 'hidden' || cs.pointerEvents === 'none' || visuallyHidden(e, cs)) continue;
    if (r.right <= 0 || r.left >= vw) continue;
    if (e.closest('[inert],[aria-hidden="true"]')) continue;
    if ((e as HTMLButtonElement).disabled || e.getAttribute('aria-disabled') === 'true') continue;
    if (isInlineTextLink(e)) continue;
    // A stretched card-open button (data-stretched-link) is only the card's background hit area:
    // the card's own controls sit on top of it (z-10), so it is not a neighbour that crowds them.
    if (e.hasAttribute('data-stretched-link')) continue;
    // A native checkbox/radio visually replaced by its label is not the target; its label is.
    if (e.tagName === 'INPUT' && /^(checkbox|radio)$/.test((e as HTMLInputElement).type) && Number(cs.opacity) === 0) continue;
    targets.push({ e, r, small: r.width < 24 || r.height < 24, inScope: inScope(e) });
  }
  // WCAG 2.5.8 spacing exception (rubric TOUCH-01): an undersized target passes when a 24 px
  // circle on its centre meets no other target and no other undersized target's circle.
  const centre = (r: DOMRect) => [r.left + r.width / 2, r.top + r.height / 2] as const;
  const spaced = (t: (typeof targets)[number]) => {
    const [cx, cy] = centre(t.r);
    for (const o of targets) {
      if (o === t || o.e.contains(t.e) || t.e.contains(o.e)) continue;
      if (o.small) {
        const [ox, oy] = centre(o.r);
        if (Math.hypot(cx - ox, cy - oy) < 24) return false;
      } else {
        const dx = Math.max(o.r.left - cx, 0, cx - o.r.right);
        const dy = Math.max(o.r.top - cy, 0, cy - o.r.bottom);
        if (Math.hypot(dx, dy) < 12) return false;
      }
    }
    return true;
  };
  // Rubric TOUCH-02 counts a checkbox, radio or switch together with its label.
  const withLabel = (e: Element, r: DOMRect) => {
    if (!/^(checkbox|radio|switch)$/.test(e.getAttribute('role') || (e as HTMLInputElement).type || '')) return r;
    const lab = e.closest('label') || (e.id ? document.querySelector(`label[for="${CSS.escape(e.id)}"]`) : null);
    if (!lab) return r;
    const l = lab.getBoundingClientRect();
    return new DOMRect(Math.min(r.left, l.left), Math.min(r.top, l.top), Math.max(r.right, l.right) - Math.min(r.left, l.left), Math.max(r.bottom, l.bottom) - Math.min(r.top, l.top));
  };
  // Options and menu items inside the top bar's own popups are not top-bar icons.
  // The copilot pill (`topbar-pill`) is not one either: the AI copilot is out of scope for the
  // mobile programme (no slice may change it), so its 32 px pill is left to whoever revives the
  // copilot. It is still measured by the 24 px check above (slice 25).
  const isPrimary = (e: Element) =>
    e.matches(primary) &&
    !e.matches('[data-slot="topbar-pill"]') &&
    !(e.closest('[data-slot="topbar"]') && e.closest('[role=listbox],[role=menu],[role=dialog]') && !e.matches('[data-touch-primary]'));
  const offenders: string[] = [];
  // For each offender, the Schedule time-grid event card it is or sits inside (-1: none). Only the
  // Schedule's accepted exception reads it (schedule-double-booked.ts); the selector is passed in
  // because this function runs in the page and cannot see that module.
  const offenderCard: number[] = [];
  const cardEls = opts.cardSelector ? [...document.querySelectorAll(opts.cardSelector)] : [];
  const cardOf = (e: Element) => { const c = opts.cardSelector ? e.closest(opts.cardSelector) : null; return c ? cardEls.indexOf(c) : -1; };
  let total = 0;
  for (const t of targets) {
    if (!t.inScope) continue;
    total++;
    const w = Math.round(t.r.width), h = Math.round(t.r.height);
    const label = `${t.e.tagName.toLowerCase()}${t.e.getAttribute('role') ? `[role=${t.e.getAttribute('role')}]` : ''} "${name(t.e)}" ${w}x${h}`;
    if (t.small && !spaced(t)) { offenders.push(`under 24px and crowded: ${label}`); offenderCard.push(cardOf(t.e)); }
    if (opts.touch && isPrimary(t.e)) {
      const u = withLabel(t.e, t.r);
      // 0.5 px of tolerance: the layout engine lands a 44 px box on 43.99997 at some widths.
      if (u.width < 43.5 || u.height < 43.5) { offenders.push(`primary touch control under 44px: ${label}`); offenderCard.push(cardOf(t.e)); }
    }
  }
  // Rubric TOUCH-02's spacing half (A2 `tooClose`, slice 25): on touch, two targets that are
  // both under 44 px should keep 8 px between them. Measured and kept in the record, not
  // asserted yet: app-wide it still counts every pair of small text controls, which later
  // slices' area passes own. Slice 75 decides when it enforces.
  const tooClose: string[] = [];
  if (opts.touch) {
    const sub44 = targets.filter((t) => t.inScope && (t.r.width < 43.5 || t.r.height < 43.5) && !isInlineTextLink(t.e));
    for (let i = 0; i < sub44.length; i++) {
      for (let j = i + 1; j < sub44.length; j++) {
        const a = sub44[i]!, b = sub44[j]!;
        if (a.e.contains(b.e) || b.e.contains(a.e)) continue;
        const dx = Math.max(0, Math.max(a.r.left, b.r.left) - Math.min(a.r.right, b.r.right));
        const dy = Math.max(0, Math.max(a.r.top, b.r.top) - Math.min(a.r.bottom, b.r.bottom));
        if (Math.max(dx, dy) < 8) tooClose.push(`"${name(a.e)}" ~ "${name(b.e)}"`);
      }
    }
  }
  return { offenders, offenderCard, info: { measuredTargets: total, ...(opts.touch ? { tooCloseCount: tooClose.length, tooClose: tooClose.slice(0, 20) } : {}) } };
}

// ── check 3: text inputs at least 16 px on touch projects ───────────────────────────────────────
export function inputFontCheck(opts: { onlyInOverlays?: boolean; sizesOnly?: boolean } = {}): CheckResult {
  const inScope = (el: Element) => !opts.onlyInOverlays || !!el.closest('[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[data-radix-popper-content-wrapper],[cmdk-root],aside[data-drawer="open"]');
  // Context, never asserted: the computed text size of every visible text-entry control, select
  // trigger and combobox, in document order. Recorded on every device, so a slice that changes
  // text-entry sizes can diff the desktop control's sizes against a run on staging (slice 14).
  const sizes: string[] = [];
  const controls = document.querySelectorAll(
    'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=color]):not([type=submit]):not([type=button]):not([type=reset]),textarea,select,[contenteditable=""],[contenteditable="true"],[role=combobox],[data-slot="select-trigger"]',
  );
  controls.forEach((e) => {
    const r = e.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return;
    if (e.closest('[inert],[aria-hidden="true"]') || !inScope(e)) return;
    const el = e as HTMLInputElement;
    const label = (el.name || el.id || el.placeholder || e.getAttribute('aria-label') || (e.textContent || '').trim()).slice(0, 30);
    sizes.push(`${e.tagName.toLowerCase()}${e.getAttribute('role') ? `[${e.getAttribute('role')}]` : ''} "${label}" ${getComputedStyle(e).fontSize}`);
  });
  if (opts.sizesOnly) return { offenders: [], notApplicable: true, info: { sizes } };
  const fields = [
    ...document.querySelectorAll(
      'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=color]):not([type=submit]):not([type=button]):not([type=reset]),textarea,select,[contenteditable=""],[contenteditable="true"]',
    ),
  ];
  const offenders: string[] = [];
  for (const e of fields) {
    const r = e.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue;
    if (e.closest('[inert],[aria-hidden="true"]') || !inScope(e)) continue;
    const px = parseFloat(getComputedStyle(e).fontSize);
    if (px >= 16) continue;
    const el = e as HTMLInputElement;
    const label = (el.name || el.id || el.placeholder || e.getAttribute('aria-label') || '').slice(0, 30);
    offenders.push(`${e.tagName.toLowerCase()} "${label}" text is ${px}px`);
  }
  return { offenders, info: { sizes } };
}

// ── check 4: open overlays inside the viewport, last item reachable ─────────────────────────────
export async function overlaysCheck(): Promise<CheckResult> {
  const vw = innerWidth, vh = innerHeight;
  const sel = '[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[data-radix-popper-content-wrapper],[cmdk-root],aside[data-drawer="open"]';
  const sig = (e: Element) => (e.getAttribute('role') || e.tagName.toLowerCase()) + (e.getAttribute('aria-label') ? `[${e.getAttribute('aria-label')}]` : '');
  const visible = (e: Element) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05 && e.getAttribute('data-state') !== 'closed';
  };
  const overlays = [...document.querySelectorAll(sel)].filter(visible);
  const offenders: string[] = [];
  const frame = () => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
  const items = 'button,a[href],input:not([type=hidden]),select,textarea,[role=option],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=tab]';
  for (const o of overlays) {
    // A popper wrapper around a menu/listbox is the same overlay; check the inner one only.
    if (o.hasAttribute('data-radix-popper-content-wrapper') && o.querySelector('[role=menu],[role=listbox],[role=dialog]')) continue;
    const r = o.getBoundingClientRect();
    if (r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1) {
      offenders.push(`${sig(o)} outside the viewport: [${Math.round(r.left)},${Math.round(r.top)} .. ${Math.round(r.right)},${Math.round(r.bottom)}] in ${vw}x${vh}`);
    }
    // Every vertical scroller in the overlay goes to its end, as a person scrolls whichever list they are in (a facet
    // list beside a value pane has two). Scrolling only the first one found called the other list's last item unreachable.
    const scrollers = [o, ...o.querySelectorAll('*')].filter((e) => /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1);
    const before = scrollers.map((s) => s.scrollTop);
    for (const s of scrollers) s.scrollTop = s.scrollHeight;
    if (scrollers.length) await frame();
    const candidates = [...o.querySelectorAll(items)].filter((e) => {
      const b = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return b.width > 1 && b.height > 1 && cs.visibility !== 'hidden' && cs.pointerEvents !== 'none' && !(e as HTMLButtonElement).disabled && e.getAttribute('aria-disabled') !== 'true';
    });
    // The lowest item once the overlay's own scroller is at its end.
    let last: Element | undefined;
    for (const e of candidates) if (!last || e.getBoundingClientRect().bottom >= last.getBoundingClientRect().bottom) last = e;
    if (last) {
      const b = last.getBoundingClientRect();
      const cx = Math.min(vw - 1, Math.max(0, b.left + b.width / 2)), cy = Math.min(vh - 1, Math.max(0, b.top + b.height / 2));
      const hit = document.elementFromPoint(cx, cy);
      const inView = b.top >= -1 && b.bottom <= vh + 1 && b.left >= -1 && b.right <= vw + 1;
      if (!inView || !hit || !(hit === last || last.contains(hit))) {
        const lname = (last.getAttribute('aria-label') || (last as HTMLElement).innerText || last.tagName).trim().slice(0, 30);
        offenders.push(`${sig(o)} last item "${lname}" not reachable${inView ? '' : ` (at ${Math.round(b.top)}..${Math.round(b.bottom)})`}${hit && !inView ? '' : hit && !(hit === last || last.contains(hit)) ? ` (covered by ${hit.tagName.toLowerCase()})` : ''}`);
      }
    }
    scrollers.forEach((s, i) => { s.scrollTop = before[i]; });
  }
  return { offenders, info: { openOverlays: overlays.map(sig) } };
}

// ── check 5: the main scroller reaches its last interactive element ─────────────────────────────
export async function scrollReachCheck(cardSelector?: string): Promise<CheckResult> {
  const isY = (el: Element) => { const s = getComputedStyle(el); return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1; };
  const sig = (el: Element) => el.tagName.toLowerCase() + (el.classList.length ? `.${[...el.classList].slice(0, 3).join('.')}` : '');
  const frame = () => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
  // Fonts first: a web font arriving late changes the width of a select or a column, and with it which
  // control sits past a scroll box's edge (the users table on a tablet failed this on a slow, loaded run).
  await document.fonts?.ready;
  await frame();
  const main = document.querySelector('main');
  let sc: Element | null = main && isY(main) ? main : null;
  if (!sc) {
    const c = [...document.querySelectorAll('body *')].filter(isY).filter((e) => e.getBoundingClientRect().width > innerWidth * 0.5 && !e.closest('[role=dialog],[role=menu],[role=listbox]'))
      .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
    sc = c[0] || null;
  }
  const root: Element = sc || main || document.body;
  // A control whose centre sits past the edge of a sideways scroll box narrower than its content: out of
  // view sideways, which is the overflow check's business (mobile slice 29: the users table's Team
  // column). Asked twice: when the candidates are picked, and again when the last one is judged,
  // because a late layout (fonts, a select's width) can move its centre past the edge in between.
  const clippedSideways = (e: Element, stop: Element) => {
    const r = e.getBoundingClientRect();
    const cx0 = r.left + r.width / 2;
    for (let a = e.parentElement; a && a !== stop; a = a.parentElement) {
      if (!/(auto|scroll|hidden|clip)/.test(getComputedStyle(a).overflowX) || a.scrollWidth <= a.clientWidth + 1) continue;
      const ab = a.getBoundingClientRect();
      if (cx0 < ab.left || cx0 > ab.right) return true;
    }
    return false;
  };
  // The LAST interactive element is the one lowest in the scrolled content (not the last in DOM
  // order: a pager rendered after a list can sit above it). Disabled controls are not interactive.
  const contentBottom = (r: DOMRect) => (sc ? r.bottom - sc.getBoundingClientRect().top + sc.scrollTop : r.bottom + window.scrollY);
  const candidates = [...root.querySelectorAll('button,a[href],input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=checkbox],[role=switch],[role=tab]')]
    .filter((e) => {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      if (r.width <= 1 || r.height <= 1 || cs.visibility === 'hidden' || cs.pointerEvents === 'none') return false;
      if ((e as HTMLButtonElement).disabled || e.getAttribute('aria-disabled') === 'true') return false;
      if (e.closest('[inert],[aria-hidden="true"]')) return false;
      // Sideways out of view (a wide table's far column) is the overflow check's business.
      if (r.right <= 0 || r.left >= innerWidth) return false;
      // The same far column inside a sideways scroll box narrower than the screen: its centre is
      // clipped by the box, so it is out of view sideways too (mobile slice 29: the users table on
      // the landscape phone, whose Team column sits past the box's right edge).
      if (clippedSideways(e, root)) return false;
      // Fixed/sticky chrome is always on screen; the question is about the scrolled content.
      let p: Element | null = e;
      while (p && p !== root) { const pos = getComputedStyle(p).position; if (pos === 'fixed' || pos === 'sticky') return false; p = p.parentElement; }
      return true;
    })
    // Slice 75: a control inside a list that scrolls in a bounded box of its own (a thread list
    // beside its composer) is reached by scrolling THAT box, not the page. The question for such
    // a control is whether the box can be seen, so the box stands in for it. A box that runs past
    // the screen still fails, as the control inside it would.
    .map((e) => {
      let target: Element = e;
      for (let a = e.parentElement; a && a !== root; a = a.parentElement) if (isY(a)) target = a;
      return { e: target, b: contentBottom(target.getBoundingClientRect()) };
    });
  let last: Element | undefined;
  let lowest = -Infinity;
  for (const c of candidates) if (c.b >= lowest) { lowest = c.b; last = c.e; }
  // Scroll THE scroller (only it: moving the document too would shift a bounded scroller by
  // however far the document overflows) as far as it takes to bring the last control into its
  // box, the way a user would. Text below the last control may stay out of view; that is fine.
  // If the scroller cannot go that far, or its box runs past the screen, the control stays off
  // screen and the check fails.
  if (sc) sc.scrollTop = Math.min(sc.scrollHeight - sc.clientHeight, Math.max(0, lowest - sc.clientHeight + 8));
  else window.scrollTo(0, Math.max(0, lowest - innerHeight + 8));
  await frame();
  await new Promise((ok) => setTimeout(ok, 250));
  const info: Record<string, unknown> = { scroller: sc ? sig(sc) : 'document' };
  // Which Schedule time-grid event cards the last control and its cover are (-1: not a card), for the
  // Schedule's accepted exception only (schedule-double-booked.ts). Passed in: this runs in the page.
  const cardEls = cardSelector ? [...document.querySelectorAll(cardSelector)] : [];
  const cardOf = (e: Element | null) => { const c = e && cardSelector ? e.closest(cardSelector) : null; return c ? cardEls.indexOf(c) : -1; };
  const coverOf: { v?: { last: number; hit: number } } = {};
  const judge = (): string[] => {
    coverOf.v = undefined;
    if (!last) return [];
    if (clippedSideways(last, root)) return [];
    const r = last.getBoundingClientRect();
    // A user taps the part of the control they can see. Inside a box that clips (a sideways scroll
    // box, a card with rounded overflow) that is the control's rect cut to every clipping ancestor's
    // content box, so the point judged is the centre of THAT part: the raw centre of a select
    // whose right half runs past the box edge sits on the box's border or padding and hit-tests as the
    // box (the users table on a tablet, flaky by a few pixels), though the control is plainly tappable.
    let vl = r.left, vr = r.right, vt = r.top, vb = r.bottom;
    for (let a = last.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      const clipsX = /(auto|scroll|hidden|clip)/.test(cs.overflowX), clipsY = /(auto|scroll|hidden|clip)/.test(cs.overflowY);
      if (!clipsX && !clipsY) continue;
      const ab = a.getBoundingClientRect();
      if (clipsX) { vl = Math.max(vl, ab.left + a.clientLeft); vr = Math.min(vr, ab.left + a.clientLeft + a.clientWidth); }
      if (clipsY && a !== root) { vt = Math.max(vt, ab.top + a.clientTop); vb = Math.min(vb, ab.top + a.clientTop + a.clientHeight); }
    }
    const vcx = vr > vl ? (vl + vr) / 2 : r.left + r.width / 2;
    const vcy = vb > vt ? (vt + vb) / 2 : r.top + r.height / 2;
    const cx = Math.min(innerWidth - 1, Math.max(0, vcx)), cy = Math.min(innerHeight - 1, Math.max(0, vcy));
    const hit = document.elementFromPoint(cx, cy);
    const inView = r.bottom <= innerHeight + 1 && r.top >= -1 && r.left < innerWidth && r.right > 0;
    const topmost = !!hit && (hit === last || last.contains(hit) || (hit.tagName === 'LABEL' && (hit as HTMLLabelElement).control === last));
    const lname = (last.getAttribute('aria-label') || (last as HTMLElement).innerText || last.getAttribute('placeholder') || last.tagName).trim().replace(/\s+/g, ' ').slice(0, 30);
    info.last = lname;
    if (!inView) return [`last control "${lname}" stays off screen at the bottom of the scroller (${Math.round(r.top)}..${Math.round(r.bottom)} in ${innerHeight})`];
    if (!topmost) {
      coverOf.v = { last: cardOf(last), hit: cardOf(hit) };
      return [`last control "${lname}" is covered by ${hit ? sig(hit) : 'nothing hit-testable'}`];
    }
    return [];
  };
  let offenders = judge();
  // Slice 75: a user keeps scrolling to the END. The minimal scroll above leaves the control at
  // the very bottom of the box, which a fixed bottom bar covers; if the page has room to scroll
  // further (its bottom padding), the control is reachable once the scroller is at its end.
  if (offenders.length && sc && sc.scrollTop < sc.scrollHeight - sc.clientHeight - 1) {
    sc.scrollTop = sc.scrollHeight - sc.clientHeight;
    await frame();
    await new Promise((ok) => setTimeout(ok, 250));
    offenders = judge();
  }
  if (sc) sc.scrollTop = 0;
  else window.scrollTo(0, 0);
  info.documentScrollsToo = !!sc && document.documentElement.scrollHeight > innerHeight + 1;
  return { offenders, info, ...(offenders.length && coverOf.v ? { cover: coverOf.v } : {}) };
}

// ── check 6 (collection half): every text a user can see ───────────────────────────────────────
export function collectVisibleCopy(opts: { onlyInOverlays?: boolean } = {}): Array<{ source: string; text: string }> {
  const ovSel = '[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[data-radix-popper-content-wrapper],[cmdk-root],aside[data-drawer="open"]';
  const out: Array<{ source: string; text: string }> = [];
  if (opts.onlyInOverlays) {
    for (const o of document.querySelectorAll(ovSel)) out.push({ source: 'text', text: (o as HTMLElement).innerText });
  } else {
    out.push({ source: 'title', text: document.title });
    out.push({ source: 'text', text: document.body.innerText });
    // The host is the deployment's, not app copy; the path and query are what the app writes.
    out.push({ source: 'url', text: decodeURIComponent(location.pathname + location.search + location.hash) });
  }
  const attrs = ['aria-label', 'aria-description', 'aria-roledescription', 'aria-valuetext', 'title', 'alt', 'placeholder'];
  for (const el of document.querySelectorAll(attrs.map((a) => `[${a}]`).join(','))) {
    if (el.tagName === 'TITLE' || el.closest('svg title')) continue;
    if (opts.onlyInOverlays && !el.closest(ovSel)) continue;
    for (const a of attrs) {
      const v = el.getAttribute(a);
      if (v) out.push({ source: a === 'placeholder' ? 'placeholder' : `accessible name (${a})`, text: v });
    }
  }
  return out;
}

// ── check 8: no full-viewport backdrop blur on touch projects (PERF-06, mobile slice 16) ────────
/**
 * A scrim (or any layer) that covers the viewport and applies a backdrop blur. On a phone that
 * blur is recomputed over the whole screen every frame something moves under or over it (a sheet
 * dragging, a drawer sliding), for a frosted look a finger hides. Small blurred chips (a price-book
 * badge over a photo) are not scrims and are not counted. Runs on every state, so an open dialog,
 * sheet or the navigation drawer is measured on the overlay states.
 */
export function scrimBlurCheck(): CheckResult {
  const vw = innerWidth, vh = innerHeight;
  const sig = (el: Element) =>
    el.tagName.toLowerCase() + (el.classList.length ? `.${[...el.classList].slice(0, 4).join('.')}` : '');
  const offenders: string[] = [];
  let blurred = 0;
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    const filter = [cs.getPropertyValue('backdrop-filter'), cs.getPropertyValue('-webkit-backdrop-filter')].find((f) => f && f !== 'none') || '';
    if (!/blur\(/.test(filter)) continue;
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    blurred++;
    const r = el.getBoundingClientRect();
    if (r.width < vw * 0.9 || r.height < vh * 0.9) continue;
    offenders.push(`full-viewport backdrop blur: ${sig(el)} ${filter} [${Math.round(r.width)}x${Math.round(r.height)} in ${vw}x${vh}]`);
  }
  return { offenders, info: { blurredLayers: blurred } };
}

/**
 * Short-height chrome (mobile slice 34, VP-12): on a viewport at most 500 px tall (SHORT_HEIGHT_MAX in
 * breakpoints.js, written out here because this function runs in the page) the top bar is one
 * row, at most 56 px, and the chrome (the bar plus any fixed or sticky band across the screen)
 * covers at most 20% of the height. Not applicable on a taller viewport.
 */
export function chromeRatioCheck(): CheckResult {
  const h = innerHeight;
  if (h > 500) return { offenders: [], notApplicable: true };
  const bands: Array<[number, number]> = [];
  const names: string[] = [];
  const tb = document.querySelector('[data-slot="topbar"]');
  const tr = tb?.getBoundingClientRect();
  if (tr && tr.height > 0) bands.push([Math.max(0, tr.top), Math.min(h, tr.bottom)]);
  for (const e of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(e);
    const pos = cs.position;
    if (pos !== 'fixed' && pos !== 'sticky') continue;
    // A sticky element only holds a band of the screen if it sticks to the top or the bottom. One
    // that sticks sideways only (`left: 0`, a wide table's empty state) scrolls away like content.
    if (pos === 'sticky' && cs.top === 'auto' && cs.bottom === 'auto') continue;
    if (tb && (tb.contains(e) || e.contains(tb))) continue;
    const r = e.getBoundingClientRect();
    if (r.height > 0 && r.bottom > 0 && r.top < h && r.width > innerWidth * 0.5 && r.height < h * 0.9) {
      bands.push([Math.max(0, r.top), Math.min(h, r.bottom)]);
      names.push(`${e.tagName.toLowerCase()}${e.classList.length ? '.' + [...e.classList].slice(0, 3).join('.') : ''} ${Math.round(r.height)} px`);
    }
  }
  bands.sort((a, b) => a[0] - b[0]);
  let covered = 0, end = -1;
  for (const [t, b] of bands) { if (t > end) { covered += b - t; end = b; } else if (b > end) { covered += b - end; end = b; } }
  const ratio = +(covered / h).toFixed(3);
  const offenders: string[] = [];
  if (tr && tr.height > 56) offenders.push(`the top bar is ${Math.round(tr.height)} px tall in a ${h} px viewport (one row is at most 56 px)`);
  if (ratio > 0.2) offenders.push(`chrome covers ${Math.round(ratio * 100)}% of a ${h} px tall viewport (at most 20%): top bar ${tr ? Math.round(tr.height) : 0} px + ${names.slice(0, 4).join(', ') || 'no band'}`);
  return { offenders, info: { ratio, topbarPx: tr ? Math.round(tr.height) : 0 } };
}

// ── check: no list scroller inside a dialog's body scroller (slice 65, rubric SCR-02) ───────────
/**
 * On a phone a dialog is full-screen or a bottom sheet, and its BODY is the only scroller. A list
 * inside it that kept its own height cap and its own scrolling is a scroll trap: a finger on the
 * list scrolls the list, a finger beside it scrolls the body.
 *
 * Judged on the dialogs that state a phone presentation (`data-presentation` is fullscreen or
 * bottom-sheet): a card at md and up keeps its capped lists, as it always did. A scroller is an
 * element with a vertical `overflow` of auto or scroll that either overflows now or carries a
 * pixel `max-height` (a capped list that merely has few rows today is the same trap with more
 * rows). Text fields are not scrollers (a textarea is `overflow: auto` by default), and a wide
 * table's sideways scroll box is not one unless it also overflows vertically.
 */
export function dialogScrollersCheck(): CheckResult {
  const visible = (e: Element) => {
    const r = e.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && getComputedStyle(e).visibility !== 'hidden' && e.getAttribute('data-state') !== 'closed';
  };
  const sig = (e: Element) => e.tagName.toLowerCase() + (e.classList.length ? `.${[...e.classList].slice(0, 4).join('.')}` : '');
  const dialogs = [...document.querySelectorAll('[role=dialog][data-presentation], [role=alertdialog][data-presentation]')]
    .filter((d) => visible(d) && d.getAttribute('data-presentation') !== 'card');
  if (dialogs.length === 0) return { offenders: [], notApplicable: true };
  const offenders: string[] = [];
  for (const d of dialogs) {
    // An element that CAN scroll vertically (its overflow is auto or scroll), overflowing or not: the body.
    const canScroll = (e: Element) => {
      if (/^(textarea|input|select)$/i.test(e.tagName) || !visible(e)) return false;
      return /(auto|scroll)/.test(getComputedStyle(e).overflowY);
    };
    // One that IS a list scroller: it overflows now, or it carries a pixel cap (few rows today, many tomorrow).
    const isList = (e: Element) => canScroll(e) && (e.scrollHeight > e.clientHeight + 1 || /^\d/.test(getComputedStyle(e).maxHeight));
    for (const el of [...d.querySelectorAll('*')].filter(isList)) {
      let outer: Element | null = el.parentElement;
      while (outer && outer !== d && !canScroll(outer)) outer = outer.parentElement;
      if (outer && outer !== d) offenders.push(`${sig(el)} scrolls inside ${sig(outer)} in ${d.getAttribute('aria-label') || d.getAttribute('data-presentation')} dialog`);
    }
  }
  return { offenders, info: { dialogs: dialogs.length } };
}

// ── measured, not asserted: A5 chrome ratio, A6 sticky, A7 focus obscured, A8 orphan inputs ──────
export async function measuredOnly(): Promise<Record<string, unknown>> {
  const h = innerHeight;
  const fixed = [...document.querySelectorAll('body *')].filter((e) => { const p = getComputedStyle(e).position; return (p === 'fixed' || p === 'sticky') && e.getBoundingClientRect().height > 0; });
  const bands = fixed.map((e) => e.getBoundingClientRect()).filter((r) => r.bottom > 0 && r.top < h && r.width > innerWidth * 0.5 && r.height < h * 0.9).map((r) => [Math.max(0, r.top), Math.min(h, r.bottom)] as [number, number]).sort((a, b) => a[0] - b[0]);
  let covered = 0, end = -1;
  for (const [t, b] of bands) { if (t > end) { covered += b - t; end = b; } else if (b > end) { covered += b - end; end = b; } }
  const tb = document.querySelector('[data-slot="topbar"], header');
  const chrome = { ratio: +(covered / h).toFixed(2), topbarPx: tb ? Math.round(tb.getBoundingClientRect().height) : 0 };

  const sticky: Array<{ el: string; moved: number }> = [];
  for (const el of [...document.querySelectorAll('body *')].filter((e) => getComputedStyle(e).position === 'sticky').slice(0, 30)) {
    let p = el.parentElement;
    while (p && !/(auto|scroll)/.test(getComputedStyle(p).overflowY)) p = p.parentElement;
    if (!p || p.scrollHeight <= p.clientHeight + 300) continue;
    const before = el.getBoundingClientRect().top;
    p.scrollTop += 300;
    await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
    const after = el.getBoundingClientRect().top;
    p.scrollTop -= 300;
    if (Math.abs(before - after) > 50) sticky.push({ el: el.tagName.toLowerCase() + '.' + [...el.classList].slice(0, 3).join('.'), moved: Math.round(before - after) });
  }

  const fields = [...document.querySelectorAll('main input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]), main textarea, main select, [role=dialog] input:not([type=hidden]), [role=dialog] textarea')]
    .filter((e) => e.getBoundingClientRect().width > 0).slice(0, 12) as HTMLElement[];
  const focusObscured: string[] = [];
  for (const f of fields) {
    f.focus({ preventScroll: true });
    f.scrollIntoView({ block: 'nearest' });
    await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
    const fr = f.getBoundingClientRect();
    const name = ((f as HTMLInputElement).name || f.id || (f as HTMLInputElement).placeholder || f.getAttribute('aria-label') || '').slice(0, 30);
    if (fr.bottom > innerHeight || fr.top < 0) { focusObscured.push(`${name}: outside viewport`); continue; }
    for (const o of fixed) {
      if (o.contains(f)) continue;
      const or = o.getBoundingClientRect();
      const ix = Math.max(0, Math.min(fr.right, or.right) - Math.max(fr.left, or.left));
      const iy = Math.max(0, Math.min(fr.bottom, or.bottom) - Math.max(fr.top, or.top));
      if (ix && iy) { focusObscured.push(`${name}: under ${o.tagName.toLowerCase()}`); break; }
    }
  }
  (document.activeElement as HTMLElement | null)?.blur?.();

  const orphanInputs = [...document.querySelectorAll('input:not([type=hidden]), select, textarea')]
    .filter((i) => i.getBoundingClientRect().width > 0)
    .filter((i) => !(i.id && document.querySelector(`label[for="${CSS.escape(i.id)}"]`)) && !i.getAttribute('aria-label') && !i.getAttribute('aria-labelledby') && !i.closest('label'))
    .map((i) => `${i.tagName.toLowerCase()} ${(i as HTMLInputElement).name || (i as HTMLInputElement).placeholder || ''}`.trim()).slice(0, 10);

  return { chrome, stickyBroken: sticky, focusObscured: focusObscured.slice(0, 10), orphanInputs };
}

/**
 * Where every Schedule time-grid event card sits (schedule-double-booked.ts): its day column and its
 * vertical extent. The list is in `document.querySelectorAll(cardSelector)` order, the same order the
 * `offenderCard` / `cover` indexes use. Empty on any page without a calendar. `selectors` (axe node
 * targets) are resolved to the card each is or sits inside, -1 when none.
 */
export function scheduleCardProbe(o: { cardSelector: string; columnSelector: string; selectors?: string[] }): { cards: CardFact[]; ofSelector: number[] } {
  const els = [...document.querySelectorAll(o.cardSelector)];
  const columns = [...document.querySelectorAll(o.columnSelector)];
  const cards = els.map((e) => {
    const r = e.getBoundingClientRect();
    return { column: columns.indexOf(e.closest(o.columnSelector) as Element), top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  });
  const ofSelector = (o.selectors ?? []).map((sel) => {
    let el: Element | null = null;
    try { el = document.querySelector(sel); } catch { /* a selector the browser cannot parse */ }
    const c = el ? el.closest(o.cardSelector) : null;
    return c ? els.indexOf(c) : -1;
  });
  return { cards, ofSelector };
}

/** Run one check in the page. Touch-only checks report notApplicable on the desktop control. */
export async function runCheck(
  page: Page,
  check: Exclude<CheckName, 'vendorTerms' | 'vendorConsole' | 'a11y'>,
  o: { touch: boolean; onlyInOverlays: boolean },
): Promise<CheckResult> {
  const scope = { onlyInOverlays: o.onlyInOverlays };
  switch (check) {
    case 'overflow':
      return page.evaluate(overflowCheck, { ...scope, intended: [...INTENDED_X_SCROLLERS], adminTables: [...ADMIN_SCROLL_TABLES] });
    case 'topbarOverflow':
      // On an overlay state too: an open menu or sheet must not push the bar apart either.
      return page.evaluate(topbarOverflowCheck);
    case 'targets':
      return page.evaluate(targetsCheck, { touch: o.touch, primary: PRIMARY_TOUCH_SELECTORS, cardSelector: SCHEDULE_CARD_SELECTOR, ...scope });
    case 'inputFont':
      return page.evaluate(inputFontCheck, o.touch ? scope : { ...scope, sizesOnly: true });
    case 'overlays':
      return page.evaluate(overlaysCheck);
    case 'scrollReach':
      // On an overlay state the overlay check owns reachability; the page under it was measured
      // by its own route state.
      return o.onlyInOverlays ? { offenders: [], notApplicable: true } : page.evaluate(scrollReachCheck, SCHEDULE_CARD_SELECTOR);
    case 'chromeRatio':
      // An open overlay is not chrome; the page under it was measured by its own route state.
      return o.onlyInOverlays ? { offenders: [], notApplicable: true } : page.evaluate(chromeRatioCheck);
    case 'dialogScrollers':
      // Every state: a page state has no dialog and is not applicable; an overlay state is judged
      // on the dialog it opened (a card keeps its capped lists, so only the phone presentations count).
      return page.evaluate(dialogScrollersCheck);
    case 'scrimBlur':
      // The desktop control keeps its frosted scrims; the rule is for touch screens.
      return o.touch ? page.evaluate(scrimBlurCheck) : { offenders: [], notApplicable: true };
  }
}
