// #2043 slice 2 - new RED/GREEN pairs for gates the frozen `repro-2043.test.tsx`
// does not pin (R14: every new gate needs its own pair). The frozen test is
// read-only; these cases live here, mirroring `stockAbilityGate.test.tsx` /
// `purchasingAbilityGate.test.tsx`'s shape.
//
// Covers (Lead UI-pass residual): `StageDetailDialog`'s attachments card
// still showed the capture instructions paragraph ("Photos, videos, and PDF
// pages all count...") to a requester without `update Inventory`, even
// though the buttons that instruction describes are already gated.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders, inventoryWriteAbility } from '@/__tests__/helpers';

import { StageDetailDialog } from '@/components/inventory/StageDetailDialog';
import type { JobStage } from '@/lib/api/inventory';

const mockApi = vi.mocked(api);

const STAGE_ID = '11111111-2222-4333-8444-555555555555';

function makeStage(overrides: Partial<JobStage> = {}): JobStage {
  return {
    id: STAGE_ID,
    jobNumber: 'J-1900',
    customer: 'Acme Corp',
    site: '1 Main St',
    trade: 'security',
    // Finished (not "awaiting"/"partial"), so `editing` seeds false regardless
    // of the ability - both cases below land on the same non-editing render branch.
    status: 'complete',
    items: [
      {
        id: 'li-1', itemSku: 'CAM-01', itemName: 'Dome Camera', uom: 'EA',
        qtyOrdered: 2, qtyReceived: 2, vendor: 'Acme', poNumber: 'P00001', serialized: false,
      },
    ],
    photos: [],
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderDialog(ability: ReturnType<typeof buildAbility>) {
  return renderWithProviders(
    <StageDetailDialog
      open
      onClose={vi.fn()}
      stage={makeStage()}
      locations={[]}
      onSave={vi.fn()}
      onReceiveOne={vi.fn()}
    />,
    { ability },
  );
}

const readOnlyAbility = () => buildAbility([{ action: 'read', subject: 'Inventory' }]);

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(((url: string) => {
    if (url === '/api/inventory/vendors') return Promise.resolve({ data: { vendors: [] } });
    if (url === '/api/inventory/techs') return Promise.resolve({ data: { techs: [] } });
    return Promise.resolve({ data: {} });
  }) as typeof mockApi.get);
});

describe('#2043 — StageDetailDialog attachments capture instructions (Lead UI-pass residual)', () => {
  it('hides the capture instructions without update Inventory, keeps the label/badge/empty state', async () => {
    renderDialog(readOnlyAbility());

    expect(await screen.findByText(/Staging attachments \(0\)/)).toBeInTheDocument();
    expect(screen.getByText(/required before/i)).toBeInTheDocument();
    expect(screen.getByText('No attachments yet.')).toBeInTheDocument();
    expect(screen.queryByText(/Photos, videos, and PDF pages all count/i)).not.toBeInTheDocument();
  });

  it('keeps the capture instructions with update Inventory (must stay green)', async () => {
    renderDialog(inventoryWriteAbility());

    expect(await screen.findByText(/Photos, videos, and PDF pages all count/i)).toBeInTheDocument();
  });
});

// #2043 R14 / R4 — the in-progress editing seed. Base `makeStage()` above
// opens `complete` (finished), which lands `editing` false regardless of
// ability - it never exercises the seed. These fixtures are `awaiting`
// (isInProgress = true) with a not-yet-fully-received line, the exact shape
// the R4/H19 trap needs: before the fix, `editing` was seeded from
// `isInProgress` alone, so a read-only requester on an in-progress stage
// opened straight into edit mode with live qtyReceived inputs.
function makeInProgressStage(overrides: Partial<JobStage> = {}): JobStage {
  return makeStage({
    status: 'awaiting',
    items: [
      {
        id: 'li-1', itemSku: 'CAM-01', itemName: 'Dome Camera', uom: 'EA',
        qtyOrdered: 2, qtyReceived: 0, vendor: 'Acme', poNumber: 'P00001', serialized: false,
      },
    ],
    ...overrides,
  });
}

function renderInProgressDialog(ability: ReturnType<typeof buildAbility>) {
  return renderWithProviders(
    <StageDetailDialog
      open
      onClose={vi.fn()}
      stage={makeInProgressStage()}
      locations={[]}
      onSave={vi.fn()}
      onReceiveOne={vi.fn()}
    />,
    { ability },
  );
}

describe('#2043 — StageDetailDialog in-progress stage (R4: editing seed + Receive +1)', () => {
  it('a read-only ability never enters edit mode on an in-progress stage: no qtyReceived input, no Receive +1', async () => {
    renderInProgressDialog(readOnlyAbility());

    await screen.findByText('Line items (1)');
    // The per-line qtyReceived <Input type="number"> renders only under
    // `editing` - a read-only requester must never land there.
    expect(screen.queryAllByRole('spinbutton')).toHaveLength(0);
    // R4.2's own trap: `!editing && !done && canUpdate` - if `Receive +1`
    // ever loses its own `canUpdate` clause, a read-only requester (whose
    // `editing` is correctly false) would see it appear.
    expect(screen.queryByRole('button', { name: 'Receive +1' })).toBeNull();
  });

  it('a write ability seeds edit mode on an in-progress stage with the qtyReceived input (must stay green)', async () => {
    renderInProgressDialog(inventoryWriteAbility());

    await screen.findByText('Line items (1)');
    expect(screen.getAllByRole('spinbutton').length).toBeGreaterThan(0);
  });
});
