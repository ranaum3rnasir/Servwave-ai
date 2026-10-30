/**
 * The list filter on a phone (mobile slice 51).
 *
 * RED before the change: the filter was one 640 px two-pane popover at every width, so on a 320 px
 * phone its top landed at -155 and its right-hand value pane had no room. Now, below md, it is a
 * bottom sheet: the facet list drills into one full-width value list, and Apply / Clear are pinned.
 *
 * jsdom has no layout, so the geometry itself lives in `filterPlacement` (its own test, with the
 * measured failing cases) and in the mobile gate; here we pin which presentation each width gets
 * and that the draft only reaches the page on Apply.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { FacetConfig, FilterState } from '@/lib/filters/types';
import { FilterPopover } from '../filterPopover';

const registry: FacetConfig[] = [
  {
    key: 'status', label: 'Status', icon: '', kind: 'multi', param: 'status',
    options: [{ value: 'NEW', label: 'New' }, { value: 'WON', label: 'Won' }],
  },
  { key: 'created', label: 'Created', icon: '', kind: 'dateRange', param: 'created' },
];

const original = { w: window.innerWidth, h: window.innerHeight };
const setViewport = (width: number, height: number) => {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true });
};

function renderFilter(value: FilterState = {}) {
  const onChange = vi.fn();
  render(
    <FilterPopover
      registry={registry}
      value={value}
      onChange={onChange}
      resolveOptions={() => []}
      resolveMax={() => 0}
      statusDomain="lead"
    />,
  );
  return onChange;
}

beforeEach(() => setViewport(1280, 720));
afterEach(() => setViewport(original.w, original.h));

describe('FilterPopover presentation', () => {
  it('shows the applied-filter count on the Filter button', () => {
    renderFilter({ status: { kind: 'multi', values: ['NEW', 'WON'] }, created: { kind: 'dateRange', from: '2026-01-01', to: '' } });
    expect(screen.getByRole('button', { name: /Filter/ })).toHaveTextContent('3');
  });

  it('is the two-pane popover at md and up', async () => {
    renderFilter();
    await userEvent.click(screen.getByRole('button', { name: /Filter/ }));
    expect(await screen.findByRole('tablist', { name: 'Filter facets' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
  });

  it('keeps every facet tab its full height when the list outgrows its box (they scroll, never shrink)', async () => {
    renderFilter();
    await userEvent.click(screen.getByRole('button', { name: /Filter/ }));
    const list = await screen.findByRole('tablist', { name: 'Filter facets' });
    // jsdom has no layout: the facet list is a flex column, so a tab without shrink-0 is squashed (32 px down to 20 px)
    // once the facets no longer fit. The mobile gate measured 171x20 tabs on the Jobs filter.
    for (const tab of within(list).getAllByRole('tab')) expect(tab.className).toMatch(/(^|\s)shrink-0(\s|$)/);
  });

  it('is a bottom sheet below md: the facet list first, no side rail', async () => {
    setViewport(320, 568);
    renderFilter();
    await userEvent.click(screen.getByRole('button', { name: /Filter/ }));
    const sheet = await screen.findByRole('dialog');
    expect(sheet).toHaveAttribute('data-presentation', 'bottom-sheet');
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: /Status/ })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: /Created/ })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Apply' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Clear' })).toBeInTheDocument();
  });

  it('is a bottom sheet on a phone held sideways too', async () => {
    setViewport(838, 390);
    renderFilter();
    await userEvent.click(screen.getByRole('button', { name: /Filter/ }));
    expect(await screen.findByRole('dialog')).toHaveAttribute('data-presentation', 'bottom-sheet');
  });
});

describe('FilterPopover bottom sheet', () => {
  beforeEach(() => setViewport(375, 667));

  it('gives focus back to the Filter button when the sheet closes (Escape, and Apply)', async () => {
    renderFilter();
    const trigger = screen.getByRole('button', { name: /Filter/ });
    await userEvent.click(trigger);
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    await userEvent.click(trigger);
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('drills into one value list and back, and only Apply reaches the page', async () => {
    const onChange = renderFilter();
    await userEvent.click(screen.getByRole('button', { name: /Filter/ }));
    const sheet = await screen.findByRole('dialog');

    await userEvent.click(within(sheet).getByRole('button', { name: /Status/ }));
    expect(within(sheet).getByRole('button', { name: 'Back to filters' })).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole('checkbox', { name: /Won/ }));
    expect(onChange).not.toHaveBeenCalled(); // a draft, until Apply

    await userEvent.click(within(sheet).getByRole('button', { name: 'Back to filters' }));
    expect(within(sheet).getByRole('button', { name: /Created/ })).toBeInTheDocument();

    await userEvent.click(within(sheet).getByRole('button', { name: 'Apply' }));
    expect(onChange).toHaveBeenCalledWith({ status: { kind: 'multi', values: ['WON'] } });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Clear empties the draft, and closing without Apply keeps the applied filters', async () => {
    const onChange = renderFilter({ status: { kind: 'multi', values: ['NEW'] } });
    await userEvent.click(screen.getByRole('button', { name: /Filter/ }));
    const sheet = await screen.findByRole('dialog');

    await userEvent.click(within(sheet).getByRole('button', { name: 'Clear' }));
    expect(within(sheet).getByRole('button', { name: 'Clear' })).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();

    await userEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
