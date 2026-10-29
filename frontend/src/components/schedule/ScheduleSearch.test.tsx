// Schedule search offers all THREE board types. Jobs and Walkthroughs were always there;
// Service Plans is the third schedulable type (scheduleModel.ts EventType) that the
// dropdown never rendered, so a plan card sitting in the sidebar rail was unfindable.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import ScheduleSearch from '@/components/schedule/ScheduleSearch';
import type { SearchResult } from '@/components/layout/search-shared';
import { asWallClock } from '@/lib/schedule-tz';

vi.mock('@/lib/axios', () => ({ default: { get: vi.fn() } }));

import api from '@/lib/axios';
const mockGet = api.get as ReturnType<typeof vi.fn>;

const TZ = 'America/New_York';
const DATE_RANGE = { start: asWallClock(new Date('2026-08-01')), end: asWallClock(new Date('2026-08-31')) };

const PLAN: SearchResult = {
  id: 'plan-1',
  entity_type: 'service-plan',
  title: 'SP00001',
  subtitle: 'John Doe',
  date: '2026-08-15T09:00:00.000Z',
  address: '100 Test Ave, Austin, TX',
  status: 'ACTIVE',
};

function respondWith(over: Partial<Record<string, SearchResult[]>> = {}) {
  mockGet.mockResolvedValue({
    data: { results: { jobs: [], customers: [], leads: [], estimates: [], invoices: [], servicePlans: [], ...over } },
  });
}

async function typeQuery(onSelect = vi.fn()) {
  renderWithProviders(<ScheduleSearch onSelect={onSelect} dateRange={DATE_RANGE} tz={TZ} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'SP00001' } });
  return onSelect;
}

beforeEach(() => {
  vi.clearAllMocks();
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn();
});

describe('ScheduleSearch - service plans', () => {
  it('renders a Service Plans section for a plan hit', async () => {
    respondWith({ servicePlans: [PLAN] });
    await typeQuery();

    expect(await screen.findByText('Service Plans')).toBeInTheDocument();
    expect(screen.getByText('SP00001')).toBeInTheDocument();
  });

  it('hands the plan row back on select, so the page can highlight its rail card', async () => {
    respondWith({ servicePlans: [PLAN] });
    const onSelect = await typeQuery();

    fireEvent.click(await screen.findByText('SP00001'));
    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'plan-1', entity_type: 'service-plan' })),
    );
  });

  it('counts plans toward the result total, not just jobs and walkthroughs', async () => {
    respondWith({ servicePlans: [PLAN] });
    await typeQuery();

    expect(await screen.findByText('Showing 1 result')).toBeInTheDocument();
  });

  it('shows no Service Plans section when the org has none to offer', async () => {
    respondWith();
    await typeQuery();

    expect(await screen.findByText(/No results for/)).toBeInTheDocument();
    expect(screen.queryByText('Service Plans')).not.toBeInTheDocument();
  });
});
