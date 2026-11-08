/**
 * #2028 slice 4 — an unpriced scope block renders with a BLANK amount.
 *
 * Both templates filtered scopes down to those carrying a flat price, so a block describing work
 * with no separate price attached vanished from the customer's document entirely — the
 * salesperson wrote it and the customer never saw it. It contributes nothing to the totals, which
 * was already true and stays true; a blank amount says "not separately priced", where a zero
 * would tell the customer the work is free.
 */
import { describe, it, expect } from 'vitest';
import { buildAlphaClassicPdf } from '../alpha-classic';
import { buildCrmDefaultPdf } from '../crm-default';
import { PREVIEW_ESTIMATE_FIXTURE } from '../../preview-fixture';

const ORG = {
  name: 'Northwind Services LLC',
  address_line1: '1001 Willow Avenue',
  address_line2: null,
  city: 'Hoboken', state: 'NJ', postal_code: '07030',
  email: 'info@northwind.example.com',
  phone: null,
  website: null,
  logo_url: null,
  brand_color: '#E11D2E',
  estimate_terms: 'Sample terms.',
  estimate_notes: '',
  estimate_payment_terms: '',
};

const PRICED = {
  id: 'scope-1',
  title: 'Install 3 commercial storefront doors',
  body: 'Remove existing units, install new frames and hardware.',
  flat_price: 2000,
  is_taxable: true,
};

const UNPRICED = {
  id: 'scope-2',
  title: 'Site survey and measurements',
  body: 'Included at no separate charge.',
  flat_price: null,
  is_taxable: false,
};

const TEMPLATES = [
  ['alpha-classic', buildAlphaClassicPdf] as const,
  ['crm-default', buildCrmDefaultPdf] as const,
];

describe.each(TEMPLATES)('%s — unpriced scope blocks', (_name, build) => {
  function doc(scopes: unknown[], over: Record<string, unknown> = {}) {
    return JSON.stringify(build({ ...PREVIEW_ESTIMATE_FIXTURE, scopes, ...over } as never, ORG as never));
  }

  it('prints an unpriced block with its description', () => {
    const json = doc([UNPRICED]);

    expect(json).toContain('Site survey and measurements');
    expect(json).toContain('Included at no separate charge.');
  });

  it('leaves its amount blank rather than printing a zero', () => {
    const json = doc([UNPRICED]);

    // A "$0.00" against this row would tell the customer the work is free. There is no such
    // figure anywhere on a document whose other amounts are all non-zero.
    expect(json).not.toContain('$0.00');
  });

  it('still prints a priced block with its amount', () => {
    expect(doc([PRICED])).toContain('$2,000.00');
  });

  it('prints both when an estimate mixes them, and the printed amounts still reconcile', () => {
    const json = doc([PRICED, UNPRICED]);

    expect(json).toContain('Install 3 commercial storefront doors');
    expect(json).toContain('Site survey and measurements');
    // The priced block's amount is printed exactly once; the unpriced one adds no second figure.
    expect(json.split('$2,000.00').length - 1).toBe(1);
  });
});
