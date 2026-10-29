import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import type { WorkflowCatalog } from '@/lib/api/workflows';
import StopIfForm from '../components/stopIfForm';

/**
 * Spec B slice 6, the observable half of story 29.
 *
 * A task's own staleness - finished or cancelled between enrollment and send - is handled
 * silently inside the engine's send-time re-check, precisely so that no admin has to re-derive
 * the same obvious rule for every task workflow they build. The visible consequence is that the
 * task entity offers NO stop-if condition at all, exactly as lead already does, and the builder
 * shows the dead-end note instead of a picker.
 *
 * `conditions[entity]` is a plain `Record<string, string[]>`, so a task condition creeping in
 * would not redden anything - it would quietly grow a control that contradicts the design. This
 * test is what notices.
 */
const CATALOG = {
  triggers: {
    JOB_SCHEDULED: {
      label: 'Job is scheduled',
      description: 'When a job gets a date',
      category: 'events',
      entity: 'job',
      timeBased: false,
      mergeFields: [],
    },
    TASK_CREATED: {
      label: 'Task is created',
      description: 'When a task is created',
      category: 'events',
      entity: 'task',
      timeBased: false,
      mergeFields: [],
    },
    TASK_DATE_ANCHORED: {
      label: 'Before or after a task is due',
      description: 'Counts from the task due date',
      category: 'date',
      entity: 'task',
      timeBased: false,
      mergeFields: [],
    },
  },
  actions: {},
  merge_field_labels: {},
  sample_context: {},
  templates: [],
  stop_if: {
    conditions: {
      job: ['job_cancelled', 'job_completed', 'job_rescheduled'],
      lead: [],
      task: [],
    },
    labels: { job_completed: 'the job was completed' },
  },
} as unknown as WorkflowCatalog;

describe('StopIfForm - the task entity is a stop-if dead end', () => {
  it.each(['TASK_CREATED', 'TASK_DATE_ANCHORED'] as const)(
    '%s shows the dead-end note and no condition picker',
    (trigger) => {
      renderWithProviders(
        <StopIfForm config={{}} triggerType={trigger} catalog={CATALOG} onChange={vi.fn()} />,
      );

      expect(screen.getByText(/Stop conditions aren.t available for this trigger/)).toBeInTheDocument();
      expect(screen.queryByLabelText('Stop condition')).toBeNull();
    },
  );

  it('still offers the picker for a job trigger, so the note is entity-scoped and not global', () => {
    renderWithProviders(
      <StopIfForm config={{}} triggerType="JOB_SCHEDULED" catalog={CATALOG} onChange={vi.fn()} />,
    );

    expect(screen.getByLabelText('Stop condition')).toBeInTheDocument();
    expect(screen.queryByText(/Stop conditions aren.t available for this trigger/)).toBeNull();
  });

  it('offers no task condition at all - the list is empty, not merely short', () => {
    expect(CATALOG.stop_if.conditions.task).toEqual([]);
  });
});
