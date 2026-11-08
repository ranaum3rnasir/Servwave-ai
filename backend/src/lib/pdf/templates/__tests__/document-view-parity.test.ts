/**
 * #2028 slice 2 — the view-model extraction is a NO-OP.
 *
 * Both templates now render from `buildEstimateDocumentView` instead of deciding for themselves.
 * These snapshots are the proof that nothing moved: they were captured from the templates as they
 * stood BEFORE the extraction, across the shapes whose handling differs (no scopes, a priced
 * scope, an unpriced one, both discount kinds, a signature, a draft reading live copy). A
 * refactor that changes what a customer sees fails here.
 *
 * The whole docDefinition is compared as JSON — pdfmake's `layout` callbacks are fresh closures
 * per build and never reference-equal, and dropping them is exactly what JSON.stringify does.
 *
 * #2028 slice 3 RE-BASELINED every snapshot in this file, deliberately. The document now prints
 * only the sections that have content, as two distinct sections, so it is no longer the same
 * document it was before the extraction and cannot be: a "Scope of Work:" / "Line Items:" heading
 * now precedes each table, scope blocks moved out of the line-item table into their own
 * two-column one above it, and a scope-only estimate draws no line-item column strip at all.
 * These snapshots are the standing guard on THAT document. Anything beyond the sections — the
 * figures, the totals, the terms, the signature — is still expected to be untouched, and a diff
 * here that touches them is a regression, not a re-baseline.
 */
import { describe, it, expect } from 'vitest';
import { buildAlphaClassicPdf } from '../alpha-classic';
import { buildCrmDefaultPdf } from '../crm-default';
import { PREVIEW_ESTIMATE_FIXTURE } from '../../preview-fixture';

const ORG = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Northwind Services LLC',
  legal_name: null,
  address_line1: '1001 Willow Avenue',
  address_line2: null,
  city: 'Hoboken', state: 'NJ', postal_code: '07030', country: 'US',
  email: 'info@northwind.example.com',
  phone: null,
  website: 'https://northwind.example.com/',
  logo_url: null,
  brand_color: '#E11D2E',
  estimate_template: 'alpha-classic',
  estimate_terms: 'Sample terms.',
  estimate_notes: '- Note A\n- Note B',
  estimate_payment_terms: '- 70% on acceptance',
};

const PRICED_SCOPE = {
  id: 'scope-1',
  title: 'Install 3 commercial storefront doors',
  body: 'Remove existing units, install new frames and hardware.',
  flat_price: 2000,
  is_taxable: true,
};

const SHAPES: Array<[string, Record<string, unknown>]> = [
  ['a plain estimate with no scopes and no discounts', {}],
  ['a priced scope block', { scopes: [PRICED_SCOPE] }],
  ['an unpriced scope block', { scopes: [{ ...PRICED_SCOPE, flat_price: null }] }],
  ['priced and unpriced scopes together', { scopes: [PRICED_SCOPE, { ...PRICED_SCOPE, id: 'scope-2', title: 'Site survey', flat_price: null }] }],
  ['a document-level discount', { discount_name: 'Repeat customer', discount_amount: 150 }],
  ['an unnamed document-level discount', { discount_name: null, discount_amount: 150 }],
  ['scope notes', { scope_notes: 'Work is performed during business hours.' }],
  ['a signature', { signature_data: 'data:image/png;base64,iVBORw0KGgo=', signature_at: new Date('2026-09-05T00:00:00Z') }],
  ['a draft, which reads the org\'s live copy', { status: 'DRAFT', snapshot_terms: 'Stale.', snapshot_notes: 'Stale.', snapshot_payment_terms: 'Stale.' }],
  ['a sent estimate reading its own snapshot', { status: 'SENT', snapshot_terms: 'Terms as sent.', snapshot_notes: 'Notes as sent.', snapshot_payment_terms: 'Payment terms as sent.' }],
];

const TEMPLATES: Array<[string, (e: never, o: never) => unknown]> = [
  ['alpha-classic', buildAlphaClassicPdf as never],
  ['crm-default', buildCrmDefaultPdf as never],
];

describe.each(TEMPLATES)('%s renders identically after the view-model extraction', (name, build) => {
  it.each(SHAPES)('for %s', (shape, over) => {
    const doc = build({ ...PREVIEW_ESTIMATE_FIXTURE, ...over } as never, ORG as never);

    expect(JSON.parse(JSON.stringify(doc))).toMatchSnapshot(`${name} — ${shape}`);
  });
});
