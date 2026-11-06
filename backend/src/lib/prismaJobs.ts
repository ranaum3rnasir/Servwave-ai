import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma, PrismaClient } from '@prisma/client';
import { tenantGuardOn, wrapWithTenantGuard } from './tenant-guard';

/** The jobs' own pool: two lines, so a job can never hold more than two of the database's connections. */
const JOBS_CONNECTION_LIMIT = 2;

/** A job statement running longer than this is cancelled by the database; one waiting longer than `JOB_LOCK_TIMEOUT` for a lock is too. */
const JOB_STATEMENT_TIMEOUT = '5s';
const JOB_LOCK_TIMEOUT = '1s';

/** `url` with its connection_limit replaced by `limit` (any connection_limit already in it is dropped). */
function withConnectionLimit(url: string, limit: number): string {
  const [head, query = ''] = url.split('?');
  const kept = query.split('&').filter((p) => p !== '' && !/^connection_limit=/i.test(p));
  return `${head}?${[...kept, `connection_limit=${limit}`].join('&')}`;
}

// Test-only switch, read the same way as in lib/prisma.ts: PRISMA_QUERY_EVENTS=on gives this client the query event the backend query counter
// (src/__tests__/support/query-counter.ts) listens to, so a test can prove a paused job sends no query on the jobs' lines either.
// Ignored in production; errors still go to stdout either way.
const QUERY_EVENTS = process.env.PRISMA_QUERY_EVENTS === 'on' && process.env.NODE_ENV !== 'production';
const jobsLog: Prisma.LogDefinition[] = QUERY_EVENTS
  ? [{ emit: 'event', level: 'query' }, { emit: 'stdout', level: 'error' }]
  : [{ emit: 'stdout', level: 'error' }];

const globalForJobs = globalThis as unknown as { prismaJobs?: PrismaClient };

// The address is read the way lib/prisma.ts reads it (the process environment), so importing either needs nothing more than
// DATABASE_URL: a script that imports lib/prisma must not need the whole app's configuration. Without one, Prisma fails on
// the first query, as it does for the users' client.
const databaseUrl = process.env.DATABASE_URL;

// Typed as `Prisma.PrismaClientOptions` BEFORE the constructor, on purpose. `new PrismaClient({ ...inline literal... })` takes the
// literal's own type as the client's type argument, and assigning or passing that client to a `PrismaClient`-typed place makes
// TypeScript compare the two clients structurally across every model: about 39k types per call site, and about 700k for the first
// one. That once pushed the 4 GB typecheck and the default-heap build out of memory. With the options typed up front the client is
// the default `PrismaClient` type and nothing is compared. Keep it this way; do not inline the literal.
const jobsOptions: Prisma.PrismaClientOptions = {
  log: jobsLog,
  ...(databaseUrl ? { datasources: { db: { url: withConnectionLimit(databaseUrl, JOBS_CONNECTION_LIMIT) } } } : {}),
  transactionOptions: { maxWait: 2000, timeout: 5000 },
};

const base = globalForJobs.prismaJobs || new PrismaClient(jobsOptions);

if (process.env.NODE_ENV !== 'production') globalForJobs.prismaJobs = base;

// Wrapped exactly as `prisma` is when DB_TENANT_GUARD is on, so tenant isolation is the same for a job. Guard on or off,
// the wrap also gives every job statement its limits, inside the transaction the wrap opens.
export const prismaJobs: PrismaClient = wrapWithTenantGuard(base, {
  tenant: tenantGuardOn(),
  limits: { statementTimeout: JOB_STATEMENT_TIMEOUT, lockTimeout: JOB_LOCK_TIMEOUT },
});

const jobScope = new AsyncLocalStorage<true>();

/** Run `fn` as a background job: every `prisma` call it makes, however deep, goes to the jobs' own lines. */
export function runOnJobsClient<T>(fn: () => T): T {
  return jobScope.run(true, fn);
}

export function onJobsClient(): boolean {
  return jobScope.getStore() === true;
}
