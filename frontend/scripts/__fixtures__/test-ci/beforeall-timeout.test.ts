import { beforeAll, describe, expect, it } from 'vitest';

describe('suite with a hanging setup', () => {
  beforeAll(() => new Promise(() => {}), 300);
  it('never runs', () => expect(1).toBe(1));
});
