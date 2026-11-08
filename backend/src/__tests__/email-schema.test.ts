import { describe, it, expect } from 'vitest';
import { emailSchema } from '../lib/email-schema';

describe('emailSchema (canonical email input gate)', () => {
  it('lowercases mixed-case input', () => {
    expect(emailSchema.parse('Sagiv@Northwind.Example.com')).toBe('sagiv@northwind.example.com');
  });

  it('trims surrounding whitespace then lowercases', () => {
    expect(emailSchema.parse('  Hazal@Alpha.COM ')).toBe('hazal@alpha.com');
  });

  it('leaves an already-normalized email unchanged', () => {
    expect(emailSchema.parse('emanuel@northwind.example.com')).toBe('emanuel@northwind.example.com');
  });

  it('rejects a non-email', () => {
    expect(() => emailSchema.parse('not-an-email')).toThrow();
  });
});
