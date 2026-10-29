/**
 * Mobile slice 24 (rubric KB-10, user story 28): the lead, job and invoice
 * customer block names its fields for what they hold.
 *
 * Every box in the block (first name, last name, phone, email, company) showed
 * the same placeholder, "Search...", so on a phone - where the label sits above
 * a box the keyboard may have scrolled away - a rep saw five identical
 * "Search..." boxes and a screen reader read "Search..." as each field's hint.
 * Each box now carries its own name, and the fact that typing finds an
 * existing customer is said once, as the fields' description.
 *
 * The lead and invoice forms render `PickCustomerFields` (pages/v2/_shared);
 * the job form renders `PickOrCreateCustomer` (components/crm). Both are
 * checked.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import { PickOrCreateCustomer, type CustomerContactFields } from '@/components/crm/PickOrCreateCustomer';
import { PickCustomerFields } from '@/pages/v2/_shared/pickCustomer';

const EMPTY: CustomerContactFields = { first_name: '', last_name: '', company_name: '', phone: '', email: '' };

const BLOCKS: Array<[string, () => JSX.Element]> = [
  [
    'lead and invoice forms (PickCustomerFields)',
    () => (
      <PickCustomerFields
        fields={EMPTY}
        onFieldChange={vi.fn()}
        selectedCustomer={null}
        onSelectCustomer={vi.fn()}
        required
      />
    ),
  ],
  [
    'job form (PickOrCreateCustomer)',
    () => (
      <PickOrCreateCustomer fields={EMPTY} onFieldChange={vi.fn()} selectedCustomer={null} onSelectCustomer={vi.fn()} required />
    ),
  ],
];

const FIELDS: Array<[RegExp, string]> = [
  [/^first name/i, 'First name'],
  [/^last name/i, 'Last name'],
  [/^phone$/i, 'Phone number'],
  [/^email$/i, 'Email address'],
  [/^company name$/i, 'Company name'],
];

describe.each(BLOCKS)('customer block on the %s', (_name, Block) => {
  it('shows no "Search..." placeholder anywhere', () => {
    renderWithProviders(<Block />);
    expect(screen.queryAllByPlaceholderText('Search...')).toEqual([]);
  });

  it.each(FIELDS)('the %s box is announced by its own name, with its own placeholder', (name, placeholder) => {
    renderWithProviders(<Block />);
    const box = screen.getByRole('textbox', { name });
    expect(box).toHaveAttribute('placeholder', placeholder);
    // That typing here finds an existing customer is a description, not the field's name.
    expect(box).toHaveAccessibleDescription(/existing customer/i);
  });
});
