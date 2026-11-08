/**
 * #2029 slice 1 — the per-line-item photo upload path is retired.
 *
 * Ran, directly: line items have images attached to them as an attribute from the stock/price
 * book for that item, that's it. They cannot upload more images for line items, not even to the
 * estimate itself.
 *
 * A deletion, not a deprecation — both photo tables are empty in production, so there is no data
 * to migrate and no compatibility window to keep. Scope photos are untouched.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { mockAuthAs, authHeader } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const ESTIMATE_ID = 'f0000000-0000-0000-0000-000000000001';
const LINE_ID = 'aa000000-0000-0000-0000-000000000003';
const SCOPE_ID = 'cc000000-0000-0000-0000-000000000003';
const PHOTO_ID = 'bb000000-0000-0000-0000-000000000003';

/**
 * A 404 alone proves nothing here: the upload handler ALSO 404s an estimate it cannot find, so a
 * test asserting only the status would pass just as happily against the route still mounted. An
 * unmounted path falls through to app.ts's own catch-all, whose body is exactly `Not found` —
 * that body, not the status, is the assertion.
 */
function expectUnmounted(res: { status: number; body: unknown }) {
  expect(res.status).toBe(404);
  expect(res.body).toEqual({ error: 'Not found' });
}

beforeEach(() => {
  clearPermissionCache();
  mockAuthAs('admin');
});

describe('the line-item photo routes', () => {
  it('no longer accept an upload', async () => {
    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/line-items/${LINE_ID}/photos`)
      .set(authHeader('admin'))
      .attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), { filename: 'x.jpg', contentType: 'image/jpeg' });

    expectUnmounted(res);
  });

  it('no longer accept a delete', async () => {
    const res = await request(app)
      .delete(`/api/estimates/${ESTIMATE_ID}/line-items/${LINE_ID}/photos/${PHOTO_ID}`)
      .set(authHeader('admin'));

    expectUnmounted(res);
  });
});

describe('the scope photo routes', () => {
  it('still exist — this slice does not touch them', async () => {
    const res = await request(app)
      .delete(`/api/estimates/${ESTIMATE_ID}/scopes/${SCOPE_ID}/photos/${PHOTO_ID}`)
      .set(authHeader('admin'));

    // Whatever the handler decides about this particular id, the ROUTE is still mounted: it is
    // answered by an estimate handler, never by app.ts's catch-all.
    expect(res.body).not.toEqual({ error: 'Not found' });
  });
});
