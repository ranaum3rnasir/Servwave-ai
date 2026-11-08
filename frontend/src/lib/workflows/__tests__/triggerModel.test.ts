import { describe, it, expect } from 'vitest';
import { selectionToTrigger, triggerToSelection, DATE_ANCHORED_BY_SUBJECT, type WorkflowCatalog } from '../triggerModel';
import type { AutomationTriggerType as ModelTriggerType } from '../triggerModel';
import type { AutomationTriggerType as ApiTriggerType } from '../../api/workflows';

/**
 * Minimal slice of the real served catalog (backend/src/services/automations/
 * catalog.ts TRIGGERS + ANCHOR_OPTIONS) — only the trigger types and anchor
 * labels these tests actually exercise, shaped exactly like the real thing
 * (`triggers` keyed by type with `entity`, plus `anchors` keyed by entity).
 */
const catalogFixture: WorkflowCatalog = {
  triggers: {
    JOB_COMPLETED: { entity: 'job' },
    BEFORE_JOB_START: { entity: 'job' },
    INVOICE_DATE_ANCHORED: { entity: 'invoice' },
    JOB_SUB_STATUS_ENTERED: { entity: 'job' },
    // Spec B. `catalogFixture` is TYPED as WorkflowCatalog, whose `triggers` is keyed by
    // AutomationTriggerType - so these two entries are the type pin for this module's own
    // hand-written copy of that union. Nothing else on the frontend would notice a copy that
    // drifted behind the backend: the catalog arrives from the API as data.
    TASK_CREATED: { entity: 'task' },
    TASK_ASSIGNED: { entity: 'task' },
    TASK_COMMENT_ADDED: { entity: 'task' },
    // Slice 14 ("Task is done") - the same type pin, for the same reason.
    TASK_COMPLETED: { entity: 'task' },
    // Slice 15 ("Task is cancelled").
    TASK_CANCELLED: { entity: 'task' },
    TASK_DELETED: { entity: 'task' },
    TASK_DATE_ANCHORED: { entity: 'task' },
  },
  anchors: {
    invoice: [{ key: 'invoice.due_date', label: 'the invoice due date' }],
    // Spec B slice 5. triggerToSelection cross-checks a saved anchor against the SERVED
    // per-entity list, so a task reminder cannot round-trip without this entry either.
    task: [{ key: 'task.due_at', label: 'the task due date' }],
  },
};

describe('triggerModel', () => {
  describe('selectionToTrigger', () => {
    it('maps a date selection to the entity date-anchored trigger', () => {
      expect(
        selectionToTrigger({ subject: 'invoice', mode: 'date', anchor: 'invoice.due_date', direction: 'before', offsetMinutes: 1440 }),
      ).toEqual({
        trigger_type: 'INVOICE_DATE_ANCHORED',
        trigger_config: { anchor: 'invoice.due_date', direction: 'before', offset_minutes: 1440 },
      });
    });

    it('maps an event selection with no config', () => {
      expect(selectionToTrigger({ subject: 'job', mode: 'event', eventTrigger: 'JOB_COMPLETED' })).toEqual({
        trigger_type: 'JOB_COMPLETED',
        trigger_config: null,
      });
    });

    it('returns null for an incomplete date selection (the brief-given example: nothing set)', () => {
      expect(selectionToTrigger({ subject: 'invoice', mode: 'date' })).toBeNull();
    });

    it('returns null for a date selection missing only the anchor', () => {
      expect(
        selectionToTrigger({ subject: 'invoice', mode: 'date', direction: 'before', offsetMinutes: 1440 }),
      ).toBeNull();
    });

    it('returns null for a date selection missing only the direction', () => {
      expect(
        selectionToTrigger({ subject: 'invoice', mode: 'date', anchor: 'invoice.due_date', offsetMinutes: 1440 }),
      ).toBeNull();
    });

    it('returns null for a date selection missing only offsetMinutes', () => {
      expect(
        selectionToTrigger({ subject: 'invoice', mode: 'date', anchor: 'invoice.due_date', direction: 'before' }),
      ).toBeNull();
    });

    it('does NOT treat an offsetMinutes of 0 as missing (0 is a valid "immediately" offset)', () => {
      expect(
        selectionToTrigger({ subject: 'job', mode: 'date', anchor: 'job.scheduled_start', direction: 'after', offsetMinutes: 0 }),
      ).toEqual({
        trigger_type: 'JOB_DATE_ANCHORED',
        trigger_config: { anchor: 'job.scheduled_start', direction: 'after', offset_minutes: 0 },
      });
    });

    it('returns null for an event selection with no eventTrigger chosen', () => {
      expect(selectionToTrigger({ subject: 'job', mode: 'event' })).toBeNull();
    });

    it('ignores a stale eventTrigger left over from a previous mode when mode is "date"', () => {
      expect(
        selectionToTrigger({
          subject: 'invoice',
          mode: 'date',
          eventTrigger: 'INVOICE_PAID',
          anchor: 'invoice.due_date',
          direction: 'before',
          offsetMinutes: 1440,
        }),
      ).toEqual({
        trigger_type: 'INVOICE_DATE_ANCHORED',
        trigger_config: { anchor: 'invoice.due_date', direction: 'before', offset_minutes: 1440 },
      });
    });

    it('ignores stale date fields left over from a previous mode when mode is "event"', () => {
      expect(
        selectionToTrigger({
          subject: 'invoice',
          mode: 'event',
          eventTrigger: 'INVOICE_PAID',
          anchor: 'invoice.due_date',
          direction: 'before',
          offsetMinutes: 1440,
        }),
      ).toEqual({
        trigger_type: 'INVOICE_PAID',
        trigger_config: null,
      });
    });

    // SRVW-113 — JOB_SUB_STATUS_ENTERED is the one event trigger that still needs a
    // trigger_config (which sub-status), unlike every other event trigger's bare null.
    it('maps a JOB_SUB_STATUS_ENTERED selection to a sub_status_id trigger_config', () => {
      expect(
        selectionToTrigger({ subject: 'job', mode: 'event', eventTrigger: 'JOB_SUB_STATUS_ENTERED', subStatusId: 'sub-1' }),
      ).toEqual({
        trigger_type: 'JOB_SUB_STATUS_ENTERED',
        trigger_config: { sub_status_id: 'sub-1' },
      });
    });

    it('returns null for JOB_SUB_STATUS_ENTERED with no sub-status picked yet', () => {
      expect(
        selectionToTrigger({ subject: 'job', mode: 'event', eventTrigger: 'JOB_SUB_STATUS_ENTERED' }),
      ).toBeNull();
    });

    it('ignores a stale subStatusId when the event trigger is something else', () => {
      expect(
        selectionToTrigger({ subject: 'job', mode: 'event', eventTrigger: 'JOB_COMPLETED', subStatusId: 'sub-1' }),
      ).toEqual({
        trigger_type: 'JOB_COMPLETED',
        trigger_config: null,
      });
    });
  });

  describe('round-trips through selectionToTrigger -> triggerToSelection', () => {
    it('round-trips a date selection back out of a saved workflow', () => {
      const sel = {
        subject: 'invoice' as const,
        mode: 'date' as const,
        anchor: 'invoice.due_date' as const,
        direction: 'before' as const,
        offsetMinutes: 1440,
      };
      const saved = selectionToTrigger(sel)!;
      expect(triggerToSelection(saved.trigger_type, saved.trigger_config, catalogFixture)).toEqual(sel);
    });

    it('round-trips an event selection back out of a saved workflow', () => {
      const sel = { subject: 'job' as const, mode: 'event' as const, eventTrigger: 'JOB_COMPLETED' as const };
      const saved = selectionToTrigger(sel)!;
      expect(triggerToSelection(saved.trigger_type, saved.trigger_config, catalogFixture)).toEqual(sel);
    });

    it('round-trips a JOB_SUB_STATUS_ENTERED selection back out of a saved workflow', () => {
      const sel = { subject: 'job' as const, mode: 'event' as const, eventTrigger: 'JOB_SUB_STATUS_ENTERED' as const, subStatusId: 'sub-1' };
      const saved = selectionToTrigger(sel)!;
      expect(triggerToSelection(saved.trigger_type, saved.trigger_config, catalogFixture)).toEqual(sel);
    });
  });

  describe('triggerToSelection — combinations that do not cleanly map back', () => {
    it('returns null for a trigger_type the catalog does not describe', () => {
      expect(triggerToSelection('JOB_CANCELLED', null, catalogFixture)).toBeNull();
    });

    it('returns null for a legacy timed trigger (bare offset config has no home in the two-mode shape)', () => {
      expect(triggerToSelection('BEFORE_JOB_START', { offset_minutes: 1440 }, catalogFixture)).toBeNull();
    });

    it('returns null for a date-anchored trigger whose config is missing anchor/direction', () => {
      expect(triggerToSelection('INVOICE_DATE_ANCHORED', { offset_minutes: 1440 }, catalogFixture)).toBeNull();
    });

    it('returns null when the config anchor does not belong to the trigger entity', () => {
      expect(
        triggerToSelection(
          'INVOICE_DATE_ANCHORED',
          { anchor: 'job.scheduled_start', direction: 'before', offset_minutes: 1440 },
          catalogFixture,
        ),
      ).toBeNull();
    });

    it('returns null when the catalog lists no anchors at all for the entity (not just a mismatched one)', () => {
      const catalogWithoutJobAnchors: WorkflowCatalog = {
        triggers: { JOB_DATE_ANCHORED: { entity: 'job' } },
        anchors: {}, // no 'job' entry
      };
      expect(
        triggerToSelection(
          'JOB_DATE_ANCHORED',
          { anchor: 'job.scheduled_start', direction: 'before', offset_minutes: 60 },
          catalogWithoutJobAnchors,
        ),
      ).toBeNull();
    });

    it('returns null for JOB_SUB_STATUS_ENTERED with a null config (unlike every other event trigger, null is incomplete here)', () => {
      expect(triggerToSelection('JOB_SUB_STATUS_ENTERED', null, catalogFixture)).toBeNull();
    });

    it('returns null for JOB_SUB_STATUS_ENTERED with a malformed config', () => {
      expect(
        triggerToSelection('JOB_SUB_STATUS_ENTERED', { offset_minutes: 60 } as never, catalogFixture),
      ).toBeNull();
    });
  });

  describe('task triggers (Spec B)', () => {
    it('maps the task-assigned event selection to its wire shape', () => {
      expect(selectionToTrigger({ subject: 'task', mode: 'event', eventTrigger: 'TASK_ASSIGNED' })).toEqual({
        trigger_type: 'TASK_ASSIGNED',
        trigger_config: null,
      });
    });

    it('round-trips a task event selection back to the task subject', () => {
      expect(triggerToSelection('TASK_ASSIGNED', null, catalogFixture)).toEqual({
        subject: 'task',
        mode: 'event',
        eventTrigger: 'TASK_ASSIGNED',
      });
    });

    it('maps the task-comment event selection to its wire shape', () => {
      expect(selectionToTrigger({ subject: 'task', mode: 'event', eventTrigger: 'TASK_COMMENT_ADDED' })).toEqual({
        trigger_type: 'TASK_COMMENT_ADDED',
        trigger_config: null,
      });
    });

    it('round-trips a task comment selection back to the task subject', () => {
      expect(triggerToSelection('TASK_COMMENT_ADDED', null, catalogFixture)).toEqual({
        subject: 'task',
        mode: 'event',
        eventTrigger: 'TASK_COMMENT_ADDED',
      });
    });

    // A COMPILE-TIME pin, not a runtime one: vitest does not typecheck, so this assertion alone
    // cannot fail. The frontend `tsc --noEmit` CI step checks this file, and removing
    // TASK_COMPLETED from either hand-written union fails tsc on these two `satisfies` lines.
    it('TASK_COMPLETED is a member of both hand-written trigger unions (enforced by tsc)', () => {
      const pins = ['TASK_COMPLETED' satisfies ModelTriggerType, 'TASK_COMPLETED' satisfies ApiTriggerType];
      expect(pins).toEqual(['TASK_COMPLETED', 'TASK_COMPLETED']);
    });

    it('maps the task-done event selection to its wire shape', () => {
      expect(selectionToTrigger({ subject: 'task', mode: 'event', eventTrigger: 'TASK_COMPLETED' })).toEqual({
        trigger_type: 'TASK_COMPLETED',
        trigger_config: null,
      });
    });

    it('round-trips a task-done selection back to the task subject', () => {
      expect(triggerToSelection('TASK_COMPLETED', null, catalogFixture)).toEqual({
        subject: 'task',
        mode: 'event',
        eventTrigger: 'TASK_COMPLETED',
      });
    });

    // Slice 15: the same compile-time pin for "Task is cancelled" (tsc fails if either union loses it).
    it('TASK_CANCELLED is a member of both hand-written trigger unions (enforced by tsc)', () => {
      const pins = ['TASK_CANCELLED' satisfies ModelTriggerType, 'TASK_CANCELLED' satisfies ApiTriggerType];
      expect(pins).toEqual(['TASK_CANCELLED', 'TASK_CANCELLED']);
    });

    it('maps the task-cancelled event selection to its wire shape', () => {
      expect(selectionToTrigger({ subject: 'task', mode: 'event', eventTrigger: 'TASK_CANCELLED' })).toEqual({
        trigger_type: 'TASK_CANCELLED',
        trigger_config: null,
      });
    });

    it('round-trips a task-cancelled selection back to the task subject', () => {
      expect(triggerToSelection('TASK_CANCELLED', null, catalogFixture)).toEqual({
        subject: 'task',
        mode: 'event',
        eventTrigger: 'TASK_CANCELLED',
      });
    });

    it('maps the task-deleted event selection to its wire shape', () => {
      expect(selectionToTrigger({ subject: 'task', mode: 'event', eventTrigger: 'TASK_DELETED' })).toEqual({
        trigger_type: 'TASK_DELETED',
        trigger_config: null,
      });
    });

    it('round-trips a task deletion selection back to the task subject', () => {
      expect(triggerToSelection('TASK_DELETED', null, catalogFixture)).toEqual({
        subject: 'task',
        mode: 'event',
        eventTrigger: 'TASK_DELETED',
      });
    });

    // Spec B slice 5. Without the DATE_ANCHORED_BY_SUBJECT entry, selectionToTrigger returns
    // null for a fully-filled-in task date selection, so the builder's Save simply does
    // nothing and the office never learns why.
    it('maps a task due-date selection to TASK_DATE_ANCHORED in the BEFORE direction', () => {
      expect(
        selectionToTrigger({ subject: 'task', mode: 'date', anchor: 'task.due_at', direction: 'before', offsetMinutes: 1440 }),
      ).toEqual({
        trigger_type: 'TASK_DATE_ANCHORED',
        trigger_config: { anchor: 'task.due_at', direction: 'before', offset_minutes: 1440 },
      });
    });

    it('maps the same selection in the AFTER direction - the overdue chase, one trigger', () => {
      expect(
        selectionToTrigger({ subject: 'task', mode: 'date', anchor: 'task.due_at', direction: 'after', offsetMinutes: 1440 }),
      ).toEqual({
        trigger_type: 'TASK_DATE_ANCHORED',
        trigger_config: { anchor: 'task.due_at', direction: 'after', offset_minutes: 1440 },
      });
    });

    it('round-trips a saved task reminder back into the date-mode selection', () => {
      expect(
        triggerToSelection(
          'TASK_DATE_ANCHORED',
          { anchor: 'task.due_at', direction: 'after', offset_minutes: 1440 },
          catalogFixture,
        ),
      ).toEqual({
        subject: 'task',
        mode: 'date',
        anchor: 'task.due_at',
        direction: 'after',
        offsetMinutes: 1440,
      });
    });
  });

  describe('DATE_ANCHORED_BY_SUBJECT', () => {
    it('is a complete lookup covering all five subjects', () => {
      expect(DATE_ANCHORED_BY_SUBJECT).toEqual({
        job: 'JOB_DATE_ANCHORED',
        estimate: 'ESTIMATE_DATE_ANCHORED',
        invoice: 'INVOICE_DATE_ANCHORED',
        lead: 'LEAD_DATE_ANCHORED',
        task: 'TASK_DATE_ANCHORED',
      });
    });
  });
});
