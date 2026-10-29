/**
 * The v2 Unassigned bucket stack - the port of
 * `src/components/schedule/UnassignedBuckets.test.tsx` onto the rebuilt
 * component at `pages/v2/schedule/components/unassignedBuckets.tsx`.
 *
 * The rebuild is a PRESENTATION rebuild: the disclosure row became a kit
 * Button, the two pills became kit Badges and the empty body became the kit
 * EmptyState, but the drag/drop contract was meant to survive byte-for-byte.
 * This file is what proves it, and it matters most for the one behaviour the
 * kit could plausibly have eaten: the stack ROOT is the D6
 * drag-to-unschedule drop target, gated on `grid-event-id` being present in
 * `dataTransfer.types`, and `data-testid="unassigned-buckets"` is that drop
 * target's own selector.
 *
 * Drag payloads are plain objects mimicking dataTransfer (jsdom has no
 * DataTransfer); keys come from the dragChannels codec, which v2 imports
 * unchanged - same pattern as the legacy suite.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';
import { GRID_EVENT_ID, JOB_ID } from '@/components/schedule/dragChannels';
import type { SchedulableEvent } from '@/components/schedule/scheduleModel';
import type { AssignableUser } from '@/lib/api/users';

import { UnassignedBuckets } from '../components/unassignedBuckets';

const members: AssignableUser[] = [
  {
    id: 'm-alice',
    first_name: 'Alice',
    last_name: 'Ng',
    role: 'TECHNICIAN',
    department: null,
  },
];

const freshJob: SchedulableEvent = {
  boardId: 'job-1', parentId: 'job-1', type: 'job', number: 'J00041', title: 'Furnace tune-up', customer: 'Acme',
  crew: [], ownerId: null, start: null, end: null, raw: {},
};
const secondJob: SchedulableEvent = {
  boardId: 'job-2', parentId: 'job-2', type: 'job', number: 'J00042', title: 'Duct repair', customer: 'Globex',
  crew: [], ownerId: null, start: null, end: null, raw: {},
};
// State 3 - crewed but unscheduled (crew kept, no time).
const crewedJob: SchedulableEvent = {
  boardId: 'job-3', parentId: 'job-3', type: 'job', number: 'J00043', title: 'Rooftop swap', customer: 'Initech',
  crew: ['m-alice'], ownerId: null, start: null, end: null, raw: {},
};
const walkthrough: SchedulableEvent = {
  boardId: 'wt-lead-1', parentId: 'lead-1', type: 'walkthrough', number: 'L00012', title: 'Walkthrough - Acme', customer: 'Acme',
  crew: [], ownerId: null, start: null, end: null, raw: { id: 'lead-1' },
};

function renderBuckets(
  events: SchedulableEvent[],
  overrides: Partial<React.ComponentProps<typeof UnassignedBuckets>> = {},
) {
  const props = {
    events,
    members,
    onDragStartCard: vi.fn(),
    onUnscheduleDrop: vi.fn(),
    onCardClick: vi.fn(),
    ...overrides,
  };
  renderWithProviders(<UnassignedBuckets {...props} />);
  return props;
}

describe('v2 UnassignedBuckets - the extensible bucket stack', () => {
  it('renders all three bucket headers, incl. the Service Plans "soon" stub pill', () => {
    renderBuckets([freshJob, walkthrough]);
    expect(screen.getByText('Jobs')).toBeInTheDocument();
    expect(screen.getByText('Walkthroughs')).toBeInTheDocument();
    expect(screen.getByText('Service Plans')).toBeInTheDocument();
    expect(screen.getByText(/soon/i)).toBeInTheDocument();
    expect(screen.getByText(/Recurring visits land here \(Step 9E\)/)).toBeInTheDocument();
  });

  it('renders bucket cards FIFO - array order, no resort', () => {
    renderBuckets([freshJob, secondJob]);
    const numbers = screen.getAllByText(/^J000\d+$/).map((el) => el.textContent);
    expect(numbers).toEqual(['J00041', 'J00042']);
  });

  it('a state-3 card shows the crew-kept badge + an initials avatar; a state-1 card does not', () => {
    renderBuckets([freshJob, crewedJob]);
    expect(screen.getAllByText('crew kept')).toHaveLength(1); // only the crewed card
    expect(screen.getByText('AN')).toBeInTheDocument(); // Alice Ng resolved from members
    expect(screen.getByText(/re-drop remembers the crew/)).toBeInTheDocument();
  });

  it('an unresolvable crew id still renders an avatar with "?" initials', () => {
    renderBuckets([{ ...crewedJob, crew: ['ghost-user'] }]);
    expect(screen.getByText('?')).toBeInTheDocument();
  });

  it('dropping a board card (grid-event-id) on the stack calls onUnscheduleDrop with the id', () => {
    const { onUnscheduleDrop } = renderBuckets([freshJob]);
    fireEvent.drop(screen.getByTestId('unassigned-buckets'), {
      dataTransfer: {
        getData: (k: string) => (k === GRID_EVENT_ID ? 'job-1' : ''),
        types: [GRID_EVENT_ID],
      },
    });
    expect(onUnscheduleDrop).toHaveBeenCalledTimes(1);
    expect(onUnscheduleDrop).toHaveBeenCalledWith('job-1');
  });

  it('a non-board payload (bucket job-id channel) does NOT trigger unschedule', () => {
    const { onUnscheduleDrop } = renderBuckets([freshJob]);
    fireEvent.drop(screen.getByTestId('unassigned-buckets'), {
      dataTransfer: {
        getData: (k: string) => (k === JOB_ID ? 'job-9' : ''),
        types: [JOB_ID],
      },
    });
    expect(onUnscheduleDrop).not.toHaveBeenCalled();
  });

  it('with unscheduleDropDisabled (plan mode) the board-card drop does not fire', () => {
    const { onUnscheduleDrop } = renderBuckets([freshJob], { unscheduleDropDisabled: true });
    fireEvent.drop(screen.getByTestId('unassigned-buckets'), {
      dataTransfer: {
        getData: (k: string) => (k === GRID_EVENT_ID ? 'job-1' : ''),
        types: [GRID_EVENT_ID],
      },
    });
    expect(onUnscheduleDrop).not.toHaveBeenCalled();
  });

  it('with unscheduleDropDisabled the drag-back hint hides too (the drop it describes is off)', () => {
    renderBuckets([freshJob], { unscheduleDropDisabled: true });
    expect(screen.queryByText(/Drag a board card back here/)).not.toBeInTheDocument();
  });

  it('dragging a bucket card calls onDragStartCard with the event', () => {
    const { onDragStartCard } = renderBuckets([freshJob]);
    const card = screen.getByText('J00041').closest('[draggable="true"]');
    expect(card).not.toBeNull();
    fireEvent.dragStart(card!, { dataTransfer: { setData: vi.fn(), effectAllowed: 'none' } });
    expect(onDragStartCard).toHaveBeenCalledTimes(1);
    expect((onDragStartCard as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ boardId: 'job-1' });
  });

  it('clicking a card calls onCardClick with the event', () => {
    const { onCardClick } = renderBuckets([freshJob]);
    fireEvent.click(screen.getByText('J00041'));
    expect(onCardClick).toHaveBeenCalledWith(expect.objectContaining({ boardId: 'job-1' }));
  });

  it('collapsing a bucket hides its cards (default expanded)', async () => {
    renderBuckets([freshJob]);
    expect(screen.getByText('J00041')).toBeInTheDocument();
    const header = screen.getByText('Jobs').closest('button');
    expect(header).not.toBeNull();
    expect(header!.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(screen.getByText('Jobs'));

    // The disclosure state flips on the same tick as the click...
    expect(header!.getAttribute('aria-expanded')).toBe('false');
    // ...but the section animates closed (framer-motion exit), so the card
    // leaves the DOM asynchronously. The generous timeout is for the animation
    // frame budget under parallel load, not a weaker assertion - the card must
    // still be gone.
    await waitFor(
      () => expect(screen.queryByText('J00041')).not.toBeInTheDocument(),
      { timeout: 4000 },
    );
  });

  it('an empty non-stub bucket explains itself', () => {
    renderBuckets([freshJob]); // no walkthroughs
    expect(screen.getByText('Nothing here - all Walkthroughs are scheduled.')).toBeInTheDocument();
  });

  it("hiddenTypes=['walkthrough'] removes the bucket and its false empty state, and leaves BOTH the stack's drop target and the drag-back hint working", () => {
    const { onUnscheduleDrop } = renderBuckets([freshJob, walkthrough], {
      hiddenTypes: ['walkthrough'],
    });
    expect(screen.queryByText('Walkthroughs')).not.toBeInTheDocument();
    expect(screen.queryByText(/all Walkthroughs are scheduled/)).not.toBeInTheDocument();
    // Everything the viewer CAN reach is untouched.
    expect(screen.getByText('Jobs')).toBeInTheDocument();
    expect(screen.getByText('J00041')).toBeInTheDocument();

    // The drop target is the stack ROOT, not a bucket, so filtering BUCKETS cannot disturb it.
    fireEvent.drop(screen.getByTestId('unassigned-buckets'), {
      dataTransfer: {
        getData: (k: string) => (k === GRID_EVENT_ID ? 'job-1' : ''),
        types: [GRID_EVENT_ID],
      },
    });
    expect(onUnscheduleDrop).toHaveBeenCalledTimes(1);
    expect(onUnscheduleDrop).toHaveBeenCalledWith('job-1');
    // Regex, not a full string: <strong> splits the <p>'s text nodes.
    expect(screen.getByText(/Drag a board card back here/)).toBeInTheDocument();
  });

  it("hiddenTypes=['service-plan'] removes the Service Plans section, its 'soon' pill and the Step 9E copy", () => {
    renderBuckets([freshJob, walkthrough], { hiddenTypes: ['service-plan'] });
    expect(screen.queryByText('Service Plans')).not.toBeInTheDocument();
    expect(screen.queryByText(/soon/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Recurring visits land here \(Step 9E\)/)).not.toBeInTheDocument();
    expect(screen.getByText('Jobs')).toBeInTheDocument();
    expect(screen.getByText('Walkthroughs')).toBeInTheDocument();
  });

  it('planSlot replaces the stub: live pv- content renders, the soon pill does not', () => {
    renderBuckets([], { planSlot: <div>SP0007 card</div>, planCount: 1 });
    expect(screen.getByText('SP0007 card')).toBeInTheDocument();
    expect(screen.queryByText(/soon/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Recurring visits land here/)).not.toBeInTheDocument();
  });

  it('jobsError renders the Jobs bucket failure body instead of an empty state', () => {
    renderBuckets([], { jobsError: true });
    expect(screen.getByText('Failed to load jobs')).toBeInTheDocument();
    expect(screen.queryByText('Nothing here - all Jobs are scheduled.')).not.toBeInTheDocument();
  });

  // Read-only roles - cards are not drag sources.
  describe('dragDisabled (read-only roles)', () => {
    it('cards render draggable=false and dragStart never reaches onDragStartCard', () => {
      const { onDragStartCard } = renderBuckets([freshJob], { dragDisabled: true });
      const card = screen.getByText('J00041').closest('[draggable]');
      expect(card).not.toBeNull();
      expect(card!.getAttribute('draggable')).toBe('false');
      fireEvent.dragStart(card!, { dataTransfer: { setData: vi.fn(), effectAllowed: 'none' } });
      expect(onDragStartCard).not.toHaveBeenCalled();
    });

    it('clicks still open the (view-only) editor; the board-drag unschedule hint hides', () => {
      const { onCardClick } = renderBuckets([freshJob], { dragDisabled: true });
      fireEvent.click(screen.getByText('J00041'));
      expect(onCardClick).toHaveBeenCalledWith(expect.objectContaining({ boardId: 'job-1' }));
      expect(screen.queryByText(/Drag a board card back here/)).not.toBeInTheDocument();
    });

    it('default (dragDisabled absent) keeps cards draggable', () => {
      renderBuckets([freshJob]);
      const card = screen.getByText('J00041').closest('[draggable]');
      expect(card!.getAttribute('draggable')).toBe('true');
    });
  });
});
