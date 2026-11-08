// Pending stock-out approvals. When a field tech scans a part to remove it
// from their van (consume / return / writeoff), the action is held in this
// queue until a manager/logistics user approves it.
// Per PRD §7.3 approval engine pattern + §5.2.4 closeout enforcement.

export type ApprovalActionType =
  | "consume_on_job"
  | "return_to_warehouse"
  | "writeoff"
  | "transfer_to_van";

export type ApprovalStatus = "pending" | "approved" | "rejected";

export type ApprovalModification = {
  at: string;
  byName: string;
  note: string;             // human-readable summary of what changed
  postDecision: boolean;    // true if edited after approve/reject
};

export type StockApproval = {
  id: string;
  requestedAt: string;
  requestedByTechId: string;
  requestedByTechName: string;
  type: ApprovalActionType;
  itemSku: string;
  itemName: string;
  uom: string;
  qty: number;
  fromLocationId: string;
  fromLocationName: string;
  toLocationId?: string;       // for transfer/return
  toLocationName?: string;
  jobNumber?: string;          // for consume
  customer?: string;
  reason?: string;
  serialCaptured?: string;     // for serialized items
  photoUrl?: string;           // photo of the part / scan moment
  status: ApprovalStatus;
  reviewedAt?: string;
  reviewedByName?: string;
  reviewComment?: string;
  modifications?: ApprovalModification[];
};

export const stockApprovals: StockApproval[] = [
  {
    id: "apr_001",
    requestedAt: "2026-05-25T09:14:00Z",
    requestedByTechId: "tech_mike",
    requestedByTechName: "Mike Alvarez",
    type: "consume_on_job",
    itemSku: "HES-1006-630",
    itemName: "HES 1006 Electric Strike, 12/24 VDC, 630 Finish",
    uom: "EA",
    qty: 1,
    fromLocationId: "loc_van_mike",
    fromLocationName: "Mike's Van",
    jobNumber: "J-1850",
    customer: "Rolex 5th Ave",
    reason: "Vault corridor west door — strike replacement",
    serialCaptured: "HES-A8821",
    status: "pending",
  },
  {
    id: "apr_002",
    requestedAt: "2026-05-25T08:42:00Z",
    requestedByTechId: "tech_jose",
    requestedByTechName: "Jose Ramirez",
    type: "consume_on_job",
    itemSku: "HVC-CAP-45-5",
    itemName: "Dual Run Capacitor 45/5 MFD 440V",
    uom: "EA",
    qty: 2,
    fromLocationId: "loc_van_jose",
    fromLocationName: "Jose's Van",
    jobNumber: "J-1851",
    customer: "McDonald's Atlantic Ave",
    reason: "Rooftop unit #2 + unit #4 capacitor replacement",
    status: "pending",
  },
  {
    id: "apr_003",
    requestedAt: "2026-05-25T07:58:00Z",
    requestedByTechId: "tech_carlos",
    requestedByTechName: "Carlos Tran",
    type: "transfer_to_van",
    itemSku: "HID-PROX-26",
    itemName: "HID ProxPoint Plus Reader, Wiegand 26",
    uom: "EA",
    qty: 4,
    fromLocationId: "loc_wh_main",
    fromLocationName: "Main Warehouse",
    toLocationId: "loc_van_carlos",
    toLocationName: "Carlos's Van",
    jobNumber: "J-1853",
    customer: "TikTok TriBeCa Office",
    reason: "Loading van for floor 14 access control retrofit",
    status: "pending",
  },
  {
    id: "apr_004",
    requestedAt: "2026-05-24T17:22:00Z",
    requestedByTechId: "tech_dre",
    requestedByTechName: "Dre Patel",
    type: "return_to_warehouse",
    itemSku: "PLB-COP-3-4-L",
    itemName: "Copper Pipe, Type L, 3/4 in × 10 ft",
    uom: "FT",
    qty: 20,
    fromLocationId: "loc_van_jose",
    fromLocationName: "Jose's Van",
    toLocationId: "loc_wh_main",
    toLocationName: "Main Warehouse",
    reason: "Excess from J-1845 — return for restocking",
    status: "pending",
  },
  {
    id: "apr_005",
    requestedAt: "2026-05-24T16:05:00Z",
    requestedByTechId: "tech_alex",
    requestedByTechName: "Alex Romero",
    type: "writeoff",
    itemSku: "DOR-WGT-CMB-FRP",
    itemName: "Door Weatherseal Kit, Commercial",
    uom: "KIT",
    qty: 1,
    fromLocationId: "loc_van_carlos",
    fromLocationName: "Carlos's Van",
    reason: "Damaged in transit — torn rubber gasket, unusable",
    status: "pending",
  },
];

export function approvalTypeLabel(t: ApprovalActionType): string {
  switch (t) {
    case "consume_on_job":
      return "Consume on Job";
    case "return_to_warehouse":
      return "Return to Warehouse";
    case "writeoff":
      return "Write-off";
    case "transfer_to_van":
      return "Transfer to Van";
  }
}

export function approvalTypeTint(t: ApprovalActionType): string {
  switch (t) {
    case "consume_on_job":
      return "bg-ai-surface text-ai-text ring-ai-border";
    case "return_to_warehouse":
      return "bg-success-surface text-success-text ring-success-border";
    case "writeoff":
      return "bg-danger-surface text-danger-text ring-danger-border";
    case "transfer_to_van":
      return "bg-info-surface text-info-text ring-info-border";
  }
}
