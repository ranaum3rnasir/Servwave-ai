// Issue #447 — Today's Schedule shows walkthroughs alongside jobs: pending
// walkthroughs get the ocean 'Walkthrough' pill, completed ones the sage
// done-state pill; walkthrough rows navigate to /leads/:id, jobs to /jobs/:id.
import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import type { TechSchedule } from '@/lib/api/dashboard';
import TodaySchedule from './TodaySchedule';

const lane: TechSchedule = {
  user_id: 'u-ann',
  first_name: 'Ann',
  last_name: 'Ames',
  jobs: [
    {
      id: 'job-1', job_number: 'J00001', status: 'SCHEDULED', scope_notes: 'Fix door',
      scheduled_start: '2026-07-02T09:00:00.000Z', scheduled_end: '2026-07-02T11:00:00.000Z',
      customer_name: 'Acme Doors', address: null, entity: 'job',
    },
    {
      id: 'lead-1', job_number: 'L00001', status: 'WALKTHROUGH', scope_notes: 'New gate operator',
      scheduled_start: '2026-07-02T12:00:00.000Z', scheduled_end: '2026-07-02T13:00:00.000Z',
      customer_name: 'Eric Bizzak', address: null, entity: 'walkthrough',
    },
    {
      id: 'lead-2', job_number: 'L00002', status: 'WALKTHROUGH_COMPLETED', scope_notes: 'Turnstile survey',
      scheduled_start: '2026-07-02T14:00:00.000Z', scheduled_end: '2026-07-02T15:00:00.000Z',
      customer_name: 'Gregory Ave HOA', address: null, entity: 'walkthrough',
    },
  ],
};

function rowOf(text: string): HTMLElement {
  return screen.getByText(text).closest('button')!;
}

describe('TodaySchedule — walkthrough entries (#447)', () => {
  it('renders a Walkthrough pill for both walkthrough rows: ocean when pending, sage when completed', () => {
    renderWithProviders(<TodaySchedule data={[lane]} navigate={vi.fn()} />);
    expect(screen.getAllByText('Walkthrough')).toHaveLength(2);

    const pending = rowOf('Eric Bizzak');
    expect(pending.className).toContain('bg-primary-subtle');
    expect(pending.querySelector('.text-ocean-800')).not.toBeNull();

    const done = rowOf('Gregory Ave HOA');
    expect(done.className).toContain('bg-sage-50');
    expect(done.querySelector('.text-sage-700')).not.toBeNull();
  });

  it('navigates walkthrough rows to /leads/:id and job rows to /jobs/:id', () => {
    const navigate = vi.fn();
    renderWithProviders(<TodaySchedule data={[lane]} navigate={navigate} />);

    fireEvent.click(rowOf('Eric Bizzak'));
    expect(navigate).toHaveBeenLastCalledWith('/leads/lead-1');

    fireEvent.click(rowOf('Gregory Ave HOA'));
    expect(navigate).toHaveBeenLastCalledWith('/leads/lead-2');

    fireEvent.click(rowOf('Acme Doors'));
    expect(navigate).toHaveBeenLastCalledWith('/jobs/job-1');
  });

  it('renders the "Nothing scheduled" empty state when there are no lanes', () => {
    renderWithProviders(<TodaySchedule data={[]} navigate={vi.fn()} />);
    expect(screen.getByText('Nothing scheduled')).toBeInTheDocument();
  });
});
