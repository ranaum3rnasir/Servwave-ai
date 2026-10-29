/**
 * manual-log-transaction.ts — the shared `$transaction` double for the Manual Communication Log
 * (spec: md_files/specs/communication/2026-08-27-manual-communication-log.md; decision C15).
 *
 * TEST SUPPORT, not a test. It exists for the same reason manual-log-silence.ts does: every suite
 * that reaches the create path now goes through a transaction, and if each one invented its own
 * double, the one that mattered would be the one that quietly asserted nothing.
 *
 * ── WHY THE OBVIOUS DOUBLE IS A PLACEBO ───────────────────────────────────────────────────────
 *
 * The idiom this repo reaches for elsewhere is
 *
 *     mockPrisma.$transaction.mockImplementation((fn) => fn(mockPrisma));
 *
 * which runs the callback and hands it the same client. That is fine for a suite testing what the
 * writes DO, and it is worthless for a suite testing what a FAILED transaction UNDOES: nothing is
 * ever undone, so a rollback assertion written against it passes identically whether the writes
 * are wrapped in a transaction or left as three loose statements. It is also worthless for the
 * SECOND hazard below, because it hands the callback the very client it must not use. Mocked
 * Prisma hides both classes of defect, and both are recorded incidents here, not cautions.
 *
 * ── WHAT THIS ONE DOES INSTEAD, (1): REAL ALL-OR-NOTHING ──────────────────────────────────────
 *
 * It gives the callback real all-or-nothing semantics over the in-memory stores the suite already
 * keeps. Pass the arrays your fixtures push rows into; the double snapshots them before the
 * callback runs and restores them if it rejects. A suite that passes no journals gets a plain
 * pass-through of the rollback half — which is all the suites testing the happy path need, and is
 * honest about proving nothing on its own.
 *
 * That makes the rollback assertion DISCRIMINATING, which is the whole point: with the writes
 * wrapped, a failing audit-event write rolls the entry back out of the store and the lead's
 * timeline is empty; with the three loose writes it replaces, no `$transaction` call happens at
 * all, so no snapshot is taken, the entry stays in the store and the timeline still shows it.
 * Mutation-proved, not assumed — revert the controller to the three separate writes and the
 * rollback case reddens.
 *
 * ── WHAT THIS ONE DOES INSTEAD, (2): IT TELLS `tx` FROM THE GLOBAL CLIENT ─────────────────────
 *
 * Reaching for the global `prisma` client from inside an interactive transaction takes a SECOND
 * connection out of the pool while the first is still held, and deadlocks it under load (P2024) —
 * recorded here too, and the reason inventory-tx-connection-isolation.test.ts exists. THIS DOUBLE
 * CATCHES IT, and no assertion in the calling suite is needed for that to happen.
 *
 * An earlier version of this header said the hazard was "not testable under a fully mocked
 * Prisma" and left it held by reading the call graph. THAT WAS WRONG, and the wording is corrected
 * rather than merely deleted, because a comment telling the next person not to bother is the
 * expensive kind of error. `setup.ts` builds the client as a plain object literal of `vi.fn()`s,
 * so its delegates are enumerable and WRITABLE. For the duration of the callback this double
 * therefore:
 *
 *   1. CAPTURES every model delegate's functions (the `vi.fn()` objects themselves, so per-test
 *      `mockResolvedValue`/`mockRejectedValue` set before OR after arming still applies, and the
 *      suite's `toHaveBeenCalledWith` assertions still see the calls `tx` made);
 *   2. hands the callback a `tx` that forwards to those CAPTURED functions; and
 *   3. POISONS the global delegates — `prisma.<model>.<op>` throws — restoring them in a
 *      `finally`, whether the callback resolved or rejected.
 *
 * So `tx.timelineEvent.create` works and `prisma.timelineEvent.create` throws, from inside the
 * callback and only from inside it. A leak is also RECORDED, and a recorded leak fails the
 * transaction even if the throw was swallowed on the way out — which is not hypothetical here:
 * `recordLeadOutboundContact` catches and logs its own failures by contract, so handing IT the
 * global client instead of `tx` would otherwise still answer 201.
 *
 * inventory-tx-connection-isolation.test.ts is the same idea spelled the other way: it gives its
 * tx client its own spies, and each test asserts the global spy `.not.toHaveBeenCalled()`.
 * Poisoning is the shape that suits a SHARED double — the guard arrives with the double, so a
 * suite added later cannot forget to assert it.
 *
 * PROVED, in the same 2×2 shape used for the rollback claim (comm-manual-log-audit, 18 tests):
 *
 *      double            controller                          result
 *      ───────────────── ─────────────────────────────────── ────────────────────────────
 *      leak-blind        clean                               18 passed
 *      leak-blind        `tx.` → `prisma.` on the audit      18 passed  ← NOT CAUGHT
 *                        event write
 *      this one          clean                               18 passed  ← no false positive
 *      this one          same one-token mutation             16 failed / 2 passed ← CAUGHT
 *      this one          `recordLeadOutboundContact(tx` →    11 failed / 7 passed ← CAUGHT
 *                        `(prisma` — the SWALLOWED leak
 *
 * The no-false-positive row is the load-bearing one: a double that reddens correct code would be
 * worse than no double at all. All five re-measured against this file as it stands. The seven
 * survivors of the last row are the inbound and job-anchored cases, where that writer no-ops
 * before it touches a client at all — nothing leaks there, so nothing is reported.
 *
 * ── WHAT IT DELIBERATELY DOES NOT CLAIM ───────────────────────────────────────────────────────
 *
 * Restoring an array undoes ROWS ADDED during the transaction. It does not undo an in-place edit
 * to a row that was already there (`Object.assign(row, …)`, the shape comm-manual-log-audit's
 * update fixture uses), because the snapshot is shallow. The create path only ever appends, so
 * this is sufficient where it is used and would need deepening before it could stand behind a
 * rollback claim about an UPDATE.
 *
 * The leak guard covers the MODEL DELEGATES and the raw-query methods, which is every statement
 * this feature runs. It does not cover a nested `prisma.$transaction(…)` on the global client:
 * `tx.$transaction` is refused outright (see below), but a second call on the global one is let
 * through re-entrantly so that a suite issuing overlapping requests is not reddened by its own
 * concurrency. Nothing in this feature opens one; a suite that needs that caught should assert it
 * directly.
 */
import { vi } from 'vitest';
import { prisma } from '../lib/prisma';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockPrisma = prisma as any;

/** A captured delegate: `{ create: <the vi.fn>, findMany: <the vi.fn>, … }`, by model name. */
type Captured = Map<string, Record<string, any>>;

/**
 * `$transaction` can be re-entered — a suite may have two requests in flight at once, and the
 * second one's pre-transaction reads run on the global client while the first one's callback is
 * open. So the globals are poisoned when the count goes 0 → 1 and restored when it returns to 0,
 * and the captured originals are shared: an inner call must not capture the poison as if it were
 * the real delegate.
 */
let openTransactions = 0;
let captured: Captured | null = null;
let leaks: string[] = [];

/** Every model delegate, plus the raw-query methods, captured BY VALUE. */
function captureClient(): Captured {
  const snapshot: Captured = new Map();
  const raw: Record<string, any> = {};
  for (const key of Object.keys(mockPrisma)) {
    const value = mockPrisma[key];
    if (value && typeof value === 'object') {
      const ops: Record<string, any> = {};
      for (const op of Object.keys(value)) ops[op] = value[op];
      snapshot.set(key, ops);
    } else if (typeof value === 'function' && key !== '$transaction') {
      // `$queryRaw` and friends. Same hazard, same treatment; `$transaction` itself is the mock
      // whose implementation is currently running and is handled by the re-entrancy note above.
      raw[key] = value;
    }
  }
  if (Object.keys(raw).length > 0) snapshot.set('', raw);
  return snapshot;
}

/** `prisma.timelineEvent.create`, or `prisma.$queryRaw` for the raw methods (empty model). */
function globalPath(model: string, op: string): string {
  return `prisma.${model ? `${model}.` : ''}${op}`;
}

function leaked(model: string, op: string): () => never {
  return () => {
    const message =
      'manual-log-transaction: the GLOBAL prisma client was used INSIDE a $transaction callback ' +
      `(${globalPath(model, op)}). That checks a SECOND connection out of the pool while the ` +
      'first is still held, and deadlocks under load (P2024, a recorded incident here). Use the ' +
      '`tx` the callback is handed, and pass it to every helper that writes — see the module ' +
      'header of comm-manual-log.controller.ts.';
    // RECORDED as well as thrown, because throwing alone is not enough. `recordLeadOutboundContact`
    // catches and logs its own failures by contract (it must never fail a send), so a leak reached
    // through it would be swallowed and the create would still answer 201. A recorded leak fails
    // the whole transaction below whether or not anyone caught the throw.
    leaks.push(globalPath(model, op));
    // Printed as well, because the controller turns any throw from inside the callback into a 500:
    // without this the suite would report `expected 500 to be 201` with no cause attached.
    console.error(message);
    throw new Error(message);
  };
}

function poison(snapshot: Captured): void {
  for (const [model, ops] of snapshot) {
    const target = model === '' ? mockPrisma : mockPrisma[model];
    for (const op of Object.keys(ops)) {
      if (typeof ops[op] === 'function') target[op] = leaked(model, op);
    }
  }
}

function unpoison(snapshot: Captured): void {
  for (const [model, ops] of snapshot) {
    const target = model === '' ? mockPrisma : mockPrisma[model];
    for (const op of Object.keys(ops)) target[op] = ops[op];
  }
}

/**
 * The client handed to the callback. A distinct object from the global mock — so the controller
 * genuinely receives something it has to thread through rather than being handed back what it
 * already had — that forwards every delegate to the CAPTURED functions (which is what keeps it
 * working while the globals are poisoned), and refuses to nest. Prisma itself rejects an
 * interactive transaction opened inside another one, so a double that allowed it would let a
 * defect through that the real client would not.
 */
function transactionClient(snapshot: Captured): unknown {
  const raw = snapshot.get('') ?? {};
  return new Proxy(mockPrisma, {
    get(target, prop, receiver) {
      if (prop === '$transaction') {
        return () => {
          throw new Error(
            'manual-log-transaction: $transaction was opened INSIDE a transaction. Prisma refuses ' +
              'a nested interactive transaction; pass the `tx` you already hold instead.',
          );
        };
      }
      if (typeof prop === 'string') {
        const delegate = snapshot.get(prop);
        if (delegate) return delegate;
        if (prop in raw) return raw[prop];
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * Arm `$transaction` with real all-or-nothing semantics over `journals`, and with the leak guard
 * that tells `tx` from the global client.
 *
 * Call in `beforeEach` (or in the test itself, once the fixture arrays exist), AFTER whatever
 * clearAllMocks/resetAllMocks the suite runs — both wipe a mock's implementation state, and
 * `setup.ts` ships `$transaction` as a bare `vi.fn()` with none, so an unarmed one returns
 * `undefined` and the callback never runs at all.
 *
 * Every array passed is snapshotted before the callback and restored if it rejects.
 */
export function armAtomicTransaction(...journals: any[][]): void {
  if (!vi.isMockFunction(mockPrisma.$transaction)) {
    throw new Error(
      'manual-log-transaction: prisma.$transaction is not a mock, so nothing here is being ' +
        'controlled. setup.ts mocks the whole client — restore that.',
    );
  }
  // Arming happens outside any transaction, so anything left poisoned belongs to a callback that
  // never settled. Heal it rather than leaving the next test to fail for the previous one's sake.
  if (captured) unpoison(captured);
  captured = null;
  openTransactions = 0;

  mockPrisma.$transaction.mockImplementation(async (arg: unknown) => {
    // THE BATCH FORM IS A DEFECT HERE, not an alternative spelling. Under DB_TENANT_GUARD the
    // guard proxies every model delegate to run its own per-op transaction, so the promises
    // handed to `$transaction([...])` have already fired by the time the array is built — a
    // recorded incident. Failing loudly means the whole manual-log create suite goes red the
    // moment somebody switches forms, rather than one carefully-worded assertion somewhere.
    if (typeof arg !== 'function') {
      throw new Error(
        'manual-log-transaction: $transaction was called with an ARRAY. The manual log must use ' +
          'the INTERACTIVE form, $transaction(async (tx) => …): the batch form fires its writes ' +
          'eagerly under DB_TENANT_GUARD and 500s.',
      );
    }
    const undo = journals.map((journal) => journal.slice());
    const outermost = openTransactions === 0;
    if (outermost) {
      captured = captureClient();
      leaks = [];
      poison(captured);
    }
    const snapshot = captured as Captured;
    openTransactions += 1;
    try {
      const callback = arg as (tx: unknown) => Promise<unknown>;
      const result = await callback(transactionClient(snapshot));
      if (outermost && leaks.length > 0) {
        throw new Error(
          `manual-log-transaction: the callback resolved, but the GLOBAL prisma client was used ` +
            `inside it (${[...new Set(leaks)].join(', ')}) and something SWALLOWED the error. ` +
            'The transaction is failed here rather than committed: a second connection taken out ' +
            'of the pool deadlocks under load (P2024) whether or not the caller noticed.',
        );
      }
      return result;
    } catch (err) {
      journals.forEach((journal, i) => {
        journal.length = 0;
        journal.push(...undo[i]);
      });
      throw err;
    } finally {
      openTransactions -= 1;
      if (openTransactions === 0) {
        unpoison(snapshot);
        captured = null;
      }
    }
  });
}
