/**
 * The lane setup (spec #3234, "Lanes"): which database a worker gets, and that a worker with no lane fails loudly.
 * Pure: the behaviour against a real server is in db-lane-setup-db.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { laneDatabaseUrl } from './db-lane-setup';

const BASE = 'postgresql://runner@127.0.0.1:24500';

describe('laneDatabaseUrl', () => {
  it('gives worker N the database lane_N on the lane server', () => {
    expect(laneDatabaseUrl(BASE, '1', 6)).toBe(`${BASE}/lane_1`);
    expect(laneDatabaseUrl(BASE, '6', 6)).toBe(`${BASE}/lane_6`);
  });

  it('carries no connection-limit parameter, so the one-connection suites keep proving what they prove', () => {
    for (let id = 1; id <= 6; id++) expect(laneDatabaseUrl(BASE, String(id), 6)).not.toMatch(/connection_limit|\?/);
  });

  it('does nothing when lanes were not requested: a hand-set TEST_DATABASE_URL keeps working', () => {
    expect(laneDatabaseUrl(undefined, undefined, 6)).toBeUndefined();
    expect(laneDatabaseUrl('', '3', 6)).toBeUndefined();
  });

  it('throws, never skips, when lanes were requested and the worker id is missing', () => {
    expect(() => laneDatabaseUrl(BASE, undefined, 6)).toThrow('db lanes: VITEST_POOL_ID is not set');
    expect(() => laneDatabaseUrl(BASE, '', 6)).toThrow('db lanes: VITEST_POOL_ID is not set');
  });

  it('throws when the worker id is outside the lanes or not a whole number', () => {
    for (const id of ['0', '7', '-1', '1.5', 'abc']) expect(() => laneDatabaseUrl(BASE, id, 6), id).toThrow(/^db lanes: worker .* has no lane/);
  });
});
