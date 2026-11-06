/* =============================================================================
   /health/deep with the database tenant guard on (DB_TENANT_GUARD=on, #3106) - over HTTP, real app, real migrated
   database. The deep probe's own client is wrapped by the guard exactly as the users' client is; the wrapper runs
   every statement inside a transaction, and the probe must still answer ok, and still give up at 2 s on a held line.

   Skips when TEST_DATABASE_URL is unset.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Prisma, PrismaClient } from '@prisma/client';

vi.hoisted(() => {
  // Read once, when the health client module loads.
  if (process.env.TEST_DATABASE_URL) process.env.DB_TENANT_GUARD = 'on';
});

vi.mock('../lib/prisma', () => ({ prisma: undefined }));

vi.mock('../config/env', async () => {
  const { testEnv } = await import('./test-env.js');
  return { env: { ...testEnv, DATABASE_URL: process.env.TEST_DATABASE_URL ?? testEnv.DATABASE_URL } };
});

import request from 'supertest';
import { performance } from 'perf_hooks';
import { heldLines } from './support/held-lines';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite('Health endpoints with the tenant guard on (real database)', () => {
  let app: Parameters<typeof request>[0];
  let healthClient: PrismaClient;
  let monitor: PrismaClient;

  beforeAll(async () => {
    app = (await import('../app.js')).default as never;
    healthClient = (await import('../lib/prismaHealth.js')).prismaHealth();
    const { PrismaClient: Client } = await import('@prisma/client');
    // Options typed first, not inlined: an inline literal assigned to a `PrismaClient`-typed place costs ~39k types (~700k the first) and once ran CI's typecheck out of memory.
    const monitorOptions: Prisma.PrismaClientOptions = { datasources: { db: { url: process.env.TEST_DATABASE_URL! } } };
    monitor = new Client(monitorOptions);
  }, 120_000);

  afterAll(async () => {
    await healthClient.$disconnect();
    await monitor.$disconnect();
  });

  it('/health/deep says the database is fine when it answers', async () => {
    const res = await request(app).get('/health/deep');
    expect(res.status).toBe(200);
    expect(res.body.db).toBe('ok');
  });

  it('/health/deep says the database is down when it cannot get a line within 2 s', async () => {
    const stuck = await heldLines(monitor).hold(healthClient, 1, 3);

    const started = performance.now();
    const res = await request(app).get('/health/deep');
    const elapsed = performance.now() - started;

    expect(res.status).toBe(503);
    expect(res.body.db).toBe('error');
    expect(elapsed).toBeGreaterThan(1900);
    expect(elapsed).toBeLessThan(3000);
    await stuck.released;
  });
});
