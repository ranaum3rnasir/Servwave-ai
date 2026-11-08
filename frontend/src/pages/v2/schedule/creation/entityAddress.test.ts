import { describe, it, expect } from 'vitest';

import { jobAddress, walkthroughAddress, customerDisplayName } from './entityAddress';

/**
 * The whole point of this module is the ABSENCE of a customer fallback, so the tests that
 * matter most are the ones that hand it a customer address and assert it is ignored.
 */
describe('creation picker addresses never fall back to the customer', () => {
  const customerWithAddress = {
    company_name: 'Acme HVAC',
    address_line1: '999 CUSTOMER HQ',
    city: 'Wrongtown',
    state: 'XX',
    service_address_line1: '888 ALSO WRONG',
  };

  it('reads a job address from its own service_location', () => {
    expect(jobAddress({
      service_location: { address_line1: '12 Elm St', city: 'Richmond', state: 'VA' },
      customer: customerWithAddress,
    })).toBe('12 Elm St, Richmond, VA');
  });

  it('returns blank for a job with no service_location, even when the customer has one', () => {
    expect(jobAddress({ customer: customerWithAddress })).toBe('');
    expect(jobAddress({ service_location: null, customer: customerWithAddress })).toBe('');
  });

  it('never emits any customer field for a job', () => {
    const out = jobAddress({ service_location: { address_line1: '12 Elm St' }, customer: customerWithAddress });
    expect(out).not.toContain('CUSTOMER HQ');
    expect(out).not.toContain('Wrongtown');
    expect(out).toBe('12 Elm St');
  });

  it('reads a walkthrough address from the lead itself', () => {
    expect(walkthroughAddress({
      service_address_line1: '4 Oak Ave',
      service_city: 'Norfolk',
      service_state: 'VA',
      customer: customerWithAddress,
    })).toBe('4 Oak Ave, Norfolk, VA');
  });

  it('returns blank for a lead with no service address, even when the customer has one', () => {
    expect(walkthroughAddress({ customer: customerWithAddress })).toBe('');
  });

  it('skips missing parts rather than emitting empty separators', () => {
    expect(jobAddress({ service_location: { address_line1: '12 Elm St', city: null, state: 'VA' } }))
      .toBe('12 Elm St, VA');
    expect(walkthroughAddress({ service_address_line1: '  ', service_city: 'Norfolk' })).toBe('Norfolk');
  });

  it('still reads the customer for the NAME, which is what the customer record is for', () => {
    expect(customerDisplayName({ customer: customerWithAddress })).toBe('Acme HVAC');
    expect(customerDisplayName({ customer: { first_name: 'Dana', last_name: 'Reed' } })).toBe('Dana Reed');
    expect(customerDisplayName({})).toBe('');
  });
});
