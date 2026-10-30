/* A non-holder naming more records than a bulk route accepts is refused without one lookup per id. */
import { describe, it, expect, vi } from 'vitest';

const { creatorCanOpen } = vi.hoisted(() => ({ creatorCanOpen: vi.fn(async () => true) }));
vi.mock('../lib/permissions/creatorRule', () => ({
  creatorCanOpen,
  creatorRuleOpens: () => true,
}));

import { canDoOrCreator } from '../middleware/canGuard';

function run(ids: unknown) {
  const req = { ability: { can: () => false }, user: { id: 'u1' }, body: { ids } } as never;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  const next = vi.fn();
  return canDoOrCreator('delete', 'Estimate', (r) => (r as { body: { ids: unknown } }).body.ids)(req, res as never, next)
    .then(() => ({ res, next }));
}

describe('canDoOrCreator on a bulk list', () => {
  it('passes a list within the bulk limit when every record is the creator\'s', async () => {
    creatorCanOpen.mockClear();
    const { next } = await run(Array.from({ length: 100 }, (_, i) => `id-${i}`));
    expect(next).toHaveBeenCalledWith();
    expect(creatorCanOpen).toHaveBeenCalledTimes(100);
  });

  it('refuses a list longer than the bulk limit without looking any record up', async () => {
    creatorCanOpen.mockClear();
    const { res, next } = await run(Array.from({ length: 101 }, (_, i) => `id-${i}`));
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    expect(creatorCanOpen).not.toHaveBeenCalled();
  });
});
