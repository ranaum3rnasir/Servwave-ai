import { it } from 'vitest';

throw new Error('planted load failure');
it('never collected', () => {});
