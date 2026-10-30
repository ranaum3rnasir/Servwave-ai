/**
 * The Lists page itself (spec 6.1, 6.2, 6.8, 6.9, 6.10): the cards in order with their help behind a "?", no subtitle,
 * no saver for the settings Save bar, the route-level gate, and the stylesheet's promises (eight rows tall, the phone
 * layout, and not one `overscroll` or wheel handler anywhere in the new files).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import ListsPage from '@/pages/v2/settings/ListsPage';
import { SettingsBarProvider } from '@/pages/v2/settings/settingsBar';
import { renderWithProviders } from './helpers';
import { installListsServer, row } from './listsFake';

const mockApi = vi.mocked(api);
const PAGE = buildAbility([{ action: 'update', subject: 'Organization' }]);

beforeEach(() => {
  vi.clearAllMocks();
  installListsServer(mockApi, {
    '/api/job-types': { rows: [row('j1', 'Repair')] },
    '/api/lead-sources': { rows: [row('s1', 'Google')] },
  });
});

const HELP = {
  'Job types': 'The kinds of work you do, such as Repair or Install. You pick one on every job, and the order here is the order of the job-type menu.',
  'Lead/Customer sources': 'Where a lead or customer first heard about you, such as Google or a referral. Used on every lead and customer, and to see which sources bring in work.',
};

describe('Lists page', () => {
  it('shows Job types then Lead/Customer sources, each titled exactly', async () => {
    renderWithProviders(<ListsPage />, { ability: PAGE });
    await screen.findByText('Repair');
    const titles = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(titles.slice(0, 2)).toEqual(['Job types', 'Lead/Customer sources']);
  });

  it.each(Object.entries(HELP))('%s: no grey subtitle; the help sits behind a "?" that opens on click and closes on Escape', async (title, text) => {
    const user = userEvent.setup();
    renderWithProviders(<ListsPage />, { ability: PAGE });
    await screen.findByText('Repair');
    const heading = screen.getByRole('heading', { name: title });
    // The title block holds the title and the "?", never a sentence.
    expect(heading.parentElement!.querySelectorAll('p')).toHaveLength(1);
    expect(screen.queryByText(text)).not.toBeInTheDocument();

    await user.click(within(heading.parentElement!).getByRole('button', { name: `More about ${title}` }));
    expect(await screen.findByText(text)).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByText(text)).not.toBeInTheDocument();
  });

  it('the "?" also closes on an outside press', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ListsPage />, { ability: PAGE });
    await screen.findByText('Repair');
    await user.click(screen.getByRole('button', { name: 'More about Job types' }));
    expect(await screen.findByText(HELP['Job types'])).toBeInTheDocument();
    await user.click(screen.getByRole('searchbox', { name: 'Search lead/customer sources' }));
    expect(screen.queryByText(HELP['Job types'])).not.toBeInTheDocument();
  });

  it('registers no saver, so the settings Save bar has nothing to show', async () => {
    const registerSaver = vi.fn();
    renderWithProviders(
      <SettingsBarProvider value={{ registerSaver }}>
        <ListsPage />
      </SettingsBarProvider>,
      { ability: PAGE },
    );
    await screen.findByText('Repair');
    expect(registerSaver).not.toHaveBeenCalled();
  });

  it('turns away someone who may not update company settings, and asks the server for nothing', async () => {
    renderWithProviders(<ListsPage />, { ability: buildAbility([{ action: 'read', subject: 'Organization' }]) });
    expect(await screen.findByText(/don.t have access/i)).toBeInTheDocument();
    expect(mockApi.get).not.toHaveBeenCalledWith('/api/job-types');
  });

  it('keeps the rows container mounted when data changes (each card keeps its scroll position)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ListsPage />, { ability: PAGE });
    await screen.findByText('Repair');
    const list = screen.getByRole('list', { name: 'Job types' });
    await user.type(screen.getByRole('searchbox', { name: 'Search job types' }), 'rep');
    await user.click(within(screen.getByRole('heading', { name: 'Job types' }).closest('[data-slot="card"]') as HTMLElement).getByRole('radio', { name: /^Archived/ }));
    expect(screen.getByRole('list', { name: 'Job types' })).toBe(list);
  });
});

describe('the new files', () => {
  const ROOT = resolve(__dirname, '..', 'pages', 'v2', 'settings');
  const files = [
    join(ROOT, 'ListsPage.tsx'),
    ...readdirSync(join(ROOT, 'lists')).map((f) => join(ROOT, 'lists', f)),
  ];
  const text = (f: string) => readFileSync(f, 'utf8');

  it('contain no overscroll-behavior and no wheel handler (spec 6.8, 6.12 check 2)', () => {
    expect(files.length).toBeGreaterThan(8);
    for (const f of files) {
      expect(text(f).includes('overscroll'), `${f} mentions overscroll`).toBe(false);
      expect(text(f).includes('onWheel'), `${f} has a wheel handler`).toBe(false);
    }
  });

  const css = text(join(ROOT, 'lists', 'lists.css'));

  it('make every card exactly eight rows tall and scroll the rows area, with the row height 104px on a phone', () => {
    expect(css).toMatch(/\.lc-scroll\s*\{[^}]*height:\s*calc\(var\(--row-h\)\s*\*\s*8\)[^}]*overflow-y:\s*auto/);
    expect(css).toMatch(/--row-h:\s*52px/);
    const phone = css.slice(css.indexOf('@media (max-width: 640px)'));
    expect(phone).toMatch(/--row-h:\s*104px/);
  });

  it('hide the column header and the grip on a phone and switch to the narrow columns under 620px', () => {
    const phone = css.slice(css.indexOf('@media (max-width: 640px)'));
    expect(phone).toMatch(/\.lc-head\s*\{\s*display:\s*none/);
    expect(phone).toMatch(/\.lc-row \.lc-grip\s*\{\s*display:\s*none/);
    expect(css).toMatch(/@container lc \(max-width: 619px\)/);
    expect(css).toMatch(/container:\s*lc \/ inline-size/);
  });

  it('put the colour button on line 2 beside the actions on a phone, show only the dot in a narrow card, and keep names visible on the phone', () => {
    const phone = css.slice(css.indexOf('@media (max-width: 640px)'));
    expect(phone).toMatch(/\.lc-row\.has-col\s*\{\s*grid-template-areas:\s*'name meta' 'sw act'/);
    expect(phone).toMatch(/\.lc-row \.lc-swn\s*\{\s*display:\s*inline/);
    const narrow = css.slice(css.indexOf('@container lc'), css.indexOf('/* Phone'));
    expect(narrow).toMatch(/\.lc-swn,\s*\.lc-head-colour\s*\{\s*display:\s*none/);
  });

  it('use the spec\'s card grid', () => {
    expect(css).toMatch(/repeat\(auto-fit,\s*minmax\(min\(100%,\s*480px\),\s*1fr\)\)/);
  });
});
