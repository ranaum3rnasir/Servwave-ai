// Roles & Permissions S07.4 - the staging dialogs and the job page's staging section show a line's vendor only with
// View vendors and its unit cost only with See costs (read Vendor / read Pricing), and offer no write control
// without Edit stock (update Inventory). Abilities are built from the switches' grants, never from a role name. The
// Staging tab body has its own suite beside it (pages/v2/inventory/__tests__/stagingScreensHonest.test.tsx).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';

import api from '@/lib/axios';
import { buildAbility, type AbilityRule } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import type { JobStage } from '@/lib/api/inventory';

import { StageDetailDialog } from '@/components/inventory/StageDetailDialog';
import { StagePreviewDialog } from '@/components/inventory/StagePreviewDialog';
import { JobStagesSection } from '@/components/jobs/JobStagesSection';

const mockApi = vi.mocked(api);

const VIEW_STOCK: AbilityRule = { action: 'read', subject: 'Inventory' };
const EDIT_STOCK: AbilityRule = { action: 'update', subject: 'Inventory' };
const SEE_FINANCIAL_DATA: AbilityRule = { action: 'read', subject: 'Pricing' };
const VIEW_VENDORS: AbilityRule = { action: 'read', subject: 'Vendor' };

function makeStage(over: Partial<JobStage> = {}): JobStage {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    jobNumber: 'J-1900',
    customer: 'Acme Corp',
    site: '1 Main St',
    trade: 'security',
    status: 'complete',
    items: [
      {
        id: 'li-1', itemSku: 'CAM-01', itemName: 'Dome Camera', uom: 'EA', qtyOrdered: 2, qtyReceived: 2,
        vendor: 'Northwind Supply', poNumber: 'P00001', serialized: false, unitCost: 12.5,
      },
    ],
    photos: [],
    createdAt: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(((url: string) => {
    if (url === '/api/inventory/job-stages') return Promise.resolve({ data: { jobStages: [makeStage()] } });
    return Promise.resolve({ data: {} });
  }) as typeof mockApi.get);
});

/** The person's own switches, as the shared reader asks for them (the route guards read the same answer). */
function answerSwitches(values: Record<string, boolean>) {
  localStorage.clear();
  mockApi.get.mockImplementation(((url: string) => {
    if (url === '/api/inventory/job-stages') return Promise.resolve({ data: { jobStages: [makeStage()] } });
    if (url === '/api/permission-switches/me') return Promise.resolve({ data: { admin_box: false, values } });
    return Promise.resolve({ data: {} });
  }) as typeof mockApi.get);
}

function renderDetail(rules: AbilityRule[], stage = makeStage()) {
  return renderWithProviders(
    <StageDetailDialog open onClose={vi.fn()} stage={stage} locations={[]} onSave={vi.fn()} onReceiveOne={vi.fn()} />,
    { ability: buildAbility(rules) },
  );
}

function renderPreview(rules: AbilityRule[], stage = makeStage()) {
  return renderWithProviders(<StagePreviewDialog open onClose={vi.fn()} stage={stage} />, {
    ability: buildAbility(rules),
  });
}

describe('stage detail dialog - Edit stock gates every write control', () => {
  it('offers no Edit Stage, Email or attachment control with View stock alone', async () => {
    renderDetail([VIEW_STOCK]);

    await screen.findByText('Line items (1)');
    expect(screen.queryByRole('button', { name: /Edit Stage/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Email$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Take photo/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Upload file/ })).toBeNull();
  });

  it('offers them with Edit stock', async () => {
    renderDetail([VIEW_STOCK, EDIT_STOCK]);

    await screen.findByText('Line items (1)');
    expect(screen.getByRole('button', { name: /Edit Stage/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Email$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Take photo/ })).toBeInTheDocument();
  });
});

describe('stage detail dialog - line vendor and unit cost', () => {
  it('shows neither without View vendors and See costs', async () => {
    renderDetail([VIEW_STOCK]);

    await screen.findByText('Line items (1)');
    expect(screen.queryByText(/Northwind Supply/)).toBeNull();
    expect(screen.queryByText(/12\.50/)).toBeNull();
    expect(screen.queryByText(/\$0\.00/)).toBeNull();
  });

  it('shows the vendor with View vendors and the unit cost with See costs', async () => {
    renderDetail([VIEW_STOCK, VIEW_VENDORS, SEE_FINANCIAL_DATA]);

    expect(await screen.findByText(/Northwind Supply/)).toBeInTheDocument();
    expect(screen.getByText(/\$12\.50/)).toBeInTheDocument();
  });

  it('draws no unit cost for a line the response sent without one, even with See costs', async () => {
    const noCost = makeStage();
    delete noCost.items[0]!.unitCost;
    renderDetail([VIEW_STOCK, SEE_FINANCIAL_DATA], noCost);

    await screen.findByText('Line items (1)');
    expect(screen.queryByText(/unit cost/i)).toBeNull();
    expect(screen.queryByText(/\$0\.00/)).toBeNull();
  });
});

describe('pickup ticket preview - vendor column and cost figures', () => {
  it('has no vendor, unit cost column or "Est. value at cost" without the switches', async () => {
    renderPreview([VIEW_STOCK]);

    await screen.findByText('Dome Camera');
    expect(screen.queryByText(/Northwind Supply/)).toBeNull();
    expect(screen.queryByText(/Unit cost/i)).toBeNull();
    expect(screen.queryByText(/Est\. value at cost/)).toBeNull();
    expect(screen.queryByText(/\$0\.00/)).toBeNull();
  });

  it('shows the vendor with View vendors and the cost figures with See costs', async () => {
    renderPreview([VIEW_STOCK, VIEW_VENDORS, SEE_FINANCIAL_DATA]);

    expect(await screen.findByText(/Northwind Supply/)).toBeInTheDocument();
    expect(screen.getByText('Unit cost')).toBeInTheDocument();
    expect(screen.getByText('$12.50')).toBeInTheDocument();
    // 2 ordered x $12.50
    expect(screen.getByText(/Est\. value at cost/)).toBeInTheDocument();
    expect(screen.getByText('$25.00')).toBeInTheDocument();
  });

  it('never prints a zero cost for a line with no cost: no total when no line has one', async () => {
    const noCost = makeStage();
    delete noCost.items[0]!.unitCost;
    renderPreview([VIEW_STOCK, SEE_FINANCIAL_DATA], noCost);

    await screen.findByText('Dome Camera');
    expect(screen.queryByText(/Est\. value at cost/)).toBeNull();
    expect(screen.queryByText(/\$0\.00/)).toBeNull();
  });
});

describe("job page staging section - the response's lines, read only", () => {
  it('drops the vendor and leaves the PO number alone, with nothing dangling, without View vendors', async () => {
    renderWithProviders(<JobStagesSection jobId="job-1" />, { ability: buildAbility([VIEW_STOCK]) });

    const po = await screen.findByText(/P00001/);
    expect(screen.queryByText(/Northwind Supply/)).toBeNull();
    expect(po.textContent?.trim().startsWith('·')).toBe(false);
    expect(screen.queryByText(/12\.50/)).toBeNull();
  });

  it('shows the vendor with View vendors and the unit cost with See costs', async () => {
    renderWithProviders(<JobStagesSection jobId="job-1" />, {
      ability: buildAbility([VIEW_STOCK, VIEW_VENDORS, SEE_FINANCIAL_DATA]),
    });

    expect(await screen.findByText(/Northwind Supply/)).toBeInTheDocument();
    expect(screen.getByText(/\$12\.50/)).toBeInTheDocument();
  });

  it('offers the link into the Inventory page only to someone the Stock page route lets in (View stock)', async () => {
    // An attached person with View stock off reads the job's stages, but the Staging tab behind the link is not theirs.
    answerSwitches({});
    const none = renderWithProviders(<JobStagesSection jobId="job-1" />, { ability: buildAbility([]) });
    await screen.findByText(/Dome Camera/);
    expect(screen.queryByRole('link', { name: /Open in Inventory/ })).toBeNull();
    none.unmount();

    // View stock off: the route sends them to the dashboard, so the link is not drawn.
    answerSwitches({ view_stock: false });
    const hidden = renderWithProviders(<JobStagesSection jobId="job-1" />, { ability: buildAbility([VIEW_STOCK]) });
    await screen.findByText(/Dome Camera/);
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/permission-switches/me'));
    expect(screen.queryByRole('link', { name: /Open in Inventory/ })).toBeNull();
    hidden.unmount();

    answerSwitches({ view_stock: true });
    renderWithProviders(<JobStagesSection jobId="job-1" />, { ability: buildAbility([VIEW_STOCK]) });
    expect(await screen.findByRole('link', { name: /Open in Inventory/ })).toBeInTheDocument();
  });

  it('is a read-only section: no write control for a person with every write switch either', async () => {
    renderWithProviders(<JobStagesSection jobId="job-1" />, {
      ability: buildAbility([VIEW_STOCK, EDIT_STOCK, { action: 'create', subject: 'Inventory' }]),
    });

    await screen.findByText(/Dome Camera/);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
