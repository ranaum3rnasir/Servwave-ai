import { describe, it, expect } from 'vitest';
import { splitFullName } from '@/components/crm/PickOrCreateCustomer';

describe('splitFullName (#435 last-space rule)', () => {
  it('splits a multi-word name on the last space', () => {
    expect(splitFullName('John Veise Alvarez')).toEqual({
      first_name: 'John Veise',
      last_name: 'Alvarez',
    });
  });

  it('leaves a single word untouched with an empty last name', () => {
    expect(splitFullName('Alvarez')).toEqual({
      first_name: 'Alvarez',
      last_name: '',
    });
  });

  it('splits on the LAST space for multi-space names', () => {
    expect(splitFullName('a b c d')).toEqual({
      first_name: 'a b c',
      last_name: 'd',
    });
  });

  it('trims leading/trailing whitespace from both parts', () => {
    expect(splitFullName('  John Alvarez  ')).toEqual({
      first_name: 'John',
      last_name: 'Alvarez',
    });
  });

  it('is a no-op for an empty string', () => {
    expect(splitFullName('')).toEqual({ first_name: '', last_name: '' });
  });

  it('is a no-op for a whitespace-only string', () => {
    expect(splitFullName('   ')).toEqual({ first_name: '', last_name: '' });
  });
});
