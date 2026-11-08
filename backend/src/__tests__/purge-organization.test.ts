import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/prisma', () => ({ prisma: {} }));

import { purgeOrganization } from '../lib/purge';

const ORG = 'org1';

/**
 * The workflow + copilot models added for #869, plus calendarEntry (Slice 02, same defect
 * class). All of these carry `organization_id` but have NO relation to Organization, so
 * nothing at the DB level cleans them up - a successful purge used to leave every row behind,
 * orphaned and unreachable (RLS ENABLE+FORCE makes an orphan invisible to the app connection,
 * so not even the tenant-scoped delete route can reach it).
 *
 * calendarEntryParticipant is deliberately NOT in this list: its FK to calendar_entries is a
 * REQUIRED `onDelete: Cascade` relation, so it needs no deleteMany of its own - purge-tenant-
 * coverage.test.ts's cascade closure covers it once calendarEntry is deleted here.
 */
const ORPHAN_MODELS = [
  'workflowStepRun',
  'workflowEnrollment',
  'workflowVersion',
  'workflowStep',
  'workflow',
  'copilotMessage',
  'copilotConversation',
  'copilotAuditEvent',
  'calendarEntry',
] as const;

function fakeTx(orgName: string) {
  const calls: string[] = [];
  const args = new Map<string, any>();
  const del = (n: string) => vi.fn(async (a?: any) => { calls.push(n); args.set(n, a); return { count: 0 }; });
  const tx: any = {
    organization: {
      findUnique: vi.fn(async () => ({ id: ORG, name: orgName })),
      delete: del('organization.delete'),
    },
    customer: { findMany: vi.fn(async () => []), deleteMany: del('customer') },
    userTablePreference: { deleteMany: del('userTablePreference') },
    appSetting: { deleteMany: del('appSetting') },
    rolePermission: { deleteMany: del('rolePermission') },
    tagAssignment: { deleteMany: del('tagAssignment') },
    tag: { deleteMany: del('tag') },
    attachment: { deleteMany: del('attachment') },
    note: { deleteMany: del('note') },
    timelineEvent: { deleteMany: del('timelineEvent') },
    priceBookItem: { deleteMany: del('priceBookItem') },
    priceBookCategory: { deleteMany: del('priceBookCategory') },
    finish: { deleteMany: del('finish') },
    uomOption: { deleteMany: del('uomOption') },
    // Email slice 6 - its org FK is ON DELETE RESTRICT, so a leftover row does
    // not merely orphan: it makes the Organization delete itself fail.
    replyToken: { deleteMany: del('replyToken') },
    // Email slice 8b - HAS a real FK to organizations (unlike ORPHAN_MODELS
    // below), but nothing cascades INTO it, so it still needs its own delete.
    emailThread: { deleteMany: del('emailThread') },
    // External call-tracking receiver rows - org FK is ON DELETE RESTRICT.
    callTrackingIntegration: { deleteMany: del('callTrackingIntegration') },
    // Web-form lead intake slice 1 - both org FKs are ON DELETE RESTRICT, same hazard.
    webFormSubmission: { deleteMany: del('webFormSubmission') },
    webFormIntegration: { deleteMany: del('webFormIntegration') },
    // Decline-reasons slice B - org FK is ON DELETE RESTRICT, same hazard.
    lostReasonOption: { deleteMany: del('lostReasonOption') },
    // Task categories (visits-and-task-categories slice 08) - org FK cascades, deleted explicitly.
    taskCategory: { deleteMany: del('taskCategory') },
    // Spec C slice 5 - the org-scoped thread catch-all. message_threads FKs
    // organizations with NO onDelete (RESTRICT), so a thread the scoped sweeps
    // never reach makes the Organization delete itself fail. Ordering and FK
    // behaviour are asserted for real further down, against a row-holding tx;
    // these two entries only keep this call-recording fake from throwing.
    message: { deleteMany: del('message') },
    messageThread: { deleteMany: del('messageThread') },
    user: { deleteMany: del('user') },
    department: { deleteMany: del('department') },
    location: { deleteMany: del('location') },
  };
  for (const m of ORPHAN_MODELS) tx[m] = { deleteMany: del(m) };
  return { calls, args, tx };
}

describe('purgeOrganization', () => {
  it('refuses when the org name does not match the guard prefix', async () => {
    const { tx } = fakeTx('Lakeside Mechanical'); // the real demo org
    await expect(purgeOrganization(tx, ORG, 'e2e-qa-')).rejects.toThrow(/Refusing to purge/);
  });

  it('purges users + departments before the organization row', async () => {
    const { tx, calls } = fakeTx('e2e-qa-abc123');
    await purgeOrganization(tx, ORG, 'e2e-qa-');
    expect(calls).toContain('user');
    expect(calls).toContain('department');
    expect(calls.indexOf('user')).toBeLessThan(calls.indexOf('organization.delete'));
    expect(calls.indexOf('department')).toBeLessThan(calls.indexOf('organization.delete'));
  });

  it('deletes reply tokens before the organization row (email slice 6)', async () => {
    // reply_tokens_organization_id_fkey is ON DELETE RESTRICT, so this is not a
    // tidiness question: a surviving token makes the Organization delete throw
    // and rolls the entire purge back.
    const { tx, calls } = fakeTx('e2e-qa-abc123');
    await purgeOrganization(tx, ORG, 'e2e-qa-');
    expect(calls).toContain('replyToken');
    expect(calls.indexOf('replyToken')).toBeLessThan(calls.indexOf('organization.delete'));
  });

  // ─── #869: workflow + copilot teardown ─────────────────────────────────────
  describe('orphan-prone tables with no FK to organizations (#869)', () => {
    for (const model of ORPHAN_MODELS) {
      it(`deletes ${model} before the organization row`, async () => {
        const { tx, calls } = fakeTx('e2e-qa-abc123');
        await purgeOrganization(tx, ORG, 'e2e-qa-');
        expect(calls).toContain(model);
        expect(calls.indexOf(model)).toBeLessThan(calls.indexOf('organization.delete'));
      });
    }

    it('tears the workflow graph down child-first', async () => {
      const { tx, calls } = fakeTx('e2e-qa-abc123');
      await purgeOrganization(tx, ORG, 'e2e-qa-');
      const at = (n: string) => calls.indexOf(n);
      // Matches deleteWorkflow (workflow.controller.ts) and reseed-builtin-keys.ts.
      expect(at('workflowStepRun')).toBeLessThan(at('workflowEnrollment'));
      expect(at('workflowVersion')).toBeLessThan(at('workflowStep'));
      expect(at('workflowStep')).toBeLessThan(at('workflow'));
    });

    it('deletes enrollments BEFORE versions (workflow_enrollments_workflow_version_id_fkey is RESTRICT)', async () => {
      // This one edge is load-bearing, not cosmetic: that FK is ON DELETE RESTRICT, which
      // Postgres checks immediately and cannot defer. Versions-before-enrollments throws.
      const { tx, calls } = fakeTx('e2e-qa-abc123');
      await purgeOrganization(tx, ORG, 'e2e-qa-');
      expect(calls.indexOf('workflowEnrollment')).toBeLessThan(calls.indexOf('workflowVersion'));
    });

    it('deletes copilot messages before their conversations', async () => {
      const { tx, calls } = fakeTx('e2e-qa-abc123');
      await purgeOrganization(tx, ORG, 'e2e-qa-');
      expect(calls.indexOf('copilotMessage')).toBeLessThan(calls.indexOf('copilotConversation'));
    });

    it('scopes every new delete to the organization', async () => {
      // A purge that forgets tenant scope is far worse than one that forgets the table: an
      // unscoped deleteMany on these models would wipe every org's automations and copilot
      // history. Asserted on the actual argument, not just on call order.
      const { tx, args } = fakeTx('e2e-qa-abc123');
      await purgeOrganization(tx, ORG, 'e2e-qa-');
      for (const model of ORPHAN_MODELS) {
        expect(args.get(model), `${model} delete argument`).toEqual({ where: { organization_id: ORG } });
      }
    });

    it('does not touch them at all when the name guard rejects', async () => {
      const { tx, calls } = fakeTx('Lakeside Mechanical');
      await expect(purgeOrganization(tx, ORG, 'e2e-qa-')).rejects.toThrow(/Refusing to purge/);
      expect(calls).toEqual([]);
    });
  });
});

// ─── Spec C slice 5: the SET NULL purge hazard ─────────────────────────────────
//
// MessageThread.organization is a REQUIRED relation with no onDelete, i.e. RESTRICT:
// a surviving thread does not merely orphan, it makes `tx.organization.delete` throw
// and rolls the whole purge back.
//
// The two scoped sweeps only reach a thread through a lead or a customer. A thread
// keyed on a USER (Spec C staff SMS) - or on nothing at all, which unmatched-number
// threads already produce today - survives both, and `tx.user.deleteMany` merely
// NULLs its user_id because that FK is ON DELETE SET NULL. The result is an orphan
// the org delete trips over.
//
// The fake transaction below holds ROWS and enforces those two FK behaviours, so
// these tests assert what the coverage-style tests structurally cannot: that the
// organization delete itself SUCCEEDS. A tx that only records call names passes on
// the broken code, which is exactly why the hole survived this long.

type Row = Record<string, any>;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'in' in v) return (v.in as any[]).includes(row[k]);
    if (v && typeof v === 'object') return true; // nested relation filters: not modelled
    return row[k] === v;
  });
}

/**
 * A transaction that stores rows and enforces the two constraints that matter here:
 *   - users -> message_threads.user_id is ON DELETE SET NULL (the thread SURVIVES);
 *   - message_threads -> organizations is RESTRICT (a survivor blocks the org delete).
 * Every other model is an inert no-op, so this stays valid as purge.ts grows.
 */
function rowTx(seed: { threads?: Row[]; messages?: Row[]; users?: Row[]; customers?: Row[]; leads?: Row[] }) {
  const db = {
    threads: [...(seed.threads ?? [])],
    messages: [...(seed.messages ?? [])],
    users: [...(seed.users ?? [])],
    customers: [...(seed.customers ?? [])],
    leads: [...(seed.leads ?? [])],
  };
  const ops: string[] = [];
  const threadDeleteCounts: number[] = [];

  const real: Record<string, any> = {
    organization: {
      findUnique: async () => ({ id: ORG, name: 'e2e-qa-abc123' }),
      delete: async () => {
        ops.push('organization.delete');
        const blocking = db.threads.filter((t) => t.organization_id === ORG);
        if (blocking.length) {
          // What Postgres actually raises: message_threads_organization_id_fkey is RESTRICT.
          throw new Error(
            `FK violation: ${blocking.length} message_threads row(s) still reference organization ${ORG}`,
          );
        }
        return { id: ORG };
      },
    },
    messageThread: {
      findMany: async ({ where }: any) => {
        ops.push('messageThread.findMany');
        return db.threads.filter((t) => matches(t, where)).map((t) => ({ id: t.id }));
      },
      deleteMany: async ({ where }: any) => {
        ops.push('messageThread.deleteMany');
        const before = db.threads.length;
        db.threads = db.threads.filter((t) => !matches(t, where));
        const count = before - db.threads.length;
        threadDeleteCounts.push(count);
        return { count };
      },
    },
    message: {
      deleteMany: async ({ where }: any) => {
        ops.push('message.deleteMany');
        const before = db.messages.length;
        db.messages = db.messages.filter((m) => !matches(m, where));
        return { count: before - db.messages.length };
      },
    },
    user: {
      deleteMany: async ({ where }: any) => {
        ops.push('user.deleteMany');
        const gone = db.users.filter((u) => matches(u, where)).map((u) => u.id);
        db.users = db.users.filter((u) => !matches(u, where));
        // The FK: SET NULL, so the thread SURVIVES the user it was held with.
        for (const t of db.threads) if (gone.includes(t.user_id)) t.user_id = null;
        return { count: gone.length };
      },
    },
    customer: {
      findMany: async ({ where }: any) => db.customers.filter((c) => matches(c, where)).map((c) => ({ id: c.id })),
      deleteMany: async () => ({ count: 0 }),
    },
    lead: {
      findMany: async ({ where }: any) => db.leads.filter((l) => matches(l, where)).map((l) => ({ id: l.id })),
      deleteMany: async () => ({ count: 0 }),
    },
  };

  // Ops a model does not model explicitly fall through to an inert default, so this
  // fake stays valid as purge.ts grows new calls.
  const inert = (op: string) => {
    if (op === 'findUnique' || op === 'findFirst') return async () => null;
    if (op === 'findMany') return async () => [];
    if (op === 'count') return async () => 0;
    return async () => ({ count: 0 });
  };

  const tx: any = new Proxy(
    {},
    {
      get(_t, modelKey: string) {
        const defined = real[modelKey];
        return new Proxy(
          {},
          {
            get(_t2, op: string) {
              return defined?.[op] ?? inert(String(op));
            },
          },
        );
      },
    },
  );

  return { tx, db, ops, threadDeleteCounts };
}

describe('purgeOrganization - threads with no customer or lead counterparty', () => {
  it('completes when the org owns a user-keyed staff thread', async () => {
    const { tx, db } = rowTx({
      users: [{ id: 'u1', organization_id: ORG }],
      // A staff thread: keyed on a user, with every other counterparty null.
      threads: [{ id: 't-staff', organization_id: ORG, customer_id: null, lead_id: null, vendor_id: null, user_id: 'u1' }],
      messages: [{ id: 'm1', organization_id: ORG, thread_id: 't-staff' }],
    });

    // The assertion the slice demands: the ORGANIZATION DELETE SUCCEEDS. Asserting the
    // model was merely "written to" would pass against the unswept code.
    await expect(purgeOrganization(tx, ORG, 'e2e-qa-')).resolves.toBeUndefined();
    expect(db.threads).toEqual([]);
    expect(db.messages).toEqual([]);
  });

  it('completes when the org owns a counterparty-less orphan thread', async () => {
    // This hole is NOT new: `findOrCreateSmsThreadByNumber` already creates threads
    // with no customer, lead or vendor when an inbound number matches nobody. The
    // org-scoped catch-all fixes that pre-existing case at the same time.
    const { tx, db } = rowTx({
      threads: [{ id: 't-unknown', organization_id: ORG, customer_id: null, lead_id: null, vendor_id: null, user_id: null }],
      messages: [{ id: 'm1', organization_id: ORG, thread_id: 't-unknown' }],
    });

    await expect(purgeOrganization(tx, ORG, 'e2e-qa-')).resolves.toBeUndefined();
    expect(db.threads).toEqual([]);
  });

  it('deletes a thread\'s messages before the thread itself', async () => {
    // messages.thread_id references message_threads; the child has to go first.
    const { tx, ops } = rowTx({
      threads: [{ id: 't-staff', organization_id: ORG, customer_id: null, lead_id: null, vendor_id: null, user_id: 'u1' }],
      messages: [{ id: 'm1', organization_id: ORG, thread_id: 't-staff' }],
      users: [{ id: 'u1', organization_id: ORG }],
    });
    await purgeOrganization(tx, ORG, 'e2e-qa-');
    expect(ops.lastIndexOf('message.deleteMany')).toBeLessThan(ops.lastIndexOf('messageThread.deleteMany'));
  });

  it('sweeps the threads BEFORE deleting the users', async () => {
    // Pinned deliberately. An org-scoped sweep placed after the user delete would also
    // let the org delete through TODAY, because the user FK is SET NULL. Pinning the
    // earlier position keeps the fix independent of that: if the FK were ever tightened
    // to RESTRICT, a sweep sitting after the user delete would resurrect the bug.
    const { tx, ops } = rowTx({
      threads: [{ id: 't-staff', organization_id: ORG, customer_id: null, lead_id: null, vendor_id: null, user_id: 'u1' }],
      users: [{ id: 'u1', organization_id: ORG }],
    });
    await purgeOrganization(tx, ORG, 'e2e-qa-');
    expect(ops.lastIndexOf('messageThread.deleteMany')).toBeLessThan(ops.indexOf('user.deleteMany'));
  });

  it('scopes the catch-all sweep to the organization', async () => {
    // An unscoped catch-all would delete every tenant's conversations.
    const { tx, db } = rowTx({
      threads: [
        { id: 'mine', organization_id: ORG, customer_id: null, lead_id: null, vendor_id: null, user_id: null },
        { id: 'theirs', organization_id: 'other-org', customer_id: null, lead_id: null, vendor_id: null, user_id: null },
      ],
      messages: [
        { id: 'm-mine', organization_id: ORG, thread_id: 'mine' },
        { id: 'm-theirs', organization_id: 'other-org', thread_id: 'theirs' },
      ],
    });
    await purgeOrganization(tx, ORG, 'e2e-qa-');
    expect(db.threads.map((t) => t.id)).toEqual(['theirs']);
    expect(db.messages.map((m) => m.id)).toEqual(['m-theirs']);
  });
});

describe('purgeOrganization - customer and lead threads are unaffected (regression)', () => {
  it('still deletes customer- and lead-scoped threads in the order it does today', async () => {
    const { tx, db, ops } = rowTx({
      customers: [{ id: 'c1', organization_id: ORG }],
      leads: [{ id: 'l1', organization_id: ORG, customer_id: 'c1' }],
      threads: [
        { id: 't-lead', organization_id: ORG, customer_id: null, lead_id: 'l1', vendor_id: null, user_id: null },
        { id: 't-cust', organization_id: ORG, customer_id: 'c1', lead_id: null, vendor_id: null, user_id: null },
      ],
      messages: [
        { id: 'm-lead', organization_id: ORG, thread_id: 't-lead' },
        { id: 'm-cust', organization_id: ORG, thread_id: 't-cust' },
      ],
    });

    await purgeOrganization(tx, ORG, 'e2e-qa-');

    // Both rows gone, as before.
    expect(db.threads).toEqual([]);
    expect(db.messages).toEqual([]);

    // And still by the SAME route: the lead-scoped sweep runs first, then the
    // customer-scoped one, each resolving thread ids before deleting messages. The
    // catch-all is additive and runs last, after both scoped sweeps.
    const threadOps = ops.filter((o) => o.startsWith('messageThread.') || o === 'message.deleteMany');
    expect(threadOps).toEqual([
      'messageThread.findMany',   // lead-scoped resolve
      'message.deleteMany',       // its messages
      'messageThread.deleteMany', // its threads
      'messageThread.findMany',   // customer-scoped resolve
      'message.deleteMany',
      'messageThread.deleteMany',
      'message.deleteMany',       // org-scoped catch-all (additive, last)
      'messageThread.deleteMany',
    ]);
  });

  it('leaves the scoped sweeps to do the work - the catch-all finds nothing left', async () => {
    // Proves the catch-all is a safety net, not a replacement: with only customer/lead
    // threads present, it deletes zero rows.
    const { tx, threadDeleteCounts } = rowTx({
      customers: [{ id: 'c1', organization_id: ORG }],
      threads: [{ id: 't-cust', organization_id: ORG, customer_id: 'c1', lead_id: null, vendor_id: null, user_id: null }],
    });
    await purgeOrganization(tx, ORG, 'e2e-qa-');
    // The customer-scoped sweep took the row; the catch-all (the LAST delete) found
    // nothing, so it is a safety net rather than the thing doing the work.
    expect(threadDeleteCounts.at(-1)).toBe(0);
    expect(threadDeleteCounts.filter((c) => c > 0)).toEqual([1]);
  });
});
