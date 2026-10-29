/**
 * Alert - phase 9, rendered-class contract.
 *
 * The primitive exists to retire one measured signature - 22 sites hand-roll
 * `bg-danger/10 border border-danger/20 px-3 py-2 rounded-md` (program plan
 * section 1e, line 120). The first block below proves `<Alert tone="danger">`
 * alone reproduces that shape with the token-based classes it maps to. The
 * remaining blocks pin every variant x tone cell, each size rung, the
 * gap/pad axes and the usual primitive hygiene (ref forwarding, className
 * override, prop passthrough).
 */
import type { ReactElement } from 'react';

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Alert, type AlertTone, type AlertVariant } from '@/components/ui/alert';

function classOf(ui: ReactElement): string {
  const { container } = render(ui);
  return (container.firstElementChild as HTMLElement).className;
}

function tokens(ui: ReactElement): string[] {
  return classOf(ui).split(/\s+/).filter(Boolean);
}

describe('Alert - reproduces the measured 22x signature', () => {
  it('tone="danger" (variant defaults to outline) renders the token equivalent of bg-danger/10 border border-danger/20 px-3 py-2 rounded-md', () => {
    const cls = tokens(<Alert tone="danger">Something went wrong.</Alert>);
    expect(cls).toContain('bg-danger-surface');
    expect(cls).toContain('border-danger-border');
    expect(cls).toContain('text-danger-text');
    expect(cls).toContain('border');
    expect(cls).toContain('rounded-md');
    expect(cls).toContain('px-3');
    expect(cls).toContain('py-2');
  });

  it('renders role="alert" by default', () => {
    const { getByRole } = render(<Alert tone="danger">x</Alert>);
    expect(getByRole('alert')).toBeInTheDocument();
  });

  it('role is overridable, e.g. to a quieter status region', () => {
    const { getByRole } = render(
      <Alert tone="success" role="status">
        x
      </Alert>
    );
    expect(getByRole('status')).toBeInTheDocument();
  });
});

describe('Alert - bare default is a sane, non-broken box', () => {
  it('renders neutral/outline/md with no props at all', () => {
    const cls = tokens(<Alert>Plain message</Alert>);
    expect(cls).toContain('bg-neutral-surface');
    expect(cls).toContain('border-neutral-border');
    expect(cls).toContain('text-neutral-text');
    expect(cls).toContain('px-3');
    expect(cls).toContain('py-2');
    expect(cls).toContain('text-sm');
  });

  it('renders its children', () => {
    const { getByText } = render(<Alert>Hello</Alert>);
    expect(getByText('Hello')).toBeInTheDocument();
  });
});

describe('Alert - variant x tone renders the documented triad', () => {
  const OUTLINE_TRIAD: Record<AlertTone, string[]> = {
    neutral: ['bg-neutral-surface', 'border-neutral-border', 'text-neutral-text'],
    danger: ['bg-danger-surface', 'border-danger-border', 'text-danger-text'],
    success: ['bg-success-surface', 'border-success-border', 'text-success-text'],
    warning: ['bg-warning-surface', 'border-warning-border', 'text-warning-text'],
    ai: ['bg-ai-surface', 'border-ai-border', 'text-ai-text'],
  };

  it.each(Object.entries(OUTLINE_TRIAD))('variant="outline" tone="%s" renders its surface/border/text triad', (tone, expected) => {
    const cls = tokens(<Alert variant="outline" tone={tone as AlertTone}>x</Alert>);
    expected.forEach((token) => expect(cls).toContain(token));
  });

  // Literal per-tone maps, not a computed background class name built from a
  // template string. The unresolved-class guard tokenises raw source text,
  // and a template literal's static portion survives the split as its own
  // bare two-letter background-prefix fragment - a real false positive this
  // file hit and fixed. Literal strings keep this test file clean of that
  // fragment.
  const SOLID_FILL: Record<AlertTone, string> = {
    neutral: 'bg-neutral-strong',
    danger: 'bg-danger-strong',
    success: 'bg-success-strong',
    warning: 'bg-warning-strong',
    ai: 'bg-ai-strong',
  };

  const OUTLINE_BG: Record<AlertTone, string> = {
    neutral: 'bg-neutral-surface',
    danger: 'bg-danger-surface',
    success: 'bg-success-surface',
    warning: 'bg-warning-surface',
    ai: 'bg-ai-surface',
  };

  it.each(Object.entries(SOLID_FILL))('variant="solid" tone="%s" renders a strong fill with on-fill text, no border colour', (tone, expectedBg) => {
    const cls = tokens(<Alert variant="solid" tone={tone as AlertTone}>x</Alert>);
    expect(cls).toContain(expectedBg);
    expect(cls).toContain('text-on-fill');
    expect(cls).toContain('border-transparent');
    expect(cls).not.toContain(OUTLINE_BG[tone as AlertTone]);
  });

  const GHOST_TEXT: Record<AlertTone, string> = {
    neutral: 'text-neutral-text',
    danger: 'text-danger-text',
    success: 'text-success-text',
    warning: 'text-warning-text',
    ai: 'text-ai-text',
  };

  it.each(Object.entries(GHOST_TEXT))('variant="ghost" tone="%s" renders tinted text only, no fill or border colour', (tone, expectedText) => {
    const cls = tokens(<Alert variant="ghost" tone={tone as AlertTone}>x</Alert>);
    expect(cls).toContain(expectedText);
    expect(cls).toContain('border-transparent');
    expect(cls).toContain('bg-transparent');
    expect(cls).not.toContain(OUTLINE_BG[tone as AlertTone]);
    expect(cls).not.toContain(SOLID_FILL[tone as AlertTone]);
  });

  it('every minted variant x tone cell is exercised (documentation of what exists)', () => {
    const variants: AlertVariant[] = ['outline', 'solid', 'ghost'];
    const tones: AlertTone[] = ['neutral', 'danger', 'success', 'warning', 'ai'];
    for (const variant of variants) {
      for (const tone of tones) {
        const { unmount } = render(
          <Alert variant={variant} tone={tone}>
            x
          </Alert>
        );
        unmount();
      }
    }
  });
});

describe('Alert - scale is a font/icon-size axis, not control height, sm is the default', () => {
  // `scale` (not `size`) because Alert is a static status div, not a
  // control - VOCAB_V3 rule 3: "size never appears on a primitive where it
  // would not mean control height". Values are the literal Tailwind
  // font-size key each one renders, not the retired xs/sm/md/lg relative
  // ladder.
  it.each([
    ['xs', 'text-xs'],
    ['sm', 'text-sm'],
    ['base', 'text-base'],
  ] as const)('scale="%s" renders %s', (scale, expected) => {
    const cls = tokens(<Alert scale={scale}>x</Alert>);
    expect(cls).toContain(expected);
  });

  it('omitting scale renders identically to scale="sm"', () => {
    expect(classOf(<Alert tone="danger">x</Alert>)).toBe(classOf(<Alert tone="danger" scale="sm">x</Alert>));
  });
});

describe('Alert - deprecated size prop is a live alias for scale, rendering identically', () => {
  it.each([
    ['xs', 'text-xs'],
    ['sm', 'text-sm'],
    ['md', 'text-sm'],
    ['lg', 'text-base'],
  ] as const)('size="%s" renders %s', (size, expected) => {
    const cls = tokens(<Alert size={size}>x</Alert>);
    expect(cls).toContain(expected);
  });

  it('size="md" renders identically to scale="sm" (the byte-identical old default)', () => {
    expect(classOf(<Alert tone="danger" size="md">x</Alert>)).toBe(
      classOf(<Alert tone="danger" scale="sm">x</Alert>)
    );
  });

  it('size="xs" renders identically to scale="xs"', () => {
    expect(classOf(<Alert tone="danger" size="xs">x</Alert>)).toBe(
      classOf(<Alert tone="danger" scale="xs">x</Alert>)
    );
  });

  it('size="lg" renders identically to scale="base"', () => {
    expect(classOf(<Alert tone="danger" size="lg">x</Alert>)).toBe(
      classOf(<Alert tone="danger" scale="base">x</Alert>)
    );
  });

  it('omitting both size and scale renders identically to size="md"', () => {
    expect(classOf(<Alert tone="danger">x</Alert>)).toBe(classOf(<Alert tone="danger" size="md">x</Alert>));
  });

  it('scale wins when both scale and the deprecated size are passed', () => {
    const cls = tokens(
      <Alert tone="danger" size="xs" scale="base">
        x
      </Alert>
    );
    expect(cls).toContain('text-base');
    expect(cls).not.toContain('text-xs');
  });
});

describe('Alert - pad defaults to the measured geometry, overridable via the shared spacing scale', () => {
  it('no padding prop renders px-3 py-2, the exact measured signature', () => {
    const cls = tokens(<Alert>x</Alert>);
    expect(cls).toContain('px-3');
    expect(cls).toContain('py-2');
  });

  it('pad={6} overrides the default with a uniform p-6', () => {
    const cls = tokens(<Alert pad={6}>x</Alert>);
    expect(cls).toContain('p-6');
    expect(cls).not.toContain('px-3');
    expect(cls).not.toContain('py-2');
  });

  it('padX/padY override the default independently', () => {
    const cls = tokens(
      <Alert padX={4} padY={1}>
        x
      </Alert>
    );
    expect(cls).toContain('px-4');
    expect(cls).toContain('py-1');
    expect(cls).not.toContain('px-3');
    expect(cls).not.toContain('py-2');
  });

  it('pad={0} is a real override, not dropped as falsy', () => {
    const cls = tokens(<Alert pad={0}>x</Alert>);
    expect(cls).toContain('p-0');
    expect(cls).not.toContain('px-3');
  });
});

describe('Alert - gap is the same 4px-grid scale as Stack/Inline, 0 by default', () => {
  it('renders gap-0 with no gap prop', () => {
    expect(tokens(<Alert>x</Alert>)).toContain('gap-0');
  });

  it.each([
    [0, 'gap-0'],
    [0.5, 'gap-0.5'],
    [1, 'gap-1'],
    [2, 'gap-2'],
    [3, 'gap-3'],
    [6, 'gap-6'],
    [12, 'gap-12'],
  ] as const)('gap={%s} renders %s', (gap, expected) => {
    expect(tokens(<Alert gap={gap}>x</Alert>)).toContain(expected);
  });
});

describe('Alert - primitive hygiene', () => {
  it('forwards a ref to the div', () => {
    const ref = { current: null as HTMLDivElement | null };
    render(<Alert ref={ref}>x</Alert>);
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
  });

  it('a caller className wins over the variant classes (className applied last)', () => {
    const cls = tokens(<Alert tone="danger" className="bg-surface-light" />);
    expect(cls).toContain('bg-surface-light');
    expect(cls).not.toContain('bg-danger-surface');
  });

  it('passes through arbitrary div attributes', () => {
    const { getByTestId } = render(<Alert data-testid="alert" aria-label="warning" />);
    expect(getByTestId('alert').getAttribute('aria-label')).toBe('warning');
  });

  it('every class it can emit under the minted cells is a stock/registered Tailwind key, never an arbitrary bracket value', () => {
    const variants: AlertVariant[] = ['outline', 'solid', 'ghost'];
    const tones: AlertTone[] = ['neutral', 'danger', 'success', 'warning', 'ai'];
    const emitted = new Set<string>();
    for (const variant of variants) {
      for (const tone of tones) {
        const { unmount } = render(
          <Alert variant={variant} tone={tone}>
            x
          </Alert>
        );
        for (const c of tokens(<Alert variant={variant} tone={tone} />)) emitted.add(c);
        unmount();
      }
    }
    for (const c of emitted) {
      // An arbitrary VALUE (`h-[42px]`, the forbidden shape) opens its bracket
      // right after a hyphen. An arbitrary VARIANT selector (`[&_svg]:size-4`,
      // already a real pattern in button.tsx) opens at the start of the token
      // instead - that shape is not what this project's bracket-value rule
      // fences, so only the hyphen-led form is asserted against here.
      expect(c, `${c} must not be an arbitrary bracket value`).not.toMatch(/-\[[^\]]*\]/);
      expect(c, `${c} must not be a raw hex colour`).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    }
  });
});
