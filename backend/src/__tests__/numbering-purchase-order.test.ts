import { describe, it, expect, vi, beforeAll } from 'vitest';

// The global setup.ts mocks '../lib/numbering'. Bypass it here so we test the REAL allocator.
let realAllocateNumber: (typeof import('../lib/numbering'))['allocateNumber'];
beforeAll(async () => {
  const real = await vi.importActual<typeof import('../lib/numbering')>('../lib/numbering');
  realAllocateNumber = real.allocateNumber;
});

describe('allocateNumber — purchase_order', () => {
  it('formats PO-00001 from a post-increment row', async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ next_value: 2, prefix: 'PO-', padding: 5 }]),
    } as never;
    const result = await realAllocateNumber(tx, 'purchase_order', '00000000-0000-0000-0000-000000000001');
    expect(result).toBe('PO-00001');
    expect((tx as { $queryRaw: ReturnType<typeof vi.fn> }).$queryRaw).toHaveBeenCalledOnce();
  });

  it('continues after self-heal past client-generated PO-2275-style rows (PO-02275)', async () => {
    // allocateNumber's trailing-digit MAX subquery advances the counter past existing
    // rows; next_value=2276 means the allocated number is 2275, padded to org padding.
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ next_value: 2276, prefix: 'PO-', padding: 5 }]),
    } as never;
    const result = await realAllocateNumber(tx, 'purchase_order', '00000000-0000-0000-0000-000000000001');
    expect(result).toBe('PO-02275');
  });

  it('throws when org not found', async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([]) } as never;
    await expect(
      realAllocateNumber(tx, 'purchase_order', '99999999-9999-9999-9999-999999999999'),
    ).rejects.toThrow(/not found/);
  });
});
