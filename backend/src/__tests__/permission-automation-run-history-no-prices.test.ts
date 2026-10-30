/* =============================================================================
   Pre-PR review CR-20 (ticket 35's rule): the automation run history (the Activity tab, read by anyone who opens Automations)
   shows an email step's subject. A merge field that renders a price, or the customer's private link, is a field (Ran,
   2026-10-28), so the history line is rendered without those fields, for everyone; the customer's own email keeps them.

   The email executor is called directly; the mail provider is the suite-wide mock (lib/email), nothing is sent.
   ========================================================================== */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { executeAction, type ExecutionBundle } from '../services/automations/executors';
import { sendAutomationEmail } from '../lib/email';

vi.mock('../services/notifications/notificationService', () => ({ emit: vi.fn().mockResolvedValue(undefined) }));

const mockSendEmail = sendAutomationEmail as ReturnType<typeof vi.fn>;
const ORG = '00000000-0000-0000-0000-000000000001';

const PRICE_CONTEXT = {
  'customer.first_name': 'Sarah',
  'org.name': 'Blue Ridge Plumbing',
  'estimate.total': '$1,234.00',
  'estimate.link': 'https://app.example.test/e/secret-token',
  'invoice.total': '$987.65',
  'invoice.link': 'https://app.example.test/i/other-token',
};

function bundle(): ExecutionBundle {
  return {
    entityRef: { type: 'job', id: 'b0000000-0000-0000-0000-000000000001', label: 'J00042' },
    organizationId: ORG,
    org: { name: 'Blue Ridge Plumbing', timezone: 'America/New_York' },
    customer: { id: 'c0000000-0000-0000-0000-000000000001', first_name: 'Sarah', last_name: 'Mitchell', email: 'sarah@example.com', phone: '+15551234567' },
    assignees: [],
    watchers: [],
    mergeCtx: PRICE_CONTEXT,
    jobRef: { id: 'b0000000-0000-0000-0000-000000000001', label: 'J00042' },
    dedupeKey: 'JOB_COMPLETED:b0000000-0000-0000-0000-000000000001',
  };
}

const rule = (action_config: Record<string, unknown>) =>
  ({ id: 'a0000000-0000-0000-0000-0000000000aa', name: 'Quote follow-up', action_type: 'SEND_EMAIL', action_config, organization_id: ORG }) as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('automation run history: no price merge field in an email step\'s line', () => {
  it('leaves the price and private-link fields out of the subject it records; the customer still gets them', async () => {
    const res = await executeAction(
      rule({
        recipient: 'customer',
        subject: 'Hi {{customer.first_name}}: {{estimate.total}} {{estimate.link}} {{invoice.total}} {{invoice.link}}',
        body: 'From {{org.name}}',
      }),
      bundle(),
    );

    expect(res.status).toBe('SENT');
    expect(res.detail).toContain('Hi Sarah');
    for (const leaked of ['1,234', '987.65', 'secret-token', 'other-token']) expect(res.detail).not.toContain(leaked);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0]![0].subject).toContain('$1,234.00');
    expect(mockSendEmail.mock.calls[0]![0].subject).toContain('secret-token');
  });

  it('a subject with no price field is recorded as it was sent', async () => {
    const res = await executeAction(rule({ recipient: 'customer', subject: 'Hi {{customer.first_name}}', body: 'b' }), bundle());
    expect(res.detail).toBe('Hi Sarah');
  });
});
