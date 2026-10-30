/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Roles & Permissions, PRD 2, slice S02.24 - the Create New menu follows Create + View.
 *
 * Each item shows only when its Create switch AND its page's View switch are both on: New Lead (Create leads + View
 * leads), New Customer, New Estimate, New Job, New Task, and New Invoice (Standalone invoices + View
 * invoices). The Create switch reaches the screen as a compiled rule; View arrives with the person's
 * own switch answer, so each person below is a custom role described by those two things, never a built-in role name.
 * Switch keys and preset values are read from the backend catalog by the label a person sees, so a renamed switch
 * fails here instead of silently testing nothing.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import api from '@/lib/axios';
import { AbilityProvider } from '@/contexts/AbilityContext';
import { buildAbility, type AbilityRule } from '@/lib/ability';
import { AppShell } from '@/ui-kit/components/layout/appShell';
import { catalogToggle, type PresetRole } from '@/__tests__/support/backendSwitchCatalog';

import { SidebarCreateMenu } from '../SidebarCreateMenu';

vi.mock('@/pages/v2/estimates/components/newEstimateDialog', () => ({ NewEstimateDialog: () => null }));
vi.mock('@/pages/v2/tasks/components/createTaskDialog', () => ({ CreateTaskDialog: () => null }));

const mockApi = vi.mocked(api);

/** One Create New item: the label a person sees, the Create switch behind it, what that switch compiles to, its View. */
const ITEMS = [
  { item: 'New Lead', create: 'Create leads', rule: { action: 'create', subject: 'Lead' }, show: 'View leads' },
  { item: 'New Customer', create: 'Create customers', rule: { action: 'create', subject: 'Customer' }, show: 'View customers' },
  { item: 'New Estimate', create: 'Create estimates', rule: { action: 'create', subject: 'Estimate' }, show: 'View estimates' },
  { item: 'New Job', create: 'Create jobs', rule: { action: 'create', subject: 'Job' }, show: 'View jobs' },
  { item: 'New Task', create: 'Create tasks', rule: { action: 'create', subject: 'Task' }, show: 'View tasks' },
  // The invoice is the standalone one (no job, no estimate), so it follows Standalone invoices, not Create invoices.
  { item: 'New Invoice', create: 'Standalone invoices', rule: { action: 'create_standalone', subject: 'Invoice' }, show: 'View invoices' },
] as const;

type Item = (typeof ITEMS)[number];

/** The rules and the "me" answer of a person whose Create and View switches are exactly `on` (everything else off). */
function personWith(on: ReadonlySet<string>) {
  const values: Record<string, boolean> = {};
  const rules: AbilityRule[] = [];
  for (const entry of ITEMS) {
    values[catalogToggle(entry.create).key] = on.has(entry.create);
    values[catalogToggle(entry.show).key] = on.has(entry.show);
    if (on.has(entry.create)) rules.push(entry.rule as AbilityRule);
  }
  return { values, rules };
}

/** A person holding what a built-in role's preset holds for the Create and View switches, as a custom role. */
function personCopiedFrom(role: PresetRole) {
  const on = new Set<string>();
  for (const entry of ITEMS) {
    for (const label of [entry.create, entry.show]) {
      if (catalogToggle(label).presets[role]) on.add(label);
    }
  }
  return personWith(on);
}

function renderMenu(person: ReturnType<typeof personWith>) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/permission-switches/me') return { data: { admin_box: false, values: person.values, rules: [] } };
    return { data: {} };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AbilityProvider ability={buildAbility(person.rules)}>
        <MemoryRouter>
          <AppShell sidebar={<SidebarCreateMenu />} topbar={<div />}>
            <div />
          </AppShell>
        </MemoryRouter>
      </AbilityProvider>
    </QueryClientProvider>,
  );
}

/**
 * Opens Create New once the person's answer has been drawn, and returns the labels of its items. A witness item (one
 * the person holds in full, never the item under test) only draws after the answer is in, so an item reported ABSENT
 * is read from a menu that was drawn from the answer rather than from the pre-answer paint.
 */
async function openedItems(witness: Item): Promise<string[]> {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Create New' }));
  await screen.findByRole('menuitem', { name: witness.item });
  return screen.getAllByRole('menuitem').map((el) => el.textContent ?? '');
}

const everythingFor = (entry: Item) => [entry.create, entry.show];

describe('Create New follows Create + View (S02.24)', () => {
  beforeEach(() => {
    localStorage.clear();
    mockApi.get.mockReset();
  });

  describe.each(ITEMS)('$item', (entry) => {
    const witness = ITEMS.find((other) => other.item !== entry.item)!;

    it.each([
      ['Create and View both on', true, true, true],
      ['Create on, View off', true, false, false],
      ['Create off, View on', false, true, false],
      ['Create and View both off', false, false, false],
    ])('%s: item shown is %s', async (_name, createOn, showOn, shown) => {
      const on = new Set<string>(everythingFor(witness));
      if (createOn) on.add(entry.create);
      if (showOn) on.add(entry.show);
      renderMenu(personWith(on));

      const items = await openedItems(witness);

      expect(items.includes(entry.item)).toBe(shown);
    });
  });

  it('draws no Create New button for a person with every item closed', async () => {
    renderMenu(personWith(new Set()));
    // Wait for the answer to land (it is requested once), then the button must still be absent.
    await vi.waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/permission-switches/me'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('button', { name: 'Create New' })).not.toBeInTheDocument();
  });

  it('draws nothing until the answer arrives: Create on alone is not enough for the first paint', async () => {
    const person = personWith(new Set(ITEMS.map((entry) => entry.create)));
    let release: (value: unknown) => void = () => {};
    mockApi.get.mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AbilityProvider ability={buildAbility(person.rules)}>
          <MemoryRouter>
            <AppShell sidebar={<SidebarCreateMenu />} topbar={<div />}>
              <div />
            </AppShell>
          </MemoryRouter>
        </AbilityProvider>
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Create New' })).not.toBeInTheDocument();
    release({ data: { admin_box: false, values: person.values, rules: [] } });
  });

  describe('with the built-in roles\' starting values', () => {
    it('the Dispatcher values show New Customer and New Invoice: it can create both and opens both pages', async () => {
      const dispatcher = personCopiedFrom('DISPATCHER');
      // The sidebar follows View, so the pages a Dispatcher opens are the ones it has View on (P1).
      expect(dispatcher.values[catalogToggle('Create customers').key]).toBe(true);
      expect(dispatcher.values[catalogToggle('View customers').key]).toBe(true);
      expect(dispatcher.values[catalogToggle('Standalone invoices').key]).toBe(true);
      expect(dispatcher.values[catalogToggle('View invoices').key]).toBe(true);
      renderMenu(dispatcher);

      const items = await openedItems(ITEMS[0]);

      expect(items).toEqual(expect.arrayContaining(['New Customer', 'New Invoice', 'New Lead', 'New Estimate', 'New Job', 'New Task']));
    });

    it('the Technician values show no New Customer', async () => {
      const technician = personCopiedFrom('TECHNICIAN');
      expect(technician.values[catalogToggle('Create customers').key]).toBe(false);
      renderMenu(technician);

      const items = await openedItems(ITEMS.find((entry) => entry.item === 'New Estimate')!);

      expect(items).not.toContain('New Customer');
    });

    it('the Admin values show every item', async () => {
      renderMenu(personCopiedFrom('ADMIN'));

      const items = await openedItems(ITEMS[0]);

      expect(items).toEqual(ITEMS.map((entry) => entry.item));
    });
  });
});
