import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import SubjectPicker from '../SubjectPicker';
import type { WorkflowCatalog } from '@/lib/api/workflows';

/**
 * A trimmed but shape-faithful catalog (same trimming approach as
 * ../../step-forms.fixture.ts's FORM_CATALOG — only the `triggers` field
 * SubjectPicker actually reads, cast past the rest of WorkflowCatalog's
 * shape). Per-subject event counts are deliberately chosen to (a) differ
 * from each other and (b) differ from the approved mockup's hardcoded tile
 * hints (Jobs "5 events", Estimates "4 events", Invoices "3 events", Leads
 * "7 events") — if SubjectPicker ever hardcodes those mockup numbers instead
 * of deriving them from `catalog.triggers`, these assertions catch it. Each
 * subject also carries one non-`'events'`-category trigger (timed or date)
 * to prove the tile count excludes anything that isn't a plain event.
 */
const CATALOG = {
  triggers: {
    JOB_SCHEDULED: {
      label: 'Job is scheduled',
      description: 'When a job gets booked on the calendar',
      category: 'events',
      entity: 'job',
      timeBased: false,
      mergeFields: [],
    },
    JOB_COMPLETED: {
      label: 'Job is completed',
      description: 'When a job is marked complete',
      category: 'events',
      entity: 'job',
      timeBased: false,
      mergeFields: [],
    },
    BEFORE_JOB_START: {
      label: 'Before a job starts',
      description: 'A set time before the job’s scheduled start',
      category: 'timed',
      entity: 'job',
      timeBased: true,
      defaultOffsetMinutes: 1440,
      mergeFields: [],
    },

    ESTIMATE_SENT: {
      label: 'Estimate is sent',
      description: 'When you send an estimate to a customer',
      category: 'events',
      entity: 'estimate',
      timeBased: false,
      mergeFields: [],
    },
    ESTIMATE_APPROVED: {
      label: 'Estimate is approved',
      description: 'When the customer accepts',
      category: 'events',
      entity: 'estimate',
      timeBased: false,
      mergeFields: [],
    },
    ESTIMATE_DECLINED: {
      label: 'Estimate is declined',
      description: 'When the customer declines',
      category: 'events',
      entity: 'estimate',
      timeBased: false,
      mergeFields: [],
    },
    ESTIMATE_FOLLOW_UP: {
      label: 'Estimate follow-up',
      description: 'A set time after the estimate is sent with no response',
      category: 'timed',
      entity: 'estimate',
      timeBased: true,
      mergeFields: [],
    },

    INVOICE_PAID: {
      label: 'Invoice is paid',
      description: 'When payment is received',
      category: 'events',
      entity: 'invoice',
      timeBased: false,
      mergeFields: [],
    },
    INVOICE_OVERDUE: {
      label: 'Invoice is overdue',
      description: 'When it is not settled by the due date',
      category: 'timed',
      entity: 'invoice',
      timeBased: true,
      mergeFields: [],
    },

    LEAD_CREATED: {
      label: 'Lead is created',
      description: 'When a new lead comes in',
      category: 'events',
      entity: 'lead',
      timeBased: false,
      mergeFields: [],
    },
    LEAD_ASSIGNED: {
      label: 'Lead is assigned',
      description: 'When a lead is assigned to someone',
      category: 'events',
      entity: 'lead',
      timeBased: false,
      mergeFields: [],
    },
    WALKTHROUGH_SCHEDULED: {
      label: 'Walkthrough is scheduled',
      description: 'When a walkthrough gets booked',
      category: 'events',
      entity: 'lead',
      timeBased: false,
      mergeFields: [],
    },
    WALKTHROUGH_RESCHEDULED: {
      label: 'Walkthrough is rescheduled',
      description: 'When its date or time changes',
      category: 'events',
      entity: 'lead',
      timeBased: false,
      mergeFields: [],
    },
    LEAD_DATE_ANCHORED: {
      label: 'Before or after the walkthrough',
      description: 'Counts from the walkthrough’s scheduled time',
      category: 'date',
      entity: 'lead',
      timeBased: true,
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
    TASK_ASSIGNED: {
      label: 'Someone is added to a task',
      description: 'When a person is added to a task that already existed',
      category: 'events',
      entity: 'task',
      timeBased: false,
      mergeFields: [],
    },
    TASK_COMMENT_ADDED: {
      label: 'Someone comments on a task',
      description: 'When a comment is added to a task',
      category: 'events',
      entity: 'task',
      timeBased: false,
      mergeFields: [],
    },
    TASK_DELETED: {
      label: 'Task is deleted',
      description: 'When a task is deleted',
      category: 'events',
      entity: 'task',
      timeBased: false,
      mergeFields: [],
    },
  },
} as unknown as WorkflowCatalog;

const SEARCH_PLACEHOLDER = 'Search all triggers… try “paid”, “reminder”, “completed”';

function renderPicker(onPick = vi.fn()) {
  renderWithProviders(<SubjectPicker catalog={CATALOG} onPick={onPick} />);
  return onPick;
}

describe('SubjectPicker', () => {
  it('renders all five subject tiles with catalog-derived event counts (not the mockup’s hardcoded hints)', () => {
    renderPicker();

    // Each count is asserted INSIDE its own tile. A bare getByText('1 event') was ambiguous
    // the moment a second subject had exactly one event, and it never proved which tile the
    // count belonged to in the first place.
    const tile = (label: string) => screen.getByText(label).closest('button')!;

    expect(tile('Jobs')).toHaveTextContent('2 events'); // excludes BEFORE_JOB_START (timed)
    expect(tile('Estimates')).toHaveTextContent('3 events'); // excludes ESTIMATE_FOLLOW_UP (timed)
    expect(tile('Invoices')).toHaveTextContent('1 event'); // singular; excludes INVOICE_OVERDUE (timed)
    expect(tile('Leads & Walkthroughs')).toHaveTextContent('4 events'); // excludes LEAD_DATE_ANCHORED (date)

    // Spec B's fifth tile. The tile list is driven by ENTITY_ORDER, an array LITERAL, where a
    // missing member is assignable to the wider element type - so this tile could have been
    // omitted with nothing anywhere going red. This assertion is the substitute for the
    // compile error that cannot exist.
    // Spec B slice 2 added the second task trigger, slice 3 the third and slice 4 the fourth;
    // the count is catalog-derived, so it followed on its own.
    expect(tile('Tasks')).toHaveTextContent('4 events');
  });

  it('picks the task subject from its tile', () => {
    const onPick = renderPicker();
    fireEvent.click(screen.getByText('Tasks').closest('button')!);
    expect(onPick).toHaveBeenCalledWith('task');
  });

  it('surfaces the task trigger in search, attributed to the Tasks subject', () => {
    const onPick = renderPicker();
    fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), { target: { value: 'task is created' } });

    fireEvent.click(screen.getByText('Task is created').closest('button')!);
    expect(onPick).toHaveBeenCalledWith('task', 'TASK_CREATED');
  });

  it('surfaces the task-assigned trigger in search too, attributed to the Tasks subject', () => {
    const onPick = renderPicker();
    fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), { target: { value: 'added to a task' } });

    fireEvent.click(screen.getByText('Someone is added to a task').closest('button')!);
    expect(onPick).toHaveBeenCalledWith('task', 'TASK_ASSIGNED');
  });

  it('surfaces the task-deleted trigger in search too, attributed to the Tasks subject', () => {
    const onPick = renderPicker();
    fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), { target: { value: 'task is deleted' } });
    fireEvent.click(screen.getByText('Task is deleted').closest('button')!);
    expect(onPick).toHaveBeenCalledWith('task', 'TASK_DELETED');
  });

  it('surfaces the task-comment trigger in search too, attributed to the Tasks subject', () => {
    const onPick = renderPicker();
    fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), { target: { value: 'comments on a task' } });

    fireEvent.click(screen.getByText('Someone comments on a task').closest('button')!);
    expect(onPick).toHaveBeenCalledWith('task', 'TASK_COMMENT_ADDED');
  });

  it('clicking a tile calls onPick with the subject alone — no second argument', () => {
    const onPick = renderPicker();

    fireEvent.click(screen.getByText('Invoices').closest('button')!);

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith('invoice');
    // Guards against a stub that always passes `(subject, undefined)`, which
    // would satisfy toHaveBeenCalledWith('invoice') too loosely elsewhere —
    // the call must genuinely carry only one argument.
    expect(onPick.mock.calls[0]).toHaveLength(1);
  });

  it('search matches across every subject’s triggers (not just one) and surfaces INVOICE_PAID for "paid"', () => {
    const onPick = renderPicker();

    const search = screen.getByPlaceholderText(SEARCH_PLACEHOLDER);
    fireEvent.change(search, { target: { value: 'paid' } });

    // Tiles are replaced by the results list while a query is active.
    expect(screen.queryByText('Jobs')).not.toBeInTheDocument();
    expect(screen.getByText('Invoice is paid')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Invoice is paid').closest('button')!);

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith('invoice', 'INVOICE_PAID');
    expect(onPick.mock.calls[0]).toHaveLength(2);
  });

  it('shows the mockup’s no-matches copy for a query that hits nothing', () => {
    renderPicker();

    const search = screen.getByPlaceholderText(SEARCH_PLACEHOLDER);
    fireEvent.change(search, { target: { value: 'zzzznomatch' } });

    expect(screen.getByText('No matches. Try “completed”, “paid”, “reminder”, “before”.')).toBeInTheDocument();
  });
});
