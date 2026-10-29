import { describe, expect, it } from 'vitest';

import { filterPlacement, FILTER_CONTENT_HEIGHT, type PlacementRect } from '@/ui-kit/lib/filterPlacement';

const rect = (top: number, left = 16, width = 90, height = 36): PlacementRect => ({
  top, left, width, height, bottom: top + height, right: left + width,
});

/** Where the panel lands: below the anchor or above it, `gap` apart, `maxHeight` tall at most. */
function panelBox(
  p: ReturnType<typeof filterPlacement>,
  anchor: PlacementRect,
  contentHeight: number,
  gap = 6,
) {
  const h = Math.min(contentHeight, p.maxHeight);
  return p.side === 'bottom'
    ? { top: anchor.bottom + gap, bottom: anchor.bottom + gap + h }
    : { top: anchor.top - gap - h, bottom: anchor.top - gap };
}

describe('filterPlacement', () => {
  it('is a sheet below md, never a popover, and never taller than the screen', () => {
    // The measured case: iPhone SE. The old popover's top landed at -155.
    const anchor = rect(250);
    const p = filterPlacement({ viewport: { width: 320, height: 568 }, anchor, contentHeight: FILTER_CONTENT_HEIGHT });
    expect(p.presentation).toBe('sheet');
    expect(p.side).toBe('bottom');
    expect(p.maxHeight).toBeGreaterThan(0);
    expect(p.maxHeight).toBeLessThanOrEqual(568);
  });

  it('is a sheet on a phone held sideways (md wide, but short)', () => {
    const p = filterPlacement({ viewport: { width: 838, height: 390 }, anchor: rect(120), contentHeight: FILTER_CONTENT_HEIGHT });
    expect(p.presentation).toBe('sheet');
    expect(p.maxHeight).toBeLessThanOrEqual(390);
  });

  it('is a popover at md and up, and stays inside a 720 px tall window', () => {
    // The measured case: the old panel's bottom landed at 812 in a 720 px window.
    for (const top of [60, 300, 640, 684]) {
      const anchor = rect(top);
      const p = filterPlacement({ viewport: { width: 1280, height: 720 }, anchor, contentHeight: FILTER_CONTENT_HEIGHT });
      expect(p.presentation).toBe('popover');
      const box = panelBox(p, anchor, FILTER_CONTENT_HEIGHT);
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(720);
    }
  });

  it('opens below when it fits, above when only that side has room, and caps the height on the roomier side', () => {
    const roomy = filterPlacement({ viewport: { width: 1280, height: 900 }, anchor: rect(100), contentHeight: 400 });
    expect(roomy.side).toBe('bottom');
    expect(roomy.maxHeight).toBe(400);

    const low = filterPlacement({ viewport: { width: 1280, height: 720 }, anchor: rect(600), contentHeight: 400 });
    expect(low.side).toBe('top');

    const tight = filterPlacement({ viewport: { width: 1280, height: 720 }, anchor: rect(300), contentHeight: 900 });
    expect(tight.maxHeight).toBeLessThan(900);
  });
});
