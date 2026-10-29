/**
 * A heading is only printed when there is body text under it.
 *
 * Estimate and invoice PDFs used to emit "Terms:", "Notes:" and "PAYMENT TERMS:" unconditionally,
 * so a tenant who has not written their terms yet sent a document with bare headings and nothing
 * beneath them. This is not a demo-org artifact: `estimate_terms` and friends start out as the
 * empty string, and the send path snapshots that empty string, so every org's first sent estimate
 * showed it.
 *
 * "Empty" here means: after inline HTML is stripped (the converter drops it) and markdown syntax
 * characters are removed, nothing readable is left. NULL, '', whitespace, '**', '<br>' are all
 * empty; anything with a word or a number in it is not.
 *
 * These assertions read the pdfmake document definition, which is the seam the other suites in
 * this directory test, and they match a heading node EXACTLY — 'Payment Terms:' contains the
 * substring 'Terms:', so a JSON `toContain` check cannot tell the three headings apart.
 */
import { describe, it, expect } from 'vitest';
import { buildAlphaClassicPdf, buildAlphaClassicInvoicePdf } from '../alpha-classic';
import { buildCrmDefaultPdf, buildCrmDefaultInvoicePdf } from '../crm-default';
import { hasRenderableContent } from '../../markdown';
import { PREVIEW_ESTIMATE_FIXTURE, PREVIEW_INVOICE_FIXTURE } from '../../preview-fixture';

const ORG = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Example Services Co.',
  legal_name: null,
  address_line1: '1 Example Way',
  address_line2: null,
  city: 'Springfield', state: 'NJ', postal_code: '07081', country: 'US',
  email: 'billing@example.com',
  phone: null,
  website: null,
  logo_url: null,
  brand_color: '#333333',
  estimate_template: 'alpha-classic',
  estimate_terms: '',
  estimate_notes: '',
  estimate_payment_terms: '',
  invoice_terms: '',
  invoice_notes: '',
  invoice_payment_terms: '',
};

/** Every heading either template can print over a Terms/Notes/Payment-Terms body. */
const HEADINGS = ['Terms:', 'Notes:', 'Payment Terms:', 'PAYMENT TERMS:'];

/** The heading nodes the document actually prints, in order, matched exactly. */
function headings(doc: unknown): string[] {
  const content = (doc as { content: unknown[] }).content;
  return content
    .filter((n): n is { text: string } =>
      !!n && typeof (n as { text?: unknown }).text === 'string' && HEADINGS.includes((n as { text: string }).text))
    .map((n) => n.text);
}

/** The block drawn directly under `heading` — the body a customer reads. */
function bodyUnder(doc: unknown, heading: string): unknown {
  const content = (doc as { content: unknown[] }).content;
  const i = content.findIndex((n) => !!n && (n as { text?: unknown }).text === heading);
  expect(i, `no ${heading} heading in the document`).toBeGreaterThanOrEqual(0);
  return content[i + 1];
}

/**
 * A SENT estimate carries its own snapshot; the org's live copy is set to the same value so the
 * case holds whichever side `pickContent` picks. `null` is the brand-new tenant: no snapshot
 * written yet and an org column that is still blank.
 */
function estimateWith(content: string | null) {
  return [
    { ...PREVIEW_ESTIMATE_FIXTURE, status: 'SENT', snapshot_terms: content, snapshot_notes: content, snapshot_payment_terms: content },
    { ...ORG, estimate_terms: content ?? '', estimate_notes: content ?? '', estimate_payment_terms: content ?? '' },
  ] as [never, never];
}

function invoiceWith(content: string | null) {
  return [
    PREVIEW_INVOICE_FIXTURE,
    { ...ORG, invoice_terms: content, invoice_notes: content, invoice_payment_terms: content },
  ] as [never, never];
}

const EMPTY_CASES: Array<[string, string | null]> = [
  ['the empty string', ''],
  ['NULL', null],
  ['whitespace only', '   \n\t  '],
  ['markdown punctuation only', '**'],
  ['a lone list bullet', '- '],
  ['an inline HTML tag only', '<br>'],
];

const ESTIMATE_BUILDERS: Array<[string, (e: never, o: never) => unknown]> = [
  ['alpha-classic', buildAlphaClassicPdf as never],
  ['crm-default', buildCrmDefaultPdf as never],
];

const INVOICE_BUILDERS: Array<[string, (i: never, o: never) => unknown]> = [
  ['alpha-classic', buildAlphaClassicInvoicePdf as never],
  ['crm-default', buildCrmDefaultInvoicePdf as never],
];

describe('hasRenderableContent — what counts as an empty body', () => {
  it.each([
    [null], [undefined], [''], ['   '], ['\n\t '], ['**'], ['***'], ['- '], ['#'], ['>'], ['|'], ['<br>'], ['<p></p>'],
  ])('is false for %j', (input) => {
    expect(hasRenderableContent(input as string | null | undefined)).toBe(false);
  });

  it.each([
    ['Net 30'], ['30'], ['N/A'], ['**Bold.**'], ['- A bullet'], ['  leading space then words'], ['50%'],
  ])('is true for %j', (input) => {
    expect(hasRenderableContent(input)).toBe(true);
  });
});

describe.each(ESTIMATE_BUILDERS)('%s estimate — a heading needs a body', (_name, build) => {
  it.each(EMPTY_CASES)('prints no Terms/Notes/Payment Terms heading when the copy is %s', (_label, content) => {
    const doc = build(...estimateWith(content));
    expect(headings(doc)).toEqual([]);
  });

  it('still prints every heading, with its body, when there is copy', () => {
    const doc = build(...estimateWith('Net 30 on all work.'));
    expect(headings(doc)).toHaveLength(3);
    for (const heading of headings(doc)) {
      expect(JSON.stringify(bodyUnder(doc, heading))).toContain('Net 30 on all work.');
    }
  });

  it('prints the headings that have copy and drops the ones that do not', () => {
    const doc = build(
      { ...PREVIEW_ESTIMATE_FIXTURE, status: 'SENT', snapshot_terms: '  ', snapshot_notes: '- Bring the gate key', snapshot_payment_terms: '' } as never,
      { ...ORG, estimate_terms: '  ', estimate_notes: '- Bring the gate key', estimate_payment_terms: '' } as never,
    );
    expect(headings(doc)).toEqual(['Notes:']);
    expect(JSON.stringify(bodyUnder(doc, 'Notes:'))).toContain('Bring the gate key');
  });
});

describe.each(INVOICE_BUILDERS)('%s invoice — a heading needs a body', (_name, build) => {
  it.each(EMPTY_CASES)('prints no Terms/Notes/Payment Terms heading when the copy is %s', (_label, content) => {
    const doc = build(...invoiceWith(content));
    expect(headings(doc)).toEqual([]);
  });

  it('still prints every heading, with its body, when there is copy', () => {
    const doc = build(...invoiceWith('Due on receipt.'));
    expect(headings(doc)).toHaveLength(3);
    for (const heading of headings(doc)) {
      expect(JSON.stringify(bodyUnder(doc, heading))).toContain('Due on receipt.');
    }
  });
});
