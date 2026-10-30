import { describe, it, expect } from 'vitest';
import { useEffect } from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route, Link } from 'react-router-dom';
import { buildAbility } from '@/lib/ability';
import SettingsLayout from '@/pages/v2/settings/SettingsLayout';
import { useSettingsBar } from '@/pages/v2/settings/settingsBar';
import { renderWithProviders } from './helpers';

const allowAll = buildAbility([{ action: 'manage', subject: 'all' }]);

/** A page that registers a saver, the way Branding, Company and Phone & SMS do. */
function EditablePage() {
  const { registerSaver } = useSettingsBar();
  useEffect(() => {
    registerSaver({ save: () => {}, discard: () => {}, isDirty: false });
  }, [registerSaver]);
  return (
    <div>
      editable
      <Link to="/settings/lists">go to lists</Link>
    </div>
  );
}

/** A page that registers nothing (Lists: every change saves on its own). */
function NoSaverPage() {
  return <div>no saver</div>;
}

function renderAt(path: string) {
  // The shell reads the person's own switches (Users & Teams follows one), so it needs a query client.
  return renderWithProviders(
    <Routes>
      <Route path="/settings" element={<SettingsLayout />}>
        <Route path="branding" element={<EditablePage />} />
        <Route path="lists" element={<NoSaverPage />} />
      </Route>
    </Routes>,
    { ability: allowAll, initialEntries: [path] },
  );
}

// V7-01a save-bar choice: the bar is hidden until the current page has registered a saver (it appears right after the
// page's first effect, so an editable page shows it with no flicker afterwards), and it is hidden for good on a page
// that never registers. A saver is remembered with its address, so it is never inherited by the next page.
describe('Settings shell save bar follows the page that registered a saver', () => {
  it('shows no Discard / Save Changes on a page that registers no saver', async () => {
    renderAt('/settings/lists');
    await screen.findByText('no saver');
    expect(screen.queryByRole('button', { name: 'Save Changes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close settings' })).toBeTruthy();
  });

  it('shows them on an editable page once it has loaded', async () => {
    renderAt('/settings/branding');
    await screen.findByText('editable');
    expect(await screen.findByRole('button', { name: 'Save Changes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeTruthy();
  });

  it('does not carry the previous page\'s bar over to a page that registers none', async () => {
    const user = userEvent.setup();
    renderAt('/settings/branding');
    await screen.findByRole('button', { name: 'Save Changes' });
    await user.click(screen.getByRole('link', { name: 'go to lists' }));
    await screen.findByText('no saver');
    expect(screen.queryByRole('button', { name: 'Save Changes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
  });
});
