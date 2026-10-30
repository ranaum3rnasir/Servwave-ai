/**
 * Payments go-live slice 34 - which embedded payout components a minted account session enables.
 *
 * A session is minted server-side per request for a named surface, so a page can only ever mount
 * the components its surface was granted:
 *  - owner:  account onboarding, account management (bank and identity), notification banner;
 *  - viewer: payments, payment details, payouts list and details, documents, disputes
 *            (the ServWave Payments area, slice 35).
 * The Balances and full Payouts components are never enabled: ServWave owns the money screens that
 * carry a payout-now button, so a user cannot move funds from an embedded surface.
 */
export type SessionSurface = 'owner' | 'viewer';

export const SESSION_SURFACES: readonly SessionSurface[] = ['owner', 'viewer'];

type ComponentConfig = { enabled: true; features?: Record<string, boolean> };

const OWNER_COMPONENTS: Record<string, ComponentConfig> = {
  account_onboarding: { enabled: true },
  account_management: { enabled: true },
  notification_banner: { enabled: true },
};

// The processor rejects a session where the payment-family components disagree on a shared feature
// flag, so they all take this one object (payment_disputes has no capture flag, measured against the sandbox).
const PAYMENT_FEATURES = { refund_management: false, dispute_management: true, capture_payments: false };

const VIEWER_COMPONENTS: Record<string, ComponentConfig> = {
  // Refunds are made from ServWave's own refund dialog (slice 29); disputes are answered here.
  payments: { enabled: true, features: { ...PAYMENT_FEATURES } },
  payment_details: { enabled: true, features: { ...PAYMENT_FEATURES } },
  // Disputes: the list, plus the dispute pane inside a payment (evidence is submitted from there).
  payment_disputes: { enabled: true, features: { refund_management: false, dispute_management: true } },
  disputes_list: { enabled: true, features: { ...PAYMENT_FEATURES } },
  payouts_list: { enabled: true },
  payout_details: { enabled: true },
  documents: { enabled: true },
};

/** The `components` object handed to the processor when minting the session. */
export function componentsFor(surface: SessionSurface): Record<string, ComponentConfig> {
  return surface === 'owner' ? OWNER_COMPONENTS : VIEWER_COMPONENTS;
}

/** Names of the components a surface enables. */
export function enabledComponentsFor(surface: SessionSurface): string[] {
  return Object.keys(componentsFor(surface));
}
