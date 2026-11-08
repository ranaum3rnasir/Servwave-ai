import { PrismaClient } from '@prisma/client';
import { wrapWithTenantGuard } from './tenant-guard';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

const base =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
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
const GUARD_ON = process.env.DB_TENANT_GUARD === 'on';

export const prisma: PrismaClient = GUARD_ON ? wrapWithTenantGuard(base) : base;
