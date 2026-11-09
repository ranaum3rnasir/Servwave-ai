import { expect, it } from 'vitest';

// Excluded by vitest.config.mjs: it is expected but never reports.
it('never runs', () => expect(true).toBe(true));
