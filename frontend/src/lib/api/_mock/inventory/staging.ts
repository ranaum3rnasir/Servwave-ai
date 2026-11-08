// Job-specific staging: tracks items received against jobs (partial shipments,
// backorders, ready-for-pickup). Per PRD §7.4 (partial receipts + back-order
// per line) and §5.2.1 (job_staging location type).

export type StagingStatus =
  | "awaiting"
  | "partial"
  | "complete"
  | "ready_for_pickup"
  | "delivered";

export type StagedItem = {
  id: string;
  itemSku: string;
  itemName: string;
  uom: string;
  qtyOrdered: number;
  qtyReceived: number;
  // qtyBackordered = qtyOrdered - qtyReceived (derived but kept for clarity)
  vendor: string;
  poNumber: string;
  expectedDate?: string; // for backordered items
  serialized: boolean;
  receivedSerials?: string[];
};

export type StageAuditEntry = {
  id: string;
  at: string;             // ISO timestamp
  actorName: string;
  field: string;          // e.g. "notes", "assignedTech", "items[0].qtyReceived"
  oldValue?: string;
  newValue: string;
  comment?: string;
};

// Staging attachments: warehouse staff capture visual evidence of staged
// parts before flipping a job to "ready_for_pickup". Supports photos,
// videos, and PDF pages (PDF pages are rendered to images at upload time
// via pdf.js — see StageDetailDialog.uploadFiles). At least ONE attachment
// is required to enter ready_for_pickup — enforced in the UI.
export type StageAttachmentKind = "image" | "video";

export type StageAttachment = {
  id: string;
  kind: StageAttachmentKind;
  dataUrl: string;         // base64 data-URI (legacy rows) OR short-lived signed URL (Storage rows, P5)
  mimeType?: string;       // e.g. "image/jpeg", "video/mp4", "image/png" (for PDF-derived pages)
  caption?: string;
  uploadedAt: string;
  uploadedBy: string;
  // Provenance — surfaced in the audit log + tooltip so reviewers know
  // whether the image came straight from a camera or was extracted from
  // a multi-page PDF (e.g. a packing slip).
  source?: "camera" | "upload" | "pdf-page";
  pdfPageNumber?: number;  // present when source === "pdf-page"
  pdfFileName?: string;    // present when source === "pdf-page"
  durationSeconds?: number; // for video
  sizeBytes?: number;
  // Optional: scope an attachment to a specific PO so techs can match
  // which photos go with which boxes when items are co-staged.
  poNumber?: string;
};

// Back-compat alias — older code paths import StagePhoto.
export type StagePhoto = StageAttachment;

export type JobStage = {
  id: string;
  jobNumber: string;
  customer: string;
  site: string;
  scheduledFor?: string; // ISO date — when the job is on the calendar
  assignedTechId?: string; // links to techs.ts
  assignedTech?: string;   // legacy display name (kept for back-compat)
  trade: "locksmith" | "door" | "security" | "hvac" | "plumbing" | "multi";
  status: StagingStatus;
  pickupVendorId?: string;     // NEW: vendor we're picking up from
  pickupAddress?: string;      // NEW: pickup location override (defaults to vendor's address)
  stagedLocationId?: string;   // optional now — where parts END UP after pickup
  stagedArea?: string;         // NEW (rev 2026-05-26): zone within stagedLocation, e.g. "Zone A — Receiving Dock". Lets warehouse staff tell techs exactly where in the building the parts are sitting once the stage is complete. Free-form so each branch can shape its own floor plan; see Location.stagingAreas for the configured options.
  items: StagedItem[];
  photos?: StageAttachment[];  // staging attachments (image / video / PDF page) — at least one required before status can flip to ready_for_pickup
  notes?: string;
  createdAt: string;
  updatedAt?: string;
  auditLog?: StageAuditEntry[];
};

// Tiny inline SVG placeholder so seed data is fully offline-friendly. In
// production these dataUrls are JPEG/PNG bytes uploaded from the warehouse
// floor (phone camera) or pasted from clipboard.
const demoPhotoSvg = (label: string, hue: number) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},60%,55%)"/><stop offset="1" stop-color="hsl(${hue + 30},70%,40%)"/></linearGradient></defs><rect width="400" height="300" fill="url(#g)"/><g fill="rgba(255,255,255,0.92)" font-family="system-ui,sans-serif" text-anchor="middle"><text x="200" y="140" font-size="22" font-weight="700">${label}</text><text x="200" y="170" font-size="13" opacity="0.85">Staged · J-1845 · 2026-05-24</text></g><g stroke="rgba(255,255,255,0.4)" stroke-width="2" fill="none"><rect x="100" y="200" width="80" height="50" rx="4"/><rect x="220" y="200" width="80" height="50" rx="4"/></g></svg>`,
  )}`;

export const jobStages: JobStage[] = [
  {
    id: "stg_001",
    jobNumber: "J-1850",
    customer: "Rolex 5th Ave",
    site: "665 Fifth Ave, NY · Vault corridor",
    scheduledFor: "2026-05-26T08:00:00Z",
    assignedTech: "Mike Alvarez",
    trade: "multi",
    status: "partial",
    stagedLocationId: "loc_wh_main",
    notes:
      "Cross-trade: locksmith + electronic security upgrade. Hold all parts together — single dispatch.",
    createdAt: "2026-05-21T09:14:00Z",
    updatedAt: "2026-05-24T11:08:00Z",
    auditLog: [
      {
        id: "aud_001a",
        at: "2026-05-21T09:14:00Z",
        actorName: "Stephanie Diaz (Counter)",
        field: "stage",
        newValue: "created",
        comment: "Stage opened from PO-2261 receiving",
      },
      {
        id: "aud_001b",
        at: "2026-05-23T16:42:00Z",
        actorName: "Stephanie Diaz (Counter)",
        field: "items.HES-1006-630.qtyReceived",
        oldValue: "0",
        newValue: "3",
        comment: "3 of 4 received from ADI · 1 backordered",
      },
      {
        id: "aud_001c",
        at: "2026-05-24T11:08:00Z",
        actorName: "Emanuel Dahan",
        field: "notes",
        oldValue: "Cross-trade install for Rolex vault upgrade.",
        newValue:
          "Cross-trade: locksmith + electronic security upgrade. Hold all parts together — single dispatch.",
      },
    ],
    items: [
      {
        id: "stg_001_a",
        itemSku: "ASA-MUL-C-114",
        itemName: "Mul-T-Lock C-Series Cylinder, IC Core, 6-Pin",
        uom: "EA",
        qtyOrdered: 12,
        qtyReceived: 12,
        vendor: "ASA / Mul-T-Lock NA",
        poNumber: "PO-2261",
        serialized: false,
      },
      {
        id: "stg_001_b",
        itemSku: "HES-1006-630",
        itemName: "HES 1006 Electric Strike, 12/24 VDC, 630 Finish",
        uom: "EA",
        qtyOrdered: 4,
        qtyReceived: 3,
        vendor: "ADI / Anixter",
        poNumber: "PO-2261",
        expectedDate: "2026-05-25T00:00:00Z",
        serialized: true,
        receivedSerials: ["HES-A8821", "HES-A8822", "HES-A8823"],
      },
      {
        id: "stg_001_c",
        itemSku: "HID-PROX-26",
        itemName: "HID ProxPoint Plus Reader, Wiegand 26",
        uom: "EA",
        qtyOrdered: 6,
        qtyReceived: 0,
        vendor: "ADI / Anixter",
        poNumber: "PO-2261",
        expectedDate: "2026-05-26T00:00:00Z",
        serialized: true,
      },
    ],
  },
  {
    id: "stg_002",
    jobNumber: "J-1851",
    customer: "McDonald's Atlantic Ave",
    site: "395 Flatbush Ave Ext, Brooklyn · Rooftop unit #2",
    scheduledFor: "2026-05-25T07:00:00Z",
    assignedTech: "Jose Ramirez",
    trade: "hvac",
    status: "complete",
    stagedLocationId: "loc_wh_main",
    stagedArea: "Zone B — Pickup Shelf",
    notes: "All parts in — ready to move to Jose's van first thing Monday.",
    createdAt: "2026-05-22T13:20:00Z",
    items: [
      {
        id: "stg_002_a",
        itemSku: "HVC-CAP-45-5",
        itemName: "Dual Run Capacitor 45/5 MFD 440V",
        uom: "EA",
        qtyOrdered: 2,
        qtyReceived: 2,
        vendor: "Ferguson HVAC",
        poNumber: "PO-2280",
        serialized: false,
      },
      {
        id: "stg_002_b",
        itemSku: "HVC-FIL-20X25-M11",
        itemName: "Pleated Air Filter 20x25x1, MERV 11",
        uom: "EA",
        qtyOrdered: 8,
        qtyReceived: 8,
        vendor: "Ferguson HVAC",
        poNumber: "PO-2280",
        serialized: false,
      },
    ],
  },
  {
    id: "stg_003",
    jobNumber: "J-1853",
    customer: "TikTok TriBeCa Office",
    site: "151 Hudson St, NY · Floor 14 access control retrofit",
    scheduledFor: "2026-05-29T08:00:00Z",
    assignedTech: "Carlos Tran",
    trade: "security",
    status: "awaiting",
    stagedLocationId: "loc_wh_main",
    notes:
      "Backordered — vendor confirmed Wed delivery. Reschedule with customer if slips.",
    createdAt: "2026-05-23T10:05:00Z",
    items: [
      {
        id: "stg_003_a",
        itemSku: "DSC-NEO-HS2128",
        itemName: "DSC PowerSeries Neo HS2128 Alarm Panel",
        uom: "EA",
        qtyOrdered: 2,
        qtyReceived: 0,
        vendor: "ADI / Anixter",
        poNumber: "PO-2289",
        expectedDate: "2026-05-28T00:00:00Z",
        serialized: true,
      },
      {
        id: "stg_003_b",
        itemSku: "HID-PROX-26",
        itemName: "HID ProxPoint Plus Reader, Wiegand 26",
        uom: "EA",
        qtyOrdered: 14,
        qtyReceived: 0,
        vendor: "ADI / Anixter",
        poNumber: "PO-2289",
        expectedDate: "2026-05-28T00:00:00Z",
        serialized: true,
      },
    ],
  },
  {
    id: "stg_004",
    jobNumber: "J-1845",
    customer: "Hudson Yards Condo Bldg 12B",
    site: "517 W 35th St, NY · Unit 1402 plumbing rough-in",
    scheduledFor: "2026-05-24T13:00:00Z",
    assignedTech: "Jose Ramirez",
    trade: "plumbing",
    status: "ready_for_pickup",
    stagedLocationId: "loc_wh_main",
    stagedArea: "Counter Pickup Shelf",
    notes: "Tech notified · Pickup window 11:00–13:00 today.",
    createdAt: "2026-05-22T08:40:00Z",
    photos: [
      {
        id: "pho_004a",
        kind: "image",
        dataUrl: demoPhotoSvg("Pallet · 80ft copper + 4 PEX rolls", 220),
        mimeType: "image/svg+xml",
        caption: "Pallet wrapped, tagged J-1845 — copper bundles on top, PEX rolls below.",
        uploadedAt: "2026-05-24T10:12:00Z",
        uploadedBy: "Stephanie Diaz (Counter)",
        source: "camera",
        poNumber: "PO-2275",
      },
      {
        id: "pho_004b",
        kind: "image",
        dataUrl: demoPhotoSvg("Counter shelf · ready tag attached", 145),
        mimeType: "image/svg+xml",
        caption: "Sitting on Counter Pickup Shelf, slot 3.",
        uploadedAt: "2026-05-24T10:14:00Z",
        uploadedBy: "Stephanie Diaz (Counter)",
        source: "camera",
      },
    ],
    items: [
      {
        id: "stg_004_a",
        itemSku: "PLB-COP-3-4-L",
        itemName: "Copper Pipe, Type L, 3/4 in × 10 ft",
        uom: "FT",
        qtyOrdered: 80,
        qtyReceived: 80,
        vendor: "Winsupply",
        poNumber: "PO-2275",
        serialized: false,
      },
      {
        id: "stg_004_b",
        itemSku: "PLB-PEX-1-2-RED",
        itemName: "PEX-A Tubing, 1/2 in × 100 ft, Red",
        uom: "ROLL",
        qtyOrdered: 4,
        qtyReceived: 4,
        vendor: "Winsupply",
        poNumber: "PO-2275",
        serialized: false,
      },
    ],
  },
];

export function stageProgress(s: JobStage): { received: number; ordered: number; pct: number } {
  const received = s.items.reduce((sum, i) => sum + i.qtyReceived, 0);
  const ordered = s.items.reduce((sum, i) => sum + i.qtyOrdered, 0);
  return { received, ordered, pct: ordered === 0 ? 0 : Math.round((received / ordered) * 100) };
}
