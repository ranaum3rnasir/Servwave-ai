import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { ActivityPanel } from '@/components/crm/ActivityPanel';

const mockApi = vi.mocked(api);

// S06.7: a note added to a job writes a history entry for the office review to read. The Activity
// panel already lists the note itself, so the entry must not list it a second time.
const EVENTS = [
  {
    id: 'ev-1',
    event_type: 'JOB_NOTE_ADDED',
    description: 'Note added',
    created_at: '2026-10-08T12:00:00.000Z',
    creator: { id: 'u1', first_name: 'Test', last_name: 'Admin' },
    metadata: { note_id: 'n1' },
  },
  {
    id: 'ev-2',
    event_type: 'JOB_PAYMENT_RECORDED',
    description: 'Invoice I00001 payment recorded: $400.00 via Check',
    created_at: '2026-10-08T11:00:00.000Z',
    creator: { id: 'u1', first_name: 'Test', last_name: 'Admin' },
    metadata: { amount: 400, method: 'CHECK' },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/timeline')) return { data: { events: EVENTS } };
    if (url.includes('/notes')) {
      return {
        data: {
          notes: [{
            id: 'n1', content: 'Customer wants the unit by Friday', created_at: '2026-10-08T12:00:00.000Z',
            creator: { id: 'u1', first_name: 'Test', last_name: 'Admin' },
          }],
        },
      };
    }
    return { data: {} };
  });
});

describe('ActivityPanel - notes added', () => {
  it('lists the note once: its history entry is not shown beside it', async () => {
    renderWithProviders(<ActivityPanel entityType="JOB" entityId="job-1" />);

    await waitFor(() => {
      expect(screen.getByText('Customer wants the unit by Friday')).toBeInTheDocument();
    });
    expect(screen.queryByText('Note added')).not.toBeInTheDocument();
  });

  it('still lists the money entries', async () => {
    renderWithProviders(<ActivityPanel entityType="JOB" entityId="job-1" />);

    await waitFor(() => {
      expect(screen.getByText('Invoice I00001 payment recorded: $400.00 via Check')).toBeInTheDocument();
    });
  });
});
