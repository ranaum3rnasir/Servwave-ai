import { describe, it, expect, vi } from 'vitest';
import { wrapWithTenantGuard } from '../lib/tenant-guard';
import { runWithOrg, runUnscoped } from '../lib/tenant-context';

// A minimal fake PrismaClient that records the order of set_config + ops.
function makeFakeBase() {
  const log: string[] = [];
  const tx = {
    $executeRawUnsafe: (_sql: string, org: string, bypass: string) => {
      log.push(`setconfig:${org}:${bypass}`);
      return Promise.resolve();
    },
    customer: {
      findMany: (_args: unknown) => {
        log.push('op:customer.findMany');
        return Promise.resolve(['row']);
      },
    },
  };
  const base = {
    $transaction: vi.fn((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (t: unknown) => Promise<unknown>)(tx)
        : Promise.all(arg as Promise<unknown>[]),
    ),
    $executeRawUnsafe: vi.fn(() => Promise.resolve('setcfg')),
    customer: { findMany: vi.fn((_args?: unknown) => Promise.resolve()) }, // presence → treated as a model delegate
  };
  return { base, log };
}

describe('wrapWithTenantGuard', () => {
  it('runs a model op inside a txn that sets the org session var FIRST', async () => {
    const { base, log } = makeFakeBase();
    const wrapped = wrapWithTenantGuard(base as never);
    const result = await runWithOrg('org-9', () => (wrapped as never as typeof base).customer.findMany({}));
    expect(result).toEqual(['row']);
    expect(log).toEqual(['setconfig:org-9:', 'op:customer.findMany']);
  });

  it('sets the bypass flag (not an org) under runUnscoped', async () => {
    const { base, log } = makeFakeBase();
    const wrapped = wrapWithTenantGuard(base as never);
    await runUnscoped(() => (wrapped as never as typeof base).customer.findMany({}));
    expect(log[0]).toBe('setconfig::on');
  });

  it('injects set_config first inside an interactive $transaction', async () => {
    const { base, log } = makeFakeBase();
    const wrapped = wrapWithTenantGuard(base as never);
    await runWithOrg('org-2', () =>
      (wrapped as never as { $transaction: (fn: (tx: { customer: { findMany: (a: unknown) => Promise<unknown> } }) => Promise<unknown>) => Promise<unknown> }).$transaction(
        async (tx) => {
          await tx.customer.findMany({});
          return 'done';
        },
      ),
    );
    expect(log).toEqual(['setconfig:org-2:', 'op:customer.findMany']);
  });
});
