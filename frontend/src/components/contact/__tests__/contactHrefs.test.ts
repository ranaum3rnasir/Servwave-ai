// Mobile slice 50: the contact action's pure decisions. Which Call a number gets, where Text
// goes, and which maps link an address opens. RED before the module exists; each case is a
// decision a wrong implementation would get wrong, not a restatement of the code.
import { describe, expect, it } from 'vitest';

import { callRoute, composePath, mapsHref, smsHref, telHref, textPath } from '../contactHrefs';

describe('callRoute: which Call a number gets', () => {
  it('an org without the phone service, or a user who may not place calls, gets the device call', () => {
    expect(callRoute(false)).toBe('device');
  });

  it('everyone else gets the ServWave dialer; the device (phone or computer) is chosen later, by the hand-off, never here', () => {
    expect(callRoute(true)).toBe('dialer');
  });
});

describe('telHref / smsHref', () => {
  it('keep the digits the record holds and trim stray whitespace', () => {
    expect(telHref(' 5551234567 ')).toBe('tel:5551234567');
    expect(smsHref('+15551234567')).toBe('sms:+15551234567');
  });
});

describe('textPath: Text opens the ServWave conversation', () => {
  it('goes by customer when the record is a customer', () => {
    expect(textPath('5551234567', { customerId: 'c-1' })).toBe('/communication/text?customerId=c-1');
  });

  it('goes by number when nobody on file owns it (a vendor, a team member)', () => {
    expect(textPath('+15551234567')).toBe('/communication/text?to=%2B15551234567');
    expect(textPath('5551234567', { jobId: 'j-1' })).toBe('/communication/text?to=5551234567');
  });
});

describe('textPath for a customer phone: it depends on whether the person may view customers', () => {
  const CONTEXT = { customerId: 'c-1', customerName: 'Dana Reyes', jobId: 'j-1', leadId: 'l-1' };

  it('goes by customer for a person who may view customers, as it always did', () => {
    expect(textPath('5551234567', CONTEXT, { viewCustomers: true })).toBe('/communication/text?customerId=c-1');
  });

  // SPEC-4 §6.8: only a Text started on the lead's OWN page carries the lead, so the first reply sent on that
  // customer's conversation is filed on the lead (and releases its Spider alert once it goes out). A record that
  // merely has a lead (an estimate, a payment's customer) does not.
  it('carries the lead only when tapped on the lead page itself', () => {
    const url = new URL(textPath('5551234567', { ...CONTEXT, textCarriesLead: true }, { viewCustomers: true }), 'https://app.test');
    expect(url.pathname).toBe('/communication/text');
    expect(Object.fromEntries(url.searchParams)).toEqual({ customerId: 'c-1', leadId: 'l-1' });
  });

  it('goes by the tapped number for a person who may not, carrying the name and the job it was tapped from', () => {
    const path = textPath('5551234567', CONTEXT, { viewCustomers: false });
    const url = new URL(path, 'https://app.test');
    expect(url.pathname).toBe('/communication/text');
    // The record merely has a lead (an estimate, a payment's customer): the lead stays off the Text (SPEC-4 §6.8).
    expect(Object.fromEntries(url.searchParams)).toEqual({
      to: '5551234567',
      owner: 'customer',
      name: 'Dana Reyes',
      jobId: 'j-1',
    });
    // The customer id is not what the composer finds the customer by.
    expect(path).not.toContain('customerId');
  });

  it('carries the lead for a person who may not view customers only when tapped on the lead page itself', () => {
    const url = new URL(textPath('5551234567', { ...CONTEXT, textCarriesLead: true }, { viewCustomers: false }), 'https://app.test');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      to: '5551234567',
      owner: 'customer',
      name: 'Dana Reyes',
      jobId: 'j-1',
      leadId: 'l-1',
    });
  });

  it('keeps the plus of an international number', () => {
    const url = new URL(textPath('+15551234567', null, { viewCustomers: false }), 'https://app.test');
    expect(url.searchParams.get('to')).toBe('+15551234567');
    expect(url.searchParams.get('owner')).toBe('customer');
  });

  it('goes by the number for a person who may view customers when the record names no customer', () => {
    const url = new URL(textPath('5551234567', { jobId: 'j-1' }, { viewCustomers: true }), 'https://app.test');
    expect(url.searchParams.get('to')).toBe('5551234567');
    expect(url.searchParams.get('jobId')).toBe('j-1');
  });
});

describe('mapsHref: an address opens the native maps app', () => {
  const ADDRESS = '12 Main St, Springfield, IL 62701';

  it('uses the Apple Maps link on iPhone and iPad, which opens the native app', () => {
    expect(mapsHref(ADDRESS, { ios: true })).toBe(
      'https://maps.apple.com/?q=12%20Main%20St%2C%20Springfield%2C%20IL%2062701',
    );
  });

  it('uses the universal search link elsewhere, which Android hands to its maps app', () => {
    expect(mapsHref(ADDRESS, { ios: false })).toBe(
      'https://www.google.com/maps/search/?api=1&query=12%20Main%20St%2C%20Springfield%2C%20IL%2062701',
    );
  });
});

describe('composePath: Email opens the compose window filled in', () => {
  it('encodes every value and leaves optional ones out', () => {
    expect(composePath({ to: 'a+b@example.com', subject: 'Invoice INV-1 & more', customerId: 'c 1' })).toBe(
      '/communication/inbox?compose=1&to=a%2Bb%40example.com&subject=Invoice+INV-1+%26+more&customerId=c+1',
    );
  });

  it('carries the body, job and invoice when given', () => {
    const url = new URL(composePath({ to: 'x@example.com', subject: 's', body: 'Pay: https://x.test/p?a=1&b=2\nThanks', customerId: 'c', jobId: 'j', invoiceId: 'i' }), 'http://h');
    expect(url.searchParams.get('body')).toBe('Pay: https://x.test/p?a=1&b=2\nThanks');
    expect(url.searchParams.get('jobId')).toBe('j');
    expect(url.searchParams.get('invoiceId')).toBe('i');
    expect(url.searchParams.get('compose')).toBe('1');
  });
});
