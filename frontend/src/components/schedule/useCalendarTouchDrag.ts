/**
 * The standard calendar's touch-drag adapter (mobile slice 58, TOUCH-09 / TOUCH-06).
 *
 * WHY IT EXISTS. react-big-calendar's drag add-on already knows how to drag from a finger: its
 * selection engine waits for a stationary 250 ms press (`longPressThreshold`), takes over the
 * touch stream, and the add-on's event wrapper begins a move on `touchstart`. The one thing that
 * never happens is that begin. The wrapper's handler is shared by the mouse and the touch
 * listeners and opens with `if (e.button !== 0) return;`; a TouchEvent has no `button`, so
 * `undefined !== 0` is true and every touch is refused before the add-on knows an event was
 * touched. (react-big-calendar 1.20.0, addons/dragAndDrop/EventWrapper.js, handleStartDragging.)
 *
 * THE FIX SITS HERE, at the scheduler's drag-adapter boundary, not in the library: on a
 * `touchstart` on a draggable event this hands the add-on the begin it should have received, the
 * same call the mouse path makes. Everything after that is the library's own: the 250 ms
 * long-press, the move, the drop and `onEventDrop`. The scheduler page knows nothing about
 * pointers; it passes the calendar ref, its container and an event lookup, and gets no callbacks.
 *
 * A SECOND LIBRARY QUIRK THE ADAPTER ABSORBS. When the library's preview appears (the moment the
 * press has been held 250 ms) it re-renders the day column's events as a new child structure, so
 * React unmounts and re-creates every event element, including the one under the finger. A touch
 * keeps its original target for the whole gesture, and that node is now detached: its later
 * touchmoves never reach `document` (where the library listens), the browser, with nothing
 * cancelling the move, starts to pan and cancels the touch (`pointercancel`), and the drag dies
 * after the preview. The adapter therefore listens on the touched node itself, which keeps
 * receiving the gesture, cancels the pan, and forwards each touchmove, touchend and touchcancel
 * to `document` for the library when the node has been detached.
 *
 * Behaviour:
 *  - a finger that rests for TOUCH_DRAG_HOLD_MS (within TOUCH_DRAG_TOLERANCE_PX) picks the event up;
 *  - a finger that moves further first is a swipe: the add-on's begin is withdrawn and the browser
 *    scrolls the grid. Movement inside the tolerance is hidden from the library, whose long-press
 *    timer would otherwise cancel on the first jitter;
 *  - a tap is a tap: the begin is withdrawn at touchend and the click opens the event as before;
 *  - resize handles are not touched: resize stays desktop-only by design;
 *  - a read-only viewer, or an event the page's own `draggableAccessor` refuses, never begins.
 *
 * Untouched by design: the mouse path (the library's own), the unscheduled buckets (native
 * drag; their touch path is the tap sheet, slice 70) and the dispatch board (its own adapter,
 * `useBoardTouchDrag`).
 */
import { useEffect, useRef, type RefObject } from 'react';
import { TOUCH_DRAG_HOLD_MS, TOUCH_DRAG_TOLERANCE_PX } from './touchDragTiming';

/**
 * The slice of the add-on's calendar instance the adapter drives. All four members are the class
 * instance of `withDragAndDrop(Calendar)`, reached through a ref.
 */
export interface CalendarDndHandle {
  /** The call the library's own event wrapper makes when a mouse presses an event. */
  handleBeginAction: (event: object, action: 'move' | 'resize', direction?: string) => void;
  /** Called with null it abandons the action in progress (the library's own cancel). */
  handleInteractionEnd: (info: null) => void;
  state: { action?: string | null; interacting?: boolean };
  props: { draggableAccessor?: unknown };
}

export interface CalendarTouchDragOptions {
  /** The element that holds the calendar (touches elsewhere are not this adapter's). */
  containerRef: RefObject<HTMLElement | null>;
  /** The ref given to the drag-and-drop calendar. */
  calendarRef: RefObject<CalendarDndHandle | null>;
  /** The calendar's own event object for a card's `data-board-id`. */
  findEvent: (boardId: string) => object | undefined;
}

/** A resize handle, which this adapter never starts a gesture from. */
const RESIZE_ANCHOR = '[class*="rbc-addons-dnd-resize"]';

function isDraggable(handle: CalendarDndHandle, event: object): boolean {
  const accessor = handle.props.draggableAccessor;
  if (typeof accessor === 'function') return !!(accessor as (e: object) => unknown)(event);
  if (typeof accessor === 'string') return !!(event as Record<string, unknown>)[accessor];
  return true; // the library's default: every event may be dragged
}

export function useCalendarTouchDrag(opts: CalendarTouchDragOptions): void {
  const { containerRef, calendarRef } = opts;
  // The lookup changes identity every render; the listeners must not.
  const findEventRef = useRef(opts.findEvent);
  useEffect(() => {
    findEventRef.current = opts.findEvent;
  });

  useEffect(() => {
    /** The touch this adapter begun a move for, until it ends or is abandoned. */
    let pending: { id: number; x: number; y: number; at: number } | null = null;
    /** Takes the node-level listeners off the touched node. */
    let release: (() => void) | null = null;

    /** Withdraw the begin when the library did not carry the gesture on (a tap or a swipe). */
    const withdraw = () => {
      const handle = calendarRef.current;
      if (!handle) return;
      // `interacting` is set once the library has taken the touch over and moved it: that gesture
      // is the library's to finish. A begin with no interaction is ours to take back.
      if (handle.state.action && !handle.state.interacting) handle.handleInteractionEnd(null);
    };

    /**
     * Hand a gesture event that landed on a detached node to the library, which listens on the
     * document. A plain event carrying the touch lists: all the library reads is `type`, `touches`
     * and `preventDefault`, and not every engine lets a page construct a TouchEvent.
     */
    const forward = (src: TouchEvent) => {
      const copy = new Event(src.type, { bubbles: true, cancelable: true });
      for (const key of ['touches', 'targetTouches', 'changedTouches'] as const) {
        Object.defineProperty(copy, key, { value: src[key] });
      }
      document.dispatchEvent(copy);
    };

    const onStart = (e: TouchEvent) => {
      release?.();
      release = null;
      pending = null;
      const container = containerRef.current;
      const handle = calendarRef.current;
      const target = e.target as Element | null;
      if (!container || !handle || !target || e.touches.length !== 1 || !container.contains(target)) return;
      if (target.closest(RESIZE_ANCHOR)) return;
      const card = target.closest('.rbc-event');
      if (!card) return;
      const idEl = card.matches('[data-board-id]') ? card : card.querySelector('[data-board-id]');
      const boardId = idEl?.getAttribute('data-board-id');
      if (!boardId) return;
      const event = findEventRef.current(boardId);
      if (!event || !isDraggable(handle, event)) return;
      const t = e.touches[0]!;
      pending = { id: t.identifier, x: t.clientX, y: t.clientY, at: Date.now() };
      handle.handleBeginAction(event, 'move');

      // The gesture's own node (see the header): it outlives the library's re-render.
      const node = target as HTMLElement;
      let dragged = false;
      const onNodeMove = (ev: TouchEvent) => {
        if (!pending || Date.now() - pending.at < TOUCH_DRAG_HOLD_MS) return; // not picked up yet
        dragged = true;
        if (ev.cancelable) ev.preventDefault(); // the finger moves the event; the grid does not pan
        if (!node.isConnected) forward(ev);
      };
      const onNodeEnd = (ev: TouchEvent) => {
        if (dragged && ev.type === 'touchend' && ev.cancelable) ev.preventDefault(); // no click after a drag
        if (!node.isConnected) forward(ev);
        release?.();
        release = null;
      };
      node.addEventListener('touchmove', onNodeMove, { passive: false });
      node.addEventListener('touchend', onNodeEnd);
      node.addEventListener('touchcancel', onNodeEnd);
      release = () => {
        node.removeEventListener('touchmove', onNodeMove);
        node.removeEventListener('touchend', onNodeEnd);
        node.removeEventListener('touchcancel', onNodeEnd);
      };
    };

    // Capture phase on the window: it runs before the library's own listeners on the document.
    const onMove = (e: TouchEvent) => {
      if (!pending) return;
      const t = Array.from(e.touches).find((x) => x.identifier === pending!.id);
      if (!t) return;
      if (Date.now() - pending.at >= TOUCH_DRAG_HOLD_MS) return; // picked up: the library's
      if (Math.hypot(t.clientX - pending.x, t.clientY - pending.y) <= TOUCH_DRAG_TOLERANCE_PX) {
        // A resting finger drifts. The library cancels its press on the first touchmove it sees.
        e.stopPropagation();
        return;
      }
      pending = null; // a swipe: the browser scrolls
      withdraw();
    };

    const onEnd = () => {
      if (!pending) return;
      pending = null;
      // After the library's own end handling has run (it is on the document, we are on the window).
      setTimeout(withdraw, 0);
    };

    window.addEventListener('touchstart', onStart, { capture: true, passive: true });
    window.addEventListener('touchmove', onMove, { capture: true, passive: true });
    window.addEventListener('touchend', onEnd, { capture: true, passive: true });
    window.addEventListener('touchcancel', onEnd, { capture: true, passive: true });
    return () => {
      release?.();
      window.removeEventListener('touchstart', onStart, { capture: true });
      window.removeEventListener('touchmove', onMove, { capture: true });
      window.removeEventListener('touchend', onEnd, { capture: true });
      window.removeEventListener('touchcancel', onEnd, { capture: true });
    };
  }, [containerRef, calendarRef]);
}
