import type { PrismaClient, Prisma } from '@prisma/client';
import { tenantConfigValues } from './tenant-context';

/**
 * Sets both RLS session vars transaction-locally (the `true` = is_local, so they
 * reset at COMMIT — safe under a transaction-mode connection pooler).
 */
export const SET_CONFIG_SQL =
  "SELECT set_config('app.current_org_id', $1, true), set_config('app.bypass_rls', $2, true)";

/** Whether the DB tenant guard is switched on for this process (DB_TENANT_GUARD=on). */
export const tenantGuardOn = (): boolean => process.env.DB_TENANT_GUARD === 'on';

/**
 * What a wrapped client sets at the start of every transaction it opens.
 *  - `tenant` (default true): the org session vars the RLS policies read.
 *  - `limits`: Postgres `statement_timeout` / `lock_timeout` for everything in that transaction. A standalone
 *    `SET LOCAL` would be lost (the wrap makes every call its own transaction), and a connection-level setting
 *    (`options` in the URL) is refused by a transaction-mode pooler, so they are set here, with the vars.
 */
export interface TenantGuardOptions {
  tenant?: boolean;
  limits?: { statementTimeout: string; lockTimeout: string };
}

/** The one statement that sets everything `options` asks for, and the arguments it takes (read at call time). */
function configStatement(options: TenantGuardOptions): { sql: string; args: () => string[] } {
  const tenant = options.tenant ?? true;
  const { limits } = options;
  if (!tenant && !limits) throw new Error('wrapWithTenantGuard: nothing to set (tenant is off and no limits were given)');
  if (!limits) return { sql: SET_CONFIG_SQL, args: () => { const v = tenantConfigValues(); return [v.orgId, v.bypass]; } };
  if (!tenant) {
    return {
      sql: "SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)",
      args: () => [limits.statementTimeout, limits.lockTimeout],
    };
  }
  return {
    sql:
      "SELECT set_config('app.current_org_id', $1, true), set_config('app.bypass_rls', $2, true), " +
      "set_config('statement_timeout', $3, true), set_config('lock_timeout', $4, true)",
    args: () => {
      const v = tenantConfigValues();
      return [v.orgId, v.bypass, limits.statementTimeout, limits.lockTimeout];
    },
  };
}

/**
 * Wrap a PrismaClient so EVERY operation runs inside a transaction that first
 * sets the tenant session vars the RLS policies read. This is what makes a
 * single missed `tenantWhere()` unable to leak cross-org data at the DB level.
 *
 * - Model ops (`prisma.customer.findMany`, …) → per-op txn + set_config.
 * - Interactive `$transaction(fn)` → set_config runs before the callback (Prisma
 *   query extensions do NOT fire inside interactive transactions, so this wrap is
 *   how those ~90 call sites get scoped).
 * - Batch `$transaction([...])` → set_config prepended, its result stripped.
 * - Raw ops (`$queryRaw` etc.) → wrapped too (they hit tenant tables directly).
 *
 * `prisma` is wrapped only when DB_TENANT_GUARD=on (see lib/prisma.ts); the jobs' client (lib/prismaJobs.ts) is always
 * wrapped, to carry its statement and lock limits, and sets the tenant vars only when the guard is on (`tenant: false`).
 * The values come from the AsyncLocalStorage tenant context, so no call site needs to pass an org.
 */
export function wrapWithTenantGuard(base: PrismaClient, options: TenantGuardOptions = {}): PrismaClient {
  const config = configStatement(options);
  const setConfig = (tx: Prisma.TransactionClient) => tx.$executeRawUnsafe(config.sql, ...config.args());

  // Run a single operation inside its own transaction, config set first.
  const runOp = (exec: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
    base.$transaction(async (tx) => {
      await setConfig(tx);
      return exec(tx);
    });

  const wrapTxn = (arg: unknown, opts?: unknown): unknown => {
    if (typeof arg === 'function') {
      const fn = arg as (tx: Prisma.TransactionClient) => Promise<unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return base.$transaction(async (tx) => {
        await setConfig(tx);
        return fn(tx);
      }, opts as any);
    }
    // Batch form: prepend set_config, then drop its result so callers still get N.
    const arr = arg as Prisma.PrismaPromise<unknown>[];
    return (
      base.$transaction(
        [base.$executeRawUnsafe(config.sql, ...config.args()), ...arr],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        opts as any,
      ) as Promise<unknown[]>
    ).then((results) => results.slice(1));
  };

  const RAW = new Set(['$queryRaw', '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe']);

  return new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop !== 'string') return Reflect.get(target, prop, receiver);
      if (prop === '$transaction') return wrapTxn;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (RAW.has(prop)) return (...args: any[]) => runOp((tx) => (tx as any)[prop](...args));

      const value = Reflect.get(target, prop, target);
      // Model delegates are the non-$ / non-_ object properties (customer, invoice…).
      if (value && typeof value === 'object' && !prop.startsWith('$') && !prop.startsWith('_')) {
        return new Proxy(value as object, {
          get(mTarget, mProp) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const op = (mTarget as any)[mProp];
            if (typeof mProp !== 'string' || typeof op !== 'function') return op;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (...args: any[]) => runOp((tx) => (tx as any)[prop][mProp](...args));
          },
        });
      }
      // Pass through everything else, binding methods to the real client so
      // Prisma's private-field access keeps working ($connect, $on, $extends…).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return typeof value === 'function' ? (value as any).bind(target) : value;
    },
  }) as PrismaClient;
}
