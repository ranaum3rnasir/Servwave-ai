/**
 * ServWave legal document version + canonical URLs (SERV10X-17).
 *
 * CURRENT_TERMS_VERSION is the server-owned source of truth recorded on every
 * in-app acceptance. Bump it to the docs' new "Last updated" date if the Terms
 * or Privacy Policy materially change and you want to force re-acceptance.
 */
export const CURRENT_TERMS_VERSION = '2026-06-30';
export const TERMS_URL = 'https://www.servwave.com/terms/';
export const PRIVACY_URL = 'https://www.servwave.com/privacy/';

/**
 * Accounts created on/after this instant must accept Terms/Privacy before
 * finishing onboarding via ANY path (password+checkbox or Google). Accounts
 * created before it are grandfathered (SERV10X-17 §8 known gap) and are
 * never gated, including via Google. Not meant to move once shipped.
 */
export const TERMS_ENFORCEMENT_EFFECTIVE_SINCE = new Date('2026-07-09T00:00:00.000Z');

/**
 * ServWave Payments Terms — versioned INDEPENDENTLY of CURRENT_TERMS_VERSION.
 * The payments-onboarding clickwrap gate (organization-stripe.controller) is
 * version-aware: bumping this forces re-acceptance for the fee term.
 *
 * 2026-10-06 (payments go-live, D9/D12/D13): the terms now say customers pay the
 * invoice amount, the processor's standard rates are billed to the contractor's
 * own account, and ServWave charges no payment fee. Every org that accepted the
 * 2026-07-21 terms (which promised a deducted platform fee) re-accepts.
 */
export const CURRENT_PAYMENTS_TERMS_VERSION = '2026-10-06';

/**
 * The payment fee ServWave discloses on a payments-terms acceptance: zero, because
 * ServWave takes no cut of payments (D9). Organization.platform_fee_bps is retired
 * and no payment path reads it.
 */
export const DISCLOSED_PAYMENTS_FEE_BPS = 0;
export const PAYMENTS_TERMS_URL = 'https://www.servwave.com/payments-terms/';
export const PAYMENTS_FEE_SCHEDULE_URL = 'https://www.servwave.com/fee-schedule/';
