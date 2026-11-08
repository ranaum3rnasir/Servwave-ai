import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders, TAGS_FIXTURE } from './helpers';
import { buildAbility } from '@/lib/ability';
import { BulkTagPopover } from '@/components/customers/BulkTagPopover';

const hoisted = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/components/ui/use-toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/use-toast')>();
  return { ...actual, toast: hoisted.toast };
});

const mockApi = vi.mocked(api);

// useTags() is gated on `ability.can('read', 'Tag')`, and renderWithProviders
// defaults to emptyAbility (deny everything). Without this grant the vocabulary
// query never fires and no tag chip ever renders — the picker would look empty
// for a reason that has nothing to do with what these tests assert.
const TAG_READER = buildAbility([{ action: 'read', subject: 'Tag' }]);

const CUSTOMER_IDS = [
  'c0000000-0000-0000-0000-000000000001',
  'c0000000-0000-0000-0000-000000000002',
  'c0000000-0000-0000-0000-000000000003',
];

// ─── Radix popover jsdom shims (scoped to this file) ──────────
// Same shims tag-input.test.tsx needs: the shared setup mocks ResizeObserver
// with an arrow fn, which Radix's floating-ui calls with `new`.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: { tags: TAGS_FIXTURE } });
  mockApi.post.mockResolvedValue({
    data: { tagged: CUSTOMER_IDS, failed: [] },
  });
});

function renderPopover(ids: string[] = CUSTOMER_IDS) {
  return renderWithProviders(
    <BulkTagPopover customerIds={ids} onDone={() => {}} />,
    { ability: TAG_READER }
  );
}

/** Open the popover via its "Tag" trigger (Radix needs fireEvent in jsdom). */
function openPicker() {
  fireEvent.click(screen.getByRole('button', { name: /^Tag$/ }));
}

// SRVW-103 — the third tag writer with the same under-invalidation defect fixed
// in the Settings card (#1753) and TagInput (#1760). Bulk-tag dropped only
// ['customers'] and ['tags'], so it never touched ['customer'] — a customer
// detail page cached in the background kept a stale chip row — nor the other
// four entity list keys, nor the schedule board's four keys, whose /api/jobs and
// /api/leads payloads carry tags too.
//
// Written out by hand ON PURPOSE: the component derives its set from the shared
// TAG_ENTITY_ROUTES map, so a test importing that same map would agree with any
// future drift instead of catching it.
const TAG_CACHE_KEYS: string[][] = [
  ['tags'],
  ['customer'], ['customers'],
  ['lead'], ['leads'],
  ['estimate'], ['estimates'],
  ['job'], ['jobs'],
  ['invoice'], ['invoices'],
  ['schedule-jobs'],
  ['schedule-walkthroughs'],
  ['schedule-unassigned'],
  ['schedule-unscheduled-walkthroughs'],
];

/** The queryKey of every invalidateQueries call the spy recorded. */
function invalidatedKeys(spy: { mock: { calls: unknown[][] } }): unknown[] {
  return spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown } | undefined)?.queryKey);
}

/** Which of TAG_CACHE_KEYS the writer failed to drop. */
function missingTagCacheKeys(invalidated: unknown[]): string[] {
  const seen = new Set(invalidated.map((k) => JSON.stringify(k)));
  return TAG_CACHE_KEYS.filter((k) => !seen.has(JSON.stringify(k))).map((k) => k.join(':'));
}

describe('BulkTagPopover cache invalidation', () => {
  it('drops every tag-carrying cache when an existing tag is applied', async () => {
    const { queryClient } = renderPopover();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    openPicker();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Urgent' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Urgent' }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        '/api/customers/bulk-tag',
        expect.objectContaining({ ids: CUSTOMER_IDS, tag_id: TAGS_FIXTURE[0]!.id })
      );
    });

    // ['customers'] is the drop this writer has always made, so waiting on it
    // proves onSuccess ran — the assertion below is not merely early.
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['customers'] })
    );

    expect(missingTagCacheKeys(invalidatedKeys(invalidate))).toEqual([]);
  });

  it('drops every tag-carrying cache when a new tag is created inline', async () => {
    const { queryClient } = renderPopover();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    openPicker();
    fireEvent.change(screen.getByPlaceholderText('Search or create tag...'), {
      target: { value: 'NewTag' },
    });

    await waitFor(() => {
      expect(screen.getByText(/Create new tag "NewTag"/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/Create new tag "NewTag"/));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        '/api/customers/bulk-tag',
        expect.objectContaining({ ids: CUSTOMER_IDS, name: 'NewTag' })
      );
    });
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['customers'] })
    );

    expect(missingTagCacheKeys(invalidatedKeys(invalidate))).toEqual([]);
  });

  // The bare ['customer'] key is the whole point of this fix — it is what a
  // background customer detail page reads, and it is prefix-matched, so one drop
  // reaches every ['customer', id] in the batch and no id needs enumerating.
  it('drops the bare customer detail key rather than one key per selected id', async () => {
    const { queryClient } = renderPopover();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    openPicker();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Urgent' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Urgent' }));

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['customer'] })
    );

    // No record-scoped drops: emitting ['customer', id] alongside the bare
    // ['customer'] would invalidate each written record twice in one handler,
    // and invalidateQueries defaults to cancelRefetch: true — the second drop
    // cancels and restarts the refetch the first one started.
    const perId = invalidatedKeys(invalidate).filter(
      (k) => Array.isArray(k) && k.length > 1 && k[0] === 'customer'
    );
    expect(perId).toEqual([]);
  });

  // Guard against the lazy fix: a bare invalidateQueries() with no argument
  // would satisfy every assertion above while refetching dashboards, reports and
  // settings that never render a tag.
  it('enumerates keys instead of blanket-invalidating the whole cache', async () => {
    const { queryClient } = renderPopover();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    openPicker();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Urgent' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Urgent' }));

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['customers'] })
    );

    for (const key of invalidatedKeys(invalidate)) {
      expect(key).toBeDefined();
      expect(Array.isArray(key)).toBe(true);
    }
  });
});
