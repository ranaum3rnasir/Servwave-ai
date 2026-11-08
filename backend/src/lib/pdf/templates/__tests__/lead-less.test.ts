import { describe, it, expect } from 'vitest';
import { buildAlphaClassicPdf, type EstimateForPdf, type OrgForPdf } from '../alpha-classic';
import { buildCrmDefaultPdf } from '../crm-default';

const ORG: OrgForPdf = {
  name: 'Alpha', logo_url: null, brand_color: '#242424',
  estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
} as unknown as OrgForPdf;

const BASE = {
  estimate_number: 'E00099', created_at: new Date(), status: 'SENT',
  subtotal: 100, tax_rate: 0, tax_amount: 0, total_amount: 100,
  signature_data: null, signature_at: null,
  snapshot_terms: null, snapshot_notes: null, snapshot_payment_terms: null,
  line_items: [{ description: 'Rekey', item_type: 'LABOR', quantity: 1, unit_price: 100, line_total: 100, discount_amount: 0 }],
};

// The customer is reached via lead.customer — the legacy path every pre-R6 row (and today's
// create-from-lead path) still uses.
const LEAD_LINKED: EstimateForPdf = {
  ...BASE,
  customer: null,
  service_location: null,
  lead: {
    service_address_line1: null, service_address_line2: null,
    service_city: null, service_state: null, service_zip: null,
    customer: {
      first_name: 'Jane', last_name: 'Roe', company_name: 'Roe LLC', email: 'jane@roe.com', phone: '5559876543',
      service_locations: [{ is_primary: true, address_line1: '9 Oak St', address_line2: null, city: 'Austin', state: 'TX', zip: '78701' }],
    },
  },
} as unknown as EstimateForPdf;

// R6 (2026-07-22) — Estimate.customer_id/service_location_id now live directly on the row (M5).
// No create-time UI path produces a null-lead estimate yet, but the columns exist for future
// use — the template must render off them alone, with no `lead` to fall back on.
const LEAD_LESS: EstimateForPdf = {
  ...BASE,
  lead: null,
  customer: {
    first_name: 'Jane', last_name: 'Roe', company_name: 'Roe LLC', email: 'jane@roe.com', phone: '5559876543',
  },
  service_location: {
    address_line1: '9 Oak St', address_line2: null, city: 'Austin', state: 'TX', zip: '78701',
  },
} as unknown as EstimateForPdf;

describe('PDF templates render a lead-linked estimate (entity-redesign §4)', () => {
  it('alpha-classic builds a doc def without throwing', () => {
    expect(() => buildAlphaClassicPdf(LEAD_LINKED, ORG)).not.toThrow();
  });
  it('crm-default builds a doc def without throwing', () => {
    expect(() => buildCrmDefaultPdf(LEAD_LINKED, ORG)).not.toThrow();
  });
});

describe('PDF templates render a lead-less estimate off the direct customer/service_location anchor (R6)', () => {
  it('alpha-classic builds a doc def without throwing and prints the customer name', () => {
    const doc = buildAlphaClassicPdf(LEAD_LESS, ORG);
    expect(JSON.stringify(doc)).toContain('Roe LLC');
  });
  it('crm-default builds a doc def without throwing and prints the customer name', () => {
    const doc = buildCrmDefaultPdf(LEAD_LESS, ORG);
    expect(JSON.stringify(doc)).toContain('Roe LLC');
  });
});

// SERV10X-61 - a lead whose customer carries no `service_locations` array (or any caller that
// omits it) crashed `estimate.lead?.customer.service_locations.find(...)` with `undefined.find`.
// The `?.service_locations?.find` guard makes the primary-service-location lookup miss safely
// instead of throwing. Reverting the guard makes this test throw (non-placebo).
const LEAD_NO_SERVICE_LOCATIONS: EstimateForPdf = {
  ...BASE,
  customer: null,
  // A distinct service address exists (so isSameAsBilling proceeds to the primary lookup)…
  service_location: { address_line1: '9 Oak St', address_line2: null, city: 'Austin', state: 'TX', zip: '78701' },
  lead: {
    service_address_line1: '9 Oak St', service_address_line2: null,
    service_city: 'Austin', service_state: 'TX', service_zip: '78701',
    // …but the customer object has NO service_locations key at all.
    customer: {
      first_name: 'Jane', last_name: 'Roe', company_name: 'Roe LLC', email: 'jane@roe.com', phone: '5559876543',
    },
  },
} as unknown as EstimateForPdf;

describe('alpha-classic tolerates a customer with no service_locations array (guarded lookup)', () => {
  it('does not throw when lead.customer.service_locations is absent', () => {
    expect(() => buildAlphaClassicPdf(LEAD_NO_SERVICE_LOCATIONS, ORG)).not.toThrow();
  });
});
