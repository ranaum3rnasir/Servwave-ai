/* =============================================================================
   Source guard: guard the number (whole-diff security ruling, Ran 2026-11-07).

   Every place in the backend that writes what makes a customer carry a number (a customer's phone fields, a phones-list row,
   or a lead's or job's own contact entry) is listed here, so a new one cannot be added unseen. A PERSON door must ask the
   guard (lib/communication/numberGuard.ts); everything else says why it is not a person door. A file that writes none of
   these is not listed. The scan covers backend/src and backend/scripts (a script is invisible to a src-only scan).
   ========================================================================== */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const BACKEND = join(__dirname, '..', '..');

/** A write that can put a number on a customer: the models' writers, nested relation writes and raw SQL. */
const WRITER = new RegExp(
  [
    String.raw`\b(customer|customerPhone|recordContactEntry)\.(create|createMany|update|updateMany|upsert)\b`,
    String.raw`\b(phones|customer|record_contact_entries)\s*:\s*\{\s*(create|createMany|update|updateMany|upsert|connectOrCreate)\b`,
    String.raw`\b(INSERT\s+INTO|UPDATE)\s+("?public"?\s*\.\s*)?"?(customers|customer_phones|record_contact_entries)"?\b`,
  ].join('|'),
  'i',
);

/** Person doors: each asks the guard. */
const GUARDED = [
  'src/controllers/customer.controller.ts', // customer create (Create anyway included) and edit
  'src/controllers/lead.controller.ts', // new lead: a new customer, or a phone typed for an existing one
  'src/controllers/job.controller.ts', // new job: the same
  'src/controllers/record-contact-entries.controller.ts', // a lead's and a job's own entries: add, change, correct
  'src/lib/job-review-apply.ts', // the office review's apply, inside the finish
];

/** Not person doors, with the reason. */
const NOT_A_PERSON_DOOR: Record<string, string> = {
  'src/lib/customer-accretion.ts': 'the write behind the new lead and new job forms, which ask the guard before calling it',
  'src/lib/customer-create.ts': 'fills a new customer\'s required columns for the doors that create one',
  'src/lib/record-contact-entries.ts': 'converting a lead copies its entries onto the job of the same customer: no new carrier',
  'src/lib/web-form/process.ts': 'a public web form submission: no signed-in person',
  'src/scripts/backfill-customer-number.ts': 'a script (customer numbers, not phones)',
  'src/seed-demo-org.ts': 'a seed script',
  'src/seed-org-b.ts': 'a seed script',
  'src/seed-technician.ts': 'a seed script',
  'scripts/synthetic-big-company.ts': 'a script that builds a synthetic company',
  'scripts/verify-stripe/ach-refund-events.ts': 'a payments verification script',
  'scripts/verify-stripe/bank-events.ts': 'a payments verification script',
  'scripts/verify-stripe/checkout-events.ts': 'a payments verification script',
  'scripts/verify-stripe/dispute-events.ts': 'a payments verification script',
  'scripts/verify-stripe/estimate-deposit-flows.ts': 'a payments verification script',
  'scripts/verify-stripe/harness.ts': 'a payments verification script',
  'scripts/verify-stripe/refund-events.ts': 'a payments verification script',
};

/** What asking the guard looks like in a door's source. */
const ASKS_THE_GUARD = /\b(numberCarryCheckForReq|mayAddTypedPhoneForReq|mayCarry)\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : sourceFiles(path);
    return /\.ts$/.test(name) && !/\.(test|spec)\.ts$/.test(name) ? [path] : [];
  });
}

const writers = [...sourceFiles(join(BACKEND, 'src')), ...sourceFiles(join(BACKEND, 'scripts'))]
  .filter((path) => WRITER.test(readFileSync(path, 'utf8')))
  .map((path) => relative(BACKEND, path).split('\\').join('/'))
  .sort();

describe('every write that makes a customer carry a number', () => {
  it('is a listed person door or says why it is not one', () => {
    const unlisted = writers.filter((file) => !GUARDED.includes(file) && !(file in NOT_A_PERSON_DOOR));
    expect(unlisted).toEqual([]);
  });

  it('lists no file that no longer writes one', () => {
    expect([...GUARDED, ...Object.keys(NOT_A_PERSON_DOOR)].filter((file) => !writers.includes(file))).toEqual([]);
  });

  it.each(GUARDED)('%s asks the guard', (file) => {
    expect(readFileSync(join(BACKEND, file), 'utf8')).toMatch(ASKS_THE_GUARD);
  });

  it('accretion is called only from doors that ask the guard first', () => {
    const callers = sourceFiles(join(BACKEND, 'src'))
      .filter((path) => /\baccreteContactMethods\(/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(BACKEND, path).split('\\').join('/'))
      .filter((file) => file !== 'src/lib/customer-accretion.ts')
      .sort();
    expect(callers).toEqual(['src/controllers/job.controller.ts', 'src/controllers/lead.controller.ts']);
    for (const file of callers) expect(readFileSync(join(BACKEND, file), 'utf8')).toMatch(/\bmayAddTypedPhoneForReq\(/);
  });
});
