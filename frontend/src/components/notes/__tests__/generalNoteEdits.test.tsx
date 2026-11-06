/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * #3104 (B7 follow-up): an edited general note, wherever notes are listed. The Notes tab (the lead's, and the job's
 * "From Lead" notes, which share the component) and the Activity panel draw "Edited by <name> · <time>" under a note
 * that was edited, and nothing under one that was not; the Activity panel draws the lead's NOTE_EDITED history entry as
 * "<name> edited the note" with the text Before and After (Edit-After board, mockup row 5).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { RecordNotesTab, type RecordNoteItem } from '@/components/notes/RecordNotesTab';
import { ActivityPanel } from '@/components/crm/ActivityPanel';
import { JobNotesPreview } from '@/components/jobs/overview/JobNotesPreview';

const mockApi = vi.mocked(api);
const LEAD_ID = 'e0000000-0000-0000-0000-000000000001';
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const dana = { id: 'u0000000-0000-0000-0000-000000000001', first_name: 'Dana', last_name: 'Ruiz' };
const morgan = { id: 'u0000000-0000-0000-0000-000000000002', first_name: 'Morgan', last_name: 'Diaz' };
const edited: RecordNoteItem = {
  id: 'n0000000-0000-0000-0000-000000000001', content: 'Customer prefers afternoons.', created_at: minutesAgo(3 * 24 * 60),
  creator: dana, edited_at: minutesAgo(5), editor: morgan, can_delete: false, locked_actions: [],
};
const plain: RecordNoteItem = {
  id: 'n0000000-0000-0000-0000-000000000002', content: 'Dog in the yard', created_at: minutesAgo(60),
  creator: dana, edited_at: null, editor: null, can_delete: false, locked_actions: [],
};

beforeEach(() => vi.clearAllMocks());

describe('the Notes tab', () => {
  it('marks the edited note "Edited by <name> · <time>" and leaves the other note unmarked', () => {
    renderWithProviders(<RecordNotesTab recordType="LEAD" recordId={LEAD_ID} notes={[edited, plain]} canAddNotes={false} />);
    const editedRow = screen.getByText('Customer prefers afternoons.').closest('div')!;
    expect(within(editedRow).getByText('Edited by Morgan Diaz · 5 minutes ago')).toBeInTheDocument();
    // The author stays the person who wrote it.
    expect(within(editedRow.parentElement!).getByText(/Dana\s+Ruiz/)).toBeInTheDocument();
    const plainRow = screen.getByText('Dog in the yard').closest('div')!;
    expect(within(plainRow).queryByText(/Edited by/)).toBeNull();
    expect(screen.getAllByText(/Edited by/)).toHaveLength(1);
  });

  it('marks a lead\'s edited note on the job\'s list too (From Lead)', () => {
    renderWithProviders(<RecordNotesTab recordType="JOB" recordId={LEAD_ID} notes={[{ ...edited, source: 'LEAD' }]} canAddNotes={false} />);
    expect(screen.getByText('From Lead')).toBeInTheDocument();
    expect(screen.getByText('Edited by Morgan Diaz · 5 minutes ago')).toBeInTheDocument();
  });
});

describe('the job Overview\'s notes card', () => {
  it('marks the lead\'s edited general note, and not the others', () => {
    renderWithProviders(<JobNotesPreview jobId="job-1" notes={[{ ...edited, source: 'LEAD' }, plain]} />);
    expect(screen.getByText('Edited by Morgan Diaz · 5 minutes ago')).toBeInTheDocument();
    expect(screen.getAllByText(/Edited by/)).toHaveLength(1);
  });
});

describe('the Activity panel', () => {
  beforeEach(() => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/notes')) return { data: { notes: [edited] } };
      if (url.endsWith('/timeline')) {
        return {
          data: {
            events: [{
              id: 't1', event_type: 'NOTE_EDITED', description: 'Note edited', created_at: minutesAgo(5), creator: morgan,
              metadata: { note_id: edited.id, from: 'Customer prefers mornings.', to: 'Customer prefers afternoons.' },
            }],
          },
        };
      }
      return { data: {} };
    });
  });

  it('draws the edit as "<name> edited the note" with the text before and after', async () => {
    renderWithProviders(<ActivityPanel entityType="LEAD" entityId={LEAD_ID} />);
    const heading = await screen.findByText('edited the note');
    expect(heading.parentElement).toHaveTextContent('Morgan Diaz edited the note');
    const entry = heading.closest('.rounded-lg') as HTMLElement;
    expect(within(entry).getByText('Before').nextElementSibling).toHaveTextContent('Customer prefers mornings.');
    expect(within(entry).getByText('After').nextElementSibling).toHaveTextContent('Customer prefers afternoons.');
    expect(within(entry).queryByText('Note edited')).toBeNull();
  });

  it('marks the edited note itself in the feed', async () => {
    renderWithProviders(<ActivityPanel entityType="LEAD" entityId={LEAD_ID} />);
    expect(await screen.findByText('Edited by Morgan Diaz · 5 minutes ago')).toBeInTheDocument();
  });
});
