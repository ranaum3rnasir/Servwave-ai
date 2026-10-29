import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import EventModePanel from '../EventModePanel';
import type { WorkflowCatalog } from '@/lib/api/workflows';

/**
 * A trimmed but shape-faithful catalog (same trimming approach as
 * SubjectPicker.test.tsx's CATALOG). For job and invoice, each subject
 * carries an 'events' pair PLUS a 'timed' AND a 'date' sibling on the same
 * entity — so the category filter is proven against real neighbors, not an
 * already-clean list. `lead` here carries no 'events' trigger at all, for
 * the zero-options edge case below.
 *
 * INVOICE_OVERDUE is `category: 'timed'` here — matching the real backend
 * catalog (backend/src/services/automations/catalog.ts) and the identical
 * fixture convention SubjectPicker.test.tsx already established (its CATALOG
 * has the same INVOICE_OVERDUE: category 'timed'). See EventModePanel.tsx's
 * docblock for why the invoice list below therefore renders two options
 * (Invoice is sent, Invoice is paid), not the three the task brief's Step 1
 * illustration names — "Invoice is overdue" is excluded as a timed/legacy
 * trigger, same as INVOICE_DATE_ANCHORED is excluded as a date trigger.
 */
const CATALOG = {
  triggers: {
    JOB_SCHEDULED: {
      label: 'Job is scheduled',
      description: 'Fires the first time a job gets a date on the calendar.',
      category: 'events',
      entity: 'job',
      timeBased: false,
      mergeFields: [],
    },
    JOB_COMPLETED: {
      label: 'Job is completed',
      description: 'Fires when a job is marked complete.',
      category: 'events',
      entity: 'job',
      timeBased: false,
      mergeFields: [],
    },
    BEFORE_JOB_START: {
      label: 'Before a job starts',
      description: 'Fires a set amount of time before the job’s scheduled start.',
      category: 'timed',
      entity: 'job',
      timeBased: true,
      defaultOffsetMinutes: 1440,
      mergeFields: [],
    },
    JOB_DATE_ANCHORED: {
      label: 'Before or after the appointment',
      description: 'Counts from the job’s scheduled time.',
      category: 'date',
      entity: 'job',
      timeBased: false,
      mergeFields: [],
    },

    INVOICE_SENT: {
      label: 'Invoice is sent',
      description: 'Fires when an invoice is sent to the customer.',
      category: 'events',
      entity: 'invoice',
      timeBased: false,
      mergeFields: [],
    },
    INVOICE_PAID: {
      label: 'Invoice is paid',
      description: 'Fires when an invoice is paid in full.',
      category: 'events',
      entity: 'invoice',
      timeBased: false,
      mergeFields: [],
    },
    INVOICE_OVERDUE: {
      label: 'Invoice is overdue',
      description: 'Fires a set amount of time after the due date if the invoice is still unpaid.',
      category: 'timed',
      entity: 'invoice',
      timeBased: true,
      defaultOffsetMinutes: 4320,
      mergeFields: [],
    },
    INVOICE_DATE_ANCHORED: {
      label: 'Before or after the invoice due date',
      description: 'Counts from when payment is due.',
      category: 'date',
      entity: 'invoice',
      timeBased: false,
      mergeFields: [],
    },

    LEAD_DATE_ANCHORED: {
      label: 'Before or after the walkthrough',
      description: 'Counts from the walkthrough’s scheduled time.',
      category: 'date',
      entity: 'lead',
      timeBased: false,
      mergeFields: [],
    },
  },
} as unknown as WorkflowCatalog;

describe('EventModePanel', () => {
  it('renders the mockup’s verbatim heading and subheading', () => {
    renderWithProviders(<EventModePanel subject="job" catalog={CATALOG} onPick={vi.fn()} />);

    expect(screen.getByText('When this happens…')).toBeInTheDocument();
    expect(screen.getByText('The automation fires the moment this occurs.')).toBeInTheDocument();
  });

  it('renders exactly the subject’s events-category triggers, excluding both timed and date categories', () => {
    renderWithProviders(<EventModePanel subject="invoice" catalog={CATALOG} onPick={vi.fn()} />);

    expect(screen.getByText('Invoice is sent')).toBeInTheDocument();
    expect(screen.getByText('Fires when an invoice is sent to the customer.')).toBeInTheDocument();
    expect(screen.getByText('Invoice is paid')).toBeInTheDocument();
    expect(screen.getByText('Fires when an invoice is paid in full.')).toBeInTheDocument();

    // timed (legacy, superseded by date mode) — must NOT appear
    expect(screen.queryByText('Invoice is overdue')).not.toBeInTheDocument();
    // date (INVOICE_DATE_ANCHORED) — must NOT appear
    expect(screen.queryByText('Before or after the invoice due date')).not.toBeInTheDocument();

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(radios[0]).toHaveTextContent('Invoice is sent');
    expect(radios[1]).toHaveTextContent('Invoice is paid');
  });

  it('excludes triggers belonging to a different subject entirely, even when they are events-category', () => {
    renderWithProviders(<EventModePanel subject="job" catalog={CATALOG} onPick={vi.fn()} />);

    expect(screen.getByText('Job is scheduled')).toBeInTheDocument();
    expect(screen.getByText('Job is completed')).toBeInTheDocument();
    expect(screen.queryByText('Invoice is sent')).not.toBeInTheDocument();
    expect(screen.queryByText('Invoice is paid')).not.toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('clicking an option calls onPick with that option’s trigger type, and only that argument', () => {
    const onPick = vi.fn();
    renderWithProviders(<EventModePanel subject="invoice" catalog={CATALOG} onPick={onPick} />);

    fireEvent.click(screen.getByText('Invoice is paid').closest('button')!);

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith('INVOICE_PAID');
    expect(onPick.mock.calls[0]).toHaveLength(1);
  });

  it('value drives aria-checked (and the highlighted state); switching value moves the selection', () => {
    const onPick = vi.fn();
    const { rerender } = renderWithProviders(
      <EventModePanel subject="invoice" catalog={CATALOG} value={undefined} onPick={onPick} />,
    );

    const sentBtn = () => screen.getByText('Invoice is sent').closest('button')!;
    const paidBtn = () => screen.getByText('Invoice is paid').closest('button')!;

    // Nothing selected yet.
    expect(sentBtn()).toHaveAttribute('aria-checked', 'false');
    expect(paidBtn()).toHaveAttribute('aria-checked', 'false');

    rerender(<EventModePanel subject="invoice" catalog={CATALOG} value="INVOICE_PAID" onPick={onPick} />);
    expect(sentBtn()).toHaveAttribute('aria-checked', 'false');
    expect(paidBtn()).toHaveAttribute('aria-checked', 'true');

    // Switching value moves the checked option — not sticky on the first pick.
    rerender(<EventModePanel subject="invoice" catalog={CATALOG} value="INVOICE_SENT" onPick={onPick} />);
    expect(sentBtn()).toHaveAttribute('aria-checked', 'true');
    expect(paidBtn()).toHaveAttribute('aria-checked', 'false');
  });

  it('a subject with zero events-category triggers in the catalog renders an empty list, not a crash', () => {
    // Not reachable with the real backend catalog today (every BuilderSubject
    // currently has >=2 'events' triggers) — this fixture's `lead` entry only
    // carries a 'date' trigger, on purpose, to prove the component doesn't
    // assume at least one option exists.
    renderWithProviders(<EventModePanel subject="lead" catalog={CATALOG} onPick={vi.fn()} />);

    expect(screen.getByText('When this happens…')).toBeInTheDocument();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });
});
