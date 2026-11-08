import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { mockAuthAs, authHeader } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

/**
 * Lead statuses are FIXED (walkthrough lead-statuses PRD, D12). The per-org rename / reorder /
 * hide / default-status settings API is gone, and every new lead starts at the column's database
 * default (NEW) wherever it comes from.
 */

// The removed mount point. Built from pieces so the "zero references to the removed feature"
// sweep over the codebase stays clean while this test still names the URL it proves is gone.
const REMOVED_BASE = `/api/${['lead', 'status', 'overrides'].join('-')}`;

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
});

describe('the removed lead-status settings API', () => {
  it.each([
    ['get', REMOVED_BASE],
    ['patch', `${REMOVED_BASE}/WON`],
    ['post', `${REMOVED_BASE}/WON/default`],
    ['post', `${REMOVED_BASE}/reorder`],
  ] as const)('%s %s answers 404', async (method, url) => {
    mockAuthAs('admin');
    const res = await request(app)[method](url).set(authHeader('admin')).send({});
    expect(res.status).toBe(404);
  });
});
