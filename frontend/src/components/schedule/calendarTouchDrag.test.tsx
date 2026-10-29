/**
 * Mobile slice 58: the standard calendar's touch-drag adapter (useCalendarTouchDrag).
 *
 * Two layers, because the jsdom cannot run react-big-calendar's own drag (no layout, no hit
 * testing); the real gesture is the Playwright gate's job (e2e/mobile/scheduler-touch-drag.spec.ts):
 *
 *  1. The REAL library, rendered: it must refuse a touch on its own (the pinned upstream bug, so
 *     the adapter is known to be needed, and the day the library is fixed this fails and says so)
 *     and must begin a move once the adapter has run.
 *  2. The adapter's own rules, against a stand-in for the add-on's instance: what begins, what is
 *     withdrawn, what is hidden from the library's long-press timer, and the forwarding to the
 *     document once the library has re-rendered the touched node away.
 */
import { act, cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { Calendar, dateFnsLocalizer } from 'react-big-calendar';
import withDnD from 'react-big-calendar/lib/addons/dragAndDrop';
import { format, getDay, parse, startOfWeek } from 'date-fns';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCalendarTouchDrag, type CalendarDndHandle } from './useCalendarTouchDrag';
import { TOUCH_DRAG_HOLD_MS, TOUCH_DRAG_TOLERANCE_PX } from './touchDragTiming';

type Pt = { x: number; y: number };

/** A touch event the way a page sees one: a plain event carrying the touch lists. */
function touch(type: string, target: Element, at: Pt | null, id = 1, extra = 0): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  const t = at ? { identifier: id, clientX: at.x, clientY: at.y, pageX: at.x, pageY: at.y, target } : null;
  const live = t && type !== 'touchend' && type !== 'touchcancel' ? [t] : [];
  const touches = extra ? [...live, { identifier: id + 1, clientX: 0, clientY: 0, pageX: 0, pageY: 0, target }] : live;
  Object.defineProperty(ev, 'touches', { value: touches });
  Object.defineProperty(ev, 'targetTouches', { value: touches });
  Object.defineProperty(ev, 'changedTouches', { value: t ? [t] : [] });
  act(() => { target.dispatchEvent(ev); });
  return ev;
}

// ─── 1. The real library ──────────────────────────────────────────────────────────────────────
const localizer = dateFnsLocalizer({ format, parse, startOfWeek, getDay, locales: {} });
const DnDCalendar = withDnD(Calendar);
const DAY = new Date(2026, 9, 5);
const EVENTS = [
  { id: 'a', title: 'Move me', start: new Date(2026, 9, 5, 10), end: new Date(2026, 9, 5, 11) },
  { id: 'locked', title: 'Locked', start: new Date(2026, 9, 5, 13), end: new Date(2026, 9, 5, 14) },
];

function RealCalendar({ adapter, onDragStart }: { adapter: boolean; onDragStart: (a: unknown) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const cal = useRef<CalendarDndHandle | null>(null);
  useCalendarTouchDrag({
    containerRef: container,
    calendarRef: cal,
    findEvent: (id) => (adapter ? EVENTS.find((e) => e.id === id) : undefined),
  });
  return (
    <div ref={container} style={{ height: 600 }}>
      <DnDCalendar
        ref={cal as unknown as React.Ref<never>}
        localizer={localizer}
        events={EVENTS}
        view="day"
        onView={() => {}}
        date={DAY}
        onNavigate={() => {}}
        onDragStart={onDragStart}
        draggableAccessor={(e: object) => (e as { id: string }).id !== 'locked'}
        resizable
        selectable
        components={{ toolbar: () => null, event: ({ event }: { event: object }) => <div data-board-id={(event as { id: string }).id}>{(event as { title: string }).title}</div> } as never}
      />
    </div>
  );
}

describe('the real drag add-on and a touch', () => {
  afterEach(cleanup);

  const card = (title: string) => {
    const el = [...document.querySelectorAll('.rbc-event')].find((e) => e.textContent?.includes(title));
    if (!el) throw new Error(`no event "${title}" rendered`);
    return el.querySelector('[data-board-id]') as Element;
  };

  it('the library alone refuses to begin a drag from a touch (upstream: its handler tests e.button, which a touch lacks)', () => {
    const onDragStart = vi.fn();
    render(<RealCalendar adapter={false} onDragStart={onDragStart} />);
    touch('touchstart', card('Move me'), { x: 40, y: 40 });
    expect(onDragStart).not.toHaveBeenCalled();
  });

  it('with the adapter, a touch on an event begins a move of THAT event', () => {
    const onDragStart = vi.fn();
    render(<RealCalendar adapter onDragStart={onDragStart} />);
    touch('touchstart', card('Move me'), { x: 40, y: 40 });
    expect(onDragStart).toHaveBeenCalledTimes(1);
    expect(onDragStart.mock.calls[0]![0]).toMatchObject({ action: 'move', event: { id: 'a' } });
  });

  it('an event the page\'s own draggableAccessor refuses is never begun', () => {
    const onDragStart = vi.fn();
    render(<RealCalendar adapter onDragStart={onDragStart} />);
    touch('touchstart', card('Locked'), { x: 40, y: 40 });
    expect(onDragStart).not.toHaveBeenCalled();
  });

  it('a touch on a resize handle begins nothing: resize stays desktop-only', () => {
    const onDragStart = vi.fn();
    render(<RealCalendar adapter onDragStart={onDragStart} />);
    const anchor = document.querySelector('.rbc-addons-dnd-resize-ns-anchor');
    expect(anchor, 'the resize handle is rendered').toBeTruthy();
    touch('touchstart', anchor!, { x: 40, y: 40 });
    expect(onDragStart).not.toHaveBeenCalled();
  });
});

// ─── 2. The adapter's own rules ───────────────────────────────────────────────────────────────
function fakeHandle(): CalendarDndHandle & { begin: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> } {
  const begin = vi.fn();
  const end = vi.fn();
  const h = {
    state: {} as { action?: string | null; interacting?: boolean },
    props: {} as { draggableAccessor?: unknown },
    handleBeginAction: (...a: unknown[]) => { begin(...a); h.state.action = 'move'; },
    handleInteractionEnd: (...a: unknown[]) => { end(...a); h.state.action = null; },
    begin,
    end,
  };
  return h as unknown as CalendarDndHandle & { begin: typeof begin; end: typeof end };
}

function Harness({ handle, events }: { handle: CalendarDndHandle; events: Record<string, object> }) {
  const container = useRef<HTMLDivElement>(null);
  const cal = useRef<CalendarDndHandle | null>(handle);
  useCalendarTouchDrag({ containerRef: container, calendarRef: cal, findEvent: (id) => events[id] });
  return (
    <div>
      <div ref={container} data-testid="container">
        <div className="rbc-event"><div data-board-id="a" data-testid="a">A</div></div>
        <div className="rbc-event"><div data-board-id="ghost-x" data-testid="ghost">no event for this id</div></div>
      </div>
      <p data-testid="outside">elsewhere</p>
    </div>
  );
}

describe('useCalendarTouchDrag', () => {
  const EVENT = { id: 'a' };
  let handle: ReturnType<typeof fakeHandle>;
  let seen: string[];
  let spy: (e: Event) => void;

  const mount = () => {
    const utils = render(<Harness handle={handle} events={{ a: EVENT }} />);
    return { a: utils.getByTestId('a'), ghost: utils.getByTestId('ghost'), outside: utils.getByTestId('outside') };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    handle = fakeHandle();
    seen = [];
    // What the library's own listeners (on the document) would see.
    spy = (e) => seen.push(e.type);
    for (const t of ['touchmove', 'touchend', 'touchcancel']) document.addEventListener(t, spy);
  });
  afterEach(() => {
    for (const t of ['touchmove', 'touchend', 'touchcancel']) document.removeEventListener(t, spy);
    cleanup();
    vi.useRealTimers();
  });

  it('begins a move of the touched event on touchstart', () => {
    const { a } = mount();
    touch('touchstart', a, { x: 10, y: 10 });
    expect(handle.begin).toHaveBeenCalledWith(EVENT, 'move');
  });

  it('begins nothing for an unknown event, a second finger, or a touch outside the calendar', () => {
    const { a, ghost, outside } = mount();
    touch('touchstart', ghost, { x: 10, y: 10 });
    touch('touchstart', a, { x: 10, y: 10 }, 1, 1);
    touch('touchstart', outside, { x: 10, y: 10 });
    expect(handle.begin).not.toHaveBeenCalled();
  });

  it('a finger that drifts inside the tolerance is hidden from the library, so its press survives', () => {
    const { a } = mount();
    touch('touchstart', a, { x: 10, y: 10 });
    vi.advanceTimersByTime(100);
    touch('touchmove', a, { x: 10 + TOUCH_DRAG_TOLERANCE_PX - 1, y: 10 });
    expect(seen).not.toContain('touchmove');
    expect(handle.end).not.toHaveBeenCalled();
  });

  it('a finger that moves further before the hold is a swipe: the begin is withdrawn and the library sees the move', () => {
    const { a } = mount();
    touch('touchstart', a, { x: 10, y: 10 });
    vi.advanceTimersByTime(100);
    touch('touchmove', a, { x: 10, y: 10 + TOUCH_DRAG_TOLERANCE_PX + 20 });
    expect(handle.end).toHaveBeenCalledWith(null);
    expect(seen).toContain('touchmove');
  });

  it('after the hold the gesture is the library\'s: a move is not withdrawn and a drift is not hidden', () => {
    const { a } = mount();
    touch('touchstart', a, { x: 10, y: 10 });
    vi.advanceTimersByTime(TOUCH_DRAG_HOLD_MS + 10);
    touch('touchmove', a, { x: 10, y: 200 });
    expect(handle.end).not.toHaveBeenCalled();
    expect(seen).toContain('touchmove');
  });

  it('a tap withdraws the begin once the library has had its turn, and a gesture the library carried is left alone', () => {
    const { a } = mount();
    touch('touchstart', a, { x: 10, y: 10 });
    touch('touchend', a, null);
    expect(handle.end).not.toHaveBeenCalled(); // not yet: after the library's own end handling
    vi.advanceTimersByTime(1);
    expect(handle.end).toHaveBeenCalledTimes(1);

    handle.end.mockClear();
    touch('touchstart', a, { x: 10, y: 10 });
    handle.state.interacting = true; // the library has taken the touch over and moved it
    touch('touchend', a, null);
    vi.advanceTimersByTime(1);
    expect(handle.end).not.toHaveBeenCalled();
  });

  it('when the library re-renders the touched node away, the node still carries the gesture to the document', () => {
    const { a } = mount();
    touch('touchstart', a, { x: 10, y: 10 });
    vi.advanceTimersByTime(TOUCH_DRAG_HOLD_MS + 10);
    a.remove(); // the preview appeared and React rebuilt the event elements
    expect(a.isConnected).toBe(false);

    const move = touch('touchmove', a, { x: 10, y: 120 });
    expect(move.defaultPrevented, 'the grid does not pan under the finger').toBe(true);
    expect(seen, 'the document received the move the detached node could not bubble').toContain('touchmove');

    touch('touchend', a, null);
    expect(seen).toContain('touchend');
  });

  it('a connected node is not forwarded (the library already hears it: no double delivery)', () => {
    const { a } = mount();
    touch('touchstart', a, { x: 10, y: 10 });
    vi.advanceTimersByTime(TOUCH_DRAG_HOLD_MS + 10);
    touch('touchmove', a, { x: 10, y: 120 });
    expect(seen.filter((t) => t === 'touchmove')).toHaveLength(1);
  });

  it('honours the page\'s draggableAccessor', () => {
    handle.props.draggableAccessor = () => false;
    const { a } = mount();
    touch('touchstart', a, { x: 10, y: 10 });
    expect(handle.begin).not.toHaveBeenCalled();
  });
});
