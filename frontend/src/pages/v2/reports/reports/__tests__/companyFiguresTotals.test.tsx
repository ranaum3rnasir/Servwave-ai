/**
 * Roles & Permissions S01.16 - the company-wide totals of the routed report pages.
 *
 * A list report sends the records a person can open, and the page adds them up into total tiles, footers and
 * charts. Those sums are company-wide money, so a person with Access Reports but without See company figures gets
 * the rows and counts and none of the sums. The Revenue report is nothing but sums: it says so instead of drawing
 * zeros. Each test renders the same page twice, once with the switch and once without, so a total that is hidden
 * for the wrong reason (an empty page) cannot pass.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';

// Charts measure their container; jsdom has none.
vi.mock('recharts', async (orig) => {
  const actual = await orig<typeof import('recharts')>();
  return { ...actual, ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div> };
});
// A demo org reads each report's deterministic sample rows, which carry dollar amounts on every record.
vi.mock('@/lib/useIsDemoOrg', () => ({ useIsDemoOrg: () => true }));
vi.mock('@/lib/reports/payment-fees-data', () => ({ usePaymentFeesReport: () => ({ data: undefined, isLoading: false }) }));

import RevenueReport from '../RevenueReport';
import PaymentsReport from '../PaymentsReport';
import InvoicesReport from '../InvoicesReport';
import EstimatesReport from '../EstimatesReport';
import JobsReport from '../JobsReport';
import LeadsReport from '../LeadsReport';

const WITH = buildAbility([{ action: 'read', subject: 'Report' }, { action: 'read', subject: 'CompanyFigures' }]);
const WITHOUT = buildAbility([{ action: 'read', subject: 'Report' }]);

/** How many elements carry exactly this text. */
const count = (text: string) => screen.queryAllByText(text).length;

describe('Revenue report', () => {
  it('draws the trend, the bridge and the five figures with the switch', () => {
    renderWithProviders(<RevenueReport />, { ability: WITH });
    expect(screen.getByText('Collection Rate')).toBeInTheDocument();
    expect(screen.getByText('Outstanding')).toBeInTheDocument();
    expect(screen.getByText('Reconciliation bridge')).toBeInTheDocument();
  });

  it('says the figures are limited, and draws no tile, chart or zero, without it', () => {
    const { container } = renderWithProviders(<RevenueReport />, { ability: WITHOUT });
    for (const label of ['Completed', 'Invoiced', 'Collected', 'Collection Rate', 'Outstanding', 'Reconciliation bridge']) {
      expect(screen.queryByText(label), label).toBeNull();
    }
    expect(screen.getByText(/company figures/i)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\$\s?\d/);
  });
});

describe('Payments report', () => {
  it('shows the totals with the switch', () => {
    renderWithProviders(<PaymentsReport />, { ability: WITH });
    for (const label of ['Total Revenue', 'Total Collected', 'Total amount', 'Total tips', 'Revenue by category', 'Weekly trend', 'Category breakdown']) {
      expect(screen.getAllByText(label).length, label).toBeGreaterThan(0);
    }
  });

  it('drops the totals tiles, the totals strip and the company-wide charts, and keeps the payments, without it', () => {
    const withFigures = renderWithProviders(<PaymentsReport />, { ability: WITH });
    const amountLabelsWith = count('Amount');
    withFigures.unmount();
    renderWithProviders(<PaymentsReport />, { ability: WITHOUT });
    for (const label of ['Total Revenue', 'Total Collected', 'Total amount', 'Total tips', 'Revenue by category', 'Weekly trend', 'Category breakdown']) {
      expect(screen.queryByText(label), label).toBeNull();
    }
    expect(count('Amount')).toBeLessThan(amountLabelsWith);
    expect(screen.getByText('Payments')).toBeInTheDocument();
    expect(screen.getByText('Amount')).toBeInTheDocument();
  });
});

describe('Invoices report', () => {
  /** A status tile reads as its label then its number; the text of the tile tells a count from a dollar sum. */
  const tile = (label: string) => screen.getAllByText(label).map((e) => e.parentElement?.textContent ?? '');

  it('shows dollar sums on the status tiles and a totals strip with the switch', () => {
    renderWithProviders(<InvoicesReport />, { ability: WITH });
    expect(tile('Overdue').some((t) => /^Overdue\$/.test(t))).toBe(true);
    expect(screen.getByText('Collected')).toBeInTheDocument();
  });

  it('turns the status tiles into counts, drops the totals strip, and keeps the invoices, without the switch', () => {
    const withFigures = renderWithProviders(<InvoicesReport />, { ability: WITH });
    const subtotalWith = count('Subtotal');
    withFigures.unmount();
    renderWithProviders(<InvoicesReport />, { ability: WITHOUT });
    expect(tile('Overdue').some((t) => /^Overdue\d+$/.test(t))).toBe(true);
    expect(tile('Due').some((t) => /^Due\$/.test(t))).toBe(false);
    expect(tile('Paid').some((t) => /^Paid\d+$/.test(t))).toBe(true);
    expect(screen.queryByText('Collected')).toBeNull();
    expect(count('Subtotal')).toBeLessThan(subtotalWith);
    expect(tile('Unsent').some((t) => /^Unsent\d+$/.test(t))).toBe(true);
    expect(screen.getByText('Client')).toBeInTheDocument();
  });
});

describe('Estimates report', () => {
  it('drops the revenue tiles, charts and revenue columns of the by-rep view, and keeps win rates, without the switch', () => {
    renderWithProviders(<EstimatesReport />, { ability: WITH });
    fireEvent.click(screen.getByRole('radio', { name: /by rep/i }));
    for (const label of ['Total Revenue', 'Avg Deal', 'Revenue by rep']) {
      expect(screen.getAllByText(label).length, label).toBeGreaterThan(0);
    }
  });

  it('shows the by-rep view without any dollar figure', () => {
    const { container } = renderWithProviders(<EstimatesReport />, { ability: WITHOUT });
    fireEvent.click(screen.getByRole('radio', { name: /by rep/i }));
    for (const label of ['Total Revenue', 'Avg Deal', 'Revenue by rep', 'Weekly trend', 'Revenue', 'Avg deal', 'Open $']) {
      expect(screen.queryByText(label), label).toBeNull();
    }
    expect(screen.getByText('Win Rate')).toBeInTheDocument();
    expect(screen.getByText('Win rate')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\$\s?\d/);
  });
});

describe('Jobs report', () => {
  it('drops the billed and collected tiles and the dollars beside each breakdown count, without the switch', () => {
    const withFigures = renderWithProviders(<JobsReport />, { ability: WITH });
    const billedWith = count('Billed');
    expect(screen.getAllByText(/^\d+ · \$/).length).toBeGreaterThan(0);
    withFigures.unmount();
    renderWithProviders(<JobsReport />, { ability: WITHOUT });
    expect(count('Billed')).toBeLessThan(billedWith);
    expect(screen.queryAllByText(/^\d+ · \$/)).toHaveLength(0);
    expect(screen.getByText('Total Jobs')).toBeInTheDocument();
    expect(screen.getByText('In Progress')).toBeInTheDocument();
  });
});

describe('Leads report', () => {
  it('drops the sold-for tile and the dollars beside each breakdown count, without the switch', () => {
    const withFigures = renderWithProviders(<LeadsReport />, { ability: WITH });
    expect(screen.getByText('Sold for')).toBeInTheDocument();
    withFigures.unmount();
    renderWithProviders(<LeadsReport />, { ability: WITHOUT });
    expect(screen.queryByText('Sold for')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\d · \$\d/);
    expect(screen.getByText('Conversion Rate')).toBeInTheDocument();
  });
});
