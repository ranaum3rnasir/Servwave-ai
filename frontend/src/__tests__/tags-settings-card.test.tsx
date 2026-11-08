/**
 * TagsSettingsCard — the admin surface for renaming, recolouring and deleting
 * org tags. Before this card existed a tag could be created from any record but
 * never removed, so the delete path (and its confirm-before-detach warning) is
 * the behaviour worth pinning down.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { TagsSettingsCard } from '@/pages/v2/settings/components/tagsSettingsCard';

const mockApi = vi.mocked(api);

/**
 * Every query key prefix whose cached payload embeds a copy of a tag, and so
 * goes stale the moment a tag is renamed, recoloured or deleted:
 *   - the five detail keys the record pages read (TagInput's ENTITY_ROUTES),
 *   - the five list keys — each list page renders a Tags column via TagChips,
 *   - the schedule board's four job/lead fetches, which read those same list
 *     endpoints (tags attached) under their own keys.
 * Written out by hand ON PURPOSE: the card derives its set from the shared
 * TAG_ENTITY_ROUTES map, so a test importing that map would agree with any
 * future drift instead of catching it.
 */
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

/** Names of the caches the component failed to drop — asserted against []. */
function missingTagCacheKeys(invalidated: unknown[]): string[] {
  const seen = new Set(invalidated.map((k) => JSON.stringify(k)));
  return TAG_CACHE_KEYS.filter((k) => !seen.has(JSON.stringify(k))).map((k) => k[0]!);
}

const TAGS = [
  { id: 't1', name: 'Urgent', color: '#EF4444' },
  { id: 't2', name: 'Stale', color: '#6B7280' },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: { tags: TAGS } });
  mockApi.patch.mockResolvedValue({ data: { tag: { ...TAGS[0], name: 'Rush' } } });
  mockApi.delete.mockResolvedValue({ data: {} });
});

describe('TagsSettingsCard', () => {
  it('reads the plain tag list on the same key the record picker uses', async () => {
    renderWithProviders(<TagsSettingsCard />);

    expect(await screen.findByText('Urgent')).toBeInTheDocument();
    // No params: the per-tag usage count is gone, and sharing TagInput's exact
    // request means the two surfaces share one cache entry rather than two that
    // can disagree.
    expect(mockApi.get).toHaveBeenCalledWith('/api/tags');
    expect(screen.queryByText(/\d+ records?$/)).not.toBeInTheDocument();
    expect(screen.queryByText('Not used')).not.toBeInTheDocument();
  });

  it('renames a tag through PATCH /api/tags/:id', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TagsSettingsCard />);

    await user.click(await screen.findByLabelText('Edit tag Urgent'));
    const field = screen.getByLabelText('Rename tag Urgent');
    await user.clear(field);
    await user.type(field, 'Rush');
    await user.click(screen.getByRole('button', { name: 'Save tag' }));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledWith('/api/tags/t1', { name: 'Rush' }));
  });

  it('sends only the colour when the name is untouched', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TagsSettingsCard />);

    await user.click(await screen.findByLabelText('Edit tag Urgent'));
    await user.click(screen.getByLabelText('Use colour #22C55E'));
    await user.click(screen.getByRole('button', { name: 'Save tag' }));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledWith('/api/tags/t1', { color: '#22C55E' }));
  });

  it('does not call the API when nothing actually changed', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TagsSettingsCard />);

    await user.click(await screen.findByLabelText('Edit tag Urgent'));
    await user.click(screen.getByRole('button', { name: 'Save tag' }));

    await waitFor(() => expect(screen.getByLabelText('Edit tag Urgent')).toBeInTheDocument());
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('warns that a delete detaches the tag everywhere, and deletes on confirm', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TagsSettingsCard />);

    await user.click(await screen.findByLabelText('Delete tag Urgent'));

    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/removes the tag from every record it is assigned to/i),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/can't be undone/i)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Delete tag' }));

    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith('/api/tags/t1'));
  });

  it('gives every tag the same warning, used or not', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TagsSettingsCard />);

    await user.click(await screen.findByLabelText('Delete tag Stale'));

    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/removes the tag from every record it is assigned to/i),
    ).toBeInTheDocument();
  });

  it('does not delete when the confirm is cancelled', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TagsSettingsCard />);

    await user.click(await screen.findByLabelText('Delete tag Urgent'));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(mockApi.delete).not.toHaveBeenCalled();
  });

  it('drops every cached copy of a tag when the tag is deleted', async () => {
    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(<TagsSettingsCard />);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    await user.click(await screen.findByLabelText('Delete tag Urgent'));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete tag' }));

    // Waiting on the tag list itself is what proves onSuccess ran, so the
    // per-entity assertions below are not merely early.
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tags'] }));

    const invalidated = invalidate.mock.calls.map((c) => c[0]?.queryKey);
    expect(missingTagCacheKeys(invalidated)).toEqual([]);
  });

  it('drops every cached copy of a tag when the tag is renamed', async () => {
    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(<TagsSettingsCard />);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    await user.click(await screen.findByLabelText('Edit tag Urgent'));
    const field = screen.getByLabelText('Rename tag Urgent');
    await user.clear(field);
    await user.type(field, 'Rush');
    await user.click(screen.getByRole('button', { name: 'Save tag' }));

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tags'] }));

    const invalidated = invalidate.mock.calls.map((c) => c[0]?.queryKey);
    expect(missingTagCacheKeys(invalidated)).toEqual([]);
  });

  it('points admins at the record pages when the org has no tags yet', async () => {
    mockApi.get.mockResolvedValue({ data: { tags: [] } });
    renderWithProviders(<TagsSettingsCard />);

    expect(await screen.findByText(/No tags yet/i)).toBeInTheDocument();
  });
});
