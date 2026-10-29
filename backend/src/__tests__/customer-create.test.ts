import { describe, it, expect, beforeEach, vi } from 'vitest';
import { withRequiredCustomerFields } from '../lib/customer-create';
import { allocateNumber } from '../lib/numbering';

// withRequiredCustomerFields is the single source of truth for the Customer
// columns that are NOT-NULL with no DB default — customer_number (app-allocated),
// kind, segment. Both POST /api/customers and the inline new_customer path in
// lead creation route through it so the two can never drift apart again.
describe('withRequiredCustomerFields', () => {
  beforeEach(() => {
    vi.mocked(allocateNumber).mockReset();
  });

  it('allocates a customer_number and defaults kind/segment, carrying org + passthrough fields', async () => {
    vi.mocked(allocateNumber).mockResolvedValue('C00007' as never);
    const tx = {} as never;

    const out = await withRequiredCustomerFields(tx, 'org-1', {
      first_name: 'New',
      last_name: 'Client',
      email: 'new.client@example.com',
      phone: '5551112222',
    });

    expect(allocateNumber).toHaveBeenCalledWith(tx, 'customer', 'org-1');
    expect(out).toMatchObject({
      organization_id: 'org-1',
      customer_number: 'C00007',
      kind: 'PERSON',
      segment: 'RESIDENTIAL',
      first_name: 'New',
      last_name: 'Client',
      email: 'new.client@example.com',
      phone: '5551112222',
    });
  });

  it('derives kind from company_name (ignoring any client-supplied kind) and respects an explicit segment', async () => {
    vi.mocked(allocateNumber).mockResolvedValue('C00008' as never);

    const out = await withRequiredCustomerFields({} as never, 'org-1', {
      company_name: 'Acme LLC',
      email: 'ops@acme.example',
      phone: '5559998888',
      kind: 'BUSINESS', // ignored — kind is always server-derived (unified-client-creation §5.1)
      segment: 'COMMERCIAL',
    });

    expect(out.kind).toBe('COMPANY');
    expect(out.segment).toBe('COMMERCIAL');
    expect(out.customer_number).toBe('C00008');
  });

  it('derives PERSON when there is no company_name', async () => {
    vi.mocked(allocateNumber).mockResolvedValue('C00009' as never);

    const out = await withRequiredCustomerFields({} as never, 'org-1', {
      first_name: 'Jane',
      phone: '5551234567',
    });

    expect(out.kind).toBe('PERSON');
  });
});
