import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../../../lib/prisma';
import { loadExecutionBundle } from '../context';

const mockPrisma = prisma as any;

const ORG = '00000000-0000-0000-0000-000000000001';
const ESTIMATE_ID = 'e0000000-0000-0000-0000-000000000001';

const ORG_ROW = {
  name: 'Blue Ridge Plumbing',
  phone: '(555) 204-7788',
  timezone: 'America/New_York',
  currency: 'USD',
  logo_url: null,
  brand_color: '#0C2D3A',
};

function estimateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ESTIMATE_ID,
    estimate_number: 'E00042',
    status: 'SENT',
    total_amount: '1200.00',
    public_token: null,
    creator: {
      id: 'u0000000-0000-0000-0000-000000000001',
      email: 'cara@example.com',
      first_name: 'Cara',
      last_name: 'Reed',
    },
    lead: {
      customer: {
        id: 'c0000000-0000-0000-0000-000000000001',
        first_name: 'Sarah',
        last_name: 'Mitchell',
        email: 'sarah@example.com',
        phone: '+15551234567',
      },
      commission_owner: null,
    },
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.organization.findUnique.mockResolvedValue(ORG_ROW);
  mockPrisma.estimate.findFirst.mockResolvedValue(estimateRow());
});

describe('loadExecutionBundle — estimate people', () => {
  it('sets creator from created_by and salesperson from the lead owner', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValueOnce(
      estimateRow({
        lead: {
          customer: {
            id: 'c0000000-0000-0000-0000-000000000001',
            first_name: 'Sarah',
            last_name: 'Mitchell',
            email: 'sarah@example.com',
            phone: '+15551234567',
          },
          commission_owner: {
            id: 'o0000000-0000-0000-0000-000000000001',
            email: 'owen@example.com',
            first_name: 'Owen',
            last_name: 'Ortiz',
          },
        },
      }),
    );

    const result = await loadExecutionBundle({
      entityType: 'estimate',
      entityId: ESTIMATE_ID,
      organizationId: ORG,
      dedupeKey: 'k1',
    });

    expect(result!.bundle.creator).toEqual({
      id: 'u0000000-0000-0000-0000-000000000001',
      email: 'cara@example.com',
      first_name: 'Cara',
      last_name: 'Reed',
    });
    expect(result!.bundle.salesperson).toEqual({
      id: 'o0000000-0000-0000-0000-000000000001',
      email: 'owen@example.com',
      first_name: 'Owen',
      last_name: 'Ortiz',
    });
  });

  it('salesperson is null when the lead has no commission owner', async () => {
    const result = await loadExecutionBundle({
      entityType: 'estimate',
      entityId: ESTIMATE_ID,
      organizationId: ORG,
      dedupeKey: 'k2',
    });

    expect(result!.bundle.salesperson).toBeNull();
  });
});

// SRVW-303 - the lead owner, reachable from an estimate template as well: "your estimate is
// ready" is the second most natural email to sign with the seller.
describe('loadExecutionBundle - estimate owner merge fields', () => {
  it('renders the lead owner as owner_name and a trimmed owner_first_name', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValueOnce(
      estimateRow({
        lead: {
          customer: null,
          commission_owner: {
            id: 'o0000000-0000-0000-0000-000000000001',
            email: 'dana@example.com',
            first_name: ' Dana ',
            last_name: 'Whitfield',
          },
        },
      }),
    );
    const result = await loadExecutionBundle({
      entityType: 'estimate',
      entityId: ESTIMATE_ID,
      organizationId: ORG,
      dedupeKey: 'k-owner',
    });
    expect(result!.bundle.mergeCtx['estimate.owner_name']).toBe('Dana Whitfield');
    expect(result!.bundle.mergeCtx['estimate.owner_first_name']).toBe('Dana');
  });

  it('resolves exactly empty strings when the lead has no owner, and for a lead-less estimate', async () => {
    const unowned = await loadExecutionBundle({
      entityType: 'estimate',
      entityId: ESTIMATE_ID,
      organizationId: ORG,
      dedupeKey: 'k-owner-none',
    });
    expect(unowned!.bundle.mergeCtx['estimate.owner_name']).toBe('');
    expect(unowned!.bundle.mergeCtx['estimate.owner_first_name']).toBe('');

    mockPrisma.estimate.findFirst.mockResolvedValueOnce(estimateRow({ lead: null, customer: null }));
    const leadless = await loadExecutionBundle({
      entityType: 'estimate',
      entityId: ESTIMATE_ID,
      organizationId: ORG,
      dedupeKey: 'k-owner-leadless',
    });
    expect(leadless!.bundle.mergeCtx['estimate.owner_name']).toBe('');
    expect(leadless!.bundle.mergeCtx['estimate.owner_first_name']).toBe('');
  });
});
