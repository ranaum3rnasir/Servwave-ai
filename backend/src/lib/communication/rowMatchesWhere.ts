/**
 * Does this loaded row satisfy this Prisma `where`? The in-memory reading of the shapes M11 (communicationScope.ts) emits,
 * so the SAME `where` that decides whether one person opens one conversation can be asked of an already-loaded
 * conversation for many people at once (the notification access filter), without a second statement of the rule.
 *
 * It answers the way the database does, nulls included: a null column is neither "different from" a value nor "outside" a
 * list, and a missing to-one relation never satisfies a condition on it. A shape it does not know is an error, not a
 * guess: the caller treats a throw as "nobody may read", so a rule that grows an operator fails closed until this reads it.
 * `permission-communication-conversation-readers-db.test.ts` runs both readings over the same fixtures and holds them equal.
 */
export type Row = Record<string, unknown>;

const OPERATORS = new Set(['not', 'in', 'notIn', 'some', 'none']);
// Prisma filters this reader does not implement. A column of the same name is not expected on any row it reads.
const UNSUPPORTED = new Set([
  'equals', 'lt', 'lte', 'gt', 'gte', 'contains', 'startsWith', 'endsWith', 'mode', 'is', 'isNot', 'every', 'has', 'hasSome', 'hasEvery', 'path',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

function list(value: unknown, key: string): Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (isPlainObject(value)) return [value];
  throw new Error(`rowMatchesWhere: ${key} needs a list of conditions`);
}

export function rowMatchesWhere(row: Row | null | undefined, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return list(cond, key).some((c) => rowMatchesWhere(row, c));
    if (key === 'AND') return list(cond, key).every((c) => rowMatchesWhere(row, c));
    if (key === 'NOT') throw new Error('rowMatchesWhere: NOT is not supported');

    const actual = row?.[key];
    if (cond === undefined) return true;
    if (cond === null) return actual === null || actual === undefined;
    if (!isPlainObject(cond)) return actual === cond;

    const keys = Object.keys(cond);
    const unsupported = keys.find((k) => UNSUPPORTED.has(k));
    if (unsupported) throw new Error(`rowMatchesWhere: ${unsupported} is not supported`);

    // A column condition: every operator in it must hold.
    if (keys.length > 0 && keys.every((k) => OPERATORS.has(k))) {
      return keys.every((k) => {
        const operand = cond[k];
        const missing = actual === null || actual === undefined;
        switch (k) {
          case 'not':
            if (operand === null) return !missing;
            return !missing && actual !== operand;
          case 'in':
            return (operand as unknown[]).includes(actual);
          case 'notIn':
            return !missing && !(operand as unknown[]).includes(actual);
          case 'some':
            return Array.isArray(actual) && actual.some((e) => rowMatchesWhere(e as Row, operand as Record<string, unknown>));
          default: // none
            return !Array.isArray(actual) || !actual.some((e) => rowMatchesWhere(e as Row, operand as Record<string, unknown>));
        }
      });
    }

    // Anything else is a to-one relation filter: a missing relation can never satisfy one.
    if (actual === null || actual === undefined) return false;
    return rowMatchesWhere(actual as Row, cond);
  });
}
