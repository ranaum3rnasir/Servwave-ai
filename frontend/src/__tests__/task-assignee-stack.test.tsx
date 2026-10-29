/**
 * The assignee avatar stack, and the null-name case every task surface has to
 * survive.
 *
 * `assignee_ids` is a bare id array with no foreign key, so a deactivated or
 * deleted user leaves an id behind that resolves to `name: null`. Every renderer
 * has to tolerate that - `getInitials(null)` and `name.split(...)` are the two
 * ways this crashes a whole board, and neither is caught by typechecking a
 * fixture that always fills the name in.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { AssigneeStack } from '@/components/tasks/AssigneeStack';
import { taskAssignees, assigneeNames, assigneeTooltip } from '@/lib/tasks/assignees';
import type { Task, TaskPersonRef } from '@/lib/tasks/types';

function refs(...names: (string | null)[]): TaskPersonRef[] {
  return names.map((name, i) => ({ id: `u${i + 1}`, name }));
}

describe('AssigneeStack', () => {
  it('renders one tile per assignee when the set fits under the cap', () => {
    render(<AssigneeStack assignees={refs('Ada Lovelace', 'Grace Hopper')} />);
    expect(screen.getByLabelText('Ada Lovelace')).toHaveTextContent('AL');
    expect(screen.getByLabelText('Grace Hopper')).toHaveTextContent('GH');
    expect(screen.queryByLabelText(/more$/)).not.toBeInTheDocument();
  });

  it('caps at 3 tiles and shows a +N chip for the overflow', () => {
    render(
      <AssigneeStack
        assignees={refs('Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Katherine Johnson', 'Jean Bartik')}
      />,
    );

    // Exactly the first three render as tiles...
    expect(screen.getByLabelText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByLabelText('Grace Hopper')).toBeInTheDocument();
    expect(screen.getByLabelText('Alan Turing')).toBeInTheDocument();
    expect(screen.queryByLabelText('Katherine Johnson')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Jean Bartik')).not.toBeInTheDocument();

    // ...and the remaining two collapse into one chip.
    expect(screen.getByLabelText('2 more')).toHaveTextContent('+2');
  });

  it('names the FULL set in the hover title, not just the visible three', () => {
    render(
      <AssigneeStack
        assignees={refs('Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Katherine Johnson')}
      />,
    );
    // The whole point of hovering an overflowing stack is learning who "+1" is.
    expect(screen.getByTestId('assignee-stack')).toHaveAttribute(
      'title',
      'Ada Lovelace, Grace Hopper, Alan Turing, Katherine Johnson',
    );
  });

  it('shows exactly 3 tiles and no chip at the cap boundary', () => {
    render(<AssigneeStack assignees={refs('Ada Lovelace', 'Grace Hopper', 'Alan Turing')} />);
    expect(screen.getByLabelText('Alan Turing')).toBeInTheDocument();
    expect(screen.queryByLabelText(/more$/)).not.toBeInTheDocument();
  });

  it('renders an assignee whose name is null without crashing', () => {
    // The deactivated-user case: the id survives, the name does not.
    render(<AssigneeStack assignees={[{ id: 'ghost-uuid', name: null }]} showSoleName />);
    expect(screen.getByLabelText('Unknown user')).toHaveTextContent('?');
    // The "sole assignee" caption falls back too, rather than rendering blank.
    expect(screen.getByText('Unknown user')).toBeInTheDocument();
  });

  it('survives a mixed set where only some names resolve, and still counts overflow', () => {
    render(<AssigneeStack assignees={refs('Ada Lovelace', null, null, null)} />);
    expect(screen.getByLabelText('Ada Lovelace')).toBeInTheDocument();
    // Two unresolved tiles share a label but not a React key - they are keyed on
    // the stable id, which is why two "Unknown user" tiles can coexist.
    expect(screen.getAllByLabelText('Unknown user')).toHaveLength(2);
    expect(screen.getByLabelText('1 more')).toHaveTextContent('+1');
  });

  it('says "Unassigned" rather than rendering an empty stack', () => {
    render(<AssigneeStack assignees={[]} />);
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
  });
});

describe('taskAssignees', () => {
  const task = (over: Partial<Pick<Task, 'assignee_ids' | 'assignees'>>) => ({
    assignee_ids: [],
    assignees: [],
    ...over,
  });

  it('materialises a ref for an id the `assignees` array does not resolve', () => {
    // A payload can carry an id with no matching entry. Rendering nothing for
    // that person would silently shrink the crew.
    const result = taskAssignees(task({ assignee_ids: ['a', 'b'], assignees: [{ id: 'a', name: 'Ada' }] }));
    expect(result).toEqual([{ id: 'a', name: 'Ada' }, { id: 'b', name: null }]);
    expect(assigneeNames(task({ assignee_ids: ['a', 'b'], assignees: [{ id: 'a', name: 'Ada' }] })))
      .toEqual(['Ada', 'Unknown user']);
  });

  it('ignores a resolved entry whose id is no longer assigned', () => {
    // `assignee_ids` is the authority on WHO; a stale name lookup must not
    // resurrect somebody who was removed.
    expect(taskAssignees(task({
      assignee_ids: ['a'],
      assignees: [{ id: 'a', name: 'Ada' }, { id: 'gone', name: 'Removed Person' }],
    }))).toEqual([{ id: 'a', name: 'Ada' }]);
  });

  it('keeps wire order, so the stack matches the order the API promised', () => {
    expect(assigneeTooltip(task({
      assignee_ids: ['c', 'a', 'b'],
      assignees: [{ id: 'a', name: 'Ada' }, { id: 'b', name: 'Bea' }, { id: 'c', name: 'Cy' }],
    }))).toBe('Cy, Ada, Bea');
  });
});
