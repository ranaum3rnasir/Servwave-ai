import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import RecipientMultiSelect from './RecipientMultiSelect';
import type { AudienceKey, AudienceOption } from '@/lib/api/workflows';
import type { AssignableUser } from '@/lib/api/users';

// Mirrors the real catalog's audiencesFor() output (backend/src/services/
// automations/catalog.ts) for a job trigger's SEND_EMAIL action.
const JOB_EMAIL_OPTIONS: AudienceOption[] = [
  { key: 'customer', label: 'the customer' },
  { key: 'assigned_team', label: 'the assigned crew', hint: 'Skipped if no one is assigned yet.' },
  { key: 'dispatcher', label: 'the dispatcher', hint: 'Skipped if no dispatcher is set.' },
  { key: 'salesperson', label: 'the salesperson', hint: 'Skipped if no salesperson is set.' },
  { key: 'all_admins', label: 'all admins' },
  { key: 'all_dispatchers', label: 'all dispatchers' },
  { key: 'specific_user', label: 'a specific person' },
  { key: 'custom', label: 'a custom email' },
];

// Mirrors an invoice trigger's SEND_EMAIL action — no salesperson/dispatcher/assigned_team.
const INVOICE_EMAIL_OPTIONS: AudienceOption[] = [
  { key: 'customer', label: 'the customer' },
  { key: 'all_admins', label: 'all admins' },
  { key: 'all_dispatchers', label: 'all dispatchers' },
  { key: 'specific_user', label: 'a specific person' },
  { key: 'custom', label: 'a custom email' },
];

// Mirrors a TASK_CREATED trigger's SEND_EMAIL action. A task has no customer, and its two
// people lists are Spec B's new audiences. This fixture is also the type pin for them:
// `AudienceOption['key']` is `AudienceKey`, the frontend's hand-written mirror of the backend
// `RecipientKey`, so a mirror that has drifted behind the backend cannot express these two keys
// and the frontend typecheck goes red. Nothing else on the frontend would notice - the catalog
// arrives from the API as data, and foldLegacyAudienceKey casts a bare string into the union.
const TASK_EMAIL_OPTIONS: AudienceOption[] = [
  { key: 'assignees', label: 'the assignees' },
  { key: 'watchers', label: 'the watchers', hint: 'Skipped if nobody is watching the task.' },
  { key: 'creator', label: 'the creator', hint: 'Skipped if the record has no creator on file.' },
  { key: 'all_admins', label: 'all admins' },
  { key: 'all_dispatchers', label: 'all dispatchers' },
  { key: 'specific_user', label: 'a specific person' },
  { key: 'custom', label: 'a custom email' },
];

const MOCK_USERS: AssignableUser[] = [
  { id: 'u1', first_name: 'Ada', last_name: 'Lovelace', role: 'ADMIN', department: null },
  { id: 'u2', first_name: 'Grace', last_name: 'Hopper', role: 'DISPATCHER', department: null },
];

vi.mock('@/lib/api/users', () => ({
  useAssignableUsers: vi.fn(() => ({ data: MOCK_USERS, isLoading: false })),
}));

/** Stateful wrapper so interaction tests exercise a real controlled round-trip,
 * while still spying on every emitted array for exact-value assertions. */
function Harness({
  options = JOB_EMAIL_OPTIONS,
  initialRecipients = [],
  initialUserIds = [],
  initialCustomEmails = [],
  onRecipientsSpy,
  onUserIdsSpy,
  onCustomEmailsSpy,
}: {
  options?: AudienceOption[];
  initialRecipients?: AudienceKey[];
  initialUserIds?: string[];
  initialCustomEmails?: string[];
  onRecipientsSpy?: (v: AudienceKey[]) => void;
  onUserIdsSpy?: (v: string[]) => void;
  onCustomEmailsSpy?: (v: string[]) => void;
}) {
  const [recipients, setRecipients] = useState<AudienceKey[]>(initialRecipients);
  const [userIds, setUserIds] = useState<string[]>(initialUserIds);
  const [customEmails, setCustomEmails] = useState<string[]>(initialCustomEmails);
  return (
    <RecipientMultiSelect
      options={options}
      recipients={recipients}
      userIds={userIds}
      customEmails={customEmails}
      onRecipientsChange={(next) => {
        onRecipientsSpy?.(next);
        setRecipients(next);
      }}
      onUserIdsChange={(next) => {
        onUserIdsSpy?.(next);
        setUserIds(next);
      }}
      onCustomEmailsChange={(next) => {
        onCustomEmailsSpy?.(next);
        setCustomEmails(next);
      }}
    />
  );
}

describe('RecipientMultiSelect — renders the legal audiences it is given', () => {
  it('renders exactly the given options as checkboxes (job trigger set)', () => {
    renderWithProviders(<Harness options={JOB_EMAIL_OPTIONS} />);
    for (const opt of JOB_EMAIL_OPTIONS) {
      expect(screen.getByRole('checkbox', { name: opt.label })).toBeInTheDocument();
    }
    // Nothing ticked yet, so no reveal-only checkboxes (specific_user's picker) exist.
    expect(screen.getAllByRole('checkbox')).toHaveLength(JOB_EMAIL_OPTIONS.length);
  });

  it('omits salesperson (and other job-only audiences) for an invoice trigger set', () => {
    renderWithProviders(<Harness options={INVOICE_EMAIL_OPTIONS} />);
    expect(screen.queryByRole('checkbox', { name: 'the salesperson' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'the assigned crew' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'the dispatcher' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'the customer' })).toBeInTheDocument();
  });

  it('offers the task audiences, and round-trips assignees/watchers as picked values', () => {
    renderWithProviders(
      <Harness options={TASK_EMAIL_OPTIONS} initialRecipients={['assignees', 'watchers']} />,
    );
    expect(screen.getByRole('checkbox', { name: 'the assignees' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'the watchers' })).toBeChecked();
    expect(screen.getByText('Skipped if nobody is watching the task.')).toBeInTheDocument();
    // A task carries no customer of its own, so that audience is never on offer for one.
    expect(screen.queryByRole('checkbox', { name: 'the customer' })).toBeNull();
  });

  it('renders the not-guaranteed hint for salesperson', () => {
    renderWithProviders(<Harness options={JOB_EMAIL_OPTIONS} />);
    expect(screen.getByText('Skipped if no salesperson is set.')).toBeInTheDocument();
  });

  it('renders exactly one hint per not-guaranteed audience, none for the rest', () => {
    renderWithProviders(<Harness options={JOB_EMAIL_OPTIONS} />);
    // assigned_team + dispatcher + salesperson carry a hint in this fixture; the
    // other five options (customer/all_admins/all_dispatchers/specific_user/custom) don't.
    const hintCount = JOB_EMAIL_OPTIONS.filter((o) => o.hint).length;
    expect(screen.getAllByText(/^Skipped if /)).toHaveLength(hintCount);
  });
});

describe('RecipientMultiSelect — ticking audiences', () => {
  it('ticking two audiences emits recipients: [a, b] in tick order', async () => {
    const user = userEvent.setup();
    const onRecipientsSpy = vi.fn();
    renderWithProviders(<Harness onRecipientsSpy={onRecipientsSpy} />);

    await user.click(screen.getByRole('checkbox', { name: 'the customer' }));
    expect(onRecipientsSpy).toHaveBeenLastCalledWith(['customer']);

    await user.click(screen.getByRole('checkbox', { name: 'the salesperson' }));
    expect(onRecipientsSpy).toHaveBeenLastCalledWith(['customer', 'salesperson']);
  });

  it('unticking an audience removes it from recipients', async () => {
    const user = userEvent.setup();
    const onRecipientsSpy = vi.fn();
    renderWithProviders(<Harness initialRecipients={['customer', 'salesperson']} onRecipientsSpy={onRecipientsSpy} />);

    await user.click(screen.getByRole('checkbox', { name: 'the customer' }));
    expect(onRecipientsSpy).toHaveBeenLastCalledWith(['salesperson']);
  });

  it('shows "Pick at least one recipient" when nothing is ticked, and clears once something is', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    expect(screen.getByText('Pick at least one recipient')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'the customer' }));
    expect(screen.queryByText('Pick at least one recipient')).toBeNull();
  });
});

describe('RecipientMultiSelect — specific_user reveal (multi)', () => {
  it('reveals the team-member picker only once specific_user is ticked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    expect(screen.queryByRole('checkbox', { name: 'Ada Lovelace' })).toBeNull();

    await user.click(screen.getByRole('checkbox', { name: 'a specific person' }));
    expect(screen.getByRole('checkbox', { name: 'Ada Lovelace' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Grace Hopper' })).toBeInTheDocument();
  });

  it('requires at least one team member once revealed', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await user.click(screen.getByRole('checkbox', { name: 'a specific person' }));
    expect(screen.getByText('Pick at least one team member')).toBeInTheDocument();
  });

  it('picking two team members emits user_ids: [id1, id2]', async () => {
    const user = userEvent.setup();
    const onUserIdsSpy = vi.fn();
    renderWithProviders(<Harness initialRecipients={['specific_user']} onUserIdsSpy={onUserIdsSpy} />);

    await user.click(screen.getByRole('checkbox', { name: 'Ada Lovelace' }));
    expect(onUserIdsSpy).toHaveBeenLastCalledWith(['u1']);

    await user.click(screen.getByRole('checkbox', { name: 'Grace Hopper' }));
    expect(onUserIdsSpy).toHaveBeenLastCalledWith(['u1', 'u2']);
  });

  it('unticking specific_user clears user_ids and hides the picker', async () => {
    const user = userEvent.setup();
    const onUserIdsSpy = vi.fn();
    renderWithProviders(
      <Harness initialRecipients={['specific_user']} initialUserIds={['u1']} onUserIdsSpy={onUserIdsSpy} />,
    );

    await user.click(screen.getByRole('checkbox', { name: 'a specific person' }));
    expect(onUserIdsSpy).toHaveBeenLastCalledWith([]);
    expect(screen.queryByRole('checkbox', { name: 'Ada Lovelace' })).toBeNull();
  });
});

describe('RecipientMultiSelect — custom email reveal', () => {
  it('reveals the email field only once custom is ticked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    expect(screen.queryByLabelText('Custom email address')).toBeNull();

    await user.click(screen.getByRole('checkbox', { name: 'a custom email' }));
    expect(screen.getByLabelText('Custom email address')).toHaveValue('');
  });

  it('requires at least one address once revealed', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await user.click(screen.getByRole('checkbox', { name: 'a custom email' }));
    expect(screen.getByText('Enter at least one email address')).toBeInTheDocument();
  });

  it('typing an address and pressing Enter adds it to custom_emails', async () => {
    const user = userEvent.setup();
    const onCustomEmailsSpy = vi.fn();
    renderWithProviders(<Harness initialRecipients={['custom']} onCustomEmailsSpy={onCustomEmailsSpy} />);

    await user.type(screen.getByLabelText('Custom email address'), 'office@example.com{Enter}');
    expect(onCustomEmailsSpy).toHaveBeenLastCalledWith(['office@example.com']);
    expect(screen.getByText('office@example.com')).toBeInTheDocument();
  });

  it('flags an invalid address instead of adding it', async () => {
    const user = userEvent.setup();
    const onCustomEmailsSpy = vi.fn();
    renderWithProviders(<Harness initialRecipients={['custom']} onCustomEmailsSpy={onCustomEmailsSpy} />);

    await user.type(screen.getByLabelText('Custom email address'), 'not-an-email{Enter}');
    expect(screen.getByText('Enter a valid email address')).toBeInTheDocument();
    expect(onCustomEmailsSpy).not.toHaveBeenCalled();
  });

  it('unticking custom clears custom_emails and hides the field', async () => {
    const user = userEvent.setup();
    const onCustomEmailsSpy = vi.fn();
    renderWithProviders(
      <Harness
        initialRecipients={['custom']}
        initialCustomEmails={['office@example.com']}
        onCustomEmailsSpy={onCustomEmailsSpy}
      />,
    );

    await user.click(screen.getByRole('checkbox', { name: 'a custom email' }));
    expect(onCustomEmailsSpy).toHaveBeenLastCalledWith([]);
    expect(screen.queryByLabelText('Custom email address')).toBeNull();
  });
});
