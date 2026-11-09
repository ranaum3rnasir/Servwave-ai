/**
 * Lists that grow (house rule 7): 150 sources, 150 tags' worth of rows, and the 500-row cap. The card must still hold
 * ONE scrolling rows area (the stylesheet fixes its height at eight rows), search and sort must work over everything,
 * and a created row must be scrolled into view INSIDE its card.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import ListsPage from '@/pages/v2/settings/ListsPage';
import { renderWithProviders } from './helpers';
import { installListsServer, makeRows, row } from './listsFake';

vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }),
}));

const mockApi = vi.mocked(api);
const PAGE = buildAbility([{ action: 'update', subject: 'Organization' }]);

let server: ReturnType<typeof installListsServer>;
beforeEach(() => {
  vi.clearAllMocks();
  server = installListsServer(mockApi, {
    '/api/job-types': { rows: makeRows('Type', 500) },
    '/api/lead-sources': { rows: [...makeRows('Source', 150), row('few', 'Zebra crossing', { sort_order: 150, used_count: 900 })] },
  });
});

/** Cheap lookups for the big cards: getByRole / getByLabelText compute an accessible name for every row's controls (seconds for 150 to 500 rows on a small machine), so find the create button and its input by visible text. */
const createButton = (c: HTMLElement, singular: string) => within(c).getByText(`Create ${singular}`).closest('button')!;
const nameInput = (c: HTMLElement, singular: string) => c.querySelector<HTMLInputElement>(`#${CSS.escape(within(c).getByText(`Name of the new ${singular}`).getAttribute('for')!)}`)!;

const card = (title: string) => screen.getByRole('heading', { name: title }).closest('[data-slot="card"]') as HTMLElement;

describe('150 sources and 500 job types', () => {
  it('each card has one rows area holding every row, and the counts are right', async () => {
    renderWithProviders(<ListsPage />, { ability: PAGE });
    const sources = await screen.findByRole('list', { name: 'Lead/Customer sources' });
    await waitFor(() => expect(within(sources).getAllByRole('listitem')).toHaveLength(151));
    expect(card('Lead/Customer sources').querySelectorAll('.lc-scroll')).toHaveLength(1);
    expect(within(card('Lead/Customer sources')).getByText('151 sources')).toBeInTheDocument();
    const types = screen.getByRole('list', { name: 'Job types' });
    await waitFor(() => expect(within(types).getAllByRole('listitem')).toHaveLength(500));
    expect(within(card('Job types')).getByText('500 job types')).toBeInTheDocument();
  });

  it('search narrows over all rows and sort puts the most used first', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ListsPage />, { ability: PAGE });
    const c = () => card('Lead/Customer sources');
    await within(c()).findByText('Zebra crossing');
    await user.type(within(c()).getByRole('searchbox', { name: 'Search lead/customer sources' }), 'Source 14');
    // Source 14, 140 to 149
    expect(within(c()).getAllByRole('listitem')).toHaveLength(11);
    expect(within(c()).getByText('11 of 151')).toBeInTheDocument();
    await user.clear(within(c()).getByRole('searchbox', { name: 'Search lead/customer sources' }));

    await user.click(within(c()).getByRole('combobox', { name: 'Sort lead/customer sources' }));
    await user.click(screen.getByRole('option', { name: 'Most used' }));
    expect(within(c()).getAllByRole('listitem')[0]).toHaveTextContent('Zebra crossing');
  });

  describe('a created row is scrolled into view inside its card', () => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    afterEach(() => {
      HTMLElement.prototype.getBoundingClientRect = original;
    });

    it('moves the rows area, not the page', async () => {
      const user = userEvent.setup();
      renderWithProviders(<ListsPage />, { ability: PAGE });
      const c = () => card('Lead/Customer sources');
      await within(c()).findByText('Zebra crossing');
      // jsdom has no layout: say where the box and the new row are, and give the box a scrollTop that sticks.
      const box = c().querySelector('.lc-scroll') as HTMLElement;
      let top = 0;
      Object.defineProperty(box, 'scrollTop', { get: () => top, set: (v: number) => void (top = v), configurable: true });
      const rect = (t: number, b: number) => ({ top: t, bottom: b, left: 0, right: 0, width: 0, height: b - t, x: 0, y: t, toJSON: () => ({}) }) as DOMRect;
      HTMLElement.prototype.getBoundingClientRect = function () {
        if (this === box) return rect(0, 416);
        if (this.dataset?.id?.startsWith('new-')) return rect(6000, 6052);
        return rect(0, 0);
      };

      await user.click(createButton(c(), 'source'));
      await user.type(nameInput(c(), 'source'), 'Fresh source{Enter}');
      await within(c()).findByText('Fresh source');
      await waitFor(() => expect(top).toBe(6052 - 416));
      expect(server.calls.some((x) => x.method === 'post' && x.url === '/api/lead-sources')).toBe(true);
    });
  });
});

describe('the 500-row cap', () => {
  it('answers a 501st job type with the server\'s own words under the input', async () => {
    server.lists['/api/job-types']!.cap = 500;
    const user = userEvent.setup();
    renderWithProviders(<ListsPage />, { ability: PAGE });
    const c = () => card('Job types');
    await within(c()).findByText('Type 1');
    // Same cheap lookups as above: the 500-row case used to spend ~15 s in accessible-name queries, not in the cap.
    await user.click(createButton(c(), 'job type'));
    const input = nameInput(c(), 'job type');
    await user.click(input);
    await user.paste('One too many');
    await user.keyboard('{Enter}');
    expect(await within(c()).findByRole('alert')).toHaveTextContent('This list can hold up to 500 items.');
  });
});
