// The bulk cancel dialog's list of refused jobs scales: with 100+ refused jobs the dialog body is the
// only scroller on a phone (a capped list there is a scroller inside a scroller), the list is bounded
// only as a desktop card, and the Close button stays in the pinned footer either way.
//
// jsdom applies no CSS, so presentation is read from `data-presentation`, the slots and the classes
// that carry the geometry (the same reading as remaining-dialogs-overlay.test.tsx).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { MEDIA } from '@/ui-kit/lib/breakpoints';
import { BulkCancelJobsDialog } from '@/components/jobs/BulkCancelJobsDialog';

function mockWidth(belowMd: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === MEDIA.belowMd && belowMd,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

afterEach(() => vi.restoreAllMocks());

const REFUSED = Array.from({ length: 120 }, (_, i) => ({ id: `job-${i}`, error: 'Reopen this job first' }));
const NUMBERS = Object.fromEntries(REFUSED.map((job, i) => [job.id, `J${String(i + 1).padStart(5, '0')}`]));

function renderRefused() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BulkCancelJobsDialog
        open
        onOpenChange={() => {}}
        count={120}
        jobIds={REFUSED.map((job) => job.id)}
        isPending={false}
        onConfirm={() => {}}
        result={{ cancelledCount: 3, refused: REFUSED }}
        jobNumbers={NUMBERS}
      />
    </QueryClientProvider>,
  );
}

const slot = (name: string) => document.querySelector(`[data-slot="${name}"]`)!;

describe('Bulk cancel - the refused jobs list with 120 refused jobs', () => {
  it('on a phone flows in the dialog body: no cap, no scroller of its own, Close stays in the footer', () => {
    mockWidth(true);
    renderRefused();
    const list = screen.getByRole('list', { name: 'Jobs that could not be cancelled' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(120);
    expect(list.className).not.toMatch(/max-h-|overflow-/);
    expect(slot('dialog-body').contains(list)).toBe(true);
    expect(slot('dialog-body').className).toContain('overflow-y-auto');
    expect(within(slot('dialog-footer') as HTMLElement).getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(within(slot('dialog-body') as HTMLElement).queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  });

  it('on a desktop card is bounded and scrolls inside the card, with Close in the footer', () => {
    mockWidth(false);
    renderRefused();
    const list = screen.getByRole('list', { name: 'Jobs that could not be cancelled' });
    expect(list.className).toContain('max-h-64');
    expect(list.className).toContain('overflow-y-auto');
    expect(within(slot('dialog-footer') as HTMLElement).getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });
});
