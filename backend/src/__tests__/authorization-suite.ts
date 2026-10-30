/**
 * The authorization suite (P20): the tests that prove who may do what, collected under one name and run as a release gate.
 *
 * A permission regression must not reach production unnoticed, so the proving tests of every alignment ticket are listed here,
 * ticket by ticket, and `npm run test:authorization` (vitest.authorization.config.ts) runs exactly these files plus every
 * `permission-*` test, so a new permission test joins the gate the day it lands without anyone remembering to list it.
 *
 * Where it runs:
 *  - the Backend job of ci.yml runs it as its own named step, on every pull request and on every push to main; the suites that
 *    need no database run there;
 *  - the Database job of ci.yml runs the `*-db.test.ts` files of it (every real-database suite is dealt to a shard by name),
 *    on the same triggers, so on every push to main too.
 * `authorization-suite.test.ts` fails when a listed file is missing, when a ticket lists nothing, or when ci.yml stops
 * running the suite.
 */

/** Ticket id (the alignment slice) to the test files, relative to this folder, that prove it. */
export const AUTHORIZATION_SUITE: Record<string, readonly string[]> = {
  'AL-01a role edits reach everyone on the role': [
    'permission-overlay-store-db.test.ts', 'permission-switches-db.test.ts', 'permission-roles-api-db.test.ts',
  ],
  'AL-01b reset, dependent overrides, who a save reached': ['permission-roles-api-db.test.ts', 'permission-overlay-store-db.test.ts'],
  'AL-02 no Location scope': ['permission-location-scope-migration-db.test.ts', 'permission-switch-catalog.test.ts'],
  'AL-03 Admin is a flag': ['permission-admin-flag-db.test.ts', 'permission-admin-flag-guard.test.ts'],
  'AL-04 Create requires Edit': [
    'permission-create-requires-edit.test.ts', 'permission-create-requires-edit-migration-db.test.ts', 'permission-preset-chain-db.test.ts',
  ],
  'AL-05a See prices is the root money switch': [
    'permission-money-chain.test.ts', 'permission-prices-db.test.ts', 'permission-see-prices-migration-db.test.ts',
  ],
  'AL-05b costs and company figures stand on prices': [
    'permission-financial-data-db.test.ts', 'permission-money-leaks-db.test.ts', 'preset-migration-rename-follow-up.test.ts',
  ],
  'AL-06a who made a record opens nothing': [
    'permission-own-documents-db.test.ts', 'permission-no-creator-guard.test.ts', 'permission-lead-creator-edit-db.test.ts',
  ],
  'AL-06b estimates and invoices follow the Jobs and Leads scope': [
    'permission-estimate-invoice-scope-db.test.ts', 'permission-document-scopes-migration-db.test.ts',
  ],
  'AL-07 attachments and notes come with the record': [
    'permission-attachments-notes-migration-db.test.ts', 'permission-attachment-delete-db.test.ts', 'permission-tasks-attachments-notes-db.test.ts',
  ],
  'AL-08 the reach toggles became scope': ['permission-reach-scope-migration-db.test.ts', 'permission-data-scope-db.test.ts'],
  'AL-09 reports follow the scope': ['permission-reports-scope-db.test.ts'],
  'AL-10 display switches retire': [
    'permission-display-switches-migration-db.test.ts', 'permission-switch-classes.test.ts', 'permission-switch-layout.test.ts',
  ],
  'AL-11 every refusal is logged': ['permission-refusals-logged-db.test.ts', 'audit-access-denied.test.ts'],
  'AL-12 the switch version stamp': ['permission-switch-stamp-db.test.ts'],
  'AL-13a deactivation changes no data': ['permission-deactivation-keeps-data-db.test.ts'],
  'AL-13b erase personal data': ['permission-erase-personal-data-db.test.ts'],
  'AL-15 the legacy tables are gone': ['permission-grant-sources-db.test.ts', 'permission-preset-migration-db.test.ts', 'permission-preset-migration.test.ts'],
  'M2 no writing onto records you cannot open: log past communication, duplicate estimate': [
    'permission-manual-log-reach-db.test.ts', 'permission-estimate-duplicate-reach-db.test.ts', 'permission-communication-target-reach-db.test.ts',
  ],
  'T21 caught up with staging: no role-name Admin check came in': ['permission-admin-flag-guard.test.ts'],
  'H6 prices cannot be dodged: a retyped address, the customer link token field, every money column decided': [
    'permission-prices-address-db.test.ts', 'permission-money-columns-guard.test.ts', 'permission-prices-probe-db.test.ts',
  ],
  'AL-16 (ticket 24) every company has an Owner, and no one can remove them': [
    'permission-owner-db.test.ts', 'permission-owner-storage-db.test.ts', 'permission-owner-migration-db.test.ts',
    'permission-owner-new-companies-db.test.ts',
  ],
  'H3 statements and the customer page follow reach': ['permission-statement-customer-reach-db.test.ts'],
  'M4 (ticket 35) costs hidden in one place: price presets, service plans, customer deposits, the bell, staff emails, every cost column decided': [
    'permission-costs-central.test.ts', 'permission-costs-db.test.ts', 'permission-costs-journey-db.test.ts', 'permission-money-columns-guard.test.ts',
    'permission-default-staff-emails-migration-db.test.ts', 'permission-bells-no-money.test.ts', 'permission-staff-emails-no-money-db.test.ts',
    'permission-history-lines-migration-db.test.ts', 'permission-price-writes-db.test.ts',
  ],
  'item-3/7/8 (ticket 33) not found means not found, and reports follow reach': [
    'permission-not-found-means-not-found-db.test.ts', 'permission-reach-documents-and-reports-db.test.ts',
    'permission-bulk-not-found-db.test.ts', 'permission-payment-item-restricted-db.test.ts', 'permission-reach-sql-equivalence-db.test.ts',
    'permission-body-id-guard.test.ts', 'permission-body-id-not-found-db.test.ts', 'permission-reach-sql-compiler.test.ts',
  ],
  'H2 invites (ticket 23)': ['permission-invite-links-db.test.ts'],
  '33b editing a service plan keeps its customer and address': ['permission-service-plan-edit-keeps-customer-db.test.ts'],
  'AL-18 user and role management Admin-only (ticket 28)': [
    'permission-admin-only-management-db.test.ts', 'permission-user-role-switches-migration-db.test.ts', 'permission-users-db.test.ts',
  ],
  'H2 revoke (ticket 22): revoked or deactivated, no door lets them in; a failed removal is an error; no account cap': [
    'permission-revoke-locks-out-db.test.ts', 'permission-revoke-doors-guard.test.ts',
  ],
  'M7/M8 switches do what they say (ticket 36)': [
    'permission-show-email-guard.test.ts', 'permission-show-email-db.test.ts',
    'permission-export-routes-guard.test.ts', 'permission-export-routes-db.test.ts',
    'permission-company-admin-only-guard.test.ts', 'permission-company-admin-only-db.test.ts',
    'permission-email-bells-show-email-db.test.ts',
  ],
  'H4/H5 only the Owner changes Admins (ticket 26)': ['permission-owner-changes-admins-db.test.ts'],
  'H5/D1 Make Owner with email approval (ticket 27)': ['permission-make-owner-db.test.ts', 'permission-make-owner-guard.test.ts'],
  'M8 Company settings is the Admin flag\'s alone, the switch retired (ticket 36b, M17)': [
    'permission-company-settings-guard.test.ts', 'permission-company-settings-admin-only-db.test.ts',
    'permission-company-settings-migration-db.test.ts', 'permission-own-sign-in-db.test.ts',
  ],
  'M6 access changes recorded (ticket 25)': [
    'permission-access-audit-db.test.ts', 'permission-audit-append-only-db.test.ts', 'permission-admin-change-email-db.test.ts',
  ],
  'M3 the people list is names-only for non-Admins (ticket 29)': [
    'permission-people-names-only-db.test.ts', 'permission-people-names-only-guard.test.ts',
  ],
  'M1 mail reach is per message: a reply or an assignment opens nothing more': [
    'permission-email-message-reach-db.test.ts', 'permission-email-reply-bells-db.test.ts', 'permission-email-unmatched-reply-bells-db.test.ts',
    'permission-email-reply-bell-follow-db.test.ts',
  ],
  'M5/M6, items 5 and 12 (ticket 37) the safety nets: every route checked, the outside roles on the CI database, access seen by every server, the switch cache cleared after commit, concurrent role edits': [
    'permission-every-route-checked.test.ts', 'permission-outside-roles-ci-guard.test.ts', 'permission-outside-roles-db.test.ts',
    'permission-access-two-servers-db.test.ts', 'permissions-cache.test.ts', 'permission-switch-cache-after-commit-db.test.ts',
    'permission-concurrent-role-edits-db.test.ts',
  ],
  'pre-PR review fixes (code review of 3f48023ef: CR-1, CR-4..CR-8, CR-10, CR-11, CR-20, parked (d))': [
    'permission-prepr-review-fixes-db.test.ts', 'permission-job-mark-done-db.test.ts', 'permission-erase-personal-data-db.test.ts',
    'permission-email-reply-bells-db.test.ts', 'permission-create-requires-edit-migration-db.test.ts',
    'permission-refusal-scope-switches.test.ts', 'permission-automation-run-history-no-prices.test.ts',
  ],
  'pre-PR review fixes (SR-1, SR-2, SR-5, SR-7, the older lock checks): a record id spelled any other way names nothing; a sign-in left behind opens no later account': [
    'permission-canonical-ids-db.test.ts', 'permission-canonical-ids-guard.test.ts', 'permission-leftover-login-db.test.ts',
    'permission-handover-own-id-db.test.ts',
  ],
  'pre-PR review fixes (re-audit 2026-10-29, builder D): customer link tokens (N0), invoice and money fields (H3, N5, N10, N11, N17), names-only history (N6), Admin mailboxes (N8), email filing and conversations (N9, N16), the Owner id (N18), invites (N21), role records (N23), refusal rows (N19), the switch history append-only (N13), the route test blind spots (N14, N20)': [
    'permission-public-link-token-db.test.ts', 'permission-prepr-review-fixes-d-db.test.ts', 'permission-audit-append-only-db.test.ts',
    'permission-every-route-checked.test.ts', 'test-routes-guard.test.ts',
  ],
  're-audit pass 2 fixes (builder F): a phone number files on a customer only inside reach (P2-1), the payments drawer\'s refusals and a payment\'s history name no figure without See prices (P2-2), the price-book image upload answers a hidden estimate like a missing one (P2-4)': [
    'permission-reaudit-p2-fixes-f-db.test.ts', 'permission-phone-match-reach-guard.test.ts', 'permission-body-id-guard.test.ts',
    'permission-body-id-not-found-db.test.ts',
  ],
};

/** Every file the suite names, once. */
export const AUTHORIZATION_SUITE_FILES: readonly string[] = [...new Set(Object.values(AUTHORIZATION_SUITE).flat())].sort();
