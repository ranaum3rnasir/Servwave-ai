/**
 * #2030 slices 1 and 2 — minting a version.
 *
 * A version records what a CUSTOMER RECEIVED, so every event where a customer receives something
 * mints one: sending, marking as sent manually (an estimate delivered outside the system), and
 * copying the estimate to an invoice (which is what makes a payment reconcilable against what was
 * quoted). Only the first did.
 *
 * An ordinary edit mints nothing. Editing is not a delivery.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../prisma';
import { supabaseAdmin } from '../supabase';
import { mintEstimateVersion, VERSION_TRIGGERS } from '../mint-estimate-version';

const mockPrisma = prisma as unknown as {
  estimate: { findUnique: ReturnType<typeof vi.fn> };
  organization: { findUnique: ReturnType<typeof vi.fn> };
  estimateVersionSnapshot: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

/**
 * A tiny stateful stand-in for the snapshot table, handed to the transaction callback.
 *
 * Stateful on purpose: the defect this file now guards against is two deliveries agreeing on a
 * version number, and the only way to catch that is for the SECOND mint to see what the first one
 * wrote. A `findFirst` that always answers null would pass on the broken code and on the fixed
 * code alike.
 */
let rows: Array<Record<string, any>>;
let tx: {
  estimateVersionSnapshot: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
};

function txDouble() {
  return {
    estimateVersionSnapshot: {
      findFirst: vi.fn(async (args: any) => {
        const orgOk = (r: Record<string, any>) =>
          !args?.where?.estimate?.organization_id || r.organization_id === args.where.estimate.organization_id;
        return (
          rows
            .filter((r) => r.estimate_id === args?.where?.estimate_id && orgOk(r))
            .sort((a, b) => b.version - a.version)[0] ?? null
        );
      }),
      create: vi.fn(async (args: any) => {
        rows.push({ organization_id: ORG_ID, ...args.data });
        return { id: `snap-${rows.length}` };
      }),
    },
  };
}

const storage = supabaseAdmin.storage.from('attachments') as unknown as {
  copy: ReturnType<typeof vi.fn>;
};

const ESTIMATE_ID = 'est-1';
const ORG_ID = 'org-1';

const ESTIMATE = {
  id: ESTIMATE_ID,
  estimate_number: 'E00042',
  version: 3,
  status: 'SENT',
  created_at: new Date('2026-09-01T00:00:00Z'),
  organization_id: ORG_ID,
  subtotal: 2200, discount_amount: 0, discount_name: null,
  tax_rate: 0, tax_amount: 0, total_amount: 2200,
  signature_data: null, signature_at: null,
  snapshot_terms: 'Terms as sent.', snapshot_notes: '', snapshot_payment_terms: '',
  scope_notes: null,
  scopes: [{ id: 'scope-1', title: 'Doors', body: '', flat_price: 2000, is_taxable: true }],
  scope_photos: [
    { id: 'sp-1', scope_id: 'scope-1', storage_path: `${ORG_ID}/estimate_scope/${ESTIMATE_ID}/scope-1/1-a.jpg`, caption: null },
  ],
  customer: { first_name: 'Jane', last_name: 'Doe', company_name: null, email: null, phone: '5551234567' },
  service_location: null,
  lead: null,
  line_items: [
    { id: 'li-1', description: 'Keypad', item_type: 'MATERIAL', quantity: 1, unit_price: 200, line_total: 200, discount_amount: 0 },
  ],
};

const ORG = {
  id: ORG_ID, name: 'Northwind Services', address_line1: '1', address_line2: null,
  city: 'Hoboken', state: 'NJ', postal_code: '07030', email: 'a@b.c', phone: null,
  website: null, logo_url: null, brand_color: '#E11D2E',
  estimate_terms: 'Live terms.', estimate_notes: '', estimate_payment_terms: '',
  estimate_template: 'crm-default',
};

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
  tx = txDouble();
  mockPrisma.$transaction.mockImplementation((cb: any) => cb(tx));
  mockPrisma.estimate.findUnique.mockResolvedValue(ESTIMATE);
  mockPrisma.organization.findUnique.mockResolvedValue(ORG);
  storage.copy.mockResolvedValue({ data: { path: 'copied' }, error: null });
});

function created(index = 0) {
  const call = tx.estimateVersionSnapshot.create.mock.calls[index];
  if (!call) throw new Error(`no version was minted at index ${index}`);
  return call[0].data as Record<string, any>;
}

/**
 * The version number is the snapshot's OWN ordinal over deliveries, NOT a copy of
 * `estimates.version` — which counts material edits made after a send and does not move on a
 * plain re-send at all. Copying it meant two deliveries with no edit between them landed on the
 * same number: two "Version 1" cards in the history drawer, both linking to the same url, one of
 * which opened the other snapshot's document.
 */
describe('two deliveries with no edit between them', () => {
  it('gives each its own version number', async () => {
    // The rep sends the estimate...
    await mintEstimateVersion({ estimateId: ESTIMATE_ID, orgId: ORG_ID, trigger: 'SEND' });
    // ...the customer accepts, and the rep copies it to an invoice without touching the estimate.
    await mintEstimateVersion({ estimateId: ESTIMATE_ID, orgId: ORG_ID, trigger: 'COPY_TO_INVOICE' });

    expect(created(0).version).toBe(1);
    expect(created(1).version).toBe(2);
  });

  it('counts deliveries, not edits — the estimate’s own version column is not the source', async () => {
    // `estimates.version` sits at 3 in the fixture and never moves across these two mints.
    await mintEstimateVersion({ estimateId: ESTIMATE_ID, orgId: ORG_ID, trigger: 'SEND' });
    await mintEstimateVersion({ estimateId: ESTIMATE_ID, orgId: ORG_ID, trigger: 'SEND' });

    expect([created(0).version, created(1).version]).toEqual([1, 2]);
  });

  it('resolves the ordinal inside the transaction that writes it, never before it', async () => {
    await mintEstimateVersion({ estimateId: ESTIMATE_ID, orgId: ORG_ID, trigger: 'SEND' });

    // The callback form, never the array form: a batch fires its writes eagerly and 500s under
    // DB_TENANT_GUARD.
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(typeof mockPrisma.$transaction.mock.calls[0][0]).toBe('function');
    // Both statements go through the transaction client. A read taken on the global client before
    // the transaction opens is a snapshot, not a lock.
    expect(tx.estimateVersionSnapshot.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.estimateVersionSnapshot.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.estimateVersionSnapshot.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.estimateVersionSnapshot.create).not.toHaveBeenCalled();
  });

  it('scopes the high-water read to the organization, like every other query here', async () => {
    await mintEstimateVersion({ estimateId: ESTIMATE_ID, orgId: ORG_ID, trigger: 'SEND' });

    // Asserted on the ARGS: the mocked client answers whatever the double decides regardless of
    // the where clause, so a response-shape assertion could not fail here.
    expect(tx.estimateVersionSnapshot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { estimate_id: ESTIMATE_ID, estimate: { organization_id: ORG_ID } },
        orderBy: { version: 'desc' },
      }),
    );
  });
});

describe('minting a version', () => {
  it('writes the whole document, not just a summary', async () => {
    await mintEstimateVersion({ estimateId: ESTIMATE_ID, orgId: ORG_ID, trigger: 'SEND' });

    const data = created();
    expect(data.estimate_id).toBe(ESTIMATE_ID);
    expect(data.version).toBe(1);
    expect(data.document.view.rows).toHaveLength(2);
    expect(data.document.org.name).toBe('Northwind Services');
    expect(data.document.templateKey).toBe('crm-default');
  });

  it('records which customer-facing event minted it', async () => {
    for (const trigger of VERSION_TRIGGERS) {
      vi.clearAllMocks();
      rows = [];
      tx = txDouble();
      mockPrisma.$transaction.mockImplementation((cb: any) => cb(tx));
      mockPrisma.estimate.findUnique.mockResolvedValue(ESTIMATE);
      mockPrisma.organization.findUnique.mockResolvedValue(ORG);
      storage.copy.mockResolvedValue({ data: { path: 'copied' }, error: null });

      await mintEstimateVersion({ estimateId: ESTIMATE_ID, orgId: ORG_ID, trigger });

      expect(created().trigger).toBe(trigger);
    }
  });

  it('gives the version its OWN copy of each photo, so a later deletion cannot blank it', async () => {
    await mintEstimateVersion({ estimateId: ESTIMATE_ID, orgId: ORG_ID, trigger: 'SEND' });

    expect(storage.copy).toHaveBeenCalledTimes(1);
    const [from, to] = storage.copy.mock.calls[0];
    expect(from).toBe(ESTIMATE.scope_photos[0].storage_path);
    // Keyed by the mint rather than by the ordinal: the copies happen before the transaction
    // that assigns the ordinal opens.
    expect(to).toMatch(new RegExp(`^${ORG_ID}/estimate_version/${ESTIMATE_ID}/[0-9a-f-]{36}/`));
    // The stored document points at the version's own object, never the live one.
    expect(created().document.photoPaths).toEqual([to]);
  });

  it('still mints the version when a photo cannot be copied', async () => {
    storage.copy.mockResolvedValue({ data: null, error: { message: 'gone' } });

    await mintEstimateVersion({ estimateId: ESTIMATE_ID, orgId: ORG_ID, trigger: 'SEND' });

    expect(created().document.photoPaths).toEqual([]);
  });

  it('keeps the legacy summary columns, so nothing that reads them breaks', async () => {
    await mintEstimateVersion({ estimateId: ESTIMATE_ID, orgId: ORG_ID, trigger: 'SEND' });

    const data = created();
    expect(Number(data.total_amount)).toBe(2200);
    expect(data.line_items).toHaveLength(1);
    expect(data.scopes).toHaveLength(1);
    expect(data.sent_at).toBeInstanceOf(Date);
  });

  it('mints nothing for an estimate that has gone missing', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    await mintEstimateVersion({ estimateId: ESTIMATE_ID, orgId: ORG_ID, trigger: 'SEND' });

    expect(tx.estimateVersionSnapshot.create).not.toHaveBeenCalled();
  });

  it('never lets a snapshot failure escape into the send it followed', async () => {
    tx.estimateVersionSnapshot.create.mockRejectedValue(new Error('db down'));

    await expect(
      mintEstimateVersion({ estimateId: ESTIMATE_ID, orgId: ORG_ID, trigger: 'SEND' }),
    ).resolves.toBeUndefined();
  });
});
