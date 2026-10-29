/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AbilityProvider } from '@/contexts/AbilityContext';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import { useAiCenterStore } from '@/stores/aiCenterStore';
import Sidebar from '../Sidebar';

// Full-access ability (admin superuser: `manage all`) so every flat nav item
// passes the CASL filter. The auth store is mocked globally in setup.ts (ADMIN).
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

// Real-org ADMIN (matches the setup.ts default; org_is_demo absent → real org).
// org_features is explicit (empty), not omitted — useOrgFeatures/useEntitlementsReady
// treat undefined as "unknown, not yet loaded" (Sidebar's featureLocked gate is
// keyed on entitlementsReady), so omitting it would make the "locked" fixture
// read as pending-load rather than deliberately unentitled, defeating the
// feature-lock tests below.
const REAL_ORG_ADMIN = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'admin@test.com',
  first_name: 'Test',
  last_name: 'Admin',
  role: 'ADMIN',
  org_features: [] as string[],
};

/** Point the mocked auth store at a specific signed-in user (demo vs real org). */
function mockAuthUser(user: Record<string, unknown>) {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: any) => unknown) =>
    selector({ user, isAuthenticated: true, isLoading: false, error: null })
  );
}

function renderSidebar(ability = adminAbility, collapsed = false) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AbilityProvider ability={ability}>
        <TooltipProvider>
          <Sidebar collapsed={collapsed} />
        </TooltipProvider>
      </AbilityProvider>
    </MemoryRouter>
  );
}

describe('Sidebar', () => {
  // A fresh localStorage means useNavLayout hydrates from DEFAULT_LAYOUT_KEYS.
  // Reset the auth mock to a real org each test (the demo test opts in explicitly).
  beforeEach(() => {
    localStorage.clear();
    mockAuthUser(REAL_ORG_ADMIN);
    useAiCenterStore.setState({ open: false, focusAgentId: null });
  });

  // Structural guard for the customizable flat-list rework: the default layout
  // resolves through the registry and renders the renamed destinations.
  it('renders the default flat nav items', () => {
    renderSidebar();
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    // The Customers destination renders under the "Customers" label.
    expect(screen.getByText('Customers')).toBeInTheDocument();
  });

  // The standalone "ServWave Phone" shortcut was redundant with Communication's
  // own "Phone" child (both linked to /communication/phone) — removed in favor
  // of the single entry point under the Communication group.
  it('no longer renders a standalone ServWave Phone shortcut', () => {
    renderSidebar();
    expect(screen.queryByText('ServWave Phone')).toBeNull();
  });

  it('exposes the Customize toggle to reorder/add/remove shortcuts', () => {
    renderSidebar();
    expect(screen.getByRole('button', { name: /Customize/ })).toBeInTheDocument();
  });

  // #234 — Reports is Admin + Dispatcher only. The nav item is CASL-gated on
  // `read Report`; a Sales ability (no Report grant) must not see it.
  it('hides the Reports nav item for an ability without read Report (Sales)', () => {
    // Sales-shaped: dashboard/leads/estimates yes, Report no.
    const salesAbility = buildAbility([
      { action: 'read', subject: 'Dashboard' },
      { action: 'read', subject: 'Lead' },
      { action: 'read', subject: 'Estimate' },
    ]);
    renderSidebar(salesAbility);

    // Dashboard is granted so it renders; Reports is not.
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.queryByText('Reports')).toBeNull();
  });

  it('shows the Reports nav item for an ability with read Report (Dispatcher/Admin)', () => {
    const dispatcherAbility = buildAbility([
      { action: 'read', subject: 'Dashboard' },
      { action: 'read', subject: 'Report' },
    ]);
    renderSidebar(dispatcherAbility);

    expect(screen.getByText('Reports')).toBeInTheDocument();
  });

  // #234 drift fix — the default-layout "Billing" item links to /reports/unpaid-invoices,
  // a route now restricted to ADMIN+DISPATCHER. It was gated on `read Invoice`, so
  // SALES (row-scoped read Invoice) saw it but clicking dead-ended at `/`. It's now
  // re-gated on `read Report`, so it must hide for an ability without read Report.
  it('hides the Billing report nav item for an ability with read Invoice but not read Report (Sales)', () => {
    const salesAbility = buildAbility([
      { action: 'read', subject: 'Dashboard' },
      { action: 'read', subject: 'Lead' },
      { action: 'read', subject: 'Invoice' }, // SALES holds read Invoice (row-scoped)
    ]);
    renderSidebar(salesAbility);

    // Dashboard is granted so it renders; the Billing report link is not.
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.queryByText('Billing')).toBeNull();
  });

  it('shows the Billing report nav item for an ability with read Report (Dispatcher/Admin)', () => {
    const dispatcherAbility = buildAbility([
      { action: 'read', subject: 'Dashboard' },
      { action: 'read', subject: 'Report' },
    ]);
    renderSidebar(dispatcherAbility);

    expect(screen.getByText('Billing')).toBeInTheDocument();
  });

  // #371 — long shortcut labels ('Salesperson Leaderboard') must ellipsize instead
  // of pushing the Customize-mode X remove button past the 240px rail edge, where
  // the nav's overflow-x-hidden clips it and the shortcut becomes un-deletable.
  // jsdom cannot measure layout overflow, so these assertions pin the CSS contract
  // the fix depends on: NavLink `min-w-0` (nested-flex shrink) + label `truncate`.
  it('keeps the remove (X) button reachable for a long shortcut label in Customize mode', () => {
    // Seed the persisted layout (mocked auth user id from setup.ts) with the
    // long-labelled pinnable report shortcut from the nav registry.
    localStorage.setItem(
      'servwave:nav-layout:00000000-0000-0000-0000-000000000001',
      JSON.stringify(['dashboard', 'rpt-rep-board'])
    );
    renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: /Customize/ }));

    // (a) The X remove button renders for the long-labelled shortcut.
    expect(
      screen.getByRole('button', { name: 'Remove Salesperson Leaderboard' })
    ).toBeInTheDocument();

    // (b) Truncation contract: the label span ellipsizes…
    const label = screen.getByText('Salesperson Leaderboard');
    expect(label).toHaveClass('truncate');
    // …and the NavLink flex item can actually shrink (min-width:auto disabled),
    // so the label's truncate engages instead of the row overflowing the rail.
    const navLink = label.closest('a');
    expect(navLink).not.toBeNull();
    expect(navLink).toHaveClass('min-w-0');
  });

  // Marketing is a demo-only mock surface (no /api/marketing backend). Real orgs
  // must see it locked — visible but non-clickable "coming soon", never a live
  // link — while demo orgs get the working page. Pairs with <DemoOnlyRoute>.
  it('locks the Marketing item (non-clickable) for a real org', () => {
    renderSidebar(); // default mock = real org (org_is_demo absent → false)
    const marketing = screen.getByText('Marketing');
    expect(marketing).toBeInTheDocument();
    // Not rendered as a navigable link…
    expect(marketing.closest('a')).toBeNull();
    // …and its row is explicitly marked disabled.
    expect(marketing.closest('[aria-disabled="true"]')).not.toBeNull();
  });

  it('renders Marketing as a live link for a demo org', () => {
    mockAuthUser({ ...REAL_ORG_ADMIN, org_is_demo: true });
    renderSidebar();
    const link = screen.getByText('Marketing').closest('a');
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('href', '/marketing');
  });

  // Communication is gated on TWO entitlements since email left the `phone`
  // master switch: the group shows when the org holds `phone` OR `email`.
  // Because it's an expandable GROUP (not a flat item like Marketing), an org
  // with NEITHER must see it collapse to a locked, non-clickable, plan-badged
  // row — never an expandable list of live child links. Pairs with <RequireFeature>.
  it('locks the Communication group (non-clickable, no children) for an org with neither the phone nor the email entitlement', () => {
    renderSidebar(); // default mock = org_features: [] (neither entitlement)
    const comm = screen.getByText('Communication');
    expect(comm).toBeInTheDocument();
    // Not a navigable link, and not an expandable group button…
    expect(comm.closest('a')).toBeNull();
    expect(comm.closest('button')).toBeNull();
    // …its row is explicitly marked disabled…
    expect(comm.closest('[aria-disabled="true"]')).not.toBeNull();
    // …and its child links are not rendered (a locked group can't expand).
    expect(screen.queryByText('WhatsApp')).toBeNull();
  });

  it('renders Communication as an expandable group with all four channels for a phone + email org', () => {
    mockAuthUser({ ...REAL_ORG_ADMIN, org_features: ['phone', 'email'] });
    renderSidebar();
    const groupBtn = screen.getByText('Communication').closest('button');
    expect(groupBtn).not.toBeNull();
    expect(groupBtn).toHaveAttribute('aria-expanded');
    fireEvent.click(groupBtn!);
    expect(screen.getByText('Phone').closest('a')).toHaveAttribute('href', '/communication/phone');
    expect(screen.getByText('Text').closest('a')).toHaveAttribute('href', '/communication/text');
    expect(screen.getByText('Email').closest('a')).toHaveAttribute('href', '/communication/inbox');
    expect(screen.getByText('WhatsApp')).toBeInTheDocument();
  });

  // The reason `email` was split out of `phone`: Communication is dark by
  // default for every new org (`feature_overrides: {"phone": false}`), but every
  // plan may send email. Such an org must still see the group - with Email in it
  // and nothing else.
  it('renders the Communication group with ONLY Email for an org entitled to email but not phone', () => {
    mockAuthUser({ ...REAL_ORG_ADMIN, org_features: ['email'] });
    renderSidebar();
    const groupBtn = screen.getByText('Communication').closest('button');
    expect(groupBtn).not.toBeNull();
    fireEvent.click(groupBtn!);

    expect(screen.getByText('Email').closest('a')).toHaveAttribute('href', '/communication/inbox');
    expect(screen.queryByText('Phone')).toBeNull();
    expect(screen.queryByText('Text')).toBeNull();
    expect(screen.queryByText('WhatsApp')).toBeNull();
  });

  // WhatsApp has no connected Business account for a real org. The row is
  // LOCKED rather than hidden - a hidden row with a live route is still
  // reachable by URL, so the honest thing is to show it locked. Pairs with the
  // <DemoOnlyRoute> wrapper on /communication/whatsapp.
  it('locks the WhatsApp child (non-clickable) for a real org that owns the phone entitlement', () => {
    mockAuthUser({ ...REAL_ORG_ADMIN, org_features: ['phone', 'email'] });
    renderSidebar();
    fireEvent.click(screen.getByText('Communication').closest('button')!);

    const whatsapp = screen.getByText('WhatsApp');
    expect(whatsapp.closest('a')).toBeNull();
    expect(whatsapp.closest('[aria-disabled="true"]')).not.toBeNull();
    // Its entitled siblings stay live - the lock is per child, not per group.
    expect(screen.getByText('Phone').closest('a')).not.toBeNull();
  });

  it('renders the WhatsApp child as a live link for a demo org', () => {
    mockAuthUser({ ...REAL_ORG_ADMIN, org_features: ['phone', 'email'], org_is_demo: true });
    renderSidebar();
    fireEvent.click(screen.getByText('Communication').closest('button')!);

    expect(screen.getByText('WhatsApp').closest('a'))
      .toHaveAttribute('href', '/communication/whatsapp');
  });

  // The collapsed rail renders a group as a single link, so its href is the
  // group's landing target. That target is resolved to the first child the user
  // can actually REACH - the declared `/communication/phone` is a dead link for
  // an email-only org, and an /upgrade bounce is not a landing page.
  it('lands the collapsed Communication row on the first child the org can reach', () => {
    mockAuthUser({ ...REAL_ORG_ADMIN, org_features: ['email'] });
    const { container } = renderSidebar(adminAbility, true);
    expect(container.querySelector('a[href="/communication/inbox"]')).not.toBeNull();
    expect(container.querySelector('a[href="/communication/phone"]')).toBeNull();
  });

  it('lands the collapsed Communication row on the phone hub for a phone org', () => {
    mockAuthUser({ ...REAL_ORG_ADMIN, org_features: ['phone', 'email'] });
    const { container } = renderSidebar(adminAbility, true);
    expect(container.querySelector('a[href="/communication/phone"]')).not.toBeNull();
  });

  // #450 — the bottom AI promo card (marketing copy + full-width CTA) was
  // replaced by a compact icon+label launcher that opens the AI Center modal.
  it('opens the AI Center from the sidebar launcher (expanded)', () => {
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'AI Agentic Farm' }));
    expect(useAiCenterStore.getState().open).toBe(true);
    // The old promo copy is gone:
    expect(screen.queryByText(/close more deals/i)).toBeNull();
  });

  it('hides the AI launcher for an ability without read AiCenter', () => {
    renderSidebar(buildAbility([{ action: 'read', subject: 'Dashboard' }]));
    expect(screen.queryByRole('button', { name: 'AI Agentic Farm' })).toBeNull();
  });

  it('exposes the AI launcher when collapsed', () => {
    renderSidebar(adminAbility, true);
    expect(screen.getByRole('button', { name: 'AI Agentic Farm' })).toBeInTheDocument();
  });
});
