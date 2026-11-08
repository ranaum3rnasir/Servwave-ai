/**
 * Walkthrough lead statuses, slice 01 - "the two statuses exist and show correctly everywhere".
 *
 * Walkthrough Scheduled and Walkthrough Completed are real lead statuses again, in pipeline order
 * between Contacted and Estimate Sent. This file pins what a user sees: the label, the colour (in
 * both themes), the order of the filter / status-menu list, and that no raw enum value leaks.
 * The status-registry <-> schema bijection is guarded separately by
 * design-system/__tests__/status-registry-schema-guard.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { render, screen } from '@testing-library/react';

import { STATUS_REGISTRY } from '@/design-system/status-registry';
import { LEAD_STATUSES, isTerminalLeadStatus, leadsRegistry } from '@/lib/filters/registries/leads';
import { StatusChip, statusVariantFor } from '@/pages/v2/_shared/statusChip';
import { contrastRatio } from '@/design-system/contrast';
import { statusLabel } from '@/components/layout/search-shared';

const WS = 'WALKTHROUGH_SCHEDULED';
const WC = 'WALKTHROUGH_COMPLETED';

describe('registry labels', () => {
  it('labels both statuses with the PRD wording and the in-progress intent', () => {
    expect(STATUS_REGISTRY.lead[WS]).toEqual({ label: 'Walkthrough Scheduled', intent: 'info' });
    expect(STATUS_REGISTRY.lead[WC]).toEqual({ label: 'Walkthrough Completed', intent: 'info' });
  });
});

describe('status list order (filters and the status menu)', () => {
  it('is New, Contacted, Walkthrough Scheduled, Walkthrough Completed, Estimate Sent, Won, Lost, Cancelled', () => {
    expect(LEAD_STATUSES).toEqual(['NEW', 'CONTACTED', WS, WC, 'ESTIMATED', 'WON', 'LOST', 'CANCELLED']);
    expect(LEAD_STATUSES.map((s) => STATUS_REGISTRY.lead[s]!.label)).toEqual([
      'New',
      'Contacted',
      'Walkthrough Scheduled',
      'Walkthrough Completed',
      'Estimate Sent',
      'Won',
      'Lost',
      'Cancelled',
    ]);
  });

  it('the leads-list Status filter offers both, labelled, in that order', () => {
    const facet = leadsRegistry.find((f) => f.key === 'status');
    expect(facet).toBeDefined();
    const options = (facet as { options: { value: string; label: string }[] }).options;
    expect(options.map((o) => o.value)).toEqual(LEAD_STATUSES);
    expect(options.find((o) => o.value === WS)?.label).toBe('Walkthrough Scheduled');
    expect(options.find((o) => o.value === WC)?.label).toBe('Walkthrough Completed');
  });

  it('keeps both open: only Won, Lost and Cancelled are closed', () => {
    expect(isTerminalLeadStatus(WS)).toBe(false);
    expect(isTerminalLeadStatus(WC)).toBe(false);
  });
});

describe('global search', () => {
  it('shows the label for a lead in either status, never the raw value', () => {
    expect(statusLabel('lead', WS)).toBe('Walkthrough Scheduled');
    expect(statusLabel('lead', WC)).toBe('Walkthrough Completed');
  });
});

describe('the chip', () => {
  it.each([
    [WS, 'Walkthrough Scheduled', 'bg-status-teal'],
    [WC, 'Walkthrough Completed', 'bg-status-indigo'],
  ])('%s shows its label and its own colour, never the raw value', (status, label, bg) => {
    const { container } = render(<StatusChip domain="lead" status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/WALKTHROUGH_|_/);
    expect(container.querySelector('[data-slot="badge"]')).toHaveClass(bg);
  });

  it('paints the two new statuses teal and indigo, and leaves the others alone', () => {
    expect(statusVariantFor('lead', WS)).toBe('teal');
    expect(statusVariantFor('lead', WC)).toBe('indigo');
    expect(statusVariantFor('lead', 'NEW')).toBe('purple');
    expect(statusVariantFor('lead', 'CONTACTED')).toBe('blue');
    expect(statusVariantFor('lead', 'ESTIMATED')).toBe('amber');
  });
});

/**
 * Chip text is `text-on-fill` (white) on the solid `--status-*` fill, so the check is white on the
 * fill, read from the live token file for the light theme (`:root`) and the dark theme (`.dark`).
 */
describe('contrast of the new chip tones, light and dark', () => {
  const css = readFileSync(join(__dirname, '../design-system/tokens-v2.css'), 'utf8');
  const tokens = readFileSync(join(__dirname, '../design-system/tokens.css'), 'utf8');

  function block(selector: RegExp): string {
    const start = css.search(selector);
    expect(start, `block ${selector} exists in tokens-v2.css`).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf('\n}', start));
  }
  function channelsToHex(block: string, name: string): string {
    const m = new RegExp(`--${name}:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)`).exec(block);
    expect(m, `--${name} is declared`).not.toBeNull();
    return '#' + [m![1], m![2], m![3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  }
  const onFill = channelsToHex(tokens, 'text-on-fill');

  describe.each([
    ['light', /^:root\s*\{/m],
    ['dark', /^\.dark\s*\{/m],
  ])('%s theme', (_theme, selector) => {
    it.each(['status-teal', 'status-indigo'])('%s clears 4.5:1 against the chip text', (name) => {
      expect(contrastRatio(onFill, channelsToHex(block(selector), name))).toBeGreaterThanOrEqual(4.5);
    });
  });

  it('the two new tones are wired into Tailwind so the classes generate', () => {
    const tw = readFileSync(join(__dirname, '../../tailwind.config.js'), 'utf8');
    expect(tw).toContain("teal: 'rgb(var(--status-teal) / <alpha-value>)'");
    expect(tw).toContain("indigo: 'rgb(var(--status-indigo) / <alpha-value>)'");
  });
});
