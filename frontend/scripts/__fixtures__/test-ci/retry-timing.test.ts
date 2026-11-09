import { it } from 'vitest';

let attempt = 0;
// Attempt 1 takes 800 ms and fails; attempt 2 passes at once. The summary must say so per attempt.
it('slow first attempt', async () => {
  attempt += 1;
  if (attempt === 1) {
    await new Promise((r) => setTimeout(r, 800));
    throw new Error('planted first-attempt failure');
  }
});
