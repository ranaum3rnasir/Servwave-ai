/**
 * Mobile slice 58: the dispatch board's touch-drag bridge (useBoardTouchDrag).
 *
 * The jsdom has neither a DataTransfer, a DragEvent nor hit testing, so tiny stand-ins are
 * installed; what is under test is the bridge's contract with the board's existing native-drag
 * handlers: after a hold, the card's own `dragstart` fills a payload; the element under the finger
 * gets `dragenter`/`dragover`; a drop is delivered only to a target that cancelled its `dragover`;
 * a swipe, a tap and a cancelled touch deliver nothing. The real gesture, on a real engine, is the
 * Playwright gate's job (e2e/mobile/scheduler-touch-drag.spec.ts).
 */
import { act, cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { useBoardTouchDrag } from './useBoardTouchDrag';
import { TOUCH_DRAG_HOLD_MS, TOUCH_DRAG_TOLERANCE_PX } from './touchDragTiming';

class FakeDataTransfer {
  private data = new Map<string, string>();
  effectAllowed = 'all';
  dropEffect = 'none';
  get types() { return [...this.data.keys()]; }
  setData(k: string, v: string) { this.data.set(k, v); }
  getData(k: string) { return this.data.get(k) ?? ''; }
}
class FakeDragEvent extends Event {
  dataTransfer: unknown;
  clientX: number;
  clientY: number;
  relatedTarget: EventTarget | null;
  constructor(type: string, init: Record<string, unknown> = {}) {
    super(type, init as EventInit);
    this.dataTransfer = init.dataTransfer;
    this.clientX = (init.clientX as number) ?? 0;
    this.clientY = (init.clientY as number) ?? 0;
    this.relatedTarget = (init.relatedTarget as EventTarget) ?? null;
  }
}

function touch(type: string, target: Element, at: { x: number; y: number } | null, extraFingers = 0): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  const t = at ? { identifier: 1, clientX: at.x, clientY: at.y, pageX: at.x, pageY: at.y, target } : null;
  const live = t && type !== 'touchend' && type !== 'touchcancel' ? [t] : [];
  const touches = extraFingers ? [...live, { identifier: 2, clientX: 0, clientY: 0, target }] : live;
  Object.defineProperty(ev, 'touches', { value: touches });
  Object.defineProperty(ev, 'changedTouches', { value: t ? [t] : [] });
  act(() => { target.dispatchEvent(ev); });
  return ev;
}

const CARD = { x: 20, y: 20 };
const ZONE = { x: 220, y: 220 };
const NOWHERE = { x: 400, y: 400 };

type Spy = Mock<(...args: unknown[]) => void>;
interface Log { onDragStart: Spy; onDragEnd: Spy; onClick: Spy; onContextMenu: Spy; zoneOver: Spy; zoneEnter: Spy; zoneLeave: Spy; zoneDrop: Spy }

function Board({ log, accept = true }: { log: Log; accept?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useBoardTouchDrag(ref);
  return (
    <div>
      <div
        ref={ref}
        data-testid="card"
        data-board-id="ce-1"
        draggable
        style={{ opacity: '0.8' }}
        onDragStart={(e) => { e.dataTransfer.setData('grid-event-id', 'ce-1'); log.onDragStart(); }}
        onDragEnd={() => log.onDragEnd()}
        onClick={() => log.onClick()}
        onContextMenu={() => log.onContextMenu()}
      >
        card
      </div>
      <div
        data-testid="zone"
        onDragEnter={() => log.zoneEnter()}
        onDragOver={(e) => { log.zoneOver(); if (accept && e.dataTransfer.types.includes('grid-event-id')) e.preventDefault(); }}
        onDragLeave={() => log.zoneLeave()}
        onDrop={(e) => { e.preventDefault(); log.zoneDrop(e.dataTransfer.getData('grid-event-id')); }}
      >
        zone
      </div>
    </div>
  );
}

describe('useBoardTouchDrag', () => {
  let log: Log;
  const original = { DataTransfer: globalThis.DataTransfer, DragEvent: globalThis.DragEvent, elementFromPoint: document.elementFromPoint };

  const mount = (accept = true) => {
    const utils = render(<Board log={log} accept={accept} />);
    const card = utils.getByTestId('card');
    const zone = utils.getByTestId('zone');
    document.elementFromPoint = (x: number, y: number) => (x === ZONE.x && y === ZONE.y ? zone : x === CARD.x && y === CARD.y ? card : null);
    return { card, zone };
  };
  const preview = () => document.querySelector('[data-touch-drag-preview]');

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as unknown as Record<string, unknown>).DataTransfer = FakeDataTransfer;
    (globalThis as unknown as Record<string, unknown>).DragEvent = FakeDragEvent;
    log = { onDragStart: vi.fn(), onDragEnd: vi.fn(), onClick: vi.fn(), onContextMenu: vi.fn(), zoneOver: vi.fn(), zoneEnter: vi.fn(), zoneLeave: vi.fn(), zoneDrop: vi.fn() };
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    (globalThis as unknown as Record<string, unknown>).DataTransfer = original.DataTransfer;
    (globalThis as unknown as Record<string, unknown>).DragEvent = original.DragEvent;
    document.elementFromPoint = original.elementFromPoint;
  });

  it('a press held for the long-press picks the card up: its own dragstart runs and a floating copy follows', () => {
    const { card } = mount();
    touch('touchstart', card, CARD);
    expect(log.onDragStart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(TOUCH_DRAG_HOLD_MS);
    expect(log.onDragStart).toHaveBeenCalledTimes(1);
    const copy = preview() as HTMLElement;
    expect(copy, 'a floating copy').toBeTruthy();
    expect(copy.hasAttribute('data-board-id'), 'the copy is not a second card').toBe(false);
    expect(copy.style.pointerEvents).toBe('none');
    expect(card.style.opacity, 'the card itself dims while it is carried').toBe('0.35');
  });

  it('a swipe (the finger moves past the tolerance before the hold) picks nothing up and does not stop the scroll', () => {
    const { card } = mount();
    touch('touchstart', card, CARD);
    vi.advanceTimersByTime(80);
    const move = touch('touchmove', card, { x: CARD.x, y: CARD.y + TOUCH_DRAG_TOLERANCE_PX + 30 });
    vi.advanceTimersByTime(TOUCH_DRAG_HOLD_MS * 2);
    expect(log.onDragStart).not.toHaveBeenCalled();
    expect(preview()).toBeNull();
    expect(move.defaultPrevented, 'the browser may scroll').toBe(false);
  });

  it('a resting finger that drifts inside the tolerance still picks the card up', () => {
    const { card } = mount();
    touch('touchstart', card, CARD);
    touch('touchmove', card, { x: CARD.x + TOUCH_DRAG_TOLERANCE_PX - 2, y: CARD.y });
    vi.advanceTimersByTime(TOUCH_DRAG_HOLD_MS);
    expect(log.onDragStart).toHaveBeenCalledTimes(1);
  });

  it('a tap is a tap: nothing is picked up and the click is not swallowed', () => {
    const { card } = mount();
    touch('touchstart', card, CARD);
    vi.advanceTimersByTime(60);
    touch('touchend', card, null);
    vi.advanceTimersByTime(TOUCH_DRAG_HOLD_MS * 2);
    expect(log.onDragStart).not.toHaveBeenCalled();
    act(() => { card.click(); });
    expect(log.onClick).toHaveBeenCalledTimes(1);
  });

  it('carried over a target, it gets enter and over; released there, it gets the drop with the payload', () => {
    const { card } = mount();
    touch('touchstart', card, CARD);
    vi.advanceTimersByTime(TOUCH_DRAG_HOLD_MS);
    const move = touch('touchmove', card, ZONE);
    expect(move.defaultPrevented, 'a carried card does not pan the board').toBe(true);
    expect(log.zoneEnter).toHaveBeenCalledTimes(1);
    expect(log.zoneOver).toHaveBeenCalled();
    touch('touchend', card, ZONE);
    expect(log.zoneDrop).toHaveBeenCalledWith('ce-1');
    expect(log.onDragEnd).toHaveBeenCalledTimes(1);
    expect(preview(), 'the copy is gone').toBeNull();
    expect(card.style.opacity, 'the card is back to its own opacity').toBe('0.8');
  });

  it('keeps the native rule: a target that did not cancel dragover receives no drop', () => {
    const { card } = mount(false);
    touch('touchstart', card, CARD);
    vi.advanceTimersByTime(TOUCH_DRAG_HOLD_MS);
    touch('touchmove', card, ZONE);
    touch('touchend', card, ZONE);
    expect(log.zoneOver).toHaveBeenCalled();
    expect(log.zoneDrop).not.toHaveBeenCalled();
    expect(log.onDragEnd).toHaveBeenCalledTimes(1);
    expect(preview()).toBeNull();
  });

  it('released over nothing, or cancelled by the browser, delivers no drop and cleans up', () => {
    let { card } = mount();
    touch('touchstart', card, CARD);
    vi.advanceTimersByTime(TOUCH_DRAG_HOLD_MS);
    touch('touchmove', card, NOWHERE);
    touch('touchend', card, NOWHERE);
    expect(log.zoneDrop).not.toHaveBeenCalled();
    expect(preview()).toBeNull();
    cleanup();

    ({ card } = mount());
    touch('touchstart', card, CARD);
    vi.advanceTimersByTime(TOUCH_DRAG_HOLD_MS);
    touch('touchmove', card, ZONE);
    touch('touchcancel', card, ZONE);
    expect(log.zoneDrop).not.toHaveBeenCalled();
    expect(log.onDragEnd).toHaveBeenCalledTimes(2);
    expect(preview()).toBeNull();
  });

  it('a drop is not also a tap: the click that follows is swallowed, a later one is not', () => {
    const { card } = mount();
    touch('touchstart', card, CARD);
    vi.advanceTimersByTime(TOUCH_DRAG_HOLD_MS);
    touch('touchmove', card, ZONE);
    touch('touchend', card, ZONE);
    act(() => { card.click(); });
    expect(log.onClick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    act(() => { card.click(); });
    expect(log.onClick).toHaveBeenCalledTimes(1);
  });

  it('a second finger lets go; the long-press context menu is suppressed only while a touch is held', () => {
    const { card } = mount();
    touch('touchstart', card, CARD);
    touch('touchstart', card, CARD, 1); // second finger
    vi.advanceTimersByTime(TOUCH_DRAG_HOLD_MS * 2);
    expect(log.onDragStart).not.toHaveBeenCalled();

    touch('touchend', card, null);
    const free = new Event('contextmenu', { bubbles: true, cancelable: true });
    act(() => { card.dispatchEvent(free); });
    expect(log.onContextMenu, 'a right-click or a keyboard menu still opens the menu').toHaveBeenCalledTimes(1);

    touch('touchstart', card, CARD);
    const held = new Event('contextmenu', { bubbles: true, cancelable: true });
    act(() => { card.dispatchEvent(held); });
    expect(held.defaultPrevented).toBe(true);
    expect(log.onContextMenu).toHaveBeenCalledTimes(1);
  });

  it('where the browser has no DataTransfer constructor, the card is left alone (native drag stays as it was)', () => {
    (globalThis as unknown as Record<string, unknown>).DataTransfer = undefined;
    const { card } = mount();
    touch('touchstart', card, CARD);
    vi.advanceTimersByTime(TOUCH_DRAG_HOLD_MS * 2);
    expect(log.onDragStart).not.toHaveBeenCalled();
    expect(preview()).toBeNull();
  });
});
