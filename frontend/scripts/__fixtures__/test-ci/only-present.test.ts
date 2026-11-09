import { expect, it } from 'vitest';

it('planted only', () => expect(1).toBe(1));
it.only('the only one', () => expect(1).toBe(1));
