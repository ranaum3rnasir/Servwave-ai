/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { FORM_CATALOG } from '@/components/workflows/step-forms.fixture';
import { sendTextConfigSchema } from '@/lib/workflows/stepSchemas';
import type { WorkflowCatalog } from '@/lib/api/workflows';
import type { AssignableUser } from '@/lib/api/users';

import SendTextForm from '../components/sendTextForm';

/**
 * The FIRST suite for the ROUTED text form. `components/workflows/SendTextForm.test.tsx`
 * covers the unrouted v1 twin (/automations routes to the v2 fork), so every assertion about
 * what an admin actually sees had to be written here rather than extended there.
 *
 * What it pins is the change Spec C slice 8 makes: the form used to render a static
 * "Customer" badge under the Send-to label and hard-code `recipient: 'customer'` into its
 * defaults AND into every config it emitted. There was no picker to widen - the work was
 * adding one - so the regression guard that matters most is the customer round trip below.
 */

// FORM_CATALOG predates the v2.1 `audiences` field, so this layers on the slice the real
// catalog serves (catalog.ts's audiencesFor) post-slice-1: SEND_SMS is now SEND_EMAIL's list
// minus `custom`. TASK_ASSIGNED is here because Spec B landed the task entity and its
// audiences are entirely staff - the clearest case that the channel is no longer
// customer-only, and the trigger where a customer option would be wrong to offer at all.
const CATALOG: WorkflowCatalog = {
  ...FORM_CATALOG,
  triggers: {
    ...FORM_CATALOG.triggers,
    TASK_ASSIGNED: {
      label: 'Task is assigned',
      description: 'Fires when someone is added to a task.',
      category: 'events',
      entity: 'task',
      timeBased: false,
      mergeFields: ['task.number', 'task.title'],
    },
  } as unknown as WorkflowCatalog['triggers'],
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
    TASK_ASSIGNED: {
      SEND_SMS: [
        { key: 'assignees', label: 'the people it is assigned to' },
        { key: 'watchers', label: 'the watchers', hint: 'Skipped if nobody is watching the task.' },
        { key: 'creator', label: 'the creator', hint: 'Skipped if the record has no creator on file.' },
        { key: 'all_admins', label: 'all admins' },
        { key: 'specific_user', label: 'a specific person' },
        { key: 'assigned_user', label: 'the person just assigned' },
      ],
    },
  } as unknown as WorkflowCatalog['audiences'],
};

const MOCK_USERS: AssignableUser[] = [
  { id: 'u1', first_name: 'Ada', last_name: 'Lovelace', role: 'ADMIN', department: null },
  { id: 'u2', first_name: 'Grace', last_name: 'Hopper', role: 'TECHNICIAN', department: null },
];

vi.mock('@/lib/api/users', () => ({
  useAssignableUsers: vi.fn(() => ({ data: MOCK_USERS, isLoading: false })),
}));

function setup(config: Record<string, unknown>, triggerType: 'JOB_SCHEDULED' | 'TASK_ASSIGNED' = 'JOB_SCHEDULED') {
  const onChange = vi.fn();
  renderWithProviders(
    <SendTextForm config={config} triggerType={triggerType} catalog={CATALOG} onChange={onChange} />,
  );
  return { onChange, body: () => screen.getByLabelText('Message') as HTMLTextAreaElement };
}

describe('sendTextForm (v2) - the audiences the catalog serves', () => {
  it('offers every audience the catalog advertises for this trigger, hints included', () => {
    setup({ recipients: ['customer'], body: 'Hi' });

    for (const label of [
      'the customer',
      'the assigned crew',
      'the dispatcher',
      'the salesperson',
      'all admins',
      'all dispatchers',
      'a specific person',
    ]) {
      expect(screen.getByRole('checkbox', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByText('Skipped if no salesperson is set.')).toBeInTheDocument();
  });

  it('offers the email step’s list minus the custom-address option', () => {
    setup({ recipients: ['customer'], body: 'Hi' });

    const emailOnly = CATALOG.audiences.JOB_SCHEDULED.SEND_EMAIL.filter((o) => o.key !== 'custom');
    expect(screen.getAllByRole('checkbox')).toHaveLength(emailOnly.length);
    expect(screen.queryByRole('checkbox', { name: 'a custom email' })).toBeNull();
    expect(screen.queryByLabelText('Custom email address')).toBeNull();
  });

  it('lets the customer be UNticked - the audience is chosen, not announced', async () => {
    // The proof the static badge is gone. A badge can be read; it cannot be turned off, and
    // it could never emit an empty audience for the server to flag as needing setup.
    const { onChange } = setup({ recipients: ['customer'], body: 'Hi' });

    await userEvent.click(screen.getByRole('checkbox', { name: 'the customer' }));

    expect(onChange).toHaveBeenLastCalledWith({ recipients: [], body: 'Hi' });
    expect(screen.getByText('Pick at least one recipient')).toBeInTheDocument();
  });

  it('offers a task trigger’s staff audiences, with no customer among them', () => {
    setup({ recipients: [], body: '' }, 'TASK_ASSIGNED');

    expect(screen.getByRole('checkbox', { name: 'the people it is assigned to' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'the watchers' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'the person just assigned' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'the customer' })).toBeNull();
  });

  it('prompts for a recipient when the step has none yet', () => {
    setup({ recipients: [], body: '' });
    expect(screen.getByText('Pick at least one recipient')).toBeInTheDocument();
  });
});

describe('sendTextForm (v2) - what it emits', () => {
  it('emits a recipients array for a staff audience, never a singular customer', async () => {
    const { onChange } = setup({ recipients: [], body: 'On our way' });

    await userEvent.click(screen.getByRole('checkbox', { name: 'the assigned crew' }));

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ recipients: ['assigned_team'], body: 'On our way' }),
    );
    const cfg = onChange.mock.lastCall?.[0] as Record<string, unknown>;
    expect(cfg.recipient).not.toBe('customer');
  });

  it('carries the chosen people as user_ids when a named team member is picked', async () => {
    const { onChange } = setup({ recipients: [], body: 'Heads up' });

    await userEvent.click(screen.getByRole('checkbox', { name: 'a specific person' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Ada Lovelace' }));

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ recipients: ['specific_user'], user_ids: ['u1'], body: 'Heads up' }),
    );
  });

  it('requires the person to be chosen: specific_user with nobody picked says so', async () => {
    setup({ recipients: [], body: 'Heads up' });

    await userEvent.click(screen.getByRole('checkbox', { name: 'a specific person' }));
    expect(screen.getByText('Pick at least one team member')).toBeInTheDocument();
  });

  it('drops the chosen people again when the named-member audience is unticked', async () => {
    const { onChange } = setup({ recipients: ['specific_user'], user_ids: ['u1'], body: 'Heads up' });

    await userEvent.click(screen.getByRole('checkbox', { name: 'a specific person' }));

    const cfg = onChange.mock.lastCall?.[0] as Record<string, unknown>;
    expect(cfg.recipients).toEqual([]);
    expect(cfg.user_ids).toBeUndefined();
  });

  it('emits several audiences at once', async () => {
    const { onChange } = setup({ recipients: ['customer'], body: 'Hi' });

    await userEvent.click(screen.getByRole('checkbox', { name: 'the dispatcher' }));

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ recipients: ['customer', 'dispatcher'], body: 'Hi' }),
    );
  });
});

// The additive-change regression guard. A customer text automation authored before this slice
// must open the same way and republish the same bytes; the whole feature is worthless if
// widening the audience quietly re-addressed the existing ones.
describe('sendTextForm (v2) - an existing customer automation is untouched', () => {
  it('opens with the customer ticked and nothing else', () => {
    setup({ recipients: ['customer'], body: 'On our way' });

    expect(screen.getByRole('checkbox', { name: 'the customer' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'the dispatcher' })).not.toBeChecked();
    expect(screen.getByLabelText('Message')).toHaveValue('On our way');
  });

  it('re-emits the customer, singular field included, when the copy is edited', () => {
    const { onChange } = setup({ recipients: ['customer'], body: 'On our way' });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'On our way now' } });

    expect(onChange).toHaveBeenLastCalledWith({
      recipients: ['customer'],
      recipient: 'customer',
      body: 'On our way now',
    });
  });

  it('opens a legacy singular-recipient config with the customer ticked', () => {
    setup({ recipient: 'customer', body: 'Hi' });
    expect(screen.getByRole('checkbox', { name: 'the customer' })).toBeChecked();
  });
});

// Reopening is the half of "publishing succeeds" this component owns: the server stores what
// the form emitted, and the form has to read its own output back.
describe('sendTextForm (v2) - a staff-addressed step reopens as it was saved', () => {
  it('shows the assigned crew still ticked', () => {
    setup({ recipients: ['assigned_team'], recipient: 'assigned_techs', body: 'On our way' });

    expect(screen.getByRole('checkbox', { name: 'the assigned crew' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'the customer' })).not.toBeChecked();
  });

  it('shows the named team member still chosen', () => {
    setup({ recipients: ['specific_user'], user_ids: ['u1'], body: 'Heads up' });

    expect(screen.getByRole('checkbox', { name: 'a specific person' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Ada Lovelace' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Grace Hopper' })).not.toBeChecked();
    expect(screen.queryByText('Pick at least one team member')).toBeNull();
  });

  it('re-emits the crew unchanged when only the copy is edited', () => {
    const { onChange } = setup({ recipients: ['assigned_team'], body: 'On our way' });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Running late' } });

    expect(onChange).toHaveBeenLastCalledWith({
      recipients: ['assigned_team'],
      recipient: 'assigned_techs',
      body: 'Running late',
    });
  });
});

// The customer-only constraint was duplicated across layers, so the defect this guards is a
// single STALE layer: a config the form happily emits that the validation mirror - and so the
// server, which the mirror is a 1:1 copy of - would refuse.
describe('sendTextForm (v2) - everything it emits survives the validation mirror', () => {
  it.each([
    ['the assigned crew'],
    ['the dispatcher'],
    ['the salesperson'],
    ['all admins'],
    ['all dispatchers'],
  ])('a step addressed to %s parses', async (audience) => {
    const { onChange } = setup({ recipients: [], body: 'On our way' });

    await userEvent.click(screen.getByRole('checkbox', { name: audience }));

    const cfg = onChange.mock.lastCall?.[0] as Record<string, unknown>;
    const parsed = sendTextConfigSchema.safeParse(cfg);
    expect(parsed.success).toBe(true);
  });

  it('a step addressed to a named team member parses, user_ids included', async () => {
    const { onChange } = setup({ recipients: [], body: 'Heads up' });

    await userEvent.click(screen.getByRole('checkbox', { name: 'a specific person' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Grace Hopper' }));

    const cfg = onChange.mock.lastCall?.[0] as Record<string, unknown>;
    expect(sendTextConfigSchema.safeParse(cfg).success).toBe(true);
  });

  it('a task step addressed to the assignees parses', async () => {
    const { onChange } = setup({ recipients: [], body: 'Your task is up' }, 'TASK_ASSIGNED');

    await userEvent.click(screen.getByRole('checkbox', { name: 'the people it is assigned to' }));

    const cfg = onChange.mock.lastCall?.[0] as Record<string, unknown>;
    expect(sendTextConfigSchema.safeParse(cfg).success).toBe(true);
  });
});

describe('sendTextForm (v2) - copy and limits', () => {
  it('no longer claims texts land in the customer’s conversation', () => {
    setup({ recipients: ['customer'], body: 'Hi' });
    expect(screen.queryByText(/customer’s conversation/)).toBeNull();
    expect(screen.getByText(/no phone number on file/i)).toBeInTheDocument();
  });

  it('a 321-char body shows the plain-English error and the meter turns red', async () => {
    setup({ recipients: ['customer'], body: '' });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'a'.repeat(321) } });

    expect(await screen.findByText('Texts are capped at 320 characters')).toBeInTheDocument();
    expect(screen.getByText('321 / 320').className).toContain('text-destructive');
  });

  it('inserts a merge field at the caret and flips that chip to "in use"', async () => {
    setup({ recipients: ['customer'], body: 'AB' });
    const textarea = screen.getByLabelText('Message') as HTMLTextAreaElement;
    // Exact: the chip's trailing "if empty, fill with" icon is also named after the field.
    const chip = screen.getByRole('button', { name: /^Job number$/i });
    expect(chip).toHaveAttribute('aria-pressed', 'false');

    textarea.focus();
    textarea.setSelectionRange(1, 1);
    await userEvent.click(chip);

    expect(textarea.value).toBe('A{{job.number}}B');
    expect(screen.getByRole('button', { name: /^Job number$/i })).toHaveAttribute('aria-pressed', 'true');
  });
});

// ── "If empty, fill with" ────────────────────────────────────────────────────
//
// Spec: md_files/specs/scheduling/2026-09-13-customer-scheduling-notifications-and-visit-milestones.md
// The fallback map lives in the step config beside the body. A step that already carries one
// shows it and emits the edit; a step stored before the map existed shows the catalog's seeded
// defaults in the popover, and the first edit emits the whole map (defaults plus the edit) so the
// server's read-as-is rule never turns an untouched default into an empty field.

const FALLBACK_CATALOG: WorkflowCatalog = {
  ...CATALOG,
  triggers: {
    ...CATALOG.triggers,
    JOB_SCHEDULED: {
      ...CATALOG.triggers.JOB_SCHEDULED,
      mergeFields: ['customer.first_name', 'job.number', 'technician.names'],
    },
  },
  merge_field_labels: { ...CATALOG.merge_field_labels, 'technician.names': 'Technician name(s)' },
  default_fallbacks: { 'technician.names': 'Our team', 'customer.first_name': 'there' },
};

function setupWithFallbacks(config: Record<string, unknown>) {
  const onChange = vi.fn();
  renderWithProviders(
    <SendTextForm config={config} triggerType="JOB_SCHEDULED" catalog={FALLBACK_CATALOG} onChange={onChange} />,
  );
  return { onChange };
}

describe('sendTextForm (v2) - "If empty, fill with"', () => {
  it('shows a stored fallback in the chip popover and emits the edited map with the step', async () => {
    const user = userEvent.setup();
    const { onChange } = setupWithFallbacks({
      recipients: ['customer'],
      body: 'Hi',
      fallbacks: { 'technician.names': 'the crew', 'customer.first_name': 'there' },
    });

    await user.click(screen.getByRole('button', { name: 'Technician name(s): if empty, fill with' }));
    const field = await screen.findByRole('textbox', { name: 'If empty, fill with' });
    expect(field).toHaveValue('the crew');

    await user.clear(field);
    await user.type(field, 'your installer');

    expect(onChange).toHaveBeenLastCalledWith({
      recipients: ['customer'],
      recipient: 'customer',
      body: 'Hi',
      fallbacks: { 'technician.names': 'your installer', 'customer.first_name': 'there' },
    });
  });

  it('seeds the catalog defaults for a step stored without a map, and emits them all on the first edit', async () => {
    const user = userEvent.setup();
    const { onChange } = setupWithFallbacks({ recipients: ['customer'], body: 'Hi' });

    await user.click(screen.getByRole('button', { name: 'Technician name(s): if empty, fill with' }));
    const field = await screen.findByRole('textbox', { name: 'If empty, fill with' });
    expect(field).toHaveValue('Our team');

    await user.type(field, '!');

    expect(onChange).toHaveBeenLastCalledWith({
      recipients: ['customer'],
      recipient: 'customer',
      body: 'Hi',
      fallbacks: { 'technician.names': 'Our team!', 'customer.first_name': 'there' },
    });
  });

  it('leaves the emitted shape alone until a fallback is touched', async () => {
    const user = userEvent.setup();
    const { onChange } = setupWithFallbacks({ recipients: ['customer'], body: 'Hi' });

    await user.type(screen.getByLabelText('Message'), '!');

    expect(onChange).toHaveBeenLastCalledWith({ recipients: ['customer'], recipient: 'customer', body: 'Hi!' });

    // The map appears the moment a fallback IS touched, so the bare shape above is the form
    // holding back, not a form that never emits one.
    await user.click(screen.getByRole('button', { name: 'Technician name(s): if empty, fill with' }));
    await user.type(await screen.findByRole('textbox', { name: 'If empty, fill with' }), '!');

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ fallbacks: { 'technician.names': 'Our team!', 'customer.first_name': 'there' } }),
    );
  });
});
