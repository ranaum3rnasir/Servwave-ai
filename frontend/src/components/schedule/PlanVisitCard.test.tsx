// The sidebar rail's service-plan card, lifted out of SchedulePage so the schedule search
// highlight can reach it. Urgency (overdue / due soon / neither) drives border, chip and
// next-due line as one treatment.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { PlanVisitCard } from '@/components/schedule/PlanVisitCard';
import { PLAN_VISIT_PLAN_ID } from '@/components/schedule/dragChannels';
import type { SchedulerBucketPlan } from '@/lib/api/service-plans';

const PLAN: SchedulerBucketPlan = {
  id: 'plan-1',
  service_plan_number: 'SP00001',
  customer: 'John Doe',
  service_location: { address_line1: '100 Test Ave', city: 'Austin', state: 'TX' },
  recurrence: 'Every month',
  next_due: '2026-08-15T09:00:00.000Z',
  visits_remaining: 4,
  due_soon: false,
  overdue: false,
};

function renderCard(over: Partial<React.ComponentProps<typeof PlanVisitCard>> = {}) {
  const props = {
    plan: PLAN,
    dragging: false,
    dragDisabled: false,
    highlighted: false,
    onDragStart: vi.fn(),
    onDragEnd: vi.fn(),
    onClick: vi.fn(),
    ...over,
  };
  // Scoped to the render container, not `screen`: the drag test appends a drag-image
  // ghost carrying the same SP-number straight to document.body, and RTL's cleanup does
  // not own that node.
  const { container } = render(<PlanVisitCard {...props} />);
  const card = () => within(container).getByText('SP00001').closest('[draggable]')!;
  return { ...props, card };
}

beforeEach(() => {
  vi.clearAllMocks();
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn();
});

describe('PlanVisitCard', () => {
  it('renders the plan number, customer, location and remaining visits', () => {
    renderCard();
    expect(screen.getByText('SP00001')).toBeInTheDocument();
    expect(screen.getByText('John Doe')).toBeInTheDocument();
    expect(screen.getByText('Austin, TX')).toBeInTheDocument();
    expect(screen.getByText('4 left')).toBeInTheDocument();
  });

  it('labels an open-ended plan Ongoing rather than a visit count', () => {
    renderCard({ plan: { ...PLAN, visits_remaining: null } });
    expect(screen.getByText('Ongoing')).toBeInTheDocument();
  });

  it('marks and scrolls to the card the schedule search selected', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    const { card } = renderCard({ highlighted: true });

    expect(card()).toHaveAttribute('data-highlighted');
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it('is unmarked when it is not the search hit', () => {
    const { card } = renderCard();
    expect(card()).not.toHaveAttribute('data-highlighted');
  });

  it('carries the plan id on the plan-visit drag channel', () => {
    const { onDragStart, card } = renderCard();
    const setData = vi.fn();

    fireEvent.dragStart(card(), { dataTransfer: { setData, setDragImage: vi.fn(), effectAllowed: 'none' } });

    expect(setData).toHaveBeenCalledWith(PLAN_VISIT_PLAN_ID, 'plan-1');
    expect(onDragStart).toHaveBeenCalled();
  });

  it('is not a drag source for a read-only board', () => {
    const { card } = renderCard({ dragDisabled: true });
    expect(card()).toHaveAttribute('draggable', 'false');
  });
});
