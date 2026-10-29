import { describe, it, expect } from 'vitest';
import { anchorDateFor, isAnchoredWait, describeAnchoredWait, ANCHORS_FOR_ENTITY, ANCHOR_LABELS, ALL_ANCHOR_KEYS, LEAD_STAGE_CLOCK_ANCHORS, type AnchorKey } from '../anchors';
import type { EntityState } from '../context';

describe('anchors', () => {
  it('reads the job start from state', () => {
    const d = new Date('2026-08-01T15:00:00Z');
    expect(anchorDateFor('job.scheduled_start', { jobScheduledStart: d })).toEqual(d);
  });
  it('reads the walkthrough time from state', () => {
    const d = new Date('2026-08-01T15:00:00Z');
    expect(anchorDateFor('lead.walkthrough_scheduled_at', { leadWalkthroughScheduledAt: d })).toEqual(d);
  });
  it('returns null when the anchor date is unset', () => {
    expect(anchorDateFor('job.scheduled_start', {})).toBeNull();
  });
  it('detects an anchored wait config by mode', () => {
    expect(isAnchoredWait({ mode: 'anchored', anchor: 'job.scheduled_start', direction: 'before', offset_minutes: 1440 })).toBe(true);
    expect(isAnchoredWait({ duration_minutes: 60 })).toBe(false);
  });
  it('humanizes the anchored wait for the activity log', () => {
    expect(describeAnchoredWait({ mode: 'anchored', anchor: 'lead.walkthrough_scheduled_at', direction: 'before', offset_minutes: 1440 }))
      .toBe('1 day before the walkthrough time');
  });
});

describe('anchors — invoice + estimate', () => {
  it('offers a due-date anchor for invoices and an expiration anchor for estimates', () => {
    expect(ANCHORS_FOR_ENTITY.invoice).toEqual(['invoice.due_date']);
    expect(ANCHORS_FOR_ENTITY.estimate).toEqual(['estimate.valid_until']);
  });

  it('reads the invoice due date off EntityState', () => {
    const due = new Date('2026-08-01T12:00:00.000Z');
    const state = { invoiceDueDate: due } as unknown as EntityState;
    expect(anchorDateFor('invoice.due_date', state)?.toISOString()).toBe(due.toISOString());
  });

  it('reads the estimate expiration off EntityState', () => {
    const exp = new Date('2026-08-05T12:00:00.000Z');
    const state = { estimateValidUntil: exp } as unknown as EntityState;
    expect(anchorDateFor('estimate.valid_until', state)?.toISOString()).toBe(exp.toISOString());
  });

  it('returns null when the anchor date is absent', () => {
    expect(anchorDateFor('invoice.due_date', {} as EntityState)).toBeNull();
    expect(anchorDateFor('estimate.valid_until', {} as EntityState)).toBeNull();
  });

  it('labels every anchor with the approved mockup wording', () => {
    // Typed as Record<AnchorKey, string>, so this stays an EXHAUSTIVE assertion: adding an anchor
    // without a label fails to compile here, and adding one with a label fails this equality
    // until it is listed. That is why the three spec #1751 clocks are added rather than the
    // assertion being loosened to a subset check.
    const expected: Record<AnchorKey, string> = {
      'job.scheduled_start': 'the appointment',
      'lead.walkthrough_scheduled_at': 'the walkthrough',
      'lead.created_at': 'the lead arriving',
      'lead.contacted_at': 'first contact',
      'lead.last_visit_completed_at': 'the completed walkthrough',
      'invoice.due_date': 'the invoice due date',
      'estimate.valid_until': 'the estimate expiration',
      'task.due_at': 'the task due date',
    };
    expect(ANCHOR_LABELS).toEqual(expected);
  });
});

describe('anchors - task', () => {
  it('registers the task due date as an anchor with both labels', () => {
    // Both maps are Record<AnchorKey, string>, so the key set is compiler-forced and
    // ALL_ANCHOR_KEYS derives from the first of them - no second hand-written copy.
    expect(ANCHOR_LABELS['task.due_at']).toBe('the task due date');
    expect(ALL_ANCHOR_KEYS).toContain('task.due_at');
    expect(
      describeAnchoredWait({ mode: 'anchored', anchor: 'task.due_at', direction: 'after', offset_minutes: 1440 }),
    ).toBe('1 day after the task due date');
  });

  it('reads the task due date off EntityState', () => {
    const due = new Date('2026-09-01T17:00:00.000Z');
    expect(anchorDateFor('task.due_at', { taskDueAt: due })?.toISOString()).toBe(due.toISOString());
    expect(anchorDateFor('task.due_at', {})).toBeNull();
  });

  // Spec B slice 5 flipped this on, in the same change that added TASK_DATE_ANCHORED. Until
  // that enum value existed, offering the anchor would have let the builder compose a
  // date-mode task trigger the backend could not store.
  it('OFFERS the task due date now that the trigger consuming it has shipped', () => {
    expect(ANCHORS_FOR_ENTITY.task).toEqual(['task.due_at']);
  });

  it('is not a lead stage clock, so BOTH directions stay legal - reminder before, chase after', () => {
    // The one anchor that gives an entity both a reminder and an overdue chase from a single
    // trigger, which is why Spec B has no separate overdue trigger.
    expect(LEAD_STAGE_CLOCK_ANCHORS.has('task.due_at')).toBe(false);
  });
});
