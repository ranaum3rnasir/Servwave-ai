import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { buildAbility } from '@/lib/ability';
import SettingsLayout from '@/pages/v2/settings/SettingsLayout';
import { renderWithProviders } from './helpers';

const allowAll = buildAbility([{ action: 'manage', subject: 'all' }]);

function renderAt(path: string) {
  // The shell reads the person's own switches (Users & Teams follows one), so it needs a query client.
  return renderWithProviders(
    <Routes>
      <Route path="/settings" element={<SettingsLayout />}>
        <Route path="branding" element={<div>branding</div>} />
        <Route path="payout-account" element={<div>payout</div>} />
      </Route>
    </Routes>,
    { ability: allowAll, initialEntries: [path] },
  );
}

describe('Settings shell save bar on the payout account page', () => {
  it('shows no Discard / Save Changes on the payout account page (nothing there is editable)', async () => {
    renderAt('/settings/payout-account');
    await screen.findByText('payout');
    expect(screen.queryByRole('button', { name: 'Save Changes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close settings' })).toBeTruthy();
  });

  it('still shows them on an editable page', async () => {
    renderAt('/settings/branding');
    await screen.findByText('branding');
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeTruthy();
  });
});
