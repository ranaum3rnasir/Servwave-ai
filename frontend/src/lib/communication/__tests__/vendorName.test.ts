// vendorName.ts decodes the vendor's name at runtime so the bundle never carries
// it. The console filter and the legacy storage key depend on the decoded words
// being exact, so pin them here (tests do not ship).
import { describe, expect, it } from 'vitest';

import { PHONE_VENDOR_LONG, PHONE_VENDOR_SHORT } from '@/lib/communication/vendorName';

describe('vendorName', () => {
  it('decodes the short name', () => {
    expect(PHONE_VENDOR_SHORT).toBe('ctm');
  });
  it('decodes the first word of the long name', () => {
    expect(PHONE_VENDOR_LONG).toBe('calltracking');
  });
});
