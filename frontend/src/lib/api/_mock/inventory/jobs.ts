// Seed jobs for the prototype. In production these come from the jobs table
// (PRD §6 cross-trade jobs). Picking a job in staging auto-fills customer,
// site, trade, and the scheduled date.

export type InventoryJob = {
  id: string;
  jobNumber: string;
  customer: string;
  site: string;
  trade: "locksmith" | "door" | "security" | "hvac" | "plumbing" | "multi";
  scheduledFor?: string;
  assignedTechId?: string;
  status: "scheduled" | "in_progress" | "completed" | "on_hold";
  /** Free-text job notes — access instructions, contact preferences, gotchas. */
  notes?: string;
  /** Customer FK (server-provided) — the Create PO dialog sends it as `customerId`
   *  alongside `jobId` when a job is linked (S3.1). Absent on the mock seed. */
  customerId?: string;
};

export const jobs: InventoryJob[] = [
  {
    id: "job_1850",
    jobNumber: "J-1850",
    customer: "Rolex 5th Ave",
    site: "665 Fifth Ave, NY · Vault corridor",
    trade: "multi",
    scheduledFor: "2026-05-26T08:00:00Z",
    assignedTechId: "tech_mike",
    status: "scheduled",
    notes:
      "COI must be emailed to facilities@rolex before any tech arrives. Vault corridor access only in the 7–9am window. Daniel Cohen is the sole authorized contact.",
  },
  {
    id: "job_1851",
    jobNumber: "J-1851",
    customer: "McDonald's Atlantic Ave",
    site: "395 Flatbush Ave Ext, Brooklyn · Rooftop unit #2",
    trade: "hvac",
    scheduledFor: "2026-05-25T07:00:00Z",
    assignedTechId: "tech_jose",
    status: "scheduled",
    notes:
      "Rooftop unit #2. Spanish-preferred contact (Rosa). Roof hatch key is at the register — ask the GM. Avoid the lunch rush 11:30am–1:30pm.",
  },
  {
    id: "job_1853",
    jobNumber: "J-1853",
    customer: "TikTok TriBeCa Office",
    site: "151 Hudson St, NY · Floor 14 access control retrofit",
    trade: "security",
    scheduledFor: "2026-05-29T08:00:00Z",
    assignedTechId: "tech_carlos",
    status: "scheduled",
    notes:
      "Floor 14 access-control retrofit. Priya is reviewing the estimate internally — decision expected next week. Badge access via the 1st-floor security desk.",
  },
  {
    id: "job_1862",
    jobNumber: "J-1862",
    customer: "Equinox Hudson Yards",
    site: "33 Hudson Yards, NY · Lobby 1 access control",
    trade: "security",
    scheduledFor: "2026-05-28T08:00:00Z",
    assignedTechId: "tech_carlos",
    status: "scheduled",
    notes:
      "Lobby 1 access control — waiting on PO-2305 hardware (ADI/Anixter). Marcus Webb on site M–F 6am–2pm. Use the loading dock entrance on 33rd St.",
  },
  {
    id: "job_1865",
    jobNumber: "J-1865",
    customer: "Whole Foods Gowanus",
    site: "214 3rd St, Brooklyn · Rooftop AHU-3",
    trade: "hvac",
    scheduledFor: "2026-05-27T07:00:00Z",
    assignedTechId: "tech_jose",
    status: "scheduled",
  },
  {
    id: "job_1868",
    jobNumber: "J-1868",
    customer: "Tiffany & Co · 5th Ave",
    site: "727 Fifth Ave, NY · Vault retrofit",
    trade: "locksmith",
    scheduledFor: "2026-05-30T08:00:00Z",
    assignedTechId: "tech_mike",
    status: "scheduled",
    notes:
      "Vault retrofit — high security. Helen Park must escort all techs on site. Background check required 48h prior to arrival.",
  },
  {
    id: "job_1845",
    jobNumber: "J-1845",
    customer: "Hudson Yards Condo Bldg 12B",
    site: "517 W 35th St, NY · Unit 1402 plumbing rough-in",
    trade: "plumbing",
    scheduledFor: "2026-05-24T13:00:00Z",
    assignedTechId: "tech_jose",
    status: "in_progress",
    notes:
      "Unit 1402 — recurring sink leak. Owner Greg Sanders prefers calls after 5pm. Last visit replaced the supply line; monitoring for 2 weeks before closing.",
  },
  // ─── Jobs referenced by RFQs (pre-po.ts) ─────────────────────────────────
  // These three drive the "auto-fill line items from open RFQ" path on the
  // Create PO dialog. Adding them here so the typeahead surfaces them.
  {
    id: "job_1872",
    jobNumber: "J-1872",
    customer: "Chase Bank · Park Slope Branch",
    site: "247 7th Ave, Brooklyn · Vault hardware refresh",
    trade: "locksmith",
    scheduledFor: "2026-06-08T08:00:00Z",
    assignedTechId: "tech_mike",
    status: "scheduled",
  },
  {
    id: "job_1874",
    jobNumber: "J-1874",
    customer: "Brooklyn Brewery",
    site: "79 N 11th St, Brooklyn · Walk-in cooler service",
    trade: "hvac",
    scheduledFor: "2026-06-02T07:00:00Z",
    assignedTechId: "tech_jose",
    status: "scheduled",
  },
  {
    id: "job_1876",
    jobNumber: "J-1876",
    customer: "Sweetgreen · Williamsburg",
    site: "240 Bedford Ave, Brooklyn · POS counter rebuild",
    trade: "multi",
    scheduledFor: "2026-06-05T08:00:00Z",
    assignedTechId: "tech_carlos",
    status: "scheduled",
  },
  // ─── Job referenced by Estimate Reservation (pre-po.ts) ──────────────────
  // Drives the "auto-fill line items from customer-approved estimate" path.
  {
    id: "job_1877",
    jobNumber: "J-1877",
    customer: "NYC Department of Education · PS-321",
    site: "180 7th Ave, Brooklyn · Lobby door hardware",
    trade: "door",
    scheduledFor: "2026-05-30T07:00:00Z",
    assignedTechId: "tech_mike",
    status: "scheduled",
  },
];
