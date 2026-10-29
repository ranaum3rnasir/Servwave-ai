import { describe, it, expect } from 'vitest';
import { emailSchema } from '../lib/email-schema';

describe('emailSchema (canonical email input gate)', () => {
  it('lowercases mixed-case input', () => {
    expect(emailSchema.parse('Sagiv@AlphaSecurityUS.com')).toBe('sagiv@alphasecurityus.com');
  });

  it('trims surrounding whitespace then lowercases', () => {
    expect(emailSchema.parse('  Hazal@Alpha.COM ')).toBe('hazal@alpha.com');
  });

  it('leaves an already-normalized email unchanged', () => {
    expect(emailSchema.parse('emanuel@alphasecurityus.com')).toBe('emanuel@alphasecurityus.com');
  });

  it('rejects a non-email', () => {
    expect(() => emailSchema.parse('not-an-email')).toThrow();
  });
});
