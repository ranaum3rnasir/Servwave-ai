/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { FORM_CATALOG } from '@/components/workflows/step-forms.fixture';
import type { WorkflowCatalog } from '@/lib/api/workflows';
import type { AssignableUser } from '@/lib/api/users';

import SendEmailForm from '../components/sendEmailForm';

/**
 * "If empty, fill with" on the ROUTED email form (/automations routes to the v2 fork).
 *
 * Spec: md_files/specs/scheduling/2026-09-13-customer-scheduling-notifications-and-visit-milestones.md
 * Same contract as the text form: a stored map shows and edits in place; a step stored without
 * one shows the catalog's seeded defaults and the first edit emits the whole map; an untouched
 * step keeps the shape it had.
 */

const MOCK_USERS: AssignableUser[] = [
  { id: 'u1', first_name: 'Ada', last_name: 'Lovelace', role: 'ADMIN', department: null },
];

vi.mock('@/lib/api/users', () => ({
  useAssignableUsers: vi.fn(() => ({ data: MOCK_USERS, isLoading: false })),
}));

const CATALOG: WorkflowCatalog = {
  ...FORM_CATALOG,
  triggers: {
    ...FORM_CATALOG.triggers,
    JOB_SCHEDULED: {
      ...FORM_CATALOG.triggers.JOB_SCHEDULED,
      mergeFields: ['customer.first_name', 'job.number', 'technician.names'],
    },
  },
  merge_field_labels: { ...FORM_CATALOG.merge_field_labels, 'technician.names': 'Technician name(s)' },
  audiences: {
    JOB_SCHEDULED: {
      SEND_EMAIL: [
        { key: 'customer', label: 'the customer' },
        { key: 'all_admins', label: 'all admins' },
      ],
      SEND_SMS: [{ key: 'customer', label: 'the customer' }],
    },
  } as unknown as WorkflowCatalog['audiences'],
  default_fallbacks: { 'technician.names': 'Our team', 'customer.first_name': 'there' },
};

function setup(config: Record<string, unknown>) {
  const onChange = vi.fn();
  renderWithProviders(
    <SendEmailForm config={config} triggerType="JOB_SCHEDULED" catalog={CATALOG} onChange={onChange} />,
  );
  return { onChange };
}

describe('sendEmailForm (v2) - "If empty, fill with"', () => {
  it('shows a stored fallback in the chip popover and emits the edited map with the step', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({
      recipients: ['customer'],
      subject: 'Visit',
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
      subject: 'Visit',
      body: 'Hi',
      fallbacks: { 'technician.names': 'your installer', 'customer.first_name': 'there' },
    });
  });

  it('seeds the catalog defaults for a step stored without a map, and emits them all on the first edit', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ recipients: ['customer'], subject: 'Visit', body: 'Hi' });

    await user.click(screen.getByRole('button', { name: 'Technician name(s): if empty, fill with' }));
    const field = await screen.findByRole('textbox', { name: 'If empty, fill with' });
    expect(field).toHaveValue('Our team');

    await user.type(field, '!');

    expect(onChange).toHaveBeenLastCalledWith({
      recipients: ['customer'],
      recipient: 'customer',
      subject: 'Visit',
      body: 'Hi',
      fallbacks: { 'technician.names': 'Our team!', 'customer.first_name': 'there' },
    });
  });

  it('leaves the emitted shape alone until a fallback is touched', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ recipients: ['customer'], subject: 'Visit', body: 'Hi' });

    await user.type(screen.getByLabelText('Subject'), '!');

    expect(onChange).toHaveBeenLastCalledWith({
      recipients: ['customer'],
      recipient: 'customer',
      subject: 'Visit!',
      body: 'Hi',
    });

    // The map appears the moment a fallback IS touched, so the bare shape above is the form
    // holding back, not a form that never emits one.
    await user.click(screen.getByRole('button', { name: 'Technician name(s): if empty, fill with' }));
    await user.type(await screen.findByRole('textbox', { name: 'If empty, fill with' }), '!');

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ fallbacks: { 'technician.names': 'Our team!', 'customer.first_name': 'there' } }),
    );
  });
});
