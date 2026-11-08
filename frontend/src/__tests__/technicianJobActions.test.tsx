import { describe, it, expect } from 'vitest';
import { buildAbility, canOnJob, type AbilityRule } from '@/lib/ability';

const TECH_ID = 'tech-1';
const OWN_JOB_COND = { assignees: { some: { user_id: TECH_ID } } };

// The EXACT rule shape the server ships for a technician (defineAbility emits conditional
// `can` rules; auth.controller serialises them straight to the client).
const technicianRules: AbilityRule[] = [
  { action: 'read', subject: 'Job', conditions: OWN_JOB_COND },
  { action: 'update', subject: 'Job', conditions: OWN_JOB_COND },
  { action: 'start', subject: 'Job', conditions: OWN_JOB_COND },
  { action: 'arrive', subject: 'Job', conditions: OWN_JOB_COND },
  { action: 'complete', subject: 'Job', conditions: OWN_JOB_COND },
] as AbilityRule[];

const dispatcherRules: AbilityRule[] = [
  { action: 'read', subject: 'Job' },
  { action: 'update', subject: 'Job' },
  { action: 'assign', subject: 'Job' },
  { action: 'complete', subject: 'Job' },
] as AbilityRule[];

const ownJob = { assignees: [{ user: { id: TECH_ID } }] };
const otherJob = { assignees: [{ user: { id: 'someone-else' } }] };
const unassignedJob = { assignees: [] };

// ── creation confers control (technician-ownership spec, Part C) ────────────────────────────────
// The server ships TWO scope shapes for a technician now, and the UI has to be able to tell them
// apart or it offers buttons the API refuses (and hides ones it would allow):
//   read/update  { OR: [ own-job, created-by-me ] }   assigned OR created
//   manage_lines / assign / unassign / delete  { created_by_id }   created only
const CREATED_BY_ME_COND = { created_by_id: TECH_ID };
const OWN_OR_CREATED_COND = { OR: [OWN_JOB_COND, CREATED_BY_ME_COND] };

const creatorRules: AbilityRule[] = [
  { action: 'read', subject: 'Job', conditions: OWN_OR_CREATED_COND },
  { action: 'update', subject: 'Job', conditions: OWN_JOB_COND },
  { action: 'complete', subject: 'Job', conditions: OWN_JOB_COND },
  { action: 'manage_lines', subject: 'Job', conditions: CREATED_BY_ME_COND },
  { action: 'assign', subject: 'Job', conditions: CREATED_BY_ME_COND },
  { action: 'unassign', subject: 'Job', conditions: CREATED_BY_ME_COND },
  { action: 'delete', subject: 'Job', conditions: CREATED_BY_ME_COND },
] as AbilityRule[];

/** Assigned to the technician, made by somebody else. */
const assignedNotCreated = { assignees: [{ user: { id: TECH_ID } }], created_by_id: 'someone-else' };
/** Made by the technician, who has since been taken off the crew. The permanence case. */
const createdNotAssigned = { assignees: [], created_by_id: TECH_ID };
/** Neither. */
const foreignJob = { assignees: [{ user: { id: 'someone-else' } }], created_by_id: 'someone-else' };

describe('canOnJob - creation confers control', () => {
  const ability = () => buildAbility(creatorRules);

  it.each(['manage_lines', 'assign', 'unassign', 'delete'] as const)(
    'refuses %s on a job the technician is assigned to but did not create',
    (verb) => {
      expect(canOnJob(ability(), verb, assignedNotCreated, TECH_ID)).toBe(false);
    },
  );

  it.each(['manage_lines', 'assign', 'unassign', 'delete'] as const)(
    'permits %s on a job the technician created but is NOT assigned to',
    (verb) => {
      expect(canOnJob(ability(), verb, createdNotAssigned, TECH_ID)).toBe(true);
    },
  );

  it('still permits the work verbs on an assigned job they did not create', () => {
    expect(canOnJob(ability(), 'complete', assignedNotCreated, TECH_ID)).toBe(true);
    expect(canOnJob(ability(), 'update', assignedNotCreated, TECH_ID)).toBe(true);
  });

  it('satisfies an OR grant through EITHER branch', () => {
    expect(canOnJob(ability(), 'read', assignedNotCreated, TECH_ID)).toBe(true);
    expect(canOnJob(ability(), 'read', createdNotAssigned, TECH_ID)).toBe(true);
  });

  it('refuses everything on a job that is neither theirs to work nor theirs to control', () => {
    for (const verb of ['read', 'update', 'complete', 'manage_lines', 'assign', 'unassign', 'delete'] as const) {
      expect(canOnJob(ability(), verb, foreignJob, TECH_ID), verb).toBe(false);
    }
  });

  it('treats a missing created_by_id as "not the creator", never as a match', () => {
    // Legacy rows carry created_by_id: null (the column is newer than the data). A null-vs-undefined
    // slip here would hand every technician the creator surface on every pre-migration job.
    expect(canOnJob(ability(), 'delete', { assignees: [], created_by_id: null }, TECH_ID)).toBe(false);
    expect(canOnJob(ability(), 'delete', { assignees: [] }, TECH_ID)).toBe(false);
  });
});

describe('the CASL matcher hazard this helper exists for', () => {
  it('documents that a naive instance check is BROKEN for conditional grants', () => {
    // If this ever starts returning true, @casl/ability learned to evaluate Prisma's `some`
    // and canOnJob's conjunct could be simplified. Until then, do not use ability.can(verb, job).
    const ability = buildAbility(technicianRules);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(ability.can('complete', { __caslSubjectType__: 'Job', ...ownJob } as any)).toBe(false);
  });
});

describe('canOnJob', () => {
  it('permits an own-scoped verb on an assigned job', () => {
    const ability = buildAbility(technicianRules);
    for (const verb of ['update', 'start', 'arrive', 'complete'] as const) {
      expect(canOnJob(ability, verb, ownJob, TECH_ID)).toBe(true);
    }
  });

  it('refuses an own-scoped verb on another crew’s job', () => {
    const ability = buildAbility(technicianRules);
    for (const verb of ['update', 'start', 'complete'] as const) {
      expect(canOnJob(ability, verb, otherJob, TECH_ID)).toBe(false);
    }
  });

  it('refuses a verb the technician holds no rule for at all', () => {
    expect(canOnJob(buildAbility(technicianRules), 'assign', ownJob, TECH_ID)).toBe(false);
    expect(canOnJob(buildAbility(technicianRules), 'delete', ownJob, TECH_ID)).toBe(false);
  });

  it('grants an unconditional holder authority on ANY job, assigned or not', () => {
    const ability = buildAbility(dispatcherRules);
    expect(canOnJob(ability, 'complete', otherJob, 'dispatcher-1')).toBe(true);
    expect(canOnJob(ability, 'assign', unassignedJob, 'dispatcher-1')).toBe(true);
  });

  it('refuses an own-scoped verb on an unassigned job', () => {
    expect(canOnJob(buildAbility(technicianRules), 'complete', unassignedJob, TECH_ID)).toBe(false);
  });

  it('tolerates a job whose assignees are missing or null', () => {
    const ability = buildAbility(technicianRules);
    expect(canOnJob(ability, 'complete', { assignees: null }, TECH_ID)).toBe(false);
    expect(canOnJob(ability, 'complete', {}, TECH_ID)).toBe(false);
  });

  it('respects a DENY override — the button must not render when the API will 403', () => {
    // An admin toggling OFF a capability for one user emits an unconditional `cannot`
    // layered over the role's conditional `can`. Scanning rulesFor alone sees the allow
    // rule and returns true; the API returns 403. This is the case the type-level
    // short-circuit exists for.
    const denied = buildAbility([
      ...technicianRules,
      { action: 'complete', subject: 'Job', inverted: true },
    ] as AbilityRule[]);
    expect(denied.can('complete', 'Job')).toBe(false);
    expect(canOnJob(denied, 'complete', ownJob, TECH_ID)).toBe(false);
  });

  it('respects a DENY override for an unconditional holder too', () => {
    const deniedDispatcher = buildAbility([
      ...dispatcherRules,
      { action: 'delete', subject: 'Job', inverted: true },
    ] as AbilityRule[]);
    expect(canOnJob(deniedDispatcher, 'delete', otherJob, 'dispatcher-1')).toBe(false);
  });
});
