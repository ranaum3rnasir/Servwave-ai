/**
 * Reordering the Job types card (spec 6.4): the Move buttons and the drag send the WHOLE active id list, the controls go
 * `aria-disabled` (not natively disabled, so a tap can still be told why) while a search is on, and Sources have none.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { toast } from '@/ui-kit/components/ui/sonner';
import ListsPage from '@/pages/v2/settings/ListsPage';
import { renderWithProviders } from './helpers';
import { installListsServer, row, savedToasts } from './listsFake';

vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }),
}));

const mockApi = vi.mocked(api);
const toastMock = vi.mocked(toast);
const PAGE = buildAbility([{ action: 'update', subject: 'Organization' }]);
const REASON = 'Clear the search to reorder.';

let server: ReturnType<typeof installListsServer>;
beforeEach(() => {
  vi.clearAllMocks();
  server = installListsServer(mockApi, {
    '/api/job-types': {
      rows: [
        row('a', 'Repair', { sort_order: 0 }),
        row('b', 'Install', { sort_order: 1 }),
        row('c', 'Inspection', { sort_order: 2 }),
        row('d', 'Old', { sort_order: 3, archived: true }),
      ],
    },
    '/api/lead-sources': { rows: [row('s1', 'Google'), row('s2', 'Referral')] },
  });
});

async function open() {
  const user = userEvent.setup();
  renderWithProviders(<ListsPage />, { ability: PAGE });
  await screen.findByRole('heading', { name: 'Job types' });
  const card = screen.getByRole('heading', { name: 'Job types' }).closest('[data-slot="card"]') as HTMLElement;
  await within(card).findByText('Repair');
  return { user, card };
}
const order = (card: HTMLElement) => within(card).getAllByRole('listitem').map((li) => li.querySelector('.lc-nm')?.textContent);
const reorderPosts = () => server.calls.filter((x) => x.method === 'post' && x.url === '/api/job-types/reorder');
const rowOf = (card: HTMLElement, name: string) => within(card).getByText(name, { selector: '.lc-nm' }).closest('[role="listitem"]') as HTMLElement;

describe('Move up / Move down', () => {
  it('Move down sends the whole active id list, shows the new order and toasts with Undo', async () => {
    const { user, card } = await open();
    await user.click(within(card).getByRole('button', { name: 'Move Repair down' }));
    await waitFor(() => expect(order(card)).toEqual(['Install', 'Repair', 'Inspection']));
    expect(reorderPosts().map((x) => x.body)).toEqual([{ ordered_ids: ['b', 'a', 'c'] }]);
    const saved = (await savedToasts(toastMock)).at(-1)!;
    expect(saved.text).toBe('Saved · Moved “Repair” down');
    expect(saved.undoLabel).toBe('Undo');
  });

  it('Undo sends the previous order back', async () => {
    const { user, card } = await open();
    await user.click(within(card).getByRole('button', { name: 'Move Inspection up' }));
    await waitFor(() => expect(order(card)).toEqual(['Repair', 'Inspection', 'Install']));
    await act(async () => (await savedToasts(toastMock)).at(-1)!.undo!());
    await waitFor(() => expect(order(card)).toEqual(['Repair', 'Install', 'Inspection']));
    expect(reorderPosts().at(-1)!.body).toEqual({ ordered_ids: ['a', 'b', 'c'] });
    expect(toastMock).toHaveBeenLastCalledWith('Change undone');
  });

  it('focus stays on the same button after a move', async () => {
    const { user, card } = await open();
    await user.click(within(card).getByRole('button', { name: 'Move Repair down' }));
    await waitFor(() => expect(order(card)).toEqual(['Install', 'Repair', 'Inspection']));
    await waitFor(() => expect(within(card).getByRole('button', { name: 'Move Repair down' })).toHaveFocus());
  });

  it('the first Up and the last Down are aria-disabled and do nothing', async () => {
    const { user, card } = await open();
    const up = within(card).getByRole('button', { name: 'Move Repair up' });
    const down = within(card).getByRole('button', { name: 'Move Inspection down' });
    expect(up).toHaveAttribute('aria-disabled', 'true');
    expect(down).toHaveAttribute('aria-disabled', 'true');
    await user.click(up);
    await user.click(down);
    expect(reorderPosts()).toHaveLength(0);
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('a failed save puts the old order back and shows the error', async () => {
    const { user, card } = await open();
    const post = mockApi.post.getMockImplementation()!;
    mockApi.post.mockImplementation(((url: string, body?: unknown) =>
      url === '/api/job-types/reorder' ? Promise.reject({ response: { status: 400, data: { error: 'Send all 3 active job types when reordering' } } }) : post(url, body)) as never);
    await user.click(within(card).getByRole('button', { name: 'Move Repair down' }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Send all 3 active job types when reordering'));
    await waitFor(() => expect(order(card)).toEqual(['Repair', 'Install', 'Inspection']));
  });
});

describe('while the reorder is off', () => {
  it('a search turns the grip and both buttons aria-disabled with the reason, shows the note, and a tap toasts the reason', async () => {
    const { user, card } = await open();
    expect(within(card).queryByText(/Dragging and the Move buttons are off/)).not.toBeInTheDocument();
    await user.type(within(card).getByRole('searchbox', { name: 'Search job types' }), 'ins');

    expect(within(card).getByText('Clear the search to reorder. Dragging and the Move buttons are off until then.')).toBeInTheDocument();
    const up = within(card).getByRole('button', { name: 'Move Inspection up' });
    const down = within(card).getByRole('button', { name: 'Move Inspection down' });
    for (const b of [up, down]) {
      expect(b).toHaveAttribute('aria-disabled', 'true');
      expect(b).toHaveAttribute('title', REASON);
    }
    const grip = rowOf(card, 'Inspection').querySelector('[data-slot="lc-grip"]')!;
    expect(grip).toHaveAttribute('aria-disabled', 'true');
    expect(grip).toHaveAttribute('title', REASON);

    await user.click(down);
    expect(toastMock).toHaveBeenLastCalledWith(REASON);
    await user.click(grip);
    expect(toastMock).toHaveBeenCalledTimes(2);
    expect(reorderPosts()).toHaveLength(0);
    expect(rowOf(card, 'Inspection')).not.toHaveAttribute('draggable');
  });

  it('clearing the search turns reordering back on', async () => {
    const { user, card } = await open();
    const box = within(card).getByRole('searchbox', { name: 'Search job types' });
    await user.type(box, 'ins');
    await user.clear(box);
    expect(within(card).queryByText(/Dragging and the Move buttons are off/)).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Move Install down' })).not.toHaveAttribute('aria-disabled');
    expect(rowOf(card, 'Install')).toHaveAttribute('draggable', 'true');
  });

  it('the Archived view has no grip, no Move buttons and no note', async () => {
    const { user, card } = await open();
    await user.click(within(card).getByRole('radio', { name: 'Archived 1' }));
    await user.type(within(card).getByRole('searchbox', { name: 'Search job types' }), 'ol');
    expect(card.querySelector('[data-slot="lc-grip"]')).toBeNull();
    expect(within(card).queryByRole('button', { name: /^Move / })).not.toBeInTheDocument();
    expect(within(card).queryByText(/Dragging and the Move buttons are off/)).not.toBeInTheDocument();
  });
});

describe('drag', () => {
  const dt = () => ({ dataTransfer: { effectAllowed: '', setData: vi.fn() } });

  it('dropping a row on the top half of another sends the whole active id list and toasts "Moved"', async () => {
    const { card } = await open();
    const dragged = rowOf(card, 'Inspection');
    fireEvent.dragStart(dragged, dt());
    expect(dragged).toHaveClass('is-drag');
    const target = rowOf(card, 'Install');
    fireEvent.dragOver(target, { clientY: 0 });
    expect(target).toHaveClass('is-over');
    fireEvent.drop(target);

    await waitFor(() => expect(reorderPosts().map((x) => x.body)).toEqual([{ ordered_ids: ['a', 'c', 'b'] }]));
    await waitFor(() => expect(order(card)).toEqual(['Repair', 'Inspection', 'Install']));
    expect((await savedToasts(toastMock)).at(-1)!.text).toBe('Saved · Moved “Inspection”');
  });

  it('the bottom half drops AFTER the row', async () => {
    const { card } = await open();
    fireEvent.dragStart(rowOf(card, 'Repair'), dt());
    const target = rowOf(card, 'Install');
    // jsdom's drag events carry no coordinates, so the pointer position is put on the event by hand.
    const over = createEvent.dragOver(target);
    Object.defineProperty(over, 'clientY', { value: 10 });
    fireEvent(target, over);
    expect(target).toHaveClass('is-over-after');
    fireEvent.drop(target);
    await waitFor(() => expect(reorderPosts().map((x) => x.body)).toEqual([{ ordered_ids: ['b', 'a', 'c'] }]));
  });

  it('dropping a row back where it was sends nothing, and the drag marks clear', async () => {
    const { card } = await open();
    const r = rowOf(card, 'Repair');
    fireEvent.dragStart(r, dt());
    fireEvent.dragOver(rowOf(card, 'Install'), { clientY: 0 });
    fireEvent.dragEnd(r);
    expect(reorderPosts()).toHaveLength(0);
    expect(r).not.toHaveClass('is-drag');
  });
});

describe('Sources', () => {
  it('have no grip and no Move buttons, and keep their creation order', async () => {
    await open();
    const card = screen.getByRole('heading', { name: 'Lead/Customer sources' }).closest('[data-slot="card"]') as HTMLElement;
    await within(card).findByText('Google');
    expect(card.querySelector('[data-slot="lc-grip"]')).toBeNull();
    expect(within(card).queryByRole('button', { name: /^Move / })).not.toBeInTheDocument();
    expect(within(card).queryByText(/Dragging and the Move buttons/)).not.toBeInTheDocument();
    expect(within(card).getAllByRole('listitem').every((li) => !li.hasAttribute('draggable'))).toBe(true);
  });
});
