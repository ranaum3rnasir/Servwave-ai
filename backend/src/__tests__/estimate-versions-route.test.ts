/**
 * #2030 slice 3 — reading a past version.
 *
 * A salesperson opens a past version and reads the WHOLE document — totals, line items, scope of
 * work, photos — exactly as the customer received it. Read-only because the route only reads:
 * structural, rather than a mode flag on the workspace that can be got wrong.
 *
 * The single most valuable test in #2030 is here: send, then edit, then open the version and
 * confirm it still shows the pre-edit document.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, TEST_USERS, ESTIMATE_FIXTURE } from './helpers';
import { buildVersionSnapshotDocument } from '../lib/estimate-version-snapshot';

const mockPrisma = prisma as unknown as {
  estimate: { findUnique: ReturnType<typeof vi.fn> };
  estimateVersionSnapshot: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
};

const ESTIMATE_ID = ESTIMATE_FIXTURE.id;

const ORG = {
  name: 'Northwind Services', address_line1: '1', address_line2: null,
  city: 'Hoboken', state: 'NJ', postal_code: '07030', email: 'a@b.c', phone: null,
  website: null, logo_url: null, brand_color: '#E11D2E',
  estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
};

/** The estimate as it stood when version 1 was sent: two line items, $1,000. */
const AS_SENT = {
  estimate_number: 'E00042',
  created_at: new Date('2026-09-01T00:00:00Z'),
  status: 'SENT',
  subtotal: 1000, discount_amount: 0, discount_name: null,
  tax_rate: 0, tax_amount: 0, total_amount: 1000,
  signature_data: null, signature_at: null,
  snapshot_terms: 'Terms as sent.', snapshot_notes: null, snapshot_payment_terms: null,
  scope_notes: 'Business hours only.',
  scopes: [{ id: 'scope-1', title: 'Doors', body: 'Three of them.', flat_price: 800, is_taxable: true }],
  scope_photos: [{ id: 'sp-1', scope_id: 'scope-1', storage_path: 'org/estimate_version/est/1/a.jpg', caption: 'Frame' }],
  customer: { first_name: 'Jane', last_name: 'Doe', company_name: null, email: null, phone: '5551234567' },
  service_location: null,
  lead: null,
  line_items: [
    { id: 'li-1', description: 'Keypad', item_type: 'MATERIAL', quantity: 1, unit_price: 200, line_total: 200, discount_amount: 0 },
  ],
};

const SNAPSHOT = {
  id: 'snap-1',
  estimate_id: ESTIMATE_ID,
  version: 1,
  total_amount: 1000,
  trigger: 'SEND',
  sent_at: new Date('2026-09-02T00:00:00Z'),
  document: JSON.parse(JSON.stringify(
    buildVersionSnapshotDocument(AS_SENT as never, ORG as never, 'alpha-classic'),
  )),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthAs('admin');
  mockPrisma.estimate.findUnique.mockResolvedValue({
    id: ESTIMATE_ID,
    estimate_number: 'E00042',
    organization_id: TEST_USERS.admin.organization_id,
    created_by: TEST_USERS.admin.id,
    lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
  });
  mockPrisma.estimateVersionSnapshot.findMany.mockResolvedValue([SNAPSHOT]);
  mockPrisma.estimateVersionSnapshot.findFirst.mockResolvedValue(SNAPSHOT);
});

describe('GET /api/estimates/:id/versions', () => {
  it('lists the versions with what minted each one', async () => {
    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_ID}/versions`)
      .set(authHeader('admin'))
      .expect(200);

    expect(res.body.versions).toEqual([
      expect.objectContaining({ version: 1, trigger: 'SEND', total_amount: 1000 }),
    ]);
    // A list is a list — the whole frozen document does not belong in it. Asserted on the SELECT
    // the route asked for, because the mocked client hands back the whole row whatever the select
    // says, so a response-shape assertion here could not fail.
    const select = mockPrisma.estimateVersionSnapshot.findMany.mock.calls[0][0].select;
    expect(select).not.toHaveProperty('document');
    expect(select).toMatchObject({ version: true, trigger: true, total_amount: true });
  });

  it('makes the re-send count derivable', async () => {
    mockPrisma.estimateVersionSnapshot.findMany.mockResolvedValue([
      { ...SNAPSHOT, version: 1, trigger: 'SEND' },
      { ...SNAPSHOT, id: 'snap-2', version: 2, trigger: 'SEND' },
      { ...SNAPSHOT, id: 'snap-3', version: 3, trigger: 'COPY_TO_INVOICE' },
    ]);

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_ID}/versions`)
      .set(authHeader('admin'))
      .expect(200);

    const sends = res.body.versions.filter((v: { trigger: string }) => v.trigger === 'SEND');
    expect(sends).toHaveLength(2);
  });
});

describe('GET /api/estimates/:id/versions/:version', () => {
  it('renders the whole document as the customer received it', async () => {
    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_ID}/versions/1`)
      .set(authHeader('admin'))
      .expect(200);

    const doc = res.body.version.document;
    expect(doc.view.rows).toHaveLength(2);
    expect(doc.view.scopeNotes).toBe('Business hours only.');
    expect(doc.view.totals.find((t: { kind: string }) => t.kind === 'total').amount).toBe(1000);
    expect(doc.view.terms).toBe('Terms as sent.');
  });

  it('serves the photos as they were, freshly signed', async () => {
    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_ID}/versions/1`)
      .set(authHeader('admin'))
      .expect(200);

    const scope = res.body.version.document.view.rows.find((r: { kind: string }) => r.kind === 'scope');
    expect(scope.photos[0].url).toContain('/object/sign/');
  });

  // THE test: send, then edit, then open the version.
  it('does not change when the live estimate is edited afterwards', async () => {
    const before = await request(app)
      .get(`/api/estimates/${ESTIMATE_ID}/versions/1`)
      .set(authHeader('admin'))
      .expect(200);

    // The live estimate moves on: a scope repriced, a line item added, the terms rewritten.
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_ID,
      estimate_number: 'E00042',
      organization_id: TEST_USERS.admin.organization_id,
      created_by: TEST_USERS.admin.id,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
      total_amount: 9999,
      scopes: [],
      line_items: [],
    });

    const after = await request(app)
      .get(`/api/estimates/${ESTIMATE_ID}/versions/1`)
      .set(authHeader('admin'))
      .expect(200);

    expect(after.body.version.document.view).toEqual(before.body.version.document.view);
    expect(after.body.version.document.view.totals.find((t: { kind: string }) => t.kind === 'total').amount).toBe(1000);
  });

  it('says which version it is and which estimate it belongs to, so the way back is obvious', async () => {
    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_ID}/versions/1`)
      .set(authHeader('admin'))
      .expect(200);

    expect(res.body.version).toMatchObject({
      version: 1,
      estimate_id: ESTIMATE_ID,
      estimate_number: 'E00042',
      trigger: 'SEND',
    });
  });

  // Minting copied `estimates.version` before the #2030 fix, and that column only moves on a
  // material edit to an already-sent estimate — so two deliveries with no edit between them wrote
  // the SAME number. No unique constraint can be added retroactively (staging and prod may already
  // hold such rows, and an index that fails to build breaks the deploy), so the reader has to
  // resolve the collision itself rather than take whatever the planner happens to hand back.
  describe('two legacy snapshots that share a version number', () => {
    const OLDER = { ...SNAPSHOT, id: 'snap-old', trigger: 'SEND', total_amount: 1000, created_at: new Date('2026-09-02T00:00:00Z') };
    const NEWER = { ...SNAPSHOT, id: 'snap-new', trigger: 'COPY_TO_INVOICE', total_amount: 2000, created_at: new Date('2026-09-05T00:00:00Z') };

    beforeEach(() => {
      mockPrisma.estimateVersionSnapshot.findFirst.mockImplementation(async (args: any) => {
        const dir = args?.orderBy?.created_at;
        // No ordering asked for: the planner is free to return either row. Model that as the
        // first one written, which is exactly the wrong answer.
        if (!dir) return OLDER;
        return dir === 'desc' ? NEWER : OLDER;
      });
    });

    it('opens the newest of them — the document the customer most recently received', async () => {
      const res = await request(app)
        .get(`/api/estimates/${ESTIMATE_ID}/versions/1`)
        .set(authHeader('admin'))
        .expect(200);

      expect(res.body.version.trigger).toBe('COPY_TO_INVOICE');
      expect(Number(res.body.version.total_amount)).toBe(2000);
    });

    it('asks the database for that order rather than hoping for it', async () => {
      await request(app)
        .get(`/api/estimates/${ESTIMATE_ID}/versions/1`)
        .set(authHeader('admin'))
        .expect(200);

      expect(mockPrisma.estimateVersionSnapshot.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { estimate_id: ESTIMATE_ID, version: 1 },
          orderBy: { created_at: 'desc' },
        }),
      );
    });
  });

  it('404s a version that does not exist', async () => {
    mockPrisma.estimateVersionSnapshot.findFirst.mockResolvedValue(null);

    await request(app)
      .get(`/api/estimates/${ESTIMATE_ID}/versions/99`)
      .set(authHeader('admin'))
      .expect(404);
  });

  it('404s a snapshot written before versions were re-renderable', async () => {
    // Every snapshot from before #2030 is summary-only. There is nothing to open, and pretending
    // otherwise would render an empty document as if it were what the customer received.
    mockPrisma.estimateVersionSnapshot.findFirst.mockResolvedValue({ ...SNAPSHOT, document: null });

    await request(app)
      .get(`/api/estimates/${ESTIMATE_ID}/versions/1`)
      .set(authHeader('admin'))
      .expect(404);
  });

  it('is read-only — the route rejects a write, it does not merely hide controls', async () => {
    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/versions/1`)
      .set(authHeader('admin'))
      .send({ total_amount: 1 });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('resolves for a colleague in the same organization, so the route is shareable', async () => {
    mockAuthAs('sales');

    await request(app)
      .get(`/api/estimates/${ESTIMATE_ID}/versions/1`)
      .set(authHeader('sales'))
      .expect(200);
  });

  it('never resolves for another organization', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    await request(app)
      .get(`/api/estimates/${ESTIMATE_ID}/versions/1`)
      .set(authHeader('admin'))
      .expect(404);
  });
});
