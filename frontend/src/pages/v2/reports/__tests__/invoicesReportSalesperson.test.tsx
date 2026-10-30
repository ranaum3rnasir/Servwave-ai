/**
 * Roles & Permissions S03.10 - the Invoices report people actually open (the v2 page behind /reports/invoices).
 *
 * The salesperson column is the job's stored Sold By (a service plan's own invoice shows the plan's Sold by), and the
 * server sends a dash for an empty seller. The help line under the table must say that, and the page must show what
 * the server sent, with no label of its own for the empty case.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';

const ROWS = [
  {
    number: 'INV-1', client: 'Pat Example', email: 'pat@example.test', created: Date.parse('2026-06-01T12:00:00Z'),
    subtotal: 100, tax: 0, discountPct: 0, amount: 100, due: 100, status: 'Due', job: '1001',
    salesperson: 'Maria Lopez', technician: 'Tom Becker', jobType: 'Install',
  },
  {
    number: 'INV-2', client: 'Sam Example', email: 'sam@example.test', created: Date.parse('2026-06-02T12:00:00Z'),
    subtotal: 200, tax: 0, discountPct: 0, amount: 200, due: 200, status: 'Paid', job: '1002',
    salesperson: '—', technician: '—', jobType: 'Repair',
  },
];

vi.mock('@/lib/reports/invoices-data', async (orig) => {
  const actual = await orig<typeof import('@/lib/reports/invoices-data')>();
  return { ...actual, useInvoicesReport: () => ({ rows: ROWS, now: new Date('2026-06-06T12:00:00Z'), isLoading: false }) };
});

import InvoicesReport from '../reports/InvoicesReport';

const ABILITY = buildAbility([{ action: 'read', subject: 'Report' }]);

describe('Invoices report (routed page): salesperson wording', () => {
  it('says the salesperson is the job\'s Sold By, not the estimate\'s lead commission owner', () => {
    renderWithProviders(<InvoicesReport />, { ability: ABILITY });
    expect(screen.getByText(/salesperson maps to the job's Sold By/i)).toBeInTheDocument();
    expect(screen.getByText(/service plan's invoice shows the plan's Sold by/i)).toBeInTheDocument();
    expect(screen.queryByText(/lead commission owner/i)).toBeNull();
  });

  it('shows the seller the server sent, dash included, with no label of its own for an empty one', () => {
    renderWithProviders(<InvoicesReport />, { ability: ABILITY });
    expect(screen.getByText('Maria Lopez')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.queryByText(/unassigned/i)).toBeNull();
  });
});
