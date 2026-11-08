/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { useWorkflowActivity, type ActivityRow } from '@/lib/api/workflows';

import WorkflowActivity from '../components/workflowActivity';

/**
 * Scheduling-notifications slice 03. A step aimed at several audiences records one
 * status for the whole step, SENT if anyone got it, so an admin reading "Sent" could
 * not tell whether the CUSTOMER was reached or only the crew. The row now lists each
 * audience with its own outcome and reason beneath the step.
 */

vi.mock('@/lib/api/workflows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/workflows')>();
  return { ...actual, useWorkflowActivity: vi.fn() };
});

const mockUseActivity = vi.mocked(useWorkflowActivity);

function emailRow(overrides: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: 'r1',
    source: 'workflow',
    when: '2026-09-13T09:00:00.000Z',
    step_index: 0,
    step_type: 'SEND_EMAIL',
    status: 'SENT',
    recipient_summary: 'mike@org.com',
    detail: 'Sent to 1 · skipped: The customer has no email address on file',
    entity_label: 'J00042',
    audience_outcomes: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

function render(...rows: ActivityRow[]) {
  mockUseActivity.mockReturnValue({ data: { rows }, isLoading: false } as ReturnType<typeof useWorkflowActivity>);
  renderWithProviders(<WorkflowActivity id="wf-1" />);
}

/** A row that DID record per-audience outcomes, to sit next to one that did not. */
function recordedRow(): ActivityRow {
  return emailRow({
    id: 'r-recorded',
    detail: 'Sent to 1 · skipped: The customer has no email address on file',
    audience_outcomes: [
      { audience: 'customer', label: 'the customer', outcome: 'skipped', summary: 'The customer has no email address on file' },
      { audience: 'assigned_team', label: 'the assigned crew', outcome: 'sent', summary: 'Sent to mike@org.com' },
    ],
  });
}

/** The activity card a row's headline sits in. */
function cardOf(detail: string): HTMLElement {
  const card = screen.getByText(detail).closest('.rounded-lg');
  if (!(card instanceof HTMLElement)) throw new Error(`no card holds "${detail}"`);
  return card;
}

describe('workflowActivity (v2) - the per-audience breakdown under a step', () => {
  it('lists each audience with its outcome and reason', () => {
    render(
      emailRow({
        audience_outcomes: [
          {
            audience: 'customer',
            label: 'the customer',
            outcome: 'skipped',
            summary: 'The customer has no email address on file',
          },
          { audience: 'assigned_team', label: 'the assigned crew', outcome: 'sent', summary: 'Sent to mike@org.com' },
        ],
      }),
    );

    const list = screen.getByRole('list', { name: /per audience/i });
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(list).toHaveTextContent('The customer');
    expect(items[0]).toHaveTextContent('Skipped');
    expect(items[0]).toHaveTextContent('The customer has no email address on file');
    expect(items[1]).toHaveTextContent('The assigned crew');
    expect(items[1]).toHaveTextContent('Sent');
    expect(items[1]).toHaveTextContent('Sent to mike@org.com');
  });

  it('marks a failed audience as failed', () => {
    render(
      emailRow({
        status: 'FAILED',
        audience_outcomes: [
          { audience: 'customer', label: 'the customer', outcome: 'failed', summary: 'delivery failed: blocked' },
        ],
      }),
    );
    expect(screen.getByRole('listitem')).toHaveTextContent('Failed');
    expect(screen.getByRole('listitem')).toHaveTextContent('delivery failed: blocked');
  });

  it('renders the breakdown only under the step that recorded something per audience, not an empty one', () => {
    const emptyDetail = 'Sent to mike@org.com';
    render(recordedRow(), emailRow({ id: 'r-empty', detail: emptyDetail, audience_outcomes: [] }));

    // getByRole throws on zero AND on more than one: exactly one breakdown on the page.
    const list = screen.getByRole('list', { name: /per audience/i });
    expect(cardOf('Sent to 1 · skipped: The customer has no email address on file')).toContainElement(list);
    expect(cardOf(emptyDetail).querySelector('ul')).toBeNull();
  });

  it('tolerates a row without the field at all (a legacy engine row) beside one that has it', () => {
    const legacyDetail = 'Email sent (previous engine)';
    render(
      recordedRow(),
      emailRow({
        id: 'r-legacy',
        source: 'legacy',
        detail: legacyDetail,
        audience_outcomes: undefined as unknown as ActivityRow['audience_outcomes'],
      }),
    );

    // getByRole throws on zero AND on more than one: exactly one breakdown on the page.
    const list = screen.getByRole('list', { name: /per audience/i });
    expect(cardOf('Sent to 1 · skipped: The customer has no email address on file')).toContainElement(list);
    // The legacy row still renders in full, with no breakdown and no crash on the missing field.
    const legacy = cardOf(legacyDetail);
    expect(legacy.querySelector('ul')).toBeNull();
    expect(legacy).toHaveTextContent('Step 1 · Send an email');
    expect(legacy).toHaveTextContent('From the previous automations engine');
  });
});
