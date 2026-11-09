import { expect, it } from 'vitest';

// Planted for the brake drill (#3254): slow in the main run, fast when re-run alone (the command sets
// TEST_CI_BRAKE_RERUN for the lone re-run), like a test that was only slow because the machine was busy.
it('is slow only under load', async () => {
  if (!process.env.TEST_CI_BRAKE_RERUN) await new Promise((r) => setTimeout(r, 3000));
  expect(1).toBe(1);
});
