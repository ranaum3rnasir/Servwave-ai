import { beforeAll, describe, expect, it } from 'vitest';

describe('suite with a throwing setup', () => {
  beforeAll(() => {
    throw new Error('planted beforeAll failure');
  });
  it('never runs', () => expect(1).toBe(1));
  it('also never runs', () => expect(1).toBe(1));
});
