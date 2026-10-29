/**
 * Org-wide tag management: PATCH /api/tags/:id and DELETE /api/tags/:id.
 *
 * Both are ADMIN-only by omission — `update Tag` / `delete Tag` have no
 * defaultGrants row, so DISPATCHER and SALES (who *can* read and create tags)
 * must not reach them. The role tests below are the guard on that, because a
 * stray grant row would silently hand every dispatcher a destructive org-wide
 * delete.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, TAG_FIXTURE } from './helpers';

const mockPrisma = prisma as unknown as {
  tag: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
};

const OTHER_TAG_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.tag.findFirst.mockResolvedValue({ id: TAG_FIXTURE.id });
  mockPrisma.tag.findUnique.mockResolvedValue(null);
  mockPrisma.tag.update.mockResolvedValue({ id: TAG_FIXTURE.id, name: 'Renamed', color: '#22C55E' });
  mockPrisma.tag.delete.mockResolvedValue({ id: TAG_FIXTURE.id });
});

describe('GET /api/tags', () => {
  it('returns the bare vocabulary and never asks for relation counts', async () => {
    mockAuthAs('sales');
    mockPrisma.tag.findMany.mockResolvedValue([{ id: TAG_FIXTURE.id, name: 'Urgent', color: '#EF4444' }]);

    const res = await request(app).get('/api/tags').set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body.tags[0]).toEqual({ id: TAG_FIXTURE.id, name: 'Urgent', color: '#EF4444' });
    // The per-tag usage count is gone: nobody acted on the figure and it cost two
    // relation counts per row on a list the picker fetches on every open.
    expect(mockPrisma.tag.findMany.mock.calls[0][0].select._count).toBeUndefined();
  });

  it('ignores a leftover with_usage query param instead of changing shape', async () => {
    mockAuthAs('admin');
    mockPrisma.tag.findMany.mockResolvedValue([{ id: TAG_FIXTURE.id, name: 'Urgent', color: '#EF4444' }]);

    const res = await request(app).get('/api/tags?with_usage=1').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.tags[0].usage_count).toBeUndefined();
  });
});

describe('PATCH /api/tags/:id', () => {
  it('renames and recolours a tag for an admin (200)', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch(`/api/tags/${TAG_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ name: 'Renamed', color: '#22C55E' });

    expect(res.status).toBe(200);
    expect(res.body.tag.name).toBe('Renamed');
    expect(mockPrisma.tag.update.mock.calls[0][0].data).toEqual({ name: 'Renamed', color: '#22C55E' });
  });

  it('scopes the lookup to the caller org before writing', async () => {
    mockAuthAs('admin');
    await request(app).patch(`/api/tags/${TAG_FIXTURE.id}`).set(authHeader('admin')).send({ name: 'Renamed' });

    // update() keys on the unique id alone, so the org check has to happen first.
    const where = mockPrisma.tag.findFirst.mock.calls[0][0].where;
    expect(where.organization_id).toBeDefined();
  });

  it('returns 404 when the tag belongs to another org', async () => {
    mockAuthAs('admin');
    mockPrisma.tag.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/tags/${TAG_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ name: 'Renamed' });

    expect(res.status).toBe(404);
    expect(mockPrisma.tag.update).not.toHaveBeenCalled();
  });

  it('returns 409 when the new name is taken by a different tag', async () => {
    mockAuthAs('admin');
    mockPrisma.tag.findUnique.mockResolvedValue({ id: OTHER_TAG_ID });

    const res = await request(app)
      .patch(`/api/tags/${TAG_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ name: 'Urgent' });

    expect(res.status).toBe(409);
    expect(mockPrisma.tag.update).not.toHaveBeenCalled();
  });

  it('allows a recolour that keeps the tag its own name', async () => {
    mockAuthAs('admin');
    // The unique lookup finds *this* tag — not a clash.
    mockPrisma.tag.findUnique.mockResolvedValue({ id: TAG_FIXTURE.id });

    const res = await request(app)
      .patch(`/api/tags/${TAG_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ name: 'Urgent', color: '#3B82F6' });

    expect(res.status).toBe(200);
  });

  it('rejects an empty body (400)', async () => {
    mockAuthAs('admin');

    const res = await request(app).patch(`/api/tags/${TAG_FIXTURE.id}`).set(authHeader('admin')).send({});

    expect(res.status).toBe(400);
    expect(mockPrisma.tag.update).not.toHaveBeenCalled();
  });

  // The name is validated AFTER it is trimmed, not before. Ordered the other way
  // round (`.min(1).max(50).trim()`) the length checks read the raw string, so a
  // name of nothing but spaces cleared `min(1)`, was trimmed to '' on the way out
  // of the schema, and was written to the shared Tag row - the tag then rendered
  // as an empty chip on every record carrying it, and could not be found by name
  // to repair. Reproduced against deployed staging before this test existed:
  // PATCH /api/tags/<id> {"name":"   "} returned 200 and persisted ''.
  it('rejects a whitespace-only name (400) rather than storing it blank', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch(`/api/tags/${TAG_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ name: '   ' });

    expect(res.status).toBe(400);
    expect(mockPrisma.tag.update).not.toHaveBeenCalled();
  });

  it('accepts a padded name and stores it trimmed', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch(`/api/tags/${TAG_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ name: '  Renamed  ' });

    expect(res.status).toBe(200);
    expect(mockPrisma.tag.update.mock.calls[0][0].data.name).toBe('Renamed');
  });

  it('accepts a name that is exactly the 50-character limit', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch(`/api/tags/${TAG_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ name: 'x'.repeat(50) });

    expect(res.status).toBe(200);
  });

  // The other half of the same operator-order bug: 52 characters that trim to a
  // legal 50 were rejected, because `max(50)` also read the untrimmed string.
  it('accepts padding around a 50-character name', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch(`/api/tags/${TAG_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ name: `  ${'x'.repeat(50)}  ` });

    expect(res.status).toBe(200);
    expect(mockPrisma.tag.update.mock.calls[0][0].data.name).toBe('x'.repeat(50));
  });

  it('still rejects a name longer than 50 characters once trimmed (400)', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch(`/api/tags/${TAG_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ name: 'x'.repeat(51) });

    expect(res.status).toBe(400);
    expect(mockPrisma.tag.update).not.toHaveBeenCalled();
  });

  it('rejects a non-hex colour (400)', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch(`/api/tags/${TAG_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ color: 'red' });

    expect(res.status).toBe(400);
  });

  it.each(['dispatcher', 'sales'] as const)('forbids %s from renaming a tag (403)', async (role) => {
    mockAuthAs(role);

    const res = await request(app)
      .patch(`/api/tags/${TAG_FIXTURE.id}`)
      .set(authHeader(role))
      .send({ name: 'Renamed' });

    expect(res.status).toBe(403);
    expect(mockPrisma.tag.update).not.toHaveBeenCalled();
  });

  it('404s a malformed id without reaching Prisma', async () => {
    mockAuthAs('admin');

    const res = await request(app).patch('/api/tags/not-a-uuid').set(authHeader('admin')).send({ name: 'Renamed' });

    expect(res.status).toBe(404);
    // The point of the guard: `id` is a Postgres uuid column, so a raw string reaching
    // findFirst throws P2023 and the catch turns it into a 500 - a fake server error, and
    // a Sentry page, for what is only a typo'd URL.
    expect(mockPrisma.tag.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.tag.update).not.toHaveBeenCalled();
  });

  it('still 403s a non-admin on a malformed id, rather than leaking that it is malformed', async () => {
    mockAuthAs('sales');

    const res = await request(app).patch('/api/tags/not-a-uuid').set(authHeader('sales')).send({ name: 'Renamed' });

    // The uuid guard sits AFTER canDo in the chain on purpose.
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/tags/:id', () => {
  it('deletes a tag for an admin (204)', async () => {
    mockAuthAs('admin');

    const res = await request(app).delete(`/api/tags/${TAG_FIXTURE.id}`).set(authHeader('admin'));

    expect(res.status).toBe(204);
    expect(mockPrisma.tag.delete).toHaveBeenCalledWith({ where: { id: TAG_FIXTURE.id } });
  });

  it('returns 404 when the tag belongs to another org', async () => {
    mockAuthAs('admin');
    mockPrisma.tag.findFirst.mockResolvedValue(null);

    const res = await request(app).delete(`/api/tags/${TAG_FIXTURE.id}`).set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(mockPrisma.tag.delete).not.toHaveBeenCalled();
  });

  it.each(['dispatcher', 'sales'] as const)('forbids %s from deleting a tag (403)', async (role) => {
    mockAuthAs(role);

    const res = await request(app).delete(`/api/tags/${TAG_FIXTURE.id}`).set(authHeader(role));

    expect(res.status).toBe(403);
    expect(mockPrisma.tag.delete).not.toHaveBeenCalled();
  });

  it('404s a malformed id without reaching Prisma', async () => {
    mockAuthAs('admin');

    const res = await request(app).delete('/api/tags/not-a-uuid').set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(mockPrisma.tag.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.tag.delete).not.toHaveBeenCalled();
  });

  it('still 403s a non-admin on a malformed id, rather than leaking that it is malformed', async () => {
    mockAuthAs('sales');

    const res = await request(app).delete('/api/tags/not-a-uuid').set(authHeader('sales'));

    expect(res.status).toBe(403);
  });
});
