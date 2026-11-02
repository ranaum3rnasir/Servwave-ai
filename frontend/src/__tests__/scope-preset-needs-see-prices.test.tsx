/**
 * Roles & Permissions M4 (ticket 35), Ran's ruling of 2026-10-28 ("builders see prices"): a scope preset is a priced scope, so
 * a person without See prices is never offered one. No "Use preset" button, no picker, no "Save as preset" on the estimate's scope
 * of work, and the picker never draws a false "$0.00" for a price it does not have.
 *
 * The entry points are a source guard: every file that reaches the presets is listed here. A new screen that offers presets is
 * not on the list, so this fails until someone decides who may see it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders, seesPrices } from './helpers';
import { buildAbility } from '@/lib/ability';
import { impossibleOnPurpose } from '@/__tests__/support/backendSwitchCatalog';
import { EstimateScopeOfWorkCard } from '@/components/estimates/EstimateLineItemsEditor';
import type { Scope } from '@/lib/api/jobs';

const mockApi = vi.mocked(api);
const SCOPE: Scope = { id: 'scope-a', title: 'Demo', body: 'Remove old unit.', flat_price: 100, is_taxable: true, internal_cost: null };
const estimate = { id: 'est-1', scopes: [SCOPE] };

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({
    data: {
      presets: [
        { id: 'p1', name: 'Door install', scope_text: 'Install the door', priced: true, price: 120 },
        { id: 'p2', name: 'Hidden price', scope_text: 'A preset whose price the server left out', priced: true },
      ],
    },
  });
});

describe('the estimate scope of work offers presets only to a person who sees prices', () => {
  it('without See prices: no "Use preset", no "Save as preset", and the preset list is never fetched', async () => {
    const noPrices = impossibleOnPurpose(
      buildAbility([{ action: 'update', subject: 'Estimate' }]),
      'PENDING RAN: Edit estimates now needs See prices, so this guard against an editor without prices tests a person no role can hold',
    );
    renderWithProviders(<EstimateScopeOfWorkCard estimate={estimate} canManage canSeePricing={false} />, { ability: noPrices });
    expect(screen.getAllByTestId('scope-block')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /use preset/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/save .*preset/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Scope of Work Presets')).not.toBeInTheDocument();
    expect(mockApi.get).not.toHaveBeenCalledWith('/api/scope-presets', expect.anything());
  });

  it('with See prices: the button is there, the picker lists presets with their price, and a missing price is never drawn as $0.00', async () => {
    renderWithProviders(<EstimateScopeOfWorkCard estimate={estimate} canManage canSeePricing={false} />, { ability: seesPrices });
    await userEvent.click(screen.getByRole('button', { name: /use preset/i }));
    expect(await screen.findByText('Scope of Work Presets')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Door install')).toBeInTheDocument());
    expect(screen.getByText('$120.00')).toBeInTheDocument();
    expect(screen.getByText('Hidden price')).toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('a person who cannot manage the estimate is not offered presets either, with or without prices', () => {
    renderWithProviders(<EstimateScopeOfWorkCard estimate={estimate} canManage={false} canSeePricing={false} />, { ability: seesPrices });
    expect(screen.queryByRole('button', { name: /use preset/i })).not.toBeInTheDocument();
  });
});

describe('every screen that reaches the scope presets (source guard)', () => {
  const SRC = join(__dirname, '..');
  function files(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (name === '__tests__' || name === 'node_modules') continue;
      if (statSync(full).isDirectory()) files(full, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(full);
    }
    return out;
  }

  it('only the estimate scope of work (gated on See prices above) reaches the preset list, the picker and the save call', () => {
    const reach = files(SRC)
      .filter((f) => !f.endsWith('.stories.tsx'))
      .filter((f) => /\/api\/scope-presets|listScopePresets|createScopePreset|ScopePresetPicker/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length + 1))
      .sort();
    expect(reach).toEqual([
      'components/estimates/EstimateLineItemsEditor.tsx', // the one screen: gated on useCanSeePrices
      'features/estimate-workspace/components/ScopePresetPicker.tsx', // the picker itself
      'lib/api/estimates.ts', // the two calls
    ]);
    // The one screen asks for See prices before it offers the picker, the button or the save.
    const editor = readFileSync(join(SRC, 'components/estimates/EstimateLineItemsEditor.tsx'), 'utf8');
    expect(editor).toMatch(/canUsePresets = canManage && seesPrices/);
    expect(editor).toMatch(/\{canUsePresets && \(\s*<ScopePresetPicker/);
  });

  it('the job and invoice scope-of-work cards are never handed a preset handler', () => {
    for (const rel of ['pages', 'components/jobs', 'components/invoices', 'features']) {
      for (const f of files(join(SRC, rel))) {
        if (f.endsWith('ScopeOfWorkCard.tsx') || f.endsWith('EstimateLineItemsEditor.tsx')) continue;
        expect(readFileSync(f, 'utf8'), f).not.toMatch(/onUsePreset=/);
      }
    }
  });
});
