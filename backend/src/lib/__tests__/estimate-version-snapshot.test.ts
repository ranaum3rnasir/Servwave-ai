/**
 * #2030 slice 1 — the send-time snapshot becomes a complete document record.
 *
 * Sending already wrote a frozen record — version, total, line items, scopes — but it has never
 * had a reader, and it held enough for a summary and not enough to RE-RENDER the document: no
 * photos, no branding. Extended to carry everything the document view-model consumes, a past
 * version can be rendered by the same code that renders the live one, rather than by a parallel
 * read-only implementation that would drift.
 *
 * There are already three competing change mechanisms — clone-into-a-new-number (revise), this
 * snapshot, and send-back-to-draft-and-edit-in-place. The third produced the estimate Ran
 * reported. This slice adds no fourth: it gives the second one a reader.
 */
import { describe, it, expect } from 'vitest';
import { buildVersionSnapshotDocument, snapshotDocumentPaths } from '../estimate-version-snapshot';
import { buildEstimateDocumentView } from '../estimate-document-view';

const ORG = {
  name: 'Northwind Services LLC',
  address_line1: '1001 Willow Avenue',
  address_line2: null,
  city: 'Hoboken', state: 'NJ', postal_code: '07030',
  email: 'info@northwind.example.com',
  phone: null,
  website: 'https://northwind.example.com/',
  logo_url: 'https://x.supabase.co/logo.png',
  brand_color: '#E11D2E',
  estimate_terms: 'Live terms.',
  estimate_notes: 'Live notes.',
  estimate_payment_terms: 'Live payment terms.',
  estimate_template: 'alpha-classic',
};

const ESTIMATE = {
  estimate_number: 'E00042',
  created_at: new Date('2026-09-01T00:00:00Z'),
  status: 'SENT',
  subtotal: 2200,
  discount_amount: 0,
  discount_name: null,
  tax_rate: 0,
  tax_amount: 0,
  total_amount: 2200,
  signature_data: null,
  signature_at: null,
  snapshot_terms: 'Terms as sent.',
  snapshot_notes: 'Notes as sent.',
  snapshot_payment_terms: 'Payment terms as sent.',
  scope_notes: 'Business hours only.',
  scopes: [{ id: 'scope-1', title: 'Doors', body: 'Three of them.', flat_price: 2000, is_taxable: true }],
  scope_photos: [
    { id: 'sp-1', scope_id: 'scope-1', url: 'https://signed.test/1.jpg', caption: 'Frame', storage_path: 'org/estimate_scope/est-1/scope-1/1-a.jpg' },
  ],
  customer: { first_name: 'Jane', last_name: 'Doe', company_name: null, email: 'jane@x.com', phone: '5551234567' },
  service_location: { address_line1: '1 Main', address_line2: null, city: 'Hoboken', state: 'NJ', zip: '07030' },
  lead: null,
  line_items: [
    { id: 'li-1', description: 'Keypad', item_type: 'MATERIAL', quantity: 1, unit_price: 200, line_total: 200, discount_amount: 0 },
  ],
};

describe('the version snapshot document', () => {
  it('carries every field the document view-model consumes', () => {
    const snapshot = buildVersionSnapshotDocument(ESTIMATE as never, ORG as never, 'alpha-classic');
    const live = buildEstimateDocumentView(ESTIMATE as never, ORG as never);

    // The guard the slice asks for: a field added to the view-model but missing from the snapshot
    // fails HERE, rather than silently blanking on a version somebody opens next year.
    expect(snapshotDocumentPaths(snapshot.view)).toEqual(snapshotDocumentPaths(live));
  });

  it('captures the branding as it stood at send time', () => {
    const snapshot = buildVersionSnapshotDocument(ESTIMATE as never, ORG as never, 'alpha-classic');

    expect(snapshot.org).toMatchObject({
      name: 'Northwind Services LLC',
      logo_url: 'https://x.supabase.co/logo.png',
      brand_color: '#E11D2E',
    });
    // The TEMPLATE too: an org that switches template later must not re-render an old version in
    // a shape the customer never saw.
    expect(snapshot.templateKey).toBe('alpha-classic');
  });

  it('captures the customer and service location the document was addressed to', () => {
    const snapshot = buildVersionSnapshotDocument(ESTIMATE as never, ORG as never, 'alpha-classic');

    expect(snapshot.customer).toMatchObject({ first_name: 'Jane', last_name: 'Doe' });
    expect(snapshot.serviceLocation).toMatchObject({ address_line1: '1 Main' });
  });

  it('records each photo by its STORAGE PATH, never by a signed url', () => {
    const snapshot = buildVersionSnapshotDocument(ESTIMATE as never, ORG as never, 'alpha-classic');

    const photo = snapshot.view.rows.find((r) => r.kind === 'scope')!.photos[0]!;
    // A signed url expires within the hour; a version is meant to outlive that by years, so the
    // snapshot stores what can be re-signed rather than what was already signed.
    expect(photo.url).not.toContain('signed.test');
    expect(snapshot.photoPaths).toEqual(['org/estimate_scope/est-1/scope-1/1-a.jpg']);
  });

  it('freezes the copy the customer was sent, not the org\'s current copy', () => {
    const snapshot = buildVersionSnapshotDocument(
      { ...ESTIMATE, status: 'SENT' } as never,
      { ...ORG, estimate_terms: 'Terms changed since.' } as never,
      'alpha-classic',
    );

    expect(snapshot.view.terms).toBe('Terms as sent.');
  });
});
