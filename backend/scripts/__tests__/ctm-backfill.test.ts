import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { getTenantContext, type TenantContext } from '../../src/lib/tenant-context';
import { backfillOrg, type BackfillDeps } from '../ctm-backfill';

/**
 * Slice 9 — historical backfill orchestration core (scripts/ctm-backfill.ts).
 *
 * Everything is exercised through injected fakes — the script must NEVER touch
 * the real DB or CTM from tests (local .env points at shared staging). The
 * tenant-context module is left REAL so the runWithOrg wrapping is asserted
 * against actual AsyncLocalStorage propagation, not a spy.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const ORG_ID = 'ab0e6f4e-0000-4000-8000-000000000042';
const ACCOUNT_ID = '500001';

const DEFAULT_ORG = { id: ORG_ID, ctm_account_id: ACCOUNT_ID };

function makeDeps(
  pages: Array<Array<Record<string, unknown>>>,
  cfg: {
    org?: { id: string; ctm_account_id: string | null } | null;
    /** callSessionId → stored recording_key (missing ids resolve to null) */
    recordingKeys?: Record<string, string>;
  } = {},
) {
  // Every fake records the ALS tenant context it was invoked under.
  const contexts: Array<TenantContext | undefined> = [];
  const seen = () => {
    contexts.push(getTenantContext());
  };

  const listCalls = vi.fn(
    (_accountId: string, _params?: Record<string, string | number | undefined>) =>
      (async function* () {
        for (const page of pages) {
          seen();
          yield page;
        }
      })(),
  );

  const ingestCall = vi.fn(
    async (
      _db: unknown,
      _orgId: string,
      payload: Record<string, any>,
      _position: string,
      _opts?: Record<string, unknown>,
    ) => {
      seen();
      if (payload.__boom) throw new Error('ingest exploded');
      const sid = String(payload.sid ?? '');
      if (!sid) return null;
      return {
        callSessionId: `cs-${sid}`,
        sid,
        status: 'completed',
        direction: 'in' as const,
        hasRecording: !!payload.audio,
      };
    },
  );

  const ingestSms = vi.fn(
    async (_db: unknown, _orgId: string, payload: Record<string, any>, _opts?: Record<string, unknown>) => {
      seen();
      if (payload.__boom) throw new Error('sms ingest exploded');
      return { messageId: `m-${payload.message_id ?? payload.sid}`, threadId: 't-1', direction: 'in' as const };
    },
  );

  const ingestRecording = vi.fn(async (_args: Record<string, string>) => {
    seen();
  });

  const recordingKeys = cfg.recordingKeys ?? {};
  const prismaFake = {
    organization: {
      findUnique: vi.fn(async () => {
        seen();
        return cfg.org === undefined ? DEFAULT_ORG : cfg.org;
      }),
    },
    callSession: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        seen();
        return { recording_key: recordingKeys[args.where.id] ?? null };
      }),
    },
  };

  const sleep = vi.fn(async (_ms: number) => {});

  const deps = {
    client: { listCalls },
    ingestCall,
    ingestSms,
    ingestRecording,
    prisma: prismaFake as unknown as PrismaClient,
    sleep,
  } as unknown as BackfillDeps;

  return { deps, contexts, listCalls, ingestCall, ingestSms, ingestRecording, prismaFake, sleep };
}

describe('backfillOrg', () => {
  // (a) runWithOrg wrapping — asserted via the REAL tenant-context ALS
  it('runs ALL work (org load, paging, ingest, recording checks) inside runWithOrg for the target org', async () => {
    const f = makeDeps([
      [
        { sid: 'CA1', audio: 'https://app.calltrackingmetrics.com/recordings/RE1' },
        { direction: 'msg_inbound', message_id: 'MSG1' },
      ],
    ]);

    await backfillOrg(f.deps, { orgId: ORG_ID });

    // org load + page yield + call ingest + cs lookup + recording + sms ingest
    expect(f.contexts.length).toBeGreaterThanOrEqual(6);
    for (const ctx of f.contexts) {
      expect(ctx).toEqual({ orgId: ORG_ID, unscoped: false });
    }
  });

  // (b) page-based iteration exhausts the generator
  it('iterates every page of the generator to exhaustion', async () => {
    const pages = [
      [{ sid: 'CA1' }, { sid: 'CA2' }],
      [{ sid: 'CA3' }, { direction: 'msg_inbound', message_id: 'MSG1' }],
      [{ direction: 'msg_outbound', message_id: 'MSG2' }],
    ];
    const f = makeDeps(pages);

    const counters = await backfillOrg(f.deps, { orgId: ORG_ID });

    expect(f.listCalls).toHaveBeenCalledTimes(1);
    expect(f.listCalls).toHaveBeenCalledWith(ACCOUNT_ID, {});
    expect(f.ingestCall).toHaveBeenCalledTimes(3);
    expect(f.ingestSms).toHaveBeenCalledTimes(2);
    expect(counters).toMatchObject({ calls: 3, sms: 2, errors: 0 });
  });

  it('passes --since through as the listCalls start_date param', async () => {
    const f = makeDeps([[]]);

    await backfillOrg(f.deps, { orgId: ORG_ID, since: '2026-01-15' });

    expect(f.listCalls).toHaveBeenCalledWith(ACCOUNT_ID, { start_date: '2026-01-15' });
  });

  // (c) classification
  it('classifies msg_* direction or MSG-prefixed message_id as SMS, everything else as a call at position end', async () => {
    const smsByDirection = { direction: 'msg_inbound', message_id: '31337' };
    const smsByMessageId = { direction: 'inbound', message_id: 'MSG0a1b2c' };
    const smsWrapped = { call: { direction: 'msg_outbound', message_id: 'MSG9' } };
    const call = { sid: 'CA9', direction: 'outbound' };
    const f = makeDeps([[smsByDirection, smsByMessageId, smsWrapped, call]]);

    const counters = await backfillOrg(f.deps, { orgId: ORG_ID });

    expect(f.ingestSms).toHaveBeenCalledTimes(3);
    expect(f.ingestSms).toHaveBeenCalledWith(f.deps.prisma, ORG_ID, smsByDirection, { suppressNotifications: true });
    expect(f.ingestSms).toHaveBeenCalledWith(f.deps.prisma, ORG_ID, smsByMessageId, { suppressNotifications: true });
    expect(f.ingestSms).toHaveBeenCalledWith(f.deps.prisma, ORG_ID, smsWrapped, { suppressNotifications: true });
    expect(f.ingestCall).toHaveBeenCalledTimes(1);
    expect(f.ingestCall).toHaveBeenCalledWith(f.deps.prisma, ORG_ID, call, 'end', {
      suppressNotifications: true,
      ctmAccountId: ACCOUNT_ID,
    });
    expect(counters).toMatchObject({ calls: 1, sms: 3 });
  });

  // (c2) notification suppression — EVERY historical ingest (call AND sms)
  // carries suppressNotifications so a backfill can't ring bells or mark
  // hundreds of threads unread.
  it('passes suppressNotifications on every ingest call', async () => {
    const f = makeDeps([
      [{ sid: 'CA1' }, { direction: 'msg_inbound', message_id: 'MSG1' }],
      [{ sid: 'CA2' }, { direction: 'msg_outbound', message_id: 'MSG2' }],
    ]);

    await backfillOrg(f.deps, { orgId: ORG_ID });

    for (const call of f.ingestCall.mock.calls) {
      // The assertion this test exists for is the suppression flag; the account
      // id rides along on the same opts object (see c3) and is checked there.
      expect(call[4]).toMatchObject({ suppressNotifications: true });
    }
    for (const call of f.ingestSms.mock.calls) {
      expect(call[3]).toEqual({ suppressNotifications: true });
    }
    expect(f.ingestCall.mock.calls.length + f.ingestSms.mock.calls.length).toBe(4);
  });

  // (c3) forwarded-answer attribution - a historical call answered on a
  // forwarded phone names nobody in its payload; ingest can only resolve it
  // with the org's CTM account id, so the backfill has to hand it over or the
  // whole imported history stays unattributed.
  it('passes the CTM account id so historical forwarded answers resolve', async () => {
    const f = makeDeps([[{ sid: 'CA1' }]]);

    await backfillOrg(f.deps, { orgId: ORG_ID });

    expect(f.ingestCall).toHaveBeenCalledWith(
      f.deps.prisma,
      ORG_ID,
      { sid: 'CA1' },
      'end',
      expect.objectContaining({ ctmAccountId: ACCOUNT_ID }),
    );
  });

  // (d) recording re-attempt
  it('re-attempts recordings only for calls with a recording and no stored recording_key', async () => {
    const withRecMissing = { sid: 'CA1', audio: 'https://app.calltrackingmetrics.com/recordings/RE1' };
    const withRecKeyed = { sid: 'CA2', audio: 'https://app.calltrackingmetrics.com/recordings/RE2' };
    const noRec = { sid: 'CA3' };
    const f = makeDeps([[withRecMissing, withRecKeyed, noRec]], {
      recordingKeys: { 'cs-CA2': `${ORG_ID}/cs-CA2.mp3` },
    });

    const counters = await backfillOrg(f.deps, { orgId: ORG_ID });

    expect(f.ingestRecording).toHaveBeenCalledTimes(1);
    expect(f.ingestRecording).toHaveBeenCalledWith({
      orgId: ORG_ID,
      callSessionId: 'cs-CA1',
      ctmAccountId: ACCOUNT_ID,
      callSid: 'CA1',
    });
    // recording_key is only consulted for the two calls that HAVE a recording
    expect(f.prismaFake.callSession.findUnique).toHaveBeenCalledTimes(2);
    expect(counters).toMatchObject({ calls: 3, recordings_fetched: 1, skipped: 1 });
  });

  // (e) one item throwing does not abort the run
  it('counts a throwing item as an error and continues with the rest', async () => {
    const boomCall = { sid: 'CABOOM', __boom: true };
    const okSms = { direction: 'msg_inbound', message_id: 'MSG1' };
    const okCall = { sid: 'CA2' };
    const f = makeDeps([[boomCall, okSms], [okCall]]);

    const counters = await backfillOrg(f.deps, { orgId: ORG_ID });

    expect(counters).toMatchObject({ calls: 1, sms: 1, errors: 1 });
    expect(f.ingestCall).toHaveBeenCalledTimes(2); // boom + ok — the loop kept going
    expect(f.ingestSms).toHaveBeenCalledTimes(1);
  });

  // (f) dry-run
  it('--dry-run classifies and counts but makes ZERO ingest or write calls', async () => {
    const f = makeDeps([
      [
        { sid: 'CA1', audio: 'https://app.calltrackingmetrics.com/recordings/RE1' },
        { sid: 'CA2' },
        { direction: 'msg_outbound', message_id: 'MSG1' },
      ],
    ]);

    const counters = await backfillOrg(f.deps, { orgId: ORG_ID, dryRun: true });

    expect(counters).toEqual({ calls: 2, sms: 1, recordings_fetched: 0, skipped: 0, errors: 0 });
    expect(f.ingestCall).not.toHaveBeenCalled();
    expect(f.ingestSms).not.toHaveBeenCalled();
    expect(f.ingestRecording).not.toHaveBeenCalled();
    expect(f.prismaFake.callSession.findUnique).not.toHaveBeenCalled();
    // the ONLY DB touch is the read-only org lookup resolving the CTM account
    expect(f.prismaFake.organization.findUnique).toHaveBeenCalledTimes(1);
  });

  // (g) pacing
  it('paces the loop with a 120ms sleep after each item', async () => {
    const f = makeDeps([
      [{ sid: 'CA1' }, { sid: 'CA2' }],
      [{ direction: 'msg_inbound', message_id: 'MSG1' }],
    ]);

    await backfillOrg(f.deps, { orgId: ORG_ID });

    expect(f.sleep).toHaveBeenCalledTimes(3);
    for (const call of f.sleep.mock.calls) {
      expect(call[0]).toBe(120);
    }
  });

  // org validation (backs the CLI's exit-1 contract)
  it('rejects when the org is missing or not connected to CTM, before any CTM traffic', async () => {
    const missing = makeDeps([[{ sid: 'CA1' }]], { org: null });
    await expect(backfillOrg(missing.deps, { orgId: ORG_ID })).rejects.toThrow(/not found/i);
    expect(missing.listCalls).not.toHaveBeenCalled();

    const unconnected = makeDeps([[{ sid: 'CA1' }]], { org: { id: ORG_ID, ctm_account_id: null } });
    await expect(backfillOrg(unconnected.deps, { orgId: ORG_ID })).rejects.toThrow(/not connected/i);
    expect(unconnected.listCalls).not.toHaveBeenCalled();
  });

  // whole-run failure (generator/page-fetch error) propagates → CLI exits 1
  it('propagates a page-fetch failure as a whole-run failure', async () => {
    const f = makeDeps([[]]);
    f.listCalls.mockImplementation(() =>
      (async function* () {
        yield [{ sid: 'CA1' }];
        throw new Error('CTM API error 500: server exploded');
      })(),
    );

    await expect(backfillOrg(f.deps, { orgId: ORG_ID })).rejects.toThrow('CTM API error 500');
    expect(f.ingestCall).toHaveBeenCalledTimes(1); // first page WAS processed
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
