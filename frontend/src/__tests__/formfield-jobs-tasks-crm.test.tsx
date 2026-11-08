/**
 * FormField adoption - phase 11b/11d, the "jobs, tasks and crm field clusters"
 * batch (14 files across components/jobs/, components/tasks/, components/crm/).
 *
 * Pins the RENDERED CONTRACT of the genuine FormField-shape conversions in this
 * batch, at the rigour of frontend/src/__tests__/formfield-auth-and-staff.test.tsx:
 *
 * 1. THE DEFECT THE CONVERSION CLOSES: the label's `htmlFor` and the control's
 *    `id` are ONE generated (or explicitly pinned) fact, not two hand-typed
 *    literals that can drift apart. Asserting `label.getAttribute('for') ===
 *    control.id` is what makes this survive the useId() path.
 *
 * 2. TotalsFooter.tsx's Sales-tax-jurisdiction field wraps a compound `<Select>`
 *    (a Radix root with no DOM of its own) via FormField's render-prop child, the
 *    id landing on the `SelectTrigger` - the same shape StaffFormDialog's Role/
 *    Department fields use. Pinned separately from the plain-Input cases because
 *    it is the one non-cloneElement path this batch exercises.
 *
 * 3. THE DEFERRALS ARE PINNED, NOT JUST WRITTEN DOWN. CreateTaskModal.tsx's
 *    Owner/Watchers/Due Date/Priority/Linked To labels each wrap a compound
 *    picker with no `id` prop of its own to receive fieldProps, and were
 *    deliberately left raw rather than forced through FormField. The test
 *    asserts those rows are still plain, unwired `<label>` elements, so "someone
 *    force-fit FormField onto a compound picker" is a red test, not a silent
 *    regression.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from './helpers';
import { ScopeOfWorkCard } from '@/components/jobs/items/ScopeOfWorkCard';
import { TotalsFooter } from '@/components/jobs/items/TotalsFooter';
import { CreateTaskModal } from '@/components/tasks/CreateTaskModal';
import type { AssignableUser } from '@/lib/api/users';

// ─── module mocks (CreateTaskModal only) ──────────────────────────────────

const MOCK_USERS: AssignableUser[] = [
  {
    id: 'user-alice-uuid',
    first_name: 'Alice',
    last_name: 'Anderson',
    role: 'DISPATCHER',
    is_active: true,
    has_login: true,
    department: { id: 'dept-ops', name: 'Operations' },
  },
];

vi.mock('@/lib/api/users', () => ({
  useAssignableUsers: vi.fn(() => ({ data: MOCK_USERS, isLoading: false })),
}));

vi.mock('@/stores/tasksStore', () => ({
  useTasksStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({ tasks: [], addTask: vi.fn() }),
  ),
}));

// ─── ScopeOfWorkCard - AddScopeForm (Title, Description) ─────────────────

describe('ScopeOfWorkCard - FormField conversion (AddScopeForm)', () => {
  const renderCard = () =>
    renderWithProviders(
      <ScopeOfWorkCard
        scopes={[]}
        canEdit
        canSeePricing={false}
        onAdd={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        onReorder={vi.fn()}
      />,
    );

  it('wires one id to both the label and the control, for Title and Description', async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole('button', { name: /add scope of work/i }));

    for (const name of [/^title$/i, /description \(optional\)/i]) {
      const control = screen.getByLabelText(name);
      const label = screen.getByText(name);
      expect(label.getAttribute('for')).toBe(control.id);
      expect(control.id).toBeTruthy();
    }
  });

  it('the Title Input and Description Textarea still carry their own aria-labels', async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole('button', { name: /add scope of work/i }));

    expect(screen.getByLabelText('New scope title')).toHaveAttribute('placeholder', 'e.g. Demo & haul-away');
    expect(screen.getByLabelText('New scope description').tagName).toBe('TEXTAREA');
  });
});

// ─── TotalsFooter - Sales tax jurisdiction (render-prop Select) ───────────

describe('TotalsFooter - FormField conversion (Sales tax jurisdiction, render-prop child)', () => {
  const renderFooter = () =>
    renderWithProviders(
      <TotalsFooter
        lines={[]}
        subtotal={100}
        tax_amount={0}
        tax_rate={0}
        discount_amount={0}
        tip={0}
        total_amount={100}
        editable
        hasInvoice
      />,
    );

  it('wires the FormField label to the SelectTrigger, not a manual aria-label', () => {
    renderFooter();
    const trigger = screen.getByRole('combobox', { name: 'Sales tax — jurisdiction' });
    const label = screen.getByText('Sales tax — jurisdiction');
    expect(label.getAttribute('for')).toBe(trigger.id);
    expect(trigger.id).toBeTruthy();
  });
});

// ─── CreateTaskModal - Title, Description (+ deferred compound pickers) ───

describe('CreateTaskModal - FormField conversion', () => {
  const renderModal = () =>
    renderWithProviders(<CreateTaskModal open onOpenChange={vi.fn()} />);

  it('wires one id to both the label and the control, for Title and Description', () => {
    renderModal();

    // Title is `required`, so its accessible name (used by getByLabelText) is
    // "Title *" - getByText, which matches a label's OWN direct text node
    // rather than the full accessible name, still finds "Title" alone. Both
    // matchers below use a start-anchored regex so one pair of names covers
    // both query shapes.
    for (const name of [/^title/i, /^description$/i]) {
      const control = screen.getByLabelText(name);
      const label = screen.getByText(name);
      expect(label.getAttribute('for')).toBe(control.id);
      expect(control.id).toBeTruthy();
    }
  });

  it('renders the Title FormField required-asterisk styling', () => {
    renderModal();
    // FormField's `required` renders the label text plus a trailing " *" span.
    const labelEl = screen.getByText(/^title$/i);
    expect(labelEl.parentElement?.textContent).toBe('Title *');
  });

  it('leaves Due Date/Priority/Linked To as plain, unwired labels - the recorded deferral', () => {
    renderModal();

    for (const text of ['Due Date', 'Priority', 'Linked To']) {
      const label = screen.getByText(text);
      expect(label.tagName).toBe('LABEL');
      // Deliberately NOT wired to a control via htmlFor/id - these wrap compound
      // pickers with no id prop of their own to receive FormField's fieldProps.
      expect(label).not.toHaveAttribute('for');
    }
  });

  it('wires the Assignees and Watchers labels to their pickers', () => {
    // These two shed the deferral above: the multi-assignee feature gave both
    // controls an explicit id (they had to be told apart in the DOM once the
    // drawer mounted two of them), and MultiAssigneeSelect forwards `id` to its
    // trigger - so there is no longer anything stopping the label naming it.
    renderModal();

    for (const [text, id] of [['Assignees', 'new-task-assignees'], ['Watchers', 'new-task-watchers']] as const) {
      const label = screen.getByText(text);
      expect(label.tagName).toBe('LABEL');
      expect(label).toHaveAttribute('for', id);
      expect(document.getElementById(id)).not.toBeNull();
    }
  });
});
