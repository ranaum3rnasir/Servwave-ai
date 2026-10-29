import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { getTenantContext } from '../lib/tenant-context';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, LEAD_FIXTURE } from './helpers';

/**
 * Regression guard for the "Entity not found" attachment-upload bug.
 *
 * `authenticate` wraps the request in runWithOrg(org, next) so the DB RLS
 * backstop (DB_TENANT_GUARD=on) can scope every query to the caller's org.
 * multer's upload.single() consumes the request stream and drives the
 * continuation off stream events — OUTSIDE that AsyncLocalStorage scope — so
 * the controller (and every Prisma query it runs) sees NO org context. With
 * the guard on, that means RLS matches zero rows and checkEntityExists() 404s
 * with "Entity not found" for a lead the user can otherwise read.
 *
 * The mocked prisma here can't reproduce RLS row-filtering, so we assert the
 * true invariant instead: when the upload controller queries, it MUST be
 * running inside the uploader's org context.
 */
const mockPrisma = prisma as unknown as {
  lead: { findUnique: ReturnType<typeof vi.fn> };
  organization: { findUnique: ReturnType<typeof vi.fn> };
};

// A real, decodable 1x1 transparent PNG - the org-logo controller re-encodes
// through sharp before it queries, so the bytes must survive that decode.
//
// The previous fixture here only LOOKED decodable: its IDAT chunk carried a bad
// CRC and a truncated deflate stream. libpng <= 1.6.50 (sharp <= 0.34.x) read it
// anyway; libpng 1.6.58 (sharp 0.35.x) correctly rejects it with "vipspng:
// libpng read error", which made sharp throw at organization.controller.ts
// BEFORE the prisma query below, so capturedOrg never left 'NEVER_CALLED'.
// These bytes are a structurally valid PNG (every chunk CRC verified) and decode
// on both libpng generations - do not swap them for a "smaller" 1x1 off the web,
// most of those circulate with the same broken IDAT.
const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==',
  'base64',
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('multipart uploads preserve the org context past multer', () => {
  it('lead attachment upload runs the controller inside the uploader org context', async () => {
    mockAuthAs('admin');

    let capturedOrg: string | null | undefined = 'NEVER_CALLED';
    mockPrisma.lead.findUnique.mockImplementation(() => {
      capturedOrg = getTenantContext()?.orgId ?? null;
      // Return null → checkEntityExists() short-circuits to 404 before any
      // storage call. We only care about the context captured above.
      return Promise.resolve(null);
    });

    await request(app)
      .post(`/api/attachments/lead/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .field('display_name', 'probe')
      .field('description', 'probe')
      .attach('file', Buffer.from('%PDF-1.4 minimal probe'), 'probe.pdf');

    expect(capturedOrg).toBe(ALPHA_ORG_ID);
  });

  it('org logo upload runs the controller inside the uploader org context', async () => {
    mockAuthAs('admin');

    let capturedOrg: string | null | undefined = 'NEVER_CALLED';
    mockPrisma.organization.findUnique.mockImplementation(() => {
      capturedOrg = getTenantContext()?.orgId ?? null;
      // Return null → controller short-circuits to 404 before any storage call.
      return Promise.resolve(null);
    });

    await request(app)
      .post('/api/organization/logo')
      .set(authHeader('admin'))
      .attach('file', ONE_PX_PNG, 'logo.png');

    expect(capturedOrg).toBe(ALPHA_ORG_ID);
  });
});
