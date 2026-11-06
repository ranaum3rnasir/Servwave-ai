import { Prisma, PrismaClient } from '@prisma/client';
import { tenantGuardOn, wrapWithTenantGuard } from './tenant-guard';
import { onJobsClient, prismaJobs } from './prismaJobs';

// Test-only switch. Prisma delivers `$on('query')` events only to a client built with an event log, and the
// default log below has none. The backend query counter (src/__tests__/support/query-counter.ts) needs them on the
// client the app really uses, so PRISMA_QUERY_EVENTS=on adds the event. It is ignored in production, and errors
// still go to stdout, so a deployed server behaves exactly as before.
const QUERY_EVENTS = process.env.PRISMA_QUERY_EVENTS === 'on' && process.env.NODE_ENV !== 'production';

const logLevels: Prisma.LogDefinition[] = QUERY_EVENTS
  ? [
      { emit: 'event', level: 'query' },
      { emit: 'stdout', level: 'error' },
    ]
  : process.env.NODE_ENV === 'development'
    ? [
        { emit: 'stdout', level: 'warn' },
        { emit: 'stdout', level: 'error' },
      ]
    : [{ emit: 'stdout', level: 'error' }];

// The property must stay REQUIRED (`{ prisma: PrismaClient }`), not optional. Because `globalForPrisma.prisma || new PrismaClient({...})`
// is then typed as `PrismaClient`, the literal below is checked against the default options and the new client is not compared
// structurally. Made optional (`prisma?: PrismaClient`), `new PrismaClient({...})` takes the literal's own type and costs about
// 700k types, enough to push the 4 GB typecheck and the default-heap build out of memory. (lib/prismaJobs.ts and
// lib/prismaHealth.ts type their options up front for the same reason.)
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

const base =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: logLevels,
    // Interactive transactions default to maxWait 2s / timeout 5s. The Supabase
    // pooler's cold connect + per-query latency from a dev machine can push a
    // single write transaction past 5s, killing it with P2028. Raise the limits
    // so writes (lead/job/customer/estimate/invoice) survive a slow pooler.
    transactionOptions: { maxWait: 20000, timeout: 30000 },
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = base;

// DB-level tenant isolation backstop. OFF by default → `prisma` is the plain
// client and behavior is identical to before. When DB_TENANT_GUARD=on (and the
// app connects as a non-BYPASSRLS role), every query runs inside a transaction
// that sets the org session var the RLS policies enforce. See
// docs/rls-activation-runbook.md for the one-step activation.
const GUARD_ON = tenantGuardOn();

const userClient: PrismaClient = GUARD_ON ? wrapWithTenantGuard(base) : base;

// Background jobs run on their own two lines (lib/prismaJobs.ts) so they can never hold the users' lines. A job is anything
// started inside `runOnJobsClient` (every cron job and the boot-time run in index.ts): its calls, however deep in the
// services, reach `prisma` here and are sent to the jobs' client; every other call (an HTTP request) uses the user client.
export const prisma: PrismaClient = new Proxy(userClient, {
  get(_target, prop) {
    const client = onJobsClient() ? prismaJobs : userClient;
    const value = Reflect.get(client, prop, client);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});
