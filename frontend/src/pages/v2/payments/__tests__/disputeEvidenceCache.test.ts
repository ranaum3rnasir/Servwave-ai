import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

import { disputeEvidenceKeys, setDisputeEvidenceState } from '@/lib/api/paymentsPage';

import { DISPUTE_ID, makeEvidence } from './disputeFixtures';

describe('setDisputeEvidenceState', () => {
  it('keeps the customer block the read brought when a save or submit answers without one', () => {
    const client = new QueryClient();
    const read = makeEvidence();
    client.setQueryData(disputeEvidenceKeys.one('org-1', DISPUTE_ID), read);
    const { customer_block: _omitted, ...answer } = makeEvidence({ dispute: { status: 'UNDER_REVIEW' } });
    setDisputeEvidenceState(client, 'org-1', DISPUTE_ID, answer);
    const after = client.getQueryData<ReturnType<typeof makeEvidence>>(disputeEvidenceKeys.one('org-1', DISPUTE_ID))!;
    expect(after.dispute.status).toBe('UNDER_REVIEW');
    expect(after.customer_block).toEqual(read.customer_block);
  });

  it('takes the answer\'s own block when it carries one', () => {
    const client = new QueryClient();
    client.setQueryData(disputeEvidenceKeys.one('org-1', DISPUTE_ID), makeEvidence());
    setDisputeEvidenceState(client, 'org-1', DISPUTE_ID, makeEvidence({ customer_block: { restricted: true, customer: null } }));
    expect(client.getQueryData<ReturnType<typeof makeEvidence>>(disputeEvidenceKeys.one('org-1', DISPUTE_ID))!.customer_block).toEqual({ restricted: true, customer: null });
  });
});
