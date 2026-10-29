/**
 * Mobile slice 36: every phone field uses the phone input, without losing any stored number.
 *
 * The frontend's phone input (frontend/src/ui-kit/components/form/phoneInput.tsx) emits the
 * values listed in frontend/src/ui-kit/lib/phoneFieldCases.json; the frontend test proves it
 * really emits them. This side proves, from the SAME table, that:
 *   - every save endpoint behind an adopted field accepts what the input sends;
 *   - storage did not change: a US number stores the same bytes the old mask's value stored,
 *     and the +1 cases now store the right ten digits instead of a truncated number;
 *   - a stored international or long number, re-saved unchanged by an unrelated edit, stores the
 *     same bytes again;
 *   - inbound call and SMS matching (matchByPhone) still finds a customer whose number was
 *     re-saved through the new input.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';

import { requiredCustomerPhone } from '../lib/phone-schema';
import { normalizePhone } from '../lib/customer-duplicate';
import { matchByPhone, normalizeNAPhone } from '../lib/comms-identity';
import { userPhoneField } from '../lib/user-phone';
import { updateCustomerSchema } from '../controllers/customer.controller';
import { updateLocationSchema } from '../controllers/location.controller';
import { patchOrgSchema } from '../controllers/organization.controller';
import { updateBranchSchema } from '../controllers/inv-locations.controller';
import { blockNumberSchema } from '../controllers/comm-agents.controller';

interface TypingCase { case: string; prev: string; next: string; format: 'us' | 'as-typed'; emits: string; before: string }
interface StoredCase { case: string; stored: string | null; shows: string }

const CASES = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', 'frontend', 'src', 'ui-kit', 'lib', 'phoneFieldCases.json'), 'utf8'),
) as { typing: TypingCase[]; stored: StoredCase[] };

const ORG = '00000000-0000-0000-0000-000000000001';
const digits = (s: string) => s.replace(/\D/g, '');
/** A complete number the input sends (the lone "+" mid-typing is never submitted). */
const sent = CASES.typing.filter((c) => digits(c.emits).length >= 7);
const usCases = sent.filter((c) => c.format === 'us' && digits(c.emits).length === 10);

/** The customer row the stub prisma holds, matched exactly like Postgres would match `phone IN (...)`. */
function prismaHolding(storedPhone: string) {
  const hit = (where: { OR?: Array<{ phone?: { in: string[] } }> }) =>
    where.OR?.some((c) => c.phone?.in.includes(storedPhone)) ? { id: 'cust-1', first_name: 'Ann', last_name: 'Lee', company_name: null } : null;
  return {
    customer: { findFirst: vi.fn(async ({ where }) => hit(where)) },
    lead: { findFirst: vi.fn(async () => null) },
    vendor: { findFirst: vi.fn(async () => null) },
    vendorContact: { findFirst: vi.fn(async () => null) },
  } as unknown as Parameters<typeof matchByPhone>[0];
}

describe('phone input values reach every save endpoint unchanged in meaning (mobile slice 36)', () => {
  it('the shared table is read', () => {
    expect(sent.length).toBeGreaterThan(8);
    expect(CASES.stored.length).toBeGreaterThan(3);
  });

  it.each(sent)('customer, lead and job customer phones accept "$emits" ($case)', ({ emits }) => {
    // requiredCustomerPhone / optionalCustomerPhone is the rule on customer create/update, phones[],
    // and the lead and job new_customer paths (lib/phone-schema.ts).
    expect(requiredCustomerPhone.safeParse(emits).success).toBe(true);
    const parsed = updateCustomerSchema.safeParse({ phone: emits, secondary_phone: emits, phones: [{ phone: emits }] });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it.each(usCases)('a US value stores the same bytes as the old mask\'s value, or the right ten digits where it truncated ($case)', ({ emits, before, next }) => {
    const stored = requiredCustomerPhone.parse(emits);
    if (emits === before) expect(stored).toBe(requiredCustomerPhone.parse(before));
    else expect(stored).toBe(digits(next).slice(-10)); // the old mask kept "151..." of a +1 number
    expect(stored).toMatch(/^\d{10}$/);
  });

  it.each(usCases)('user phones (invite, edit, My Profile, accept invite) accept "$emits" as the same E.164', ({ emits }) => {
    expect(userPhoneField.parse(emits)).toBe(normalizeNAPhone(emits));
    expect(userPhoneField.parse(emits)).toMatch(/^\+1\d{10}$/);
  });

  it.each(sent)('locations, company profile and branches store "$emits" as sent ($case)', ({ emits }) => {
    expect(updateLocationSchema.parse({ phone: emits }).phone).toBe(emits);
    expect(patchOrgSchema.parse({ phone: emits }).phone).toBe(emits);
    expect(updateBranchSchema.parse({ phone: emits }).phone).toBe(emits);
  });

  it.each(sent)('vendor phones normalise "$emits" exactly as the customer rule does ($case)', ({ emits }) => {
    expect(normalizePhone(emits)).toBe(requiredCustomerPhone.parse(emits));
  });

  it.each(usCases)('the block list accepts "$emits"', ({ emits }) => {
    expect(blockNumberSchema.safeParse({ number: emits, reason: 'spam' }).success).toBe(true);
  });
});

describe('a stored number re-saved through the new input (mobile slice 36)', () => {
  const stored = CASES.stored.filter((c): c is StoredCase & { stored: string } => Boolean(c.stored) && digits(c.stored!).length >= 7);

  it.each(stored)('$case: "$stored" shown as "$shows" stores the same bytes again', ({ stored: raw, shows }) => {
    const customerStored = requiredCustomerPhone.parse(raw);
    expect(requiredCustomerPhone.parse(shows)).toBe(customerStored);
    expect(updateLocationSchema.parse({ phone: shows }).phone).toBe(shows);
  });

  it.each(stored)('$case: inbound call and SMS matching finds the customer exactly as before', async ({ stored: raw, shows }) => {
    const before = requiredCustomerPhone.parse(raw);
    const after = requiredCustomerPhone.parse(shows);
    const inbound = `+${digits(raw).length === 10 ? '1' : ''}${digits(raw)}`;
    const matchedBefore = await matchByPhone(prismaHolding(before), ORG, inbound);
    const matchedAfter = await matchByPhone(prismaHolding(after), ORG, inbound);
    expect(matchedAfter).toEqual(matchedBefore);
  });

  it.each(usCases)('a customer saved through the input as "$emits" is found by an inbound call from its E.164 number', async ({ emits }) => {
    const storedPhone = requiredCustomerPhone.parse(emits);
    const match = await matchByPhone(prismaHolding(storedPhone), ORG, `+1${storedPhone}`);
    expect(match).toMatchObject({ kind: 'customer', customerId: 'cust-1' });
  });
});
