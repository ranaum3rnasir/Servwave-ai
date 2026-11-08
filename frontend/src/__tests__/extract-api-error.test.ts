import { describe, it, expect } from 'vitest';
import { extractApiError } from '@/lib/utils';

// #112 / #107 — failures must name the offending field, not just "Validation failed".
describe('extractApiError', () => {
  it('surfaces per-field validation details over the generic error', () => {
    const err = {
      response: {
        data: {
          error: 'Validation failed',
          details: [
            { field: 'country', message: 'String must contain exactly 2 character(s)' },
            { field: 'currency', message: 'Required' },
          ],
        },
      },
    };
    const msg = extractApiError(err, 'fallback');
    expect(msg).toContain('country:');
    expect(msg).toContain('currency:');
    expect(msg).not.toBe('Validation failed');
  });

  it('falls back to the API error string when there are no details', () => {
    const err = { response: { data: { error: 'A location with that code already exists' } } };
    expect(extractApiError(err, 'fallback')).toBe('A location with that code already exists');
  });

  it('uses the fallback when nothing is extractable', () => {
    expect(extractApiError({}, 'Could not save')).toBe('Could not save');
  });
});
