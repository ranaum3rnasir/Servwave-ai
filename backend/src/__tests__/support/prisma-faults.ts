/* =============================================================================
   Test helper (not a test file): a Prisma client whose raw statements can be made to fail on demand.

   A Prisma client is a proxy of its own, so `vi.spyOn(client, '$executeRaw')` installs a spy that the client never
   calls: the original method still runs, and a test that "made the write fail" proves nothing. Mock `lib/prisma` with
   this wrapper instead:

     const faults = vi.hoisted(() => ({ executeRaw: null as null | ((sql: string) => Error | null) }));
     vi.mock('../lib/prisma', async () => ({ prisma: (await import('./support/prisma-faults.js')).withFaults(realClient, faults) }));
     faults.executeRaw = (sql) => (sql.includes('UPDATE spider_alerts') ? new Error('connection reset') : null);

   While `faults.executeRaw` is set, every `$executeRaw` call whose SQL text it answers with an error rejects with that
   error and never reaches the database; every other call, and everything else on the client (model delegates, `$on`,
   `$transaction`, internals the query counter reads), is the real client's, bound to it. `calls` lists the SQL text
   of every `$executeRaw` call the wrapper saw, failed or not.
   ========================================================================== */

import type { PrismaClient } from '@prisma/client';

export interface PrismaFaults {
  executeRaw: null | ((sql: string) => Error | null);
  calls?: string[];
}

/** The SQL text of a `$executeRaw` call: a `Prisma.sql` object, or a tagged template's strings. */
function sqlOf(first: unknown): string {
  if (Array.isArray(first)) return first.join('?');
  const sql = (first as { sql?: unknown } | null)?.sql;
  return typeof sql === 'string' ? sql : String(first);
}

export function withFaults(real: PrismaClient, faults: PrismaFaults): PrismaClient {
  return new Proxy(real, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === '$executeRaw') {
        return (...args: unknown[]) => {
          const sql = sqlOf(args[0]);
          (faults.calls ??= []).push(sql);
          const error = faults.executeRaw?.(sql) ?? null;
          if (error) return Promise.reject(error);
          return (value as (...a: unknown[]) => Promise<number>).apply(target, args);
        };
      }
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as PrismaClient;
}
