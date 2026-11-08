import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import TriggerForm from './TriggerForm';
import api from '@/lib/axios';
import type { WorkflowCatalog } from '@/lib/api/workflows';

/**
 * A trimmed but shape-faithful catalog (same trimming approach as the B3-B6
 * test fixtures — SubjectPicker.test.tsx/EventModePanel.test.tsx/
 * TriggerReadback.test.tsx each define their own local catalog rather than
 * reusing the shared step-forms.fixture.ts, since this test needs `anchors`
 * populated across every subject plus multiple categories per subject).
 * Covers: 2+ 'events' triggers on job/invoice/lead, one legacy 'timed'
 * trigger (BEFORE_JOB_START, for the legacy-fallback tests), and all four
 * 'date' triggers (for date-mode + round-trip tests on every subject).
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
    JOB_DATE_ANCHORED: {
      label: 'Before or after the appointment',
      description: 'Counts from the job’s scheduled time',
      category: 'date',
      entity: 'job',
      timeBased: false,
      mergeFields: [],
    },
    JOB_SUB_STATUS_ENTERED: {
      label: 'Job enters a sub-status',
      description: 'When a job is given a specific sub-status label',
      category: 'events',
      entity: 'job',
      timeBased: false,
      mergeFields: [],
    },
    INVOICE_SENT: {
      label: 'Invoice is sent',
      description: 'When you send an invoice to a customer',
      category: 'events',
      entity: 'invoice',
      timeBased: false,
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
    INVOICE_DATE_ANCHORED: {
      label: 'Before or after the invoice due date',
      description: 'Counts from when payment is due',
      category: 'date',
      entity: 'invoice',
      timeBased: false,
      mergeFields: [],
    },
    ESTIMATE_DATE_ANCHORED: {
      label: 'Before or after the estimate expiration',
      description: 'Counts from when the estimate expires',
      category: 'date',
      entity: 'estimate',
      timeBased: false,
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
    LEAD_DATE_ANCHORED: {
      label: 'Before or after the walkthrough',
      description: 'Counts from the walkthrough’s scheduled time',
      category: 'date',
      entity: 'lead',
      timeBased: false,
      mergeFields: [],
    },
    // Spec B slice 5: the fifth subject's date trigger.
    TASK_DATE_ANCHORED: {
      label: 'Before or after the task due date',
      description: 'Counts from when the task is due',
      category: 'date',
      entity: 'task',
      timeBased: false,
      mergeFields: [],
    },
  },
  anchors: {
    job: [{ key: 'job.scheduled_start', label: 'the appointment' }],
    estimate: [{ key: 'estimate.valid_until', label: 'the estimate expiration' }],
    invoice: [{ key: 'invoice.due_date', label: 'the invoice due date' }],
    lead: [{ key: 'lead.walkthrough_scheduled_at', label: 'the walkthrough' }],
    task: [{ key: 'task.due_at', label: 'the task due date' }],
  },
  merge_field_labels: {},
  sample_context: {},
  templates: [],
  stop_if: { conditions: {}, labels: {} },
} as unknown as WorkflowCatalog;

/** Same catalog, but `job` has no served anchor — ModeFork should lock date mode for that subject. */
const CATALOG_NO_JOB_ANCHOR = { ...CATALOG, anchors: { ...CATALOG.anchors, job: [] } } as unknown as WorkflowCatalog;

function props(overrides: Partial<React.ComponentProps<typeof TriggerForm>> = {}) {
  return {
    triggerType: 'JOB_COMPLETED' as const,
    triggerConfig: null,
    stepCount: 0,
    catalog: CATALOG,
    onSetTrigger: vi.fn(),
    ...overrides,
  };
}


// ── catalog loading ──────────────────────────────────────────────────────────

describe('TriggerForm — catalog loading', () => {
  it('shows a loading placeholder — not the picker, not the footnote — while the catalog has not resolved yet', () => {
    renderWithProviders(<TriggerForm {...props({ catalog: undefined })} />);
    expect(screen.queryByText('What is this automation about?')).not.toBeInTheDocument();
    expect(screen.queryByText(/Step 1 of 3/)).not.toBeInTheDocument();
  });
});

// ── a brand-new, never-configured automation (triggerConfigured=false) ──────
// Regression coverage for the 2026-07-20 QA pass finding: a genuinely new
// automation's `triggerType` is `blankState()`'s placeholder ('JOB_COMPLETED',
// the same value the rest of this file's fixtures use to mean "already
// configured") — without `triggerConfigured=false`, TriggerForm has no way to
// tell "the office picked Job completed" apart from "nobody has touched this
// yet", and used to silently show the former.

describe('TriggerForm — a brand-new, never-configured automation (triggerConfigured=false)', () => {
  it('shows the blank subject picker, never the pre-seeded breadcrumb/readback, even though triggerType is a real catalog match', () => {
    renderWithProviders(<TriggerForm {...props({ triggerType: 'JOB_COMPLETED', triggerConfig: null, triggerConfigured: false })} />);

    expect(screen.getByText('Step 1 of 3 — choose a subject')).toBeInTheDocument();
    expect(screen.getByText('What is this automation about?')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Jobs — change subject/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /Job is completed/ })).not.toBeInTheDocument();
  });

  it('does not show the legacy-trigger banner — a never-touched draft is not "an older timing setup"', () => {
    renderWithProviders(<TriggerForm {...props({ triggerType: 'JOB_COMPLETED', triggerConfig: null, triggerConfigured: false })} />);
    expect(screen.queryByText(/older timing setup/)).not.toBeInTheDocument();
  });

  it('picking a subject/mode/event from scratch still works normally and commits', () => {
    const onSetTrigger = vi.fn();
    renderWithProviders(
      <TriggerForm {...props({ triggerType: 'JOB_COMPLETED', triggerConfig: null, triggerConfigured: false, onSetTrigger })} />,
    );

    fireEvent.click(screen.getByText('Invoices').closest('button')!);
    fireEvent.click(screen.getByText('Right after something happens').closest('button')!);
    fireEvent.click(screen.getByText('Invoice is sent').closest('button')!);

    expect(onSetTrigger).toHaveBeenCalledTimes(1);
    expect(onSetTrigger).toHaveBeenCalledWith('INVOICE_SENT', null);
  });
});

// ── send-window removal ──────────────────────────────────────────────────────

describe('TriggerForm — send-window removal', () => {
  it('promises no global quiet-hours setting anywhere (that setting was cancelled)', () => {
    renderWithProviders(<TriggerForm {...props()} />);
    // The old footnote pointed at an "Automation preferences" screen that will
    // never exist. Naming a setting the product does not have is exactly the
    // dead-control problem removing the toggle was meant to solve.
    expect(screen.queryByText(/quiet hours/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/global setting/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Automation preferences/i)).not.toBeInTheDocument();
  });

  it('renders no SendWindowToggle control anywhere on the surface', () => {
    renderWithProviders(<TriggerForm {...props()} />);
    expect(screen.queryByText('When can it send?')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Any time' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Business hours/ })).not.toBeInTheDocument();
  });

  it('the props type no longer accepts sendWindow/onSetSendWindow at all (narrowed, not just unused)', () => {
    type Props = React.ComponentProps<typeof TriggerForm>;
    type StillHasSendWindow = 'sendWindow' extends keyof Props ? true : false;
    type StillHasOnSetSendWindow = 'onSetSendWindow' extends keyof Props ? true : false;
    const hasSendWindow: StillHasSendWindow = false;
    const hasOnSetSendWindow: StillHasOnSetSendWindow = false;
    expect(hasSendWindow).toBe(false);
    expect(hasOnSetSendWindow).toBe(false);
  });
});

// ── amber "changing the trigger" warning (unchanged behavior) ───────────────

describe('TriggerForm — amber "changing the trigger" warning', () => {
  it('shows only when the workflow already has steps', () => {
    const { rerender } = renderWithProviders(<TriggerForm {...props({ stepCount: 0 })} />);
    expect(screen.queryByText(/Changing the trigger can make steps invalid/)).not.toBeInTheDocument();

    rerender(<TriggerForm {...props({ stepCount: 2 })} />);
    expect(screen.getByText(/Changing the trigger can make steps invalid/)).toBeInTheDocument();
  });
});

// ── building a NEW event-mode trigger, end to end ────────────────────────────

describe('TriggerForm — building a NEW event-mode trigger from scratch', () => {
  it('breadcrumb reset -> SubjectPicker -> ModeFork -> EventModePanel -> readback, committing only once complete', () => {
    const onSetTrigger = vi.fn();
    // Seed from the default new-automation trigger (job/event/JOB_COMPLETED,
    // exactly useWorkflowDraft's blankState()) and use the breadcrumb to
    // start over — the realistic "build something new" flow, since a brand
    // new draft always already has a default trigger seeded.
    renderWithProviders(<TriggerForm {...props({ triggerType: 'JOB_COMPLETED', triggerConfig: null, onSetTrigger })} />);
    fireEvent.click(screen.getByRole('button', { name: /Jobs — change subject/ }));

    // Back at stage 1.
    expect(screen.getByText('Step 1 of 3 — choose a subject')).toBeInTheDocument();
    expect(screen.getByText('What is this automation about?')).toBeInTheDocument();
    expect(onSetTrigger).not.toHaveBeenCalled();

    // SubjectPicker's own tile label is the longer "Leads & Walkthroughs"
    // (its docblock explains this deliberately differs from TriggerForm's
    // own shorter breadcrumb label, asserted separately below).
    fireEvent.click(screen.getByText('Leads & Walkthroughs').closest('button')!);

    // Subject chosen, mode not yet -> ModeFork, no commit yet.
    expect(screen.getByText('How should it start?')).toBeInTheDocument();
    expect(onSetTrigger).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Right after something happens').closest('button')!);

    // Mode chosen, event not yet -> EventModePanel, still no commit (matches
    // TriggerReadback's own placeholder for an incomplete event pick).
    expect(screen.getByText('When this happens…')).toBeInTheDocument();
    expect(screen.getByText('Pick the event that starts it.')).toBeInTheDocument();
    expect(onSetTrigger).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Lead is assigned').closest('button')!);

    // Complete -> commits exactly once, with the real wire shape.
    expect(onSetTrigger).toHaveBeenCalledTimes(1);
    expect(onSetTrigger).toHaveBeenCalledWith('LEAD_ASSIGNED', null);
    expect(screen.getByRole('status')).toHaveTextContent('The moment a lead is assigned.');
  });

  it('breadcrumb shows both crumbs once mode is chosen, and switching mode preserves the event pick (no lost work)', () => {
    renderWithProviders(<TriggerForm {...props()} />);
    // Default seed (job/event/JOB_COMPLETED) already resolves past stage 1+2.
    expect(screen.getByRole('button', { name: /Jobs — change subject/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Right after something happens — change mode/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Job is completed/ })).toHaveAttribute('aria-checked', 'true');

    // Switch to date mode via the mode crumb, then switch back.
    fireEvent.click(screen.getByRole('button', { name: /Right after something happens — change mode/ }));
    expect(screen.getByText('How should it start?')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Before or after a date').closest('button')!);
    expect(screen.getByText(/How far from the appointment\?/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Before or after a date — change mode/ }));
    fireEvent.click(screen.getByText('Right after something happens').closest('button')!);

    // JOB_COMPLETED is still checked — the earlier event pick was never cleared.
    expect(screen.getByRole('radio', { name: /Job is completed/ })).toHaveAttribute('aria-checked', 'true');
  });
});

// ── JOB_SUB_STATUS_ENTERED — the one event trigger needing an extra pick ────

describe('TriggerForm — JOB_SUB_STATUS_ENTERED needs a sub-status pick before it commits', () => {
  it('picking the event alone does not commit; picking a sub-status commits with the wire shape', async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { job_sub_statuses: [{ id: 'sub-1', parent: 'IN_PROGRESS', label: 'Waiting on parts', sort_order: 0 }] },
    });
    const onSetTrigger = vi.fn();
    renderWithProviders(<TriggerForm {...props({ triggerType: 'JOB_COMPLETED', triggerConfig: null, onSetTrigger })} />);

    fireEvent.click(screen.getByText('Job enters a sub-status').closest('button')!);

    // Event picked, but no sub-status yet — must NOT commit (unlike every other event trigger).
    expect(onSetTrigger).not.toHaveBeenCalled();
    expect(await screen.findByText('Waiting on parts')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Waiting on parts').closest('button')!);

    expect(onSetTrigger).toHaveBeenCalledTimes(1);
    expect(onSetTrigger).toHaveBeenCalledWith('JOB_SUB_STATUS_ENTERED', { sub_status_id: 'sub-1' });
  });

  it('shows the Settings link (not a picker) when the org has no sub-statuses yet', async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { job_sub_statuses: [] } });
    renderWithProviders(<TriggerForm {...props({ triggerType: 'JOB_COMPLETED', triggerConfig: null })} />);

    fireEvent.click(screen.getByText('Job enters a sub-status').closest('button')!);

    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(screen.getByText('No job sub-statuses yet')).toBeInTheDocument();
  });

  it('seeds the picker from a saved workflow and shows it pre-checked', async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { job_sub_statuses: [{ id: 'sub-1', parent: 'IN_PROGRESS', label: 'Waiting on parts', sort_order: 0 }] },
    });
    renderWithProviders(
      <TriggerForm
        {...props({ triggerType: 'JOB_SUB_STATUS_ENTERED', triggerConfig: { sub_status_id: 'sub-1' } })}
      />,
    );

    expect(screen.getByRole('radio', { name: /Job enters a sub-status/ })).toHaveAttribute('aria-checked', 'true');
    expect(await screen.findByText('Waiting on parts')).toBeInTheDocument();
    expect(screen.getByText('Waiting on parts').closest('button')).toHaveAttribute('aria-checked', 'true');
  });
});

// ── building a NEW date-mode trigger, end to end ─────────────────────────────

describe('TriggerForm — building a NEW date-anchored trigger from scratch', () => {
  it('breadcrumb reset -> SubjectPicker -> ModeFork -> DateModePanel preset -> readback, committing the anchored config', () => {
    const onSetTrigger = vi.fn();
    renderWithProviders(<TriggerForm {...props({ triggerType: 'JOB_COMPLETED', triggerConfig: null, onSetTrigger })} />);
    fireEvent.click(screen.getByRole('button', { name: /Jobs — change subject/ }));
    fireEvent.click(screen.getByText('Invoices').closest('button')!);
    fireEvent.click(screen.getByText('Before or after a date').closest('button')!);

    // DateModePanel is up, keyed to the invoice anchor label; nothing committed yet.
    expect(screen.getByText(/How far from the invoice due date\?/)).toBeInTheDocument();
    expect(onSetTrigger).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Choose a timing to complete this.');

    fireEvent.click(screen.getByRole('button', { name: '3 days after' }));

    expect(onSetTrigger).toHaveBeenCalledTimes(1);
    expect(onSetTrigger).toHaveBeenCalledWith('INVOICE_DATE_ANCHORED', {
      anchor: 'invoice.due_date',
      direction: 'after',
      offset_minutes: 4320,
    });
    expect(screen.getByRole('status')).toHaveTextContent('3 days after the invoice due date.');
  });

  /**
   * Spec B slice 5, and the observable half of the acceptance criterion. Until the catalog
   * served an anchor for tasks, this same path found the date card DISABLED and reading
   * "This subject has no scheduled date to count from."
   */
  it('offers date mode for Tasks and commits TASK_DATE_ANCHORED in the BEFORE direction', () => {
    const onSetTrigger = vi.fn();
    renderWithProviders(<TriggerForm {...props({ triggerType: 'JOB_COMPLETED', triggerConfig: null, onSetTrigger })} />);
    fireEvent.click(screen.getByRole('button', { name: /Jobs.+change subject/ }));
    fireEvent.click(screen.getByText('Tasks').closest('button')!);

    const dateCard = screen.getByText('Before or after a date').closest('button')!;
    expect(dateCard).not.toBeDisabled();
    fireEvent.click(dateCard);

    expect(screen.getByText(/How far from the task due date\?/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '1 day before' }));

    expect(onSetTrigger).toHaveBeenCalledWith('TASK_DATE_ANCHORED', {
      anchor: 'task.due_at',
      direction: 'before',
      offset_minutes: 1440,
    });
  });

  /**
   * BOTH directions, from the one trigger - which is why Spec B has no separate overdue
   * trigger. `allowAfter` is false only for estimates, so a task keeps its after presets.
   */
  it('offers the AFTER direction too, so the overdue chase is authorable from the same card', () => {
    const onSetTrigger = vi.fn();
    renderWithProviders(<TriggerForm {...props({ triggerType: 'JOB_COMPLETED', triggerConfig: null, onSetTrigger })} />);
    fireEvent.click(screen.getByRole('button', { name: /Jobs.+change subject/ }));
    fireEvent.click(screen.getByText('Tasks').closest('button')!);
    fireEvent.click(screen.getByText('Before or after a date').closest('button')!);

    fireEvent.click(screen.getByRole('button', { name: '3 days after' }));

    expect(onSetTrigger).toHaveBeenCalledWith('TASK_DATE_ANCHORED', {
      anchor: 'task.due_at',
      direction: 'after',
      offset_minutes: 4320,
    });
  });

  it('ModeFork locks date mode (and TriggerForm passes null anchorLabel, not a crash) when the subject has no served anchor', () => {
    renderWithProviders(<TriggerForm {...props({ catalog: CATALOG_NO_JOB_ANCHOR })} />);
    // Default seed is job/event — go back to ModeFork for job.
    fireEvent.click(screen.getByRole('button', { name: /Right after something happens — change mode/ }));

    const dateCard = screen.getByText('Before or after a date').closest('button')!;
    expect(dateCard).toBeDisabled();
    expect(screen.getByText('This subject has no scheduled date to count from.')).toBeInTheDocument();
  });
});

// ── search-hit routing (SubjectPicker has no category filter) ───────────────

describe('TriggerForm — SubjectPicker search-hit routing by category', () => {
  it('an events-category search hit commits an immediate, complete event pick', () => {
    const onSetTrigger = vi.fn();
    renderWithProviders(<TriggerForm {...props({ triggerType: 'JOB_COMPLETED', triggerConfig: null, onSetTrigger })} />);
    fireEvent.click(screen.getByRole('button', { name: /Jobs — change subject/ }));

    fireEvent.change(screen.getByPlaceholderText(/Search all triggers/), { target: { value: 'paid' } });
    fireEvent.click(screen.getByText('Invoice is paid').closest('button')!);

    expect(onSetTrigger).toHaveBeenCalledTimes(1);
    expect(onSetTrigger).toHaveBeenCalledWith('INVOICE_PAID', null);
    expect(screen.getByRole('radio', { name: /Invoice is paid/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('a non-events (date/timed) search hit lands on the subject with mode unset, rather than fabricating an invalid pick', () => {
    const onSetTrigger = vi.fn();
    renderWithProviders(<TriggerForm {...props({ triggerType: 'JOB_COMPLETED', triggerConfig: null, onSetTrigger })} />);
    fireEvent.click(screen.getByRole('button', { name: /Jobs — change subject/ }));

    fireEvent.change(screen.getByPlaceholderText(/Search all triggers/), { target: { value: 'walkthrough' } });
    fireEvent.click(screen.getByText('Before or after the walkthrough').closest('button')!);

    // Landed on ModeFork for "lead" — not a committed, half-formed trigger.
    expect(screen.getByText('How should it start?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Leads — change subject/ })).toBeInTheDocument();
    expect(onSetTrigger).not.toHaveBeenCalled();
  });
});

// ── round-trip re-population of an EXISTING saved workflow ──────────────────

describe('TriggerForm — round-trip re-population from a saved trigger', () => {
  it('an existing event-mode workflow (INVOICE_PAID) pre-populates the picker straight to EventModePanel + readback, no picker steps shown', () => {
    renderWithProviders(<TriggerForm {...props({ triggerType: 'INVOICE_PAID', triggerConfig: null })} />);

    expect(screen.queryByText('What is this automation about?')).not.toBeInTheDocument();
    expect(screen.queryByText('How should it start?')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Invoices — change subject/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Right after something happens — change mode/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Invoice is paid/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('The moment an invoice is paid.');
    expect(screen.queryByText(/older timing setup/)).not.toBeInTheDocument();
  });

  it('an existing date-anchored workflow (INVOICE_DATE_ANCHORED) pre-populates DateModePanel + readback with the saved offset', () => {
    renderWithProviders(
      <TriggerForm
        {...props({
          triggerType: 'INVOICE_DATE_ANCHORED',
          triggerConfig: { anchor: 'invoice.due_date', direction: 'before', offset_minutes: 1440 },
        })}
      />,
    );

    expect(screen.getByRole('button', { name: /Invoices — change subject/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Before or after a date — change mode/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1 day before' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('The day before the invoice due date.');
    expect(screen.queryByText(/older timing setup/)).not.toBeInTheDocument();
  });

  it('re-seeds correctly even if the catalog was not yet loaded on first mount (async catalog race)', () => {
    const { rerender } = renderWithProviders(
      <TriggerForm {...props({ triggerType: 'INVOICE_PAID', triggerConfig: null, catalog: undefined })} />,
    );
    expect(screen.queryByText('What is this automation about?')).not.toBeInTheDocument(); // loading state

    rerender(<TriggerForm {...props({ triggerType: 'INVOICE_PAID', triggerConfig: null })} />);

    expect(screen.getByRole('radio', { name: /Invoice is paid/ })).toHaveAttribute('aria-checked', 'true');
  });
});

// ── legacy-trigger fallback (the hardest design decision in this task) ──────

describe('TriggerForm — legacy timed-trigger fallback', () => {
  it('shows an honest banner naming the current legacy trigger, and falls through to a fresh SubjectPicker', () => {
    renderWithProviders(
      <TriggerForm {...props({ triggerType: 'BEFORE_JOB_START', triggerConfig: { offset_minutes: 1440 } })} />,
    );

    expect(screen.getByText(/This automation currently uses an older timing setup/)).toBeInTheDocument();
    expect(screen.getByText('Before a job starts')).toBeInTheDocument();
    // Falls through to a genuinely fresh picker — not a fabricated subject/mode guess.
    expect(screen.getByText('What is this automation about?')).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 3 — choose a subject')).toBeInTheDocument();
  });

  it('closing the drawer without picking anything never calls onSetTrigger — the legacy trigger is left untouched', () => {
    const onSetTrigger = vi.fn();
    renderWithProviders(
      <TriggerForm {...props({ triggerType: 'BEFORE_JOB_START', triggerConfig: { offset_minutes: 1440 }, onSetTrigger })} />,
    );
    expect(onSetTrigger).not.toHaveBeenCalled();
  });

  it('picking a new subject/mode/event replaces the legacy trigger, and the banner disappears once the parent echoes the completed pick back', () => {
    const onSetTrigger = vi.fn();
    const { rerender } = renderWithProviders(
      <TriggerForm {...props({ triggerType: 'BEFORE_JOB_START', triggerConfig: { offset_minutes: 1440 }, onSetTrigger })} />,
    );

    fireEvent.click(screen.getByText('Jobs').closest('button')!);
    fireEvent.click(screen.getByText('Right after something happens').closest('button')!);
    fireEvent.click(screen.getByText('Job is scheduled').closest('button')!);

    expect(onSetTrigger).toHaveBeenCalledWith('JOB_SCHEDULED', null);
    // Still showing the banner at this point — the PARENT hasn't re-rendered
    // with the new committed trigger_type yet (that only happens once the
    // draft/autosave round-trip echoes it back as new props), matching how
    // the real drawer is wired.
    expect(screen.getByText(/This automation currently uses an older timing setup/)).toBeInTheDocument();

    rerender(<TriggerForm {...props({ triggerType: 'JOB_SCHEDULED', triggerConfig: null, onSetTrigger })} />);
    expect(screen.queryByText(/This automation currently uses an older timing setup/)).not.toBeInTheDocument();
  });

  it('every one of the four legacy timed trigger types produces the fallback (not just BEFORE_JOB_START)', () => {
    const legacyConfig = { offset_minutes: 60 };
    for (const triggerType of ['BEFORE_JOB_START', 'AFTER_JOB_COMPLETED', 'INVOICE_OVERDUE', 'ESTIMATE_FOLLOW_UP'] as const) {
      const { unmount } = renderWithProviders(<TriggerForm {...props({ triggerType, triggerConfig: legacyConfig })} />);
      expect(screen.getByText(/This automation currently uses an older timing setup/)).toBeInTheDocument();
      unmount();
    }
  });
});
