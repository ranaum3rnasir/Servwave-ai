/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MarketingAnalyticsPage from '@/pages/MarketingAnalyticsPage';

/**
 * Guards the Marketing Analytics demo surface. It is mock data, so there is no API
 * behaviour to test - what matters is that the numbers a prospect sees hold together:
 *
 * - every timeframe actually carries its own data (the whole point of the selector)
 * - the derived KPIs are computed from the channel rows, so they cannot drift
 * - Cost/Booked Job stays PAID-only; folding in free referral/repeat work would
 *   silently flatter it back to ~$145
 * - channels stay ones an electronic-security / door contractor actually records
 *
 * recharts' ResponsiveContainer renders null under jsdom, so all assertions target
 * the KPI strip and tables, which are plain DOM.
 */

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return {
    ...actual,
    useOrganization: () => ({ data: { id: 'org-1', name: 'Northwind Services' }, isLoading: false, isError: false }),
  };
});

// Radix Select needs pointer geometry jsdom does not provide - swap in a native
// select so the timeframe switch is drivable.
vi.mock('@/components/form/SelectField', () => ({
  SelectField: ({
    value,
    onValueChange,
    options,
    className,
    ...rest
  }: {
    value: string;
    onValueChange: (v: string) => void;
    options: { value: string; label: string }[];
    className?: string;
    'aria-label'?: string;
  }) => (
    // className is forwarded because the real SelectField passes it to SelectTrigger,
    // whose base variant carries `w-full` - the sizing assertion below only means
    // something if the mock preserves what the call site sets.
    <select
      aria-label={rest['aria-label']}
      className={className}
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));

/** The channel-performance table, addressed via its first column header. */
function channelTable(): HTMLTableElement {
  return screen.getByRole('table', { name: 'Channel performance' }) as HTMLTableElement;
}

/**
 * The KPI card carrying `label`. Values like "42%" also appear in the channel
 * table, so headline assertions have to be scoped to the strip.
 */
function kpiCard(label: string): HTMLElement {
  return screen.getByText(label).closest('div')?.parentElement as HTMLElement;
}

/** Sum a numeric column of the channel table by its header name. */
function columnTotal(header: string): number {
  const table = channelTable();
  const headers = [...table.querySelectorAll('thead th')].map((th) => th.textContent?.trim());
  const idx = headers.indexOf(header);
  expect(idx).toBeGreaterThan(-1);
  return [...table.querySelectorAll('tbody tr')].reduce((sum, row) => {
    const cell = row.querySelectorAll('td')[idx]?.textContent ?? '0';
    return sum + Number(cell.replace(/[^0-9.]/g, ''));
  }, 0);
}

describe('Marketing Analytics mockup', () => {
  it('names the signed-in org rather than a sample company', () => {
    render(<MarketingAnalyticsPage />);
    expect(screen.getByText(/Northwind Services · Owner view/)).toBeInTheDocument();
    expect(screen.queryByText(/Northside Heating/)).toBeNull();
  });

  it('carries no data-trust or alert banner above the KPIs', () => {
    render(<MarketingAnalyticsPage />);
    expect(screen.queryByText(/Data trust/)).toBeNull();
    expect(screen.queryByText(/Unknown-source rate/)).toBeNull();
    expect(screen.queryByText(/Monday alert/)).toBeNull();
  });

  it('keeps the date filter a small fixed-width control', () => {
    render(<MarketingAnalyticsPage />);
    // SelectField's base variant carries `w-full`, which stretched it across the
    // whole header and wrapped the subtitle. The call site must pin a width.
    const trigger = screen.getByLabelText('Date range');
    expect(trigger.className).toMatch(/w-\[150px\]/);
    expect(trigger.className).toMatch(/shrink-0/);
  });

  it('shows the actual date window the figures cover', async () => {
    render(<MarketingAnalyticsPage />);
    expect(screen.getByText(/Owner view · Jul 8 - Aug 6, 2026/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Date range'), 'This month');
    expect(screen.getByText(/Owner view · Aug 1-6, 2026/)).toBeInTheDocument();
  });

  it('has no Owner/Director view toggle', () => {
    render(<MarketingAnalyticsPage />);
    expect(screen.queryByRole('button', { name: 'Owner' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Director' })).toBeNull();
  });

  it('always shows what used to be gated behind the Director toggle', () => {
    render(<MarketingAnalyticsPage />);
    // ROAS + Booking columns, plus the formerly director-only lower blocks.
    expect(screen.getByRole('columnheader', { name: 'ROAS' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Booking' })).toBeInTheDocument();
    expect(screen.getByText('Service line profitability')).toBeInTheDocument();
    expect(screen.getByText('Organic & reputation')).toBeInTheDocument();
    expect(screen.getByText('Conversion funnel')).toBeInTheDocument();
  });

  it('only lists channels a door / security contractor actually records', () => {
    render(<MarketingAnalyticsPage />);
    const table = channelTable();
    for (const name of [
      'Google LSA',
      'Google Ads',
      'Website & Organic',
      'Referral Partners',
      'Repeat & Accounts',
      'Trade Accounts',
    ]) {
      expect(within(table).getByText(name)).toBeInTheDocument();
    }
    // Residential home-services channels that do not belong on a commercial
    // access-control story, and read as generic template data.
    expect(screen.queryByText(/Angi/)).toBeNull();
    expect(screen.queryByText(/Meta \(FB\/IG\)/)).toBeNull();
    expect(screen.queryByText(/Offline \(wraps/)).toBeNull();
  });

  it('reports Cost / Booked Job on paid channels only', () => {
    render(<MarketingAnalyticsPage />);
    // Last 30 days: $22,500 spend buys 62 jobs on LSA + Google Ads -> $363.
    // Blending in the 94 free referral/organic/repeat/trade jobs gives ~$144.
    expect(screen.getByText('Cost / Booked Job (paid)')).toBeInTheDocument();
    expect(screen.getByText('$363')).toBeInTheDocument();
    expect(screen.queryByText('$144')).toBeNull();
    expect(screen.getByText(/under the \$450 industry floor/)).toBeInTheDocument();
  });

  it('derives the headline KPIs from the channel rows', async () => {
    render(<MarketingAnalyticsPage />);
    // Attributed revenue and lead volume must equal the table they summarise.
    expect(columnTotal('Revenue')).toBe(500000);
    expect(columnTotal('Leads')).toBe(372);
    expect(screen.getByText('$500,000')).toBeInTheDocument();
    // Scoped: the funnel's Leads bar is also labelled 372.
    expect(kpiCard('Lead Volume')).toHaveTextContent('372');
    // Booking rate = 156 booked / 372 leads. Scoped to the KPI card because
    // individual channel rows carry a 42% of their own in the Booking column.
    expect(columnTotal('Booked')).toBe(156);
    expect(kpiCard('Booking Rate')).toHaveTextContent('42%');
  });

  it.each([
    ['This month', 104000, 76],
    ['Last 30 days', 500000, 372],
    ['This quarter', 612000, 458],
    ['Year to date', 3410000, 2614],
  ])('carries real data for %s and keeps the table consistent', async (range, revenue, leads) => {
    render(<MarketingAnalyticsPage />);
    await userEvent.selectOptions(screen.getByLabelText('Date range'), range);
    expect(columnTotal('Revenue')).toBe(revenue);
    expect(columnTotal('Leads')).toBe(leads);
    expect(screen.getByText(revenue.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }))).toBeInTheDocument();
  });

  it('reports a different window label per timeframe', async () => {
    render(<MarketingAnalyticsPage />);
    expect(screen.getByText(/Jul 8 - Aug 6, 2026/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Date range'), 'Year to date');
    expect(screen.getByText(/Jan 1 - Aug 6, 2026/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Date range'), 'This quarter');
    expect(screen.getByText(/Jul 1 - Aug 6, 2026 \(Q3\)/)).toBeInTheDocument();
  });

  it('slices the same pipeline money two ways that must agree', () => {
    render(<MarketingAnalyticsPage />);
    // The forecast table's weighted total is the same money the cohort chart splits
    // by month, so the two headline figures have to reconcile. A viewer who adds the
    // per-channel forecast column has to land on the stated total.
    const table = screen.getByRole('table', { name: 'Pipeline forecast by channel' }) as HTMLTableElement;
    const headers = [...table.querySelectorAll('thead th')].map((th) => th.textContent?.trim());
    const idx = headers.indexOf('Forecast');
    const sum = [...table.querySelectorAll('tbody tr')].reduce((n, row) => {
      const cell = row.querySelectorAll('td')[idx]?.textContent ?? '0';
      return n + Number(cell.replace(/[^0-9.]/g, ''));
    }, 0);
    expect(sum).toBe(892920);
    expect(screen.getByText('$892,920')).toBeInTheDocument();
    expect(screen.getByText('$2,011,000')).toBeInTheDocument();
  });

  it('judges each service line against its own work-type band', () => {
    render(<MarketingAnalyticsPage />);
    const table = screen.getByRole('table', { name: 'Service line profitability' });
    const row = (name: string) =>
      within(table).getByText(name).closest('tr') as HTMLTableRowElement;
    // A 39% margin on INSTALL work beats its 28-38% band. Under the old single
    // ">=60% good" scale this rendered red - telling an owner their largest revenue
    // line was failing when it is outperforming its own industry norm.
    expect(row('Commercial Door Install / Replacement')).toHaveTextContent('▲ above 28-38%');
    expect(row('Camera & Surveillance')).toHaveTextContent('▲ above 30-40%');
    expect(row('Gates & Garage Doors')).toHaveTextContent('▲ above 28-38%');
    // A 62% margin on SERVICE work is genuinely under its 65-72% band - the one real
    // problem on the list, and the only row that should read as a warning.
    expect(row('Commercial Door Repair & Service')).toHaveTextContent('▼ below 65-72%');
    expect(row('Residential Service & Lockout')).toHaveTextContent('● in 65-72%');
  });

  it('shows stage-to-stage conversion and names the worst drop', () => {
    render(<MarketingAnalyticsPage />);
    // 372 -> 268 -> 156 -> 131. The drop-off is the point of a funnel; four bars with
    // no percentages left the reader to compute it.
    expect(screen.getByText(/↓ 72% quoted/)).toBeInTheDocument();
    expect(screen.getByText(/↓ 58% won/)).toBeInTheDocument();
    expect(screen.getByText(/↓ 84% completed/)).toBeInTheDocument();
    // Quoted -> Won loses 112, the largest of the three.
    expect(screen.getByText(/Quoted → Won/)).toBeInTheDocument();
    expect(screen.getByText(/112 lost \(42%\)/)).toBeInTheDocument();
  });

  it('never paints two different channels the same color', () => {
    render(<MarketingAnalyticsPage />);
    // chartPalette has 5 slots against 6 channels, so cycling it gave Google LSA and
    // Trade Accounts an identical green. The donut folds its tail into "Other"
    // instead; the channel table still breaks out all six.
    // Scoped to the lead-source legend. The KPI strip's tone dots are excluded on
    // purpose - those encode status, so repeating "success" green there is correct.
    const legend = screen.getByText(/^Other \(/).closest('div') as HTMLElement;
    const swatches = [...legend.querySelectorAll('.rounded-full[style*="background"]')]
      .map((el) => (el as HTMLElement).style.background)
      .filter(Boolean);
    expect(swatches).toHaveLength(5);
    expect(new Set(swatches).size).toBe(5);
    // The folded tail is named, not silently dropped.
    expect(within(legend).getByText(/^Other \(/)).toBeInTheDocument();
  });

  it('plots the cost-per-booked-job trend against the industry floor', () => {
    render(<MarketingAnalyticsPage />);
    expect(screen.getByText(/Cost per booked job — trailing 12 months/)).toBeInTheDocument();
    // Ends on the same figure the "This month" KPI reports, so the two agree.
    expect(screen.getByText(/Down from \$521 to \$354/)).toBeInTheDocument();
    expect(screen.getByText(/trailing 12 months, not affected by the date filter/)).toBeInTheDocument();
  });

  it('labels the pipeline snapshot as outside the date filter', async () => {
    render(<MarketingAnalyticsPage />);
    // Open pipeline is point-in-time, so it must NOT move with the filter - and must
    // say so, or the dashboard implies a period aggregate it is not.
    expect(screen.getByText(/snapshot as of today, not affected by the date filter/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Date range'), 'Year to date');
    expect(screen.getByText('$2,011,000')).toBeInTheDocument();
  });
});
