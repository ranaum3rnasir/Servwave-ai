import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders, TAGS_FIXTURE } from './helpers';
import { TagInput } from '@/components/leads/TagInput';

const hoisted = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/components/ui/use-toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/use-toast')>();
  return { ...actual, toast: hoisted.toast };
});

const mockApi = vi.mocked(api);

/** An axios-shaped rejection carrying the API's structured error code. */
function apiError(status: number, body: { error: string; code?: string }) {
  return { response: { status, data: body } };
}

const existingTags = [
  { id: 'a0000000-0000-0000-0000-000000000001', name: 'Urgent', color: '#EF4444' },
];

// ─── Radix popover jsdom shims (scoped to this file) ──────────
// The shared setup mocks ResizeObserver with an arrow fn, which Radix's
// floating-ui calls with `new` — a constructable class is needed to open the
// Popover in jsdom. hasPointerCapture / scrollIntoView are likewise stubbed.
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
  mockApi.post.mockResolvedValue({ data: { tag: TAGS_FIXTURE[0] } });
  mockApi.delete.mockResolvedValue({ data: {} });
});

/** Open the popover via the dashed '+ Tag' trigger (Radix needs fireEvent in jsdom). */
function openPicker() {
  fireEvent.click(screen.getByText('Tag'));
}

/** The available-tag chips rendered inside the popover, in DOM order. */
function chipNames(): string[] {
  const fixtureNames = new Set(TAGS_FIXTURE.map((t) => t.name));
  return screen
    .getAllByRole('button')
    .map((b) => b.textContent ?? '')
    .filter((name) => fixtureNames.has(name));
}

describe('TagInput', () => {
  it('renders existing tags as pills', () => {
    renderWithProviders(
      <TagInput leadId="lead-1" tags={existingTags} />
    );

    expect(screen.getByText('Urgent')).toBeInTheDocument();
  });

  it('shows Tag button when popover is closed', () => {
    renderWithProviders(
      <TagInput leadId="lead-1" tags={[]} />
    );

    expect(screen.getByText('Tag')).toBeInTheDocument();
  });

  it('opens a popover with search input on Tag button click', async () => {
    renderWithProviders(
      <TagInput leadId="lead-1" tags={[]} />
    );

    openPicker();
    expect(screen.getByPlaceholderText('Search tags...')).toBeInTheDocument();
  });

  it('shows "Available tags (N)" header counting only unattached tags', async () => {
    renderWithProviders(
      <TagInput leadId="lead-1" tags={existingTags} />
    );

    openPicker();

    // 2 tags in fixture, 1 attached → 1 available
    await waitFor(() => {
      expect(screen.getByText('Available tags (1)')).toBeInTheDocument();
    });
  });

  it('shows available tags as chips (excluding attached)', async () => {
    renderWithProviders(
      <TagInput leadId="lead-1" tags={existingTags} />
    );

    openPicker();

    // VIP should show since it's not attached; Urgent should be excluded
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'VIP' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Urgent' })).not.toBeInTheDocument();
  });

  it('filters the chip list as the user types', async () => {
    renderWithProviders(
      <TagInput leadId="lead-1" tags={[]} />
    );

    openPicker();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Urgent' })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText('Search tags...'), {
      target: { value: 'VIP' },
    });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Urgent' })).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'VIP' })).toBeInTheDocument();
  });

  it('sort toggle reverses the chip order', async () => {
    renderWithProviders(
      <TagInput leadId="lead-1" tags={[]} />
    );

    openPicker();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'VIP' })).toBeInTheDocument();
    });

    // Default A→Z
    expect(chipNames()).toEqual(['Urgent', 'VIP']);

    fireEvent.click(screen.getByRole('button', { name: /sort/i }));

    await waitFor(() => {
      expect(chipNames()).toEqual(['VIP', 'Urgent']);
    });
  });

  it('shows Create option for non-matching text', async () => {
    renderWithProviders(
      <TagInput leadId="lead-1" tags={[]} />
    );

    openPicker();
    fireEvent.change(screen.getByPlaceholderText('Search tags...'), {
      target: { value: 'NewTag' },
    });

    await waitFor(() => {
      expect(screen.getByText(/Create new tag "NewTag"/)).toBeInTheDocument();
    });
  });

  it('posts name + color when the create row is clicked', async () => {
    renderWithProviders(
      <TagInput leadId="lead-1" tags={[]} />
    );

    openPicker();
    fireEvent.change(screen.getByPlaceholderText('Search tags...'), {
      target: { value: 'NewTag' },
    });

    await waitFor(() => {
      expect(screen.getByText(/Create new tag "NewTag"/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/Create new tag "NewTag"/));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        '/api/leads/lead-1/tags',
        expect.objectContaining({
          name: 'NewTag',
          color: expect.stringMatching(/^#/),
        })
      );
    });
  });

  it('posts the chosen swatch color, not the default', async () => {
    renderWithProviders(
      <TagInput leadId="lead-1" tags={[]} />
    );

    openPicker();
    fireEvent.change(screen.getByPlaceholderText('Search tags...'), {
      target: { value: 'NewTag' },
    });

    // Swatches render only once the create row is shown (non-matching text).
    const swatch = await screen.findByRole('button', { name: 'Use color #22C55E' });
    fireEvent.click(swatch);

    fireEvent.click(screen.getByText(/Create new tag "NewTag"/));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        '/api/leads/lead-1/tags',
        expect.objectContaining({ name: 'NewTag', color: '#22C55E' })
      );
    });
  });

  it('calls remove API when X is clicked on a tag', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <TagInput leadId="lead-1" tags={existingTags} />
    );

    // Click the X button on the Urgent tag
    const xButtons = screen.getAllByRole('button').filter(
      (btn) => btn.querySelector('svg')?.classList.contains('h-3')
    );
    // The first small button should be the X on the tag
    if (xButtons.length > 0) {
      await user.click(xButtons[0]!);
      await waitFor(() => {
        expect(mockApi.delete).toHaveBeenCalledWith(
          expect.stringContaining('/tags/')
        );
      });
    }
  });

  it('calls add API with tag_id when an available chip is clicked', async () => {
    renderWithProviders(
      <TagInput leadId="lead-1" tags={[]} />
    );

    openPicker();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Urgent' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Urgent' }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        '/api/leads/lead-1/tags',
        expect.objectContaining({ tag_id: TAGS_FIXTURE[0]!.id })
      );
    });
  });
});

// SRVW-103 - the EntityType union widened from 'LEAD' | 'JOB' to all five TagEntity
// values, and the two-way ternary became a Record lookup. These lock the route each
// value addresses, including the deprecated leadId path.
describe('TagInput entity routing', () => {
  async function addFirstChip() {
    openPicker();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Urgent' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Urgent' }));
  }

  it('posts to /api/customers/:id/tags when entityType is CUSTOMER', async () => {
    renderWithProviders(<TagInput entityType="CUSTOMER" entityId="c-1" tags={[]} />);

    await addFirstChip();

    await waitFor(() => {
      expect(mockApi.post.mock.calls[0]![0]).toBe('/api/customers/c-1/tags');
    });
  });

  it('posts to /api/estimates/:id/tags when entityType is ESTIMATE', async () => {
    renderWithProviders(<TagInput entityType="ESTIMATE" entityId="e-1" tags={[]} />);

    await addFirstChip();

    await waitFor(() => {
      expect(mockApi.post.mock.calls[0]![0]).toBe('/api/estimates/e-1/tags');
    });
  });

  it('posts to /api/invoices/:id/tags when entityType is INVOICE', async () => {
    renderWithProviders(<TagInput entityType="INVOICE" entityId="i-1" tags={[]} />);

    await addFirstChip();

    await waitFor(() => {
      expect(mockApi.post.mock.calls[0]![0]).toBe('/api/invoices/i-1/tags');
    });
  });

  it('still routes the deprecated leadId prop to /api/leads/:id/tags', async () => {
    renderWithProviders(<TagInput leadId="lead-1" tags={[]} />);

    await addFirstChip();

    await waitFor(() => {
      expect(mockApi.post.mock.calls[0]![0]).toBe('/api/leads/lead-1/tags');
    });
  });
});

// SRVW-103 - TagInput is where tags are actually attached and detached, and both
// of its writers under-invalidated: neither dropped the list caches or the
// schedule board (whose payloads carry tags), and the remove path never dropped
// ['tags'] at all - which the Settings card's ['tags','with-usage'] usage counts
// sit under, so a detach left its "removes the tag from N records" delete
// warning quoting a number that was too high.
//
// Written out by hand ON PURPOSE: TagInput derives its set from the shared
// TAG_ENTITY_ROUTES map, so a test importing that map would agree with any
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

/**
 * The keys one tag write has to drop: every key above, except the written
 * record's own bare detail key - that one is dropped record-scoped
 * (`['lead', 'lead-1']`) instead, since only THAT record's chip row changed and
 * dropping the prefix as well would cancel and restart the same in-flight
 * detail refetch (invalidateQueries defaults to cancelRefetch: true).
 */
function missingTagCacheKeys(invalidated: unknown[], detailKey: string, entityId: string): string[] {
  const expected = [
    ...TAG_CACHE_KEYS.filter((k) => k[0] !== detailKey),
    [detailKey, entityId],
  ];
  const seen = new Set(invalidated.map((k) => JSON.stringify(k)));
  return expected.filter((k) => !seen.has(JSON.stringify(k))).map((k) => k.join(':'));
}

/** The queryKey of every invalidateQueries call the spy recorded. */
function invalidatedKeys(spy: { mock: { calls: unknown[][] } }): unknown[] {
  return spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown } | undefined)?.queryKey);
}

describe('TagInput cache invalidation', () => {
  it('drops every tag-carrying cache when a tag is attached', async () => {
    const { queryClient } = renderWithProviders(<TagInput leadId="lead-1" tags={[]} />);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    openPicker();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Urgent' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Urgent' }));

    // The record-scoped drop is the one the writer has always made, so waiting
    // on it proves onSuccess ran - the assertions below are not merely early.
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['lead', 'lead-1'] })
    );

    expect(missingTagCacheKeys(invalidatedKeys(invalidate), 'lead', 'lead-1')).toEqual([]);
  });

  it('drops every tag-carrying cache when a tag is removed', async () => {
    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(
      <TagInput leadId="lead-1" tags={existingTags} />
    );
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    // The chip's close-X is the first icon-only button on the row.
    const xButton = screen
      .getAllByRole('button')
      .find((btn) => btn.querySelector('svg')?.classList.contains('h-3'))!;
    await user.click(xButton);

    await waitFor(() =>
      expect(mockApi.delete).toHaveBeenCalledWith(`/api/leads/lead-1/tags/${existingTags[0]!.id}`)
    );
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['lead', 'lead-1'] })
    );

    expect(missingTagCacheKeys(invalidatedKeys(invalidate), 'lead', 'lead-1')).toEqual([]);
  });

  it('scopes the record-level drop to the entity actually written', async () => {
    const { queryClient } = renderWithProviders(
      <TagInput entityType="JOB" entityId="j-1" tags={[]} />
    );
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    openPicker();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Urgent' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Urgent' }));

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['job', 'j-1'] }));

    expect(missingTagCacheKeys(invalidatedKeys(invalidate), 'job', 'j-1')).toEqual([]);
  });
});

describe('TagInput when the vocabulary changed underneath the page', () => {
  // The scenario: an admin deletes a tag in Settings; a colleague who has not
  // reloaded still has it in their cached picker and clicks it. The API answers
  // 404 TAG_NOT_FOUND. Before this, the mutation had no onError at all, so the
  // click did nothing visible and the dead entry stayed put to be clicked again.
  it('explains a deleted tag rather than failing silently, and refreshes the list', async () => {
    mockApi.post.mockRejectedValue(
      apiError(404, { error: 'Tag not found', code: 'TAG_NOT_FOUND' })
    );

    const { queryClient } = renderWithProviders(<TagInput leadId="lead-1" tags={[]} />);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    openPicker();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Urgent' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Urgent' }));

    await waitFor(() =>
      expect(hoisted.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'destructive',
          title: 'That tag is no longer available',
        })
      )
    );

    // Self-heal: the stale vocabulary is dropped on the very click that exposed
    // it, so the dead entry leaves the picker instead of failing identically.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tags'] });
  });

  it('says the same when detaching a chip whose tag was already deleted', async () => {
    const user = userEvent.setup();
    mockApi.delete.mockRejectedValue(
      apiError(404, { error: 'Tag not attached to this lead', code: 'TAG_NOT_ATTACHED' })
    );

    const { queryClient } = renderWithProviders(
      <TagInput leadId="lead-1" tags={existingTags} />
    );
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    const xButton = screen
      .getAllByRole('button')
      .find((btn) => btn.querySelector('svg')?.classList.contains('h-3'))!;
    await user.click(xButton);

    await waitFor(() =>
      expect(hoisted.toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'That tag is no longer available' })
      )
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tags'] });
  });

  it('does not blame a deleted tag for an unrelated failure', async () => {
    mockApi.post.mockRejectedValue(apiError(500, { error: 'Failed to add tag to lead' }));

    renderWithProviders(<TagInput leadId="lead-1" tags={[]} />);

    openPicker();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Urgent' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Urgent' }));

    await waitFor(() =>
      expect(hoisted.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Couldn't add tag",
          description: 'Failed to add tag to lead',
        })
      )
    );
  });

  it('refetches the vocabulary each time the picker opens', async () => {
    renderWithProviders(<TagInput leadId="lead-1" tags={[]} />);

    await waitFor(() => expect(mockApi.get).toHaveBeenCalledTimes(1));

    openPicker();
    // Reopening is the cheap freshness lever: the app's default staleTime is five
    // minutes, long enough for a tag deleted in Settings to still be listed here.
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledTimes(2));
  });
});
