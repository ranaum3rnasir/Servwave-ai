// S3.1 (PRD 3) — the Create PO dialog sends real ids and a unit cost per line.
//
// Contract under test:
//   • Picking a vendor writes `vendorId` (the FK) AND the legacy `vendor` name snapshot.
//   • Linking a job writes `jobId` + `customerId` (no more name-only job links).
//   • Every line carries `unitCost`: defaulted from the picked catalog item, editable,
//     and an explicit `null` when the operator blanks the money input.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { NewPODialog } from '@/components/inventory/NewPODialog';
import type { Item, Vendor, InventoryJob, NewPOInput } from '@/lib/api/inventory';

const VENDOR_ID = 'ccccccc1-0000-4000-8000-000000000001';
const OTHER_VENDOR_ID = 'ccccccc1-0000-4000-8000-000000000002';
const ITEM_ID = 'bbbbbbb1-0000-4000-8000-000000000001';
const UNCOSTED_ITEM_ID = 'bbbbbbb1-0000-4000-8000-000000000002';
const JOB_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const CUSTOMER_ID = 'd1d1d1d1-0000-4000-8000-000000000001';

const vendors = [
  { id: VENDOR_ID, name: 'ADI / Anixter', category: 'Security', status: 'active' },
  { id: OTHER_VENDOR_ID, name: 'Banner Solutions', category: 'Hardware', status: 'active' },
] as unknown as Vendor[];

const items = [
  {
    id: ITEM_ID, sku: 'HES-1006', name: 'HES 1006 Electric Strike', category: 'Hardware', trade: 'security',
    kind: 'material', uom: 'EA', unitCost: 120, sellPrice: 199, serialized: false, hazmat: false,
    status: 'active', vendor: 'ADI / Anixter', stock: [], updatedAt: '2026-07-01T00:00:00Z',
  },
  {
    // No catalog cost (cost-stripped or never priced) — the input starts blank.
    id: UNCOSTED_ITEM_ID, sku: 'MISC-1', name: 'Misc anchors', category: 'Hardware', trade: 'security',
    kind: 'material', uom: 'EA', sellPrice: 5, serialized: false, hazmat: false,
    status: 'active', vendor: 'ADI / Anixter', stock: [], updatedAt: '2026-07-01T00:00:00Z',
  },
] as unknown as Item[];

const jobs: InventoryJob[] = [
  {
    id: JOB_ID, jobNumber: 'J-1870', customer: 'Equinox Hudson Yards', site: '33 Hudson Yards, New York, NY 10001',
    trade: 'multi', status: 'scheduled', scheduledFor: '2026-09-10T14:00:00Z', customerId: CUSTOMER_ID,
  },
];

function renderDialog() {
  const onCreate = vi.fn<(po: NewPOInput) => void>();
  const onClose = vi.fn();
  renderWithProviders(
    <NewPODialog open onClose={onClose} onCreate={onCreate} vendors={vendors} items={items} existingPOs={[]} jobs={jobs} />,
  );
  return { onCreate, onClose };
}

async function pickVendor(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('combobox', { name: 'Vendor' }));
  await user.click(await screen.findByRole('option', { name }));
}

// Opens the picker on the LAST still-empty row (a picked row's trigger shows the
// item name, not the placeholder) and chooses `itemName`.
async function pickItem(user: ReturnType<typeof userEvent.setup>, itemName: string) {
  const empties = screen.getAllByRole('button', { name: /pick an item/i });
  await user.click(empties[empties.length - 1]);
  const picker = await screen.findByRole('dialog', { name: 'Pick an item' });
  await user.click(within(picker).getByRole('button', { name: new RegExp(itemName) }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('NewPODialog — create payload carries real ids and a unit cost per line (S3.1)', () => {
  it('sends vendorId + vendor, jobId + customerId, and the catalog-defaulted unitCost', async () => {
    const user = userEvent.setup();
    const { onCreate } = renderDialog();

    await pickVendor(user, 'ADI / Anixter');
    await pickItem(user, 'HES 1006 Electric Strike');

    // Unit cost pre-fills from the catalog item and is editable.
    const cost = screen.getByRole('spinbutton', { name: 'Unit cost for HES 1006 Electric Strike' }) as HTMLInputElement;
    expect(cost.value).toBe('120');

    // Link the job through the typeahead.
    await user.type(screen.getByPlaceholderText(/find a job by #/i), '1870');
    await user.click(await screen.findByRole('button', { name: /J-1870/ }));
    expect(screen.getByRole('button', { name: /unlink/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /save draft po/i }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    const payload = onCreate.mock.calls[0][0];
    expect(payload).toMatchObject({
      vendor: 'ADI / Anixter',
      vendorId: VENDOR_ID,
      status: 'draft',
      jobId: JOB_ID,
      customerId: CUSTOMER_ID,
      jobNumber: 'J-1870',
      customer: 'Equinox Hudson Yards',
    });
    expect(payload.lines).toEqual([
      { itemSku: 'HES-1006', itemName: 'HES 1006 Electric Strike', uom: 'EA', qtyOrdered: 1, qtyReceived: 0, unitCost: 120 },
    ]);
    // A draft carries no order date — "ordered" never means "created".
    expect(payload).not.toHaveProperty('orderedAt');
  });

  it('an overridden unit cost wins; a blanked one is sent as null; no job link sends no ids', async () => {
    const user = userEvent.setup();
    const { onCreate } = renderDialog();

    await pickVendor(user, 'Banner Solutions');
    await pickItem(user, 'HES 1006 Electric Strike');
    await user.click(screen.getByRole('button', { name: /add line/i }));
    await pickItem(user, 'Misc anchors');

    const first = screen.getByRole('spinbutton', { name: 'Unit cost for HES 1006 Electric Strike' });
    await user.clear(first);
    await user.type(first, '99.5');

    // The uncosted catalog item starts blank and stays blank.
    const second = screen.getByRole('spinbutton', { name: 'Unit cost for Misc anchors' }) as HTMLInputElement;
    expect(second.value).toBe('');

    await user.click(screen.getByRole('button', { name: /save draft po/i }));

    const payload = onCreate.mock.calls[0][0];
    expect(payload.vendorId).toBe(OTHER_VENDOR_ID);
    expect(payload.vendor).toBe('Banner Solutions');
    expect(payload.jobId).toBeUndefined();
    expect(payload.customerId).toBeUndefined();
    expect(payload.lines.map((l) => l.unitCost)).toEqual([99.5, null]);
  });

  it('refuses a negative unit cost and does not create', async () => {
    const user = userEvent.setup();
    const { onCreate } = renderDialog();

    await pickVendor(user, 'ADI / Anixter');
    await pickItem(user, 'HES 1006 Electric Strike');
    const cost = screen.getByRole('spinbutton', { name: 'Unit cost for HES 1006 Electric Strike' });
    await user.clear(cost);
    await user.type(cost, '-4');

    await user.click(screen.getByRole('button', { name: /save draft po/i }));

    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByText(/unit cost for "HES 1006 Electric Strike"/i)).toBeInTheDocument();
  });
});
