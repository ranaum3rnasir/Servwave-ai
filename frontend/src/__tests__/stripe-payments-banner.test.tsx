// Payments Phase 2, Task 2.5 — just-in-time (JIT) "accept cards" banner (spec §6.8 non-admin
// copy). An admin sees the CTA ("Get paid faster..." + Set up + a dismissible X); a non-admin
// sees informational-only copy ("...ask your admin") with no CTA and no dismiss control — they
// can't act on it. The banner renders nothing while org data hasn't loaded yet, once
// `stripe_charges_enabled` is already true, or once dismissed (a global per-browser localStorage
// flag). Dismissal is checked BEFORE the admin/non-admin branch, so a prior admin dismissal also
// silences the non-admin's informational copy — that's intentional per the brief, not a bug.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { StripePaymentsBanner } from '@/components/payments/StripePaymentsBanner';
import { buildAbility } from '@/lib/ability';
import type { Organization } from '@/lib/api/organization';

const DISMISS_KEY = 'servwave.payments.jit.dismissed';

// Real CASL ability granting the Organization-management permission that gates admin-only
// surfaces app-wide (same check as CompanyProfilePage/PhoneSmsPage/etc: can('update', 'Organization')).
const ADMIN_ABILITY = buildAbility([{ action: 'update', subject: 'Organization' }]);
// Omitting the `ability` option makes renderWithProviders fall back to emptyAbility (every
// .can() is false) — that's the non-admin case (Sales/Dispatcher/Technician).

const ORG = {
  id: 'org-1',
  name: 'Acme HVAC',
  stripe_charges_enabled: false,
  platform_fee_bps: 50,
} as Organization;

const hoisted = vi.hoisted(() => ({
  org: undefined as unknown as Organization,
}));

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return {
    ...actual,
    useOrganization: () => ({ data: hoisted.org }),
  };
});

beforeEach(() => {
  hoisted.org = { ...ORG };
  localStorage.clear();
});

describe('StripePaymentsBanner (§6.8 JIT banner + non-admin copy)', () => {
  it('renders nothing while organization data has not loaded yet', () => {
    hoisted.org = undefined as unknown as Organization;
    renderWithProviders(<StripePaymentsBanner onSetup={vi.fn()} />, { ability: ADMIN_ABILITY });

    expect(screen.queryByText(/Get paid faster/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ask your admin/)).not.toBeInTheDocument();
  });

  it('renders nothing once card payments are already enabled — admin', () => {
    hoisted.org = { ...ORG, stripe_charges_enabled: true };
    renderWithProviders(<StripePaymentsBanner onSetup={vi.fn()} />, { ability: ADMIN_ABILITY });

    expect(screen.queryByText(/Get paid faster/)).not.toBeInTheDocument();
  });

  it('renders nothing once card payments are already enabled — non-admin', () => {
    hoisted.org = { ...ORG, stripe_charges_enabled: true };
    renderWithProviders(<StripePaymentsBanner onSetup={vi.fn()} />);

    expect(screen.queryByText(/ask your admin/)).not.toBeInTheDocument();
  });

  it('admin: shows the "Get paid faster" CTA banner with Set up + Dismiss, and no non-admin copy', () => {
    renderWithProviders(<StripePaymentsBanner onSetup={vi.fn()} />, { ability: ADMIN_ABILITY });

    expect(screen.getByText('Get paid faster — accept card payments.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set up' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    expect(screen.queryByText(/ask your admin/)).not.toBeInTheDocument();
  });

  it('admin: clicking Set up calls onSetup', async () => {
    const onSetup = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<StripePaymentsBanner onSetup={onSetup} />, { ability: ADMIN_ABILITY });

    await user.click(screen.getByRole('button', { name: 'Set up' }));
    expect(onSetup).toHaveBeenCalledTimes(1);
  });

  it('admin: clicking Dismiss hides the banner immediately and persists across remounts', async () => {
    const user = userEvent.setup();
    const { unmount } = renderWithProviders(
      <StripePaymentsBanner onSetup={vi.fn()} />,
      { ability: ADMIN_ABILITY }
    );

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/Get paid faster/)).not.toBeInTheDocument();
    expect(localStorage.getItem(DISMISS_KEY)).toBe('1');

    unmount();
    renderWithProviders(<StripePaymentsBanner onSetup={vi.fn()} />, { ability: ADMIN_ABILITY });
    expect(screen.queryByText(/Get paid faster/)).not.toBeInTheDocument();
  });

  it('non-admin: shows informational copy only — no Set up CTA, no dismiss control', () => {
    renderWithProviders(<StripePaymentsBanner onSetup={vi.fn()} />);

    expect(screen.getByText('Card payments aren’t set up — ask your admin.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set up' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Get paid faster/)).not.toBeInTheDocument();
  });

  it('a prior admin dismissal also silences the non-admin informational copy (dismissed check runs first)', () => {
    localStorage.setItem(DISMISS_KEY, '1');
    renderWithProviders(<StripePaymentsBanner onSetup={vi.fn()} />);

    expect(screen.queryByText(/ask your admin/)).not.toBeInTheDocument();
  });

  it('never renders a card, bank, or SSN input', () => {
    const { container } = renderWithProviders(
      <StripePaymentsBanner onSetup={vi.fn()} />,
      { ability: ADMIN_ABILITY }
    );
    expect(container.querySelectorAll('input')).toHaveLength(0);
  });
});
