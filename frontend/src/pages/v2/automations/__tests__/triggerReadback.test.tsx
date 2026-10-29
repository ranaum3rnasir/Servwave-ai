/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';

import type { TriggerSelection } from '@/lib/workflows/triggerModel';
import type { WorkflowCatalog } from '@/lib/api/workflows';
import { renderWithProviders } from '@/__tests__/helpers';

import TriggerReadback from '../components/trigger/triggerReadback';
import { ELLIPSIS } from '../components/glyphs';

/**
 * The FIRST suite for the ROUTED readback. `/automations/:id` renders
 * AutomationBuilderPage -> components/triggerForm -> this component;
 * `components/workflows/trigger/TriggerReadback.tsx` is the v1 twin behind the
 * unrouted pages/workflows builder, and it has its own suite. Both were fixed
 * together, but only this one is what staging actually served.
 *
 * The defect: the sentence used to end with the hardcoded tail "send the
 * customer an email.", so a fresh TASK_CREATED draft with ZERO steps read
 *
 *   "The moment a task is created, send the customer an email."
 *
 * The customer is not a legal audience for ANY task trigger - catalog.ts's
 * ENTITIES_WITH_CUSTOMER excludes `task`, whose audiences are staff only
 * (assignees, watchers, creator, all_admins, all_dispatchers, specific_user,
 * custom) - and no step existed to send anything at all.
 */

const CATALOG = {
  triggers: {
    INVOICE_PAID: {
      label: 'Invoice is paid',
      description: 'Fires when an invoice is paid in full.',
      category: 'events',
      entity: 'invoice',
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
    // Real labels, from backend catalog.ts / anchors.ts.
    TASK_CREATED: {
      label: 'Task is created',
      description: 'Fires when a task is created.',
      category: 'events',
      entity: 'task',
      timeBased: false,
      mergeFields: [],
    },
  },
  anchors: {
    job: [{ key: 'job.scheduled_start', label: 'the appointment' }],
    invoice: [{ key: 'invoice.due_date', label: 'the invoice due date' }],
    task: [{ key: 'task.due_at', label: 'the task due date' }],
  },
} as unknown as WorkflowCatalog;

function sentenceText(): string {
  return screen.getByRole('status').textContent ?? '';
}

describe('triggerReadback (routed)', () => {
  describe('the sentence is the trigger, and only the trigger', () => {
    /** Every audience describeWorkflow.ts / stepSentence.ts can print, plus the bare noun. */
    const AUDIENCE_WORDS =
      /\b(customer|technician|technicians|dispatcher|dispatchers|salesperson|creator|admin|admins|assignee|assignees|watcher|watchers|recipient|team member)\b/i;
    /** Every messaging verb / channel the step bubbles own. */
    const ACTION_WORDS = /\b(send|sends|sending|email|emails|text|texts|texting|notify|notifies|message|messages)\b/i;

    const CASES: Array<{ name: string; selection: TriggerSelection; expected: string }> = [
      {
        name: 'task event (the defect)',
        selection: { subject: 'task', mode: 'event', eventTrigger: 'TASK_CREATED' },
        expected: 'The moment a task is created.',
      },
      {
        name: 'task date',
        selection: { subject: 'task', mode: 'date', anchor: 'task.due_at', direction: 'before', offsetMinutes: 1440 },
        expected: 'The day before the task due date.',
      },
      {
        name: 'job event (regression guard)',
        selection: { subject: 'job', mode: 'event', eventTrigger: 'JOB_COMPLETED' },
        expected: 'The moment a job is completed.',
      },
      {
        name: 'job date (regression guard)',
        selection: {
          subject: 'job',
          mode: 'date',
          anchor: 'job.scheduled_start',
          direction: 'after',
          offsetMinutes: 4320,
        },
        expected: '3 days after the appointment.',
      },
      {
        name: 'invoice event',
        selection: { subject: 'invoice', mode: 'event', eventTrigger: 'INVOICE_PAID' },
        expected: 'The moment an invoice is paid.',
      },
      {
        name: 'invoice date, 0 offset',
        selection: {
          subject: 'invoice',
          mode: 'date',
          anchor: 'invoice.due_date',
          direction: 'before',
          offsetMinutes: 0,
        },
        expected: 'Just before the invoice due date.',
      },
      {
        name: 'invoice date, 1 hour after (singular non-day unit)',
        selection: {
          subject: 'invoice',
          mode: 'date',
          anchor: 'invoice.due_date',
          direction: 'after',
          offsetMinutes: 60,
        },
        expected: '1 hour after the invoice due date.',
      },
    ];

    it.each(CASES)('$name reads as the trigger alone', ({ selection, expected }) => {
      renderWithProviders(<TriggerReadback selection={selection} catalog={CATALOG} />);
      expect(sentenceText()).toBe(expected);
    });

    it.each(CASES)('$name names no audience', ({ selection }) => {
      renderWithProviders(<TriggerReadback selection={selection} catalog={CATALOG} />);
      expect(sentenceText()).not.toMatch(AUDIENCE_WORDS);
    });

    it.each(CASES)('$name asserts no action', ({ selection }) => {
      // This component is never told how many steps the draft has, so it has to
      // read correctly on a draft with ZERO - the canvas still saying "Add your
      // first step" while this strip promised an email was the defect. It must
      // also not hardcode a channel: the first step, once added, may be a text.
      renderWithProviders(<TriggerReadback selection={selection} catalog={CATALOG} />);
      expect(sentenceText()).not.toMatch(ACTION_WORDS);
    });

    it('says "customer" nowhere on a task trigger - not in the sentence, not in the rule-1 note', () => {
      const { container } = renderWithProviders(
        <TriggerReadback
          selection={{ subject: 'task', mode: 'date', anchor: 'task.due_at', direction: 'before', offsetMinutes: 1440 }}
          catalog={CATALOG}
        />,
      );
      expect(container.textContent ?? '').not.toMatch(/customer/i);
    });
  });

  describe('the eyebrow scopes the sentence', () => {
    it('reads "This automation starts…", not the old "will…" promise', () => {
      renderWithProviders(
        <TriggerReadback selection={{ subject: 'task', mode: 'event', eventTrigger: 'TASK_CREATED' }} catalog={CATALOG} />,
      );
      expect(screen.getByText(`This automation starts${ELLIPSIS}`)).toBeInTheDocument();
      expect(screen.queryByText(`This automation will${ELLIPSIS}`)).not.toBeInTheDocument();
    });
  });

  describe('rule-1 note, unchanged', () => {
    it('renders for a "before" date selection, naming the selection’s own anchor', () => {
      renderWithProviders(
        <TriggerReadback
          selection={{ subject: 'task', mode: 'date', anchor: 'task.due_at', direction: 'before', offsetMinutes: 1440 }}
          catalog={CATALOG}
        />,
      );
      const note = screen.getByTestId('trigger-readback-note');
      expect(note).toHaveTextContent('If the task due date is still coming up');
      expect(within(note).getByText('still coming up')).toBeInTheDocument();
      expect(within(note).getByText('already passed')).toBeInTheDocument();
    });

    it('is absent for an "after" date selection and for event mode', () => {
      const { unmount } = renderWithProviders(
        <TriggerReadback
          selection={{ subject: 'task', mode: 'date', anchor: 'task.due_at', direction: 'after', offsetMinutes: 1440 }}
          catalog={CATALOG}
        />,
      );
      expect(screen.queryByTestId('trigger-readback-note')).not.toBeInTheDocument();
      unmount();

      renderWithProviders(
        <TriggerReadback selection={{ subject: 'task', mode: 'event', eventTrigger: 'TASK_CREATED' }} catalog={CATALOG} />,
      );
      expect(screen.queryByTestId('trigger-readback-note')).not.toBeInTheDocument();
    });
  });

  describe('incomplete selections, unchanged', () => {
    it('event mode with no trigger picked yet shows its placeholder', () => {
      renderWithProviders(<TriggerReadback selection={{ subject: 'task', mode: 'event' }} catalog={CATALOG} />);
      expect(sentenceText()).toBe('Pick the event that starts it.');
      expect(screen.queryByTestId('trigger-readback-note')).not.toBeInTheDocument();
    });

    it('date mode with no timing picked yet shows its placeholder', () => {
      renderWithProviders(
        <TriggerReadback selection={{ subject: 'task', mode: 'date', anchor: 'task.due_at' }} catalog={CATALOG} />,
      );
      expect(sentenceText()).toBe('Choose a timing to complete this.');
      expect(screen.queryByTestId('trigger-readback-note')).not.toBeInTheDocument();
    });
  });
});
