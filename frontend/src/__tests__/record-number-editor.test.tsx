import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { RecordNumberEditor } from '@/components/crm/RecordNumberEditor';
import type { RenumberComputation } from '@/lib/api/record-numbering';

const mockApi = vi.mocked(api);

const CLEAN_COMPUTATION: RenumberComputation = {
  entity: 'customer',
  parentId: 'c1',
  oldNumber: 'C00001',
  newNumber: 'C00099',
  parentConflict: false,
  derived: [
    { table: 'estimates', id: 'e1', column: 'estimate_number', oldValue: 'C00001-1', newValue: 'C00099-1', conflict: false },
  ],
  labelRefreshes: [
    { table: 'job_stages', id: 'js1', column: 'job_number', oldValue: 'C00001', newValue: 'C00099', conflict: false },
  ],
  hasConflicts: false,
};

const CONFLICT_COMPUTATION: RenumberComputation = {
  entity: 'customer',
  parentId: 'c1',
  oldNumber: 'C00001',
  newNumber: 'C00050',
  parentConflict: true,
  parentConflictWithId: 'c9',
  derived: [
    { table: 'estimates', id: 'e1', column: 'estimate_number', oldValue: 'C00001-1', newValue: 'C00050-1', conflict: true, conflictWithId: 'e9' },
  ],
  labelRefreshes: [],
  hasConflicts: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RecordNumberEditor — canEdit gating', () => {
  it('renders the plain number with no edit affordance when canEdit is false', () => {
    renderWithProviders(
      <RecordNumberEditor entity="customer" id="c1" number="C00001" canEdit={false} />,
    );
    expect(screen.getByText('C00001')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders an edit affordance when canEdit is true, and clicking it opens the editor', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RecordNumberEditor entity="customer" id="c1" number="C00001" canEdit={true} />,
    );
    const editButton = screen.getByRole('button', { name: /edit id/i });
    expect(editButton).toBeInTheDocument();

    await user.click(editButton);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByDisplayValue('C00001')).toBeInTheDocument();
  });
});

// A derived estimate number is still edited through the same pencil every other entity
// uses - the header must not special-case one record type. The extra step that protects
// the parent link moved INSIDE the dialog, where it reads as a warning to accept rather
// than a control that has to be discovered and pressed first.
describe('RecordNumberEditor — derived estimate: same affordance, warning inside', () => {
  it('offers the ordinary pencil, not an unlock control', () => {
    renderWithProviders(
      <RecordNumberEditor
        entity="estimate"
        id="e1"
        number="C00001-1"
        canEdit={true}
        isDerivedAndLocked={true}
      />,
    );

    expect(screen.getByText('C00001-1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit id/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /use a custom number/i })).toBeNull();
  });

  it('warns that editing detaches the number, and withholds the input until that is accepted', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RecordNumberEditor
        entity="estimate"
        id="e1"
        number="C00001-1"
        canEdit={true}
        isDerivedAndLocked={true}
      />,
    );

    await user.click(screen.getByRole('button', { name: /edit id/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    // Asserted on the dialog description, which is the one place the phrase appears. The
    // warning is worded the same way whether the number came from a customer, a lead or a
    // job, so the three container kinds cannot drift into three separately-worded warnings.
    expect(screen.getByText(/this id follows the id it came from/i)).toBeInTheDocument();
    expect(screen.queryByDisplayValue('C00001-1')).toBeNull();

    await user.click(screen.getByRole('button', { name: /use my own id/i }));

    expect(screen.getByDisplayValue('C00001-1')).toBeInTheDocument();
    expect(screen.queryByText(/this id follows the id it came from/i)).toBeNull();
  });

  it('states the consequence in one short sentence, not a paragraph', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RecordNumberEditor
        entity="estimate"
        id="e1"
        number="C00001-1"
        canEdit={true}
        isDerivedAndLocked={true}
      />,
    );

    await user.click(screen.getByRole('button', { name: /edit id/i }));
    await screen.findByRole('dialog');

    // Exact text, not a substring: a warning nobody reads protects nobody, and the failure
    // mode here is re-expansion - each clarifying clause someone adds later reads reasonable
    // on its own and the paragraph grows back. One sentence, and the assertion says so.
    expect(screen.getByRole('alert').textContent?.trim()).toBe(
      'Set your own ID and it stops following.',
    );
  });

  it('re-arms the warning for the next edit rather than staying unlocked', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RecordNumberEditor
        entity="estimate"
        id="e1"
        number="C00001-1"
        canEdit={true}
        isDerivedAndLocked={true}
      />,
    );

    await user.click(screen.getByRole('button', { name: /edit id/i }));
    await user.click(await screen.findByRole('button', { name: /use my own id/i }));
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: /edit id/i }));
    expect(await screen.findByText(/this id follows the id it came from/i)).toBeInTheDocument();
  });

  it('goes straight to the input for a record that is not derived', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RecordNumberEditor entity="estimate" id="e2" number="E00005" canEdit={true} />,
    );

    await user.click(screen.getByRole('button', { name: /edit id/i }));
    expect(await screen.findByDisplayValue('E00005')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /use my own id/i })).toBeNull();
  });
});

describe('RecordNumberEditor — preview + confirm (clean)', () => {
  it('previews, renders the derived-change summary, and confirms the rename', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValueOnce({ data: CLEAN_COMPUTATION });
    mockApi.patch.mockResolvedValueOnce({
      data: {
        customer: { id: 'c1', customer_number: 'C00099' },
        old_number: 'C00001',
        new_number: 'C00099',
        derived: CLEAN_COMPUTATION.derived,
        label_refreshes: CLEAN_COMPUTATION.labelRefreshes,
      },
    });
    const onRenamed = vi.fn();

    renderWithProviders(
      <RecordNumberEditor entity="customer" id="c1" number="C00001" canEdit={true} onRenamed={onRenamed} />,
    );

    await user.click(screen.getByRole('button', { name: /edit id/i }));
    const input = await screen.findByDisplayValue('C00001');
    await user.clear(input);
    await user.type(input, 'C00099');

    await user.click(screen.getByRole('button', { name: /continue/i }));

    expect(mockApi.post).toHaveBeenCalledWith('/api/customers/c1/number/preview', { number: 'C00099' });
    expect(await screen.findByText(/1 estimate/i)).toBeInTheDocument();
    expect(screen.getByText(/1 record refreshed/i)).toBeInTheDocument();

    const confirmButton = screen.getByRole('button', { name: /confirm rename/i });
    expect(confirmButton).not.toBeDisabled();
    await user.click(confirmButton);

    expect(mockApi.patch).toHaveBeenCalledWith('/api/customers/c1/number', { number: 'C00099' });
    expect(onRenamed).toHaveBeenCalledWith('C00099');
  });
});

// A job rename rewrites its logistic orders, its job_stages, its call/message labels - rows
// spread across a dozen cached queries that no single detail page knows about. The client's
// default staleTime is five minutes, so without an explicit invalidation the user walks to the
// logistics list and reads the OLD numbers until it expires, which is exactly what staging QA hit.
describe('RecordNumberEditor — cache after a confirmed rename', () => {
  /** Stands in for any list the user already has open elsewhere in the app. An OBSERVED query,
   *  not a bare setQueryData entry: only an observed one refetches on invalidation, which is the
   *  behaviour being asserted. */
  function LogisticOrdersProbe({ queryFn }: { queryFn: () => Promise<unknown> }) {
    useQuery({ queryKey: ['logistic-orders', { jobId: 'j1' }], queryFn });
    return null;
  }

  it('refetches the queries a rename cascaded into, not just the record itself', async () => {
    const user = userEvent.setup();
    const listQueryFn = vi.fn().mockResolvedValue({ data: [] });
    mockApi.post.mockResolvedValueOnce({ data: { ...CLEAN_COMPUTATION, entity: 'job' } });
    mockApi.patch.mockResolvedValueOnce({
      data: {
        job: { id: 'j1', job_number: 'WZ-4471' },
        old_number: 'J00224',
        new_number: 'WZ-4471',
        derived: CLEAN_COMPUTATION.derived,
        label_refreshes: CLEAN_COMPUTATION.labelRefreshes,
      },
    });

    renderWithProviders(
      <>
        <LogisticOrdersProbe queryFn={listQueryFn} />
        <RecordNumberEditor entity="job" id="j1" number="J00224" canEdit={true} />
      </>,
    );
    await waitFor(() => expect(listQueryFn).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: /edit id/i }));
    const input = await screen.findByDisplayValue('J00224');
    await user.clear(input);
    await user.type(input, 'WZ-4471');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(await screen.findByRole('button', { name: /confirm rename/i }));

    await waitFor(() => expect(listQueryFn).toHaveBeenCalledTimes(2));
  });
});

describe('RecordNumberEditor — preview conflicts', () => {
  it('renders every conflict and disables the confirm action', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValueOnce({ data: CONFLICT_COMPUTATION });

    renderWithProviders(
      <RecordNumberEditor entity="customer" id="c1" number="C00001" canEdit={true} />,
    );

    await user.click(screen.getByRole('button', { name: /edit id/i }));
    const input = await screen.findByDisplayValue('C00001');
    await user.clear(input);
    await user.type(input, 'C00050');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // Parent conflict + the one derived conflict are both surfaced.
    const conflictItems = await screen.findAllByRole('listitem');
    expect(conflictItems).toHaveLength(2);
    expect(conflictItems[0]).toHaveTextContent('C00050 is already used by another customer');
    expect(conflictItems[1]).toHaveTextContent('C00050-1 is already used in estimates');

    const confirmButton = screen.getByRole('button', { name: /confirm/i });
    expect(confirmButton).toBeDisabled();
    expect(mockApi.patch).not.toHaveBeenCalled();
  });
});

describe('RecordNumberEditor — invalid format', () => {
  it('renders the inline error from a 400 preview response', async () => {
    const user = userEvent.setup();
    mockApi.post.mockRejectedValueOnce({
      response: { status: 400, data: { error: 'Number may only contain letters, digits, periods, underscores, and hyphens' } },
    });

    renderWithProviders(
      <RecordNumberEditor entity="customer" id="c1" number="C00001" canEdit={true} />,
    );

    await user.click(screen.getByRole('button', { name: /edit id/i }));
    const input = await screen.findByDisplayValue('C00001');
    await user.clear(input);
    await user.type(input, 'bad/number');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    expect(await screen.findByText(/may only contain letters, digits, periods, underscores, and hyphens/i)).toBeInTheDocument();
    expect(mockApi.patch).not.toHaveBeenCalled();
  });
});
