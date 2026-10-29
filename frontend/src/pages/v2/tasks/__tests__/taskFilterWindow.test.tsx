/**
 * The Tasks Filter on the shared list filter (mobile slice 64).
 *
 * RED before the change: Tasks had its own copy of the filter window (a 640 px panel with a rail
 * 120 px wide on a phone) and no bottom sheet. It now goes through the shared filter, with the
 * store untouched: Member and Department are pick-one, the flags are two booleans, and the
 * Dashboard drill-down is not a facet but is still cleared by Clear all.
 *
 * Real filter store and real hooks; only the HTTP layer and the two directory lists are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { useTaskFilterStore } from '@/stores/taskFilterStore';

vi.mock('@/lib/api/users', () => ({
  useAssignableUsers: vi.fn(() => ({
    data: [
      { id: 'u-alice', first_name: 'Alice', last_name: 'Anderson', role: 'DISPATCHER', is_active: true, has_login: true, department: null },
      { id: 'u-bob', first_name: 'Bob', last_name: 'Baker', role: 'TECHNICIAN', is_active: true, has_login: true, department: null },
    ],
    isLoading: false,
  })),
}));
vi.mock('@/lib/api/departments', () => ({
  useDepartments: vi.fn(() => ({
    data: [{ id: 'd-ops', name: 'Operations', head_id: null, created_at: '2026-01-01T00:00:00Z' }],
    isLoading: false,
  })),
}));

import { TaskFilterTrigger } from '../components/taskFilterBar';

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

const store = () => useTaskFilterStore.getState();
const filterButton = () => screen.getByRole('button', { name: /^Filter/ });

beforeEach(() => {
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  vi.clearAllMocks();
  store().reset();
  vi.mocked(api).get.mockResolvedValue({ data: { categories: [], tasks: [], users: [], departments: [] } });
});
afterEach(() => setViewport(original.w, original.h));

describe('the Tasks Filter at desktop width', () => {
  beforeEach(() => setViewport(1280, 720));

  it('lists the same six facets in the same order', async () => {
    renderWithProviders(<TaskFilterTrigger view="list" />);
    await userEvent.click(filterButton());
    const tabs = within(await screen.findByRole('tablist', { name: 'Filter facets' })).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Member', 'Department', 'Category', 'Due', 'Created', 'Only show']);
  });

  it('Member and Department stay one-value selects that read the store', async () => {
    store().setMember('u-alice');
    renderWithProviders(<TaskFilterTrigger view="list" />);
    await userEvent.click(filterButton());

    expect(await screen.findByRole('combobox', { name: 'Member' })).toHaveTextContent('Alice Anderson');
    await userEvent.click(screen.getByRole('tab', { name: /^Department/ }));
    expect(screen.getByRole('combobox', { name: 'Department' })).toHaveTextContent('All departments');
    expect(within(screen.getByRole('tab', { name: /^Member/ })).getByText('1')).toBeInTheDocument();
  });

  it('Only show writes both flags, and the button counts them', async () => {
    renderWithProviders(<TaskFilterTrigger view="list" />);
    await userEvent.click(filterButton());

    await userEvent.click(await screen.findByRole('tab', { name: 'Only show' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Overdue' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'At risk' }));
    expect(store().overdue).toBe(true);
    expect(store().atRisk).toBe(true);
    expect(within(filterButton()).getByText('2')).toBeInTheDocument();
  });

  it('Due keeps its two date fields and writes both ends', async () => {
    renderWithProviders(<TaskFilterTrigger view="list" />);
    await userEvent.click(filterButton());
    await userEvent.click(await screen.findByRole('tab', { name: 'Due' }));
    expect(screen.getByLabelText('Due from')).toBeInTheDocument();
    expect(screen.getByLabelText('Due to')).toBeInTheDocument();
  });
});

describe('the Tasks Filter on a phone', () => {
  beforeEach(() => setViewport(320, 568));

  it('is a bottom sheet: the facet list first, one value list at a time, and no 120 px rail', async () => {
    renderWithProviders(<TaskFilterTrigger view="list" />);
    await userEvent.click(filterButton());

    const sheet = await screen.findByRole('dialog');
    expect(sheet).toHaveAttribute('data-presentation', 'bottom-sheet');
    expect(screen.queryByRole('tablist', { name: 'Filter facets' })).not.toBeInTheDocument();
    for (const name of [/^Member/, /^Department/, /^Category/, /^Due/, /^Created/, /^Only show/]) {
      expect(within(sheet).getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('a pick is a draft until Apply', async () => {
    renderWithProviders(<TaskFilterTrigger view="list" />);
    await userEvent.click(filterButton());
    const sheet = await screen.findByRole('dialog');

    await userEvent.click(within(sheet).getByRole('button', { name: /^Only show/ }));
    await userEvent.click(within(sheet).getByRole('checkbox', { name: 'Overdue' }));
    expect(store().overdue).toBe(false);

    await userEvent.click(within(sheet).getByRole('button', { name: 'Apply' }));
    expect(store().overdue).toBe(true);
  });

  it('Apply with nothing changed leaves the Dashboard drill-down alone', async () => {
    store().setCategory('blocked');
    renderWithProviders(<TaskFilterTrigger view="list" />);
    await userEvent.click(filterButton());
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Apply' }));
    expect(store().category).toBe('blocked');
  });

  it('Clear then Apply clears every facet AND the Dashboard drill-down, as Clear all always did', async () => {
    store().setCategory('blocked');
    store().setMember('u-alice');
    store().setOverdue(true);
    renderWithProviders(<TaskFilterTrigger view="list" />);
    await userEvent.click(filterButton());
    const sheet = await screen.findByRole('dialog');

    await userEvent.click(within(sheet).getByRole('button', { name: 'Clear' }));
    expect(store().memberId).toBe('u-alice'); // still a draft
    await userEvent.click(within(sheet).getByRole('button', { name: 'Apply' }));

    expect(store().memberId).toBe('all');
    expect(store().overdue).toBe(false);
    expect(store().category).toBe('all');
  });

  it('Clear, re-pick a value that was already applied, then Apply keeps the re-picked value', async () => {
    store().setOverdue(true);
    store().setAtRisk(true);
    store().setMember('u-alice');
    renderWithProviders(<TaskFilterTrigger view="list" />);
    await userEvent.click(filterButton());
    const sheet = await screen.findByRole('dialog');

    await userEvent.click(within(sheet).getByRole('button', { name: 'Clear' }));
    await userEvent.click(within(sheet).getByRole('button', { name: /^Only show/ }));
    await userEvent.click(within(sheet).getByRole('checkbox', { name: 'Overdue' }));
    await userEvent.click(within(sheet).getByRole('button', { name: 'Apply' }));

    // Overdue was ticked again, so it survives; the two facets left alone are cleared.
    expect(store().overdue).toBe(true);
    expect(store().atRisk).toBe(false);
    expect(store().memberId).toBe('all');
  });
});
