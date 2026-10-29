// Slice 2 — resolveOutboundNumber: the single source of outbound caller ID for
// both the click-to-call bridge and outbound SMS. Precedence:
//   explicit pick (if assigned to user) -> user default -> org default ->
//   legacy oldest-active -> null.
// db is mocked here (unit isolation); the wiring into createCall/sendSms is
// covered by ctm-click-to-call.test.ts / ctm-sms-send.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveOutboundNumber } from '../lib/communication/resolveOutboundNumber';

/* eslint-disable @typescript-eslint/no-explicit-any */
function makeDb() {
  return {
    userPhoneNumber: { findFirst: vi.fn() },
    phoneNumber: { findFirst: vi.fn() },
  };
}

const ORG = 'org-1';
const USER = 'user-1';

const link = (id: string, tpn: string) => ({ phone_number: { id, ctm_number_id: tpn } });
const row = (id: string, tpn: string) => ({ id, ctm_number_id: tpn });

let db: ReturnType<typeof makeDb>;
beforeEach(() => {
  vi.clearAllMocks();
  db = makeDb();
});

describe('resolveOutboundNumber', () => {
  it("returns the user's default assignment (wins over org default — never even reads it)", async () => {
    db.userPhoneNumber.findFirst.mockResolvedValue(link('pn-user', 'TPN-USER'));
    db.phoneNumber.findFirst.mockResolvedValue(row('pn-org', 'TPN-ORG'));

    const res = await resolveOutboundNumber(db as any, { orgId: ORG, userId: USER });

    expect(res).toEqual({ ctm_number_id: 'TPN-USER', phone_number_id: 'pn-user' });
    // Short-circuits before touching the org-default / legacy phoneNumber query.
    expect(db.phoneNumber.findFirst).not.toHaveBeenCalled();
  });

  it('falls to the org default when the user has no default assignment', async () => {
    db.userPhoneNumber.findFirst.mockResolvedValue(null);
    db.phoneNumber.findFirst.mockResolvedValue(row('pn-org', 'TPN-ORG'));

    const res = await resolveOutboundNumber(db as any, { orgId: ORG, userId: USER });

    expect(res).toEqual({ ctm_number_id: 'TPN-ORG', phone_number_id: 'pn-org' });
    // The first phoneNumber query is the org-default one.
    expect(db.phoneNumber.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ is_org_default: true }) }),
    );
  });

  it('honors an explicit pick that is assigned to the user (wins over the user default)', async () => {
    db.userPhoneNumber.findFirst.mockResolvedValue(link('pn-x', 'TPN-X'));

    const res = await resolveOutboundNumber(db as any, {
      orgId: ORG,
      userId: USER,
      explicitNumberId: 'pn-x',
    });

    expect(res).toEqual({ ctm_number_id: 'TPN-X', phone_number_id: 'pn-x' });
    expect(db.userPhoneNumber.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ user_id: USER, phone_number_id: 'pn-x' }) }),
    );
  });

  it('ignores an explicit pick NOT assigned to the user and falls through to the user default', async () => {
    // 1st userPhoneNumber query (explicit) -> null; 2nd (user default) -> hit.
    db.userPhoneNumber.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(link('pn-user', 'TPN-USER'));

    const res = await resolveOutboundNumber(db as any, {
      orgId: ORG,
      userId: USER,
      explicitNumberId: 'pn-not-mine',
    });

    expect(res).toEqual({ ctm_number_id: 'TPN-USER', phone_number_id: 'pn-user' });
    expect(db.userPhoneNumber.findFirst).toHaveBeenCalledTimes(2);
  });

  it('falls back to the oldest active number when nothing is assigned or defaulted', async () => {
    db.userPhoneNumber.findFirst.mockResolvedValue(null);
    db.phoneNumber.findFirst
      .mockResolvedValueOnce(null) // org default
      .mockResolvedValueOnce(row('pn-legacy', 'TPN-OLD')); // legacy oldest-active

    const res = await resolveOutboundNumber(db as any, { orgId: ORG, userId: USER });

    expect(res).toEqual({ ctm_number_id: 'TPN-OLD', phone_number_id: 'pn-legacy' });
    // The legacy query orders by created_at asc (the pre-mapping behavior).
    expect(db.phoneNumber.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({ orderBy: { created_at: 'asc' } }),
    );
  });

  it('returns null when the org owns no usable number', async () => {
    db.userPhoneNumber.findFirst.mockResolvedValue(null);
    db.phoneNumber.findFirst.mockResolvedValue(null);

    const res = await resolveOutboundNumber(db as any, { orgId: ORG, userId: USER });

    expect(res).toBeNull();
  });

  it('applies the sms_enabled filter to every candidate when requireSms is set', async () => {
    db.userPhoneNumber.findFirst.mockResolvedValue(null);
    db.phoneNumber.findFirst.mockResolvedValue(null);

    await resolveOutboundNumber(db as any, { orgId: ORG, userId: USER, requireSms: true });

    // Both the user-default relation filter and the phoneNumber queries carry sms_enabled.
    expect(db.userPhoneNumber.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ phone_number: expect.objectContaining({ sms_enabled: true }) }),
      }),
    );
    expect(db.phoneNumber.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ sms_enabled: true }) }),
    );
  });

  it('skips the per-user branches entirely when no userId is given (system/automation send)', async () => {
    db.phoneNumber.findFirst.mockResolvedValue(row('pn-org', 'TPN-ORG'));

    const res = await resolveOutboundNumber(db as any, { orgId: ORG, requireSms: true });

    expect(res).toEqual({ ctm_number_id: 'TPN-ORG', phone_number_id: 'pn-org' });
    expect(db.userPhoneNumber.findFirst).not.toHaveBeenCalled();
  });
});
