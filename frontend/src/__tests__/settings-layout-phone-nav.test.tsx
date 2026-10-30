// The v2 Settings shell at phone and tablet width. The side nav is a fixed 224px column,
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

/** A settings page with a saver but nothing to save yet, so the shell draws its Save bar. */
function SaverPage() {
  const { registerSaver } = useSettingsBar();
  useEffect(() => {
    registerSaver({ save: () => {}, discard: () => {}, isDirty: false });
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
  // Mobile slice 29: below lg the side nav no longer fits either. On an iPad (768) or a phone
  // on its side (838) the app sidebar plus this 224 px column left a settings page about 260 px,
  // which pushed the header strip's Close past the right edge. The picker covers sm to lg too.
  it('hides the side nav below lg and shows the page picker only below lg', () => {
    renderShell();

    const sideNav = screen.getByRole('navigation', { name: 'Settings' });
    expect(sideNav).toHaveClass('hidden', 'lg:block');
    expect(sideNav).not.toHaveClass('sm:block');
    // Desktop: the side nav still carries every entry as a link.
    expect(within(sideNav).getByRole('link', { name: 'Caller ID' })).toBeInTheDocument();

    expect(picker().closest('.lg\\:hidden')).not.toBeNull();
    expect(picker().closest('.sm\\:hidden')).toBeNull();
    // The picker never sits inside the hidden side nav.
    expect(sideNav.contains(picker())).toBe(false);
  });

  it('lets the header strip wrap so Save and Close stay on screen', async () => {
    renderShell('/settings/phone-numbers', <SaverPage />);
    const save = await screen.findByRole('button', { name: 'Save Changes' });
    const close = screen.getByRole('button', { name: 'Close settings' });
    const actions = save.parentElement!;
    expect(actions).toBe(close.parentElement);
    expect(actions.parentElement).toHaveClass('flex-wrap');
    expect(actions).toHaveClass('flex-wrap');
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
