import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import {
  resolveWatcherPool,
  resolveWatcherPoolForRequest,
  watcherPoolWhere,
  isWatcherPermitted,
  isWatcherSetPermitted,
  type WatcherCandidate,
} from '../watcherPool';
import { defineAbilityFor, type Grant } from '../defineAbility';

// Task watcher pool (#1956) — the resolver's unit suite.
//
// Every case drives the REAL `defineAbilityFor`, for the same reason the assigneePool suite
// does: a hand-written ability literal would pass against a resolver that read a role name,
// and "reads the ability, not the role" is the whole claim of this module.
//
// These tests assert what a caller OBSERVES — the scope returned, the rows a fragment would
// match, the verdict on a candidate — and never how the clauses are assembled internally.

const READ_LEAD: Grant = { action: 'read', subject: 'Lead' };

const DEPT_A = 'dept-aaaa';
const DEPT_B = 'dept-bbbb';

const user = (
  id: string,
  role: WatcherCandidate['role'],
  department_id: string | null = null,
): WatcherCandidate => ({ id, role, department_id });

describe('resolveWatcherPool — the ability, not the role name', () => {
  it('an ADMIN resolves org-wide through the manage-all short-circuit, holding no explicit grant', () => {
    const ability = defineAbilityFor({ id: 'admin-1', role: 'ADMIN' }, []);
    expect(resolveWatcherPool(ability, 'admin-1', DEPT_A)).toEqual({ scope: 'org' });
  });

  it('an ADMIN with NO department stays org-wide — an unset department must not restrict the unrestricted role', () => {
    const ability = defineAbilityFor({ id: 'admin-2', role: 'ADMIN' }, []);
    expect(resolveWatcherPool(ability, 'admin-2', null)).toEqual({ scope: 'org' });
  });

  it('SALES resolves to the cohort, carrying THEIR id and THEIR department', () => {
    const ability = defineAbilityFor({ id: 'sales-7', role: 'SALES' }, [READ_LEAD]);
    expect(resolveWatcherPool(ability, 'sales-7', DEPT_A)).toEqual({
      scope: 'cohort',
      userId: 'sales-7',
      departmentId: DEPT_A,
    });
  });

  it('a departmentless actor normalises to a null department rather than undefined', () => {
    const ability = defineAbilityFor({ id: 'sales-8', role: 'SALES' }, [READ_LEAD]);
    expect(resolveWatcherPool(ability, 'sales-8', undefined)).toEqual({
      scope: 'cohort',
      userId: 'sales-8',
      departmentId: null,
    });
  });

  it('an ADMIN-DERIVED custom role does NOT short-circuit — it holds base_role ADMIN but not `manage all`', () => {
    // The case a `role === "ADMIN"` check gets wrong. Such a role carries base_role ADMIN plus
    // an explicit, deliberately-subtracted grant set; treating it as a superuser here would
    // silently hand it the org-wide pool its grant set was written to withhold.
    const ability = defineAbilityFor(
      { id: 'cust-1', role: 'ADMIN', custom_role_id: 'cr-minus-payroll' },
      [READ_LEAD],
    );
    expect(resolveWatcherPool(ability, 'cust-1', DEPT_A)).toEqual({
      scope: 'cohort',
      userId: 'cust-1',
      departmentId: DEPT_A,
    });
  });

  it('fails CLOSED to the cohort when no ability is attached', () => {
    expect(resolveWatcherPool(undefined, 'nobody', DEPT_A)).toEqual({
      scope: 'cohort',
      userId: 'nobody',
      departmentId: DEPT_A,
    });
  });

  it('resolveWatcherPoolForRequest reads id and department off the session', () => {
    const ability = defineAbilityFor({ id: 'tech-3', role: 'TECHNICIAN' }, []);
    const req = { ability, user: { id: 'tech-3', department_id: DEPT_B } } as unknown as Request;
    expect(resolveWatcherPoolForRequest(req)).toEqual({
      scope: 'cohort',
      userId: 'tech-3',
      departmentId: DEPT_B,
    });
  });

  it('an absent session fails closed to a cohort that permits nobody but the empty set', () => {
    const req = {} as Request;
    const pool = resolveWatcherPoolForRequest(req);
    expect(pool).toEqual({ scope: 'cohort', userId: '', departmentId: null });
    expect(isWatcherSetPermitted(pool, [])).toBe(true);
    expect(isWatcherPermitted(pool, user('anyone', 'SALES', DEPT_A))).toBe(false);
  });
});

describe('isWatcherPermitted — the three clauses', () => {
  const pool = resolveWatcherPool(
    defineAbilityFor({ id: 'me', role: 'SALES' }, [READ_LEAD]),
    'me',
    DEPT_A,
  );

  it('permits the actor themselves', () => {
    expect(isWatcherPermitted(pool, user('me', 'SALES', DEPT_A))).toBe(true);
  });

  it('permits the actor even if their own row somehow carries another department', () => {
    // The id clause stands alone; it must not depend on the department agreeing.
    expect(isWatcherPermitted(pool, user('me', 'SALES', DEPT_B))).toBe(true);
  });

  it('permits an ADMIN from any department, and one with none', () => {
    expect(isWatcherPermitted(pool, user('admin-x', 'ADMIN', DEPT_B))).toBe(true);
    expect(isWatcherPermitted(pool, user('admin-y', 'ADMIN', null))).toBe(true);
  });

  it('permits a colleague sharing the department, whatever their role', () => {
    expect(isWatcherPermitted(pool, user('mate', 'TECHNICIAN', DEPT_A))).toBe(true);
    expect(isWatcherPermitted(pool, user('disp', 'DISPATCHER', DEPT_A))).toBe(true);
  });

  it('REFUSES a non-admin in another department', () => {
    expect(isWatcherPermitted(pool, user('stranger', 'SALES', DEPT_B))).toBe(false);
  });

  it('REFUSES a non-admin with no department at all', () => {
    expect(isWatcherPermitted(pool, user('loner', 'TECHNICIAN', null))).toBe(false);
  });
});

describe('isWatcherPermitted — a null department is not a department', () => {
  const pool = resolveWatcherPool(
    defineAbilityFor({ id: 'me', role: 'SALES' }, [READ_LEAD]),
    'me',
    null,
  );

  it('still permits the actor and every admin', () => {
    expect(isWatcherPermitted(pool, user('me', 'SALES', null))).toBe(true);
    expect(isWatcherPermitted(pool, user('admin-x', 'ADMIN', DEPT_A))).toBe(true);
  });

  it('does NOT group the actor with other department-less users', () => {
    // The regression this guards: omitting the clause vs. emitting `department_id: null`.
    expect(isWatcherPermitted(pool, user('other-loner', 'SALES', null))).toBe(false);
  });
});

describe('an org-scoped pool permits everyone', () => {
  const pool = resolveWatcherPool(defineAbilityFor({ id: 'admin-1', role: 'ADMIN' }, []), 'admin-1', null);

  it('permits a stranger in another department', () => {
    expect(isWatcherPermitted(pool, user('stranger', 'TECHNICIAN', DEPT_B))).toBe(true);
  });

  it('narrows nothing in the query fragment', () => {
    expect(watcherPoolWhere(pool)).toEqual({});
  });
});

describe('watcherPoolWhere — the read side, derived from the same clauses', () => {
  it('nests under AND so it cannot clobber an OR the caller already set', () => {
    // The roster`s `where` may already carry an OR (include_referenced_in). A bare `OR` here
    // would overwrite it and silently widen the roster.
    const pool = resolveWatcherPool(
      defineAbilityFor({ id: 'me', role: 'SALES' }, [READ_LEAD]),
      'me',
      DEPT_A,
    );
    expect(watcherPoolWhere(pool)).toEqual({
      AND: [{ OR: [{ id: 'me' }, { role: 'ADMIN' }, { department_id: DEPT_A }] }],
    });
  });

  it('omits the department clause entirely when the actor has none', () => {
    const pool = resolveWatcherPool(
      defineAbilityFor({ id: 'me', role: 'SALES' }, [READ_LEAD]),
      'me',
      null,
    );
    expect(watcherPoolWhere(pool)).toEqual({
      AND: [{ OR: [{ id: 'me' }, { role: 'ADMIN' }] }],
    });
  });

  it('the fragment and the predicate agree on the same people — the drift this module exists to stop', () => {
    // The read and the write must answer identically. Asserted by running both over one cast
    // and comparing the sets, so a clause added to one and not the other fails here.
    const pool = resolveWatcherPool(
      defineAbilityFor({ id: 'me', role: 'SALES' }, [READ_LEAD]),
      'me',
      DEPT_A,
    );
    const cast: WatcherCandidate[] = [
      user('me', 'SALES', DEPT_A),
      user('admin-x', 'ADMIN', DEPT_B),
      user('mate', 'TECHNICIAN', DEPT_A),
      user('stranger', 'SALES', DEPT_B),
      user('loner', 'SALES', null),
    ];
    const where = watcherPoolWhere(pool) as { AND: [{ OR: Record<string, string>[] }] };
    // Evaluate the Prisma fragment by hand: a row matches when it satisfies ANY clause, and a
    // clause when every key on it equals the row's value. That is what Postgres will do with it.
    const matchesFragment = (c: WatcherCandidate) =>
      where.AND[0].OR.some((clause) =>
        Object.entries(clause).every(
          ([key, value]) => (c as unknown as Record<string, unknown>)[key] === value,
        ),
      );
    const byFragment = cast.filter(matchesFragment).map((c) => c.id);
    const byPredicate = cast.filter((c) => isWatcherPermitted(pool, c)).map((c) => c.id);
    expect(byFragment).toEqual(byPredicate);
    expect(byPredicate).toEqual(['me', 'admin-x', 'mate']);
  });
});

describe('isWatcherSetPermitted — the set form the controllers call', () => {
  const pool = resolveWatcherPool(
    defineAbilityFor({ id: 'me', role: 'SALES' }, [READ_LEAD]),
    'me',
    DEPT_A,
  );

  it('permits the empty set — removing every watcher is a legitimate edit', () => {
    expect(isWatcherSetPermitted(pool, [])).toBe(true);
  });

  it('permits a set drawn entirely from the pool', () => {
    expect(isWatcherSetPermitted(pool, [
      user('me', 'SALES', DEPT_A),
      user('admin-x', 'ADMIN', DEPT_B),
      user('mate', 'TECHNICIAN', DEPT_A),
    ])).toBe(true);
  });

  it('refuses the whole set when ONE member is outside it', () => {
    expect(isWatcherSetPermitted(pool, [
      user('admin-x', 'ADMIN', DEPT_B),
      user('stranger', 'SALES', DEPT_B),
    ])).toBe(false);
  });
});
