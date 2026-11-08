import { describe, it, expect } from 'vitest'
import { computeLayout } from '@/components/data/table-flex'

// Helper to build a minimal column
const col = (
  id: string,
  width: number,
  minWidth: number,
  opts: {
    growWeight?: number
    visible?: boolean
    manuallySized?: boolean
    fixed?: boolean
    pinned?: boolean
    locked?: boolean
  } = {}
) => ({
  id,
  width,
  minWidth,
  growWeight: opts.growWeight,
  visible: opts.visible ?? true,
  manuallySized: opts.manuallySized ?? false,
  fixed: opts.fixed ?? false,
  pinned: opts.pinned ?? false,
  locked: opts.locked ?? false,
})

describe('computeLayout', () => {
  // Test 1: Surplus distributed to growable columns by weight
  it('distributes surplus to growable columns by weight', () => {
    const columns = [
      col('fixed', 100, 50, { fixed: true }),
      col('grow1', 150, 50, { growWeight: 1 }),
      col('grow2', 150, 50, { growWeight: 2 }),
    ]
    const result = computeLayout({ containerWidth: 600, columns })
    // Total base = 400, surplus = 200, distributed 1:2
    // grow1 gets 200 * (1/3) ≈ 66.67 → 150 + 66.67 ≈ 216.67
    // grow2 gets 200 * (2/3) ≈ 133.33 → 150 + 133.33 ≈ 283.33
    expect(result.widths['fixed']).toBe(100)
    expect(result.widths['grow1']).toBeCloseTo(216.67, 0)
    expect(result.widths['grow2']).toBeCloseTo(283.33, 0)
    expect(result.scrolls).toBe(false)
  })

  // Test 2: Growable columns fall to minWidth, scrolls=true when still over container
  it('sets scrolls=true when content exceeds container even at minWidth', () => {
    const columns = [
      col('fixed', 300, 300, { fixed: true }),
      col('grow1', 200, 100, { growWeight: 1 }),
      col('grow2', 200, 100, { growWeight: 1 }),
    ]
    // Total at minWidth = 300 + 100 + 100 = 500 > 400
    const result = computeLayout({ containerWidth: 400, columns })
    expect(result.widths['grow1']).toBe(100)
    expect(result.widths['grow2']).toBe(100)
    expect(result.scrolls).toBe(true)
  })

  // Test 3: Hidden columns excluded from widths and offsets
  it('excludes hidden columns from widths and stickyOffsets', () => {
    const columns = [
      col('visible', 100, 50, { growWeight: 1 }),
      col('hidden', 100, 50, { visible: false }),
    ]
    const result = computeLayout({ containerWidth: 300, columns })
    expect('hidden' in result.widths).toBe(false)
    expect('hidden' in result.stickyOffsets).toBe(false)
  })

  // Test 4: manuallySized columns don't grow
  it('treats manuallySized columns as fixed even when growWeight > 0', () => {
    const columns = [
      col('manual', 150, 50, { growWeight: 1, manuallySized: true }),
      col('grow', 150, 50, { growWeight: 1 }),
    ]
    // Total = 300, container = 600, surplus = 300
    // manual is manuallySized so treated as fixed → grow gets all 300
    const result = computeLayout({ containerWidth: 600, columns })
    expect(result.widths['manual']).toBe(150)
    expect(result.widths['grow']).toBe(450)
    expect(result.scrolls).toBe(false)
  })

  // Test 5: No dead space fallback — identity column absorbs remainder
  it('identity column absorbs surplus when no growable columns exist', () => {
    const columns = [
      col('locked', 100, 50, { fixed: true, locked: true }),
      col('fixed2', 100, 50, { fixed: true }),
    ]
    // Total = 200, container = 500, surplus = 300
    // No growable columns → identity (locked) absorbs 300
    const result = computeLayout({ containerWidth: 500, columns })
    expect(result.widths['locked']).toBe(400)
    expect(result.widths['fixed2']).toBe(100)
    expect(result.scrolls).toBe(false)
  })

  // Test 5b: No dead space fallback — falls back to first visible if no locked
  it('first visible column absorbs surplus when no growable and no locked columns', () => {
    const columns = [
      col('first', 100, 50, { fixed: true }),
      col('second', 100, 50, { fixed: true }),
    ]
    const result = computeLayout({ containerWidth: 400, columns })
    expect(result.widths['first']).toBe(300)
    expect(result.widths['second']).toBe(100)
    expect(result.scrolls).toBe(false)
  })

  // Test 5c (data-table.tsx's opt-in '__select' checkbox column, R7 bulk-delete): the identity
  // fallback is found by `visible.find(c => c.locked)`, which returns the FIRST match in array
  // order. '__select' is always prepended first (data-table.tsx's effectiveColumns), so if it were
  // ever marked `locked` it would win this search ahead of the page's real identity column (e.g.
  // Estimates' 'customer') the moment every growable column gets manually resized — a 40px
  // checkbox column absorbing the entire surplus. '__select' is deliberately NOT locked for this
  // exact reason (see data-table.tsx's selectColumn comment); this pins that its absence of
  // `locked` is what lets the real identity column (still locked, just no longer growable once
  // manuallySized) win instead — mirrors EstimatesPage's actual column shape (select, customer,
  // ...fixed columns) with every growable column manually resized.
  it('a leading fixed+pinned-but-not-locked column (mirrors the __select checkbox column) does not steal the surplus from the real locked identity column once all growable columns are manually resized', () => {
    const columns = [
      col('__select', 40, 40, { fixed: true, pinned: true }), // NOT locked
      col('customer', 200, 140, { locked: true, pinned: true, manuallySized: true }), // was growWeight:2, now manually resized
      col('status', 110, 90, { fixed: true }),
    ]
    // Total base = 350, container = 900, surplus = 550 — no growable columns (customer's
    // manuallySized excludes it from isGrowable) → falls to the `visible.find(c => c.locked)`
    // branch. 'customer' must absorb it, not '__select'.
    const result = computeLayout({ containerWidth: 900, columns })
    expect(result.widths['__select']).toBe(40)
    expect(result.widths['customer']).toBe(750)
    expect(result.widths['status']).toBe(110)
    expect(result.scrolls).toBe(false)
  })

  // Test 6: Sticky left offsets for pinned columns
  it('computes sticky left offsets for pinned columns', () => {
    const columns = [
      col('pin1', 100, 50, { pinned: true, fixed: true }),
      col('pin2', 80, 40, { pinned: true, fixed: true }),
      col('normal', 200, 100, { growWeight: 1 }),
    ]
    const result = computeLayout({ containerWidth: 600, columns })
    expect(result.stickyOffsets['pin1']).toBe(0)
    expect(result.stickyOffsets['pin2']).toBe(100)
    expect('normal' in result.stickyOffsets).toBe(false)
  })

  // Test 8 (#454 root cause at the pure-function boundary):
  // The clip appears only because the desktop table phantom-overflows its scroll
  // box. That happens when DataTable measures the OUTER wrapper's offsetWidth
  // (2-17px larger than the inner scroll container's clientWidth content box) and
  // feeds that inflated width here: the growable columns fill to the inflated
  // width, so the resolved widths SUM WIDER than the real box → scrollLeft > 0 →
  // the opaque sticky column paints over its neighbor's left edge. Measuring the
  // true clientWidth (the fix) keeps the sum within the real box.
  it('resolved widths never exceed the true content-box width, but an inflated (offsetWidth-style) width overflows it (#454)', () => {
    // Mirrors the Leads column set: pinned customer + fixed phone + a growable body column.
    const columns = [
      col('customer', 170, 140, { pinned: true, locked: true, growWeight: 1.5 }),
      col('phone', 140, 80, { fixed: true }),
      col('status', 140, 100, { growWeight: 1 }),
    ]
    const trueBox = 1000 // scroll container's real clientWidth

    // Fix: measuring the true clientWidth → columns fill exactly the box, no overflow.
    const correct = computeLayout({ containerWidth: trueBox, columns })
    const correctSum = Object.values(correct.widths).reduce((a, b) => a + b, 0)
    expect(correctSum).toBeCloseTo(trueBox, 5)
    expect(correctSum).toBeLessThanOrEqual(trueBox)
    expect(correct.scrolls).toBe(false)

    // Bug: measuring the outer wrapper's offsetWidth (larger by the border box +
    // scrollbar gutter, e.g. +17px) makes the resolved widths sum WIDER than the
    // real box — the phantom overflow that lets the sticky column clip its
    // neighbor. computeLayout still reports scrolls:false because it fits the
    // (wrong) inflated width; the overflow only manifests in the real box.
    const inflated = computeLayout({ containerWidth: trueBox + 17, columns })
    const inflatedSum = Object.values(inflated.widths).reduce((a, b) => a + b, 0)
    expect(inflatedSum).toBeCloseTo(trueBox + 17, 5)
    expect(inflatedSum).toBeGreaterThan(trueBox)
  })

  // Test 7: Sticky + growable interaction
  it('computes sticky offset from resolved (grown) width when column is pinned and growable', () => {
    const columns = [
      col('pin_grow', 100, 50, { pinned: true, growWeight: 1 }),
      col('pin_fixed', 80, 40, { pinned: true, fixed: true }),
      col('normal', 200, 100),
    ]
    // Total base = 380, container = 600, surplus = 220
    // Only pin_grow is growable → gets all 220 → resolved width = 320
    // pin_fixed offset should be 320 (based on resolved width of pin_grow)
    const result = computeLayout({ containerWidth: 600, columns })
    expect(result.widths['pin_grow']).toBe(320)
    expect(result.stickyOffsets['pin_grow']).toBe(0)
    expect(result.stickyOffsets['pin_fixed']).toBe(320)
  })
})
