import { describe, it, expect } from 'vitest';
import { formatPhone, formatPhoneInput } from '@/lib/utils';

// #352 — the single shared live input mask (moved out of CustomerFormPage).
describe('formatPhoneInput — live input mask', () => {
  it('progressively masks as the user types', () => {
    expect(formatPhoneInput('')).toBe('');
    expect(formatPhoneInput('5')).toBe('(5');
    expect(formatPhoneInput('555')).toBe('(555');
    expect(formatPhoneInput('5551')).toBe('(555) 1');
    expect(formatPhoneInput('555123')).toBe('(555) 123');
    expect(formatPhoneInput('5551234')).toBe('(555) 123-4');
    expect(formatPhoneInput('5551234567')).toBe('(555) 123-4567');
  });

  it('re-derives from digits so backspace/edits behave naturally', () => {
    // Deleting the trailing "7" of "(555) 123-4567" leaves "(555) 123-456".
    expect(formatPhoneInput('(555) 123-456')).toBe('(555) 123-456');
    // Deleting past a separator re-derives cleanly.
    expect(formatPhoneInput('(555) 123-')).toBe('(555) 123');
  });

  it('caps at 10 digits', () => {
    expect(formatPhoneInput('55512345678999')).toBe('(555) 123-4567');
  });

  it('masks an already-formatted or digits-only stored value identically (hydration)', () => {
    expect(formatPhoneInput('5551234567')).toBe('(555) 123-4567');
    expect(formatPhoneInput('(555) 123-4567')).toBe('(555) 123-4567');
  });
});

describe('formatPhone — display formatter', () => {
  it('formats 10-digit and 11-with-leading-1 values', () => {
    expect(formatPhone('5551234567')).toBe('(555) 123-4567');
    expect(formatPhone('15551234567')).toBe('(555) 123-4567');
  });

  it('returns non-phone-shaped values unchanged (graceful degradation)', () => {
    expect(formatPhone('bg-import-phone:5551234')).toBe('bg-import-phone:5551234');
    expect(formatPhone('N/A')).toBe('N/A');
    expect(formatPhone('')).toBe('');
  });

  it('is null-tolerant — customers.phone is nullable and dropdowns render it raw off the API', () => {
    // Regression guard for the review blocker: PickOrCreateCustomer/JobFormPage
    // call formatPhone(c.phone) on search results; a null-phone customer
    // (Talon import, or junk NULLed by the #352 backfill) must not crash.
    expect(formatPhone(null)).toBe('');
    expect(formatPhone(undefined)).toBe('');
  });
});
