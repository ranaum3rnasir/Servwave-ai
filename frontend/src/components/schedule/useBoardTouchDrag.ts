/**
 * The dispatch board's touch-drag adapter (mobile slice 58, TOUCH-09).
 *
 * The member board's cards (the day grid's `JobCard`, the week board's `BoardCard`) are native
 * HTML5 drag sources and its hour slots and day cells are native drop targets. A finger never
 * starts a native drag reliably (the platform's own lift gesture is not available in every
 * browser, and the scheduler cannot rely on it), so on a touch screen the card could not be moved.
 *
 * This adapter is a bridge, not a second drag-and-drop. It gives a card the same gesture as the
 * calendar's events and the task board: rest a finger for TOUCH_DRAG_HOLD_MS and the card is
 * picked up; move before then and it is a swipe, so the board scrolls. A picked-up card is then
 * carried with a floating copy, and the finger plays the part of the mouse: the same
 * `dragstart`, `dragenter`, `dragover`, `dragleave`, `drop` and `dragend` events a native drag
 * would fire are dispatched, carrying a real `DataTransfer`, at the element under the finger. The
 * card's own `onDragStart` fills the payload and the slots' and cells' own handlers decide what a
 * drop means, so there is exactly one set of drop rules, the one the mouse already uses, and
 * nothing here knows what a job, a walkthrough or a lane is.
 *
 * Details that matter:
 *  - the native drop rule is kept: `drop` only fires on a target whose `dragover` was cancelled;
 *  - the board scrolls itself while a card is held near its edge, so a far slot can be reached;
 *  - a swipe, a tap and a card dropped nowhere leave everything as it was (no click follows a drag);
 *  - if the browser starts its own native drag (it fires a trusted `dragstart`), or cancels the
 *    touch, this adapter lets go and the native drag carries on;
 *  - the platform's long-press context menu is suppressed while a touch is held on a card;
 *  - mouse and trackpad users never touch this code: it only listens to touch events.
 *
 * Not used by the unscheduled buckets: their touch path is the tap sheet (slice 70).
 */
import { useEffect, type RefObject } from 'react';
import { TOUCH_DRAG_HOLD_MS, TOUCH_DRAG_TOLERANCE_PX } from './touchDragTiming';

/** Distance from a scroller's edge, in px, inside which a held card scrolls it. */
const EDGE_PX = 56;
/** The fastest the board scrolls itself, px per frame. */
const MAX_SCROLL_STEP = 14;

type DragType = 'dragstart' | 'dragenter' | 'dragover' | 'dragleave' | 'drop' | 'dragend';

/** Whether this browser can carry a drag payload for a page: no constructor, no bridge. */
function canBridge(): boolean {
  return typeof DataTransfer === 'function' && typeof DragEvent === 'function';
}

function fire(target: Element, type: DragType, dt: DataTransfer, x: number, y: number, related: Element | null = null): DragEvent {
  const ev = new DragEvent(type, {
    bubbles: true,
    cancelable: type !== 'dragleave' && type !== 'dragend',
    composed: true,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    relatedTarget: related,
    dataTransfer: dt,
  });
  // An engine that ignores `dataTransfer` in the constructor still has to deliver the payload.
  if (ev.dataTransfer !== dt) Object.defineProperty(ev, 'dataTransfer', { value: dt });
  target.dispatchEvent(ev);
  return ev;
}

/** The nearest ancestors that scroll on each axis. */
function scrollParents(el: Element): { y: HTMLElement | null; x: HTMLElement | null } {
  let y: HTMLElement | null = null;
  let x: HTMLElement | null = null;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (!y && /(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1) y = p;
    if (!x && /(auto|scroll)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1) x = p;
    if (x && y) break;
  }
  return { y, x };
}

/** How far to scroll for a finger at `pos` in the band `[lo, hi]`: 0 away from the edges. */
function edgeStep(pos: number, lo: number, hi: number): number {
  if (pos < lo + EDGE_PX) return -Math.ceil(MAX_SCROLL_STEP * Math.min(1, (lo + EDGE_PX - pos) / EDGE_PX));
  if (pos > hi - EDGE_PX) return Math.ceil(MAX_SCROLL_STEP * Math.min(1, (pos - (hi - EDGE_PX)) / EDGE_PX));
  return 0;
}

export function useBoardTouchDrag(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !canBridge()) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let touchId: number | null = null;
    let start = { x: 0, y: 0 };
    let at = { x: 0, y: 0 };
    let held = false; // touch down, press not yet long enough
    let swallowClickUntil = 0;
    let drag: {
      dt: DataTransfer;
      preview: HTMLElement;
      grab: { x: number; y: number };
      hover: Element | null;
      droppable: boolean;
      frame: number;
      scroll: { y: HTMLElement | null; x: HTMLElement | null };
      restoreOpacity: string;
    } | null = null;
    /** Our own dispatched `dragstart` is not the browser starting a native drag. */
    let dispatching = false;

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const hit = (x: number, y: number): Element | null => document.elementFromPoint(x, y);

    /** Re-evaluate what is under the finger: enter/leave, then a dragover (the native cadence). */
    const update = () => {
      if (!drag) return;
      const { x, y } = at;
      const over = hit(x, y);
      if (over !== drag.hover) {
        if (drag.hover) fire(drag.hover, 'dragleave', drag.dt, x, y, over);
        if (over) fire(over, 'dragenter', drag.dt, x, y, drag.hover);
        drag.hover = over;
      }
      drag.droppable = false;
      if (over) drag.droppable = fire(over, 'dragover', drag.dt, x, y).defaultPrevented;
    };

    const tick = () => {
      if (!drag) return;
      const { x, y } = at;
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      if (drag.scroll.y) {
        const r = drag.scroll.y.getBoundingClientRect();
        drag.scroll.y.scrollTop += edgeStep(y, Math.max(r.top, 0), Math.min(r.bottom, vh));
      }
      if (drag.scroll.x) {
        const r = drag.scroll.x.getBoundingClientRect();
        drag.scroll.x.scrollLeft += edgeStep(x, Math.max(r.left, 0), Math.min(r.right, vw));
      }
      update();
      drag.frame = requestAnimationFrame(tick);
    };

    const movePreview = () => {
      if (!drag) return;
      drag.preview.style.transform = `translate3d(${at.x - drag.grab.x}px, ${at.y - drag.grab.y}px, 0)`;
    };

    /** Put everything back the way it was; `drop` is whether to deliver a drop first. */
    const finish = (drop: boolean) => {
      clearTimer();
      held = false;
      touchId = null;
      if (!drag) return;
      const d = drag;
      drag = null;
      cancelAnimationFrame(d.frame);
      const { x, y } = at;
      if (drop && d.droppable && d.hover) {
        fire(d.hover, 'drop', d.dt, x, y);
      } else if (d.hover) {
        fire(d.hover, 'dragleave', d.dt, x, y, null);
      }
      dispatching = true;
      try {
        fire(el, 'dragend', d.dt, x, y);
      } finally {
        dispatching = false;
      }
      d.preview.remove();
      el.style.opacity = d.restoreOpacity;
    };

    const activate = () => {
      timer = null;
      if (!held) return;
      held = false;
      const rect = el.getBoundingClientRect();
      const dt = new DataTransfer();
      dispatching = true;
      try {
        fire(el, 'dragstart', dt, at.x, at.y); // the card's own onDragStart writes the payload
      } finally {
        dispatching = false;
      }
      const preview = el.cloneNode(true) as HTMLElement;
      preview.removeAttribute('data-board-id');
      preview.removeAttribute('draggable');
      preview.removeAttribute('id');
      preview.setAttribute('aria-hidden', 'true');
      preview.setAttribute('data-touch-drag-preview', '');
      Object.assign(preview.style, {
        position: 'fixed',
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        margin: '0',
        inset: 'auto',
        right: 'auto',
        bottom: 'auto',
        pointerEvents: 'none',
        zIndex: '2147483000',
        opacity: '0.92',
        boxShadow: '0 12px 28px rgba(0,0,0,0.28)',
        transition: 'none',
        willChange: 'transform',
      });
      document.body.appendChild(preview);
      drag = {
        dt,
        preview,
        grab: { x: start.x, y: start.y },
        hover: null,
        droppable: false,
        frame: 0,
        scroll: scrollParents(el),
        restoreOpacity: el.style.opacity,
      };
      el.style.opacity = '0.35';
      try { navigator.vibrate?.(8); } catch { /* not every engine has it */ }
      movePreview();
      update();
      drag.frame = requestAnimationFrame(tick);
    };

    const ours = (e: TouchEvent): Touch | undefined =>
      touchId === null ? undefined : Array.from(e.touches).find((t) => t.identifier === touchId)
        ?? Array.from(e.changedTouches).find((t) => t.identifier === touchId);

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        // A second finger is a gesture of its own (pinch, scroll): let go.
        clearTimer();
        held = false;
        if (drag) finish(false);
        return;
      }
      const t = e.touches[0]!;
      touchId = t.identifier;
      start = { x: t.clientX, y: t.clientY };
      at = start;
      held = true;
      clearTimer();
      timer = setTimeout(activate, TOUCH_DRAG_HOLD_MS);
    };

    const onMove = (e: TouchEvent) => {
      const t = ours(e);
      if (!t) return;
      at = { x: t.clientX, y: t.clientY };
      if (held) {
        // Drifting within the tolerance is a resting finger; further is a swipe, and it scrolls.
        if (Math.hypot(at.x - start.x, at.y - start.y) > TOUCH_DRAG_TOLERANCE_PX) {
          clearTimer();
          held = false;
          touchId = null;
        }
        return;
      }
      if (!drag) return;
      if (e.cancelable) e.preventDefault(); // the finger carries the card; the board does not pan
      movePreview();
      update();
    };

    const onEnd = (e: TouchEvent) => {
      if (touchId === null) return;
      const t = ours(e);
      if (t) at = { x: t.clientX, y: t.clientY };
      const carried = !!drag;
      if (carried) {
        swallowClickUntil = Date.now() + 500; // a drop is not a tap
        if (e.cancelable) e.preventDefault();
      }
      finish(carried && e.type === 'touchend');
    };

    /** The browser started its own native drag: it owns the gesture now. */
    const onNativeDragStart = (e: Event) => {
      if (dispatching || !e.isTrusted) return;
      clearTimer();
      held = false;
      if (drag) {
        const d = drag;
        drag = null;
        cancelAnimationFrame(d.frame);
        d.preview.remove();
        el.style.opacity = d.restoreOpacity;
        }
      touchId = null;
    };

    /** A long-press must not also open the platform's context menu on a card. */
    const onContextMenu = (e: Event) => {
      if (held || drag || Date.now() < swallowClickUntil) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    const onClick = (e: Event) => {
      if (Date.now() < swallowClickUntil) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: false });
    el.addEventListener('touchcancel', onEnd);
    el.addEventListener('dragstart', onNativeDragStart);
    el.addEventListener('contextmenu', onContextMenu, true);
    el.addEventListener('click', onClick, true);
    return () => {
      clearTimer();
      if (drag) {
        cancelAnimationFrame(drag.frame);
        drag.preview.remove();
        el.style.opacity = drag.restoreOpacity;
        drag = null;
      }
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
      el.removeEventListener('dragstart', onNativeDragStart);
      el.removeEventListener('contextmenu', onContextMenu, true);
      el.removeEventListener('click', onClick, true);
    };
  }, [ref]);
}
