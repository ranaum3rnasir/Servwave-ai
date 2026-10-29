import { describe, it, expect } from 'vitest';
import { customerSchema } from './customerSchema';

// Text length limits (2026-10-14): customer notes take 20,000 characters, like every other note.
describe('customerSchema notes', () => {
  const notesIssues = (notes: string) => {
    const r = customerSchema.safeParse({ first_name: 'A', notes });
    return r.success ? [] : r.error.issues.filter((i) => i.path.join('.') === 'notes').map((i) => i.message);
  };

  it('accepts 20,000 characters', () => {
    expect(notesIssues('x'.repeat(20_000))).toEqual([]);
  });

  it('refuses 20,001 with the readable message', () => {
    expect(notesIssues('x'.repeat(20_001))).toEqual(['Too long (maximum 20,000 characters)']);
  });
});
