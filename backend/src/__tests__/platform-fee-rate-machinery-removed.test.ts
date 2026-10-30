import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

// Slice 40: the payments model has no platform fee, so the within-ceiling rate-change notice
// machinery (nothing calls it) is gone. This guards against it creeping back.
const SRC = path.resolve(__dirname, '..');
const text = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8');

describe('dead platform-fee rate-change machinery stays removed', () => {
  it('the notice helper file is gone', () => {
    expect(existsSync(path.join(SRC, 'lib/platform-fee-rate-notice.ts'))).toBe(false);
  });
  it('the ceiling constant is gone from legal.ts', () => {
    expect(text('lib/legal.ts')).not.toContain('PLATFORM_FEE_CEILING_BPS');
  });
  it('the email sender is gone', () => {
    expect(text('lib/email.ts')).not.toContain('sendPaymentsRateChangeNotice');
  });
  it('the notification verb has no template or recipient rule', () => {
    expect(text('services/notifications/templates.ts')).not.toContain('billing.platform_fee_rate_changed');
    expect(text('services/notifications/resolveRecipients.ts')).not.toContain('billing.platform_fee_rate_changed');
  });
});
