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
 * version-aware: bumping this forces re-acceptance for the fee term. URLs are
 * placeholders until counsel delivers the documents (spec §15D).
 */
export const CURRENT_PAYMENTS_TERMS_VERSION = '2026-07-21';
export const PAYMENTS_TERMS_URL = 'https://www.servwave.com/payments-terms/';
export const PAYMENTS_FEE_SCHEDULE_URL = 'https://www.servwave.com/fee-schedule/';

/**
 * Ceiling for a WITHIN-ceiling platform-fee rate change (§3.6, Task 4.3).
 * Organization.platform_fee_bps may be raised up to this value with just a
 * ≥30-day notice (lib/platform-fee-rate-notice.ts) — no re-acceptance. A
 * change ABOVE this ceiling is a different, not-yet-built flow that would
 * need fresh clickwrap re-acceptance, not just a notice.
 */
export const PLATFORM_FEE_CEILING_BPS = 200; // 2%
