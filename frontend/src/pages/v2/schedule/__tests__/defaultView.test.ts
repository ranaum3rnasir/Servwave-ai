/**
 * Mobile slice 02 - the scheduler's opening view is a pure function of
 * (width class, URL view, session choice), and the empty state only mentions
 * the side panel where that panel is actually on screen.
 *
 * The function is exercised over EVERY combination of its three inputs (2 width
 * classes x 4 URL values x 4 session values), so no ordering rule can hide in an
 * untested corner.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  parseScheduleView,
  resolveScheduleView,
  readSessionView,
  writeSessionView,
  scheduleEmptyStateCopy,
  SCHEDULE_VIEW_SESSION_KEY,
  type ScheduleView,
  type ScheduleWidthClass,
} from '../defaultView';

const WIDTHS: ScheduleWidthClass[] = ['phone', 'wide'];
const VIEWS: ScheduleView[] = ['day', 'week', 'month'];
const MAYBE: Array<ScheduleView | null> = [null, ...VIEWS];

describe('resolveScheduleView - every combination', () => {
  for (const widthClass of WIDTHS) {
    for (const urlView of MAYBE) {
      for (const sessionView of MAYBE) {
        const expected: ScheduleView =
          urlView ?? sessionView ?? (widthClass === 'phone' ? 'day' : 'week');
        it(`width=${widthClass} url=${urlView ?? '-'} session=${sessionView ?? '-'} -> ${expected}`, () => {
          expect(resolveScheduleView({ widthClass, urlView, sessionView })).toBe(expected);
        });
      }
    }
  }

  it('opens a phone on Day and a wide screen on Week when nothing was chosen', () => {
    expect(resolveScheduleView({ widthClass: 'phone', urlView: null, sessionView: null })).toBe('day');
    expect(resolveScheduleView({ widthClass: 'wide', urlView: null, sessionView: null })).toBe('week');
  });

  it('keeps a Week the user picked on a phone', () => {
    expect(resolveScheduleView({ widthClass: 'phone', urlView: null, sessionView: 'week' })).toBe('week');
  });

  it('lets an explicit URL view beat both the session choice and the width default', () => {
    expect(resolveScheduleView({ widthClass: 'phone', urlView: 'month', sessionView: 'week' })).toBe('month');
    expect(resolveScheduleView({ widthClass: 'wide', urlView: 'day', sessionView: 'month' })).toBe('day');
  });
});

describe('resolveScheduleView - the "No crew" filter (S09.12)', () => {
  for (const widthClass of WIDTHS) {
    for (const sessionView of MAYBE) {
      it(`opens on Week at width=${widthClass} whatever the session chose (${sessionView ?? '-'})`, () => {
        expect(resolveScheduleView({ widthClass, urlView: null, sessionView, noCrew: true })).toBe('week');
      });
    }
  }

  it('still lets a view the link names win', () => {
    expect(resolveScheduleView({ widthClass: 'phone', urlView: 'day', sessionView: 'week', noCrew: true })).toBe('day');
    expect(resolveScheduleView({ widthClass: 'wide', urlView: 'month', sessionView: null, noCrew: true })).toBe('month');
  });

  it('changes nothing when the filter is off', () => {
    expect(resolveScheduleView({ widthClass: 'phone', urlView: null, sessionView: null, noCrew: false })).toBe('day');
  });
});

describe('parseScheduleView', () => {
  it('accepts the three board views', () => {
    expect(parseScheduleView('day')).toBe('day');
    expect(parseScheduleView('week')).toBe('week');
    expect(parseScheduleView('month')).toBe('month');
  });

  it('rejects anything else, so a junk ?view= falls through to the default', () => {
    for (const junk of [null, undefined, '', 'agenda', 'work_week', 'DAY', 'year', ' week']) {
      expect(parseScheduleView(junk)).toBeNull();
    }
  });
});

describe('session choice storage', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('round-trips a chosen view', () => {
    expect(readSessionView()).toBeNull();
    writeSessionView('week');
    expect(sessionStorage.getItem(SCHEDULE_VIEW_SESSION_KEY)).toBe('week');
    expect(readSessionView()).toBe('week');
  });

  it('ignores a tampered stored value', () => {
    sessionStorage.setItem(SCHEDULE_VIEW_SESSION_KEY, 'agenda');
    expect(readSessionView()).toBeNull();
  });

  it('survives storage that throws (private mode, blocked site data)', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
    try {
      expect(readSessionView()).toBeNull();
      expect(() => writeSessionView('day')).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window, 'sessionStorage', original);
    }
  });
});

describe('scheduleEmptyStateCopy - the side panel is only mentioned where it is on screen', () => {
  const PANEL = /panel/i;

  for (const view of VIEWS) {
    for (const panelVisible of [true, false]) {
      for (const canDrag of [true, false]) {
        it(`view=${view} panelVisible=${panelVisible} canDrag=${canDrag}`, () => {
          const copy = scheduleEmptyStateCopy({ view, panelVisible, canDrag });
          const mentionsPanel = PANEL.test(`${copy.title} ${copy.description ?? ''}`);
          expect(mentionsPanel).toBe(panelVisible && canDrag);
        });
      }
    }
  }

  it('keeps the desktop Week copy exactly as it was', () => {
    expect(scheduleEmptyStateCopy({ view: 'week', panelVisible: true, canDrag: true })).toEqual({
      title: 'No jobs scheduled this week',
      description: 'Drag a job from the panel on the left to assign it',
    });
  });

  it('names the range the board is actually showing', () => {
    const day = scheduleEmptyStateCopy({ view: 'day', panelVisible: false, canDrag: true });
    const month = scheduleEmptyStateCopy({ view: 'month', panelVisible: false, canDrag: true });
    expect(day.title).toBe('No jobs scheduled this day');
    expect(month.title).toBe('No jobs scheduled this month');
  });
});

describe('scheduleEmptyStateCopy - the "No crew" filter (S09.12)', () => {
  it('says there is nothing to staff in every view, and never points at the side panel', () => {
    for (const view of VIEWS) {
      const copy = scheduleEmptyStateCopy({ view, panelVisible: true, canDrag: true, noCrew: true });
      expect(copy.title).toBe('No visits without a crew');
      expect(PANEL_WORD.test(`${copy.title} ${copy.description ?? ''}`)).toBe(false);
    }
  });
});

const PANEL_WORD = /panel/i;
