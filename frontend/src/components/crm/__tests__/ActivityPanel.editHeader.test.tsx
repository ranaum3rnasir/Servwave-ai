/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * #3104 follow-up: the header of a "note edited" entry in the narrow Activity panel. Only the author's name may
 * truncate; "edited the note" must stay whole. It used to sit inside the name's `truncate` span, so the panel cut it
 * to "System Admin edited the …", and scrolling the hidden words into view slid that span sideways and cut the name's
 * first letters off as well ("stem Admin edited …").
 *
 * jsdom does no layout, so the check is structural: the name and the words are separate elements, and the words are
 * neither a truncating element nor inside one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { ActivityPanel } from '@/components/crm/ActivityPanel';

const mockApi = vi.mocked(api);
const LEAD_ID = 'e0000000-0000-0000-0000-000000000001';
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const admin = { id: 'u0000000-0000-0000-0000-000000000009', first_name: 'System', last_name: 'Admin' };

/** True when `el` or one of its ancestors clips its text with an ellipsis (Tailwind's `truncate`). */
function insideTruncation(el: HTMLElement): boolean {
  return el.closest('.truncate, .text-ellipsis, .line-clamp-1') !== null;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/notes')) return { data: { notes: [] } };
    if (url.endsWith('/timeline')) {
      return {
        data: {
          events: [
            {
              id: 't1', event_type: 'NOTE_EDITED', description: 'Note edited', created_at: minutesAgo(120), creator: admin,
              metadata: { note_id: 'n1', from: 'Customer prefers mornings.', to: 'Customer prefers afternoons.' },
            },
            { id: 't2', event_type: 'STATUS_CHANGED', description: 'Status changed', created_at: minutesAgo(300), creator: admin },
          ],
        },
      };
    }
    return { data: {} };
  });
});

describe('the Activity panel\'s "note edited" header', () => {
  it('draws the full name and "edited the note" as separate elements, and only the name truncates', async () => {
    renderWithProviders(<ActivityPanel entityType="LEAD" entityId={LEAD_ID} />);
    const words = await screen.findByText('edited the note');
    const header = words.parentElement!;
    expect(header).toHaveTextContent('System Admin edited the note');

    const nameEl = Array.from(header.children).find((c) => c.textContent?.trim() === 'System Admin') as HTMLElement;
    expect(nameEl).toBeTruthy();
    expect(nameEl).not.toContainElement(words);
    expect(insideTruncation(words)).toBe(false);
  });

  it('leaves the other entries\' header as it was: the name alone in one truncating span', async () => {
    renderWithProviders(<ActivityPanel entityType="LEAD" entityId={LEAD_ID} />);
    const status = await screen.findByText('Status changed');
    const entry = status.closest('.rounded-lg') as HTMLElement;
    const nameEl = entry.querySelector('span.truncate') as HTMLElement;
    expect(nameEl).toHaveTextContent(/^System Admin$/);
    expect(nameEl.className).toBe('text-xs font-medium text-text-primary truncate');
  });
});
