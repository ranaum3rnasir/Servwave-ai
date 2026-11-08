// Inventory P1 §7 — Settings → Inventory (org stock policy).
//
// Contract under test (follows the settings-locations.test.tsx harness):
//   • The page renders the org's current values off GET /api/organization.
//   • Saving PATCHes ONLY the dirty keys — flipping the Block-negative-stock switch sends
//     exactly { block_negative_stock: true }; picking a default location sends exactly
//     { default_inventory_location_id }.
//   • The SettingsLayout nav entry is gated on `update Organization`.
//
// The location options come through the inventory seam, mocked stable (jsdom seed-loop
// landmine — see purchase-orders-deeplink.test.tsx, the sanctioned pattern).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router-dom';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import SettingsLayout from '@/pages/settings/SettingsLayout';
import InventorySettingsPage from '@/pages/settings/InventorySettingsPage';
import { buildAbility } from '@/lib/ability';

const h = vi.hoisted(() => ({
  LOC_MAIN: 'aaaaaaa1-0000-4000-8000-000000000001',
}));

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const locations = [
    { id: h.LOC_MAIN, name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' },
  ];
  return {
    ...actual,
    useLocations: () => ({ data: locations, isLoading: false, isError: false }),
  };
});

const mockApi = vi.mocked(api);

const ORG = {
  id: 'org-1',
  name: 'ServWave Test Co',
  default_inventory_location_id: null as string | null,
  block_negative_stock: false,
};

const orgAdminAbility = () =>
  buildAbility([
    { action: 'read', subject: 'Organization' },
    { action: 'update', subject: 'Organization' },
  ]);

function renderSettingsInventory(ability = orgAdminAbility()) {
  return renderWithProviders(
    <Routes>
      <Route path="/settings" element={<SettingsLayout />}>
        <Route path="inventory" element={<InventorySettingsPage />} />
      </Route>
    </Routes>,
    { initialEntries: ['/settings/inventory'], ability },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/organization') return { data: { ...ORG } };
    return { data: {} };
  });
  mockApi.patch.mockResolvedValue({ data: { ...ORG } });
});

describe('SettingsLayout — Inventory nav entry gating', () => {
  it('shows the Inventory entry for an ability with update Organization', async () => {
    renderSettingsInventory();

    expect(await screen.findByRole('link', { name: 'Inventory' })).toBeInTheDocument();
  });

  it('hides the Inventory entry when the ability lacks update Organization', async () => {
    renderSettingsInventory(buildAbility([{ action: 'read', subject: 'Organization' }]));

    // The read-only Organization entries (e.g. Company Profile) still render — the
    // update-gated Inventory one must not.
    expect(await screen.findByRole('link', { name: 'Company Profile' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Inventory' })).toBeNull();
  });
});

describe('InventorySettingsPage — dirty-only PATCH (Inventory P1 §7)', () => {
  it('renders the org values (switch off, no default location)', async () => {
    renderSettingsInventory();

    const toggle = await screen.findByRole('switch', { name: 'Block negative stock' });
    expect(toggle).toHaveAttribute('data-state', 'unchecked');
    expect(
      screen.getByText('Pre-selected when receiving stock and deducting job/invoice items.'),
    ).toBeInTheDocument();
  });

  it('flipping Block negative stock + Save PATCHes exactly { block_negative_stock: true }', async () => {
    renderSettingsInventory();

    await userEvent.click(await screen.findByRole('switch', { name: 'Block negative stock' }));
    const save = screen.getByRole('button', { name: 'Save Changes' });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalled());
    const [url, body] = mockApi.patch.mock.calls[0]!;
    expect(url).toBe('/api/organization');
    // Dirty-only: the untouched default_inventory_location_id must NOT ride along.
    expect(body).toEqual({ block_negative_stock: true });
  });

  it('picking a default location + Save PATCHes exactly { default_inventory_location_id }', async () => {
    renderSettingsInventory();

    await userEvent.click(
      await screen.findByRole('combobox', { name: 'Default inventory location' }),
    );
    await userEvent.click(await screen.findByText('Main Warehouse'));

    const save = screen.getByRole('button', { name: 'Save Changes' });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalled());
    const [url, body] = mockApi.patch.mock.calls[0]!;
    expect(url).toBe('/api/organization');
    expect(body).toEqual({ default_inventory_location_id: h.LOC_MAIN });
  });
});

// --- FormField adoption (phase 11b) ------------------------------------------------
//
// The stock-policy location field renders through the FormField pattern. Two things
// are pinned, at the same rigor as components/patterns/__tests__/FormField.test.tsx.
//
//   1. THE WIRING, which is the whole reason the pattern exists. Before this
//      conversion the <Label> here carried NO htmlFor at all: it was one of the
//      unwired labels in the a11y backlog. FormField generates a single id via
//      useId and the call site hands it to the SelectTrigger through the
//      render-prop child (the radix Select ROOT renders no DOM and would swallow
//      it), so the label's `for`, the trigger's `id` and the hint's
//      `aria-describedby` are one fact rather than three hand-typed literals.
//   2. THE RENDERED CLASS STRINGS, byte-exact, because this is a structural
//      refactor with no intended visual change: the wrapper's `space-y-1.5`
//      became Stack's `gap-1.5` (the same 6px), and the hint paragraph's
//      `text-xs text-text-secondary` is reproduced exactly by `Text as="p"
//      size="xs" tone="secondary"` - which is what lets the pattern satisfy the
//      components/patterns appearance ceiling of 0 without moving a pixel.
describe('InventorySettingsPage - FormField adoption (phase 11b)', () => {
  const HINT = 'Pre-selected when receiving stock and deducting job/invoice items.';

  it('wires one generated id across label, Select trigger and hint', async () => {
    renderSettingsInventory();

    const trigger = await screen.findByRole('combobox', { name: 'Default inventory location' });
    const label = screen.getByText('Default inventory location', { selector: 'label' });
    const hint = screen.getByText(HINT);

    expect(trigger.id).toBeTruthy();
    expect(label).toHaveAttribute('for', trigger.id);
    expect(hint).toHaveAttribute('id', `${trigger.id}-hint`);
    expect(trigger).toHaveAttribute('aria-describedby', `${trigger.id}-hint`);
    // No error is passed, so the pattern must not assert a validity state.
    expect(trigger).not.toHaveAttribute('aria-invalid');
    // The trigger's own aria-label still wins the accessible name, unchanged.
    expect(trigger).toHaveAttribute('aria-label', 'Default inventory location');
  });

  it('renders the pattern markup byte-exactly, and keeps the trigger width override', async () => {
    renderSettingsInventory();

    const trigger = await screen.findByRole('combobox', { name: 'Default inventory location' });
    const label = screen.getByText('Default inventory location', { selector: 'label' });

    expect(label.parentElement?.getAttribute('class')).toBe('flex flex-col gap-1.5');
    expect(screen.getByText(HINT).getAttribute('class')).toBe('text-xs text-text-secondary');
    expect(label.getAttribute('class')).toBe(
      'text-sm leading-none transition-colors duration-300 hover:text-text-primary ' +
        'has-[+input:is(:hover,:focus)]:text-text-primary ' +
        'has-[+textarea:is(:hover,:focus)]:text-text-primary ' +
        'peer-disabled:cursor-not-allowed peer-disabled:opacity-70 text-text-secondary font-bold',
    );
    // The call site's layout override survives the fieldProps spread.
    expect(trigger).toHaveClass('w-full', 'max-w-sm');
  });
});
