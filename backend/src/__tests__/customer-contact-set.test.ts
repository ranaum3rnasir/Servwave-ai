import { describe, it, expect } from 'vitest';
import { customerContactSet } from '../lib/customer-contact-set';

describe('customerContactSet', () => {
  it('lists the primary, then the secondary, then the phone list, each number once', () => {
    const set = customerContactSet({
      phone: '(617) 555-0101', phone_ext: '7', secondary_phone: '617-555-0102',
      phones: [
        { phone: '+16175550101', label: 'Mobile', extension: '7', is_primary: true },
        { phone: '6175550103', label: 'Office', extension: null, is_primary: false },
      ],
    });
    expect(set.phones).toEqual([
      { phone: '(617) 555-0101', label: 'Mobile', extension: '7', is_primary: true },
      { phone: '617-555-0102', label: null, extension: null, is_primary: false },
      { phone: '6175550103', label: 'Office', extension: null, is_primary: false },
    ]);
  });

  it('makes the list-flagged phone the primary when the customer columns hold none', () => {
    const set = customerContactSet({
      phones: [
        { phone: '6175550104', label: null, extension: null, is_primary: false },
        { phone: '6175550105', label: 'Cell', extension: null, is_primary: true },
      ],
    });
    expect(set.phones.map((p) => [p.phone, p.is_primary])).toEqual([['6175550104', false], ['6175550105', true]]);
  });

  it('lists the primary email, then the extra emails, each address once regardless of case', () => {
    const set = customerContactSet({
      email: 'Pat@Example.test',
      extra_emails: [{ email: 'pat@example.test', label: null }, { email: 'billing@example.test', label: 'Billing' }],
    });
    expect(set.emails).toEqual([
      { email: 'Pat@Example.test', label: null, is_primary: true },
      { email: 'billing@example.test', label: 'Billing', is_primary: false },
    ]);
  });

  it('answers empty lists for a customer with no contact details', () => {
    expect(customerContactSet({ phone: null, email: '', phones: [], extra_emails: [] })).toEqual({ phones: [], emails: [] });
  });
});
