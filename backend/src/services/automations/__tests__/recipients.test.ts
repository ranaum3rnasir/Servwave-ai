import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../../../lib/prisma';
import {
  audiencesForEntity,
  audienceLabel,
  resolveAudience,
  type AudienceContext,
  type RecipientKey,
} from '../recipients';
import type { RecipientUser } from '../executors';

const mockPrisma = prisma as any;
const ORG = '00000000-0000-0000-0000-000000000001';

function user(overrides: Partial<RecipientUser> = {}): RecipientUser {
  return { id: 'u1', email: 'u1@org.com', first_name: 'Ann', last_name: 'Lee', phone: '+15550000001', ...overrides };
}

function ctx(overrides: Partial<AudienceContext> = {}): AudienceContext {
  return {
    organizationId: ORG,
    entity: 'job',
    customer: { id: 'c1', email: 'cust@example.com' },
    assignees: [],
    // Only a task has watchers; every other entity's list is structurally empty.
    watchers: [],
    dispatcher: null,
    salesperson: null,
    creator: null,
    eventRecipient: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── audiencesForEntity ──────────────────────────────────────────────────────

describe('audiencesForEntity', () => {
  it('job → customer, assigned_team, dispatcher, salesperson, all_admins, all_dispatchers, specific_user', () => {
    expect(audiencesForEntity('job')).toEqual([
      'customer',
      'assigned_team',
      'dispatcher',
      'salesperson',
      'all_admins',
      'all_dispatchers',
      'specific_user',
    ]);
  });

  it('lead → drops dispatcher, keeps salesperson + assigned_team', () => {
    expect(audiencesForEntity('lead')).toEqual([
      'customer',
      'assigned_team',
      'salesperson',
      'all_admins',
      'all_dispatchers',
      'specific_user',
    ]);
  });

  it('estimate → creator + salesperson, no dispatcher / assigned_team', () => {
    expect(audiencesForEntity('estimate')).toEqual([
      'customer',
      'creator',
      'salesperson',
      'all_admins',
      'all_dispatchers',
      'specific_user',
    ]);
  });

  it('invoice → customer + admins/dispatchers/specific only (salesperson dropped)', () => {
    expect(audiencesForEntity('invoice')).toEqual([
      'customer',
      'all_admins',
      'all_dispatchers',
      'specific_user',
    ]);
  });

  it('task → the two task-people audiences, creator, admins/dispatchers/specific - never the customer', () => {
    expect(audiencesForEntity('task')).toEqual([
      'assignees',
      'watchers',
      'creator',
      'all_admins',
      'all_dispatchers',
      'specific_user',
    ]);
    expect(audiencesForEntity('task')).not.toContain('customer');
  });

  it('offers assignees/watchers ONLY on task - they mean nothing on the other four', () => {
    for (const e of ['job', 'lead', 'estimate', 'invoice'] as const) {
      expect(audiencesForEntity(e)).not.toContain('assignees');
      expect(audiencesForEntity(e)).not.toContain('watchers');
    }
  });

  it('never includes custom (custom is added at SEND_EMAIL validation time, not here)', () => {
    for (const e of ['job', 'lead', 'estimate', 'invoice', 'task'] as const) {
      expect(audiencesForEntity(e)).not.toContain('custom');
    }
  });

  it('returns a fresh array (callers cannot mutate the shared source of truth)', () => {
    const a = audiencesForEntity('job');
    a.push('custom');
    expect(audiencesForEntity('job')).not.toContain('custom');
  });
});

// ── audienceLabel ───────────────────────────────────────────────────────────

describe('audienceLabel', () => {
  it('assigned_team differs per entity: walkthrough team for lead, assigned crew otherwise', () => {
    expect(audienceLabel('assigned_team', 'lead')).toBe('the walkthrough team');
    expect(audienceLabel('assigned_team', 'job')).toBe('the assigned crew');
    expect(audienceLabel('assigned_team', 'estimate')).toBe('the assigned crew');
    expect(audienceLabel('assigned_team', 'invoice')).toBe('the assigned crew');
  });

  it('renders plain-English labels for every other key', () => {
    expect(audienceLabel('customer', 'job')).toBe('the customer');
    expect(audienceLabel('dispatcher', 'job')).toBe('the dispatcher');
    expect(audienceLabel('salesperson', 'job')).toBe('the salesperson');
    expect(audienceLabel('creator', 'estimate')).toBe('the creator');
    expect(audienceLabel('all_admins', 'job')).toBe('all admins');
    expect(audienceLabel('all_dispatchers', 'job')).toBe('all dispatchers');
    expect(audienceLabel('specific_user', 'job')).toBe('a specific person');
    expect(audienceLabel('custom', 'job')).toBe('a custom email');
  });

  it('removed_user differs per entity: removed technician for job, removed performer for lead', () => {
    expect(audienceLabel('removed_user', 'job')).toBe('the removed technician');
    expect(audienceLabel('removed_user', 'lead')).toBe('the removed performer');
  });

  it('assigned_user differs per entity: the assigned technician for job, the assigned performer for lead', () => {
    expect(audienceLabel('assigned_user', 'job')).toBe('the assigned technician');
    expect(audienceLabel('assigned_user', 'lead')).toBe('the assigned performer');
  });
});

// ── resolveAudience — customer ──────────────────────────────────────────────

describe('resolveAudience — customer', () => {
  it('returns the customer email when present', async () => {
    const r = await resolveAudience('customer', ctx({ customer: { id: 'c1', email: 'a@b.com' } }));
    expect(r).toEqual({ users: [], emails: ['a@b.com'] });
  });

  it('skips with the plain-English reason when the customer has no email', async () => {
    const r = await resolveAudience('customer', ctx({ customer: { id: 'c1', email: null } }));
    expect(r.emails).toEqual([]);
    expect(r.skipReason).toBe('The customer has no email address on file');
  });

  it('skips when there is no customer at all (never throws)', async () => {
    const r = await resolveAudience('customer', ctx({ customer: null }));
    expect(r.skipReason).toBe('The customer has no email address on file');
  });

  // ── extra_emails[] — opted-in secondary addresses ─────────────────────────
  // context.ts pre-filters to receives_emails:true rows, so anything reaching
  // this resolver is already opted in; the resolver only merges and dedupes.

  it('appends opted-in extra emails after the primary', async () => {
    const r = await resolveAudience(
      'customer',
      ctx({ customer: { id: 'c1', email: 'a@b.com', extra_emails: [{ email: 'ops@b.com' }] } }),
    );
    expect(r).toEqual({ users: [], emails: ['a@b.com', 'ops@b.com'] });
  });

  it('preserves the order the extras arrive in', async () => {
    const r = await resolveAudience(
      'customer',
      ctx({
        customer: {
          id: 'c1',
          email: 'a@b.com',
          extra_emails: [{ email: 'ops@b.com' }, { email: 'billing@b.com' }],
        },
      }),
    );
    expect(r.emails).toEqual(['a@b.com', 'ops@b.com', 'billing@b.com']);
  });

  it('sends to the extras when the customer has no primary email', async () => {
    const r = await resolveAudience(
      'customer',
      ctx({ customer: { id: 'c1', email: null, extra_emails: [{ email: 'ops@b.com' }] } }),
    );
    expect(r.emails).toEqual(['ops@b.com']);
    expect(r.skipReason).toBeUndefined();
  });

  it('dedupes an extra that repeats the primary, case- and whitespace-insensitively', async () => {
    const r = await resolveAudience(
      'customer',
      ctx({
        customer: {
          id: 'c1',
          email: 'a@b.com',
          extra_emails: [{ email: ' A@B.com ' }, { email: 'ops@b.com' }, { email: 'OPS@b.com' }],
        },
      }),
    );
    expect(r.emails).toEqual(['a@b.com', 'ops@b.com']);
  });

  it('ignores blank extra rows rather than emailing an empty address', async () => {
    const r = await resolveAudience(
      'customer',
      ctx({ customer: { id: 'c1', email: 'a@b.com', extra_emails: [{ email: '   ' }] } }),
    );
    expect(r.emails).toEqual(['a@b.com']);
  });

  it('still skips when the primary is absent and every extra is opted out (empty array)', async () => {
    const r = await resolveAudience('customer', ctx({ customer: { id: 'c1', email: null, extra_emails: [] } }));
    expect(r.emails).toEqual([]);
    expect(r.skipReason).toBe('The customer has no email address on file');
  });
});

// ── resolveAudience — assigned_team (+ legacy alias) ────────────────────────

describe('resolveAudience — assigned_team', () => {
  it('returns the crew for a job ctx', async () => {
    const crew = [user({ id: 'u1' }), user({ id: 'u2' })];
    const r = await resolveAudience('assigned_team', ctx({ entity: 'job', assignees: crew }));
    expect(r).toEqual({ users: crew, emails: [] });
  });

  it('returns the walkthrough performers for a lead ctx', async () => {
    const performers = [user({ id: 'p1' })];
    const r = await resolveAudience('assigned_team', ctx({ entity: 'lead', assignees: performers }));
    expect(r).toEqual({ users: performers, emails: [] });
  });

  it('empty job → "No one is assigned to this job yet"', async () => {
    const r = await resolveAudience('assigned_team', ctx({ entity: 'job', assignees: [] }));
    expect(r.users).toEqual([]);
    expect(r.skipReason).toBe('No one is assigned to this job yet');
  });

  it('empty lead → "No walkthrough team is assigned yet"', async () => {
    const r = await resolveAudience('assigned_team', ctx({ entity: 'lead', assignees: [] }));
    expect(r.skipReason).toBe('No walkthrough team is assigned yet');
  });

  it('legacy "assigned_techs" resolves IDENTICALLY to "assigned_team" (job crew)', async () => {
    const crew = [user({ id: 'u1' })];
    const legacy = await resolveAudience('assigned_techs', ctx({ entity: 'job', assignees: crew }));
    const canonical = await resolveAudience('assigned_team', ctx({ entity: 'job', assignees: crew }));
    expect(legacy).toEqual(canonical);
    expect(legacy).toEqual({ users: crew, emails: [] });
  });

  it('legacy "assigned_techs" empty lead → same walkthrough skipReason', async () => {
    const r = await resolveAudience('assigned_techs', ctx({ entity: 'lead', assignees: [] }));
    expect(r.skipReason).toBe('No walkthrough team is assigned yet');
  });
});

// ── resolveAudience — dispatcher / salesperson / creator ────────────────────

describe('resolveAudience — dispatcher / salesperson / creator', () => {
  it('dispatcher present → that user', async () => {
    const d = user({ id: 'd1' });
    expect(await resolveAudience('dispatcher', ctx({ dispatcher: d }))).toEqual({ users: [d], emails: [] });
  });

  it('dispatcher null → "No dispatcher is assigned to this job"', async () => {
    const r = await resolveAudience('dispatcher', ctx({ dispatcher: null }));
    expect(r.skipReason).toBe('No dispatcher is assigned to this job');
  });

  it('salesperson present → that user; null → "No salesperson is assigned"', async () => {
    const s = user({ id: 's1' });
    expect(await resolveAudience('salesperson', ctx({ salesperson: s }))).toEqual({ users: [s], emails: [] });
    expect((await resolveAudience('salesperson', ctx({ salesperson: null }))).skipReason).toBe(
      'No salesperson is assigned',
    );
  });

  it('creator present → that user; null → "This record has no creator on file"', async () => {
    const c = user({ id: 'cr1' });
    expect(await resolveAudience('creator', ctx({ entity: 'estimate', creator: c }))).toEqual({
      users: [c],
      emails: [],
    });
    expect((await resolveAudience('creator', ctx({ entity: 'estimate', creator: null }))).skipReason).toBe(
      'This record has no creator on file',
    );
  });
});

// ── resolveAudience — removed_user ──────────────────────────────────────────
// Unlike every other audience, this one can't be re-derived from the live
// entity (the person is no longer on the crew/team by the time the automation
// runs) — it comes from ctx.eventRecipient, sourced from the enrollment's
// persisted event_payload (context.ts), not from a live DB lookup here.

describe('resolveAudience — removed_user', () => {
  it('resolves to the event-captured recipient when present', async () => {
    const removed = user({ id: 'r1', first_name: 'Priya' });
    const r = await resolveAudience('removed_user', ctx({ eventRecipient: removed }));
    expect(r).toEqual({ users: [removed], emails: [] });
  });

  it('skips with a plain-English reason when no removed recipient was captured', async () => {
    const r = await resolveAudience('removed_user', ctx({ eventRecipient: null }));
    expect(r.users).toEqual([]);
    expect(r.skipReason).toBeTruthy();
  });
});

// ── resolveAudience — assigned_user ─────────────────────────────────────────
// Same mechanism as removed_user (ctx.eventRecipient), for the opposite case:
// TECH_ASSIGNED / WALKTHROUGH_PERFORMER_ASSIGNED dispatch once per newly-added
// person, so the audience must be that ONE person, not the live full crew
// (which is what `assigned_team` would resolve to — see defaultAutomations.ts).

describe('resolveAudience — assigned_user', () => {
  it('resolves to the event-captured recipient when present', async () => {
    const added = user({ id: 'a1', first_name: 'Priya' });
    const r = await resolveAudience('assigned_user', ctx({ eventRecipient: added }));
    expect(r).toEqual({ users: [added], emails: [] });
  });

  it('skips with a plain-English reason when no assigned recipient was captured', async () => {
    const r = await resolveAudience('assigned_user', ctx({ eventRecipient: null }));
    expect(r.users).toEqual([]);
    expect(r.skipReason).toBeTruthy();
  });
});

// ── resolveAudience — all_admins / all_dispatchers ──────────────────────────

describe('resolveAudience — all_admins / all_dispatchers', () => {
  it('all_admins queries active ADMINs scoped to the org', async () => {
    const admins = [user({ id: 'a1' }), user({ id: 'a2' })];
    mockPrisma.user.findMany.mockResolvedValueOnce(admins);
    const r = await resolveAudience('all_admins', ctx());
    expect(r).toEqual({ users: admins, emails: [] });
    expect(mockPrisma.user.findMany.mock.calls[0][0]).toMatchObject({
      where: { organization_id: ORG, role: 'ADMIN', is_active: true },
      select: { id: true, email: true, first_name: true, last_name: true, phone: true },
    });
  });

  it('all_dispatchers queries active DISPATCHERs', async () => {
    mockPrisma.user.findMany.mockResolvedValueOnce([user({ id: 'd1' })]);
    await resolveAudience('all_dispatchers', ctx());
    expect(mockPrisma.user.findMany.mock.calls[0][0]).toMatchObject({
      where: { organization_id: ORG, role: 'DISPATCHER', is_active: true },
    });
  });

  it('empty admins → skip', async () => {
    mockPrisma.user.findMany.mockResolvedValueOnce([]);
    const r = await resolveAudience('all_admins', ctx());
    expect(r.users).toEqual([]);
    expect(r.skipReason).toMatch(/no active admins/i);
  });

  it('empty dispatchers → skip', async () => {
    mockPrisma.user.findMany.mockResolvedValueOnce([]);
    const r = await resolveAudience('all_dispatchers', ctx());
    expect(r.skipReason).toMatch(/no active dispatchers/i);
  });
});

// ── resolveAudience — specific_user ─────────────────────────────────────────

describe('resolveAudience — specific_user', () => {
  it('resolves the chosen active user inside the org only', async () => {
    const u = user({ id: 'u9' });
    mockPrisma.user.findFirst.mockResolvedValueOnce(u);
    const r = await resolveAudience('specific_user', ctx({ userId: 'u9' }));
    expect(r).toEqual({ users: [u], emails: [] });
    expect(mockPrisma.user.findFirst.mock.calls[0][0].where).toMatchObject({
      id: 'u9',
      organization_id: ORG,
      is_active: true,
    });
  });

  it('no userId → "No team member was chosen" (and no db call)', async () => {
    const r = await resolveAudience('specific_user', ctx({ userId: undefined }));
    expect(r.skipReason).toBe('No team member was chosen');
    expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('userId set but user not found / inactive → skip with a reason', async () => {
    mockPrisma.user.findFirst.mockResolvedValueOnce(null);
    const r = await resolveAudience('specific_user', ctx({ userId: 'ghost' }));
    expect(r.users).toEqual([]);
    expect(r.skipReason).toBeTruthy();
  });
});

// ── resolveAudience — custom ────────────────────────────────────────────────

describe('resolveAudience — custom', () => {
  it('returns the configured emails', async () => {
    const r = await resolveAudience('custom', ctx({ customEmails: ['a@b.com', 'c@d.com'] }));
    expect(r).toEqual({ users: [], emails: ['a@b.com', 'c@d.com'] });
  });

  it('empty / missing → "No email address was configured"', async () => {
    expect((await resolveAudience('custom', ctx({ customEmails: [] }))).skipReason).toBe(
      'No email address was configured',
    );
    expect((await resolveAudience('custom', ctx({ customEmails: undefined }))).skipReason).toBe(
      'No email address was configured',
    );
  });
});

// ── resolveAudience - the acting user is never in their own audience ────────
// Rule 0: never tell someone about their own action. The engine's half of it
// lives here, at the ONE function that turns an audience key into people, so
// it covers every action type, every trigger and every entity at once - a
// per-case filter would leave the next key added unguarded.

describe('resolveAudience - the acting user is dropped', () => {
  const ACTOR = 'actor-1';
  const actor = () => user({ id: ACTOR, email: 'actor@org.com', first_name: 'Dana' });

  it('drops the acting user from every audience that resolves to people', async () => {
    const cases: { key: RecipientKey; ctx: AudienceContext; arrange?: () => void }[] = [
      { key: 'assigned_team', ctx: ctx({ actorId: ACTOR, assignees: [actor()] }) },
      { key: 'dispatcher', ctx: ctx({ actorId: ACTOR, dispatcher: actor() }) },
      { key: 'salesperson', ctx: ctx({ actorId: ACTOR, salesperson: actor() }) },
      { key: 'creator', ctx: ctx({ actorId: ACTOR, entity: 'estimate', creator: actor() }) },
      {
        key: 'all_admins',
        ctx: ctx({ actorId: ACTOR }),
        arrange: () => mockPrisma.user.findMany.mockResolvedValueOnce([actor()]),
      },
      {
        key: 'all_dispatchers',
        ctx: ctx({ actorId: ACTOR }),
        arrange: () => mockPrisma.user.findMany.mockResolvedValueOnce([actor()]),
      },
      {
        key: 'specific_user',
        ctx: ctx({ actorId: ACTOR, userId: ACTOR }),
        arrange: () => mockPrisma.user.findFirst.mockResolvedValueOnce(actor()),
      },
      { key: 'removed_user', ctx: ctx({ actorId: ACTOR, eventRecipient: actor() }) },
      { key: 'assigned_user', ctx: ctx({ actorId: ACTOR, eventRecipient: actor() }) },
    ];
    expect(cases).toHaveLength(9);

    for (const c of cases) {
      c.arrange?.();
      const r = await resolveAudience(c.key, c.ctx);
      expect(r.users, c.key).toEqual([]);
      expect(r.emails, c.key).toEqual([]);
      expect(r.skipReason, c.key).toBeTruthy();
    }
  });

  it('keeps the other person when only one of two is the acting user, with no skip reason', async () => {
    const other = user({ id: 'u2', email: 'other@org.com', first_name: 'Sam' });
    const crew = await resolveAudience('assigned_team', ctx({ actorId: ACTOR, assignees: [actor(), other] }));
    expect(crew.users).toEqual([other]);
    expect(crew.skipReason).toBeUndefined();

    mockPrisma.user.findMany.mockResolvedValueOnce([actor(), other]);
    const admins = await resolveAudience('all_admins', ctx({ actorId: ACTOR }));
    expect(admins.users).toEqual([other]);
    expect(admins.skipReason).toBeUndefined();
  });

  it('leaves a plain-English skip reason, in the same voice as the other eleven', async () => {
    const r = await resolveAudience('dispatcher', ctx({ actorId: ACTOR, dispatcher: actor() }));
    expect(r.skipReason).toBe('The only person to notify is the one who triggered this');
    // product copy, not a log line: no jargon, no ids, renders in the Activity tab
    expect(r.skipReason).not.toMatch(/actor|rule 0|actor-1/i);
  });

  it('an audience that was already empty keeps its OWN reason, not the acting-user one', async () => {
    const noDispatcher = await resolveAudience('dispatcher', ctx({ actorId: ACTOR, dispatcher: null }));
    expect(noDispatcher.skipReason).toBe('No dispatcher is assigned to this job');

    const noCrew = await resolveAudience('assigned_team', ctx({ actorId: ACTOR, entity: 'job', assignees: [] }));
    expect(noCrew.skipReason).toBe('No one is assigned to this job yet');

    mockPrisma.user.findMany.mockResolvedValueOnce([]);
    const noAdmins = await resolveAudience('all_admins', ctx({ actorId: ACTOR }));
    expect(noAdmins.skipReason).toMatch(/no active admins/i);
  });

  it('the customer and custom addresses resolve identically with and without an acting user', async () => {
    const customerCtx = { id: 'c1', email: 'a@b.com', extra_emails: [{ email: 'ops@b.com' }] };
    expect(await resolveAudience('customer', ctx({ actorId: ACTOR, customer: customerCtx }))).toEqual(
      await resolveAudience('customer', ctx({ customer: customerCtx })),
    );
    expect(await resolveAudience('custom', ctx({ actorId: ACTOR, customEmails: ['a@b.com'] }))).toEqual(
      await resolveAudience('custom', ctx({ customEmails: ['a@b.com'] })),
    );
  });

  it('never throws for any key, with or without an acting user', async () => {
    const keys: RecipientKey[] = [
      'customer',
      'assigned_team',
      'dispatcher',
      'salesperson',
      'creator',
      'all_admins',
      'all_dispatchers',
      'specific_user',
      'custom',
      'removed_user',
      'assigned_user',
    ];
    mockPrisma.user.findMany.mockResolvedValue([]);
    mockPrisma.user.findFirst.mockResolvedValue(null);
    for (const key of keys) {
      await expect(resolveAudience(key, ctx({ actorId: ACTOR }))).resolves.toBeTruthy();
      await expect(resolveAudience(key, ctx())).resolves.toBeTruthy();
    }
  });
});

// ── Spec B slice 1: the two task-people audiences ────────────────────────────

describe('resolveAudience - task assignees and watchers', () => {
  const ann = user({ id: 'a1', email: 'ann@org.com', first_name: 'Ann' });
  const bob = user({ id: 'b1', email: 'bob@org.com', first_name: 'Bob' });

  function taskCtx(overrides: Partial<AudienceContext> = {}): AudienceContext {
    return ctx({ entity: 'task', customer: null, assignees: [], watchers: [], ...overrides });
  }

  it('assignees resolves the people doing the task', async () => {
    const out = await resolveAudience('assignees', taskCtx({ assignees: [ann, bob] }));
    expect(out.users).toEqual([ann, bob]);
    expect(out.emails).toEqual([]);
    expect(out.skipReason).toBeUndefined();
  });

  it('watchers resolves the people following it, and the two never contaminate each other', async () => {
    const out = await resolveAudience('watchers', taskCtx({ assignees: [ann], watchers: [bob] }));
    expect(out.users).toEqual([bob]);
    const other = await resolveAudience('assignees', taskCtx({ assignees: [ann], watchers: [bob] }));
    expect(other.users).toEqual([ann]);
  });

  it('a task nobody is watching returns a plain-English skip reason, never a throw or an empty send', async () => {
    const out = await resolveAudience('watchers', taskCtx({ assignees: [ann], watchers: [] }));
    expect(out.users).toEqual([]);
    expect(out.emails).toEqual([]);
    expect(out.skipReason).toBe('No one is watching this task');
  });

  it('an unassigned task says so rather than sending to nobody', async () => {
    const out = await resolveAudience('assignees', taskCtx({ assignees: [] }));
    expect(out.users).toEqual([]);
    expect(out.skipReason).toBe('No one is assigned to this task');
  });

  it('Rule 0 applies to both: the acting user is dropped from either list', async () => {
    const out = await resolveAudience('assignees', taskCtx({ assignees: [ann, bob], actorId: 'a1' }));
    expect(out.users).toEqual([bob]);

    const alone = await resolveAudience('watchers', taskCtx({ watchers: [ann], actorId: 'a1' }));
    expect(alone.users).toEqual([]);
    expect(alone.skipReason).toBe('The only person to notify is the one who triggered this');
  });
});

describe('audienceLabel - task audiences', () => {
  it('reads the two new keys as real phrases', () => {
    expect(audienceLabel('assignees', 'task')).toBe('the assignees');
    expect(audienceLabel('watchers', 'task')).toBe('the watchers');
  });

  it('leaves the job and lead labels exactly as they were', () => {
    expect(audienceLabel('assigned_team', 'job')).toBe('the assigned crew');
    expect(audienceLabel('assigned_team', 'lead')).toBe('the walkthrough team');
    expect(audienceLabel('creator', 'task')).toBe('the creator');
  });
});

// ── Spec B slice 2: the newly-added person, on a task that already had people ─
//
// The regression test for the whole slice. `assigned_user` must read the person the
// EVENT carried and never the live roster: a task-assigned workflow built on `assignees`
// re-emails everyone already on the task each time one more person joins, throws nothing,
// and logs nothing. It also cannot be caught with a one-assignee fixture - with a single
// person on the task the two audiences return the same row - so every case below puts TWO
// people on the task before adding a third.

describe('resolveAudience - assigned_user on a task that already has people', () => {
  const ann = user({ id: 'a1', email: 'ann@org.com', first_name: 'Ann' });
  const bob = user({ id: 'b1', email: 'bob@org.com', first_name: 'Bob' });
  const cat = user({ id: 'c1', email: 'cat@org.com', first_name: 'Cat' });

  const addedCat = (overrides: Partial<AudienceContext> = {}): AudienceContext =>
    ctx({
      entity: 'task',
      customer: null,
      // The roster AFTER the addition - what a live-roster audience would resolve to.
      assignees: [ann, bob, cat],
      watchers: [],
      eventRecipient: cat,
      ...overrides,
    });

  it('resolves to the added person alone, never the two who were already on the task', async () => {
    const out = await resolveAudience('assigned_user', addedCat());
    expect(out.users).toEqual([cat]);
    expect(out.users.map((u) => u.id)).not.toContain(ann.id);
    expect(out.users.map((u) => u.id)).not.toContain(bob.id);
  });

  it('differs from `assignees` on the same context - that is the whole point of the key', async () => {
    const roster = await resolveAudience('assignees', addedCat());
    expect(roster.users).toEqual([ann, bob, cat]);
    const added = await resolveAudience('assigned_user', addedCat());
    expect(added.users).not.toEqual(roster.users);
  });

  it('says so plainly when the dispatch carried nobody, rather than falling back to the roster', async () => {
    const out = await resolveAudience('assigned_user', addedCat({ eventRecipient: null }));
    expect(out.users).toEqual([]);
    expect(out.emails).toEqual([]);
    expect(out.skipReason).toBe('No assigned team member was captured for this run');
  });

  it('Rule 0 still applies: adding yourself to a task does not email you', async () => {
    const out = await resolveAudience('assigned_user', addedCat({ actorId: cat.id }));
    expect(out.users).toEqual([]);
    expect(out.skipReason).toBe('The only person to notify is the one who triggered this');
  });
});

// ── Spec B slice 3: a comment on a task ──────────────────────────────────────
//
// Asserted THROUGH the resolver rather than by inspecting the emit call, because that is
// where the exclusion actually lives: `dropActingUser` wraps the whole switch, so a comment
// workflow addressed to `assignees` or `watchers` inherits Rule 0 without either case
// knowing anything about it. An assertion on the dispatch site would pass even if the
// resolver had stopped dropping anyone.

describe('resolveAudience - a comment-triggered workflow on a task', () => {
  const ann = user({ id: 'a1', email: 'ann@org.com', first_name: 'Ann' });
  const bob = user({ id: 'b1', email: 'bob@org.com', first_name: 'Bob' });
  const cat = user({ id: 'c1', email: 'cat@org.com', first_name: 'Cat' });

  /** Ann and Bob are on the task, Cat is watching it, and Bob is the one who commented. */
  const commented = (overrides: Partial<AudienceContext> = {}): AudienceContext =>
    ctx({
      entity: 'task',
      customer: null,
      assignees: [ann, bob],
      watchers: [cat],
      actorId: bob.id,
      ...overrides,
    });

  it('leaves the commenter out of the assignees they are part of', async () => {
    const out = await resolveAudience('assignees', commented());
    expect(out.users).toEqual([ann]);
    expect(out.users.map((u) => u.id)).not.toContain(bob.id);
  });

  it('leaves the commenter out of the watchers when they are watching rather than assigned', async () => {
    const out = await resolveAudience('watchers', commented({ actorId: cat.id }));
    expect(out.users).toEqual([]);
    expect(out.skipReason).toBe('The only person to notify is the one who triggered this');
  });

  it('reaches everyone on the task when the commenter is not on it at all', async () => {
    // An admin passing through: nobody in either audience is the actor, so nobody is dropped.
    const out = await resolveAudience('assignees', commented({ actorId: 'someone-else' }));
    expect(out.users).toEqual([ann, bob]);
  });

  /**
   * The divergence this slice writes down. `creator` IS an audience a task automation can be
   * addressed to, while NO task bell verb routes to the creator (resolveRecipients.ts's TASK
   * block reaches assignees and watchers only). A creator who is neither assigned nor
   * watching therefore gets automation email about a comment and never a bell for it.
   */
  it('resolves the creator, who has no bell equivalent for the same comment', async () => {
    const dee = user({ id: 'd1', email: 'dee@org.com', first_name: 'Dee' });
    const out = await resolveAudience('creator', commented({ creator: dee }));
    expect(out.users).toEqual([dee]);
  });
});


// ── Spec C: the phone number rides on every resolved staff audience ─────────
//
// A text step addresses the SAME audiences an email step does, so the resolver is what
// hands the executor a number to text. The resolver does NOT decide who is textable:
// a person with no number comes back like anyone else, and the executor is the single
// place that turns a missing number into a skip (see sendSmsAction). Splitting that
// decision between the two layers is how a staff text step ends up skipping people for
// one reason here and another reason there.

describe('resolveAudience - Spec C: staff phone numbers', () => {
  it('assigned_team carries each crew member’s phone number through untouched', async () => {
    const crew = [user({ id: 'u1', phone: '+15551110001' }), user({ id: 'u2', phone: '+15551110002' })];
    const r = await resolveAudience('assigned_team', ctx({ entity: 'job', assignees: crew }));
    expect(r.users.map((u) => u.phone)).toEqual(['+15551110001', '+15551110002']);
  });

  it('all_admins SELECTS the phone column, so the resolved admins carry numbers', async () => {
    mockPrisma.user.findMany.mockResolvedValueOnce([user({ id: 'a1', phone: '+15551110003' })]);
    const r = await resolveAudience('all_admins', ctx());
    expect(mockPrisma.user.findMany.mock.calls[0][0].select.phone).toBe(true);
    expect(r.users[0].phone).toBe('+15551110003');
  });

  it('specific_user SELECTS the phone column, so a named member carries a number', async () => {
    mockPrisma.user.findFirst.mockResolvedValueOnce(user({ id: 'u9', phone: '+15551110004' }));
    const r = await resolveAudience('specific_user', ctx({ userId: 'u9' }));
    expect(mockPrisma.user.findFirst.mock.calls[0][0].select.phone).toBe(true);
    expect(r.users[0].phone).toBe('+15551110004');
  });

  it('a member with NO phone is still resolved, with a null phone and NO skip reason', async () => {
    const crew = [user({ id: 'u1', phone: '+15551110001' }), user({ id: 'u2', phone: null })];
    const r = await resolveAudience('assigned_team', ctx({ entity: 'job', assignees: crew }));
    expect(r.users).toHaveLength(2);
    expect(r.users[1].phone).toBeNull();
    expect(r.skipReason).toBeUndefined();
  });

  it('an audience of ONLY people without phones still resolves them all, with no skip reason', async () => {
    mockPrisma.user.findMany.mockResolvedValueOnce([user({ id: 'a1', phone: null }), user({ id: 'a2', phone: null })]);
    const r = await resolveAudience('all_admins', ctx());
    expect(r.users).toHaveLength(2);
    expect(r.skipReason).toBeUndefined();
  });

  // An enrollment parked at a WAIT before Spec C shipped replays a persisted
  // event_payload whose recipient object has no phone key. context.ts normalizes that
  // to null at the JSON seam; this pins the end of that chain, so the executor can
  // never be handed `undefined` and mistake it for "not loaded yet".
  it('an in-flight enrollment’s replayed assigned_user resolves to a null phone, not undefined', async () => {
    const replayed = { id: 'r1', email: 'r1@org.com', first_name: 'Priya', last_name: 'Nair', phone: null };
    const r = await resolveAudience('assigned_user', ctx({ eventRecipient: replayed }));
    expect(r.users[0].phone).toBeNull();
    expect(r.users[0]).toHaveProperty('phone');
    expect(r.skipReason).toBeUndefined();
  });
});
