import { Prisma, PrismaClient } from '@prisma/client';
import { env } from '../config/env';
import { wrapWithTenantGuard } from './tenant-guard';

// The client behind /health/deep: one database line, used by nothing else.
//
// /health/deep asks "can this process still get a line to the database?". Asked on the users' pool, the answer
// depends on what the users and the background jobs are doing: when a job holds every line, the probe queues behind
// it and times out, and the platform restarts a healthy process (a stuck job became a restart loop). A client of its
// own makes the answer about the database alone. It holds one line, so it can never take a line from anyone else.
//
// `pool_timeout` is how long a probe may wait for that one line. It matches the probe's own 2 s budget, so a probe
// that gave up does not stay queued for the default 10 s behind a line that is held.
const HEALTH_POOL_LINES = '1';
const HEALTH_POOL_WAIT_SECONDS = '2';

/** The database address with this client's pool limits set, whatever the address already carried. */
export function healthDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('connection_limit', HEALTH_POOL_LINES);
  url.searchParams.set('pool_timeout', HEALTH_POOL_WAIT_SECONDS);
  return url.toString();
}

// Same switch and same wrapper as lib/prisma.ts: with DB_TENANT_GUARD=on every query runs inside a transaction that
// sets the tenant session variables first, so this client is never the one path around the guard.
const GUARD_ON = process.env.DB_TENANT_GUARD === 'on';

let client: PrismaClient | undefined;

/**
 * The health client, built on first use: a server that is never asked /health/deep never builds it, and importing the
 * app (every test does) opens nothing.
 */
export function prismaHealth(): PrismaClient {
  if (!client) {
    // Typed as `Prisma.PrismaClientOptions` BEFORE the constructor, on purpose. An inline literal given to `new PrismaClient({...})`
    // becomes the client's own type, and assigning that client to a `PrismaClient`-typed place (`client` below) makes TypeScript
    // compare the two structurally across every model: about 39k types per call site, about 700k for the first one. That once
    // pushed the 4 GB typecheck and the default-heap build out of memory. Typed up front, the client is the default type and
    // nothing is compared. Keep it this way; do not inline the literal.
    const options: Prisma.PrismaClientOptions = {
      datasources: { db: { url: healthDatabaseUrl(env.DATABASE_URL) } },
      log: [{ emit: 'stdout', level: 'error' }],
    };
    const base = new PrismaClient(options);
    client = GUARD_ON ? wrapWithTenantGuard(base) : base;
  }
  return client;
}
