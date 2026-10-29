import { describe, it, expect } from 'vitest';
import { isPlaceholderEmail, isPlaceholderPhone } from '../lib/placeholders';

describe('isPlaceholderEmail', () => {
  it('detects @placeholder.local domain', () => {
    expect(isPlaceholderEmail('x@placeholder.local')).toBe(true);
  });

  it('detects bg-import-v2 prefixed placeholder', () => {
    expect(isPlaceholderEmail('bg-import-v2-abc@placeholder.local')).toBe(true);
  });

  it('returns false for real email', () => {
    expect(isPlaceholderEmail('john@example.com')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isPlaceholderEmail('')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isPlaceholderEmail(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isPlaceholderEmail(undefined)).toBe(false);
  });
});

describe('isPlaceholderPhone', () => {
  it('detects bg-import-phone: prefix', () => {
    expect(isPlaceholderPhone('bg-import-phone:5551234')).toBe(true);
  });

  it('detects (000) 000-0000 sentinel', () => {
    expect(isPlaceholderPhone('(000) 000-0000')).toBe(true);
  });

  it('returns false for real phone number', () => {
    expect(isPlaceholderPhone('617-555-1234')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isPlaceholderPhone('')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isPlaceholderPhone(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isPlaceholderPhone(undefined)).toBe(false);
  });
});
