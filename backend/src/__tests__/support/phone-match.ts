/* =============================================================================
   Test helper (not a test file), for suites on the MOCKED database only: say which customer a phone number belongs to.

   The identity match (`matchByPhone`, lib/comms-identity.ts) picks one customer for a number by a fixed order, in one raw
   query (#3015). A mocked database cannot run that query, so a suite that needs "this number is that customer's" answers
   it here. The order itself is proven on a real database by comm-shared-number-fixed-order-db.test.ts; nothing here
   decides it.

   Only a raw query asked about a phone number is answered: one whose bound values hold a list with an E.164 number (the
   spellings the match accepts). It is told apart by what it asks, not by its SQL text. Every other raw query keeps the
   suite's default answer, an empty list. Call `noNumberMatches` in the suite's beforeEach, so a case's answer never
   leaks into the next one (`vi.clearAllMocks` keeps a mock's implementation).
   ========================================================================== */

import type { Mock } from 'vitest';

type RawQueryMock = { $queryRaw: Mock };

export interface NumberOwner {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  company_name?: string | null;
}

const E164 = /^\+1\d{10}$/;
const asksAboutANumber = (values: unknown[]) =>
  values.some((v) => Array.isArray(v) && v.some((x) => typeof x === 'string' && E164.test(x)));

/**
 * The number belongs to this customer and, with `own`, is the one open lead's or job's own number (the fixed order's first
 * step); without it, it is no lead's or job's own number.
 */
export function numberBelongsTo(db: RawQueryMock, customer: NumberOwner, own: { leadId?: string; jobId?: string; jobNumber?: string } = {}) {
  const row = {
    id: customer.id,
    first_name: customer.first_name ?? null,
    last_name: customer.last_name ?? null,
    company_name: customer.company_name ?? null,
    own_lead_id: own.leadId ?? null,
    own_job_id: own.jobId ?? null,
    own_job_number: own.jobNumber ?? null,
  };
  db.$queryRaw.mockImplementation(async (_sql: unknown, ...values: unknown[]) => (asksAboutANumber(values) ? [row] : []));
}

/** No customer has the number (the default answer of a mocked raw query). */
export function noNumberMatches(db: RawQueryMock) {
  db.$queryRaw.mockReset();
  db.$queryRaw.mockResolvedValue([]);
}
