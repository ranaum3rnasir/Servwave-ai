import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { cn } from '@/lib/utils';
import { isoToOrgDay, pickerValueToIso } from '@/lib/schedule-tz';
import type { Task, TaskStatus } from '@/lib/tasks/types';

/**
 * Call-site appearance guard for the task chips in the tasks calendar.
 *
 * The registry snapshot test is total over STATUS_REGISTRY and blind to every
 * call site: it cannot see whether this file still composes the class string it
 * used to. This test closes that gap for the one component whose ink the
 * status-registry migration changed, by rendering the real component in jsdom
 * and asserting the COMPOSED className (post twMerge) for the four TaskStatus
 * values against what origin/staging rendered.
 *
 * PARTIAL, not total, over TaskStatus. CANCELLED did not exist when this
 * baseline was frozen, so there is nothing it could be compared against and it
 * is deliberately absent from both maps and from `STATUSES` below - filling one
 * in would be inventing a baseline rather than recording one.
 *
 * Static: no browser, no dev server, no network.
 */

// --- The pre-registry source of truth, copied verbatim from ----------------
// git show origin/staging:frontend/src/pages/tasks/views/CalendarView.tsx
// lines 24-29 (chip) and 17-22 (dot). Do not "tidy" these strings: they are
// the baseline this test exists to compare against.
const STAGING_STATUS_CHIP: Partial<Record<TaskStatus, string>> = {
  TODO: 'bg-neutral-surface text-text-primary hover:bg-neutral-strong/15',
  IN_PROGRESS: 'bg-info-surface text-info-text hover:bg-info/15',
  BLOCKED: 'bg-warning-surface text-warning-text hover:bg-warning/15',
  DONE: 'bg-success-surface text-success-text hover:bg-success/15',
};

const STAGING_STATUS_DOT: Partial<Record<TaskStatus, string>> = {
  TODO: 'bg-neutral-strong',
  IN_PROGRESS: 'bg-info-strong',
  BLOCKED: 'bg-warning-strong',
  DONE: 'bg-success-strong',
};

const CHIP_BASE =
  'flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-left text-[10px] font-medium leading-snug cursor-pointer transition-colors';

const DOT_BASE = 'h-2 w-2 shrink-0 rounded-full';

const STATUSES: TaskStatus[] = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE'];

// --- Mocks: the chip is not exported, so the real component is rendered ----
// `mockTasks` is read at render time, so a test may swap the fixture first.
let mockTasks: Task[] = [];

vi.mock('@/lib/tasks/useFilteredTasks', () => ({
  useFilteredTasks: () => mockTasks,
}));
vi.mock('@/stores/taskDetailStore', () => ({
  useTaskDetailStore: (sel: (s: { open: (id: string) => void }) => unknown) =>
    sel({ open: () => {} }),
}));
vi.mock('@/stores/tasksStore', () => ({
  useTasksStore: (sel: (s: { reschedule: (id: string, due: string) => void }) => unknown) =>
    sel({ reschedule: () => {} }),
}));
vi.mock('@/contexts/AbilityContext', () => ({
  useAppAbility: () => ({ can: () => true }),
}));
// Hoisted so the vi.mock factory below and the fixtures further down cannot
// drift apart: the zone the view anchors on MUST be the zone the fixtures
// place their tasks in.
const { ORG_TZ } = vi.hoisted(() => ({ ORG_TZ: 'America/New_York' }));

// The calendar now reads the org's scheduling timezone, so it depends on the organization
// query. This file renders CalendarView bare, with no QueryClientProvider, so pin the org
// the same way every other dependency here is pinned. The real schedule-tz conversions stay
// live - only the source of the zone is stubbed.
vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => ({ data: { timezone: ORG_TZ } }),
}));

import CalendarView from '../CalendarView';

function makeTask(status: TaskStatus, dueAt: string): Task {
  return {
    id: `task-${status}`,
    task_number: `T-${status}`,
    title: `Title ${status}`,
    description: '',
    status,
    priority: 'MEDIUM',
    assignee_ids: ['u1'],
    assignees: [{ id: 'u1', name: 'Owner One' }],
    watcher_ids: [],
    due_at: dueAt,
    linked_entity: null,
    tags: [],
    subtasks: [],
    created_by: 'u1',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
    activity: [],
    comments: [],
    ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' },
  };
}

/**
 * "Today" MUST come from the org's clock, because that is the clock the view
 * anchors on - CalendarView's `orgToday()` is `isoToOrgDay(now, tz)`, and it
 * buckets every task by `isoToOrgDay(task.due_at, tz)`.
 *
 * Deriving it from UTC instead made this file fail every evening: after 20:00
 * in New York the UTC date has already rolled over, so the fixture wrote its
 * tasks onto tomorrow while the view was still rendering today, and the day
 * view was legitimately empty. Deterministic inside that window, so retries
 * did not help, and `TZ=` on the runner could not shift it either - the anchor
 * reads the ORG zone, never the machine's.
 *
 * The month fixture had the same defect one rollover up: on the 1st of a month
 * in UTC but the last day of the previous month in New York, the view renders
 * the previous month while the fixture writes into the next one.
 */
const ORG_TODAY = isoToOrgDay(new Date().toISOString(), ORG_TZ); // 'YYYY-MM-DD'
const ORG_MONTH = ORG_TODAY.slice(0, 7); // 'YYYY-MM'

/** A day token + an hour on the ORG's clock -> the instant to store on a task.
 *  The same direction the view's own `dayTokenAndTimeToIso` goes. */
function atOrgHour(day: string, hour: number): string {
  return pickerValueToIso(`${day}T${String(hour).padStart(2, '0')}:00`, ORG_TZ)!;
}

/**
 * Month view: one task per status on its own day, so MAX_PER_CELL (3) never
 * truncates a cell. Days 10-13 exist in every month.
 */
function monthFixture(): Task[] {
  return STATUSES.map((s, i) =>
    makeTask(s, atOrgHour(`${ORG_MONTH}-${String(10 + i).padStart(2, '0')}`, 9)),
  );
}

/** Day view: all four on today (the default anchor), one per hour. */
function dayFixture(): Task[] {
  return STATUSES.map((s, i) => makeTask(s, atOrgHour(ORG_TODAY, 9 + i)));
}

/** Order-insensitive token set, so twMerge output ORDER is never asserted. */
function tokens(cls: string): string[] {
  return cls.trim().split(/\s+/).filter(Boolean).sort();
}

/**
 * Any border COLOUR utility. Written as a bracketed pattern on purpose: the
 * unresolved-class guard (scripts/check-unresolved-classes.mjs) tokenises raw
 * source text, and a bare `border` + hyphen literal anywhere in this file would
 * register as an unresolvable class. Anything containing `[` is skipped there.
 */
const BORDER_COLOUR = /^border[-][a-z]/;

/** Drop the inert border COLOUR that STATUS_INTENT_CLASSES always ships. */
function withoutBorderColour(cls: string): string[] {
  return tokens(cls).filter((c) => !BORDER_COLOUR.test(c));
}

function chipFor(status: TaskStatus): HTMLElement {
  return screen.getByTitle(`Title ${status}`);
}

describe('CalendarView task chip - composed appearance vs origin/staging', () => {
  it('renders exactly one chip per status in the month view', () => {
    mockTasks = monthFixture();
    render(<CalendarView />);
    for (const s of STATUSES) {
      expect(screen.getAllByTitle(`Title ${s}`)).toHaveLength(1);
    }
  });

  it.each(STATUSES)(
    '%s chip composes to the same tokens origin/staging rendered, plus only the inert border colour',
    (status) => {
      mockTasks = monthFixture();
      render(<CalendarView />);
      expect(withoutBorderColour(chipFor(status).className)).toEqual(
        tokens(cn(CHIP_BASE, STAGING_STATUS_CHIP[status])),
      );
    },
  );

  it('TODO keeps text-text-primary and never falls through to text-neutral-text', () => {
    mockTasks = monthFixture();
    render(<CalendarView />);
    const cls = tokens(chipFor('TODO').className);
    expect(cls).toContain('text-text-primary');
    expect(cls).not.toContain('text-neutral-text');
  });

  it.each([
    ['IN_PROGRESS', 'text-info-text'],
    ['BLOCKED', 'text-warning-text'],
    ['DONE', 'text-success-text'],
  ] as const)('%s keeps its registry ink %s and does not take the TODO override', (status, ink) => {
    mockTasks = monthFixture();
    render(<CalendarView />);
    const cls = tokens(chipFor(status).className);
    expect(cls).toContain(ink);
    expect(cls).not.toContain('text-text-primary');
  });

  it.each([
    ['TODO', 'hover:bg-neutral-strong/15'],
    ['IN_PROGRESS', 'hover:bg-info/15'],
    ['BLOCKED', 'hover:bg-warning/15'],
    ['DONE', 'hover:bg-success/15'],
  ] as const)('%s keeps its hover affordance %s', (status, hover) => {
    mockTasks = monthFixture();
    render(<CalendarView />);
    expect(tokens(chipFor(status).className)).toContain(hover);
  });

  // --- negative controls: prove the assertions above can actually fail ------

  it('twMerge keeps the LAST text colour, so the TODO override must stay AFTER STATUS_INTENT_CLASSES', () => {
    expect(tokens(cn('text-neutral-text', 'text-text-primary'))).toEqual(['text-text-primary']);
    // Hoisting the override above the registry class silently drops it. This is
    // the failure mode the composed-token assertion above is here to catch.
    expect(tokens(cn('text-text-primary', 'text-neutral-text'))).toEqual(['text-neutral-text']);
  });

  it('the composed comparison is sensitive - a chip does not match another status baseline', () => {
    mockTasks = monthFixture();
    render(<CalendarView />);
    expect(withoutBorderColour(chipFor('TODO').className)).not.toEqual(
      tokens(cn(CHIP_BASE, STAGING_STATUS_CHIP.DONE)),
    );
  });

  it('every chip carries a border colour and NO border width - the hairline stays absent', () => {
    mockTasks = monthFixture();
    render(<CalendarView />);
    for (const s of STATUSES) {
      const cls = tokens(chipFor(s).className);
      expect(cls.some((c) => BORDER_COLOUR.test(c))).toBe(true);
      expect(cls).not.toContain('border');
    }
  });
});

describe('CalendarView day-view dot - unchanged vs origin/staging', () => {
  function dotFor(status: TaskStatus): HTMLElement {
    const row = screen.getByText(`Title ${status}`).closest('button');
    if (!row) throw new Error(`no day-view row for ${status}`);
    const dot = row.querySelector('span.rounded-full');
    if (!dot) throw new Error(`no dot for ${status}`);
    return dot as HTMLElement;
  }

  it.each(STATUSES)('%s dot composes byte-identically to the old STATUS_DOT', (status) => {
    mockTasks = dayFixture();
    render(<CalendarView />);
    fireEvent.click(screen.getByRole('button', { name: 'Day' }));
    expect(tokens(dotFor(status).className)).toEqual(
      tokens(cn(DOT_BASE, STAGING_STATUS_DOT[status])),
    );
  });
});
