import { describe, it, expect } from 'vitest';
import { defineAbilityFor } from '../lib/permissions/defineAbility';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';

// NOTE (Phase B technician redesign): the TECHNICIAN role default was deliberately narrowed.
// A technician by default can read + `complete` their own job, read+perform_walkthrough their own
// walkthrough lead, and create/read attachments (plus infra reads). Everything else — general
// `update Lead`, create/update Job, and all Invoice access (read/create/record_payment), is
// REMOVED from the default and is now an opt-in per-user toggle, never a role default. The three
// visit milestone verbs (en_route/arrive/start) came BACK as own-scoped role defaults later
// (Spec A D3 for arrive/start, scheduling-notifications slice 10 for en_route). The rows below reflect that: TECHNICIAN is
// absent from `allowedRoles` for those capabilities, so the matrix asserts the tech CANNOT do
// them by default. The granted-path positives live in the phaseB-controllers-* test files.
const ROUTE_PERMISSIONS: { action: string; subject: string; allowedRoles: string[] }[] = [
  // Dashboard
  { action: 'read',                 subject: 'Dashboard',    allowedRoles: ['ADMIN','DISPATCHER'] }, // MISS-1: SALES dropped — company dashboard leaked org-wide financials to a row-scoped role
  // Customer
  { action: 'read',                 subject: 'Customer',     allowedRoles: ['ADMIN','DISPATCHER','SALES'] },
  { action: 'create',               subject: 'Customer',     allowedRoles: ['ADMIN','DISPATCHER','SALES'] }, // #1472: SALES gained create Customer
  { action: 'update',               subject: 'Customer',     allowedRoles: ['ADMIN','DISPATCHER','SALES'] },
  { action: 'delete',               subject: 'Customer',     allowedRoles: ['ADMIN','DISPATCHER'] },
  { action: 'export',               subject: 'Customer',     allowedRoles: ['ADMIN','DISPATCHER'] }, // 018: SALES dropped — a one-click dump of the whole customer book is a departing rep's contact list; read/update above stay
  { action: 'archive',              subject: 'Customer',     allowedRoles: ['ADMIN','DISPATCHER'] },
  { action: 'force_purge',          subject: 'Customer',     allowedRoles: ['ADMIN'] },
  { action: 'anonymize',            subject: 'Customer',     allowedRoles: ['ADMIN'] },
  // Lead
  { action: 'read',                 subject: 'Lead',         allowedRoles: ['ADMIN','DISPATCHER','SALES','TECHNICIAN'] },
  { action: 'create',               subject: 'Lead',         allowedRoles: ['ADMIN','DISPATCHER','SALES'] },
  { action: 'update',               subject: 'Lead',         allowedRoles: ['ADMIN','DISPATCHER','SALES'] }, // Phase B: tech lost general update Lead (now perform_walkthrough only)
  { action: 'delete',               subject: 'Lead',         allowedRoles: ['ADMIN','DISPATCHER','SALES'] },
  { action: 'assign',               subject: 'Lead',         allowedRoles: ['ADMIN','DISPATCHER'] },
  { action: 'contact',              subject: 'Lead',         allowedRoles: ['ADMIN','DISPATCHER','SALES'] },
  { action: 'mark_lost',            subject: 'Lead',         allowedRoles: ['ADMIN','DISPATCHER','SALES'] },
  { action: 'cancel',               subject: 'Lead',         allowedRoles: ['ADMIN','DISPATCHER','SALES'] },
  { action: 'schedule_walkthrough', subject: 'Lead',         allowedRoles: ['ADMIN','DISPATCHER','SALES'] },
  // perform_walkthrough is the narrow lead capability the strict-default TECHNICIAN keeps (own
  // walkthrough, conditional OWN_WALKTHROUGH); SALES (own, OWN_LEAD) + DISPATCHER (unconditional)
  // + ADMIN (manage all) also hold it. A conditional grant still returns true at the subject-type
  // level (no instance) — same as the SALES `read Lead` row above. All four default roles CAN.
  { action: 'perform_walkthrough', subject: 'Lead',         allowedRoles: ['ADMIN','DISPATCHER','SALES','TECHNICIAN'] },
  // Estimate
  // TECHNICIAN reads its OWN estimates (own-via-lead, or - since it has no lead - own-via-creator,
  // OWN_ESTIMATE_VIA_LEAD_OR_CREATOR): without this a technician-created standalone estimate is
  // invisible to its own creator (found in live QA, 2026-08-05, following the technician
  // creator-control promotion which granted `create Estimate` but no matching `read`).
  { action: 'read',                 subject: 'Estimate',     allowedRoles: ['ADMIN','DISPATCHER','SALES','TECHNICIAN'] },
  // TECHNICIAN added by the technician-ownership spec, Part C (PR 3): a technician may raise a
  // STANDALONE estimate. Attaching one to an existing job is not a separate route - estimates carry
  // no job_id - so it lands on PATCH /api/jobs/:id's field-level manage_lines check instead.
  { action: 'create',               subject: 'Estimate',     allowedRoles: ['ADMIN','SALES','TECHNICIAN'] },
  { action: 'update',               subject: 'Estimate',     allowedRoles: ['ADMIN','SALES'] },
  { action: 'delete',               subject: 'Estimate',     allowedRoles: ['ADMIN','SALES'] },
  { action: 'send',                 subject: 'Estimate',     allowedRoles: ['ADMIN','SALES'] },
  { action: 'cancel',               subject: 'Estimate',     allowedRoles: ['ADMIN','SALES'] },
  { action: 'duplicate',            subject: 'Estimate',     allowedRoles: ['ADMIN','SALES'] },
  { action: 'revise',               subject: 'Estimate',     allowedRoles: ['ADMIN','SALES'] },
  { action: 'record_payment',       subject: 'Estimate',     allowedRoles: ['ADMIN','DISPATCHER'] },
  { action: 'waive_deposit',        subject: 'Estimate',     allowedRoles: ['ADMIN','DISPATCHER'] },
  // refund_deposit + reactivate_deposit folded into the unified Invoice refund (Phase 5).
  // Job
  { action: 'read',                 subject: 'Job',          allowedRoles: ['ADMIN','DISPATCHER','TECHNICIAN','SALES'] },
  // Technician-ownership spec, Part C (PR 3): `create Job` went from a per-user toggle back to a
  // TECHNICIAN role default, and delete/assign/unassign JOINED the role - all three conditioned on
  // `created_by_id`, i.e. reachable only on a job the technician made themselves. This matrix is
  // SUBJECT-level (defineAbilityFor + can(action, 'Job')), so it can only record that the role holds
  // the action at all; the row scope that makes it safe is proved through real requests in
  // job-creator-control.test.ts.
  { action: 'create',               subject: 'Job',          allowedRoles: ['ADMIN','DISPATCHER','TECHNICIAN'] },
  { action: 'update',               subject: 'Job',          allowedRoles: ['ADMIN','DISPATCHER','TECHNICIAN'] }, // Spec A D3 (2026-07-21): own-scoped technician default (notes + line items + job edits)
  { action: 'delete',               subject: 'Job',          allowedRoles: ['ADMIN','DISPATCHER','TECHNICIAN'] }, // creator-scoped; the invoice-bearing-job rule still blocks it
  // SALES joined 2026-09-01 (Sales-Role QA row 020, Ran's ruling): a rep first-books and crews
  // the job their OWN lead's estimate produced (OWN_JOB_VIA_ESTIMATE). This matrix is
  // subject-level, so it says WHICH VERBS - not whose names: SALES deliberately holds no
  // `assign User`, so a rep may put only THEMSELVES on that crew. Note SALES is still absent
  // from create/update/delete/reschedule Job above and below, and that is the boundary of the
  // ruling - `update Job` in particular would drag `manage_lines Job` along with it.
  { action: 'assign',               subject: 'Job',          allowedRoles: ['ADMIN','DISPATCHER','TECHNICIAN','SALES'] }, // creator-scoped for TECHNICIAN; estimate-scoped for SALES
  { action: 'unassign',             subject: 'Job',          allowedRoles: ['ADMIN','DISPATCHER','TECHNICIAN'] }, // creator-scoped
  { action: 'en_route',             subject: 'Job',          allowedRoles: ['ADMIN','DISPATCHER','TECHNICIAN'] }, // scheduling-notifications slice 10: own-scoped default, matching arrive and start
  { action: 'arrive',               subject: 'Job',          allowedRoles: ['ADMIN','DISPATCHER','TECHNICIAN'] }, // Spec A D3: own-scoped default; pre-grant for Spec B1's On Site node
  { action: 'start',                subject: 'Job',          allowedRoles: ['ADMIN','DISPATCHER','TECHNICIAN'] }, // Spec A D3: own-scoped default; pre-grant for Spec B1's Start button
  // Multi-visit S4 (D15/D7a): closing the JOB is a dispatcher/admin capability by default. A
  // technician closes their own VISIT instead, which rides the `start Job` gate. Existing orgs keep
  // the row they were seeded with - it is simply no longer a DEFAULT.
  { action: 'complete',             subject: 'Job',          allowedRoles: ['ADMIN','DISPATCHER'] },
  { action: 'cancel',               subject: 'Job',          allowedRoles: ['ADMIN','DISPATCHER'] },
  { action: 'reopen',               subject: 'Job',          allowedRoles: ['ADMIN'] },
  // Invoice
  { action: 'read',                 subject: 'Invoice',      allowedRoles: ['ADMIN','DISPATCHER','SALES'] }, // Phase B: tech lost default Invoice read (per-user toggle now)
  { action: 'create',               subject: 'Invoice',      allowedRoles: ['ADMIN','DISPATCHER'] }, // Phase B: tech create Invoice is now a per-user toggle
  { action: 'update',               subject: 'Invoice',      allowedRoles: ['ADMIN','DISPATCHER'] },
  { action: 'delete',               subject: 'Invoice',      allowedRoles: ['ADMIN','DISPATCHER'] },
  { action: 'send',                 subject: 'Invoice',      allowedRoles: ['ADMIN','DISPATCHER'] },
  { action: 'void',                 subject: 'Invoice',      allowedRoles: ['ADMIN'] },
  { action: 'refund',               subject: 'Invoice',      allowedRoles: ['ADMIN'] },
  { action: 'credit',               subject: 'Invoice',      allowedRoles: ['ADMIN'] },
  { action: 'void_payment',         subject: 'Invoice',      allowedRoles: ['ADMIN'] },
  { action: 'record_payment',       subject: 'Invoice',      allowedRoles: ['ADMIN','DISPATCHER'] }, // Phase B: tech on-site record_payment is now a per-user toggle
  // PriceBook — read opened to TECHNICIAN in Inventory P3 (catalog picker feed + my-van;
  // costs stay stripped via canSeePricing). Writes remain admin-only defaults.
  { action: 'read',                 subject: 'PriceBook',    allowedRoles: ['ADMIN','DISPATCHER','SALES','TECHNICIAN'] },
  { action: 'create',               subject: 'PriceBook',    allowedRoles: ['ADMIN'] },
  { action: 'update',               subject: 'PriceBook',    allowedRoles: ['ADMIN'] },
  { action: 'delete',               subject: 'PriceBook',    allowedRoles: ['ADMIN'] },
  // Tag
  { action: 'read',                 subject: 'Tag',          allowedRoles: ['ADMIN','DISPATCHER','SALES'] },
  { action: 'create',               subject: 'Tag',          allowedRoles: ['ADMIN','DISPATCHER','SALES'] },
  { action: 'update',               subject: 'Tag',          allowedRoles: ['ADMIN'] },
  { action: 'delete',               subject: 'Tag',          allowedRoles: ['ADMIN'] },
  // User
  { action: 'create',               subject: 'User',         allowedRoles: ['ADMIN'] },
  { action: 'read',                 subject: 'User',         allowedRoles: ['ADMIN', 'DISPATCHER', 'TECHNICIAN'] }, // ruled 2026-07-21: unconditional — crew names on the tech's own calendar
  { action: 'update',               subject: 'User',         allowedRoles: ['ADMIN'] },
  { action: 'delete',               subject: 'User',         allowedRoles: ['ADMIN'] },
  // Department
  { action: 'read',                 subject: 'Department',   allowedRoles: ['ADMIN','DISPATCHER','SALES','TECHNICIAN'] },
  { action: 'create',               subject: 'Department',   allowedRoles: ['ADMIN'] },
  { action: 'update',               subject: 'Department',   allowedRoles: ['ADMIN'] },
  { action: 'delete',               subject: 'Department',   allowedRoles: ['ADMIN'] },
  // Organization
  { action: 'read',                 subject: 'Organization', allowedRoles: ['ADMIN','DISPATCHER','SALES','TECHNICIAN'] },
  { action: 'update',               subject: 'Organization', allowedRoles: ['ADMIN'] },
  // Report
  { action: 'read',                 subject: 'Report',       allowedRoles: ['ADMIN','DISPATCHER'] },
  // Pricing (SRVW-140) - the dedicated grant canSeePricing keys on, written by the Roles UI
  // "See financial data" switch. SALES/DISPATCHER hold it by default (preserving exactly what they
  // saw the day before the repoint). TECHNICIAN joined them in the technician-ownership spec, Part
  // C: a technician who can add a line item to a job they created has to see what it costs and what
  // it sells for, and prices/totals/cost/margin are all this one grant.
  { action: 'read',                 subject: 'Pricing',      allowedRoles: ['ADMIN','DISPATCHER','SALES','TECHNICIAN'] },
  // StateTaxRate
  { action: 'read',                 subject: 'StateTaxRate', allowedRoles: ['ADMIN','DISPATCHER','SALES'] },
  // AppSetting
  { action: 'read',                 subject: 'AppSetting',   allowedRoles: ['ADMIN','DISPATCHER','SALES','TECHNICIAN'] },
  { action: 'update',               subject: 'AppSetting',   allowedRoles: ['ADMIN'] },
  // ServicePlan — admin + dispatcher only (sales/tech never see contracts)
  { action: 'read',                 subject: 'ServicePlan',  allowedRoles: ['ADMIN','DISPATCHER'] },
  { action: 'create',               subject: 'ServicePlan',  allowedRoles: ['ADMIN','DISPATCHER'] },
  { action: 'update',               subject: 'ServicePlan',  allowedRoles: ['ADMIN','DISPATCHER'] },
  { action: 'delete',               subject: 'ServicePlan',  allowedRoles: ['ADMIN','DISPATCHER'] },
  // Notification — all four roles (non-admins via conditional own-row grant)
  { action: 'read',                 subject: 'Notification', allowedRoles: ['ADMIN','DISPATCHER','SALES','TECHNICIAN'] },
  { action: 'update',               subject: 'Notification', allowedRoles: ['ADMIN','DISPATCHER','SALES','TECHNICIAN'] },
  { action: 'delete',               subject: 'Notification', allowedRoles: ['ADMIN','DISPATCHER','SALES','TECHNICIAN'] },
];

const ROLES = ['ADMIN', 'DISPATCHER', 'SALES', 'TECHNICIAN'] as const;

describe('CASL parity with legacy authorize() lists', () => {
  for (const route of ROUTE_PERMISSIONS) {
    for (const role of ROLES) {
      const shouldAllow = route.allowedRoles.includes(role);
      it(`${role} ${shouldAllow ? 'CAN' : 'CANNOT'} ${route.action} ${route.subject}`, () => {
        const grants = DEFAULT_GRANTS.filter(g => g.role === role);
        const ability = defineAbilityFor({ id: 'test-user-id', role }, grants);
        expect(ability.can(route.action as any, route.subject as any)).toBe(shouldAllow);
      });
    }
  }
});

// All four default roles hold `perform_walkthrough Lead` (asserted positively in the matrix above).
// This proves the inverse — a role WITHOUT the grant cannot — using a synthetic grant-less role so
// the assertion can't be vacuous against the four built-in roles that all happen to have it.
describe('perform_walkthrough Lead — a role without the grant CANNOT', () => {
  it('a custom role with NO grants cannot perform_walkthrough Lead', () => {
    const ability = defineAbilityFor({ id: 'test-user-id', role: 'CUSTOM_NO_GRANTS' }, []);
    expect(ability.can('perform_walkthrough' as any, 'Lead' as any)).toBe(false);
  });
});
