import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { getTenantContext, type TenantContext } from '../../src/lib/tenant-context';
import { fillInOrg, fillInAllOrgs, type FillInDeps } from '../text-company-number-fill-in';

/**
 * Roles & Permissions S08.1 - the one-time fill-in of the company number on texts stored before the
 * column existed. The phone service's history is stubbed (a page iterator) and the database is an
 * in-memory stand-in that honours the filters the script uses; the real-database run of the same
 * script is in scripts/__tests__/text-company-number-migration.integration.test.ts.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const ORG = 'ab0e6f4e-0000-4000-8000-000000000081';
const OTHER_ORG = 'ab0e6f4e-0000-4000-8000-000000000082';
const ACCOUNT = '596375';
const LINE_A = { id: 'pn-a', e164: '+12015550001', ctm_number_id: 'TPN-A' };
const LINE_B = { id: 'pn-b', e164: '+12015550002', ctm_number_id: 'TPN-B' };
const OTHER_ORG_LINE = { id: 'pn-x', e164: '+12015550001', ctm_number_id: 'TPN-X' };

interface Msg {
  id: string;
  organization_id: string;
  direction: string;
  ctm_sms_id: string | null;
  phone_number_id: string | null;
}
interface Audit {
  org_id: string;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  metadata: Record<string, unknown>;
}

function makeWorld(seed: { messages: Msg[]; audits?: Audit[]; pages?: Array<Array<Record<string, unknown>>> }) {
  const messages = seed.messages.map((m) => ({ ...m }));
  const audits = seed.audits ?? [];
  const numbers = [
    { ...LINE_A, organization_id: ORG },
    { ...LINE_B, organization_id: ORG },
    { ...OTHER_ORG_LINE, organization_id: OTHER_ORG },
  ];
  const orgs = [
    { id: ORG, ctm_account_id: ACCOUNT },
    { id: OTHER_ORG, ctm_account_id: null },
  ];
  const contexts: Array<TenantContext | undefined> = [];
  const seen = () => contexts.push(getTenantContext());

  const matches = (m: Msg, where: any) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && 'gt' in (v as any)) return (m as any)[k] > (v as any).gt;
      return (m as any)[k] === v;
    });

  const prisma = {
    organization: {
      findMany: vi.fn(async () => {
        seen();
        return orgs;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        seen();
        return orgs.find((o) => o.id === where.id) ?? null;
      }),
    },
    phoneNumber: {
      findFirst: vi.fn(async ({ where }: any) => {
        seen();
        return numbers.find((n) => n.organization_id === where.organization_id && n.e164 === where.e164) ?? null;
      }),
      findMany: vi.fn(async ({ where }: any) => {
        seen();
        return numbers.filter((n) => n.organization_id === where.organization_id);
      }),
    },
    message: {
      updateMany: vi.fn(async ({ where, data }: any) => {
        seen();
        const hit = messages.filter((m) => matches(m, where));
        for (const m of hit) Object.assign(m, data);
        return { count: hit.length };
      }),
      findMany: vi.fn(async ({ where, take }: any) => {
        seen();
        return messages
          .filter((m) => matches(m, where))
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, take ?? Infinity)
          .map((m) => ({ id: m.id }));
      }),
      count: vi.fn(async ({ where }: any) => {
        seen();
        return messages.filter((m) => matches(m, where)).length;
      }),
    },
    auditLog: {
      findMany: vi.fn(async ({ where }: any) => {
        seen();
        return audits.filter(
          (a) =>
            a.org_id === where.org_id &&
            a.action === where.action &&
            a.resource_type === where.resource_type &&
            where.resource_id.in.includes(a.resource_id),
        );
      }),
    },
  };

  const listCalls = vi.fn((_accountId: string) =>
    (async function* () {
      for (const page of seed.pages ?? []) {
        seen();
        yield page;
      }
    })(),
  );

  const deps = { client: { listCalls }, prisma: prisma as unknown as PrismaClient } as unknown as FillInDeps;
  return { deps, messages, contexts, listCalls, prisma };
}

const text = (id: string, over: Partial<Msg> = {}): Msg => ({
  id,
  organization_id: ORG,
  direction: 'in',
  ctm_sms_id: null,
  phone_number_id: null,
  ...over,
});

const historyText = (messageId: string, trackingNumber: string, direction = 'msg_inbound') => ({
  message_id: messageId,
  tracking_number: trackingNumber,
  direction,
  message_body: 'hi',
});

describe('the fill-in places stored texts from the phone service history', () => {
  it('sets the company number on a stored text matched by the phone service message id', async () => {
    const w = makeWorld({
      messages: [text('m1', { ctm_sms_id: 'MSG1' }), text('m2', { ctm_sms_id: 'MSG2', direction: 'out' })],
      pages: [[historyText('MSG1', LINE_A.e164), historyText('MSG2', LINE_B.e164, 'msg_outbound')]],
    });

    const counts = await fillInOrg(w.deps, { orgId: ORG });

    expect(w.messages.find((m) => m.id === 'm1')!.phone_number_id).toBe(LINE_A.id);
    expect(w.messages.find((m) => m.id === 'm2')!.phone_number_id).toBe(LINE_B.id);
    expect(counts).toEqual({ texts_matched_history: 2, texts_matched_audit: 0, texts_left_without_number: 0 });
  });

  it('ignores calls in the same history, history rows with no stored text, and numbers the org does not own', async () => {
    const w = makeWorld({
      messages: [text('m1', { ctm_sms_id: 'MSG1' }), text('m3', { ctm_sms_id: 'MSG3' })],
      pages: [
        [
          { sid: 'CA1', tracking_number: LINE_A.e164, direction: 'inbound' },
          historyText('MSG-never-stored', LINE_A.e164),
          historyText('MSG1', LINE_A.e164),
          historyText('MSG3', '+19995559999'),
        ],
      ],
    });

    const counts = await fillInOrg(w.deps, { orgId: ORG });

    expect(w.messages.find((m) => m.id === 'm1')!.phone_number_id).toBe(LINE_A.id);
    expect(w.messages.find((m) => m.id === 'm3')!.phone_number_id).toBeNull();
    expect(counts).toEqual({ texts_matched_history: 1, texts_matched_audit: 0, texts_left_without_number: 1 });
  });

  it("never matches another organization's text, even with the same message id", async () => {
    const w = makeWorld({
      messages: [text('m-other', { organization_id: OTHER_ORG, ctm_sms_id: 'MSG1' })],
      pages: [[historyText('MSG1', LINE_A.e164)]],
    });

    await fillInOrg(w.deps, { orgId: ORG });

    expect(w.messages[0].phone_number_id).toBeNull();
  });

  it('never overwrites a company number a text already carries', async () => {
    const w = makeWorld({
      messages: [text('m1', { ctm_sms_id: 'MSG1', phone_number_id: LINE_B.id })],
      pages: [[historyText('MSG1', LINE_A.e164)]],
    });

    const counts = await fillInOrg(w.deps, { orgId: ORG });

    expect(w.messages[0].phone_number_id).toBe(LINE_B.id);
    expect(counts.texts_matched_history).toBe(0);
  });
});

describe('the fill-in falls back to the "text sent" audit entry for app-sent texts', () => {
  const sentAudit = (messageId: string, fromTpn: string, org = ORG): Audit => ({
    org_id: org,
    action: 'sms.sent',
    resource_type: 'Message',
    resource_id: messageId,
    metadata: { thread_id: 't1', from_tpn: fromTpn },
  });

  it('takes the number from the audit entry when the history does not have the text', async () => {
    const w = makeWorld({
      messages: [text('app-1', { direction: 'out' })],
      audits: [sentAudit('app-1', LINE_B.ctm_number_id)],
      pages: [[]],
    });

    const counts = await fillInOrg(w.deps, { orgId: ORG });

    expect(w.messages[0].phone_number_id).toBe(LINE_B.id);
    expect(counts).toEqual({ texts_matched_history: 0, texts_matched_audit: 1, texts_left_without_number: 0 });
  });

  it('the history wins over the audit entry when both name the text', async () => {
    const w = makeWorld({
      messages: [text('app-1', { direction: 'out', ctm_sms_id: 'MSG1' })],
      audits: [sentAudit('app-1', LINE_B.ctm_number_id)],
      pages: [[historyText('MSG1', LINE_A.e164, 'msg_outbound')]],
    });

    const counts = await fillInOrg(w.deps, { orgId: ORG });

    expect(w.messages[0].phone_number_id).toBe(LINE_A.id);
    expect(counts).toEqual({ texts_matched_history: 1, texts_matched_audit: 0, texts_left_without_number: 0 });
  });

  it('leaves a text without a number when the audit entry names a line the org does not have', async () => {
    const w = makeWorld({
      messages: [text('app-1', { direction: 'out' }), text('app-2', { direction: 'out' })],
      audits: [sentAudit('app-1', 'TPN-gone')],
      pages: [[]],
    });

    const counts = await fillInOrg(w.deps, { orgId: ORG });

    expect(w.messages.every((m) => m.phone_number_id === null)).toBe(true);
    expect(counts).toEqual({ texts_matched_history: 0, texts_matched_audit: 0, texts_left_without_number: 2 });
  });

  it("does not use another organization's audit entry", async () => {
    const w = makeWorld({
      messages: [text('app-1', { direction: 'out' })],
      audits: [sentAudit('app-1', LINE_B.ctm_number_id, OTHER_ORG)],
      pages: [[]],
    });

    await fillInOrg(w.deps, { orgId: ORG });

    expect(w.messages[0].phone_number_id).toBeNull();
  });

  it('works through more app-sent texts than one batch holds', async () => {
    const ids = Array.from({ length: 1203 }, (_, i) => `app-${String(i).padStart(5, '0')}`);
    const w = makeWorld({
      messages: ids.map((id) => text(id, { direction: 'out' })),
      audits: ids.map((id) => sentAudit(id, LINE_A.ctm_number_id)),
      pages: [[]],
    });

    const counts = await fillInOrg(w.deps, { orgId: ORG });

    expect(counts.texts_matched_audit).toBe(1203);
    expect(w.messages.every((m) => m.phone_number_id === LINE_A.id)).toBe(true);
  });
});

describe('running the fill-in twice', () => {
  it('changes nothing the second time and reports nothing matched', async () => {
    const w = makeWorld({
      messages: [
        text('m1', { ctm_sms_id: 'MSG1' }),
        text('app-1', { direction: 'out' }),
        text('lost', { ctm_sms_id: 'MSG-old' }),
      ],
      audits: [
        { org_id: ORG, action: 'sms.sent', resource_type: 'Message', resource_id: 'app-1', metadata: { from_tpn: 'TPN-B' } },
      ],
      pages: [[historyText('MSG1', LINE_A.e164)]],
    });

    const first = await fillInOrg(w.deps, { orgId: ORG });
    const afterFirst = JSON.stringify(w.messages);
    const second = await fillInOrg(w.deps, { orgId: ORG });

    expect(first).toEqual({ texts_matched_history: 1, texts_matched_audit: 1, texts_left_without_number: 1 });
    expect(second).toEqual({ texts_matched_history: 0, texts_matched_audit: 0, texts_left_without_number: 1 });
    expect(JSON.stringify(w.messages)).toBe(afterFirst);
  });
});

describe('scope of the run', () => {
  it('runs every read and write inside the target organization', async () => {
    const w = makeWorld({
      messages: [text('m1', { ctm_sms_id: 'MSG1' }), text('app-1', { direction: 'out' })],
      audits: [
        { org_id: ORG, action: 'sms.sent', resource_type: 'Message', resource_id: 'app-1', metadata: { from_tpn: 'TPN-B' } },
      ],
      pages: [[historyText('MSG1', LINE_A.e164)]],
    });

    await fillInOrg(w.deps, { orgId: ORG });

    expect(w.contexts.length).toBeGreaterThan(5);
    for (const ctx of w.contexts) expect(ctx).toEqual({ orgId: ORG, unscoped: false });
  });

  it('reads the history only for an organization that has a phone service account; the audit pass runs for all', async () => {
    const w = makeWorld({
      messages: [text('app-x', { organization_id: OTHER_ORG, direction: 'out' })],
      pages: [[]],
    });

    const totals = await fillInAllOrgs(w.deps);

    expect(w.listCalls).toHaveBeenCalledTimes(1);
    expect(w.listCalls.mock.calls[0][0]).toBe(ACCOUNT);
    expect(totals).toEqual({ texts_matched_history: 0, texts_matched_audit: 0, texts_left_without_number: 1 });
  });

  it('sums the counts of every organization', async () => {
    const w = makeWorld({
      messages: [text('m1', { ctm_sms_id: 'MSG1' }), text('o1', { organization_id: OTHER_ORG, direction: 'out' })],
      audits: [
        { org_id: OTHER_ORG, action: 'sms.sent', resource_type: 'Message', resource_id: 'o1', metadata: { from_tpn: 'TPN-X' } },
      ],
      pages: [[historyText('MSG1', LINE_A.e164)]],
    });

    const totals = await fillInAllOrgs(w.deps);

    expect(totals).toEqual({ texts_matched_history: 1, texts_matched_audit: 1, texts_left_without_number: 0 });
  });
});

// "No recurring job, schedule or cron exists for the fill-in." The script is run by hand, once per
// environment, so nothing the platform runs on its own may reach it.
describe('the fill-in is never scheduled', () => {
  const root = join(__dirname, '../../..');
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else out.push(full);
    }
    return out;
  };
  const NAME = 'text-company-number-fill-in';

  it('is not referenced by the deploy blueprint, any workflow, or any application source', () => {
    const candidates = [
      join(root, 'render.yaml'),
      ...walk(join(root, '.github')),
      ...walk(join(root, 'backend/src')).filter((f) => !f.includes('__tests__')),
    ];
    const referencing = candidates.filter((f) => readFileSync(f, 'utf8').includes(NAME));
    expect(referencing).toEqual([]);
  });

  it('is only wired as a manual package script', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'backend/package.json'), 'utf8'));
    const entries = Object.entries(pkg.scripts as Record<string, string>).filter(([, v]) => v.includes(NAME));
    expect(entries).toHaveLength(1);
    const [name] = entries[0];
    for (const [other, cmd] of Object.entries(pkg.scripts as Record<string, string>)) {
      if (other !== name) expect(cmd).not.toContain(name);
    }
    const blueprint = readFileSync(join(root, 'render.yaml'), 'utf8');
    expect(blueprint).not.toContain(name);
  });
});
