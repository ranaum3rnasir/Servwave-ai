/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * #449 — Top bar must reflow (never overflow) as the viewport narrows.
 *
 * jsdom has no layout engine, so — like the csp-pdf-preview guard — we assert
 * the responsive class *contract* that IS the fix. If a future edit strips one
 * of these classes the bar regresses to overflowing, and this guard fails.
 * Plus one behavior test: the kebab exposes the comms shortcuts below lg.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  renderWithProviders,
  communicationSectionAbility,
  readOnlyCommunicationAbility,
} from '@/__tests__/helpers';
import { useAuthStore } from '@/stores/auth.store';
import Header from '../Header';

// Real-org ADMIN (matches the setup.ts default; org_is_demo absent → real org).
// org_features is explicit (empty), not omitted — useFeature('phone') fails
// OPEN when org_features is undefined (unknown ≠ denied), so omitting it would
// make this "no comms" fixture look entitled and defeat the gating tests below.
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

beforeEach(() => {
  // Radix Popover interaction needs these jsdom-absent methods.
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn();
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn();
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = vi.fn();
  // Default to a real org; the demo-org test opts in explicitly.
  mockAuthUser(REAL_ORG_ADMIN);
});

describe('Header — responsive reflow contract (#449)', () => {
  it('root header zone can compress (min-w-0)', () => {
    const { container } = renderWithProviders(<Header />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('min-w-0');
    expect(root.className).toContain('flex-1');
  });

  it('GlobalSearch wrapper can shrink below its input min-content (min-w-0)', () => {
    const { container } = renderWithProviders(<Header />);
    const searchWrapper = container.querySelector('.max-w-md') as HTMLElement;
    expect(searchWrapper).not.toBeNull();
    expect(searchWrapper.className).toContain('min-w-0');
  });

  it('the right action cluster never shrinks (shrink-0)', () => {
    renderWithProviders(<Header />);
    const cluster = screen.getByRole('button', { name: 'More' }).parentElement as HTMLElement;
    expect(cluster.className).toContain('shrink-0');
  });

  it('inline comms shortcuts only render at lg (hidden … lg:flex) and the kebab is lg:hidden', () => {
    renderWithProviders(<Header />);
    const inlineComms = screen.getByRole('button', { name: 'Help & support' })
      .parentElement as HTMLElement;
    expect(inlineComms.className).toContain('hidden');
    expect(inlineComms.className).toContain('lg:flex');

    const kebab = screen.getByRole('button', { name: 'More' });
    expect(kebab.className).toContain('lg:hidden');
  });

  // Each kebab shortcut is gated on the entitlement of the surface it JUMPS TO,
  // not on one module-wide switch:
  //   Messages -> /communication/phone  : PRO `phone`
  //   WhatsApp -> /communication/whatsapp: `phone` AND a demo org (the route is
  //               wrapped in <DemoOnlyRoute>, which bounces a real org to `/`)
  //   Inbox    -> /communication/inbox  : STARTER `email`, its own entitlement
  // Gating all three on `phone` (as this file used to) both hid Inbox from an
  // email-entitled Starter org and offered real Pro orgs a WhatsApp button that
  // lands on the dashboard.
  it('the kebab exposes Messages but NOT WhatsApp (real org) or Inbox (no email) for a phone-only org', async () => {
    mockAuthUser({ ...REAL_ORG_ADMIN, org_features: ['phone'] });
    const user = userEvent.setup();
    // #2046 - the six shortcut entries additionally need the section ability now.
    renderWithProviders(<Header />, { ability: communicationSectionAbility() });

    await user.click(screen.getByRole('button', { name: 'More' }));

    expect(await screen.findByText('Messages')).toBeInTheDocument();
    expect(screen.getByText('Help & support')).toBeInTheDocument();
    expect(screen.queryByText('WhatsApp')).toBeNull();
    expect(screen.queryByText('Inbox')).toBeNull();
  });

  it('offers WhatsApp only to a demo org that also has phone', async () => {
    mockAuthUser({ ...REAL_ORG_ADMIN, org_features: ['phone'], org_is_demo: true });
    const user = userEvent.setup();
    renderWithProviders(<Header />, { ability: communicationSectionAbility() });

    await user.click(screen.getByRole('button', { name: 'More' }));

    expect(await screen.findByText('WhatsApp')).toBeInTheDocument();
    expect(screen.getByText('Messages')).toBeInTheDocument();
  });

  // The regression the email/phone split creates if the header is left alone: a
  // Starter org owns `email` and the sidebar shows it the Email nav row, but the
  // header would hide the Inbox shortcut (and its unread-email badge) because it
  // asked for `phone`.
  it('offers Inbox to an email-only org, with no phone shortcuts', async () => {
    mockAuthUser({ ...REAL_ORG_ADMIN, org_features: ['email'] });
    const user = userEvent.setup();
    renderWithProviders(<Header />, { ability: communicationSectionAbility() });

    await user.click(screen.getByRole('button', { name: 'More' }));

    expect(await screen.findByText('Inbox')).toBeInTheDocument();
    expect(screen.queryByText('Messages')).toBeNull();
    expect(screen.queryByText('WhatsApp')).toBeNull();
  });

  it('offers both Messages and Inbox to a real org holding phone and email', async () => {
    mockAuthUser({ ...REAL_ORG_ADMIN, org_features: ['phone', 'email'] });
    const user = userEvent.setup();
    renderWithProviders(<Header />, { ability: communicationSectionAbility() });

    await user.click(screen.getByRole('button', { name: 'More' }));

    expect(await screen.findByText('Messages')).toBeInTheDocument();
    expect(screen.getByText('Inbox')).toBeInTheDocument();
    expect(screen.queryByText('WhatsApp')).toBeNull();
  });

  // An org entitled to nothing in Communication keeps only Help.
  it('the kebab hides every comms shortcut for an org with no comm entitlement', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Header />);

    await user.click(screen.getByRole('button', { name: 'More' }));

    expect(await screen.findByText('Help & support')).toBeInTheDocument();
    expect(screen.queryByText('Messages')).toBeNull();
    expect(screen.queryByText('WhatsApp')).toBeNull();
    expect(screen.queryByText('Inbox')).toBeNull();
  });
});

// #2046 - the six shortcut entries (three inline `CommsButton`s + their three kebab
// `OverflowItem` mirrors) additionally require the Communication SECTION ability
// (`access_inbox Communication`), never a role name. `<GlobalDialer />` is the control: it stays
// keyed on the `phone` entitlement alone, so a caller without the section gate keeps click-to-call.
describe('Header — #2046 Communication section gate', () => {
  it('hides every comms shortcut (inline + kebab) for a read-only-Communication ability, keeping GlobalDialer', async () => {
    mockAuthUser({ ...REAL_ORG_ADMIN, org_features: ['phone', 'email'] });
    const user = userEvent.setup();
    renderWithProviders(<Header />, { ability: readOnlyCommunicationAbility() });

    // Inline row: no shortcut buttons, but the dialer's own trigger still renders.
    expect(screen.queryByRole('button', { name: 'Phone messages' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Inbox' })).toBeNull();
    expect(screen.getByRole('button', { name: /open dialer/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'More' }));
    expect(await screen.findByText('Help & support')).toBeInTheDocument();
    expect(screen.queryByText('Messages')).toBeNull();
    expect(screen.queryByText('Inbox')).toBeNull();
    expect(screen.queryByText('WhatsApp')).toBeNull();
  });

  it('shows the shortcuts for an ability holding the section gate', async () => {
    mockAuthUser({ ...REAL_ORG_ADMIN, org_features: ['phone', 'email'] });
    const user = userEvent.setup();
    renderWithProviders(<Header />, { ability: communicationSectionAbility() });

    expect(screen.getByRole('button', { name: 'Phone messages' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Inbox' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'More' }));
    expect(await screen.findByText('Messages')).toBeInTheDocument();
    expect(screen.getByText('Inbox')).toBeInTheDocument();
  });
});
