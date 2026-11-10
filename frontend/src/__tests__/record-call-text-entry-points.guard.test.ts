/* =============================================================================
   #3016 entry-point guard: every place that draws a Call or a Text, and which number it uses on a lead or a job.

   A lead's or job's effective number (the record's changed number for the customer's primary, else the primary) feeds the
   places #3013 names: "Call customer" on both Communication tabs (#3016), the job header and the Overview's Call and
   Text buttons (#3017), and the line above the text box (#3023). The contact block draws a changed number in the
   customer's number's own place, so its tap already uses it.

   This walks the source for every file that draws a call or text control for a number, and every one must be in the
   table below with the reason it uses the number it uses. A new one fails here until it is classified. A file marked
   EFFECTIVE must work its number out with `recordEffectivePhone`.
   ============================================================================= */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Drawing a call or text control for a number: the dial handoff, the contact action and the components built on it. */
const DRAWS_CALL_OR_TEXT = /requestCall\(|<PhoneValue\b|<PhoneContactActions\b|<CustomerContactBlock\b|<CustomerContactButtons\b|<ContactAction\b|textPath\(|<PrimaryContactLines\b/;

type Use =
  | 'EFFECTIVE' // a lead or job: the record's effective number (#3016)
  | 'IN_PLACE' // a lead or job: draws the record's changed number in the customer number's place
  | 'CUSTOMER_NUMBER' // the customer's own number: not a lead or job, or not one of #3013's effective-number places
  | 'NOT_A_CUSTOMER' // a crew member's, a vendor's or the call's own number
  | 'BUILDING_BLOCK'; // the contact action itself; its callers are classified

const TABLE: Record<string, Use> = {
  'components/communication/LeadCommunicationsTab.tsx': 'EFFECTIVE',
  'components/communication/JobCommunicationsTab.tsx': 'EFFECTIVE',
  // The lead page's and the job Overview's customer block: a changed phone stands in the customer's phone's place. Its Text on
  // any other number than the primary as it stands names that number with the record (#3018). Its Call and Text buttons
  // (`showActions`, the job Overview card's) use the effective number (#3017).
  'components/contact/CustomerContactBlock.tsx': 'EFFECTIVE',
  'pages/v2/leads/LeadDetailPage.tsx': 'IN_PLACE',
  'components/jobs/overview/CustomerContactCard.tsx': 'IN_PLACE',
  // The job header's number (#3017).
  'pages/v2/jobs/JobDetailPage.tsx': 'EFFECTIVE',
  // A lead row in the leads list, a visit on the schedule and an estimate's header carry the customer's number: #3013 names
  // the effective number for the record pages only.
  'pages/v2/_shared/contactCell.tsx': 'CUSTOMER_NUMBER',
  'pages/v2/schedule/components/eventEditor.tsx': 'CUSTOMER_NUMBER',
  'features/estimate-workspace/components/CustomerHeader.tsx': 'CUSTOMER_NUMBER',
  'pages/v2/invoices/InvoiceDetailPage.tsx': 'CUSTOMER_NUMBER',
  'pages/CustomerDetailPage.tsx': 'CUSTOMER_NUMBER',
  'pages/v2/customers/CustomerDetailPage.tsx': 'CUSTOMER_NUMBER',
  'components/jobs/TeamCard.tsx': 'NOT_A_CUSTOMER',
  'components/communication/phone/CallsView.tsx': 'NOT_A_CUSTOMER',
  'components/contact/ContactAction.tsx': 'BUILDING_BLOCK',
  'components/contact/CustomerContactButtons.tsx': 'BUILDING_BLOCK',
  'components/contact/PhoneContactActions.tsx': 'BUILDING_BLOCK',
  'components/contact/contactHrefs.ts': 'BUILDING_BLOCK',
  'lib/communication/phoneTabHandoff.ts': 'BUILDING_BLOCK',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === '__tests__' || name === 'node_modules') return [];
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const rel = (file: string) => relative(SRC, file).split('\\').join('/');

describe('every place that draws a Call or a Text, and the number it uses on a lead or a job', () => {
  const drawers = sourceFiles(SRC)
    .filter((file) => DRAWS_CALL_OR_TEXT.test(readFileSync(file, 'utf8')))
    .map(rel)
    .sort();

  it('is classified in the table', () => {
    expect(drawers).toEqual(Object.keys(TABLE).sort());
  });

  it.each(Object.entries(TABLE).filter(([, use]) => use === 'EFFECTIVE'))('%s works its number out as the effective number', (file) => {
    expect(readFileSync(join(SRC, file), 'utf8')).toMatch(/recordEffectivePhone\(/);
  });

  it("every page that draws a Communication tab hands it the record's own entries", () => {
    const tabs = sourceFiles(SRC).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/<(LeadCommunicationsTab|JobCommunicationsTab)\b[\s\S]*?\/>/g)].map((m) => ({
        where: `${rel(file)} <${m[1]}>`,
        passesEntries: /\bcontactEntries=/.test(m[0]),
      })),
    );
    expect(tabs.map((t) => t.where).sort()).toEqual([
      'pages/v2/jobs/JobDetailPage.tsx <JobCommunicationsTab>',
      'pages/v2/leads/LeadDetailPage.tsx <LeadCommunicationsTab>',
    ]);
    expect(tabs.filter((t) => !t.passesEntries)).toEqual([]);
  });
});
