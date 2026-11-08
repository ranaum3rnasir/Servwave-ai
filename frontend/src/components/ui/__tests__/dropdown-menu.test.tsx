/**
 * DropdownMenuItem `tone` / `readability` / deprecated `variant` - W2/8
 * rename-schedule gap fix, PLUS the follow-up split of `tone` into a
 * colour-only prop (VOCAB_V3 rule 1: "tone = colour ... no second word").
 *
 * Program plan section 2a.11 schedules `variant='destructive'` ->
 * `tone="danger"` for this component (14 of 82 real call sites). This file
 * pins that:
 *   - `tone="danger"` and the deprecated `variant="destructive"` alias
 *     render byte-identical output (so the 14 real call sites, left
 *     untouched, keep rendering unchanged);
 *   - the pre-existing readability values (`strong`/`subtle`/`muted`) still
 *     work when passed to the deprecated legacy `tone` spelling, unaffected
 *     by `danger` living on the same prop;
 *   - the current `readability` prop produces the identical class strings
 *     for its three closed-vocabulary values (`default`/`strong`/`subtle`)
 *     - `muted` is retired and is NOT one of `readability`'s values (VOCAB_V3:
 *     "muted is retired, do not use it as a value" - `readability` is a prop
 *     minted fresh this session, so it never gets a legacy spelling of its
 *     own); the deprecated `tone="muted"` spelling still resolves to the
 *     same `subtle` class string internally, but only via `tone`;
 *   - `tone` wins whenever both `tone` and the deprecated `variant` are
 *     passed together (the same precedent ConfirmDialog and Toast use);
 *   - the explicit `readability` prop wins over a legacy readability value
 *     riding in on the deprecated `tone` prop, when both are passed.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

function renderItem(props: Record<string, unknown> = {}) {
  cleanup();
  render(
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem data-testid="item" {...props}>
          Item
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return screen.getByTestId('item').className;
}

const tokens = (cls: string) => cls.split(/\s+/).filter(Boolean);

describe('DropdownMenuItem - tone / deprecated variant', () => {
  it('propless renders the plain (no colour, no readability) baseline', () => {
    const got = tokens(renderItem());
    expect(got).not.toContain('text-danger');
    expect(got).not.toContain('text-text-primary');
    expect(got).not.toContain('text-text-secondary');
  });

  it('tone="danger" renders the exact class string variant="destructive" used to produce', () => {
    const dangerCls = tokens(renderItem({ tone: 'danger' }));
    expect(dangerCls).toContain('text-danger');
    expect(dangerCls).toContain('focus:bg-danger/10');
    expect(dangerCls).toContain('focus:text-danger');
  });

  it('the deprecated variant="destructive" alias renders byte-identical to tone="danger"', () => {
    const { unmount } = render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem data-testid="item" tone="danger">
            Item
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    const toneCls = screen.getByTestId('item').className;
    unmount();

    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem data-testid="item" variant="destructive">
            Item
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    expect(screen.getByTestId('item').className).toBe(toneCls);
  });

  it('the pre-existing readability values still work via the deprecated legacy tone spelling', () => {
    expect(tokens(renderItem({ tone: 'strong' }))).toContain('text-text-primary');
    expect(tokens(renderItem({ tone: 'subtle' }))).toContain('text-text-secondary');
    expect(tokens(renderItem({ tone: 'muted' }))).toContain('text-text-secondary');
  });

  it('tone wins when both tone and the deprecated variant are passed', () => {
    const got = tokens(renderItem({ variant: 'destructive', tone: 'strong' }));
    expect(got).toContain('text-text-primary');
    expect(got).not.toContain('text-danger');
  });
});

describe('DropdownMenuItem - readability (VOCAB_V3 split from tone)', () => {
  it('readability is a separate, non-colour prop: default/strong/subtle produce the same classes tone used to', () => {
    expect(tokens(renderItem({ readability: 'default' }))).not.toContain('text-danger');
    expect(tokens(renderItem({ readability: 'strong' }))).toContain('text-text-primary');
    expect(tokens(renderItem({ readability: 'subtle' }))).toContain('text-text-secondary');
  });

  it('readability has no "muted" value - the retired spelling only resolves via the deprecated tone prop, to the same class as readability="subtle"', () => {
    const subtleCls = renderItem({ readability: 'subtle' });
    const legacyMutedCls = renderItem({ tone: 'muted' });
    expect(legacyMutedCls).toBe(subtleCls);
  });

  it('readability="strong" renders byte-identical output to the deprecated legacy tone="strong"', () => {
    const readabilityCls = renderItem({ readability: 'strong' });
    const legacyToneCls = renderItem({ tone: 'strong' });
    expect(readabilityCls).toBe(legacyToneCls);
  });

  it('tone="danger" still wins over readability - danger owns the pixel outright', () => {
    const got = tokens(renderItem({ tone: 'danger', readability: 'strong' }));
    expect(got).toContain('text-danger');
    expect(got).not.toContain('text-text-primary');
  });

  it('the explicit readability prop wins over a legacy readability value riding in on the deprecated tone prop', () => {
    const got = tokens(renderItem({ tone: 'subtle', readability: 'strong' }));
    expect(got).toContain('text-text-primary');
    expect(got).not.toContain('text-text-secondary');
  });
});
