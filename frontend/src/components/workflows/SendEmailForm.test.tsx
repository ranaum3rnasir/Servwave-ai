import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import SendEmailForm from './SendEmailForm';
import { defaultConfig } from './useWorkflowDraft';
import { FORM_CATALOG } from './step-forms.fixture';
import type { AutomationTriggerType, WorkflowCatalog } from '@/lib/api/workflows';
import type { AssignableUser } from '@/lib/api/users';

// The shared FORM_CATALOG fixture predates the v2.1 `audiences` field (it's cast
// `as unknown as WorkflowCatalog`), so these tests layer on a small, realistic
// slice matching what the real catalog serves (catalog.ts's audiencesFor()) for
// a job trigger's SEND_EMAIL action — customer/assigned_team/dispatcher/
// salesperson/roles/specific_user/custom, salesperson carrying its not-guaranteed hint.
const CATALOG: WorkflowCatalog = {
  ...FORM_CATALOG,
  audiences: {
    JOB_SCHEDULED: {
      SEND_EMAIL: [
        { key: 'customer', label: 'the customer' },
        { key: 'assigned_team', label: 'the assigned crew', hint: 'Skipped if no one is assigned yet.' },
        { key: 'dispatcher', label: 'the dispatcher', hint: 'Skipped if no dispatcher is set.' },
        { key: 'salesperson', label: 'the salesperson', hint: 'Skipped if no salesperson is set.' },
        { key: 'all_admins', label: 'all admins' },
        { key: 'all_dispatchers', label: 'all dispatchers' },
        { key: 'specific_user', label: 'a specific person' },
        { key: 'custom', label: 'a custom email' },
      ],
      // Spec C slice 8: SEND_SMS is SEND_EMAIL's list minus `custom` - a handset has no
      // address to resolve. Kept faithful here even though this suite only reads SEND_EMAIL,
      // so the fixture never re-teaches the customer-only rule to whoever copies it next.
      SEND_SMS: [
        { key: 'customer', label: 'the customer' },
        { key: 'assigned_team', label: 'the assigned crew', hint: 'Skipped if no one is assigned yet.' },
        { key: 'dispatcher', label: 'the dispatcher', hint: 'Skipped if no dispatcher is set.' },
        { key: 'salesperson', label: 'the salesperson', hint: 'Skipped if no salesperson is set.' },
        { key: 'all_admins', label: 'all admins' },
        { key: 'all_dispatchers', label: 'all dispatchers' },
        { key: 'specific_user', label: 'a specific person' },
      ],
    },
    // Spec B's TASK_CREATED slice, mirroring catalog.ts's audiencesFor(). A task has no
    // customer, so `customer` is ABSENT here - that absence is the whole point of the
    // task-trigger tests below, and adding the key would make them pass vacuously.
    TASK_CREATED: {
      SEND_EMAIL: [
        { key: 'assignees', label: 'the assignees' },
        { key: 'watchers', label: 'the watchers', hint: 'Skipped if nobody is watching the task.' },
        { key: 'creator', label: 'the creator', hint: 'Skipped if the record has no creator on file.' },
        { key: 'all_admins', label: 'all admins' },
        { key: 'all_dispatchers', label: 'all dispatchers' },
        { key: 'specific_user', label: 'a specific person' },
        { key: 'custom', label: 'a custom email' },
      ],
    },
  } as unknown as WorkflowCatalog['audiences'],
};

/** The REAL seed the builder mints for a brand-new email step - imported, never copied, so
 *  these tests cannot keep passing against a seed the builder has stopped using. */
const FRESH_EMAIL_STEP = defaultConfig('SEND_EMAIL');

const MOCK_USERS: AssignableUser[] = [
  { id: 'u1', first_name: 'Ada', last_name: 'Lovelace', role: 'ADMIN', department: null },
];

vi.mock('@/lib/api/users', () => ({
  useAssignableUsers: vi.fn(() => ({ data: MOCK_USERS, isLoading: false })),
}));

function setup(config: Record<string, unknown>, triggerType: AutomationTriggerType = 'JOB_SCHEDULED') {
  const onChange = vi.fn();
  renderWithProviders(
    <SendEmailForm config={config} triggerType={triggerType} catalog={CATALOG} onChange={onChange} />,
  );
  return { onChange };
}

describe('SendEmailForm — legal audiences + hints', () => {
  it('renders the audiences the catalog advertises for this trigger, salesperson hint included', () => {
    setup({ recipient: 'customer', subject: 'Hi', body: 'Body' });
    expect(screen.getByRole('checkbox', { name: 'the customer' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'the salesperson' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'a custom email' })).toBeInTheDocument();
    expect(screen.getByText('Skipped if no salesperson is set.')).toBeInTheDocument();
  });
});

describe('SendEmailForm — legacy singular recipient loads ticked', () => {
  it('a legacy { recipient: "customer" } config shows the customer box ticked', () => {
    setup({ recipient: 'customer', subject: 'Hi', body: 'Body' });
    expect(screen.getByRole('checkbox', { name: 'the customer' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'the salesperson' })).not.toBeChecked();
  });

  it('folds the pre-v2.1 assigned_techs alias to assigned_team on load', () => {
    setup({ recipient: 'assigned_techs', subject: 'Hi', body: 'Body' });
    expect(screen.getByRole('checkbox', { name: 'the assigned crew' })).toBeChecked();
  });
});

describe('SendEmailForm — multi-select emits the array shape', () => {
  it('ticking two audiences emits recipients: [a, b] alongside subject/body', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ recipient: 'customer', subject: 'Hi', body: 'Body' });

    await user.click(screen.getByRole('checkbox', { name: 'the salesperson' }));

    expect(onChange).toHaveBeenLastCalledWith({
      recipients: ['customer', 'salesperson'],
      subject: 'Hi',
      body: 'Body',
    });
  });

  it('ticking custom and adding an address emits custom_emails', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ recipient: 'customer', subject: 'Hi', body: 'Body' });

    await user.click(screen.getByRole('checkbox', { name: 'a custom email' }));
    await user.type(screen.getByLabelText('Custom email address'), 'office@example.com{Enter}');

    expect(onChange).toHaveBeenLastCalledWith({
      recipients: ['customer', 'custom'],
      subject: 'Hi',
      body: 'Body',
      custom_emails: ['office@example.com'],
    });
  });

  it('ticking specific_user and picking a team member emits user_ids', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ recipient: 'customer', subject: 'Hi', body: 'Body' });

    await user.click(screen.getByRole('checkbox', { name: 'a specific person' }));
    await user.click(screen.getByRole('checkbox', { name: 'Ada Lovelace' }));

    expect(onChange).toHaveBeenLastCalledWith({
      recipients: ['customer', 'specific_user'],
      subject: 'Hi',
      body: 'Body',
      user_ids: ['u1'],
    });
  });

  it('mirrors a single ticked audience onto legacy `recipient` (bubble/recipe sentence back-compat)', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ recipient: 'customer', subject: 'Hi', body: 'Body' });

    await user.type(screen.getByLabelText('Subject'), '!');

    expect(onChange).toHaveBeenLastCalledWith({
      recipients: ['customer'],
      recipient: 'customer',
      subject: 'Hi!',
      body: 'Body',
    });
  });

  it('mirrors a single assigned_team pick back to the legacy assigned_techs literal', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ recipient: 'customer', subject: 'Hi', body: 'Body' });

    await user.click(screen.getByRole('checkbox', { name: 'the customer' })); // untick the default
    await user.click(screen.getByRole('checkbox', { name: 'the assigned crew' }));

    expect(onChange).toHaveBeenLastCalledWith({
      recipients: ['assigned_team'],
      recipient: 'assigned_techs',
      subject: 'Hi',
      body: 'Body',
    });
  });

  it('does not mirror when two or more audiences are ticked', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ recipient: 'customer', subject: 'Hi', body: 'Body' });

    await user.click(screen.getByRole('checkbox', { name: 'all admins' }));

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0];
    expect(lastCall.recipients).toEqual(['customer', 'all_admins']);
    expect(lastCall).not.toHaveProperty('recipient');
  });
});

// The staging BLOCKER, reproduced at the level that caused it. The builder used to seed a new
// email step `{ recipient: 'customer', ... }`; `normalizeRecipientFields` folds a singular
// `recipient` INTO the array, so on a TASK trigger - the first entity whose audience map has
// no `customer` key - the form opened with an audience it does not render a checkbox for.
// There was no way to untick it, it survived the admin's own pick as
// `recipients: ["customer","assignees"]`, and publish 400'd with 'Recipient "customer" is not
// available for this trigger'. Seeding `recipients: []` is what these tests hold in place.
describe('SendEmailForm - a fresh step on a task trigger picks up no stale audience', () => {
  it('opens with nothing ticked and no customer option to untick', () => {
    setup(FRESH_EMAIL_STEP, 'TASK_CREATED');

    expect(screen.queryByRole('checkbox', { name: 'the customer' })).not.toBeInTheDocument();
    for (const name of ['the assignees', 'the watchers', 'the creator', 'all admins']) {
      expect(screen.getByRole('checkbox', { name })).not.toBeChecked();
    }
    expect(screen.getByText('Pick at least one recipient')).toBeInTheDocument();
  });

  it('emits only the audience the admin ticked, and every key it emits is one this trigger offers', async () => {
    const user = userEvent.setup();
    const { onChange } = setup(FRESH_EMAIL_STEP, 'TASK_CREATED');

    await user.click(screen.getByRole('checkbox', { name: 'the assignees' }));

    // The publishable shape: no `customer` riding along, and the singular mirror names the
    // same audience rather than a second, different one.
    expect(onChange).toHaveBeenLastCalledWith({
      recipients: ['assignees'],
      recipient: 'assignees',
      subject: '',
      body: '',
    });

    // The server's own legality rule, asserted the way validateWorkflowDefinition applies it:
    // every emitted key must be in the trigger's advertised audience list. This is the exact
    // check that produced the 400, so run it over what the form emits rather than trusting the
    // literal above.
    const offered = new Set<string>(CATALOG.audiences.TASK_CREATED.SEND_EMAIL.map((o) => o.key));
    const emitted = onChange.mock.calls.at(-1)?.[0] as { recipients: string[] };
    expect(emitted.recipients.every((key) => offered.has(key))).toBe(true);
  });
});

describe('SendEmailForm — custom recipient needs an address', () => {
  it('ticking custom with no address yet surfaces the same danger-text requirement style', async () => {
    const user = userEvent.setup();
    setup({ recipient: 'customer', subject: 'Hi', body: 'Body' });

    await user.click(screen.getByRole('checkbox', { name: 'a custom email' }));
    expect(screen.getByLabelText('Custom email address')).toHaveValue('');
    expect(screen.getByText('Enter at least one email address')).toBeInTheDocument();
  });
});
