// The v2 Settings shell at phone width. The side nav is a fixed 224px column,
// which on a 375px phone left a settings page about 86px of room. Below the sm
// breakpoint the side nav is hidden and a compact page picker above the content
// takes its place, built from the same CASL- and entitlement-filtered entries.
// Desktop keeps the side nav unchanged.
//
// jsdom applies no CSS, so the breakpoint behaviour is checked through the
// classes that carry it; the picker itself is driven as a user would.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { buildAbility } from '@/lib/ability';
import SettingsLayout from '@/pages/v2/settings/SettingsLayout';
import { useSettingsBar } from '@/pages/v2/settings/settingsBar';
import { renderWithProviders } from './helpers';

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);

function mockOrg(features: string[]) {
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: {
        id: 'u-1', email: 'admin@test.com', first_name: 'Test', last_name: 'Admin',
        role: 'ADMIN', org_is_demo: true, organization_id: 'org-demo', org_features: features,
      },
      isAuthenticated: true, isLoading: false, error: null,
    })) as never);
}

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

/** A settings page holding an unsaved edit. */
function DirtyPage() {
  const { registerSaver } = useSettingsBar();
  useEffect(() => {
    registerSaver({ save: () => {}, discard: () => {}, isDirty: true });
  }, [registerSaver]);
  return <Where />;
}

function renderShell(start = '/settings/phone-numbers', page = <Where />) {
  return renderWithProviders(
    <Routes>
      <Route path="/settings" element={<SettingsLayout />}>
        <Route path="/settings/phone-numbers" element={page} />
        <Route path="/settings/locations" element={<Where />} />
      </Route>
    </Routes>,
    { ability: ADMIN, initialEntries: [start] },
  );
}

const picker = () => screen.getByRole('combobox', { name: 'Settings page' });

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
  mockOrg(['phone']);
});

describe('Settings shell at phone width', () => {
  it('hides the side nav below sm and shows the page picker only below sm', () => {
    renderShell();

    const sideNav = screen.getByRole('navigation', { name: 'Settings' });
    expect(sideNav).toHaveClass('hidden', 'sm:block');
    // Desktop: the side nav still carries every entry as a link.
    expect(within(sideNav).getByRole('link', { name: 'Caller ID' })).toBeInTheDocument();

    expect(picker().closest('.sm\\:hidden')).not.toBeNull();
    // The picker never sits inside the hidden side nav.
    expect(sideNav.contains(picker())).toBe(false);
  });

  it('shows the current page and moves to the page picked', async () => {
    const user = userEvent.setup();
    renderShell();

    expect(picker()).toHaveTextContent('Caller ID');
    await user.click(picker());
    await user.click(await screen.findByRole('option', { name: 'Locations' }));

    expect(screen.getByTestId('where')).toHaveTextContent('/settings/locations');
  });

  it('offers the same filtered entries as the side nav', async () => {
    // An org without the phone entitlement has no Caller ID entry in either.
    mockOrg([]);
    const user = userEvent.setup();
    renderShell('/settings/locations');

    const sideNav = screen.getByRole('navigation', { name: 'Settings' });
    const sideLabels = within(sideNav).getAllByRole('link').map((a) => a.textContent);
    expect(sideLabels).not.toContain('Caller ID');

    await user.click(picker());
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toEqual(sideLabels);
  });

  it('routes a pick through the unsaved-changes guard', async () => {
    const user = userEvent.setup();
    renderShell('/settings/phone-numbers', <DirtyPage />);

    await user.click(picker());
    await user.click(await screen.findByRole('option', { name: 'Locations' }));

    expect(await screen.findByRole('dialog', { name: 'Discard unsaved changes?' })).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/settings/phone-numbers');
  });
});
