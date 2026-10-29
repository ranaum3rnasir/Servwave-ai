import { describe, it, expect, vi, beforeAll } from 'vitest';
import { allocateNumber } from '../lib/numbering';

// The global setup.ts mocks '../lib/numbering'. Bypass it here so we test the REAL allocator.
let realAllocateNumber: (typeof import('../lib/numbering'))['allocateNumber'];
beforeAll(async () => {
  const real = await vi.importActual<typeof import('../lib/numbering')>('../lib/numbering');
  realAllocateNumber = real.allocateNumber;
});

describe('allocateNumber — service_plan', () => {
  it('formats SP00001 from a post-increment row', async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ next_value: 2, prefix: 'SP', padding: 5 }]),
    } as never;
    const result = await realAllocateNumber(tx, 'service_plan', '00000000-0000-0000-0000-000000000001');
    expect(result).toBe('SP00001');
    expect((tx as { $queryRaw: ReturnType<typeof vi.fn> }).$queryRaw).toHaveBeenCalledOnce();
  });
});
