import { describe, expect, it } from 'vitest';

import { STATUS_REGISTRY } from '@/design-system/status-registry';

describe('the dispute status chip', () => {
  it('is red for Needs response, amber for Under review, green for Won, and neutral for Lost and Closed', () => {
    const tones = Object.fromEntries(
      Object.entries(STATUS_REGISTRY.dispute).map(([status, entry]) => [status, (entry as { intent: string }).intent]),
    );
    expect(tones).toEqual({
      NEEDS_RESPONSE: 'danger', UNDER_REVIEW: 'warning', WON: 'success', LOST: 'neutral', CLOSED: 'neutral',
    });
  });
});
