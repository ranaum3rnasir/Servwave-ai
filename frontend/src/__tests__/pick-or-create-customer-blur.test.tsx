import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import {
  PickOrCreateCustomer,
  type CustomerContactFields,
  type PickCustomer,
} from '@/components/crm/PickOrCreateCustomer';

const EMPTY_FIELDS: CustomerContactFields = {
  first_name: '',
  last_name: '',
  company_name: '',
  phone: '',
  email: '',
};

const PICKED_CUSTOMER: PickCustomer = {
  id: 'c1',
  first_name: 'John Veise Alvarez',
  last_name: '',
  phone: '5551234567',
};

function renderPicker(
  fields: Partial<CustomerContactFields>,
  selectedCustomer: PickCustomer | null,
) {
  const onFieldChange = vi.fn();
  const utils = renderWithProviders(
    <PickOrCreateCustomer
      fields={{ ...EMPTY_FIELDS, ...fields }}
      onFieldChange={onFieldChange}
      selectedCustomer={selectedCustomer}
      onSelectCustomer={vi.fn()}
    />,
  );
  // Field order: first_name, last_name, phone, email, company_name.
  const firstNameInput = utils.getAllByPlaceholderText('Search...')[0];
  return { onFieldChange, firstNameInput, ...utils };
}

describe('PickOrCreateCustomer first-name blur split (#435)', () => {
  it('Case A: does NOT split or clear when an existing customer is selected', () => {
    const { onFieldChange, firstNameInput } = renderPicker(
      { first_name: 'John Veise Alvarez', last_name: '' },
      PICKED_CUSTOMER,
    );
    fireEvent.blur(firstNameInput);
    expect(onFieldChange).not.toHaveBeenCalled();
  });

  it('Case B: splits a multi-word first name on blur in new-customer mode', () => {
    const { onFieldChange, firstNameInput } = renderPicker(
      { first_name: 'John Veise Alvarez', last_name: '' },
      null,
    );
    fireEvent.blur(firstNameInput);
    expect(onFieldChange).toHaveBeenCalledTimes(2);
    expect(onFieldChange).toHaveBeenNthCalledWith(1, 'first_name', 'John Veise');
    expect(onFieldChange).toHaveBeenNthCalledWith(2, 'last_name', 'Alvarez');
  });

  it('Case C: does NOT overwrite a populated last name', () => {
    const { onFieldChange, firstNameInput } = renderPicker(
      { first_name: 'John Alvarez', last_name: 'Smith' },
      null,
    );
    fireEvent.blur(firstNameInput);
    expect(onFieldChange).not.toHaveBeenCalled();
  });

  it('Case D: does not split on change (mid-type)', () => {
    const { onFieldChange, firstNameInput } = renderPicker(
      { first_name: '', last_name: '' },
      null,
    );
    fireEvent.change(firstNameInput, { target: { value: 'John Veise Alvarez' } });
    // handleChange emits only the first_name edit, never a last_name split.
    expect(onFieldChange).toHaveBeenCalledTimes(1);
    expect(onFieldChange).toHaveBeenCalledWith('first_name', 'John Veise Alvarez');
    const touchedLast = onFieldChange.mock.calls.some(([field]) => field === 'last_name');
    expect(touchedLast).toBe(false);
  });
});
