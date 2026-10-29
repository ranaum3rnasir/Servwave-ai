// E2 — the dialer launcher store carries an optional entity context with the
// pending number so the placed call gets attributed (job_id/lead_id/customer_id
// ride POST /api/communication/calls). clearPending clears BOTH.
import { beforeEach, describe, expect, it } from 'vitest';
import { useDialerStore } from '../dialer.store';

describe('dialer.store (launcher + entity context)', () => {
  beforeEach(() => {
    useDialerStore.setState({ pendingNumber: null, pendingContext: null });
  });

  it('requestCall stores the number and its entity context', () => {
    useDialerStore.getState().requestCall('5551234567', {
      jobId: 'b0000000-0000-0000-0000-000000000001',
      jobLabel: 'J00042',
      customerId: 'c0000000-0000-0000-0000-000000000001',
      customerName: 'Daniel Cohen',
    });

    const s = useDialerStore.getState();
    expect(s.pendingNumber).toBe('5551234567');
    expect(s.pendingContext).toEqual({
      jobId: 'b0000000-0000-0000-0000-000000000001',
      jobLabel: 'J00042',
      customerId: 'c0000000-0000-0000-0000-000000000001',
      customerName: 'Daniel Cohen',
    });
  });

  it('requestCall without a context resets any stale context to null', () => {
    useDialerStore.getState().requestCall('5551234567', { customerId: 'c-1' });
    useDialerStore.getState().requestCall('5559998888');

    const s = useDialerStore.getState();
    expect(s.pendingNumber).toBe('5559998888');
    expect(s.pendingContext).toBeNull();
  });

  it('clearPending clears both the number and the context', () => {
    useDialerStore.getState().requestCall('5551234567', { leadId: 'l-1', leadLabel: 'L00001' });
    useDialerStore.getState().clearPending();

    const s = useDialerStore.getState();
    expect(s.pendingNumber).toBeNull();
    expect(s.pendingContext).toBeNull();
  });
});
