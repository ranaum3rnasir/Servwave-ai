/**
 * Roles & Permissions alignment, AL-04 (A7): a new customer inside a lead, job or invoice form is a Create customers action.
 * The two customer controls those forms use offer a new customer only to a person who can create customers; anyone else is
 * told to choose an existing one.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { PickCustomerFields } from '@/pages/v2/_shared/pickCustomer';
import { PickOrCreateCustomer, type CustomerContactFields } from '@/components/crm/PickOrCreateCustomer';

vi.mock('@/lib/axios', () => ({
  default: { get: vi.fn().mockResolvedValue({ data: { customers: [] } }) },
}));

const FIELDS: CustomerContactFields = { first_name: '', last_name: '', company_name: '', phone: '', email: '' };
const HINT = 'Choose an existing customer. Adding a new one needs permission to create customers.';
const noop = () => {};
const props = { fields: FIELDS, onFieldChange: noop, selectedCustomer: null, onSelectCustomer: noop };

// Create customers needs View customers and Edit customers; Create leads needs View leads and Edit leads.
const CAN_CREATE = buildAbility([
  { action: 'read', subject: 'Customer' },
  { action: 'update', subject: 'Customer' },
  { action: 'create', subject: 'Customer' },
]);
const CANNOT_CREATE = buildAbility([
  { action: 'read', subject: 'Lead' },
  { action: 'update', subject: 'Lead' },
  { action: 'create', subject: 'Lead' },
]);

describe.each([
  ['the lead and invoice customer fields', (extra: object) => <PickCustomerFields {...props} {...extra} />],
  ['the job customer fields', (extra: object) => <PickOrCreateCustomer {...props} {...extra} />],
])('%s', (_name, draw) => {
  it('tell a person without Create customers to choose an existing customer', () => {
    renderWithProviders(draw({}), { ability: CANNOT_CREATE });
    expect(screen.getByText(HINT)).toBeInTheDocument();
  });

  it('say nothing to a person with Create customers', () => {
    renderWithProviders(draw({}), { ability: CAN_CREATE });
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it('say nothing once an existing customer is chosen', () => {
    const chosen = { id: 'c1', first_name: 'Pat', last_name: 'Payer', company_name: '', phone: '', email: '' };
    renderWithProviders(draw({ selectedCustomer: chosen }), { ability: CANNOT_CREATE });
    expect(screen.queryByText(HINT)).toBeNull();
  });
});
