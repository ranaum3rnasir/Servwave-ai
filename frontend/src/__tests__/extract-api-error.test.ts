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

// Text length limits (2026-10-14): the server already names the field in readable words, so the
// raw `service_request:` prefix in front of it would only repeat it in code form.
describe('extractApiError - a message that already names its field', () => {
  const withDetails = (details: Array<{ field?: string; message?: string }>) => ({
    response: { data: { error: 'Validation failed', details } },
  });

  it('is shown without the field prefix', () => {
    const err = withDetails([
      { field: 'service_request', message: 'Service request is too long (maximum 20,000 characters)' },
    ]);
    expect(extractApiError(err, 'fallback')).toBe('Service request is too long (maximum 20,000 characters)');
  });

  it('matches the label on the last path segment, camelCase included', () => {
    const err = withDetails([
      { field: 'lines.0.reviewComment', message: 'Review comment is too long (maximum 20,000 characters)' },
    ]);
    expect(extractApiError(err, 'fallback')).toBe('Review comment is too long (maximum 20,000 characters)');
  });

  it('keeps the prefix on an ordinary detail', () => {
    expect(extractApiError(withDetails([{ field: 'currency', message: 'Required' }]), 'fallback')).toBe('currency: Required');
  });
});
