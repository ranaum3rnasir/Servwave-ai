/**
 * Regression guard for issue #385 — KPI tile labels and sub-captions must not
 * be hard-truncated (Tailwind `truncate` = nowrap + ellipsis). They wrap
 * instead, so 8-tile strips on xl screens show full text.
 *
 * This file also guards the value-overflow half of #385: the KpiStrip
 * `maxColumns` cap keeps the xl column count from forcing 8 narrow columns
 * (which clipped the 26px currency values past the card border). The tests
 * assert the `--kpi-n` inline-style contract (jsdom can't measure pixel fit).
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FileText } from 'lucide-react';
import { KpiStrip, KpiTile, type KpiTileProps } from '@/components/data/KpiStrip';

describe('KpiTile (issue #385)', () => {
  it('renders the full label without the truncate class', () => {
    render(<KpiTile icon={FileText} label="Total Quotes" value={42} sub="$417,600" />);
    const label = screen.getByText('Total Quotes');
    expect(label.className).not.toMatch(/truncate/);
  });

  it('renders the full sub caption without the truncate class', () => {
    render(<KpiTile icon={FileText} label="Total Quotes" value={42} sub="$417,600" />);
    const sub = screen.getByText('$417,600');
    expect(sub.className).not.toMatch(/truncate/);
  });
});

describe('KpiStrip maxColumns (issue #385 — value overflow)', () => {
  const eightItems: KpiTileProps[] = Array.from({ length: 8 }, (_, i) => ({
    icon: FileText,
    label: `Metric ${i + 1}`,
    value: `$${i}00,000`,
  }));

  it('caps the xl column count when maxColumns is set', () => {
    const { container } = render(<KpiStrip items={eightItems} maxColumns={4} />);
    expect(container.querySelector('.grid')?.getAttribute('style')).toMatch(/--kpi-n:\s*4/);
  });

  it('leaves the column count at items.length when maxColumns is omitted', () => {
    const { container } = render(<KpiStrip items={eightItems} />);
    expect(container.querySelector('.grid')?.getAttribute('style')).toMatch(/--kpi-n:\s*8/);
  });
});
