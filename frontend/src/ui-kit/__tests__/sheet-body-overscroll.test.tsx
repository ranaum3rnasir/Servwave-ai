import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SheetBody } from '@/ui-kit/components/ui/sheet';

/**
 * Mobile slice 75, rubric SCR-01: a sheet's body is an inner vertical scroller, so a swipe that
 * reaches its end must not hand over to the page behind (scroll chaining). The class that stops it
 * is `overscroll-contain`; every other kit scroller already carries it (the dialog body, the
 * navigation drawer, the activity rail).
 */
describe('SheetBody', () => {
  it('scrolls on its own and keeps a finished swipe from chaining to the page', () => {
    const { container } = render(<SheetBody>Long content</SheetBody>);
    const body = container.querySelector('[data-slot="sheet-body"]')!;
    const classes = body.className.split(/\s+/);
    expect(classes).toContain('overflow-y-auto');
    expect(classes).toContain('overscroll-contain');
  });
});
