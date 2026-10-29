import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import type { WorkflowCatalog } from '@/lib/api/workflows';
import TriggerForm from '../components/triggerForm';

/**
 * The date branch's anchor picker.
 *
 * Before this, the builder read `catalog.anchors[subject][0]` and offered nothing else, so the
 * three lead stage clocks were registered, validated and served — and unreachable. Every lead
 * date-anchored rule in the product counted from the same legacy walkthrough date.
 *
 * The two behaviours worth pinning are the picker itself and the direction narrowing that has to
 * ride with it: a stage clock records a moment AS IT HAPPENS, so `before` can never fire and the
 * backend refuses to save it. Offering it would be a control that autosaves into a 400.
 */

const LEAD_ANCHORS = [
  { key: 'lead.walkthrough_scheduled_at', label: 'the walkthrough', directions: ['before', 'after'] },
  { key: 'lead.created_at', label: 'the lead arriving', directions: ['after'] },
  { key: 'lead.contacted_at', label: 'first contact', directions: ['after'] },
  { key: 'lead.last_visit_completed_at', label: 'the completed walkthrough', directions: ['after'] },
];

const CATALOG = {
  triggers: {
    JOB_COMPLETED: {
      label: 'Job is completed',
      description: 'When a job is marked complete',
      category: 'events',
      entity: 'job',
      timeBased: false,
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
    LEAD_CREATED: {
      label: 'Lead is created',
      description: 'When a new lead arrives',
      category: 'events',
      entity: 'lead',
      timeBased: false,
      mergeFields: [],
    },
    LEAD_DATE_ANCHORED: {
      label: 'Before or after a lead date',
      description: 'Counts from a date on the lead',
      category: 'date',
      entity: 'lead',
      timeBased: false,
      mergeFields: [],
    },
  },
  actions: {},
  audiences: {},
  anchors: {
    job: [{ key: 'job.scheduled_start', label: 'the appointment', directions: ['before', 'after'] }],
    estimate: [{ key: 'estimate.valid_until', label: 'the estimate expiration', directions: ['before', 'after'] }],
    invoice: [{ key: 'invoice.due_date', label: 'the invoice due date', directions: ['before', 'after'] }],
    lead: LEAD_ANCHORS,
  },
  merge_field_labels: {},
  sample_context: {},
  templates: [],
  stop_if: { conditions: {}, labels: {} },
} as unknown as WorkflowCatalog;

function props(overrides: Partial<React.ComponentProps<typeof TriggerForm>> = {}) {
  return {
    triggerType: 'JOB_COMPLETED' as const,
    triggerConfig: null,
    triggerConfigured: false,
    stepCount: 0,
    catalog: CATALOG,
    onSetTrigger: vi.fn(),
    ...overrides,
  };
}

/** Walks the builder to the date branch for a subject: subject tile, then the date fork card. */
function openDateBranch(subjectLabel: string) {
  fireEvent.click(screen.getByText(subjectLabel));
  fireEvent.click(screen.getByText('Before or after a date'));
}

const PICKER = { name: 'What should it count from?' };

describe('trigger builder — anchor picker', () => {
  it('offers every anchor the subject serves, not just the first', () => {
    renderWithProviders(<TriggerForm {...props()} />);
    openDateBranch('Leads & Walkthroughs');

    const picker = screen.getByRole('group', PICKER);
    const chips = picker.querySelectorAll('button');
    expect(Array.from(chips).map((c) => c.textContent)).toEqual([
      'the walkthrough',
      'the lead arriving',
      'first contact',
      'the completed walkthrough',
    ]);
  });

  it('starts on the subject’s first anchor, so today’s rules are unchanged', () => {
    renderWithProviders(<TriggerForm {...props()} />);
    openDateBranch('Leads & Walkthroughs');

    expect(screen.getByRole('button', { name: 'the walkthrough' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'first contact' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('commits the chosen stage clock to the trigger config', () => {
    const onSetTrigger = vi.fn();
    renderWithProviders(<TriggerForm {...props({ onSetTrigger })} />);
    openDateBranch('Leads & Walkthroughs');

    fireEvent.click(screen.getByRole('button', { name: 'first contact' }));
    fireEvent.click(screen.getByRole('button', { name: '1 day after' }));

    expect(onSetTrigger).toHaveBeenLastCalledWith('LEAD_DATE_ANCHORED', {
      anchor: 'lead.contacted_at',
      direction: 'after',
      offset_minutes: 1440,
    });
  });

  it('hides the before presets on a stage clock — the save would reject them', () => {
    renderWithProviders(<TriggerForm {...props()} />);
    openDateBranch('Leads & Walkthroughs');

    // The legacy walkthrough anchor counts both ways.
    expect(screen.getByRole('button', { name: '1 day before' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'first contact' }));

    expect(screen.queryByRole('button', { name: '1 day before' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '2 hours before' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1 day after' })).toBeInTheDocument();
  });

  it('flips a now-illegal direction instead of autosaving one the backend refuses', () => {
    const onSetTrigger = vi.fn();
    renderWithProviders(<TriggerForm {...props({ onSetTrigger })} />);
    openDateBranch('Leads & Walkthroughs');

    fireEvent.click(screen.getByRole('button', { name: '1 day before' }));
    expect(onSetTrigger).toHaveBeenLastCalledWith('LEAD_DATE_ANCHORED', {
      anchor: 'lead.walkthrough_scheduled_at',
      direction: 'before',
      offset_minutes: 1440,
    });

    fireEvent.click(screen.getByRole('button', { name: 'first contact' }));

    expect(onSetTrigger).toHaveBeenLastCalledWith('LEAD_DATE_ANCHORED', {
      anchor: 'lead.contacted_at',
      direction: 'after',
      offset_minutes: 1440,
    });
  });

  it('names the chosen anchor in the timing question, not the subject’s first', () => {
    renderWithProviders(<TriggerForm {...props()} />);
    openDateBranch('Leads & Walkthroughs');

    expect(screen.getByText('How far from the walkthrough?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'the completed walkthrough' }));

    expect(screen.getByText('How far from the completed walkthrough?')).toBeInTheDocument();
  });

  it('shows no picker for a subject with one anchor', () => {
    renderWithProviders(<TriggerForm {...props()} />);
    openDateBranch('Jobs');

    expect(screen.queryByRole('group', PICKER)).not.toBeInTheDocument();
    expect(screen.getByText('How far from the appointment?')).toBeInTheDocument();
  });

  it('treats a catalog with no served directions as both, so an older catalog still works', () => {
    const legacyCatalog = {
      ...CATALOG,
      anchors: {
        ...CATALOG.anchors,
        lead: LEAD_ANCHORS.map(({ key, label }) => ({ key, label })),
      },
    } as unknown as WorkflowCatalog;

    renderWithProviders(<TriggerForm {...props({ catalog: legacyCatalog })} />);
    openDateBranch('Leads & Walkthroughs');

    fireEvent.click(screen.getByRole('button', { name: 'first contact' }));

    expect(screen.getByRole('button', { name: '1 day before' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1 day after' })).toBeInTheDocument();
  });
});
