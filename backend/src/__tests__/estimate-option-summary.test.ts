/**
 * #2090 (slice 3d) - the approval notification and the customer's approval email name the add-ons
 * the customer chose and the ones they turned down.
 *
 * The derivation is the DOCUMENT's own (`lib/estimate-document-view.ts`), which is the point: the
 * parity block below builds a real document view and asserts the lightweight summary the
 * notification path uses agrees with it row for row, so the email can never call something
 * declined that the attached PDF prints as included.
 */
import { describe, it, expect } from 'vitest';
import {
  buildEstimateDocumentView,
  summariseDocumentOptions,
  summariseEstimateOptions,
} from '../lib/estimate-document-view';
import { optionSummaryData } from '../lib/estimates/optionSummary';
import { renderTemplate } from '../services/notifications/templates';

const LINES = [
  { description: 'Door install\nTwo crew, one day', is_optional: false, is_selected: true },
  { description: 'Smart keypad\nBluetooth unlock', is_optional: true, is_selected: true },
  { description: 'Extended warranty', is_optional: true, is_selected: false },
];

const SCOPES = [
  { id: 's1', title: 'Permit filing', body: '', flat_price: 150, is_taxable: true, is_optional: true, is_selected: false },
  { id: 's2', title: 'Site survey', body: '', flat_price: 0, is_taxable: false, is_optional: false, is_selected: true },
];

describe('#2090 summariseEstimateOptions', () => {
  it('splits the add-ons into chosen and declined, naming each as the document names it', () => {
    const summary = summariseEstimateOptions({ line_items: LINES, scopes: SCOPES });

    // The first line of the description is the item name, exactly as every surface splits it.
    expect(summary.chosen).toEqual(['Smart keypad']);
    expect(summary.declined).toEqual(['Extended warranty', 'Permit filing']);
  });

  it('an estimate that offers nothing optional produces two empty lists', () => {
    const summary = summariseEstimateOptions({ line_items: [LINES[0]], scopes: [SCOPES[1]] });
    expect(summary).toEqual({ chosen: [], declined: [] });
  });

  it('a pre-migration row carrying neither flag is not an add-on', () => {
    const summary = summariseEstimateOptions({ line_items: [{ description: 'Legacy line' }], scopes: null });
    expect(summary).toEqual({ chosen: [], declined: [] });
  });
});

describe('#2090 the summary agrees with the document it is summarising', () => {
  it('matches what buildEstimateDocumentView marks, row for row', () => {
    const view = buildEstimateDocumentView(
      {
        estimate_number: 'E00042',
        created_at: new Date('2026-09-15'),
        status: 'WON',
        subtotal: 1300,
        discount_amount: 0,
        discount_name: null,
        tax_rate: 0,
        tax_amount: 0,
        total_amount: 1300,
        signature_data: null,
        signature_at: null,
        snapshot_terms: null,
        snapshot_notes: null,
        snapshot_payment_terms: null,
        scopes: SCOPES,
        scope_photos: [],
        line_items: LINES.map((li, i) => ({
          id: `li-${i}`,
          description: li.description,
          item_type: 'SERVICE',
          quantity: 1,
          unit_price: 100,
          line_total: 100,
          discount_type: null,
          discount_value: null,
          discount_amount: 0,
          is_optional: li.is_optional,
          is_selected: li.is_selected,
        })),
      } as never,
      { name: 'Test Org' } as never,
    );

    expect(summariseDocumentOptions(view.rows)).toEqual(summariseEstimateOptions({ line_items: LINES, scopes: SCOPES }));
  });
});

describe('#2090 the estimate.approved notification body', () => {
  const approved = (data: Record<string, unknown>) => renderTemplate('estimate.approved', data);

  it('names the chosen and declined add-ons beside the amount', () => {
    const body = approved({
      object_label: 'E00042',
      amount: '1,300.00',
      ...optionSummaryData({ chosen: ['Smart keypad'], declined: ['Extended warranty', 'Permit filing'] }),
    }).body;

    expect(body).toContain('Amount: $1,300.00');
    expect(body).toContain('Chose: Smart keypad');
    expect(body).toContain('Declined: Extended warranty, Permit filing');
  });

  it('is byte-for-byte the old amount line when the estimate offered no add-ons', () => {
    const body = approved({ object_label: 'E00042', amount: '1,300.00', ...optionSummaryData({ chosen: [], declined: [] }) }).body;
    expect(body).toBe('Amount: $1,300.00');
  });

  it('carries no body at all on an estimate with neither an amount nor add-ons', () => {
    expect(approved({ object_label: 'E00042' }).body).toBeUndefined();
  });

  it('omits an empty list rather than sending an empty key', () => {
    expect(optionSummaryData({ chosen: ['A'], declined: [] })).toEqual({ options_chosen: 'A' });
    expect(optionSummaryData({ chosen: [], declined: [] })).toEqual({});
  });
});
