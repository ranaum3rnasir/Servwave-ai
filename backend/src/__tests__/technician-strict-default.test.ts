import { describe, it, expect } from 'vitest';
import { subject } from '@casl/ability';
import { defineAbilityFor } from '../lib/permissions/defineAbility';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { isCatalogEntry } from '../lib/permissions/catalog';

// Phase B — strict technician default (RBAC).
// A technician by default can: read their own job, close it out (`complete`, own job only),
// read + perform the walkthrough on their assigned lead, upload/download attachments, and the
// infra reads the app shell needs. `perform_walkthrough` is a NEW narrow capability that
// replaces the broad `update Lead` a tech used to hold via OWN_WALKTHROUGH ("the only thing a
// tech does on a lead"). `complete Job` (own job) was restored as a role default so a tech can
// close out their own work directly. Everything else (create/update Job·Invoice·Lead, the
// record_payment) remains removed from the role default and is an opt-in per-user toggle. The
// visit milestone verbs en_route/arrive/start are own-scoped role defaults again (Spec A D3 and
// scheduling-notifications slice 10).

const TECH_ID = 'tech-1';

function techAbility() {
  return defineAbilityFor(
    { id: TECH_ID, role: 'TECHNICIAN' },
    DEFAULT_GRANTS.filter((g) => g.role === 'TECHNICIAN'),
  );
}

// owned / not-owned subject instances (the conditional grants use the assignment join tokens)
// S8 (D6): OWN_JOB reaches crew through the job's trips.
const ownJob = subject('Job', { visits: [{ assignees: [{ user_id: TECH_ID }] }] }) as any;
const otherJob = subject('Job', { visits: [{ assignees: [{ user_id: 'someone-else' }] }] }) as any;
// Walkthrough-as-entity redesign, PR-B2: OWN_WALKTHROUGH is now a nested relation through the
// visits -> assignees join (defaultGrants.ts), not a direct visit_assignees
// relation on Lead.
const ownWalkLead = subject('Lead', { visits: [{ assignees: [{ user_id: TECH_ID }] }] }) as any;
const otherWalkLead = subject('Lead', { visits: [{ assignees: [{ user_id: 'someone-else' }] }] }) as any;

describe('catalog — perform_walkthrough Lead', () => {
  it('perform_walkthrough Lead is a valid catalog entry', () => {
    expect(isCatalogEntry('perform_walkthrough', 'Lead')).toBe(true);
  });
});

describe('strict TECHNICIAN default - what a tech CAN do', () => {
  it('reads their own assigned job', () => {
    expect(techAbility().can('read', ownJob)).toBe(true);
  });

  it('reads their own walkthrough lead', () => {
    expect(techAbility().can('read', ownWalkLead)).toBe(true);
  });

  it('performs the walkthrough on their own walkthrough lead', () => {
    expect(techAbility().can('perform_walkthrough', ownWalkLead)).toBe(true);
  });

  it('perform_walkthrough passes the bare-subject route guard (canDo contract)', () => {
    // canDo('perform_walkthrough','Lead') checks can(action, subject) with no instance;
    // a conditional rule is still "applicable" to a bare subject, so the route guard passes
    // and the controller does the ownership narrowing.
    expect(techAbility().can('perform_walkthrough', 'Lead')).toBe(true);
  });

  it('creates and reads attachments', () => {
    const ability = techAbility();
    expect(ability.can('create', 'Attachment')).toBe(true);
    expect(ability.can('read', 'Attachment')).toBe(true);
  });

  it('keeps the infra reads the app shell needs', () => {
    const ability = techAbility();
    expect(ability.can('read', 'Department')).toBe(true);
    expect(ability.can('read', 'AppSetting')).toBe(true);
    expect(ability.can('read', 'Organization')).toBe(true);
  });

  // Multi-visit S4 (D15/D7a): closing the JOB stopped being a technician default. It is now
  // dispatcher/admin by default, an admin-grantable per-org row for anyone else, and what a
  // technician actually closes is their own VISIT (which rides the `start Job` gate they keep).
  // Orgs provisioned before this keep the row they were seeded with - see PRESERVED_ON_RESET.
  it('does NOT close out a job by default, even one assigned to them', () => {
    expect(techAbility().can('complete', ownJob)).toBe(false);
  });

  it('cannot complete a job they are not assigned to either', () => {
    expect(techAbility().can('complete', otherJob)).toBe(false);
  });

  // `create Job` moved BACK to a role default in the technician-ownership spec, Part C (PR 3). This
  // file is ability-level, so it can only assert the capability itself. The two properties that make
  // it safe - the creator is AUTO-ASSIGNED, and the job stays theirs via `created_by_id` afterwards -
  // need real requests and are proved in phaseB-controllers-job-create-ownership.test.ts and
  // job-creator-control.test.ts respectively. Deliberately not claimed here.
  it('CAN create a Job (role default since PR 3)', () => {
    expect(techAbility().can('create', 'Job')).toBe(true);
  });
});

describe('strict TECHNICIAN default - what a tech CANNOT do', () => {
  it('cannot create or read an Invoice', () => {
    const ability = techAbility();
    expect(ability.can('create', 'Invoice')).toBe(false);
    expect(ability.can('read', 'Invoice')).toBe(false);
    // not even on a job they own — the grant is gone entirely
    const ownInvoice = subject('Invoice', { job: { assignees: [{ user_id: TECH_ID }] } }) as any;
    expect(ability.can('read', ownInvoice)).toBe(false);
  });

  it('cannot record_payment', () => {
    const ownInvoice = subject('Invoice', { job: { assignees: [{ user_id: TECH_ID }] } }) as any;
    expect(techAbility().can('record_payment', ownInvoice)).toBe(false);
  });

  it("cannot en_route another crew's Job (the verb is a role default now, but own-scoped)", () => {
    // update/start/arrive became TECHNICIAN role defaults in the main-app migration
    // (Spec A D3, 2026-07-21) and are asserted in technician-main-app.test.ts. `en_route` joined
    // them as an own-scoped default in scheduling-notifications slice 10 (asserted in
    // permissions-technician-en-route-backfill.test.ts); what stays true is that the scope never
    // reaches a job the technician is not crewed on.
    expect(techAbility().can('en_route', ownJob)).toBe(true);
    expect(techAbility().can('en_route', otherJob)).toBe(false);
  });

  it('cannot do general update Lead (the broad grant is replaced by perform_walkthrough)', () => {
    const ability = techAbility();
    // bare-subject route-guard check (how canDo('update','Lead') gates note/tag/edit routes)
    expect(ability.can('update', 'Lead')).toBe(false);
    // not even on their own walkthrough lead — update Lead is gone, only perform_walkthrough remains
    expect(ability.can('update', ownWalkLead)).toBe(false);
  });

  it('cannot delete an Attachment', () => {
    expect(techAbility().can('delete', 'Attachment')).toBe(false);
  });

  it('cannot reach another person\'s job or walkthrough lead', () => {
    const ability = techAbility();
    expect(ability.can('read', otherJob)).toBe(false);
    expect(ability.can('read', otherWalkLead)).toBe(false);
    expect(ability.can('perform_walkthrough', otherWalkLead)).toBe(false);
  });
});

describe('SALES + DISPATCHER retain walkthrough access via perform_walkthrough', () => {
  it('SALES has own-scoped perform_walkthrough Lead', () => {
    const grants = DEFAULT_GRANTS.filter((g) => g.role === 'SALES');
    const ability = defineAbilityFor({ id: 'sales-1', role: 'SALES' }, grants);
    const ownLead = subject('Lead', { lead_assignees: [{ user_id: 'sales-1' }] }) as any;
    const otherLead = subject('Lead', { lead_assignees: [{ user_id: 'x' }] }) as any;
    expect(ability.can('perform_walkthrough', ownLead)).toBe(true);
    expect(ability.can('perform_walkthrough', otherLead)).toBe(false);
    // the row exists and is own-scoped (conditions present)
    const grant = grants.find((g) => g.action === 'perform_walkthrough' && g.subject === 'Lead');
    expect(grant).toBeDefined();
    expect((grant as any).conditions).toBeDefined();
  });

  it('DISPATCHER has unconditional perform_walkthrough Lead', () => {
    const grants = DEFAULT_GRANTS.filter((g) => g.role === 'DISPATCHER');
    const ability = defineAbilityFor({ id: 'disp-1', role: 'DISPATCHER' }, grants);
    expect(ability.can('perform_walkthrough', 'Lead')).toBe(true);
    const grant = grants.find((g) => g.action === 'perform_walkthrough' && g.subject === 'Lead');
    expect(grant).toBeDefined();
    expect((grant as any).conditions).toBeUndefined();
  });
});
