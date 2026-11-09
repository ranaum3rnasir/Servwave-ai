import { expect, it } from 'vitest';

// Planted for the brake drill (#3254): a test that always takes 3 seconds of real time.
it('takes three seconds', async () => {
  await new Promise((r) => setTimeout(r, 3000));
  expect(1).toBe(1);
});
