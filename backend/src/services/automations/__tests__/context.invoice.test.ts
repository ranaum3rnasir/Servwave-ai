import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../../../lib/prisma';
import { loadExecutionBundle } from '../context';

const mockPrisma = prisma as any;

const ORG = '00000000-0000-0000-0000-000000000001';
const INVOICE_ID = 'f0000000-0000-0000-0000-000000000001';

const ORG_ROW = {
  name: 'Blue Ridge Plumbing',
  phone: '(555) 204-7788',
  timezone: 'America/New_York',
  currency: 'USD',
  logo_url: null,
  brand_color: '#0C2D3A',
};

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    invoice_number: 'I00042',
    status: 'SENT',
    total_amount: '450.00',
    due_date: new Date('2026-08-15T00:00:00.000Z'),
    public_token: null,
    customer: {
      id: 'c0000000-0000-0000-0000-000000000001',
      first_name: 'Sarah',
      last_name: 'Mitchell',
      email: 'sarah@example.com',
      phone: '+15551234567',
    },
    job: null,
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.organization.findUnique.mockResolvedValue(ORG_ROW);
  mockPrisma.invoice.findFirst.mockResolvedValue(invoiceRow());
});

describe('loadExecutionBundle — invoice people', () => {
  it('leaves dispatcher/salesperson/creator unset — invoices carry customer only', async () => {
    const result = await loadExecutionBundle({
      entityType: 'invoice',
      entityId: INVOICE_ID,
      organizationId: ORG,
      dedupeKey: 'k1',
    });

    expect(result!.bundle.customer).toEqual(
      expect.objectContaining({ id: 'c0000000-0000-0000-0000-000000000001' }),
    );
    expect(result!.bundle.dispatcher ?? null).toBeNull();
    expect(result!.bundle.salesperson ?? null).toBeNull();
    expect(result!.bundle.creator ?? null).toBeNull();
  });
});
