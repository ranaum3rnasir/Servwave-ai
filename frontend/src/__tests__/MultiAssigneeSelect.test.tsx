/**
 * The crew picker resolves a chip's name from the RECORD, not only from the roster - and says
 * something honest when there is nobody left it may add.
 *
 * WHY THIS FILE EXISTS. `GET /api/users/assignable` is scoped: a salesperson without the
 * `assign User` grant gets exactly one row, themselves. That is the product rule. But the rep
 * who owns the lead owns its job and may READ everything on it, including the name of the
 * technician a dispatcher put on their walkthrough. The picker used to build its id -> name map
 * from the roster alone, so that chip rendered the literal string `Unknown`, and an empty
 * roster made the trigger say `No more members` - a rule reported as an absence.
 *
 * Nothing here is stubbed but the roster query and the ability, because the two strings under
 * test are produced by this component and by nothing else; a stub would assert the stub.
 *
 * `pages/v2/leads/__tests__/walkthroughSchedule.test.tsx` and `walkthroughReschedule.test.tsx`
 * MOCK this component out entirely, which is why neither of them can catch any of this.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { MultiAssigneeSelect } from '@/components/crm/MultiAssigneeSelect';
import type { AssignableUser } from '@/lib/api/users';

const ME = 'user-rep';
const TECH = 'user-tech';

/** The rep, and only the rep - what the scoped endpoint returns without the grant. */
const SELF_ONLY: AssignableUser[] = [
  { id: ME, first_name: 'Rita', last_name: 'Rep', role: 'SALES', department: null },
];

/** Mutable so a test can swap the pool; read at render time, so vi.mock's hoisting is fine. */
let mockRoster: AssignableUser[] = SELF_ONLY;

vi.mock('@/lib/api/users', () => ({
  useAssignableUsers: vi.fn(() => ({ data: mockRoster, isLoading: false })),
}));

/** The grant that means "you may name people other than yourself" for a crew/performer picker. */
const MAY_ASSIGN_USERS = () => buildAbility([{ action: 'assign', subject: 'User' }]);
/**
 * A DISPATCHER's shape for the two cases below: `read User` and `assign User`, and NO
 * `assign Task` - which no seeded role holds. This is the principal the endpoint answers
 * differently from what this component used to claim.
 */
const A_DISPATCHER = () =>
  buildAbility([
    { action: 'read', subject: 'User' },
    { action: 'assign', subject: 'User' },
  ]);

beforeEach(() => {
  mockRoster = SELF_ONLY;
});

describe('MultiAssigneeSelect - a chip is labelled from the record when the roster cannot', () => {
  it('names a selected person the scoped roster does not contain', () => {
    renderWithProviders(
      <MultiAssigneeSelect
        value={[ME, TECH]}
        onChange={vi.fn()}
        purpose="walkthroughPerformer"
        // Exactly what `lead.walkthrough_performers[].user` carries, passed straight through.
        knownPeople={[
          { id: ME, first_name: 'Rita', last_name: 'Rep' },
          { id: TECH, first_name: 'Tomas', last_name: 'Tech' },
        ]}
      />,
    );

    // The one the roster cannot explain is the whole point: the rep may not ADD Tomas, and can
    // still see that Tomas is on their walkthrough.
    expect(screen.getByText('Tomas Tech')).toBeInTheDocument();
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
  });

  it('accepts the whole-name shape the task payloads use, not just first/last', () => {
    renderWithProviders(
      <MultiAssigneeSelect
        value={[TECH]}
        onChange={vi.fn()}
        purpose="task"
        // `TaskPersonRef` is `{ id, name }`; accepting it is what lets the task drawers pass
        // `task.assignees` through with no mapping step to get wrong.
        knownPeople={[{ id: TECH, name: 'Tomas Tech' }]}
      />,
    );

    expect(screen.getByText('Tomas Tech')).toBeInTheDocument();
  });

  it('still says Unknown for an id neither the roster nor the record can name', () => {
    renderWithProviders(
      <MultiAssigneeSelect
        value={['user-ghost']}
        onChange={vi.fn()}
        purpose="jobCrew"
        knownPeople={[{ id: TECH, first_name: 'Tomas', last_name: 'Tech' }]}
      />,
    );

    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('drops a nameless row rather than rendering a blank chip', () => {
    renderWithProviders(
      <MultiAssigneeSelect
        value={[TECH]}
        onChange={vi.fn()}
        purpose="jobCrew"
        // `TaskPersonRef.name` is null when the id no longer resolves to a user.
        knownPeople={[{ id: TECH, name: null }]}
      />,
    );

    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('prefers the roster over the record, so a renamed user is not shown under a stale name', () => {
    mockRoster = [
      { id: TECH, first_name: 'Tomas', last_name: 'Married', role: 'TECHNICIAN', department: null },
    ];
    renderWithProviders(
      <MultiAssigneeSelect
        value={[TECH]}
        onChange={vi.fn()}
        purpose="jobCrew"
        knownPeople={[{ id: TECH, first_name: 'Tomas', last_name: 'Maiden' }]}
      />,
    );

    expect(screen.getByText('Tomas Married')).toBeInTheDocument();
    expect(screen.queryByText('Tomas Maiden')).not.toBeInTheDocument();
  });

  it('does NOT offer a known-but-unrostered person in the dropdown', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <MultiAssigneeSelect
        value={[]}
        onChange={vi.fn()}
        purpose="jobCrew"
        knownPeople={[{ id: TECH, first_name: 'Tomas', last_name: 'Tech' }]}
      />,
      { ability: MAY_ASSIGN_USERS() },
    );

    await user.click(screen.getByRole('combobox'));

    // Naming somebody is a LABEL, never a grant: the roster is still the only source of
    // candidates, and Tomas is not in it.
    const options = screen.getAllByRole('option').map((o) => (o.textContent ?? '').trim());
    expect(options).toEqual(['Rita Rep']);
  });
});

describe('MultiAssigneeSelect - an empty dropdown is either an absence or a rule', () => {
  it('says the rule, not "No more members", when the user may not name anyone else', () => {
    // No ability provided -> emptyAbility -> no `assign User`. The rep has themselves and has
    // already picked themselves, so there is genuinely nothing to add - but the REASON is the
    // grant, and the trigger must not report it as a roster that ran out.
    renderWithProviders(
      <MultiAssigneeSelect value={[ME]} onChange={vi.fn()} purpose="walkthroughPerformer" />,
    );

    expect(screen.getByText('You cannot add others')).toBeInTheDocument();
    expect(screen.queryByText('No more members')).not.toBeInTheDocument();
  });

  it('keeps "No more members" for a grant holder who has simply picked everyone', () => {
    renderWithProviders(
      <MultiAssigneeSelect value={[ME]} onChange={vi.fn()} purpose="walkthroughPerformer" />,
      { ability: MAY_ASSIGN_USERS() },
    );

    expect(screen.getByText('No more members')).toBeInTheDocument();
    expect(screen.queryByText('You cannot add others')).not.toBeInTheDocument();
  });

  it('reads the grant the PURPOSE names: `assign User` does not unlock the task picker', () => {
    // Pins the mapping rather than the string. `task` resolves to `assign Task` server-side
    // (resolveAssigneePool), so a holder of `assign User` alone is still self-only here.
    renderWithProviders(
      <MultiAssigneeSelect value={[ME]} onChange={vi.fn()} purpose="task" />,
      { ability: MAY_ASSIGN_USERS() },
    );

    expect(screen.getByText('You cannot add others')).toBeInTheDocument();
  });

  // THE WORDING HAS TO MATCH THE ENDPOINT, and for `task` it did not. `purpose=task` is held
  // open server-side for any holder of `read User` (#1950's hold), so a DISPATCHER is handed the
  // whole org roster while this trigger - reading `assign Task`, which no seeded role holds -
  // told them "You cannot add others". Two different answers to one question, on one screen.
  it('does not tell a DISPATCHER they cannot add others on a task picker the server holds open', () => {
    renderWithProviders(
      <MultiAssigneeSelect value={[ME]} onChange={vi.fn()} purpose="task" />,
      { ability: A_DISPATCHER() },
    );

    expect(screen.queryByText('You cannot add others')).not.toBeInTheDocument();
    expect(screen.getByText('No more members')).toBeInTheDocument();
  });

  // ...and the directory family reads its own gate. `assign User` is not it: the same dispatcher
  // stripped of `read User` is locked here while a crew picker still opens for them.
  it('reads `read User` for the directory purpose, not `assign User`', () => {
    renderWithProviders(
      <MultiAssigneeSelect value={[ME]} onChange={vi.fn()} purpose="directory" />,
      { ability: MAY_ASSIGN_USERS() },
    );

    expect(screen.getByText('You cannot add others')).toBeInTheDocument();
  });

  it('says nothing of the sort while there is still somebody to add', () => {
    renderWithProviders(
      <MultiAssigneeSelect value={[]} onChange={vi.fn()} purpose="walkthroughPerformer" />,
    );

    expect(screen.getByText('Add member...')).toBeInTheDocument();
    expect(screen.queryByText('You cannot add others')).not.toBeInTheDocument();
    expect(screen.queryByText('No more members')).not.toBeInTheDocument();
  });
});
