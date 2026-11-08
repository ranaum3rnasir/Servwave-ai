// Issue #357 — Dialer customer panel: PO numbers are clickable links.
//
// Contract under test (preserved across the slice-2.2 CustomerPanel rework):
//   • In CustomerPanel, a linked PO's number renders as a navigating button
//     with the same hover-underline/primary affordance as the job chips, for
//     a PO of ANY status.
//   • Clicking the PO number routes through requestLeave → navigate to
//     `/inventory/purchase-orders?q=<PO>&status=<status>` — the status param
//     is what lets the PO list page select the correct tab.
//   • Clicking the PO number does NOT toggle the line-items accordion; the
//     rest of the row (vendor / status pill / chevron) still does.
//   • The PO section stays keyed off the picked JOB (focusedJobId).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import {
  CustomerPanel,
  type DialerSelection,
} from '@/components/communication/phone/Dialer';
import type { PurchaseOrder } from '@/lib/api/inventory';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockApi = vi.mocked(api);

const JOB_NUMBER = 'J-1845';
const JOB_UUID = 'b0000000-0000-0000-0000-000000000042';

const PO_FIXTURES: PurchaseOrder[] = [
  {
    id: 'po_2275',
    poNumber: 'PO-2275',
    vendor: 'Winsupply',
    status: 'received',
    jobNumber: JOB_NUMBER,
    orderedAt: '2026-05-19T14:20:00Z',
    lines: [
      {
        itemSku: 'PLB-COP-3-4-L',
        itemName: 'Copper Pipe, Type L, 3/4 in x 10 ft',
        uom: 'FT',
        qtyOrdered: 80,
        qtyReceived: 80,
      },
    ],
  },
  {
    id: 'po_2305',
    poNumber: 'PO-2305',
    vendor: 'ADI / Anixter',
    status: 'ordered',
    jobNumber: JOB_NUMBER,
    orderedAt: '2026-05-23T11:00:00Z',
    lines: [
      {
        itemSku: 'HID-PROX-26',
        itemName: 'HID ProxPoint Plus Reader, Wiegand 26',
        uom: 'EA',
        qtyOrdered: 8,
        qtyReceived: 0,
      },
    ],
  },
];

const SELECTION: DialerSelection = {
  customer: {
    id: 'c0000000-0000-0000-0000-00000000012b',
    name: 'Hudson Yards Condo Bldg 12B',
    phone: '2125550142',
    site: '517 W 35th St, NY',
  },
  jobs: [
    {
      id: JOB_UUID,
      number: JOB_NUMBER,
      status: 'IN_PROGRESS',
      location: '517 W 35th St, NY · Unit 1402 plumbing rough-in',
    },
  ],
  focusedJobId: JOB_UUID,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/inventory/purchase-orders') {
      return Promise.resolve({ data: { purchaseOrders: PO_FIXTURES } });
    }
    return Promise.resolve({ data: {} });
  });
});

function renderPanel() {
  return renderWithProviders(
    <CustomerPanel selection={SELECTION} calls={[]} onCall={() => {}} />,
  );
}

describe('Dialer CustomerPanel — PO number links (#357)', () => {
  it('renders each PO number as a link-styled button, for any status', async () => {
    renderPanel();

    const received = await screen.findByRole('button', { name: 'PO-2275' });
    const sent = await screen.findByRole('button', { name: 'PO-2305' });
    for (const btn of [received, sent]) {
      expect(btn.className).toContain('hover:underline');
      expect(btn.className).toContain('hover:text-primary');
    }
  });

  it('clicking a received PO number navigates with q + status params', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'PO-2275' }));
    expect(mockNavigate).toHaveBeenCalledWith(
      '/inventory/purchase-orders?q=PO-2275&status=received',
    );
  });

  it('clicking an ordered PO number navigates with q + status params', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'PO-2305' }));
    expect(mockNavigate).toHaveBeenCalledWith(
      '/inventory/purchase-orders?q=PO-2305&status=ordered',
    );
  });

  it('clicking the PO number does NOT open the line-items accordion; the toggle area still does', async () => {
    const user = userEvent.setup();
    renderPanel();

    // Number click → no accordion
    await user.click(await screen.findByRole('button', { name: 'PO-2275' }));
    expect(
      screen.queryByText('Copper Pipe, Type L, 3/4 in x 10 ft'),
    ).not.toBeInTheDocument();

    // Vendor/toggle click → accordion opens with the line item
    await user.click(screen.getByRole('button', { name: /Winsupply/ }));
    expect(
      await screen.findByText('Copper Pipe, Type L, 3/4 in x 10 ft'),
    ).toBeInTheDocument();
  });
});
