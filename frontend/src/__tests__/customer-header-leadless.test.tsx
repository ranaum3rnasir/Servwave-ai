/**
 * CustomerHeader - lead-less (customer-anchored) estimates. A customer-anchored estimate has no
 * `lead`, so the header must render from the estimate's DIRECT `customer` instead of bailing out.
 * The Service Location column prefers the lead's own service_* scalars and falls back to the
 * denormalized `service_location` whenever those are blank - lead or no lead, since Lead's
 * `service_location_id` and its `service_address_*` scalars are independently settable and the
 * backend returns `service_location` on every estimate. It collapses to a single column only when
 * BOTH sources are empty; an estimate with neither a lead nor a customer still renders nothing.
 *
 * Also pins the two address fields the API and the header used to disagree about: the customer's
 * `billing_*` set (absent from estimateDetailSelect entirely, so "Prepared For" never showed an
 * address) and the lead's `service_address_line1` (declared here as `service_address_line`, a name
 * the API never sends, so the service street line never rendered).
 */
import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import { CustomerHeader } from '@/features/estimate-workspace/components/CustomerHeader';
import type { PanelEstimate } from '@/features/estimate-workspace/lib/panelEstimate';

function estimate(overrides: Partial<PanelEstimate> = {}): PanelEstimate {
  return {
    id: 'e0000000-0000-0000-0000-000000000001',
    estimate_number: 'E00123',
    status: 'DRAFT',
    tax_rate: 0,
    created_at: '2026-07-20T00:00:00.000Z',
    lead_id: null,
    lead: null,
    ...overrides,
  };
}

const CUSTOMER = {
  first_name: 'Dana',
  last_name: 'Whitfield',
  phone: '5550001111',
  email: 'dana@example.com',
  billing_address_line1: '900 Oak Ave',
  billing_city: 'Round Rock',
  billing_state: 'TX',
  billing_zip: '78664',
};

/** The denormalized job site the backend returns on the detail select for a lead-less estimate. */
const SERVICE_LOCATION = {
  address_line1: '77 Industrial Pkwy',
  address_line2: null,
  city: 'Pflugerville',
  state: 'TX',
  zip: '78660',
};

describe('CustomerHeader - lead-less customer-anchored estimate', () => {
  it('renders the customer from the direct `customer` field when there is no lead', () => {
    renderWithProviders(
      <CustomerHeader estimate={estimate({ customer_id: 'c-1', customer: CUSTOMER })} />,
    );

    expect(screen.getByText('Dana Whitfield')).toBeInTheDocument();
    expect(screen.getByText('900 Oak Ave')).toBeInTheDocument();
    expect(screen.getByText('Round Rock, TX 78664')).toBeInTheDocument();
    // Still the "Prepared For" document header, and the "Attached to" strip says so explicitly
    // rather than rendering an empty bar.
    expect(screen.getByText('Prepared For')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Lead/ })).not.toBeInTheDocument();
    expect(screen.getByText(/stands on its own/)).toBeInTheDocument();
  });

  it('omits the Service Location column entirely when there is no lead AND no service_location (no empty half)', () => {
    renderWithProviders(
      <CustomerHeader
        estimate={estimate({ customer_id: 'c-1', customer: CUSTOMER, service_location: null })}
      />,
    );

    // The header DID render (guards against this passing trivially on a null render) - it just
    // collapses to the single "Prepared For" column instead of an empty Service Location half.
    expect(screen.getByText('Prepared For')).toBeInTheDocument();
    expect(screen.queryByText('Service Location')).not.toBeInTheDocument();
  });

  it('renders nothing when there is neither a lead nor a direct customer', () => {
    const { container } = renderWithProviders(<CustomerHeader estimate={estimate({ customer: null })} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('still prefers the lead customer + renders both columns for a lead-anchored estimate', () => {
    renderWithProviders(
      <CustomerHeader
        estimate={estimate({
          lead_id: 'l-1',
          lead: {
            id: 'l-1',
            customer: { first_name: 'John', last_name: 'Doe', company_name: 'Doe HVAC' },
            service_address_line1: '123 Main St',
            service_city: 'Austin',
            service_state: 'TX',
            service_zip: '78701',
          },
        })}
      />,
    );

    expect(screen.getAllByText('Doe HVAC').length).toBeGreaterThan(0);
    expect(screen.getByText('Service Location')).toBeInTheDocument();
    expect(screen.getByText('123 Main St')).toBeInTheDocument();
  });

  it('renders the Service Location column from the denormalized service_location when there is no lead', () => {
    renderWithProviders(
      <CustomerHeader
        estimate={estimate({
          customer_id: 'c-1',
          customer: CUSTOMER,
          service_location: SERVICE_LOCATION,
        })}
      />,
    );

    // Both columns now: billing on the left, the denormalized job site on the right.
    expect(screen.getByText('Prepared For')).toBeInTheDocument();
    expect(screen.getByText('Service Location')).toBeInTheDocument();
    expect(screen.getByText('77 Industrial Pkwy')).toBeInTheDocument();
    expect(screen.getByText('Pflugerville, TX 78660')).toBeInTheDocument();
    // The billing column is untouched by the fallback - the two addresses stay distinct.
    expect(screen.getByText('900 Oak Ave')).toBeInTheDocument();
    expect(screen.getByText('Round Rock, TX 78664')).toBeInTheDocument();
  });
});

describe('CustomerHeader - Service Location source precedence', () => {
  const LEAD_WITH_BLANK_ADDRESS = {
    id: 'l-1',
    customer: { first_name: 'John', last_name: 'Doe', company_name: 'Doe HVAC' },
    service_address_line1: null,
    service_address_line2: null,
    service_city: null,
    service_state: null,
    service_zip: null,
  };

  it('falls back to service_location for a LEAD-anchored estimate whose lead has no address scalars', () => {
    // Lead.service_location_id and Lead.service_address_* are independently settable (both
    // optional in schema.prisma, and the scalars are the deprecated half), and
    // estimateDetailSelect returns `service_location` on EVERY estimate - so branching on the
    // presence of the LEAD used to drop the column with the address sitting right there.
    renderWithProviders(
      <CustomerHeader
        estimate={estimate({
          lead_id: 'l-1',
          lead: LEAD_WITH_BLANK_ADDRESS,
          service_location: SERVICE_LOCATION,
        })}
      />,
    );

    expect(screen.getByText('Service Location')).toBeInTheDocument();
    expect(screen.getByText('77 Industrial Pkwy')).toBeInTheDocument();
    expect(screen.getByText('Pflugerville, TX 78660')).toBeInTheDocument();
  });

  it("prefers the lead's own address WHOLE, never spliced field-by-field with service_location", () => {
    renderWithProviders(
      <CustomerHeader
        estimate={estimate({
          lead_id: 'l-1',
          // A street line and nothing else - the shape that exposes a field-level fallback.
          lead: { ...LEAD_WITH_BLANK_ADDRESS, service_address_line1: '123 Main St' },
          service_location: SERVICE_LOCATION,
        })}
      />,
    );

    // The lead's street stands alone. Filling its missing city line from the OTHER source would
    // render "123 Main St / Pflugerville, TX 78660" - an address that exists nowhere.
    expect(screen.getByText('123 Main St')).toBeInTheDocument();
    expect(screen.queryByText('77 Industrial Pkwy')).not.toBeInTheDocument();
    expect(screen.queryByText('Pflugerville, TX 78660')).not.toBeInTheDocument();
  });

  it('keeps the column for an address that is nothing but an address_line2', () => {
    renderWithProviders(
      <CustomerHeader
        estimate={estimate({
          customer_id: 'c-1',
          customer: CUSTOMER,
          service_location: { address_line1: null, address_line2: 'Bldg C, Dock 4', city: null, state: null, zip: null },
        })}
      />,
    );

    expect(screen.getByText('Service Location')).toBeInTheDocument();
    expect(screen.getByText('Bldg C, Dock 4')).toBeInTheDocument();
  });
});

describe('CustomerHeader - "Prepared For" billing address', () => {
  it('renders the billing address for a LEAD-anchored estimate (off lead.customer)', () => {
    renderWithProviders(
      <CustomerHeader
        estimate={estimate({
          lead_id: 'l-1',
          lead: {
            id: 'l-1',
            customer: {
              first_name: 'John',
              last_name: 'Doe',
              company_name: 'Doe HVAC',
              billing_address_line1: '450 Congress Ave',
              billing_city: 'Austin',
              billing_state: 'TX',
              billing_zip: '78701',
            },
            service_address_line1: '123 Main St',
            service_city: 'Georgetown',
            service_state: 'TX',
            service_zip: '78626',
          },
        })}
      />,
    );

    expect(screen.getByText('450 Congress Ave')).toBeInTheDocument();
    expect(screen.getByText('Austin, TX 78701')).toBeInTheDocument();
    // Not at the cost of the service column.
    expect(screen.getByText('123 Main St')).toBeInTheDocument();
    expect(screen.getByText('Georgetown, TX 78626')).toBeInTheDocument();
  });

  it('renders the billing address for a LEAD-LESS estimate (off the direct customer)', () => {
    renderWithProviders(
      <CustomerHeader estimate={estimate({ customer_id: 'c-1', customer: CUSTOMER })} />,
    );

    expect(screen.getByText('900 Oak Ave')).toBeInTheDocument();
    expect(screen.getByText('Round Rock, TX 78664')).toBeInTheDocument();
  });

  it('renders address line 2 between the street and city lines, for billing AND service', () => {
    renderWithProviders(
      <CustomerHeader
        estimate={estimate({
          lead_id: 'l-1',
          lead: {
            id: 'l-1',
            customer: {
              ...CUSTOMER,
              billing_address_line2: 'Suite 210',
            },
            service_address_line1: '123 Main St',
            service_address_line2: 'Bldg C',
            service_city: 'Austin',
            service_state: 'TX',
            service_zip: '78701',
          },
        })}
      />,
    );

    expect(screen.getByText('Suite 210')).toBeInTheDocument();
    expect(screen.getByText('Bldg C')).toBeInTheDocument();
  });

  // #1997 — a requester whose Customer read scope excludes this row never receives email/phone/
  // billing_* keys at all (absent, not null). The header must degrade to name + service address
  // only: no crash, no "undefined", no empty mailto:/tel: link.
  it('renders name + service address only when the seven contact/billing keys are entirely absent (#1997)', () => {
    const redactedCustomer = { id: 'c-1', first_name: 'Dana', last_name: 'Whitfield', company_name: null };
    renderWithProviders(
      <CustomerHeader
        estimate={estimate({
          customer_id: 'c-1',
          customer: redactedCustomer,
          service_location: SERVICE_LOCATION,
        })}
      />,
    );

    expect(screen.getAllByText('Dana Whitfield').length).toBeGreaterThan(0);
    expect(screen.getByText('77 Industrial Pkwy')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^tel:/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^mailto:/ })).not.toBeInTheDocument();
    expect(screen.queryByText('undefined')).not.toBeInTheDocument();
    // No billing address line either — the seven keys are absent, not just email/phone.
    expect(screen.queryByText('900 Oak Ave')).not.toBeInTheDocument();
  });
});
