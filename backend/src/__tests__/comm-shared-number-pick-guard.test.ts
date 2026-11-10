/* =============================================================================
   #3015 (parent #3013, decision 1): every place that picks ONE customer for a phone number uses the fixed order.

   A source guard. The fixed order lives in one place, the identity match (`matchByPhone`, lib/comms-identity.ts), and is
   proven on a real database by comm-shared-number-fixed-order-db.test.ts. Every other source file that looks a customer up
   by a phone value is listed below: either it picks one customer through the identity match, or it has a reason it picks
   none. A new file that filters customers by a phone value, or calls the identity match, fails here until it is listed, so
   the next door that picks a customer for a number cannot go back to "any row with this number".
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC = join(__dirname, '..');

/** The places that pick one customer for a phone number, all through the identity match. */
const PICKS_BY_FIXED_ORDER: Readonly<Record<string, string>> = {
  'lib/comms-identity.ts': 'the identity match: holds the fixed order (the only customer phone filter that picks one)',
  'lib/ctm/ingest.ts': 'an incoming call (call ingest) and an incoming text (the conversation\'s default customer)',
  'lib/communication/phoneMatchInReach.ts': 'the identity match for a signed-in person, inside their reach',
  'lib/web-form/process.ts': 'the public web form files its lead on the number\'s customer',
  'controllers/comm-threads.controller.ts': 'a conversation started or texted from a number: its default customer',
  'controllers/comm-calls.controller.ts': 'a call logged by hand, and the dialer\'s "this number is" answer (its search lists the rest)',
  'controllers/comm-whatsapp-email.controller.ts': 'a WhatsApp conversation started from a number: its default customer',
  'lib/sms-reply-router.ts': 'an incoming text with no recent text of ours is tied to the one lead or job carrying the number as its own (the fixed order\'s first step, #3020)',
};

/** The places that look customers up by a phone value but pick no single customer, and why. */
const PICKS_NONE: Readonly<Record<string, string>> = {
  'lib/phone-search.ts': 'search clauses: a search lists every customer whose number matches',
  'controllers/search.controller.ts': 'the global search lists every match',
  'controllers/customer.controller.ts': 'the customer list search, and the duplicate warning on create (lib/customer-duplicate.ts)',
  'controllers/lead.controller.ts': 'the lead list search, and the duplicate warning on create (lib/customer-duplicate.ts)',
  'controllers/job.controller.ts': 'the duplicate warning when a job creates its customer (lib/customer-duplicate.ts)',
  'lib/customer-duplicate.ts': 'the duplicate warning when a customer is created: it warns that the number is taken, it files nothing',
  'services/payments-documents.ts': 'the payments page search lists every customer whose words or number match',
  'lib/ctm/smsThread.ts': 'the conversation keying: takes the identity match from its caller; its own number lookup is of staff, not customers',
};

/** The places that pick none and filter customers by a phone value themselves: searches, which list every match. */
const SEARCHES = new Set(['lib/phone-search.ts', 'services/payments-documents.ts']);

/** The shapes that filter customers by a phone value directly; only the identity match may use them to pick one. */
const DIRECT_FILTERS = [
  'a customer query by phone', 'a phone list query', 'a phone IN filter', 'a customer phone list filter', 'a second-phone filter',
  'a raw query on the phone list', 'a raw phone comparison', 'a customer query by a where built beforehand',
];

const CUSTOMER_QUERY = String.raw`\bcustomer\.(?:findFirst|findFirstOrThrow|findMany|findUnique|findUniqueOrThrow|count)\s*\(`;

/**
 * A customer query whose where is a variable built beforehand (`const where = { phone }; customer.findFirst({ where })`, or
 * `where: built`), where that variable is given a phone filter: in the object it is built from, or by a later assignment.
 */
function customerWhereBuiltBeforehand(src: string): boolean {
  const names = [...src.matchAll(new RegExp(`${CUSTOMER_QUERY}\\s*\\{[^;]*?\\bwhere\\s*(?::\\s*([A-Za-z_$][\\w$]*)\\s*)?[,}]`, 'g'))]
    .map((m) => m[1] ?? 'where');
  const phoneKey = String.raw`\b(?:secondary_)?phones?\b\s*(?::(?!\s*true\b)|[,}])`;
  return [...new Set(names)].some((name) =>
    new RegExp(String.raw`\b${name}\b\s*(?::[^=;]*)?=\s*\{[^;]*?${phoneKey}`).test(src)
    || new RegExp(String.raw`\b${name}\s*\.\s*(?:(?:secondary_)?phones?\s*=|(?:OR|AND)\s*=[^;]*${phoneKey})`).test(src));
}

/** Ways a source file filters customers by a phone value, or reaches the identity match. */
const SHAPES: ReadonlyArray<readonly [string, RegExp | ((src: string) => boolean)]> = [
  ['the identity match', /\bmatch\w*ByPhone\w*\s*\(/],
  // customer.findFirst / findMany / ... whose where names a phone column, in any form: `phone: x`, `phone: { in }`, `{ phone }`.
  ['a customer query by phone', /\bcustomer\.(?:findFirst|findFirstOrThrow|findMany|findUnique|findUniqueOrThrow|count)\s*\(\s*\{[^;]*?\bwhere\s*:(?:(?!\b(?:select|include|orderBy|data)\s*:)[^;])*?\b(?:secondary_)?phone\b\s*(?::(?!\s*true\b)|[,}])/],
  // Any read of the phone list is a lookup of customers by number or a read of one customer's numbers; both are listed.
  ['a phone list query', /\bcustomerPhone\.(?:findFirst|findFirstOrThrow|findMany|findUnique|findUniqueOrThrow|count)\s*\(/],
  ['a phone IN filter', /\b(?:secondary_)?phone\s*:\s*\{\s*in\s*:/],
  ['a customer phone list filter', /\bphones\s*:\s*\{\s*some\s*:/],
  ['a second-phone filter', /\bsecondary_phone\s*:\s*(?:\{|phoneIn\b)/],
  ['a raw query on the phone list', /\b(?:FROM|JOIN)\s+"?customer_phones\b/i],
  ['a raw phone comparison', /\b(?:secondary_)?phone"?\s*(?:=|IN)\s*(?:\$\{|ANY\s*\(|\$\d|\()/i],
  ['the search clauses', /\bphone(?:Relation)?SearchClauses\s*\(/],
  ['the duplicate finder', /\bfindDuplicateCustomer\s*\(/],
  ['a customer query by a where built beforehand', customerWhereBuiltBeforehand],
];

/** The shapes a piece of source code has. */
function shapesOf(src: string): string[] {
  return SHAPES.filter(([, shape]) => (typeof shape === 'function' ? shape(src) : shape.test(src))).map(([name]) => name);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' || name === 'copilot' ? [] : sourceFiles(full);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : [];
  });
}

/** The file's code without comment lines or trailing line comments, so a mention in prose is not a lookup. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line))
    .map((line) => line.replace(/\s\/\/.*$/, ''))
    .join('\n');
}

describe('every place that picks one customer for a phone number uses the fixed order (#3015)', () => {
  const found = sourceFiles(SRC)
    .map((file) => ({ file: relative(SRC, file), shapes: shapesOf(code(file)) }))
    .filter((f) => f.shapes.length > 0);

  it('every file that looks customers up by a phone value is listed, as a fixed-order pick or with a reason it picks none', () => {
    const unlisted = found.filter((f) => !(f.file in PICKS_BY_FIXED_ORDER) && !(f.file in PICKS_NONE));
    expect(unlisted).toEqual([]);
  });

  it('a customer query whose where was built beforehand with a phone filter counts as a lookup by phone', () => {
    const built = [
      'const where = { organization_id: orgId, phone: n };\nconst c = await prisma.customer.findFirst({ where });',
      'const byNumber: Prisma.CustomerWhereInput = { secondary_phone: n };\nawait db.customer.findMany({ where: byNumber, take: 1 });',
      'const where: Prisma.CustomerWhereInput = { organization_id: orgId };\nwhere.OR = [{ phone: n }];\nawait prisma.customer.findFirst({ where });',
    ];
    const notByPhone = 'const where = { organization_id: orgId, is_active: true };\nawait prisma.customer.count({ where });\nconst row = { phone: c.phone };';

    expect(built.map((src) => shapesOf(src).includes('a customer query by a where built beforehand'))).toEqual([true, true, true]);
    expect(shapesOf(notByPhone)).toEqual([]);
  });

  it('every listed file still looks a number up (the lists stay honest)', () => {
    const files = new Set(found.map((f) => f.file));
    expect([...Object.keys(PICKS_BY_FIXED_ORDER), ...Object.keys(PICKS_NONE)].filter((f) => !files.has(f))).toEqual([]);
  });

  it('outside the identity match, a place that picks one customer does it through the identity match and filters no phone itself', () => {
    const wrong = found
      .filter((f) => f.file in PICKS_BY_FIXED_ORDER && f.file !== 'lib/comms-identity.ts')
      .filter((f) => !f.shapes.includes('the identity match') || f.shapes.some((s) => DIRECT_FILTERS.includes(s)));
    expect(wrong).toEqual([]);
  });

  it('a place that picks none, other than a search, never filters customers by a phone value itself, so it cannot quietly pick one', () => {
    const direct = found.filter((f) => f.file in PICKS_NONE && !SEARCHES.has(f.file) && f.shapes.some((s) => DIRECT_FILTERS.includes(s)));
    expect(direct).toEqual([]);
  });
});
