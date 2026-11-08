import { AsyncLocalStorage } from 'async_hooks';

/**
 * Per-request tenant context for the DB-level RLS backstop.
 *
 * The org id (or an explicit cross-tenant bypass) is stashed in AsyncLocalStorage
 * so the Prisma wrapper (lib/prisma.ts) can set the Postgres session vars the RLS
 * policies read — WITHOUT threading an org argument through every call site.
 *
 * This is inert until the DB tenant guard is switched on (DB_TENANT_GUARD=on) and
 * the app connects as a non-BYPASSRLS role; see docs/rls-activation-runbook.md.
 */

export interface TenantContext {
  orgId: string | null;
  unscoped: boolean;
}

const storage = new AsyncLocalStorage<TenantContext>();

/** Run `fn` scoped to `orgId` — RLS filters every query to this org. */
export function runWithOrg<T>(orgId: string, fn: () => T): T {
  return storage.run({ orgId, unscoped: false }, fn);
}

/**
 * Run `fn` with a controlled cross-tenant bypass. For the legitimate org-less
 * paths only: cron sweeps, the Stripe webhook (org resolved from the entity),
 * auth bootstrap, and scripts.
 */
export function runUnscoped<T>(fn: () => T): T {
  return storage.run({ orgId: null, unscoped: true }, fn);
}

export function getTenantContext(): TenantContext | undefined {
  return storage.getStore();
}

/**
 * The Postgres session-var values for the current context:
 *  - `app.current_org_id` scopes reads/writes to one org.
 *  - `app.bypass_rls` = 'on' is the controlled escape hatch.
 * With NO context we return neither, so the policies match no rows (fail-closed).
 */
export function tenantConfigValues(): { orgId: string; bypass: string } {
  const ctx = storage.getStore();
  if (!ctx) return { orgId: '', bypass: '' };
  if (ctx.unscoped) return { orgId: '', bypass: 'on' };
  return { orgId: ctx.orgId ?? '', bypass: '' };
}
