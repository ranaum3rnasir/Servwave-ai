import { describe, it, expect } from 'vitest';
import {
  deriveState, timeOverlap, conflictedEventIds, swapCrew, classifyBoardDrop, draftFromDrop,
  hhmmToMin, isOnBoardFor, eventDangerState, conflictNoteFor, boardCapabilitiesFor, rescheduleGate,
  occupiesAllDayStrip, isAllDayEvent,
  EVENT_TYPE_META, boardCardScheme, visitLabel, visitLabelCompact,
  seedCrewForActor,
  type SchedulableEvent,
} from './scheduleModel';
import { asWallClock, type WallClock } from '@/lib/schedule-tz';
import { token } from '@/design-system/tokens';
import { contrastRatio, rgbDistance } from '@/design-system/contrast';
import { eventCardColors } from '@/design-system/eventCardColors';

// This module operates entirely in wall-clock space (see schedule-tz.ts) — fixtures are
// plain local Dates re-asserted as WallClock, same as the real read boundary does.
const wc = (day: number, h: number, m = 0): WallClock => asWallClock(new Date(2026, 5, day, h, m));

const at = (h: number, durMin = 120): { start: WallClock; end: WallClock } => {
  const start = wc(10, h, 0);
  return { start, end: asWallClock(new Date(start.getTime() + durMin * 60_000)) };
};
const ev = (over: Partial<SchedulableEvent>): SchedulableEvent => ({
  boardId: 'e', parentId: 'p', type: 'job', number: 'J1', title: 't', customer: 'c',
  crew: [], ownerId: null, start: null, end: null, raw: {}, ...over,
});

describe('deriveState (crew ⟂ schedule, §3.8)', () => {
  it('1 Fresh = no crew, no time', () => expect(deriveState(ev({}))).toBe(1));
  it('2 Scheduled = crew + time', () => expect(deriveState(ev({ crew: ['a'], ...at(9) }))).toBe(2));
  it('3 Crewed-unscheduled = crew, no time', () => expect(deriveState(ev({ crew: ['a'] }))).toBe(3));
  it('4 Needs-assignment = time, no crew', () => expect(deriveState(ev({ ...at(9) }))).toBe(4));
});

describe('timeOverlap (real Date intervals)', () => {
  it('overlapping intervals → true', () =>
    expect(timeOverlap(ev({ ...at(9) }), ev({ ...at(10) }))).toBe(true));
  it('touching but not overlapping (9–11 vs 11–13) → false', () =>
    expect(timeOverlap(ev({ ...at(9) }), ev({ ...at(11) }))).toBe(false));
  it('either unscheduled → false', () =>
    expect(timeOverlap(ev({ ...at(9) }), ev({}))).toBe(false));
});

describe('conflictedEventIds (per shared crew member, spans jobs + walkthroughs)', () => {
  it('shared member + overlap → both flagged', () => {
    const a = ev({ boardId: 'a', crew: ['carol'], ...at(10) });
    const b = ev({ boardId: 'b', type: 'walkthrough', crew: ['carol'], ...at(11) });
    expect(conflictedEventIds([a, b])).toEqual(new Set(['a', 'b']));
  });
  it('overlap but no shared member → empty', () => {
    const a = ev({ boardId: 'a', crew: ['alice'], ...at(10) });
    const b = ev({ boardId: 'b', crew: ['bob'], ...at(11) });
    expect(conflictedEventIds([a, b]).size).toBe(0);
  });
  it('shared member but no time overlap → empty', () => {
    const a = ev({ boardId: 'a', crew: ['carol'], ...at(8) });
    const b = ev({ boardId: 'b', crew: ['carol'], ...at(11) });
    expect(conflictedEventIds([a, b]).size).toBe(0);
  });
  it('multi-crew: only the shared member triggers it', () => {
    const a = ev({ boardId: 'a', crew: ['alice', 'bob'], ...at(10) });
    const b = ev({ boardId: 'b', crew: ['bob', 'carol'], ...at(11) });
    expect(conflictedEventIds([a, b])).toEqual(new Set(['a', 'b']));
  });
});

describe('eventDangerState (the two reds — one precedence decision for every render site)', () => {
  it('timed + 0 crew → needs-crew (red fill), even when also in conflictIds (precedence)', () => {
    expect(eventDangerState(ev({ boardId: 'x', ...at(9) }), new Set(['x']))).toBe('needs-crew');
  });
  it('crewed + id ∈ conflictIds → double-booked (red outline)', () => {
    expect(eventDangerState(ev({ boardId: 'x', crew: ['a'], ...at(9) }), new Set(['x']))).toBe('double-booked');
  });
  it('crewed, scheduled, no conflict → null (normal type styling)', () => {
    expect(eventDangerState(ev({ boardId: 'x', crew: ['a'], ...at(9) }), new Set())).toBeNull();
  });
  it('ghost/draft cards are previews — never red', () => {
    expect(eventDangerState({ ...ev({ boardId: 'x', ...at(9) }), isGhost: true }, new Set(['x']))).toBeNull();
  });
});

describe('swapCrew (D2: drag changes who is on a lane; 1:1 replace)', () => {
  it('replaces from→to, preserving crew size + other members', () => {
    expect(swapCrew(['alice', 'bob'], 'alice', 'carol')).toEqual({ kind: 'swapped', crew: ['carol', 'bob'] });
  });
  it('to-member already on crew → no-op (already-on)', () => {
    expect(swapCrew(['alice', 'bob'], 'alice', 'bob')).toEqual({ kind: 'noop-already-on' });
  });
  it('from-member not on crew → no-op (not-on, defensive)', () => {
    expect(swapCrew(['alice'], 'zzz', 'carol')).toEqual({ kind: 'noop-not-on' });
  });
});

describe('classifyBoardDrop (TG10: drag = where/when + whole-lane swap; the editor = who)', () => {
  it('cross-lane hour-slot drop → swap (the slot time is ignored by the caller)', () =>
    expect(classifyBoardDrop({ fromMember: 'alice', toMember: 'bob', sameDay: true, hasTime: true })).toBe('swap'));
  it('cross-lane day-cell drop → swap (the cell date is ignored by the caller)', () =>
    expect(classifyBoardDrop({ fromMember: 'alice', toMember: 'bob', sameDay: false, hasTime: false })).toBe('swap'));
  it('same lane + hour slot → reschedule within the lane', () =>
    expect(classifyBoardDrop({ fromMember: 'alice', toMember: 'alice', sameDay: true, hasTime: true })).toBe('reschedule'));
  it('same lane + different day cell → reschedule to that date', () =>
    expect(classifyBoardDrop({ fromMember: 'alice', toMember: 'alice', sameDay: false, hasTime: false })).toBe('reschedule'));
  it('same lane + same day cell → noop', () =>
    expect(classifyBoardDrop({ fromMember: 'alice', toMember: 'alice', sameDay: true, hasTime: false })).toBe('noop'));
  it('from-member absent → noop (defensive: board drags only originate in member lanes)', () =>
    expect(classifyBoardDrop({ fromMember: null, toMember: 'bob', sameDay: false, hasTime: true })).toBe('noop'));
});

describe('draftFromDrop (D5 pre-fill by drop target)', () => {
  const e = ev({ boardId: 'e', crew: [] });
  it('member-day: seeds crew + exact time, all auto flags', () => {
    const start = wc(10, 9, 0);
    const d = draftFromDrop(e, { kind: 'member-day', memberId: 'm1', start }, { defaultStartMin: 480, defaultDurationMin: 120 });
    expect(d).toMatchObject({ eventId: 'e', crew: ['m1'], start, durationMin: 120, autoDate: true, autoTime: true, autoMember: true });
  });
  it('member-week: seeds crew + date, default start time (08:00), no autoTime', () => {
    const d = draftFromDrop(e, { kind: 'member-week', memberId: 'm1', date: wc(10, 0) }, { defaultStartMin: 480, defaultDurationMin: 120 });
    expect(d.crew).toEqual(['m1']);
    expect(d.start.getHours()).toBe(8);
    expect(d).toMatchObject({ autoDate: true, autoTime: false, autoMember: true });
  });
  it('standard-time: time, no crew', () => {
    const start = wc(10, 13, 0);
    const d = draftFromDrop(e, { kind: 'standard-time', start }, { defaultStartMin: 480, defaultDurationMin: 120 });
    expect(d).toMatchObject({ crew: [], start, autoDate: true, autoTime: true, autoMember: false });
  });
  it('standard-day: date only, default start, no crew, no autoTime', () => {
    const d = draftFromDrop(e, { kind: 'standard-day', date: wc(10, 0) }, { defaultStartMin: 480, defaultDurationMin: 120 });
    expect(d).toMatchObject({ crew: [], autoDate: true, autoTime: false, autoMember: false });
    expect(d.start.getHours()).toBe(8);
  });
  it('preserves an already-scheduled event\'s duration over the default', () => {
    const scheduled = ev({ boardId: 'e2', ...at(9, 90) }); // 9:00–10:30
    const d = draftFromDrop(scheduled, { kind: 'standard-time', start: wc(11, 13, 0) }, { defaultStartMin: 480, defaultDurationMin: 120 });
    expect(d.durationMin).toBe(90);
  });
});

describe('isOnBoardFor (M3 — the shared column-membership predicate)', () => {
  it('member on the crew → true', () =>
    expect(isOnBoardFor(ev({ crew: ['alice', 'bob'] }), 'bob')).toBe(true));
  it('member not on the crew (owner is OFF-BOARD, never a column) → false', () =>
    expect(isOnBoardFor(ev({ crew: ['alice'], ownerId: 'sam' }), 'sam')).toBe(false));

  // Slice 06 (calendar-entries spec §3, ADR 0002) — a user PARTICIPANT also puts an event on a
  // member's board lane, via a field kept separate from crew (see the ADR-0002 describe block
  // below for why crew itself must stay untouched).
  describe('participantUserIds (slice 06)', () => {
    it('member listed only in participantUserIds → true', () =>
      expect(isOnBoardFor(ev({ crew: [], participantUserIds: ['dave'] }), 'dave')).toBe(true));
    it('member on crew with participantUserIds absent → true (existing job case, unmodified)', () =>
      expect(isOnBoardFor(ev({ crew: ['alice'] }), 'alice')).toBe(true));
    it('member neither on crew nor in participantUserIds → false', () =>
      expect(isOnBoardFor(ev({ crew: ['alice'], participantUserIds: ['dave'] }), 'sam')).toBe(false));
    it('an entry whose only participants are customers (participantUserIds empty) → false for every member', () =>
      expect(isOnBoardFor(ev({ crew: [], participantUserIds: [] }), 'dave')).toBe(false));
  });
});

describe('hhmmToMin', () => {
  it('parses HH:MM to minutes', () => {
    expect(hhmmToMin('08:00')).toBe(480);
    expect(hhmmToMin('13:45')).toBe(825);
  });
  it('falls back to 08:00 on garbage', () => {
    expect(hhmmToMin('')).toBe(480);
    expect(hhmmToMin('nope')).toBe(480);
  });
});

describe('conflictNoteFor (D5 — the modal\'s advisory note, never a blocker)', () => {
  const names = new Map([['carol', 'Carol'], ['bob', 'Bob']]);

  it('shared crew member + time overlap → "overlaps <number> for <firstName>"', () => {
    const other = ev({ boardId: 'o', number: 'J00099', crew: ['carol'], ...at(10) }); // 10:00–12:00
    const note = conflictNoteFor(
      { eventId: 'e', start: wc(10, 11, 0), durationMin: 120, crew: ['carol'] },
      [other],
      names,
    );
    expect(note).toBe('overlaps J00099 for Carol');
  });

  it('no shared member → null; and the dragged event itself is excluded', () => {
    const stranger = ev({ boardId: 'o', number: 'J00099', crew: ['bob'], ...at(10) });
    const self = ev({ boardId: 'e', number: 'J00001', crew: ['carol'], ...at(10) });
    const note = conflictNoteFor(
      { eventId: 'e', start: wc(10, 10, 0), durationMin: 60, crew: ['carol'] },
      [stranger, self],
      names,
    );
    expect(note).toBeNull();
  });

  it('empty crew → null (nobody to collide with); unknown member still notes without a name', () => {
    const other = ev({ boardId: 'o', number: 'J00099', crew: ['zed'], ...at(10) });
    expect(
      conflictNoteFor({ eventId: 'e', start: wc(10, 10, 0), durationMin: 60, crew: [] }, [other], names),
    ).toBeNull();
    expect(
      conflictNoteFor({ eventId: 'e', start: wc(10, 10, 0), durationMin: 60, crew: ['zed'] }, [other], names),
    ).toBe('overlaps J00099');
  });
});

describe('boardCapabilitiesFor (D9 — UI-control gating; data scoping is server-side)', () => {
  it('ADMIN → member view + full edit', () =>
    expect(boardCapabilitiesFor('ADMIN')).toEqual({ memberView: true, readOnly: false }));
  it('DISPATCHER → member view + full edit', () =>
    expect(boardCapabilitiesFor('DISPATCHER')).toEqual({ memberView: true, readOnly: false }));
  it('SALES → no member view, normal edits on their server-scoped data', () =>
    expect(boardCapabilitiesFor('SALES')).toEqual({ memberView: false, readOnly: false }));
  it('TECHNICIAN → no member view, READ-ONLY board', () =>
    expect(boardCapabilitiesFor('TECHNICIAN')).toEqual({ memberView: false, readOnly: true }));
  it('missing/unknown role fails SAFE → no member view, read-only', () => {
    expect(boardCapabilitiesFor(undefined)).toEqual({ memberView: false, readOnly: true });
    expect(boardCapabilitiesFor('SOMETHING_NEW')).toEqual({ memberView: false, readOnly: true });
  });
});

describe('occupiesAllDayStrip (mirrors react-big-calendar TimeGrid routing)', () => {
  const spanning = (fromDay: number, fromH: number, toDay: number, toH: number) =>
    ev({ start: wc(fromDay, fromH), end: wc(toDay, toH), raw: { is_all_day: false } });

  it('a flagged all-day job occupies the strip', () => {
    expect(occupiesAllDayStrip(ev({ ...at(9), raw: { is_all_day: true } }))).toBe(true);
  });

  it('a same-day timed job does NOT occupy the strip', () => {
    expect(occupiesAllDayStrip(spanning(10, 9, 10, 17))).toBe(false);
  });

  // The bug: rbc routes any event crossing a calendar-day boundary into the all-day
  // strip whatever is_all_day says, so the strip must count it too - otherwise the
  // event renders into a container CSS has collapsed to max-height: 0 and vanishes.
  it('a cross-midnight timed job occupies the strip', () => {
    expect(occupiesAllDayStrip(spanning(9, 20, 11, 5))).toBe(true);
  });

  it('an exactly-24h timed job occupies the strip', () => {
    expect(occupiesAllDayStrip(spanning(9, 12, 10, 12))).toBe(true);
  });

  // rbc compares calendar dates, so an event ending at the stroke of midnight is
  // already "a different day" to it - match that rather than out-clever it.
  it('a job ending at midnight occupies the strip', () => {
    expect(occupiesAllDayStrip(spanning(9, 9, 10, 0))).toBe(true);
  });

  it('an unscheduled event does not occupy the strip', () => {
    expect(occupiesAllDayStrip(ev({ raw: { is_all_day: false } }))).toBe(false);
  });

  // Slice 05 — a calendar entry reaches the strip on either axis: its own flag, or (already
  // true before this slice, via the generic cross-day fallback above) spanning days.
  it('a flagged all-day calendar entry occupies the strip', () => {
    const entry = ev({ type: 'calendar-entry', ...at(9), raw: { is_all_day: true } });
    expect(occupiesAllDayStrip(entry)).toBe(true);
  });

  it('a timed calendar entry crossing midnight occupies the strip', () => {
    const entry = ev({
      type: 'calendar-entry', start: wc(9, 20), end: wc(11, 5), raw: { is_all_day: false },
    });
    expect(occupiesAllDayStrip(entry)).toBe(true);
  });
});

describe('isAllDayEvent (spec §3 — a calendar entry reads its OWN is_all_day column)', () => {
  it('a calendar entry flagged is_all_day → true', () => {
    expect(isAllDayEvent(ev({ type: 'calendar-entry', raw: { is_all_day: true } }))).toBe(true);
  });

  it('a calendar entry with is_all_day: false → false', () => {
    expect(isAllDayEvent(ev({ type: 'calendar-entry', raw: { is_all_day: false } }))).toBe(false);
  });

  it('a calendar entry with no is_all_day on raw at all → false', () => {
    expect(isAllDayEvent(ev({ type: 'calendar-entry', raw: {} }))).toBe(false);
  });

  // Same shape as the job branch: the adapter's own `isAllDay` field (carried onto the card)
  // answers before falling back to raw.
  it('a calendar entry carrying isAllDay on the card itself → true, even if raw disagrees', () => {
    const entry = ev({ type: 'calendar-entry', isAllDay: true, raw: { is_all_day: false } });
    expect(isAllDayEvent(entry)).toBe(true);
  });

  // Existing job/walkthrough behaviour, pinned so this slice cannot regress it.
  it('job still reads its own isAllDay flag (unchanged)', () => {
    expect(isAllDayEvent(ev({ type: 'job', isAllDay: true, raw: {} }))).toBe(true);
  });

  it('job still falls back to raw.is_all_day (unchanged)', () => {
    expect(isAllDayEvent(ev({ type: 'job', raw: { is_all_day: true } }))).toBe(true);
  });

  it('walkthrough still fakes all-day via duration >= 1440 (unchanged)', () => {
    expect(isAllDayEvent(ev({ type: 'walkthrough', raw: { walkthrough_duration_minutes: 1440 } }))).toBe(true);
    expect(isAllDayEvent(ev({ type: 'walkthrough', raw: { walkthrough_duration_minutes: 60 } }))).toBe(false);
  });
});

describe('rescheduleGate (Spec B1, B-2 — money, not status, freezes a job)', () => {
  it('job with a sent invoice → blocked', () => {
    const e = ev({ raw: { invoices: [{ sent_at: '2026-06-01T00:00:00Z' }] } });
    expect(rescheduleGate(e)).toEqual({ ok: false, reason: 'This job has already been invoiced.' });
  });
  it('job with only unsent invoices → ok', () => {
    const e = ev({ raw: { invoices: [{ sent_at: null }] } });
    expect(rescheduleGate(e)).toEqual({ ok: true });
  });
  it('job with no invoices → ok', () => {
    expect(rescheduleGate(ev({}))).toEqual({ ok: true });
  });
  it('completed walkthrough → blocked', () => {
    const e = ev({ type: 'walkthrough', raw: { walkthrough_completed_at: '2026-06-01T00:00:00Z' } });
    expect(rescheduleGate(e)).toEqual({ ok: false, reason: 'This walkthrough already happened.' });
  });
  it('scheduled (not yet completed) walkthrough → ok', () => {
    const e = ev({ type: 'walkthrough', raw: { walkthrough_scheduled_at: '2026-06-01T00:00:00Z', walkthrough_completed_at: null } });
    expect(rescheduleGate(e)).toEqual({ ok: true });
  });
  it('the rbc outside-drag preview stub (no raw, no type) never throws — treated as ok', () => {
    // Mirrors the untyped dragFromOutsideItem() preview: { id, title, start, end } only.
    const stub = { id: 'preview', title: 'Drop to schedule', start: new Date(), end: new Date() } as unknown as SchedulableEvent;
    expect(() => rescheduleGate(stub)).not.toThrow();
    expect(rescheduleGate(stub)).toEqual({ ok: true });
  });
  it('calendar entry → ok (ADR 0002: joins nothing, has no invoices to be gated by)', () => {
    expect(rescheduleGate(ev({ type: 'calendar-entry' }))).toEqual({ ok: true });
  });
});

// ─── Slice 03 — Calendar Entries on the board (calendar-entries spec §3, ADR 0002) ───────────

describe('eventDangerState — calendar entries never paint red (ADR 0002)', () => {
  it('a timed entry with crew: [] → null, NOT needs-crew (every entry has empty crew by design)', () => {
    const entry = ev({ type: 'calendar-entry', boardId: 'ce-1', crew: [], ...at(9) });
    expect(eventDangerState(entry, new Set())).toBeNull();
  });
  it('a timed entry whose boardId IS in conflictIds → still null (never double-booked either)', () => {
    const entry = ev({ type: 'calendar-entry', boardId: 'ce-1', crew: [], ...at(9) });
    expect(eventDangerState(entry, new Set(['ce-1']))).toBeNull();
  });
});

describe('conflictedEventIds — calendar entries excluded on both axes (ADR 0002)', () => {
  it('an entry sharing a time window with a crewed job → empty set (entry causes no conflict)', () => {
    const job = ev({ boardId: 'job-1', crew: ['carol'], ...at(10) });
    const entry = ev({ type: 'calendar-entry', boardId: 'ce-1', crew: [], ...at(10) });
    expect(conflictedEventIds([job, entry]).size).toBe(0);
  });
  it('two overlapping calendar entries → empty set', () => {
    const a = ev({ type: 'calendar-entry', boardId: 'ce-1', crew: [], ...at(10) });
    const b = ev({ type: 'calendar-entry', boardId: 'ce-2', crew: [], ...at(10) });
    expect(conflictedEventIds([a, b]).size).toBe(0);
  });
  // A real calendar entry's crew is always [] (crewPeopleOf('calendar-entry', ...) → []), so the
  // two cases above pass even WITHOUT the type guard - an empty crew never matches `.some(...)`
  // either way. This case forces crew onto both sides so the assertion actually exercises the
  // guard, not just the empty-crew coincidence - proof that the exclusion is a TYPE check, not an
  // accident of a calendar entry never carrying a crew today.
  it('the exclusion holds even if a calendar entry somehow carried a "crew" (defensive proof, not a real shape)', () => {
    const a = ev({ boardId: 'job-1', crew: ['carol'], ...at(10) });
    const entry = ev({ type: 'calendar-entry', boardId: 'ce-1', crew: ['carol'], ...at(10) });
    expect(conflictedEventIds([a, entry]).size).toBe(0);
  });

  // Slice 06 — the ADR-0002 assertion this slice exists to prove: naming a user as a
  // PARTICIPANT (which places the entry in that member's column, per isOnBoardFor above) must
  // NOT read as crewing the entry. A job crewed with that same user, overlapping the entry's
  // time window, must still produce an empty conflict set.
  it('an entry with user participantUserIds still has crew: [], and conflicts with a same-user-crewed job stay empty', () => {
    const entry = ev({
      type: 'calendar-entry', boardId: 'ce-1', crew: [], participantUserIds: ['dave'], ...at(10),
    });
    expect(entry.crew).toEqual([]);
    const job = ev({ boardId: 'job-1', crew: ['dave'], ...at(10) }); // same user, overlapping time
    expect(conflictedEventIds([entry, job]).size).toBe(0);
  });
});

describe('EVENT_TYPE_META[\'calendar-entry\'] — the muted "Event" scheme (spec §3, §9 risk 4, slice 03/06)', () => {
  it('labels the user-facing word "Event"', () => {
    expect(EVENT_TYPE_META['calendar-entry'].label).toBe('Event');
  });

  // What the card actually paints (2026-09-30): the DERIVED card colours - an opaque surface at a
  // fixed lightness in the event hue, and text that clears 4.5:1 on it (eventCardColors.ts). Until
  // then it was the token as text on a 5-10% tint of itself over the canvas, which is what this
  // block measured; --event was the one accent that passed that way, the other three did not.
  const eventText = token('--event');
  const eventCard = eventCardColors(eventText)!;

  it('the Event card\'s text clears WCAG AA (>= 4.5:1) on the surface it is painted on', () => {
    expect(contrastRatio(eventCard.text, eventCard.surface)).toBeGreaterThanOrEqual(4.5);
  });

  // REPLACES a class-string identity check ('bg-event/5' !== 'bg-warning/5' is true no matter
  // what colour either resolves to) that could never fail: the original --bronze-600 measured
  // only 79.4 away from warning's amber on this same 0-441 scale — visually near-siblings — while
  // sailing through the old assertion. This asserts the RENDERED colour instead.
  it('is visually distinct from every type accent (job/walkthrough/service-plan), by resolved colour', () => {
    const siblings = {
      job: token('--info'),
      walkthrough: token('--warning'),
      'service-plan': token('--ai'),
    } as const;
    for (const hex of Object.values(siblings)) {
      // A floor comfortably above every sibling type-accent pairing already on this board (the
      // weakest today, event vs walkthrough, measures ~97.6) — see EVENT_TYPE_META's own comment
      // for why hues that scored higher here (green/teal) were rejected on a DIFFERENT axis.
      expect(rgbDistance(eventText, hex)).toBeGreaterThan(60);
    }
  });

  it('is not near-indistinguishable from boardCardScheme\'s completed treatment on the real card background', () => {
    // The completed card's actual fill: the SOLID grey derived from --text-soft
    // (--ev-completed-solid), not a tint. That is what finally closes §9 risk 4's admitted limit:
    // two pale tints at one lightness could never get far apart on this 0-441 scale (~26-30), a
    // mid-grey solid against a pale tint is ~200 away. The old floor of 25 is kept as the floor.
    const completedBg = eventCardColors(token('--text-soft'))!.solid;
    expect(rgbDistance(eventCard.surface, completedBg)).toBeGreaterThan(25);
    expect(rgbDistance(eventCard.surface, completedBg)).toBeGreaterThan(120);
  });
});

// D13 has TWO wordings now: the sentence every roomy surface uses, and the abbreviation the
// 96.3px all-day pill uses because the sentence and the job number cannot both fit there.
// The risk is not the wording - it is the two drifting apart on the silent-when-single edge,
// which is the exact case D13 exists to get right. visitLabelCompact delegates the condition
// rather than restating it; these hold that down.
describe('visitLabel / visitLabelCompact (one condition, two wordings)', () => {
  it('word the same trip differently', () => {
    expect(visitLabel({ visitSeq: 2, visitCount: 5 })).toBe('Visit 2 of 5');
    expect(visitLabelCompact({ visitSeq: 2, visitCount: 5 })).toBe('2/5');
  });

  it('agree on silence, case for case', () => {
    const silent = [
      { visitSeq: 1, visitCount: 1 },        // the 99% case - a single trip is not news
      { visitSeq: 1, visitCount: undefined }, // no count known
      { visitSeq: undefined, visitCount: 5 }, // counted but unnumbered
    ];
    for (const e of silent) {
      expect(visitLabel(e)).toBeNull();
      expect(visitLabelCompact(e)).toBeNull();
    }
  });
});

// The board's half of the self-only assignee rule (slice 4). The lead tab's `seedPerformers` is
// the twin; both exist because a viewer without `assign User` has a one-row picker roster and an
// empty crew field therefore offers a choice that does not exist.
//
// EVERY CARD THAT REACHES THIS FUNCTION IS A BUCKET CARD, i.e. one with no live visit - see the
// function's own note for the two query parameters that make that true. That is the whole reason
// the "keep whatever the drop produced" clause is gone: the restatement exemption those cases
// used to lean on (`validateCrew`'s / `validatePerformers`' `currentCrewIds`) needs a live visit,
// and `POST /api/jobs/:id/assign` passes `undefined` - the STRICT path - when there is not one.
describe('seedCrewForActor (whose names the drop modal opens with)', () => {
  it('seeds the actor when the drop produced nobody and they may name nobody else', () => {
    // The standard-lane drop of a fresh bucket card - the case the whole slice is about.
    expect(seedCrewForActor([], false, 'u-sales')).toEqual(['u-sales']);
  });

  it('leaves a grant holder\'s empty crew empty', () => {
    // A dispatcher booking somebody else\'s job must not start with their own name in the field.
    expect(seedCrewForActor([], true, 'u-dispatch')).toEqual([]);
  });

  // THE DEAD END THIS CLAUSE CLOSES. The card's crew came off a cancelled or completed trip -
  // there is no live visit behind a bucket card - so re-sending it is not a restatement the
  // server exempts, it is a foreign name on the strict path, and the answer is 403.
  it('replaces a crew this viewer may not name with the one crew the API would accept', () => {
    expect(seedCrewForActor(['u-tech'], false, 'u-sales')).toEqual(['u-sales']);
    expect(seedCrewForActor(['u-tech', 'u-other'], false, 'u-sales')).toEqual(['u-sales']);
  });

  it('is a no-op when the drop already produced exactly that viewer', () => {
    // The member-day / member-week lane seed: the lanes come from the SAME grant-scoped
    // `/api/users/assignable` roster, so a self-only viewer has one lane and it is their own.
    expect(seedCrewForActor(['u-sales'], false, 'u-sales')).toEqual(['u-sales']);
  });

  it('hands a grant holder back whatever the drop produced, untouched', () => {
    expect(seedCrewForActor(['u-tech', 'u-other'], true, 'u-dispatch')).toEqual(['u-tech', 'u-other']);
  });

  it("seeds nobody before the session lands - [''] is a crew member the API answers 404 for", () => {
    expect(seedCrewForActor([], false, '')).toEqual([]);
  });

  it('leaves a crewed card ALONE before the session lands, rather than wiping it', () => {
    // `canAssignOthers` reads false for a dispatcher too until the ability arrives
    // (`useAppAbility` defaults to `emptyAbility`), so an empty `actorId` means "no verdict yet",
    // not "self-only viewer". Acting on it would strip a real crew off a real dispatcher's drop.
    expect(seedCrewForActor(['u-tech'], false, '')).toEqual(['u-tech']);
  });

  // Composed with the function that actually feeds it, because the pair is what `openDropModal`
  // runs and the interesting cases are the ones a drop can produce.
  it('a crewed card dropped where no member is named is the case that used to 403', () => {
    const crewed = ev({ boardId: 'e3', crew: ['u-tech', 'u-other'] });
    const d = draftFromDrop(crewed, { kind: 'standard-day', date: wc(10, 0) }, { defaultStartMin: 480, defaultDurationMin: 120 });
    // `draftFromDrop` copies the card's crew through, and THAT is what the modal used to open
    // holding - locked, on a payload the job door answers 403 for.
    expect(d.crew).toEqual(['u-tech', 'u-other']);
    expect(seedCrewForActor(d.crew, false, 'u-sales')).toEqual(['u-sales']);
    // The holder is unaffected: the same drop still opens on the crew the card carried.
    expect(seedCrewForActor(d.crew, true, 'u-dispatch')).toEqual(['u-tech', 'u-other']);
  });

  it('a fresh card dropped where no member is named seeds the same way', () => {
    const d = draftFromDrop(ev({ boardId: 'e4', crew: [] }), { kind: 'standard-time', start: wc(10, 13, 0) }, { defaultStartMin: 480, defaultDurationMin: 120 });
    expect(seedCrewForActor(d.crew, false, 'u-sales')).toEqual(['u-sales']);
    expect(seedCrewForActor(d.crew, true, 'u-dispatch')).toEqual([]);
  });

  it('a member-lane drop still opens on that lane, seed or no seed', () => {
    const crewed = ev({ boardId: 'e5', crew: ['u-tech'] });
    const d = draftFromDrop(
      crewed,
      { kind: 'member-day', memberId: 'u-sales', start: wc(10, 9, 0) },
      { defaultStartMin: 480, defaultDurationMin: 120 },
    );
    // The lane replaced the card's crew before this function ever saw it, and the lane is the
    // viewer's own - so the seed changes nothing here and the "pre-filled from ...'s lane"
    // caption still describes what is in the field.
    expect(d.crew).toEqual(['u-sales']);
    expect(seedCrewForActor(d.crew, false, 'u-sales')).toEqual(['u-sales']);
  });
});
