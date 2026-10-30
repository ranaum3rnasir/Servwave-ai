import { describe, it, expect } from 'vitest';
import { formatPlace } from './place';

describe('formatPlace', () => {
  it('writes where a clock-in or clock-out happened as latitude, longitude to four places', () => {
    expect(formatPlace(30.2672, -97.7431)).toBe('30.2672, -97.7431');
    expect(formatPlace(40.7128, -74.006)).toBe('40.7128, -74.0060');
    expect(formatPlace(-33.8688, 151.2093)).toBe('-33.8688, 151.2093');
  });

  it('writes a dash when there is no place yet (a clock-out that has not happened)', () => {
    expect(formatPlace(null, null)).toBe('-');
    expect(formatPlace(30.1, null)).toBe('-');
  });
});
