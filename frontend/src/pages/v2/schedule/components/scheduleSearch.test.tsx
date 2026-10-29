// Slice 09 — Events (CalendarEntry) are the scheduler's fourth schedulable type, matched on
// TITLE (spec §3: an entry carries no record number, so title is its only search handle) and
// rendered here in their own "Events" section alongside Jobs and Walkthroughs.
//
// This is the LIVE search component (imported by SchedulePage.tsx). Its dead v1 twin,
// components/schedule/ScheduleSearch.tsx, has a same-named test file with no importer outside
// itself — do not confuse the two; this file exercises the lowercase one under pages/v2.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import ScheduleSearch from './scheduleSearch';
import type { SearchResult } from '@/components/layout/search-shared';

vi.mock('@/lib/axios', () => ({ default: { get: vi.fn() } }));

// useScheduleTimezone() reads the org timezone through this hook. Pinned to a zone that
// differs from every plausible CI runner zone (UTC, America/New_York), mirroring
// job-detail-schedule-timezone.test.tsx, so the date assertion below fails on browser-local
// rendering rather than passing by coincidence.
vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return {
    ...actual,
    useOrganization: () => ({ data: { id: 'org-1', timezone: 'Asia/Manila' }, isLoading: false, isError: false }),
  };
});

import api from '@/lib/axios';
const mockGet = api.get as ReturnType<typeof vi.fn>;

const DATE_RANGE = { start: new Date('2026-09-01T00:00:00.000Z'), end: new Date('2026-09-30T00:00:00.000Z') };

const JOB: SearchResult = {
  id: 'job-1',
  entity_type: 'job',
  title: 'J00099',
  subtitle: 'Jane Roe',
  date: '2026-09-05T14:00:00.000Z',
  status: 'SCHEDULED',
};

const LEAD: SearchResult = {
  id: 'lead-1',
  entity_type: 'lead',
  title: 'L00050',
  subtitle: 'John Doe',
  date: '2026-09-06T14:00:00.000Z',
  status: 'SCHEDULED',
};

// 23:00 UTC on 2026-09-10 is 07:00 the NEXT day (2026-09-11) in Asia/Manila (UTC+8) — a day
// a browser-local render (UTC or America/New_York, both still on the 10th) cannot produce.
const EVENT: SearchResult = {
  id: 'ce-1',
  entity_type: 'calendar-entry',
  title: 'Dave PTO',
  date: '2026-09-10T23:00:00.000Z',
};

function respondWith(over: Partial<Record<string, SearchResult[]>> = {}) {
  mockGet.mockResolvedValue({
    data: {
      results: {
        jobs: [], customers: [], leads: [], estimates: [], invoices: [], servicePlans: [], calendarEntries: [],
        ...over,
      },
    },
  });
}

async function typeQuery(query = 'query text here', onSelect = vi.fn()) {
  renderWithProviders(<ScheduleSearch onSelect={onSelect} dateRange={DATE_RANGE} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: query } });
  return onSelect;
}

beforeEach(() => {
  vi.clearAllMocks();
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn();
});

describe('ScheduleSearch (live, pages/v2) — Events section', () => {
  it('renders an Events section, titled and dated in the ORG timezone', async () => {
    respondWith({ calendarEntries: [EVENT] });
    await typeQuery();

    expect(await screen.findByText('Events')).toBeInTheDocument();
    expect(screen.getByText('Dave PTO')).toBeInTheDocument();
    // 9/11/2026 in Manila, not 9/10/2026 — proves the row reads the ORG zone, not the
    // viewer's (a bare toLocaleDateString on the runner's zone would print 9/10/2026).
    expect(screen.getByText('9/11/2026')).toBeInTheDocument();
  });

  it('hands the Event row back on select, unchanged from what the server sent', async () => {
    respondWith({ calendarEntries: [EVENT] });
    const onSelect = await typeQuery();

    fireEvent.click(await screen.findByText('Dave PTO'));
    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'ce-1', entity_type: 'calendar-entry' })),
    );
  });

  it('arrow-key navigation traverses Job -> Walkthrough -> Event in section order, and Enter selects the active row', async () => {
    respondWith({ jobs: [JOB], leads: [LEAD], calendarEntries: [EVENT] });
    const onSelect = await typeQuery();
    const input = screen.getByRole('combobox');

    // Wait for all three sections to have rendered before driving the keyboard.
    await screen.findByText('J00099');
    await screen.findByText('L00050');
    await screen.findByText('Dave PTO');

    fireEvent.keyDown(input, { key: 'ArrowDown' }); // -> Job
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // -> Walkthrough
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // -> Event
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'ce-1', entity_type: 'calendar-entry' })),
    );
  });

  it('counts Events toward the result total', async () => {
    respondWith({ calendarEntries: [EVENT] });
    await typeQuery();

    expect(await screen.findByText('Showing 1 result')).toBeInTheDocument();
  });

  it('shows no Events section when the search returns none', async () => {
    respondWith({ jobs: [JOB] });
    await typeQuery();

    expect(await screen.findByText('J00099')).toBeInTheDocument();
    expect(screen.queryByText('Events')).not.toBeInTheDocument();
  });

  it('still renders Jobs and Walkthroughs sections unchanged alongside Events', async () => {
    respondWith({ jobs: [JOB], leads: [LEAD], calendarEntries: [EVENT] });
    await typeQuery();

    expect(await screen.findByText('Jobs')).toBeInTheDocument();
    expect(screen.getByText('Walkthroughs')).toBeInTheDocument();
    expect(screen.getByText('Events')).toBeInTheDocument();
    expect(screen.getByText('J00099')).toBeInTheDocument();
    expect(screen.getByText('L00050')).toBeInTheDocument();
    expect(screen.getByText('Dave PTO')).toBeInTheDocument();
  });
});
