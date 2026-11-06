// #2995: Spider's staff alert texts time out after 10 s with no inline retry, a timeout or a
// provider error is recorded as a FAILED text in plain words (never sent, never a vendor name),
// and EVERY other caller of the shared send code keeps the current 30 s x 3.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { prisma } from '../lib/prisma';
import * as ctmClient from '../lib/ctm/client';
import {
  sendCtmSms,
  precheckCtmSms,
  sendStaffAlertSms,
  STAFF_ALERT_SMS_LIMITS,
  _resetCtmSmsDoubleFireGuard,
} from '../lib/ctm/sendSms';
import { deliverSpiderTextsTo, TEXT_OUTCOME, TEXT_REASON } from '../services/spider/delivery';
import type { SpiderRecipient } from '../services/spider/recipients';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const client = ctmClient as any;

const ORG_ID = 'org-2995';
const recipient = (id: string): SpiderRecipient =>
  ({ id, first_name: 'Sam', last_name: 'Staff', email: null, phone: '(555) 123-4567' }) as unknown as SpiderRecipient;

function mockConnectedOrg() {
  client.isCtmConfigured.mockReturnValue(true);
  p.organization.findUnique.mockResolvedValue({
    ctm_account_id: '111111',
    ctm_sms_ready: true,
    sms_sending_enabled: true,
    plan: 'PRO',
    trial_ends_at: null,
    feature_overrides: { phone: true },
  });
  p.phoneNumber.findFirst.mockResolvedValue({ ctm_number_id: 'TPN-A' });
  client.isOptedOut.mockResolvedValue(false);
  p.message.update.mockResolvedValue({});
  p.auditLog.create.mockResolvedValue({});
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetCtmSmsDoubleFireGuard();
  client.isOutboundAllowed.mockReturnValue(true);
  mockConnectedOrg();
});

describe('sendStaffAlertSms passes the 10 s / one-attempt limits', () => {
  it('limits are 10 s and a single attempt', () => {
    expect(STAFF_ALERT_SMS_LIMITS).toEqual({ timeoutMs: 10_000, maxAttempts: 1 });
  });

  it('hands them to the client send as the third argument', async () => {
    client.sendSms.mockResolvedValue({ id: 'M1' });
    const result = await sendStaffAlertSms(prisma, { orgId: ORG_ID, toE164: '+15551234567', body: 'hi', alertKey: 'a1:u1' });
    expect(result).toEqual({ delivered: true });
    const limits = { timeoutMs: 10_000, maxAttempts: 1, deadlineAt: expect.any(Number) };
    expect(client.sendSms).toHaveBeenCalledWith('111111', { from: 'TPN-A', to: '+15551234567', msg: 'hi' }, limits);
    // The opt-out check is part of the same text and gets the SAME limits object.
    expect(client.isOptedOut).toHaveBeenCalledWith('111111', '+15551234567', limits);
    expect(client.isOptedOut.mock.calls[0][2]).toBe(client.sendSms.mock.calls[0][2]);
  });
});

describe('a timeout or provider error is a failed text in the delivery record', () => {
  const cases: Array<[string, () => Error]> = [
    ['timeout', () => new client.CtmApiError(0, 'network error or timeout')],
    ['provider error (500)', () => new client.CtmApiError(500, 'boom from the provider')],
    ['provider rejection (400)', () => new client.CtmApiError(400, 'bad request')],
    ['unexpected throw', () => new Error('socket hang up')],
  ];
  it.each(cases)('%s: failed, never sent, plain words, no vendor, onSent not run', async (_n, makeErr) => {
    client.sendSms.mockRejectedValue(makeErr());
    const onSent = vi.fn().mockResolvedValue(undefined);
    const out = await deliverSpiderTextsTo({
      orgId: ORG_ID,
      sendKey: 'alert-1',
      logKey: { alertId: 'alert-1' },
      recipients: [recipient('u1')],
      bodyFor: () => 'body',
      onSent,
    });
    expect(out.sent).toBe(0);
    expect(onSent).not.toHaveBeenCalled();
    expect(out.results).toEqual([{ user_id: 'u1', result: 'failed', reason: TEXT_REASON.failed }]);
    expect(out.outcome).toBe(TEXT_OUTCOME.failed);
    expect(out.recipients).toEqual([{ user_id: 'u1', outcome: TEXT_OUTCOME.failed }]);
    const shown = JSON.stringify(out);
    expect(shown).not.toMatch(/ctm|calltracking|boom|socket|timeout/i);
    expect(client.sendSms).toHaveBeenCalledTimes(1);
  });

  it('one recipient timing out does not mark another sent, and the next still sends', async () => {
    client.sendSms
      .mockRejectedValueOnce(new client.CtmApiError(0, 'network error or timeout'))
      .mockResolvedValueOnce({ id: 'M2' });
    const out = await deliverSpiderTextsTo({
      orgId: ORG_ID,
      sendKey: 'alert-2',
      logKey: {},
      recipients: [recipient('u1'), recipient('u2')],
      bodyFor: () => 'body',
      onSent: async () => undefined,
    });
    expect(out.results.map((r) => [r.user_id, r.result])).toEqual([['u1', 'failed'], ['u2', 'sent']]);
    expect(out.sent).toBe(1);
  });
});

describe('every caller of the shared send code, and what each passes', () => {
  const SRC = path.resolve(__dirname, '..');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const full = path.join(dir, f);
      if (statSync(full).isDirectory()) return f === '__tests__' ? [] : walk(full);
      return full.endsWith('.ts') ? [full] : [];
    });
  const rel = (f: string) => path.relative(SRC, f);
  const files = walk(SRC);

  const code = (f: string) =>
    readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // A file reaches the raw client when it imports the client module in ANY form (named, aliased,
  // namespace, dynamic, or `./client` from inside lib/ctm) - not only when it writes `sendSms(`.
  const importsClient = (f: string, txt: string) =>
    /ctm\/client['"]/.test(txt) || (rel(f).startsWith('lib/ctm/') && /from\s+['"]\.\/client['"]/.test(txt));

  // The table: what each shared function is called from. A new caller fails this until it is added
  // and its limits are decided on purpose.
  it('raw client callers of the SMS send or the opt-out check: only the shared send module', () => {
    const hits = files
      .filter((f) => rel(f) !== 'lib/ctm/client.ts')
      .filter((f) => {
        const txt = code(f);
        // `(?<![/\w])` skips import PATHS like '.../ctm/sendSms' but keeps `ctm.sendSms(` (namespace)
        // and `sendSms as raw` (alias).
        return importsClient(f, txt) && /(?<![/\w])(sendSms|isOptedOut)\b/.test(txt);
      })
      .map(rel)
      .sort();
    expect(hits).toEqual(['lib/ctm/sendSms.ts']);
  });

  const EXPECTED_CALLERS: Record<string, string[]> = {
    // user sends (customer-facing, two-way inbox) and automations
    sendCtmSms: ['controllers/comm-threads.controller.ts', 'lib/ctm/sendSms.ts', 'services/automations/smsRecord.ts'],
    // the pre-send compliance check
    precheckCtmSms: ['controllers/comm-threads.controller.ts', 'lib/ctm/sendSms.ts'],
    // Spider staff alerts, the only staff-text path
    sendStaffAlertSms: ['lib/ctm/sendSms.ts', 'services/spider/delivery.ts'],
  };
  for (const [name, expected] of Object.entries(EXPECTED_CALLERS)) {
    it(`callers of ${name}`, () => {
      const hits = files
        .filter((f) => new RegExp(`\\b${name}\\b`).test(code(f)))
        .map(rel)
        .sort();
      expect(hits).toEqual(expected.sort());
    });
  }

  it('only the staff path passes limits: sendCtmSms and precheckCtmSms pass none to the send or the opt-out check', () => {
    const txt = code(path.join(SRC, 'lib/ctm/sendSms.ts'));
    const staffFn = txt.slice(txt.indexOf('export async function sendStaffAlertSms'));
    const beforeStaff = txt.slice(0, txt.indexOf('export const STAFF_ALERT_SMS_LIMITS'));
    expect(staffFn).toMatch(/runGates\([\s\S]*?,\s*limits\)/);
    expect(staffFn).toMatch(/await sendSms\([\s\S]*?,\s*limits\)/);
    // The shared module above the staff section (runGates, precheck, sendCtmSms) only forwards an
    // optional `limits` parameter; it never builds or names a limit.
    expect(beforeStaff).not.toMatch(/timeoutMs|maxAttempts|deadlineAt|STAFF_ALERT_SMS_LIMITS|staffAlertLimits/);
    expect(beforeStaff.match(/await sendSms\(/g)).toHaveLength(1);
    const userCall = beforeStaff.slice(beforeStaff.indexOf('await sendSms('));
    expect(userCall.slice(0, userCall.indexOf(');'))).not.toMatch(/limits/);
  });

  it('only lib/ctm/client.ts and lib/ctm/sendSms.ts mention a limit, in any import form', () => {
    const mentions = files
      .filter((f) => {
        const txt = code(f);
        // `timeoutMs` alone is only a limit where the file reaches the phone client (other modules,
        // e.g. the card-payment client, use the word for their own calls).
        return (
          /\b(maxAttempts|deadlineAt|STAFF_ALERT_SMS_LIMITS|staffAlertLimits|CtmCallLimits)\b/.test(txt) ||
          (importsClient(f, txt) && /\btimeoutMs\b/.test(txt))
        );
      })
      .map(rel)
      .sort();
    expect(mentions).toEqual(['lib/ctm/client.ts', 'lib/ctm/sendSms.ts']);
  });

  it('behaviour: user and automation sends call the client send with NO limits', async () => {
    client.sendSms.mockResolvedValue({ id: 'M3' });
    await sendCtmSms(prisma, {
      orgId: ORG_ID,
      toE164: '+15551234567',
      body: 'Your technician is on the way',
      threadId: 't1',
      messageId: 'm1',
    });
    expect(client.sendSms).toHaveBeenCalledTimes(1);
    expect(client.sendSms.mock.calls[0][2]).toBeUndefined();
    expect(client.isOptedOut.mock.calls[0][2]).toBeUndefined();
  });

  it('behaviour: precheckCtmSms calls the opt-out check with NO limits', async () => {
    await precheckCtmSms(prisma, { orgId: ORG_ID, toE164: '+15551234567', body: 'x', threadId: 't1' });
    expect(client.isOptedOut).toHaveBeenCalledTimes(1);
    expect(client.isOptedOut.mock.calls[0][2]).toBeUndefined();
  });
});
