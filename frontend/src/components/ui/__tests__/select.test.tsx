/**
 * SelectTrigger - rendered-class contract for the W2 `size` axis.
 *
 * SelectTrigger had no test file before this pass. The propless-default
 * assertion below pins the exact string the component rendered before `size`
 * existed. `size` is declared in a cva() block whose `md` variant class is an
 * empty string (same shape as Input's phase-8a `size`, components/ui/input.tsx)
 * so cva's own `cx` (clsx) call drops it entirely - the default render stays
 * byte-identical to the pre-size-prop string rather than merely
 * token-set-identical (appending a second literal `h-10` would let
 * tailwind-merge dedupe it against the base string's own `h-10` and reorder
 * the survivor to the end of the class list).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const cls = (el: HTMLElement) => el.getAttribute('class') ?? '';
const trigger = () => screen.getByTestId('trigger');

const DEFAULT_CLASS =
  'flex h-10 w-full items-center justify-between rounded border border-border bg-surface-light px-3 py-2 text-sm ring-offset-surface-light data-[placeholder]:text-text-secondary focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1';

describe('SelectTrigger - the shipped default string, frozen', () => {
  it('propless renders the exact string it shipped with before size existed', () => {
    render(
      <Select>
        <SelectTrigger data-testid="trigger">
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
      </Select>
    );
    expect(cls(trigger())).toBe(DEFAULT_CLASS);
  });

  it('size="md" stated explicitly is byte-identical to propless', () => {
    render(
      <Select>
        <SelectTrigger data-testid="trigger" size="md">
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
      </Select>
    );
    expect(cls(trigger())).toBe(DEFAULT_CLASS);
  });

  it('tone="default" stated explicitly is byte-identical to propless (pre-existing contract)', () => {
    render(
      <Select>
        <SelectTrigger data-testid="trigger" tone="default">
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
      </Select>
    );
    expect(cls(trigger())).toBe(DEFAULT_CLASS);
  });
});

describe('SelectTrigger - size rungs', () => {
  it('size="xs" renders 32px (h-8) with text-xs, the TaskDetailDrawer/LineItemRow (dense) rung', () => {
    render(
      <Select>
        <SelectTrigger data-testid="trigger" size="xs">
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
      </Select>
    );
    const rendered = cls(trigger()).split(' ');
    expect(rendered).toContain('h-8');
    expect(rendered).toContain('text-xs');
    expect(rendered).not.toContain('h-10');
    expect(rendered).not.toContain('text-sm');
  });

  it('size="sm" renders 36px (h-9), the TaskFilterBar/TrainingView/TotalsFooter rung', () => {
    render(
      <Select>
        <SelectTrigger data-testid="trigger" size="sm">
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
      </Select>
    );
    const rendered = cls(trigger()).split(' ');
    expect(rendered).toContain('h-9');
    expect(rendered).not.toContain('h-10');
    // sm leaves the base string's own font alone.
    expect(rendered).toContain('text-sm');
  });

  it('size="lg" renders 44px (h-11), the StopIfForm/WaitForm/DateModePanel rung', () => {
    render(
      <Select>
        <SelectTrigger data-testid="trigger" size="lg">
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
      </Select>
    );
    const rendered = cls(trigger()).split(' ');
    expect(rendered).toContain('h-11');
    expect(rendered).not.toContain('h-10');
    expect(rendered).toContain('text-sm');
  });
});

describe('SelectTrigger - size composes with the pre-existing tone/invalid props', () => {
  it('size="xs" tone="sage" carries both the rung and the sage classes', () => {
    render(
      <Select>
        <SelectTrigger data-testid="trigger" size="xs" tone="sage">
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
      </Select>
    );
    const rendered = cls(trigger()).split(' ');
    expect(rendered).toContain('h-8');
    expect(rendered).toContain('text-xs');
    expect(rendered).toContain('border-sage-200');
    expect(rendered).toContain('text-sage-700');
  });

  it('size="lg" invalid carries both the rung and the danger border', () => {
    render(
      <Select>
        <SelectTrigger data-testid="trigger" size="lg" invalid>
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
      </Select>
    );
    const rendered = cls(trigger()).split(' ');
    expect(rendered).toContain('h-11');
    expect(rendered).toContain('border-danger');
  });
});

describe('SelectTrigger - W2/8 rename schedule gap fix - tone="business" (sage -> business)', () => {
  it('tone="business" renders byte-identical to the deprecated tone="sage"', () => {
    render(
      <Select>
        <SelectTrigger data-testid="trigger" tone="sage">
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
      </Select>
    );
    const sageClass = cls(trigger());
    cleanup();

    render(
      <Select>
        <SelectTrigger data-testid="trigger" tone="business">
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
      </Select>
    );
    expect(cls(trigger())).toBe(sageClass);
  });

  it('tone="business" carries the same border/text sage classes tone="sage" does', () => {
    render(
      <Select>
        <SelectTrigger data-testid="trigger" tone="business">
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
      </Select>
    );
    const rendered = cls(trigger()).split(' ');
    expect(rendered).toContain('border-sage-200');
    expect(rendered).toContain('text-sage-700');
  });
});

describe('SelectTrigger - hygiene', () => {
  it('a call site className still wins over the size rung', () => {
    render(
      <Select>
        <SelectTrigger data-testid="trigger" size="md" className="h-11 w-44">
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
      </Select>
    );
    const rendered = cls(trigger()).split(' ');
    expect(rendered).not.toContain('h-10');
    expect(rendered).toContain('h-11');
    expect(rendered).toContain('w-44');
  });

  it('size never reaches the DOM', () => {
    render(
      <Select>
        <SelectTrigger data-testid="trigger" size="lg">
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
      </Select>
    );
    expect(trigger().getAttribute('size')).toBeNull();
  });

  it('forwards a ref', () => {
    const ref = { current: null as HTMLButtonElement | null };
    render(
      <Select>
        <SelectTrigger ref={ref} data-testid="trigger">
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
      </Select>
    );
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });
});

/**
 * On a phone a list with long option labels ran past the screen edge: Radix
 * sizes the list to its widest row (`min-width: max-content` on its wrapper)
 * and this content had no max width. Every dropdown here opens in popper mode
 * (the default; no call site asks for item-aligned), where Radix measures the
 * width available on screen, so the content is capped to it and long labels
 * wrap. jsdom has no layout: this pins the class that does the capping.
 */
describe('SelectContent - fits the screen', () => {
  it('caps the open list to the width available on screen, and lets long labels wrap', () => {
    render(
      <Select defaultOpen>
        <SelectTrigger data-testid="trigger">
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="long">(555) 201-4410 · The main office line that rings the front desk first</SelectItem>
        </SelectContent>
      </Select>
    );
    const classes = cls(screen.getByRole('listbox')).split(' ');
    expect(classes).toContain('max-w-[var(--radix-select-content-available-width)]');
    expect(classes).toContain('break-words');
  });
});

/** An unbroken label wraps inside the list - the why is in the kit's
 *  `ui-kit/components/ui/select.test.tsx`, which pins the same pair. */
describe('SelectItem - an unbroken label wraps inside the list', () => {
  it('lets the item text shrink and break anywhere', () => {
    const UNBROKEN = 'dispatch.northeast.region.overflow.queue.longname@example-company.com';
    render(
      <Select defaultOpen>
        <SelectTrigger data-testid="trigger">
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="unbroken">{UNBROKEN}</SelectItem>
        </SelectContent>
      </Select>
    );
    // Radix drops a className given to ItemText, so the item styles its text
    // span (its direct <span> child) instead.
    const option = screen.getByRole('option');
    expect(option.querySelector(':scope > span[id]')).toHaveTextContent(UNBROKEN);
    const classes = cls(option).split(' ');
    expect(classes).toContain('[&>span]:min-w-0');
    expect(classes).toContain('[&>span]:[overflow-wrap:anywhere]');
  });
});
