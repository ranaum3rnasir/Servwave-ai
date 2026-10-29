import { describe, it, expect } from 'vitest';
import { parseArrayParam } from '../parseArrayParam';

describe('parseArrayParam', () => {
  it('returns [] for empty', () => expect(parseArrayParam(undefined)).toEqual([]));
  it('wraps a scalar', () => expect(parseArrayParam('NEW')).toEqual(['NEW']));
  it('passes arrays through, stringified + filtered', () =>
    expect(parseArrayParam(['NEW', '', 'WON'])).toEqual(['NEW', 'WON']));
  it('splits a comma string (invoice parity)', () =>
    expect(parseArrayParam('DRAFT,SENT')).toEqual(['DRAFT', 'SENT']));
});
