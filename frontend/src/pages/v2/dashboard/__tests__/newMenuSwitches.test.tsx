/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Roles & Permissions, PRD 2, slice S02.25 - the dashboard's "New" menu follows the same Create + View pair as Create
 * New (S02.24). New Lead, New Estimate, New Job, New Task and New Invoice (Standalone invoices) each need their Create
 * switch AND their page's View switch; Request Payment creates nothing, so it follows View invoices alone. With no
 * item left the "New" button is not drawn.
 *
 * The Create switch reaches the screen as a compiled rule; View arrives with the person's own
 * switch answer, so each person below is a custom role described by those switches, never a built-in role name. Switch
 * keys and preset values are read from the backend catalog by the label a person sees, so a renamed switch fails here
 * instead of silently testing nothing.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import api from '@/lib/axios';
import { buildAbility, type AbilityRule } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import { catalogToggle, type PresetRole } from '@/__tests__/support/backendSwitchCatalog';

import { NewMenu } from '../components/newMenu';

vi.mock('@/components/estimates/NewEstimateDialog', () => ({ NewEstimateDialog: () => null }));

const mockApi = vi.mocked(api);

/** One menu item: the label a person sees, the Create switch behind it (none for Request Payment), what it compiles to, its View. */
const ITEMS = [
  { item: 'New Lead', create: 'Create leads', rule: { action: 'create', subject: 'Lead' }, show: 'View leads' },
  { item: 'New Estimate', create: 'Create estimates', rule: { action: 'create', subject: 'Estimate' }, show: 'View estimates' },
  { item: 'New Job', create: 'Create jobs', rule: { action: 'create', subject: 'Job' }, show: 'View jobs' },
  { item: 'New Task', create: 'Create tasks', rule: { action: 'create', subject: 'Task' }, show: 'View tasks' },
  // The invoice is the standalone one (no job, no estimate), so it follows Standalone invoices, not Create invoices.
  { item: 'New Invoice', create: 'Standalone invoices', rule: { action: 'create_standalone', subject: 'Invoice' }, show: 'View invoices' },
  // Creates nothing: it only needs the invoices page it opens.
  { item: 'Request Payment', create: null, rule: null, show: 'View invoices' },
] as const;

type Item = (typeof ITEMS)[number];

/** The rules and the "me" answer of a person whose Create and View switches are exactly `on` (everything else off). */
function personWith(on: ReadonlySet<string>) {
  const values: Record<string, boolean> = {};
  const rules: AbilityRule[] = [];
  for (const entry of ITEMS) {
    if (entry.create) values[catalogToggle(entry.create).key] = on.has(entry.create);
    values[catalogToggle(entry.show).key] = on.has(entry.show);
    if (entry.create && on.has(entry.create)) rules.push(entry.rule as AbilityRule);
  }
  return { values, rules };
}

/** A person holding what a built-in role's preset holds for every Create and Show switch above, as a custom role. */
function personCopiedFrom(role: PresetRole) {
  const on = new Set<string>();
  for (const entry of ITEMS) {
    for (const label of [entry.create, entry.show]) {
      if (label && catalogToggle(label).presets[role]) on.add(label);
    }
  }
  return personWith(on);
}

function renderMenu(person: ReturnType<typeof personWith>) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/permission-switches/me') return { data: { admin_box: false, values: person.values, rules: [] } };
    return { data: {} };
  });
  return renderWithProviders(<NewMenu />, { ability: buildAbility(person.rules) });
}

/**
 * Opens the "New" menu once the person's answer has been drawn, and returns the labels of its items. A witness item
 * (one the person holds in full, never the item under test) only draws after the answer is in, so an item reported
 * ABSENT is read from a menu that was drawn from the answer rather than from the pre-answer paint.
 */
async function openedItems(witness: Item): Promise<string[]> {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'New' }));
  await screen.findByRole('menuitem', { name: witness.item });
  return screen.getAllByRole('menuitem').map((el) => el.textContent ?? '');
}

const everythingFor = (entry: Item): string[] => (entry.create === null ? [entry.show] : [entry.create, entry.show]);

describe('the dashboard "New" menu follows Create + View (S02.25)', () => {
  beforeEach(() => {
    localStorage.clear();
    mockApi.get.mockReset();
  });

  describe.each(ITEMS.filter((entry) => entry.create !== null))('$item', (entry) => {
    const witness = ITEMS.find((other) => other.item !== entry.item && other.show !== entry.show)!;

    it.each([
      ['Create and View both on', true, true, true],
      ['Create on, View off', true, false, false],
      ['Create off, View on', false, true, false],
      ['Create and View both off', false, false, false],
    ])('%s: item shown is %s', async (_name, createOn, showOn, shown) => {
      const on = new Set<string>(everythingFor(witness));
      if (createOn) on.add(entry.create!);
      if (showOn) on.add(entry.show);
      renderMenu(personWith(on));

      const items = await openedItems(witness);

      expect(items.includes(entry.item)).toBe(shown);
    });
  });

  describe('Request Payment (creates nothing, so it follows View invoices alone)', () => {
    const witness = ITEMS[0];

    it('shows with View invoices on and no Create switch at all', async () => {
      renderMenu(personWith(new Set([...everythingFor(witness), 'View invoices'])));

      const items = await openedItems(witness);

      expect(items).toContain('Request Payment');
      expect(items).not.toContain('New Invoice');
    });

    it('is missing with View invoices off, even with Standalone invoices on', async () => {
      renderMenu(personWith(new Set([...everythingFor(witness), 'Standalone invoices'])));

      const items = await openedItems(witness);

      expect(items).not.toContain('Request Payment');
      expect(items).not.toContain('New Invoice');
    });
  });

  it('draws no "New" button for a person with every item closed', async () => {
    renderMenu(personWith(new Set()));
    // Wait for the answer to land (it is requested once), then the button must still be absent.
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/permission-switches/me'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('button', { name: 'New' })).not.toBeInTheDocument();
  });

  it('draws nothing until the answer arrives: Create on alone is not enough for the first paint', async () => {
    const person = personWith(new Set(ITEMS.flatMap((entry) => (entry.create ? [entry.create] : []))));
    mockApi.get.mockImplementation(() => new Promise(() => {}));
    renderWithProviders(<NewMenu />, { ability: buildAbility(person.rules) });
    expect(screen.queryByRole('button', { name: 'New' })).not.toBeInTheDocument();
  });

  describe("with the built-in roles' starting values", () => {
    it('the Dispatcher values show New Invoice and Request Payment: it can create standalone invoices and has View invoices', async () => {
      const dispatcher = personCopiedFrom('DISPATCHER');
      // The menu follows View, so the pages a Dispatcher opens are the ones it has View on (P1).
      expect(dispatcher.values[catalogToggle('Standalone invoices').key]).toBe(true);
      expect(dispatcher.values[catalogToggle('View invoices').key]).toBe(true);
      renderMenu(dispatcher);

      const items = await openedItems(ITEMS[0]);

      expect(items).toEqual(expect.arrayContaining(['New Invoice', 'Request Payment', 'New Lead', 'New Estimate', 'New Job', 'New Task']));
    });

    it('the Admin values show every item, in the menu\'s order', async () => {
      renderMenu(personCopiedFrom('ADMIN'));

      const items = await openedItems(ITEMS[0]);

      expect(items).toEqual(ITEMS.map((entry) => entry.item));
    });
  });
});
