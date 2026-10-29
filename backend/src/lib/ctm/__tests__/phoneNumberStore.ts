// An in-memory stand-in for the `phone_numbers` table, installed on the global
// prisma mock. The number-sync tests assert on what ends up STORED, not on the
// arguments of an upsert call, so a refactor of how the sync writes cannot turn
// them green or red on its own.
import { prisma } from '../../prisma';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface StoredNumber {
  id: string;
  organization_id: string;
  e164: string;
  formatted: string | null;
  label: string | null;
  source: string;
  type: string | null;
  sms_enabled: boolean;
  ctm_number_id: string | null;
  call_flow_id: string | null;
  route_to: unknown;
  status: string;
  created_at: Date;
}

export function installPhoneNumberStore(seed: Array<Partial<StoredNumber>> = []) {
  const rows: StoredNumber[] = [];
  let seq = 0;
  const make = (data: Partial<StoredNumber>): StoredNumber => {
    seq += 1;
    return {
      id: `pn-${seq}`,
      organization_id: 'org-1',
      e164: '',
      formatted: null,
      label: null,
      source: 'ctm',
      type: null,
      sms_enabled: false,
      ctm_number_id: null,
      call_flow_id: null,
      route_to: null,
      status: 'active',
      created_at: new Date(Date.UTC(2026, 7, 1, 0, 0, seq)),
      ...data,
    };
  };
  for (const s of seed) rows.push(make(s));

  const p = prisma as any;
  p.phoneNumber.findMany.mockImplementation(async (args: any = {}) => {
    const orgId = args.where?.organization_id;
    return rows
      .filter((r) => (orgId ? r.organization_id === orgId : true))
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
      .map((r) => ({ ...r }));
  });
  p.phoneNumber.upsert.mockImplementation(async (args: any) => {
    const key = args.where.organization_id_e164;
    const found = rows.find((r) => r.organization_id === key.organization_id && r.e164 === key.e164);
    if (found) {
      Object.assign(found, args.update);
      return { ...found };
    }
    const created = make(args.create);
    rows.push(created);
    return { ...created };
  });

  return {
    rows,
    get: (e164: string) => rows.find((r) => r.e164 === e164),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
