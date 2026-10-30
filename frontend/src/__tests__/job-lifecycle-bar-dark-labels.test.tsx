/**
 * Roles & Permissions, PRD 6, slice S06.21 - the progress bar's step labels stay readable in the dark theme.
 *
 * The labels were painted with `text-text-primary` (the fixed ink colour, which the dark theme never overrides), so on
 * the dark card they read rgb(16,32,43) on rgb(16,29,35). They take the design system's foreground tokens instead,
 * which the dark theme does override. jsdom loads no stylesheet, so this asserts the classes the labels carry and
 * measures the contrast of the tokens those classes resolve to, in both themes, straight from the token files.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { JobLifecycleBar } from '@/components/jobs/JobLifecycleBar';

const TOKENS = readFileSync(resolve(__dirname, '../design-system/tokens-v2.css'), 'utf8');

/** The `r g b` triple a token holds inside one rule block (":root" or ".dark"). */
function tokenIn(block: ':root' | '.dark', name: string): [number, number, number] {
  const start = TOKENS.indexOf(`\n${block} {`);
  const body = TOKENS.slice(start, TOKENS.indexOf('\n}', start));
  const match = new RegExp(`--${name}:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)`).exec(body);
  if (!match) throw new Error(`--${name} is not set in ${block}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const doneJob = {
  created_at: '2026-03-01T09:00:00Z',
  completed_at: '2026-03-02T16:00:00Z',
  status: 'DONE',
  cancelled_at: null,
};

describe('the job progress bar step labels in the dark theme', () => {
  it.each(['Job Created', 'Completed', 'Office review', 'Done'])('paints "%s" with a theme-aware foreground token, not the fixed ink', (label) => {
    render(<JobLifecycleBar job={doneJob} financials={undefined} can={{}} onNodeClick={() => undefined} />);
    const el = screen.getAllByText(label).find((node) => node.className.includes('text-center'));
    expect(el, `the "${label}" label`).toBeDefined();
    expect(el!.className).toMatch(/\btext-(foreground|muted-foreground)\b/);
    expect(el!.className).not.toMatch(/\btext-text-(primary|secondary)\b/);
  });

  it.each([':root', '.dark'] as const)('keeps both label tokens at 4.5:1 or better on the card in %s', (theme) => {
    const card = tokenIn(theme, 'card');
    expect(contrast(tokenIn(theme, 'foreground'), card)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokenIn(theme, 'muted-foreground'), card)).toBeGreaterThanOrEqual(4.5);
  });
});
