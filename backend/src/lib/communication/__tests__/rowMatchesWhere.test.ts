import { describe, it, expect } from 'vitest';
import { rowMatchesWhere } from '../rowMatchesWhere';

/**
 * The in-memory reading of the `where` shapes the Communication scope emits (M11), used to ask the single-read question
 * of one loaded conversation for many people at once. It answers the way the database would, nulls included.
 */

describe('rowMatchesWhere', () => {
  it('matches an equal value and refuses a different one', () => {
    expect(rowMatchesWhere({ agent_id: 'a' }, { agent_id: 'a' })).toBe(true);
    expect(rowMatchesWhere({ agent_id: 'b' }, { agent_id: 'a' })).toBe(false);
  });

  it('reads an empty condition as no restriction', () => {
    expect(rowMatchesWhere({ agent_id: 'b' }, {})).toBe(true);
  });

  it('matches a null column against null and refuses it against a value', () => {
    expect(rowMatchesWhere({ job_id: null }, { job_id: null })).toBe(true);
    expect(rowMatchesWhere({ job_id: 'j' }, { job_id: null })).toBe(false);
  });

  it('reads { in } as membership, and an empty list as nothing', () => {
    expect(rowMatchesWhere({ phone_number_id: 'n1' }, { phone_number_id: { in: ['n1', 'n2'] } })).toBe(true);
    expect(rowMatchesWhere({ phone_number_id: 'n3' }, { phone_number_id: { in: ['n1', 'n2'] } })).toBe(false);
    expect(rowMatchesWhere({ phone_number_id: null }, { phone_number_id: { in: ['n1'] } })).toBe(false);
    expect(rowMatchesWhere({ id: 'x' }, { id: { in: [] } })).toBe(false);
  });

  it('reads { not: null } as "has a value" and { not: value } as a different value, never matching a null column', () => {
    expect(rowMatchesWhere({ job_id: 'j' }, { job_id: { not: null } })).toBe(true);
    expect(rowMatchesWhere({ job_id: null }, { job_id: { not: null } })).toBe(false);
    expect(rowMatchesWhere({ origin: 'started' }, { origin: { not: 'record' } })).toBe(true);
    expect(rowMatchesWhere({ origin: 'record' }, { origin: { not: 'record' } })).toBe(false);
    // A database does not call a null column "different from" a value.
    expect(rowMatchesWhere({ origin: null }, { origin: { not: 'record' } })).toBe(false);
  });

  it('reads { notIn } as the database does: a null column is not "outside" the list', () => {
    expect(rowMatchesWhere({ record_type: 'vendor' }, { record_type: { notIn: ['job', 'lead'] } })).toBe(true);
    expect(rowMatchesWhere({ record_type: 'job' }, { record_type: { notIn: ['job', 'lead'] } })).toBe(false);
    expect(rowMatchesWhere({ record_type: null }, { record_type: { notIn: ['job', 'lead'] } })).toBe(false);
  });

  it('combines OR and AND', () => {
    const row = { a: 1, b: 2 };
    expect(rowMatchesWhere(row, { OR: [{ a: 9 }, { b: 2 }] })).toBe(true);
    expect(rowMatchesWhere(row, { OR: [{ a: 9 }, { b: 9 }] })).toBe(false);
    expect(rowMatchesWhere(row, { AND: [{ a: 1 }, { b: 2 }] })).toBe(true);
    expect(rowMatchesWhere(row, { AND: [{ a: 1 }, { b: 9 }] })).toBe(false);
    // An empty OR matches nothing, as in the database.
    expect(rowMatchesWhere(row, { OR: [] })).toBe(false);
  });

  it('follows a to-one relation, and a missing relation never satisfies a condition on it', () => {
    expect(rowMatchesWhere({ thread: { user_id: 'me' } }, { thread: { user_id: 'me' } })).toBe(true);
    expect(rowMatchesWhere({ thread: { user_id: 'x' } }, { thread: { user_id: 'me' } })).toBe(false);
    expect(rowMatchesWhere({ thread: null }, { thread: { user_id: 'me' } })).toBe(false);
    expect(rowMatchesWhere({}, { thread: { user_id: 'me' } })).toBe(false);
  });

  it('follows a to-many relation with some and none', () => {
    const row = { emails: [{ sent_by_user_id: 'me' }, { sent_by_user_id: null }] };
    expect(rowMatchesWhere(row, { emails: { some: { sent_by_user_id: 'me' } } })).toBe(true);
    expect(rowMatchesWhere(row, { emails: { some: { sent_by_user_id: 'you' } } })).toBe(false);
    expect(rowMatchesWhere(row, { emails: { none: { sent_by_user_id: 'you' } } })).toBe(true);
    expect(rowMatchesWhere(row, { emails: { none: { sent_by_user_id: 'me' } } })).toBe(false);
    expect(rowMatchesWhere({ emails: [] }, { emails: { some: {} } })).toBe(false);
  });

  it('refuses a shape it does not know instead of guessing (the caller then drops everyone)', () => {
    expect(() => rowMatchesWhere({ a: 'x' }, { a: { contains: 'x' } })).toThrow(/contains/);
    expect(() => rowMatchesWhere({ a: 1 }, { NOT: { a: 1 } })).toThrow(/NOT/);
  });
});
