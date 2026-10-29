import { describe, it, expect } from 'vitest';
import { subject } from '@casl/ability';
import { defineAbilityFor } from '../lib/permissions/defineAbility';

// RBAC Phase B (technician redesign): per-user ALLOW overrides for the expanded managed
// capability set are FIXED own-scoped. The override DB row stays bare (action+subject+effect);
// defineAbilityFor looks the OWN_* condition up from USER_CAPABILITIES at build time and emits
// a CONDITIONAL `can` (own only). A write capability with `impliesRead` also emits the paired
// own-scoped `read <subject>` so the grantee can see what they create/edit (scopeWhereFor
// derives a subject's row-scope solely from its read grant).
//
// A bare-subject `can(action, subject)` STILL returns true for a conditional rule (CASL treats a
// conditional rule as applicable when no fields are forced) — that is the route-guard contract
// (canDo). Row-level truth is asserted with subject('X', row) instances.
//
// `{{userId}}` is substituted to the user's id by defineAbilityFor (via substituteConditions).
const TECH_ID = 'tech-1';
const tech = { id: TECH_ID, role: 'TECHNICIAN' };

// Row fixtures shaped like the Prisma payloads the OWN_* conditions match against.
// NOTE: only FLAT top-level `{ some: ... }` conditions (OWN_LEAD on Lead, OWN_JOB on Job) can be
// evaluated via CASL's in-memory matcher `ability.can(action, subject(row))`. NESTED to-many
// conditions (Estimate→lead.lead_assignees, Invoice→job.assignees) make the @casl/prisma
// in-memory matcher THROW (the documented "@ucast nested to-many" limit — real enforcement of
// those goes through SQL `canAccessRow`/`scopeWhereFor`, never the in-memory matcher). So for the
// nested subjects we assert on the emitted RULE CONDITIONS (the real, substituted own-condition
// that SQL enforcement consumes) instead of calling the throwing in-memory matcher.
const ownLead = { lead_assignees: [{ user_id: TECH_ID }] };
const otherLead = { lead_assignees: [{ user_id: 'someone-else' }] };
// S8 (D6): OWN_JOB reaches crew through the trips, so the fixture row does too.
const ownJob = { visits: [{ assignees: [{ user_id: TECH_ID }] }] };
const otherJob = { visits: [{ assignees: [{ user_id: 'someone-else' }] }] };

// Substituted own-condition shapes the emitted rules should carry (what SQL enforcement reads).
const ESTIMATE_OWN = { lead: { lead_assignees: { some: { user_id: TECH_ID } } } };
const INVOICE_OWN = { job: { visits: { some: { assignees: { some: { user_id: TECH_ID } } } } } };

function ruleConds(ability: ReturnType<typeof defineAbilityFor>, action: string, subj: string) {
  return ability.rules.find((r) => r.subject === subj && r.action === action && !r.inverted)?.conditions;
}

describe('per-user ALLOW override — fixed own-scope (Phase B)', () => {
  describe('create Estimate (own = via parent lead — nested, SQL-enforced)', () => {
    it('a tech WITH the override gets own-scoped create + the paired own-scoped read', () => {
      const ability = defineAbilityFor(tech, [], [
        { action: 'create', subject: 'Estimate', effect: 'allow' },
      ]);

      // Route-guard contract: bare-subject can(...) passes for the conditional rule.
      expect(ability.can('create', 'Estimate')).toBe(true);
      expect(ability.can('read', 'Estimate')).toBe(true);

      // Both emitted rules carry the substituted nested own-condition (what SQL canAccessRow /
      // scopeWhereFor consume to scope create-parent + read to the tech's own lead).
      expect(ruleConds(ability, 'create', 'Estimate')).toEqual(ESTIMATE_OWN);
      expect(ruleConds(ability, 'read', 'Estimate')).toEqual(ESTIMATE_OWN); // impliesRead
    });

    it('a tech WITHOUT the override cannot create or read estimates', () => {
      const ability = defineAbilityFor(tech, [], []);
      expect(ability.can('create', 'Estimate')).toBe(false);
      expect(ability.can('read', 'Estimate')).toBe(false);
      expect(ruleConds(ability, 'create', 'Estimate')).toBeUndefined();
      expect(ruleConds(ability, 'read', 'Estimate')).toBeUndefined();
    });

    it('the emitted create rule is conditional (not unconditional) and not inverted', () => {
      const ability = defineAbilityFor(tech, [], [
        { action: 'create', subject: 'Estimate', effect: 'allow' },
      ]);
      const rule = ability.rules.find((r) => r.subject === 'Estimate' && r.action === 'create');
      expect(rule).toBeTruthy();
      expect(rule?.inverted).toBeFalsy();
      expect(rule?.conditions).toEqual(ESTIMATE_OWN);
    });
  });

  describe('update Lead (own = OWN_LEAD)', () => {
    it('own-scoped update + paired read; another rep’s lead is denied', () => {
      const ability = defineAbilityFor(tech, [], [
        { action: 'update', subject: 'Lead', effect: 'allow' },
      ]);
      expect(ability.can('update', subject('Lead', ownLead) as any)).toBe(true);
      expect(ability.can('update', subject('Lead', otherLead) as any)).toBe(false);
      expect(ability.can('read', subject('Lead', ownLead) as any)).toBe(true);
      expect(ability.can('read', subject('Lead', otherLead) as any)).toBe(false);
    });
  });

  describe('en_route Job (own = OWN_JOB, advance verb)', () => {
    it('own-scoped advance + paired own-scoped read Job', () => {
      const ability = defineAbilityFor(tech, [], [
        { action: 'en_route', subject: 'Job', effect: 'allow' },
      ]);
      // Route guard passes.
      expect(ability.can('en_route', 'Job')).toBe(true);
      // Row truth.
      expect(ability.can('en_route', subject('Job', ownJob) as any)).toBe(true);
      expect(ability.can('en_route', subject('Job', otherJob) as any)).toBe(false);
      // Paired read materialized (impliesRead).
      expect(ability.can('read', subject('Job', ownJob) as any)).toBe(true);
      expect(ability.can('read', subject('Job', otherJob) as any)).toBe(false);
    });
  });

  describe('record_payment Invoice (own = OWN_INVOICE_VIA_JOB — nested, SQL-enforced)', () => {
    it('own-scoped record_payment + paired own-scoped read Invoice', () => {
      const ability = defineAbilityFor(tech, [], [
        { action: 'record_payment', subject: 'Invoice', effect: 'allow' },
      ]);
      // Route guard passes for the conditional rule.
      expect(ability.can('record_payment', 'Invoice')).toBe(true);
      // Both rules carry the substituted nested own-condition (job.assignees ∋ me).
      expect(ruleConds(ability, 'record_payment', 'Invoice')).toEqual(INVOICE_OWN);
      expect(ruleConds(ability, 'read', 'Invoice')).toEqual(INVOICE_OWN); // impliesRead
    });
  });

  describe('DENY override still blocks (unconditional cannot wins)', () => {
    it('deny en_route Job blocks even on an own job', () => {
      // role grants en_route Job (own); a deny override revokes it entirely.
      const ability = defineAbilityFor(
        tech,
        [{ action: 'en_route', subject: 'Job', conditions: { visits: { some: { assignees: { some: { user_id: '{{userId}}' } } } } } }],
        [{ action: 'en_route', subject: 'Job', effect: 'deny' }],
      );
      expect(ability.can('en_route', 'Job')).toBe(false);
      expect(ability.can('en_route', subject('Job', ownJob) as any)).toBe(false);
    });

    it('deny create Invoice blocks even with a role create grant', () => {
      const ability = defineAbilityFor(
        tech,
        [{ action: 'create', subject: 'Invoice' }],
        [{ action: 'create', subject: 'Invoice', effect: 'deny' }],
      );
      expect(ability.can('create', 'Invoice')).toBe(false);
    });
  });

  describe('create Invoice (previously-shipped capability is now own-scoped — nested, SQL-enforced)', () => {
    it('allow create Invoice is own-scoped (no longer org-wide) + paired read', () => {
      const ability = defineAbilityFor(tech, [], [
        { action: 'create', subject: 'Invoice', effect: 'allow' },
      ]);
      // Route guard passes.
      expect(ability.can('create', 'Invoice')).toBe(true);
      // Previously emitted a BARE (org-wide) `can` — now carries the nested own-condition, so
      // create is scoped to the tech's own job (controller does the real parent-check on create).
      expect(ruleConds(ability, 'create', 'Invoice')).toEqual(INVOICE_OWN);
      expect(ruleConds(ability, 'read', 'Invoice')).toEqual(INVOICE_OWN); // impliesRead (paired)
    });
  });

  describe('location_restricted Inventory (P3 — a restriction FLAG, zero scope widening)', () => {
    it('the allow emits an unconditional can (org-wide flag, no ownCondition)', () => {
      const ability = defineAbilityFor(tech, [], [
        { action: 'location_restricted', subject: 'Inventory', effect: 'allow' },
      ]);
      expect(ability.can('location_restricted', 'Inventory')).toBe(true);
      const rule = ability.rules.find(
        (r) => r.subject === 'Inventory' && r.action === 'location_restricted' && !r.inverted,
      );
      expect(rule).toBeTruthy();
      expect(rule?.conditions).toBeUndefined();
    });

    it('synthesizes NO paired read (no impliesRead) — read Inventory stays denied', () => {
      const ability = defineAbilityFor(tech, [], [
        { action: 'location_restricted', subject: 'Inventory', effect: 'allow' },
      ]);
      expect(ability.can('read', 'Inventory')).toBe(false);
      expect(ruleConds(ability, 'read', 'Inventory')).toBeUndefined();
      expect(ability.rules.some((r) => r.subject === 'Inventory' && r.action === 'read')).toBe(false);
    });

    it('a tech WITHOUT the row does not carry the flag', () => {
      const ability = defineAbilityFor(tech, [], []);
      expect(ability.can('location_restricted', 'Inventory')).toBe(false);
    });
  });

  describe('ADMIN immunity', () => {
    it('an ALLOW override does not change ADMIN (already manage all)', () => {
      const ability = defineAbilityFor({ id: 'a1', role: 'ADMIN' }, [], [
        { action: 'create', subject: 'Estimate', effect: 'allow' },
      ]);
      // manage all — unconditional; no own-scoped override rule is layered for an admin.
      expect(ability.can('create', 'Estimate')).toBe(true);
      expect(ability.rules.every((r) => r.subject === 'all')).toBe(true);
    });
  });
});
