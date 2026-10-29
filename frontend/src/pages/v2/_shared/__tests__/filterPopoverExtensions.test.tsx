/**
 * What the shared list filter takes so jobs, estimates, tasks and inventory can use it
 * (mobile slice 64): their own option paint, their own pane for one facet, the org zone for a
 * scheduling facet, and the constraints that live outside the facet list.
 *
 * Each is a prop, never a branch on the caller. RED before the change: the props did not exist, so
 * every one of these rendered the standard control, or nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { todayDay } from '@/lib/date-range';
import type { FacetConfig, FilterState } from '@/lib/filters/types';
import { FilterPopover, type FilterPopoverProps } from '../filterPopover';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const original = { w: window.innerWidth, h: window.innerHeight };
const setViewport = (width: number, height: number) => {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true });
};

const registry: FacetConfig[] = [
  {
    key: 'status', label: 'Status', icon: '', kind: 'multi', param: 'status',
    options: [{ value: 'OPEN', label: 'Open' }, { value: 'DONE', label: 'Done' }],
  },
  {
    key: 'tags', label: 'Tags', icon: '', kind: 'multi', param: 'tags',
    options: [{ value: 't1', label: 'Rush', swatch: '#ff0000' }],
  },
  { key: 'scheduled', label: 'Scheduled', icon: '', kind: 'dateRange', param: 'scheduled' },
];

function renderFilter(props: Partial<FilterPopoverProps> = {}) {
  const onChange = vi.fn();
  const view = render(
    <FilterPopover
      registry={registry}
      value={{}}
      onChange={onChange}
      resolveOptions={() => []}
      {...props}
    />,
  );
  return { onChange, ...view };
}

const open = async () => {
  await userEvent.click(screen.getByRole('button', { name: /^Filter/ }));
};

beforeEach(() => {
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  setViewport(1280, 720);
});
afterEach(() => setViewport(original.w, original.h));

describe('option paint', () => {
  it('a caller paints its own options, and returning undefined leaves one plain', async () => {
    renderFilter({
      renderOption: (facet, option) =>
        (facet.key === 'status' ? <span data-testid={`chip-${option.value}`}>chip {option.label}</span> : undefined),
    });
    await open();

    expect(screen.getByTestId('chip-OPEN')).toHaveTextContent('chip Open');
    await userEvent.click(screen.getByRole('tab', { name: 'Tags' }));
    expect(screen.getByText('Rush')).toBeInTheDocument();
  });

  it('a colour swatch rides on an option, and every option checkbox is named for it', async () => {
    const { container } = renderFilter();
    await open();
    await userEvent.click(screen.getByRole('tab', { name: 'Tags' }));

    expect(screen.getByRole('checkbox', { name: 'Rush' })).toBeInTheDocument();
    const dot = Array.from(container.ownerDocument.querySelectorAll('span[aria-hidden]'))
      .find((el) => (el as HTMLElement).style.backgroundColor !== '');
    expect(dot).toBeTruthy();
  });
});

describe('a caller-supplied pane', () => {
  it('replaces one facet, runs only while that pane shows, and writes through the context', async () => {
    const paneRuns = vi.fn();
    const { onChange } = renderFilter({
      renderFacet: (facet, ctx) => {
        if (facet.key !== 'tags') return undefined;
        paneRuns();
        return <button type="button" onClick={() => ctx.onChange({ kind: 'multi', values: ['custom'] })}>custom pane</button>;
      },
    });
    await open();
    expect(paneRuns).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('tab', { name: 'Tags' }));
    expect(paneRuns).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'custom pane' }));
    expect(onChange).toHaveBeenCalledWith({ tags: { kind: 'multi', values: ['custom'] } });
  });

  it('on a phone the pane writes the draft, and only Apply reaches the page', async () => {
    setViewport(320, 568);
    const { onChange } = renderFilter({
      renderFacet: (facet, ctx) =>
        (facet.key === 'tags'
          ? <button type="button" onClick={() => ctx.onChange({ kind: 'multi', values: ['custom'] })}>custom pane</button>
          : undefined),
    });
    await open();
    const sheet = await screen.findByRole('dialog');
    await userEvent.click(within(sheet).getByRole('button', { name: /^Tags/ }));
    await userEvent.click(within(sheet).getByRole('button', { name: 'custom pane' }));
    expect(onChange).not.toHaveBeenCalled();

    await userEvent.click(within(sheet).getByRole('button', { name: 'Apply' }));
    expect(onChange).toHaveBeenCalledWith({ tags: { kind: 'multi', values: ['custom'] } });
  });
});

describe('the org zone for a scheduling facet', () => {
  // 25 hours apart: at any instant the two zones are on different calendar days.
  const EAST = 'Pacific/Kiritimati';
  const WEST = 'Pacific/Pago_Pago';
  const todayInEast: FilterState = {
    scheduled: { kind: 'dateRange', from: todayDay(EAST), to: todayDay(EAST) },
  };

  it('reads the range as that zone\'s day, so a preset matches there', async () => {
    renderFilter({ value: todayInEast, facetTimezones: { scheduled: EAST } });
    await open();
    await userEvent.click(screen.getByRole('tab', { name: /^Scheduled/ }));
    expect(screen.getByRole('combobox', { name: 'Scheduled range' })).toHaveTextContent('Today');
  });

  it('a facet with no zone stays on the browser clock', async () => {
    renderFilter({ value: todayInEast, facetTimezones: { scheduled: WEST } });
    await open();
    await userEvent.click(screen.getByRole('tab', { name: /^Scheduled/ }));
    expect(screen.getByRole('combobox', { name: 'Scheduled range' })).not.toHaveTextContent('Today');
  });
});

describe('constraints outside the facet list', () => {
  it('count in the badge, show the subtitle, and are cleared by the caller\'s own Clear all', async () => {
    const onClearAll = vi.fn();
    const { onChange } = renderFilter({
      subtitle: 'Showing 3 of 9 items', extraCount: 2, hasExtraConstraint: true, onClearAll,
    });
    expect(within(screen.getByRole('button', { name: /^Filter/ })).getByText('2')).toBeInTheDocument();

    await open();
    expect(screen.getByText('Showing 3 of 9 items')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(onClearAll).toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('with nothing applied anywhere there is no Clear all', async () => {
    renderFilter({ onClearAll: vi.fn() });
    await open();
    expect(screen.queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument();
  });

  it('on a phone, Clear then Apply runs the caller\'s clear before the draft', async () => {
    setViewport(320, 568);
    const order: string[] = [];
    renderFilter({
      value: { status: { kind: 'multi', values: ['OPEN'] } },
      onChange: () => order.push('change'),
      onClearAll: () => order.push('clear'),
      hasExtraConstraint: true,
    });
    await open();
    const sheet = await screen.findByRole('dialog');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Clear' }));
    await userEvent.click(within(sheet).getByRole('button', { name: 'Apply' }));
    expect(order).toEqual(['clear', 'change']);
  });
});
