// Mobile slice 50: the contact action's pure decisions. Which Call a number gets, where Text
// goes, and which maps link an address opens. RED before the module exists; each case is a
// decision a wrong implementation would get wrong, not a restatement of the code.
import { describe, expect, it } from 'vitest';

import { callRoute, mapsHref, smsHref, telHref, textPath } from '../contactHrefs';

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
