import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { format } from 'date-fns';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { ActivityPanel } from '@/components/crm/ActivityPanel';

const mockApi = vi.mocked(api);

const SCHEDULED_TO = '2026-05-10T14:00:00.000Z';
const RESCHED_1_FROM = '2026-05-10T14:00:00.000Z';
const RESCHED_1_TO = '2026-05-12T16:30:00.000Z';
const RESCHED_2_FROM = '2026-05-12T16:30:00.000Z';
const RESCHED_2_TO = '2026-05-15T13:00:00.000Z';

const fmt = (iso: string) => format(new Date(iso), 'MMM d, yyyy h:mm a');

const JOB_TIMELINE_EVENTS = [
  {
    id: 'ev-1',
    event_type: 'JOB_CREATED',
    description: 'Job created',
    created_at: '2026-05-01T10:00:00.000Z',
    creator: null,
    metadata: null,
  },
  {
    id: 'ev-2',
    event_type: 'SCHEDULED',
    description: 'Job scheduled',
    created_at: '2026-05-02T10:00:00.000Z',
    creator: null,
    metadata: { from: null, to: SCHEDULED_TO },
  },
  {
    id: 'ev-3',
    event_type: 'RESCHEDULED',
    description: 'Job rescheduled',
    created_at: '2026-05-03T10:00:00.000Z',
    creator: null,
    metadata: { from: RESCHED_1_FROM, to: RESCHED_1_TO },
  },
  {
    id: 'ev-4',
    event_type: 'RESCHEDULED',
    description: 'Job rescheduled',
    created_at: '2026-05-04T10:00:00.000Z',
    creator: null,
    metadata: { from: RESCHED_2_FROM, to: RESCHED_2_TO },
  },
];

function mockActivityEndpoints(events: unknown[]) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/timeline')) {
      return { data: { events } };
    }
    if (url.includes('/notes')) {
      return { data: { notes: [] } };
    }
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ActivityPanel — reschedule history (#246)', () => {
  it('shows the reschedule count summary when RESCHEDULED events exist', async () => {
    mockActivityEndpoints(JOB_TIMELINE_EVENTS);
    renderWithProviders(<ActivityPanel entityType="JOB" entityId="job-1" />);

    await waitFor(() => {
      expect(screen.getByText('Rescheduled 2 times')).toBeInTheDocument();
    });
  });

  it('renders a from → to line for each RESCHEDULED event', async () => {
    mockActivityEndpoints(JOB_TIMELINE_EVENTS);
    renderWithProviders(<ActivityPanel entityType="JOB" entityId="job-1" />);

    await waitFor(() => {
      expect(
        screen.getByText(`${fmt(RESCHED_1_FROM)} → ${fmt(RESCHED_1_TO)}`)
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(`${fmt(RESCHED_2_FROM)} → ${fmt(RESCHED_2_TO)}`)
    ).toBeInTheDocument();
  });

  it('renders "Scheduled for <to>" on the SCHEDULED event (from null)', async () => {
    mockActivityEndpoints(JOB_TIMELINE_EVENTS);
    renderWithProviders(<ActivityPanel entityType="JOB" entityId="job-1" />);

    await waitFor(() => {
      expect(
        screen.getByText(`Scheduled for ${fmt(SCHEDULED_TO)}`)
      ).toBeInTheDocument();
    });
  });

  it('renders events with null metadata (JOB_CREATED) without crashing', async () => {
    mockActivityEndpoints(JOB_TIMELINE_EVENTS);
    renderWithProviders(<ActivityPanel entityType="JOB" entityId="job-1" />);

    await waitFor(() => {
      expect(screen.getByText('Job created')).toBeInTheDocument();
    });
  });

  it('shows no count line on a LEAD timeline with no RESCHEDULED events', async () => {
    mockActivityEndpoints([
      {
        id: 'ev-e1',
        event_type: 'LEAD_CREATED',
        description: 'Lead created',
        created_at: '2026-05-01T10:00:00.000Z',
        creator: null,
        metadata: null,
      },
    ]);
    renderWithProviders(<ActivityPanel entityType="LEAD" entityId="lead-1" />);

    await waitFor(() => {
      expect(screen.getByText('Lead created')).toBeInTheDocument();
    });
    expect(screen.queryByText(/^Rescheduled \d/)).not.toBeInTheDocument();
  });
});
