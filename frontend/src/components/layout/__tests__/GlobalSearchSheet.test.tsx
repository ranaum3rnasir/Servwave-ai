/// <reference types="@testing-library/jest-dom/vitest" />
// Mobile slice 33: global search is a full-screen sheet below md.
//
// jsdom has no layout engine, so the width is chosen the way the app chooses it: through
// `window.matchMedia`. What this pins, at phone width: the Search button opens a modal full-screen
// sheet (not a popover under the bar) holding a labelled search field with the Search action key
// and 16 px text, and its results sit in a region of the sheet that scrolls (not an absolutely
// positioned dropdown). At desktop width the field stays inline in the bar and nothing opens.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from '@/ui-kit/components/layout/appShell';
import { TooltipProvider } from '@/ui-kit/components/ui/tooltip';
import { TopBar, TopBarSearchSlot } from '@/ui-kit/components/layout/nav/topBar';
import GlobalSearch from '../GlobalSearch';

const get = vi.fn();
vi.mock('@/lib/axios', () => ({ default: { get: (...a: unknown[]) => get(...a) } }));

const REAL_MATCH_MEDIA = window.matchMedia;
function stubWidth(kind: 'phone' | 'desktop') {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: kind === 'phone' && query.includes('max-width'),
    media: query,
    onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
}

function renderBar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider>
        <AppShell
          sidebar={<nav />}
          topbar={
            <TopBar>
              <TopBarSearchSlot label="Search" resetKey="/">
                <GlobalSearch className="w-full" placeholder="Search everything..." />
              </TopBarSearchSlot>
            </TopBar>
          }
        >
          <div>page</div>
        </AppShell>
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const customer = (i: number) => ({ id: `c${i}`, entity_type: 'customer', title: `Customer ${i}` });

beforeEach(() => {
  get.mockReset();
  get.mockResolvedValue({
    data: { results: { jobs: [], customers: [1, 2, 3, 4, 5].map(customer), leads: [], estimates: [], invoices: [], servicePlans: [], calendarEntries: [] } },
  });
});
afterEach(() => {
  window.matchMedia = REAL_MATCH_MEDIA;
});

describe('global search at phone width', () => {
  beforeEach(() => stubWidth('phone'));

  it('opens a full-screen modal sheet with a labelled 16 px search field and the Search action key', async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(screen.getByRole('button', { name: 'Search' }));

    const sheet = await screen.findByRole('dialog', { name: 'Search' });
    expect(sheet).toHaveAttribute('data-slot', 'sheet-content');
    expect(sheet.className).toMatch(/\binset-0\b/);
    expect(sheet.className).toMatch(/\bh-dvh\b/);

    const field = within(sheet).getByRole('combobox', { name: 'Search everything' });
    expect(field).toHaveAttribute('enterkeyhint', 'search');
    expect(field.className).toMatch(/(^|\s)text-base(\s|$)/);
    expect(field.className).not.toMatch(/(^|\s)text-sm(\s|$)/);
    // The field fills the sheet's width (its wrapper does not cap it).
    expect(field.closest('[data-slot="search-field"]')?.className).toMatch(/\bw-full\b/);
  });

  it('shows results in a scrolling region of the sheet, not an absolute dropdown', async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(screen.getByRole('button', { name: 'Search' }));
    const sheet = await screen.findByRole('dialog', { name: 'Search' });
    await user.type(within(sheet).getByRole('combobox'), 'cu');

    const list = await within(sheet).findByRole('listbox');
    expect(list.className).not.toMatch(/\babsolute\b/);
    expect(list.className).toMatch(/\boverflow-y-auto\b/);
    expect(list.className).toMatch(/\bflex-1\b/);
    expect(await within(list).findAllByRole('option')).toHaveLength(5);
  });

  it('names the clear button', async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(screen.getByRole('button', { name: 'Search' }));
    const sheet = await screen.findByRole('dialog', { name: 'Search' });
    await user.type(within(sheet).getByRole('combobox'), 'cu');
    expect(within(sheet).getByRole('button', { name: 'Clear search' })).toBeInTheDocument();
  });
});

describe('global search at desktop width', () => {
  beforeEach(() => stubWidth('desktop'));

  it('stays inline in the bar with a named field and clear button, and opens no sheet', async () => {
    const user = userEvent.setup();
    renderBar();
    expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();
    const field = screen.getByRole('combobox', { name: 'Search everything' });
    await user.type(field, 'cu');
    expect(await screen.findByRole('listbox')).toHaveClass('absolute');
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
