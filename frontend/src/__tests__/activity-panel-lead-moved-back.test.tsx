/**
 * SPEC-4 D7 (§7.5): a Contacted lead whose last outbound contact is taken away goes back to New,
 * and its Activity panel (the History list, not the Communication tab) shows one line for it,
 * credited to the person who made the change. The panel prints a status move's description as
 * written, so the line reads exactly as Ran worded it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { ActivityPanel } from '@/components/crm/ActivityPanel';

const mockApi = vi.mocked(api);

const LEAD_EVENTS = [
  {
    id: 'ev-1',
    event_type: 'STATUS_CHANGE',
    description: 'Lead moved to Contacted: first outbound text',
    created_at: '2026-10-24T13:45:00.000Z',
    creator: { id: 'u-1', first_name: 'Sam', last_name: 'Sender' },
    metadata: { from: 'NEW', to: 'CONTACTED', via: 'first_outbound_text' },
  },
  {
    id: 'ev-2',
    event_type: 'STATUS_CHANGE',
    description: 'Lead moved back to New: no outbound contact left',
    created_at: '2026-10-24T15:10:00.000Z',
    creator: { id: 'u-2', first_name: 'Dana', last_name: 'Dispatcher' },
    metadata: { from: 'CONTACTED', to: 'NEW', via: 'no_outbound_contact_left', entry_source: 'text', entry_id: 'm-1' },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/timeline')) return { data: { events: LEAD_EVENTS } };
    if (url.includes('/notes')) return { data: { notes: [] } };
    return { data: {} };
  });
});

describe('the lead Activity panel after a move back to New', () => {
  it('shows "Lead moved back to New: no outbound contact left" verbatim, credited to the person who made the change', async () => {
    renderWithProviders(<ActivityPanel entityType="LEAD" entityId="lead-1" />);

    const line = await screen.findByText('Lead moved back to New: no outbound contact left');
    expect(line).toBeInTheDocument();
    // The first move into Contacted stays in the record above it.
    expect(screen.getByText('Lead moved to Contacted: first outbound text')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Dana Dispatcher')).toBeInTheDocument());
    // Ids kept on the row's metadata are never rendered.
    expect(screen.queryByText(/no_outbound_contact_left|m-1/)).not.toBeInTheDocument();
  });
});
