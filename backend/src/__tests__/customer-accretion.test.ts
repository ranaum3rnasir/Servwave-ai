import { describe, it, expect, vi } from 'vitest';
import { accreteContactMethods } from '../lib/customer-accretion';

function makeTx(existing: { phone: string | null; email: string | null; phones: { phone: string }[]; extra_emails: { email: string }[] } | null) {
  const customerPhoneCreate = vi.fn();
  const customerEmailCreate = vi.fn();
  const tx = {
    customer: { findUnique: vi.fn().mockResolvedValue(existing) },
    customerPhone: { create: customerPhoneCreate },
    customerEmail: { create: customerEmailCreate },
  };
  return { tx: tx as never, customerPhoneCreate, customerEmailCreate, findUnique: tx.customer.findUnique };
}

describe('accreteContactMethods (unified-client-creation §3/§5.3)', () => {
  it('creates a new secondary phone when the typed phone is not already on the customer', async () => {
    const { tx, customerPhoneCreate } = makeTx({ phone: '5551112222', email: null, phones: [], extra_emails: [] });
    await accreteContactMethods(tx, 'cust-1', { phone: '(555) 999-8888' });
    expect(customerPhoneCreate).toHaveBeenCalledWith({
      data: { customer_id: 'cust-1', phone: '5559998888', is_primary: false },
    });
  });

  it('does NOT create a duplicate phone when it matches the primary scalar phone (normalized)', async () => {
    const { tx, customerPhoneCreate } = makeTx({ phone: '5551112222', email: null, phones: [], extra_emails: [] });
    await accreteContactMethods(tx, 'cust-1', { phone: '555-111-2222' });
    expect(customerPhoneCreate).not.toHaveBeenCalled();
  });

  it('does NOT create a duplicate phone when it matches an existing secondary phone', async () => {
    const { tx, customerPhoneCreate } = makeTx({ phone: null, email: null, phones: [{ phone: '5553334444' }], extra_emails: [] });
    await accreteContactMethods(tx, 'cust-1', { phone: '(555) 333-4444' });
    expect(customerPhoneCreate).not.toHaveBeenCalled();
  });

  it('creates a new secondary email when the typed email is not already on the customer', async () => {
    const { tx, customerEmailCreate } = makeTx({ phone: null, email: 'primary@example.com', phones: [], extra_emails: [] });
    await accreteContactMethods(tx, 'cust-1', { email: 'New@Example.com' });
    expect(customerEmailCreate).toHaveBeenCalledWith({
      data: { customer_id: 'cust-1', email: 'New@Example.com' },
    });
  });

  it('does NOT create a duplicate email when it matches (case-insensitive) an existing extra email', async () => {
    const { tx, customerEmailCreate } = makeTx({ phone: null, email: null, phones: [], extra_emails: [{ email: 'ops@acme.com' }] });
    await accreteContactMethods(tx, 'cust-1', { email: 'OPS@acme.com' });
    expect(customerEmailCreate).not.toHaveBeenCalled();
  });

  it('is a no-op (does not even query the customer) when neither phone nor email is supplied', async () => {
    const { tx, findUnique, customerPhoneCreate, customerEmailCreate } = makeTx({ phone: null, email: null, phones: [], extra_emails: [] });
    await accreteContactMethods(tx, 'cust-1', {});
    expect(findUnique).not.toHaveBeenCalled();
    expect(customerPhoneCreate).not.toHaveBeenCalled();
    expect(customerEmailCreate).not.toHaveBeenCalled();
  });
});
