/**
 * Roles & Permissions, PRD 8, S08.17 - the Communication pages follow their Show switches by address.
 *
 * Renders the REAL routed table (`moduleV2Routes`) with the REAL section guard, the REAL plan check and the REAL
 * switch check; only the app chrome, the sign-in guard and the pages themselves are stubbed. The person holds the
 * section ability and the switches under test (the "me" answer), so the only thing deciding where they end up is the
 * route's own guard. Switch keys are looked up in the backend catalog by the label a person sees.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Suspense } from 'react';
import { screen } from '@testing-library/react';
import { Outlet, Routes, Route, useLocation } from 'react-router-dom';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { moduleV2Routes } from '@/pages/v2/routes';
import { communicationSectionAbility, renderWithProviders } from './helpers';
import { catalogToggle } from './support/backendSwitchCatalog';
import { buildAbility } from '@/lib/ability';

vi.mock('@/components/ProtectedRoute', () => ({ default: () => <Outlet /> }));
vi.mock('@/components/DemoOnlyRoute', () => ({ default: () => <Outlet /> }));
vi.mock('@/pages/v2/V2AppLayout', () => ({ default: () => <Outlet /> }));

const stub = vi.hoisted(() => async () => {
  const { createElement } = await import('react');
  const { useLocation } = await import('react-router-dom');
  const Opened = () => createElement('p', { 'data-testid': 'opened' }, useLocation().pathname);
  return { default: Opened };
});
vi.mock('@/pages/v2/communication/PhonePage', stub);
vi.mock('@/pages/v2/communication/TextPage', stub);
vi.mock('@/pages/v2/communication/InboxPage', stub);
vi.mock('@/pages/v2/communication/WhatsAppPage', stub);
vi.mock('@/pages/v2/communication/PhoneTabPage', stub);
vi.mock('@/pages/v2/auth-public/UpgradePage', async () => {
  const { createElement } = await import('react');
  const { useLocation } = await import('react-router-dom');
  const Upgrade = () => createElement('p', { 'data-testid': 'upgrade' }, new URLSearchParams(useLocation().search).get('feature'));
  return { default: Upgrade };
});
vi.mock('@/pages/v2/dashboard/DashboardPage', async () => {
  const { createElement } = await import('react');
  return { default: () => createElement('h1', null, 'Dashboard') };
});

const mockApi = vi.mocked(api);

const key = (label: string) => catalogToggle(label).key;

function signIn(features: string[]) {
  const state = {
    isAuthenticated: true,
    isLoading: false,
    user: { id: 'u1', role: 'ADMIN', organization_id: 'org1', org_features: features },
  };
  vi.mocked(useAuthStore).mockImplementation(((selector?: (s: typeof state) => unknown) =>
    selector ? selector(state) : state) as never);
}

function open(path: string, values: Record<string, boolean>, ability = communicationSectionAbility()) {
  mockApi.get.mockImplementation((url: string) =>
    url === '/api/permission-switches/me'
      ? Promise.resolve({ data: { admin_box: false, values, rules: [] } })
      : Promise.resolve({ data: {} }));
  return renderWithProviders(
    <Suspense fallback={null}>
      <Where />
      <Routes>
        {moduleV2Routes()}
        <Route path="*" element={<p>Nothing here</p>} />
      </Routes>
    </Suspense>,
    { initialEntries: [path], ability },
  );
}

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

const dashboard = () => screen.findByRole('heading', { name: 'Dashboard' });
const where = () => screen.getByTestId('where').textContent;

/** The three pages and the Show switch that opens each, with the addresses that reach them. */
const PAGES = [
  { name: 'Phone', show: 'Show Phone', paths: ['/communication/phone', '/communication/phone/numbers'] },
  { name: 'Text', show: 'Show Text', paths: ['/communication/text', '/communication/text/settings'] },
  { name: 'Email', show: 'Show Email', paths: ['/communication/inbox'] },
];
const SHOWS = PAGES.map((p) => key(p.show));
const allShown = Object.fromEntries(SHOWS.map((k) => [k, true]));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  signIn(['phone', 'email']);
});

describe.each(PAGES)('the $name page', ({ show, paths }) => {
  describe.each(paths)('%s', (path) => {
    it('opens with its Show switch on', async () => {
      open(path, { [key('Access Communication')]: true, ...allShown });

      expect(await screen.findByTestId('opened')).toHaveTextContent(path);
      expect(screen.queryByRole('heading', { name: 'Dashboard' })).toBeNull();
    });

    it('goes to the dashboard with its Show switch off, the other two Show switches still on', async () => {
      open(path, { [key('Access Communication')]: true, ...allShown, [key(show)]: false });

      expect(await dashboard()).toBeInTheDocument();
      expect(where()).toBe('/');
      expect(screen.queryByTestId('opened')).toBeNull();
    });
  });
});

describe('a Show switch only closes its own page', () => {
  it('keeps the Text page open for a person with Show Phone off', async () => {
    open('/communication/text', { ...allShown, [key('Show Phone')]: false });

    expect(await screen.findByTestId('opened')).toHaveTextContent('/communication/text');
  });

  it('keeps the Phone page open for a person with Show Text off', async () => {
    open('/communication/phone', { ...allShown, [key('Show Text')]: false });

    expect(await screen.findByTestId('opened')).toHaveTextContent('/communication/phone');
  });
});

describe('the section gate and the plan check stay on top of the Show switches', () => {
  it('sends a person without the section ability to the dashboard whatever their Show switches say', async () => {
    open('/communication/phone', allShown, buildAbility([{ action: 'read', subject: 'Communication' }]));

    expect(await dashboard()).toBeInTheDocument();
    expect(screen.queryByTestId('opened')).toBeNull();
  });

  it('sends a company without the phone feature to the upgrade page, not the dashboard, for the Phone and Text pages', async () => {
    signIn(['email']);
    open('/communication/text', allShown);

    expect(await screen.findByTestId('upgrade')).toHaveTextContent('phone');
    expect(where()).toBe('/upgrade');
    expect(screen.queryByTestId('opened')).toBeNull();
  });
});
