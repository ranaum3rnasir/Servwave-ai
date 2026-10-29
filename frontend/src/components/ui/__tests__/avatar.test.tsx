/**
 * Avatar - rendered-class contract for the W2 `size` axis.
 *
 * Avatar had no test file before this pass. The propless-default assertion
 * below pins the exact string the component rendered before `size` existed
 * ("relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full") - `size`
 * is spliced into the base string at the position the literal h-10 w-10 used
 * to occupy, not appended after it, specifically so the `md` default stays
 * byte-identical rather than merely token-set-identical (appending would let
 * tailwind-merge dedupe the two h-10 w-10 occurrences and reorder the
 * survivor to the end - verified against the actual installed tailwind-merge
 * before choosing the splice).
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';

const cls = (el: HTMLElement) => el.getAttribute('class') ?? '';
const root = () => screen.getByTestId('avatar');

describe('Avatar - the shipped default string, frozen', () => {
  it('propless renders the exact string it shipped with before size existed', () => {
    render(<Avatar data-testid="avatar" />);
    expect(cls(root())).toBe('relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full');
  });

  it('size="md" stated explicitly is byte-identical to propless', () => {
    render(<Avatar data-testid="avatar" size="md" />);
    expect(cls(root())).toBe('relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full');
  });

  it('ring="none" stated explicitly is byte-identical to propless (pre-existing contract)', () => {
    render(<Avatar data-testid="avatar" ring="none" />);
    expect(cls(root())).toBe('relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full');
  });
});

describe('Avatar - size rungs', () => {
  it('size="xs" renders 32px (h-8 w-8), the CustomersPage/AssignTeamPopover rung', () => {
    render(<Avatar data-testid="avatar" size="xs" />);
    expect(cls(root())).toBe('relative flex h-8 w-8 shrink-0 overflow-hidden rounded-full');
  });

  it('size="sm" renders 36px (h-9 w-9), the Header/AiJobAssistantBar rung', () => {
    render(<Avatar data-testid="avatar" size="sm" />);
    expect(cls(root())).toBe('relative flex h-9 w-9 shrink-0 overflow-hidden rounded-full');
  });

  it('size="lg" renders 44px (h-11 w-11), the ladder\'s top rung', () => {
    render(<Avatar data-testid="avatar" size="lg" />);
    expect(cls(root())).toBe('relative flex h-11 w-11 shrink-0 overflow-hidden rounded-full');
  });
});

describe('Avatar - size composes with the pre-existing ring prop', () => {
  it('size="lg" ring="stack" carries both the diameter and the ring classes', () => {
    render(<Avatar data-testid="avatar" size="lg" ring="stack" />);
    expect(cls(root())).toBe(
      'relative flex h-11 w-11 shrink-0 overflow-hidden rounded-full shadow-sm ring-2 ring-surface-light'
    );
  });

  it('size="xs" ring="ai" carries both the diameter and the ai halo', () => {
    render(<Avatar data-testid="avatar" size="xs" ring="ai" />);
    expect(cls(root())).toBe(
      'relative flex h-8 w-8 shrink-0 overflow-hidden rounded-full ring-2 ring-ai-200'
    );
  });
});

describe('Avatar - hygiene', () => {
  it('a call site className still wins over the size rung, the AgentCard singleton pattern', () => {
    // AgentCard.tsx (48px) is a singleton diameter not folded into the
    // closed 4-rung scale - it keeps a bespoke className override, and
    // tailwind-merge must still let it win over `size`'s h-w. (TeamCard.tsx's
    // 44px now coincides with the corrected `lg` rung, but that call site is
    // untouched here - migrating it to `size="lg"` is a call-site change,
    // out of scope for this component.)
    render(<Avatar data-testid="avatar" size="md" className="h-11 w-11" />);
    expect(cls(root())).toBe('relative flex shrink-0 overflow-hidden rounded-full h-11 w-11');
  });

  it('size never reaches the DOM', () => {
    render(<Avatar data-testid="avatar" size="lg" />);
    expect(root().getAttribute('size')).toBeNull();
  });

  it('forwards a ref', () => {
    const ref = { current: null as HTMLSpanElement | null };
    render(<Avatar ref={ref} data-testid="avatar" />);
    expect(ref.current).toBeInstanceOf(HTMLSpanElement);
  });

  it('AvatarFallback is unaffected by the size prop - it has no size axis of its own', () => {
    render(
      <Avatar data-testid="avatar" size="lg">
        <AvatarFallback data-testid="fallback">JD</AvatarFallback>
      </Avatar>
    );
    expect(cls(screen.getByTestId('fallback'))).toBe(
      'flex h-full w-full items-center justify-center rounded-full bg-background-light'
    );
  });
});
