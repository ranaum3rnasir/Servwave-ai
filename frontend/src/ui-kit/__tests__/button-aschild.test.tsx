import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Button } from '@/ui-kit/components/ui/button';

/**
 * Regression: `asChild` used to throw for EVERY caller.
 *
 * Button always passes two children to its wrapper - the spinner slot and the
 * caller's children - even when isLoading is false and the first is null. Under
 * asChild that wrapper is Radix Slot, which requires a single element child, so
 * it threw "Expected a single React element child" and took the page down.
 *
 * It was not a latent risk: two merged call sites rendered it
 * (customers/components/detailTabs.tsx and customers/CustomerDetailPage.tsx),
 * so the crash was live in the v2 layer and nothing caught it, because no test
 * rendered a kit Button with asChild.
 */
describe('kit Button asChild', () => {
  it('renders the caller element instead of a button, and does not throw', () => {
    render(
      <Button asChild variant="link">
        <a href="/somewhere">Go somewhere</a>
      </Button>,
    );

    const link = screen.getByRole('link', { name: 'Go somewhere' });
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '/somewhere');
    // The variant classes have to reach the caller's element, or asChild
    // renders an unstyled anchor and the bug becomes cosmetic instead of fatal.
    expect(link.className).toContain('inline-flex');
  });

  it('keeps the spinner alongside the slotted child while loading', () => {
    const { container } = render(
      <Button asChild isLoading>
        <a href="/somewhere">Saving</a>
      </Button>,
    );

    const link = screen.getByRole('link', { name: 'Saving' });
    expect(link).toHaveAttribute('aria-busy', 'true');
    // Spinner lands INSIDE the caller's element, not as a sibling that Slot
    // would have had to drop.
    expect(container.querySelector('a > svg')).not.toBeNull();
  });

  it('still renders a real button when asChild is off', () => {
    render(<Button>Press me</Button>);
    expect(screen.getByRole('button', { name: 'Press me' }).tagName).toBe('BUTTON');
  });
});
