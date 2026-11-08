// Open logistics orders / POs available to convert into job staging entries.
// Per PRD §7.2 (PO creation), §7.4 (receiving + partial receipts).

export type POStatus = "draft" | "ordered" | "partial" | "received" | "closed" | "cancelled";

export type POLine = {
  itemSku: string; // matches Item.sku in inventory.ts
  itemName: string;
  uom: string;
  qtyOrdered: number;
  qtyReceived: number;
};

export type PurchaseOrder = {
  id: string;
  poNumber: string;
  vendor: string;
  status: POStatus;
  jobNumber?: string;        // optional — link to a job already
  customer?: string;
  site?: string;
  trade?: "locksmith" | "door" | "security" | "hvac" | "plumbing" | "multi";
  orderedAt: string;
  expectedDate?: string;
  lines: POLine[];
  stagedAsJobStageId?: string; // set once a staging entry has been created
};

export const purchaseOrders: PurchaseOrder[] = [
  {
    id: "po_2305",
    poNumber: "PO-2305",
    vendor: "ADI / Anixter",
    status: "ordered",
    jobNumber: "J-1862",
    customer: "Equinox Hudson Yards",
    site: "33 Hudson Yards, NY · Lobby 1 access control",
    trade: "security",
    orderedAt: "2026-05-23T11:00:00Z",
    expectedDate: "2026-05-27T00:00:00Z",
    lines: [
      { itemSku: "DSC-NEO-HS2128", itemName: "DSC PowerSeries Neo HS2128 Alarm Panel", uom: "EA", qtyOrdered: 1, qtyReceived: 0 },
      { itemSku: "HID-PROX-26", itemName: "HID ProxPoint Plus Reader, Wiegand 26", uom: "EA", qtyOrdered: 8, qtyReceived: 0 },
      { itemSku: "HES-1006-630", itemName: "HES 1006 Electric Strike, 12/24 VDC, 630 Finish", uom: "EA", qtyOrdered: 4, qtyReceived: 0 },
    ],
  },
  {
    id: "po_2308",
    poNumber: "PO-2308",
    vendor: "Ferguson HVAC",
    status: "ordered",
    jobNumber: "J-1865",
    customer: "Whole Foods Gowanus",
    site: "214 3rd St, Brooklyn · Rooftop AHU-3",
    trade: "hvac",
    orderedAt: "2026-05-23T15:20:00Z",
    expectedDate: "2026-05-26T00:00:00Z",
    lines: [
      { itemSku: "HVC-CAP-45-5", itemName: "Dual Run Capacitor 45/5 MFD 440V", uom: "EA", qtyOrdered: 4, qtyReceived: 0 },
      { itemSku: "HVC-FIL-20X25-M11", itemName: "Pleated Air Filter 20x25x1, MERV 11", uom: "EA", qtyOrdered: 24, qtyReceived: 0 },
      { itemSku: "HVC-R410A-25LB", itemName: "R-410A Refrigerant, 25 lb Cylinder", uom: "CYL", qtyOrdered: 2, qtyReceived: 0 },
    ],
  },
  {
    id: "po_2311",
    poNumber: "PO-2311",
    vendor: "ASA / Mul-T-Lock NA",
    status: "ordered",
    jobNumber: "J-1868",
    customer: "Tiffany & Co · 5th Ave",
    site: "727 Fifth Ave, NY · Vault retrofit",
    trade: "locksmith",
    orderedAt: "2026-05-23T17:10:00Z",
    expectedDate: "2026-05-29T00:00:00Z",
    lines: [
      { itemSku: "ASA-MUL-C-114", itemName: "Mul-T-Lock C-Series Cylinder, IC Core, 6-Pin", uom: "EA", qtyOrdered: 18, qtyReceived: 0 },
      { itemSku: "KAB-PEAKS-IC-T7", itemName: "Kaba Peaks Preferred IC 7-Pin Cylinder", uom: "EA", qtyOrdered: 6, qtyReceived: 0 },
    ],
  },
  {
    id: "po_2314",
    poNumber: "PO-2314",
    vendor: "Winsupply",
    status: "ordered",
    orderedAt: "2026-05-24T08:30:00Z",
    expectedDate: "2026-05-28T00:00:00Z",
    lines: [
      { itemSku: "PLB-COP-3-4-L", itemName: "Copper Pipe, Type L, 3/4 in × 10 ft", uom: "FT", qtyOrdered: 120, qtyReceived: 0 },
      { itemSku: "PLB-PEX-1-2-RED", itemName: "PEX-A Tubing, 1/2 in × 100 ft, Red", uom: "ROLL", qtyOrdered: 6, qtyReceived: 0 },
    ],
  },
  {
    id: "po_2261",
    poNumber: "PO-2261",
    vendor: "ADI / Anixter",
    status: "partial",
    jobNumber: "J-1850",
    customer: "Rolex 5th Ave",
    site: "665 Fifth Ave, NY · Vault corridor",
    trade: "multi",
    orderedAt: "2026-05-18T09:30:00Z",
    expectedDate: "2026-05-26T00:00:00Z",
    lines: [
      { itemSku: "ASA-MUL-C-114", itemName: "Mul-T-Lock C-Series Cylinder, IC Core, 6-Pin", uom: "EA", qtyOrdered: 12, qtyReceived: 12 },
      { itemSku: "HES-1006-630", itemName: "HES 1006 Electric Strike, 12/24 VDC, 630 Finish", uom: "EA", qtyOrdered: 4, qtyReceived: 3 },
      { itemSku: "HID-PROX-26", itemName: "HID ProxPoint Plus Reader, Wiegand 26", uom: "EA", qtyOrdered: 6, qtyReceived: 0 },
    ],
    stagedAsJobStageId: "stg_001",
  },
  {
    id: "po_2275",
    poNumber: "PO-2275",
    vendor: "Winsupply",
    status: "received",
    jobNumber: "J-1845",
    customer: "Hudson Yards Condo Bldg 12B",
    site: "517 W 35th St, NY · Unit 1402 plumbing rough-in",
    trade: "plumbing",
    orderedAt: "2026-05-19T14:20:00Z",
    expectedDate: "2026-05-23T00:00:00Z",
    lines: [
      { itemSku: "PLB-COP-3-4-L", itemName: "Copper Pipe, Type L, 3/4 in × 10 ft", uom: "FT", qtyOrdered: 80, qtyReceived: 80 },
      { itemSku: "PLB-PEX-1-2-RED", itemName: "PEX-A Tubing, 1/2 in × 100 ft, Red", uom: "ROLL", qtyOrdered: 4, qtyReceived: 4 },
    ],
    stagedAsJobStageId: "stg_004",
  },
  {
    id: "po_2289",
    poNumber: "PO-2289",
    vendor: "ADI / Anixter",
    status: "ordered",
    jobNumber: "J-1853",
    customer: "TikTok TriBeCa Office",
    site: "151 Hudson St, NY · Floor 14 access control retrofit",
    trade: "security",
    orderedAt: "2026-05-22T10:00:00Z",
    expectedDate: "2026-05-28T00:00:00Z",
    lines: [
      { itemSku: "DSC-NEO-HS2128", itemName: "DSC PowerSeries Neo HS2128 Alarm Panel", uom: "EA", qtyOrdered: 2, qtyReceived: 0 },
      { itemSku: "HID-PROX-26", itemName: "HID ProxPoint Plus Reader, Wiegand 26", uom: "EA", qtyOrdered: 14, qtyReceived: 0 },
    ],
    stagedAsJobStageId: "stg_003",
  },
  {
    id: "po_2280",
    poNumber: "PO-2280",
    vendor: "Ferguson HVAC",
    status: "received",
    jobNumber: "J-1851",
    customer: "McDonald's Atlantic Ave",
    trade: "hvac",
    orderedAt: "2026-05-20T12:00:00Z",
    lines: [
      { itemSku: "HVC-CAP-45-5", itemName: "Dual Run Capacitor 45/5 MFD 440V", uom: "EA", qtyOrdered: 2, qtyReceived: 2 },
      { itemSku: "HVC-FIL-20X25-M11", itemName: "Pleated Air Filter 20x25x1, MERV 11", uom: "EA", qtyOrdered: 8, qtyReceived: 8 },
    ],
    stagedAsJobStageId: "stg_002", // already linked to McDonald's stage
  },
  // ─── Pre-PO seed data (drafts only — RFQs + Estimate Reservations live in
  //     pre-po.ts as separate types because they carry richer per-vendor /
  //     per-estimate metadata that doesn't fit the PurchaseOrder shape).
  //     PRD §7.X (Purchase Orders page · Pre-PO tab).
  {
    id: "po_2317_draft",
    poNumber: "PO-2317",
    vendor: "ADI / Anixter",
    status: "draft",
    jobNumber: "J-1870",
    customer: "WeWork Dumbo",
    site: "55 Prospect St, Brooklyn · Floor 3 access retrofit",
    trade: "security",
    orderedAt: "2026-05-27T14:00:00Z",
    expectedDate: "2026-06-02T00:00:00Z",
    lines: [
      { itemSku: "HID-PROX-26", itemName: "HID ProxPoint Plus Reader, Wiegand 26", uom: "EA", qtyOrdered: 6, qtyReceived: 0 },
      { itemSku: "HES-1006-630", itemName: "HES 1006 Electric Strike, 12/24 VDC, 630 Finish", uom: "EA", qtyOrdered: 3, qtyReceived: 0 },
    ],
  },
  {
    id: "po_2318_draft",
    poNumber: "PO-2318",
    vendor: "Ferguson HVAC",
    status: "draft",
    orderedAt: "2026-05-26T09:15:00Z",
    expectedDate: "2026-06-01T00:00:00Z",
    lines: [
      { itemSku: "HVC-FIL-20X25-M11", itemName: "Pleated Air Filter 20x25x1, MERV 11", uom: "EA", qtyOrdered: 48, qtyReceived: 0 },
    ],
  },
];
