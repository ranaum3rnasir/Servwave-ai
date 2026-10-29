import { describe, it, expect } from 'vitest';
import { boardEventPaint, type BoardEventPaintInput } from './boardEventPaint';
import type { EventType } from './scheduleModel';

const base: BoardEventPaintInput = {
  type: 'job',
  isGhost: false,
  completed: false,
  inFlight: false,
  dangerState: null,
  highlight: {},
  canDragCalendarEntry: true,
};
const paint = (over: Partial<BoardEventPaintInput>) => boardEventPaint({ ...base, ...over });
const classes = (over: Partial<BoardEventPaintInput>) => (paint(over).className ?? '').split(/\s+/);

const TYPES: EventType[] = ['job', 'walkthrough', 'service-plan', 'calendar-entry'];
const FRAME = ['![outline-style:solid]', '!outline-2', '!outline-warning', '!-outline-offset-2'];

// Spelled out rather than templated: the unresolved-class guard reads this file too, and a
// class name built from a template literal reads to it as a truncated class that does not exist.
const DERIVED: Record<EventType, { surface: string; text: string; bar: string; oldTint: string; oldText: string }> = {
  job: {
    surface: '!bg-ev-job-surface', text: '!text-ev-job-text', bar: '!border-l-ev-job-border',
    oldTint: '!bg-ev-job/10', oldText: '!text-ev-job',
  },
  walkthrough: {
    surface: '!bg-ev-walkthrough-surface', text: '!text-ev-walkthrough-text', bar: '!border-l-ev-walkthrough-border',
    oldTint: '!bg-ev-walkthrough/10', oldText: '!text-ev-walkthrough',
  },
  'service-plan': {
    surface: '!bg-ev-service-plan-surface', text: '!text-ev-service-plan-text', bar: '!border-l-ev-service-plan-border',
    oldTint: '!bg-ev-service-plan/10', oldText: '!text-ev-service-plan',
  },
  'calendar-entry': {
    surface: '!bg-ev-calendar-entry-surface', text: '!text-ev-calendar-entry-text', bar: '!border-l-ev-calendar-entry-border',
    oldTint: '!bg-ev-calendar-entry/10', oldText: '!text-ev-calendar-entry',
  },
};

describe('boardEventPaint - scheduled cards paint the DERIVED card colours, not the raw accent', () => {
  it.each(TYPES)('%s: derived surface, text and left bar', (type) => {
    const c = classes({ type });
    const d = DERIVED[type];
    expect(c).toEqual(expect.arrayContaining([d.surface, d.text, d.bar, '!border-l-4']));
    // The old paint: the accent as text on a 10% tint of itself.
    expect(c).not.toContain(d.oldTint);
    expect(c).not.toContain(d.oldText);
  });

  it('never fades a card: no state sets opacity', () => {
    for (const over of [{}, { completed: true }, { inFlight: true }, { isGhost: true }, { dangerState: 'double-booked' as const }]) {
      expect(paint(over).style.opacity).toBeUndefined();
    }
  });
});

describe('boardEventPaint - double-booked', () => {
  it.each(TYPES.filter((t) => t !== 'calendar-entry'))(
    '%s: keeps its type surface, text and left bar, and gains the amber frame - never a white card',
    (type) => {
      const c = classes({ type, dangerState: 'double-booked' });
      const d = DERIVED[type];
      expect(c).not.toContain('!bg-surface-light');
      expect(c).not.toContain('!text-text-primary');
      // The frame is a 2px amber OUTLINE inset over all four edges (the owner-approved mock), not
      // a border: a border took the left side from the type bar, so an amber-typed card framed on
      // three sides barely differed from a normal one, and the grid's own 1px surface hairline
      // (an outline, schedule-dark.css) painted over half of it. `!` beats that hairline.
      expect(c).toEqual(expect.arrayContaining([d.surface, d.text, d.bar, '!border-l-4', ...FRAME]));
      expect(c).not.toContain('!border-2');
      expect(c).not.toContain('!border-warning');
    },
  );

  it('the frame changes no geometry: same border widths as the normal card of that type', () => {
    const normal = classes({ type: 'walkthrough' }).filter((x) => /^!border(-[lrtbxy])?-\d$|^!border-0$/.test(x));
    const framed = classes({ type: 'walkthrough', dangerState: 'double-booked' }).filter((x) => /^!border(-[lrtbxy])?-\d$|^!border-0$/.test(x));
    expect(framed).toEqual(normal);
  });

  it('outranks completed and in-progress, and still carries the search highlight', () => {
    const p = paint({ dangerState: 'double-booked', completed: true, inFlight: true, highlight: { zIndex: 10 } });
    expect(p.className).toContain('!outline-warning');
    expect(p.style.zIndex).toBe(10);
  });
});

describe('boardEventPaint - status treatments', () => {
  it('in progress is the derived solid fill with its derived text (was white on raw --info, 3.68:1)', () => {
    const c = classes({ inFlight: true });
    expect(c).toEqual(expect.arrayContaining(['!bg-ev-in-progress-solid', '!text-ev-in-progress-on-solid']));
    expect(c).not.toContain('!bg-info');
  });

  it('a walkthrough has no in-flight paint: it stays a walkthrough card', () => {
    expect(classes({ type: 'walkthrough', inFlight: true })).toContain('!bg-ev-walkthrough-surface');
  });

  it('completed is a SOLID grey fill with its derived text, unfaded - never a type tint', () => {
    const p = paint({ completed: true });
    expect(p.className).toContain('!bg-ev-completed-solid');
    expect(p.className).toContain('!text-ev-completed-on-solid');
    expect(p.className).not.toContain('!bg-text-soft');
    // Hue-independent: nothing of the job's own colour survives on a done card.
    expect(p.className).not.toMatch(/ev-job/);
    expect(p.style.opacity).toBeUndefined();
    expect(p.style.cursor).toBe('default');
  });
});

describe('boardEventPaint - the plan-mode ghost', () => {
  it('previews its type in the derived colours, dashed, unfaded', () => {
    const p = paint({ type: 'walkthrough', isGhost: true });
    expect(p.style.background).toBe('rgb(var(--ev-walkthrough-surface))');
    expect(p.style.color).toBe('rgb(var(--ev-walkthrough-text))');
    expect(p.style.border).toBe('2px dashed rgb(var(--ev-walkthrough-border))');
    expect(p.style.opacity).toBeUndefined();
  });
});

describe('boardEventPaint - calendar entry cursor', () => {
  it('grab only for someone who can drag it', () => {
    expect(paint({ type: 'calendar-entry', canDragCalendarEntry: true }).style.cursor).toBe('grab');
    expect(paint({ type: 'calendar-entry', canDragCalendarEntry: false }).style.cursor).toBe('default');
  });
});
