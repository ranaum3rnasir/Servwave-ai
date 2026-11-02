// Slice 10 — the Job Profitability report and its CSV export speak the settled
// vocabulary: the word is "margin", in full, never "GM" or "Gross Margin".
//
// The component under test is the ROUTED one. Routing is
// pages/v2/routes/reports.routes.tsx -> pages/v2/reports/ReportRoute ->
// pages/v2/reports/reports-registry.ts -> this file. The identically named
// pages/reports/JobProfitabilityReport.tsx is reached by no route and is
// deliberately not touched.
//
// The report renders a hardcoded fixture and says so on the page, so these are
// assertions about labels, plus one guard that the labels moved and the numbers
// did not.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import JobProfitabilityReport from '@/pages/v2/reports/reports/JobProfitabilityReport';

/** The download button shows only with Export reports (S07.20), and these tests click it. */
// Export reports needs Access Reports.
const CAN_EXPORT = buildAbility([{ action: 'export', subject: 'Report' }, { action: 'read', subject: 'Report' }]);

const hoisted = vi.hoisted(() => ({ exportCsvFile: vi.fn() }));

vi.mock('@/lib/csv', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/csv')>();
  return { ...actual, exportCsvFile: hoisted.exportCsvFile };
});

/** The on-screen column headers, in table order. */
function onScreenHeaders(): string[] {
  return screen.getAllByRole('columnheader').map((th) => (th.textContent ?? '').trim());
}

/** Click Export and return the header row the export was handed. */
async function exportedHeaders(): Promise<string[]> {
  await userEvent.click(screen.getByRole('button', { name: /export/i }));
  expect(hoisted.exportCsvFile).toHaveBeenCalledTimes(1);
  return hoisted.exportCsvFile.mock.calls[0]![1] as string[];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Job Profitability report vocabulary', () => {
  it('spells margin in full in the column headers', async () => {
    renderWithProviders(<JobProfitabilityReport />);
    await screen.findByRole('columnheader', { name: /job/i });

    const headers = onScreenHeaders();
    expect(headers).toContain('Margin');
    expect(headers).toContain('Margin %');
  });

  it('says neither "GM" nor "Gross Margin" anywhere it renders', async () => {
    renderWithProviders(<JobProfitabilityReport />);
    await screen.findByRole('columnheader', { name: /job/i });

    expect(document.body.textContent ?? '').not.toMatch(/\bGM\b|GM\s*%|Gross Margin/i);
  });

  it('exports header cells that match the on-screen headers exactly', async () => {
    renderWithProviders(<JobProfitabilityReport />, { ability: CAN_EXPORT });
    await screen.findByRole('columnheader', { name: /job/i });

    const headers = onScreenHeaders();
    const csv = await exportedHeaders();

    // Every column the reader saw is in the file under the same words, and the
    // file invents no vocabulary of its own for the two profitability columns.
    for (const header of headers) expect(csv).toContain(header);
    expect(csv.filter((h) => /margin/i.test(h))).toEqual(['Margin', 'Margin %']);
    expect(csv.some((h) => /\bGM\b|Gross Margin/i.test(h))).toBe(false);
  });

  it('moves the labels and not the figures', async () => {
    renderWithProviders(<JobProfitabilityReport />, { ability: CAN_EXPORT });
    await screen.findByRole('columnheader', { name: /job/i });

    // The fixture's ten jobs total $64,730 of revenue, and the thinnest-margin
    // job still sorts to the top with the same $410 at 4%. Both are unchanged
    // by this slice: only the words above the numbers moved.
    await exportedHeaders();
    const rows = hoisted.exportCsvFile.mock.calls[0]![2] as unknown[][];
    expect(rows).toHaveLength(10);
    expect(rows.reduce((sum, r) => sum + (r[5] as number), 0)).toBe(64730);
    expect(rows[0]).toEqual([
      'J10021', 'Diaz, Mara', 'AC Replacement', 'HVAC', 'completed', 11200, 10790, 410, '4%',
    ]);
  });
});
