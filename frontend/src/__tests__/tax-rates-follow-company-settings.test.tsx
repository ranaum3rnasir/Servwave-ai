/**
 * Roles & Permissions, PRD 7, S07.22 - tax rates load on the estimate and invoice forms for anyone who can open
 * them, and the tax setup (the Tax Rates settings page, adding a rate from a picker) stays with Company settings.
 *
 * The settings half renders the REAL routed settings table (`settingsV2Routes`) and the real Settings shell, with
 * only the app chrome stubbed. The forms half renders the routed estimate receipt card, the shared tax picker.
 * Every person is a custom role built from the rules their switches compile into, never a built-in role name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Suspense } from 'react';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Outlet, Routes, Route } from 'react-router-dom';
import api from '@/lib/axios';
import { buildAbility, type AppAbility } from '@/lib/ability';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { useAuthStore } from '@/stores/auth.store';
import { settingsV2Routes } from '@/pages/v2/routes/settings.routes';
import { EstimateReceiptCard, type EstimateReceiptCardEstimate } from '@/components/estimates/EstimateReceiptCard';
import { renderWithProviders } from './helpers';

vi.mock('@/components/ProtectedRoute', () => ({ default: () => <Outlet /> }));
vi.mock('@/pages/v2/V2AppLayout', () => ({ default: () => <Outlet /> }));
vi.mock('@/pages/v2/settings/CompanyProfilePage', () => ({ default: () => <p role="heading" aria-level={2}>Company page</p> }));
vi.mock('@/pages/v2/settings/MyProfilePage', () => ({ default: () => <p role="heading" aria-level={2}>My profile page</p> }));

const mockApi = vi.mocked(api);

const BOSTON = { id: 'otr-ma', name: 'Boston combined', state_code: 'MA', rate: 0.0825, is_visible: true, created_at: '', updated_at: '' };

/** Create estimates and View estimates on (they can open the form), Company settings off. */
const formUser: AppAbility = buildAbility([
  { action: 'read', subject: 'Organization' },
  { action: 'read', subject: 'Estimate' },
  { action: 'create', subject: 'Estimate' },
  // Create estimates needs Edit estimates and See prices.
  { action: 'update', subject: 'Estimate' },
  { action: 'send', subject: 'Estimate' },
  { action: 'cancel', subject: 'Estimate' },
  { action: 'revise', subject: 'Estimate' },
  { action: 'read', subject: 'Prices' },
]);

/** The same, with Company settings on (the compiled rule is update Organization). */
const settingsHolder: AppAbility = buildAbility([
  { action: 'read', subject: 'Organization' },
  { action: 'update', subject: 'Organization' },
  { action: 'read', subject: 'Estimate' },
  { action: 'create', subject: 'Estimate' },
  // Create estimates needs Edit estimates and See prices.
  { action: 'update', subject: 'Estimate' },
  { action: 'send', subject: 'Estimate' },
  { action: 'cancel', subject: 'Estimate' },
  { action: 'revise', subject: 'Estimate' },
  { action: 'read', subject: 'Prices' },
]);

function serve() {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/org-tax-rates') return Promise.resolve({ data: { rates: [BOSTON] } });
    // The picker feed the forms read: the org's visible rates, merged with the national list.
    if (url === '/api/state-tax-rates') return Promise.resolve({ data: [{ id: 'otr-ma', state_code: 'MA', state_name: 'Boston combined', tax_rate: 0.0825 }] });
    if (url === '/api/permission-switches/me') return Promise.resolve({ data: { admin_box: false, values: {}, rules: [] } });
    return Promise.resolve({ data: [] });
  });
}

function openSettings(path: string, ability: AppAbility) {
  serve();
  // Setting up the company is the Admin flag's alone (36b, M17): the person who holds the old update rule here is the Admin.
  const isAdmin = ability.can('update', 'Organization');
  vi.mocked(useAuthStore).mockImplementation(((selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      user: { id: '00000000-0000-0000-0000-000000000001', email: 'p@test.com', first_name: 'Test', last_name: 'Person', role: 'DISPATCHER', is_admin: isAdmin },
      isAuthenticated: true, isLoading: false, error: null,
    })) as never);
  return renderWithProviders(
    <Suspense fallback={null}>
      <Routes>
        {settingsV2Routes()}
        <Route path="*" element={<p role="heading" aria-level={1}>Dashboard</p>} />
      </Routes>
    </Suspense>,
    { initialEntries: [path], ability },
  );
}

const calledUrls = () => mockApi.get.mock.calls.map((c) => c[0] as string);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
});

describe('the Tax Rates settings page follows Company settings', () => {
  it('draws no Tax Rates tab for a person without it', async () => {
    openSettings('/settings/profile', formUser);
    const nav = await screen.findByRole('navigation', { name: 'Settings' });
    expect(await within(nav).findByRole('link', { name: 'My Profile' })).toBeInTheDocument();

    expect(within(nav).queryByRole('link', { name: 'Tax Rates' })).toBeNull();
  });

  it('refuses the page to a person who types its address, and never asks for the rates list', async () => {
    openSettings('/settings/tax-rates', formUser);

    // The address renders nothing for anyone who is not an Admin: no page, no no-access pane, no reads.
    await screen.findByRole('navigation', { name: 'Settings' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(screen.queryByText(/Your organization.s tax rates/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Add rate/ })).toBeNull();
    expect(calledUrls()).not.toContain('/api/org-tax-rates');
  });

  it('shows the tab and the full page, with its Add rate control, to a person who holds it', async () => {
    openSettings('/settings/tax-rates', settingsHolder);

    expect(await screen.findByText(/Your organization.s tax rates/)).toBeInTheDocument();
    expect(await screen.findByText('Boston combined')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add rate/ })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    expect(within(nav).getByRole('link', { name: 'Tax Rates' })).toHaveAttribute('href', '/settings/tax-rates');
  });
});

describe('tax rates on the estimate form', () => {
  const estimate: EstimateReceiptCardEstimate = {
    id: 'est-1', subtotal: 100, discount_amount: 0, discount_type: null, discount_value: null, discount_name: null,
    tax_rate: 0.0825, tax_amount: 8.25, total_amount: 108.25, deposit_type: null, deposit_value: null,
    send_config: null, line_items: [], scopes: [], job_id: null,
  };

  async function openPicker(ability: AppAbility) {
    serve();
    renderWithProviders(<EstimateReceiptCard estimate={estimate} canEditNow />, { ability });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: 'Tax jurisdiction' }));
    return screen.findByRole('listbox');
  }

  it('loads the org rates for a person without Company settings, with the totals shown', async () => {
    const list = await openPicker(formUser);

    expect(within(list).getByRole('option', { name: /Boston combined/ })).toBeInTheDocument();
    expect(calledUrls()).toContain('/api/state-tax-rates');
  });

  it('offers no "+ Add tax rate" row to a person without Company settings, since adding a rate is tax setup', async () => {
    const list = await openPicker(formUser);

    expect(within(list).queryByRole('option', { name: '+ Add tax rate' })).toBeNull();
  });

  it('offers the "+ Add tax rate" row to a person who holds Company settings', async () => {
    const list = await openPicker(settingsHolder);

    expect(within(list).getByRole('option', { name: '+ Add tax rate' })).toBeInTheDocument();
  });
});
