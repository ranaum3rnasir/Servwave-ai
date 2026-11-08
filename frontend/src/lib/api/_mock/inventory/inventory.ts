// Fake data for the CRM Inventory prototype.
// Mirrors the PRD's data model (item, item_variant, inventory_location, stock_balance, stock_movement)
// at a level of fidelity that's realistic to *look at* — not a real inventory engine.

export type TransmitMethod = "email" | "edi" | "portal" | "phone";

// rev 2026-05-27: vendors can carry an arbitrary number of extra contacts on
// top of the primary contact fields below. Each extra contact is a separate
// person (orders rep + AP rep + branch manager + after-hours dispatcher etc.)
// with their own name / email / phone / role. The primary fields
// (contactPersonName / contactEmail / contactPhone) stay on the Vendor for
// back-compat with readers — they're treated as the "main" contact and
// surface first wherever a single contact is shown (vendor card, PO header,
// email composer suggested-recipients).
export type VendorContact = {
  id: string;
  name?: string;
  email?: string;
  phone?: string;
  role?: string;      // free-form: "Orders rep", "AP", "Branch manager", "After-hours"
};

export type Vendor = {
  id: string;
  name: string;
  /** The category ROW's name; '' when uncategorized (kept in step by the server). */
  category: string;
  /**
   * FK to the org's vendor_categories row (Purchasing Audit Verdict PR 4).
   * null = Uncategorized. Optional only so the prototype fixtures below still
   * type-check; the live API always emits it.
   */
  categoryId?: string | null;
  /**
   * RETIRED (Purchasing Audit Verdict 2026-09-02, PR 1). ServWave never sends
   * a PO, so the API stopped emitting payment terms, default lead time and
   * the PO transmit method; a later migration drops the columns. Kept
   * optional only so the prototype fixtures below still type-check - no live
   * reader may depend on them.
   */
  paymentTerms?: string;
  leadTimeDays?: number;
  transmitMethod?: TransmitMethod;
  transmitMethods?: TransmitMethod[];
  contactPersonName?: string;   // the rep we actually talk to (primary)
  contactEmail?: string;        // primary email
  contactPhone?: string;        // primary phone
  /**
   * Additional contacts beyond the primary above (rev 2026-05-27). Optional.
   * Each entry is a separate person. Empty / missing → vendor has only the
   * primary contact. The primary fields are still shown wherever a single
   * contact is needed; this list appears on the vendor detail dialog + as a
   * "+N more" pill on the vendor card.
   */
  additionalContacts?: VendorContact[];
  accountNumber?: string;
  website?: string;             // vendor portal / catalog URL — opens external
  pickupAddress?: string;
  notes?: string;
  status?: "active" | "inactive"; // soft-archive flag; missing = active
};

export const vendors: Vendor[] = [
  {
    id: "vnd_asa",
    name: "ASA / Mul-T-Lock NA",
    category: "Locksmith hardware",
    paymentTerms: "Net 30",
    leadTimeDays: 5,
    transmitMethod: "email",
    contactPersonName: "Daniel Reyes",
    contactEmail: "orders@asaab.com",
    contactPhone: "(212) 555-0114",
    accountNumber: "ASA-44218",
    website: "https://www.asaab.com",
    pickupAddress: "127 Park Ave S, NY · Will-call counter, basement",
    status: "active",
  },
  {
    id: "vnd_allegion",
    name: "Allegion / Banner Solutions",
    category: "Commercial door hardware",
    paymentTerms: "Net 30",
    leadTimeDays: 7,
    transmitMethod: "portal",
    contactPersonName: "Karen Whitfield",
    contactEmail: "support@bannersolutions.com",
    contactPhone: "(516) 555-0190",
    accountNumber: "BNR-90118",
    website: "https://www.bannersolutions.com",
    pickupAddress: "Banner Solutions Hicksville · 24 Frost St, Westbury NY",
    status: "active",
  },
  {
    id: "vnd_adi",
    name: "ADI / Anixter",
    category: "Security + low voltage",
    paymentTerms: "Net 30",
    leadTimeDays: 3,
    transmitMethod: "portal",
    contactPersonName: "Marcus Patel",
    contactEmail: "ny-orders@adiglobal.com",
    contactPhone: "(718) 555-0182",
    additionalContacts: [
      {
        id: "vc_adi_ap",
        name: "Renee Holcomb",
        email: "ap@adiglobal.com",
        phone: "(718) 555-0185",
        role: "Accounts Payable",
      },
      {
        id: "vc_adi_branch",
        name: "Tony Kapoor",
        email: "tony.kapoor@adiglobal.com",
        phone: "(718) 555-0190",
        role: "Branch Manager · Jamaica NY",
      },
      {
        id: "vc_adi_afterhours",
        phone: "(800) 555-7711",
        role: "After-hours dispatch",
      },
    ],
    accountNumber: "ADI-558271",
    website: "https://www.adiglobal.com",
    pickupAddress: "ADI Branch #018 · 240-15 Rockaway Blvd, Jamaica NY",
    status: "active",
  },
  {
    id: "vnd_crl",
    name: "CRL",
    category: "Door hardware + glazing",
    paymentTerms: "Net 30",
    leadTimeDays: 5,
    transmitMethod: "email",
    contactPersonName: "Liana Park",
    contactEmail: "orders@crlaurence.com",
    contactPhone: "(631) 555-0148",
    website: "https://www.crlaurence.com",
    pickupAddress: "CRL Hauppauge · 90 Adams Ave, Hauppauge NY",
    status: "active",
  },
  {
    id: "vnd_ferguson",
    name: "Ferguson HVAC",
    category: "HVAC + plumbing",
    paymentTerms: "Net 45",
    leadTimeDays: 2,
    transmitMethod: "edi",
    contactPersonName: "Anthony Russo",
    contactEmail: "brooklyn@ferguson.com",
    contactPhone: "(718) 555-0136",
    accountNumber: "FRG-22014",
    website: "https://www.ferguson.com",
    pickupAddress: "Ferguson Brooklyn · 1115 Atlantic Ave, Brooklyn NY · Loading dock B",
    status: "active",
  },
  {
    id: "vnd_winsupply",
    name: "Winsupply",
    category: "Plumbing wholesale",
    paymentTerms: "Net 30",
    leadTimeDays: 3,
    transmitMethod: "portal",
    contactPersonName: "Brenda Cho",
    contactEmail: "brooklyn@winsupply.com",
    contactPhone: "(718) 555-0205",
    accountNumber: "WIN-8842",
    website: "https://www.winsupply.com",
    pickupAddress: "Winsupply Brooklyn · 469 Bushwick Ave, Brooklyn NY",
    status: "active",
  },
  {
    id: "vnd_internal",
    name: "Internal",
    category: "Internal services / labor",
    paymentTerms: "n/a",
    leadTimeDays: 0,
    transmitMethod: "email",
    status: "active",
  },
];

export type Branch = {
  id: string;
  name: string;
  code?: string;       // short identifier shown in chips / receipts
  address?: string;
  phone?: string;
  managerName?: string;
  timezone?: string;
  notes?: string;
};

export const branches: Branch[] = [
  {
    id: "br_brooklyn_hq",
    name: "Brooklyn HQ",
    code: "BHQ",
    address: "215 Moore St, Brooklyn NY 11206",
    phone: "(718) 555-0101",
    managerName: "Emanuel Dahan",
    timezone: "America/New_York",
  },
  {
    id: "br_queens",
    name: "Queens Branch",
    code: "QNS",
    address: "44-02 Northern Blvd, Long Island City NY 11101",
    phone: "(718) 555-0142",
    managerName: "Carlos Tran",
    timezone: "America/New_York",
  },
  {
    id: "br_bronx",
    name: "Bronx Branch",
    code: "BX",
    address: "880 E 149th St, Bronx NY 10455",
    phone: "(718) 555-0177",
    timezone: "America/New_York",
  },
];

export type Category = {
  id: string;
  name: string;
  trade?: "locksmith" | "door" | "security" | "hvac" | "plumbing";
  description?: string;
  /**
   * Hero photo for the category — rendered as a 2:1 banner at the top of the
   * card on Price Book → Categories tab. Helps techs + customers recognize a
   * part type at a glance ("Cylinders", "Electric Strikes", "Capacitors")
   * before drilling into individual items. Falls back to a gradient + icon
   * tile when null. Production: signed object-storage URL; prototype: inline
   * `data:image/...` URI from FileReader upload (same pattern as Brand.logoUrl
   * and ItemGroup.photoUrl).
   */
  photoUrl?: string;
};

// ============================================================================
// Price Book Phase A (PRD §6.A, §6.10, §6.11 — rev 2026-05-28)
// ============================================================================
//
// Two-level taxonomy: Brand (manufacturer) and Category (cross-brand part
// type). Items carry optional brand_id + the existing category. The old
// product-family Group concept (C-Series, ND-Series) was retired in the
// 2026-05-28 Item Groups redesign — "Groups" now means a preset bundle of
// line items for fast estimate / invoice creation (see ItemGroup below).
//
// See data-model details in PRD §6.10 (brand) + §6.11 (item_group bundle).

export type Brand = {
  id: string;
  name: string;
  logoUrl?: string;          // square logo, 256x256 recommended
  website?: string;
  description?: string;
  defaultMarkupPct?: number; // 0.6 = 60% markup over unit cost (used when item.list_price is null AND no group/item override)
  defaultVendorId?: string;  // auto-fills item.vendor when this brand is picked in AddItemDialog
  isActive?: boolean;        // default true; archived brands hidden from new-item dropdowns
};

// DESIGN-SYSTEM RESIDUAL (phase 4a, 2026-07-27). The hexes below and in
// svgPhoto() are a documented exemption from the token layer, not an oversight.
// They are seed FIXTURE data: each is a third-party vendor's own brand tone
// (Mul-T-Lock red, ASSA Abloy blue, Honeywell red) baked into a data: URI
// placeholder that production replaces with a real uploaded logo. Re-theming
// ServWave must not repaint someone else's logo, and none of these values
// reaches app chrome.
//
// Brand-logo SVG helper (PRD §6.10 rev 2026-05-28). Renders a square monogram
// badge with a radial gradient + brand-tone color. Returns a data: URI so the
// seed bundle has no external image dependency — production will swap these
// for real uploaded logos in object storage (see §6.10 UX spec).
function brandLogoSvg(monogram: string, accent: string, accent2 = accent): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><defs><radialGradient id='g' cx='35%' cy='30%' r='90%'><stop offset='0' stop-color='${accent2}' stop-opacity='1'/><stop offset='1' stop-color='${accent}' stop-opacity='1'/></radialGradient></defs><rect width='100' height='100' rx='18' fill='url(%23g)'/><text x='50' y='62' font-family='-apple-system, system-ui, sans-serif' font-size='${monogram.length >= 3 ? 30 : 38}' font-weight='800' fill='#ffffff' text-anchor='middle' letter-spacing='-1'>${monogram}</text></svg>`;
  return `data:image/svg+xml;utf8,${svg.replace(/#/g, "%23")}`;
}

export const brands: Brand[] = [
  {
    id: "brd_mul",
    name: "Mul-T-Lock",
    logoUrl: brandLogoSvg("MTL", "#b91c1c", "#f59e0b"), // red → amber (Mul-T-Lock red + gold accents)
    website: "https://www.mul-t-lock.com",
    description: "High-security cylinders, padlocks, and patented keyways.",
    defaultMarkupPct: 1.4,
    defaultVendorId: "vnd_asa",
    isActive: true,
  },
  {
    id: "brd_med",
    name: "Medeco",
    logoUrl: brandLogoSvg("MED", "#7f1d1d", "#b91c1c"), // deep maroon (Medeco corporate red)
    website: "https://www.medeco.com",
    description: "High-security cylinders, deadbolts, and patented key control.",
    defaultMarkupPct: 1.35,
    isActive: true,
  },
  {
    id: "brd_assa",
    name: "ASSA Abloy",
    logoUrl: brandLogoSvg("AA", "#0e4a8f", "#1e88e5"), // ASSA Abloy blue
    website: "https://www.assaabloy.com",
    description: "Commercial locks, electric strikes, HES, HID — global access portfolio.",
    defaultMarkupPct: 1.2,
    defaultVendorId: "vnd_allegion",
    isActive: true,
  },
  {
    id: "brd_sch",
    name: "Schlage",
    logoUrl: brandLogoSvg("SCH", "#1e293b", "#475569"), // dark slate (Schlage black-on-gold wordmark)
    website: "https://www.schlage.com",
    description: "Residential + commercial deadbolts, cylindrical locks, LCN closers (Allegion).",
    defaultMarkupPct: 1.25,
    defaultVendorId: "vnd_allegion",
    isActive: true,
  },
  {
    id: "brd_kaba",
    name: "Kaba",
    logoUrl: brandLogoSvg("KB", "#0e7490", "#06b6d4"), // teal/cyan (dormakaba brand teal)
    website: "https://www.dormakaba.com",
    description: "dormakaba — Peaks high-security cylinders, Simplex pushbutton locks.",
    defaultMarkupPct: 1.3,
    isActive: true,
  },
  {
    id: "brd_hon",
    name: "Honeywell",
    logoUrl: brandLogoSvg("HON", "#dc2626", "#ef4444"), // Honeywell red
    website: "https://www.honeywell.com",
    description: "Access control panels, sensors, intrusion + fire alarm systems.",
    defaultMarkupPct: 1.3,
    defaultVendorId: "vnd_adi",
    isActive: true,
  },
];

// ----------------------------------------------------------------------------
// Item Groups — preset bundles (PRD §6.11 rev 2026-05-28 redesign)
// ----------------------------------------------------------------------------
//
// A Group is a saved bundle of line items dropped onto an estimate or invoice
// for fast turnaround. Two display modes per bundle:
//
//   - "individual"  — every line surfaces as its own row on the estimate
//                     (customer sees the breakdown of parts + labor)
//   - "flat_rate"   — bundle renders as ONE line with a lump-sum price; the
//                     underlying lines are internal (cost / margin tracking)
//
// Each line either references a real Item (live price, optional per-bundle
// override) or carries a free-form name + price for one-off charges like
// "Travel fee — $50" that don't deserve a standing inventory item.
//
// Group totals = sum of line.qty × line.effectivePrice. For flat_rate bundles
// the customer-facing price defaults to that sum but can be overridden via
// flatRatePriceOverride to set an arbitrary number (e.g. "Standard Rekey: $250
// flat" even if parts only sum to $120).

export type ItemGroupLine = {
  id: string;
  /** Reference to a Price Book Item. Undefined for free-form lines. */
  itemId?: string;
  /** Line label — mirrors item.name for real-item lines, free-form text otherwise. */
  name: string;
  quantity: number;
  /**
   * Per-line price override. Undefined = use the referenced item's current
   * list/sell price. REQUIRED for free-form lines (no item to inherit from).
   */
  priceOverride?: number;
  /** Per-line cost override (internal margin tracking). */
  costOverride?: number;
  /** Optional per-line note shown below the name in the editor. */
  notes?: string;
};

export type ItemGroupType = "flat_rate" | "individual";

export type ItemGroup = {
  id: string;
  name: string;
  description?: string;
  /**
   * Hero photo for the bundle — rendered as a banner at the top of the bundle
   * card on Price Book → Groups tab. Falls back to a Layers-icon tile when
   * null. Production: signed object-storage URL; prototype: inline
   * `data:image/...` URI from FileReader upload.
   */
  photoUrl?: string;
  /** Customer-facing display mode (see comment above). */
  groupType: ItemGroupType;
  /**
   * Custom flat-rate price for flat_rate bundles. Undefined = use the sum of
   * line.qty × line.effectivePrice. Ignored when groupType = "individual".
   */
  flatRatePriceOverride?: number;
  isActive: boolean;
  lines: ItemGroupLine[];
};

export const itemGroups: ItemGroup[] = [
  {
    id: "grp_rekey_std",
    name: "Standard Rekey Service",
    description: "Up to 6 cylinders rekeyed on-site. Lockout-safe pinning kit + tech labor.",
    groupType: "flat_rate",
    flatRatePriceOverride: 189,
    isActive: true,
    lines: [
      { id: "ln_rk_1", itemId: "itm_014", name: "Locksmith Labor — Hourly", quantity: 1 },
      { id: "ln_rk_2", itemId: "itm_001", name: "Mul-T-Lock C-Series Cylinder, IC Core, 6-Pin", quantity: 1 },
      { id: "ln_rk_3", name: "Pinning kit + dispatch", quantity: 1, priceOverride: 25, costOverride: 8, notes: "Free-form line — covers van consumables" },
    ],
  },
  {
    id: "grp_lockout_res",
    name: "Residential Lockout Service",
    description: "After-hours residential lockout — 30 min on-site, includes travel.",
    groupType: "flat_rate",
    flatRatePriceOverride: 165,
    isActive: true,
    lines: [
      { id: "ln_lo_1", itemId: "itm_014", name: "Locksmith Labor — Hourly", quantity: 0.5 },
      { id: "ln_lo_2", name: "Travel — Brooklyn metro", quantity: 1, priceOverride: 45, costOverride: 12 },
    ],
  },
  {
    id: "grp_camera_install",
    name: "Single Door Access Install",
    description: "HID reader + DSC panel + electric strike + 2 hrs labor — itemized for the customer.",
    groupType: "individual",
    isActive: true,
    lines: [
      { id: "ln_cm_1", itemId: "itm_012", name: "HID ProxPoint Plus Reader, Wiegand 26", quantity: 1 },
      { id: "ln_cm_2", itemId: "itm_004", name: "DSC PowerSeries Neo HS2128 Alarm Panel", quantity: 1 },
      { id: "ln_cm_3", itemId: "itm_003", name: "HES 1006 Electric Strike, 12/24 VDC, 630 Finish", quantity: 1 },
      { id: "ln_cm_4", itemId: "itm_014", name: "Locksmith Labor — Hourly", quantity: 2 },
    ],
  },
  {
    id: "grp_hvac_cap_swap",
    name: "HVAC Capacitor Replacement",
    description: "Diagnose + swap a dual run capacitor on a residential split system.",
    groupType: "flat_rate",
    flatRatePriceOverride: 235,
    isActive: true,
    lines: [
      { id: "ln_hv_1", itemId: "itm_006", name: "Dual Run Capacitor 45/5 MFD 440V", quantity: 1 },
      { id: "ln_hv_2", itemId: "itm_014", name: "Locksmith Labor — Hourly", quantity: 1, priceOverride: 145, notes: "HVAC tech rate" },
      { id: "ln_hv_3", name: "Service call dispatch fee", quantity: 1, priceOverride: 75, costOverride: 0 },
    ],
  },
  {
    id: "grp_door_strike_install",
    name: "Electric Strike Install — Commercial",
    description: "HES strike + weatherseal kit + 1.5 hrs labor for a commercial swing door retrofit.",
    groupType: "individual",
    isActive: true,
    lines: [
      { id: "ln_es_1", itemId: "itm_003", name: "HES 1006 Electric Strike, 12/24 VDC, 630 Finish", quantity: 1 },
      { id: "ln_es_2", itemId: "itm_013", name: "Door Weatherseal Kit, Commercial, Frame + Bottom", quantity: 1 },
      { id: "ln_es_3", itemId: "itm_014", name: "Locksmith Labor — Hourly", quantity: 1.5 },
    ],
  },
];

// Item visibility — drives whether the item appears on customer-facing
// surfaces (Catalog tab in Price Book, estimate / invoice line items in
// Phase C). Internal-only items (labor codes, fees, internal discounts) are
// still visible to ops staff in the Inventory + Items list. Default is
// defaulted to catalog on insert and can be flipped per-item.
export type ItemVisibility = "catalog" | "internal_only";

// Both surviving kinds default to the customer-facing catalog. The two that
// defaulted to internal_only - labor and fee - were retired; keeping something
// off customer surfaces is now an explicit choice on the item, which is the
// only way it was ever reliable (a "service" could always be either).
export function defaultVisibilityForKind(_kind: ItemKind): ItemVisibility {
  return "catalog";
}

export const categories: Category[] = [
  { id: "cat_cyl", name: "Cylinders", trade: "locksmith", description: "Lock cylinders (IC core, conventional, restricted)" },
  { id: "cat_locksets", name: "Locksets", trade: "door", description: "Cylindrical, mortise, and electrified locksets" },
  { id: "cat_strikes", name: "Electric Strikes", trade: "security", description: "Fail-safe / fail-secure electric strikes" },
  { id: "cat_panels", name: "Alarm Panels", trade: "security", description: "Intrusion + fire alarm control panels" },
  { id: "cat_closers", name: "Door Closers", trade: "door", description: "Surface, concealed, overhead door closers" },
  { id: "cat_caps", name: "Capacitors", trade: "hvac", description: "Run + start capacitors" },
  { id: "cat_filters", name: "Air Filters", trade: "hvac", description: "Pleated, HEPA, MERV-rated filters" },
  { id: "cat_refrig", name: "Refrigerant", trade: "hvac", description: "R-410A, R-32, R-454B + recovery cylinders" },
  { id: "cat_copper", name: "Copper Pipe", trade: "plumbing", description: "Type L / Type M copper, all diameters" },
  { id: "cat_pex", name: "PEX Tubing", trade: "plumbing", description: "PEX-A / PEX-B tubing rolls" },
  { id: "cat_readers", name: "Access Readers", trade: "security", description: "Prox, smart-card, mobile credential readers" },
  { id: "cat_seals", name: "Weather Seals", trade: "door", description: "Frame, sweep, threshold weatherseal kits" },
  { id: "cat_labor", name: "Labor", description: "Hourly labor + travel charges" },
  { id: "cat_service", name: "Service", description: "Flat-rate service tasks" },
];

export type LocationType = "warehouse" | "truck" | "counter" | "staging";

export type Location = {
  id: string;
  name: string;
  type: LocationType;
  branch: string;
  primaryTech?: string;
  /** Inventory P3 — the assigned tech's USER id (the van binding); `primaryTech` stays the display name. */
  primaryTechId?: string;
  vehicle?: string;
  /**
   * Named staging zones / bins inside a warehouse-type location, e.g.
   * ["Zone A — Receiving", "Zone B — Pickup Shelf", "Backroom Holding"].
   * Used by Job Staging (§7.4.A) to tell techs *exactly* where in the
   * warehouse their parts are sitting once the stage is complete.
   * Free-form so each branch can shape its own floor plan; the UI offers
   * the configured options and also allows a custom value.
   */
  stagingAreas?: string[];
};

export const locations: Location[] = [
  {
    id: "loc_wh_main",
    name: "Main Warehouse",
    type: "warehouse",
    branch: "Brooklyn HQ",
    stagingAreas: [
      "Zone A — Receiving Dock",
      "Zone B — Pickup Shelf",
      "Zone C — Bulk Aisle",
      "Counter Pickup Shelf",
      "Backroom Holding",
      "Loading Dock",
    ],
  },
  {
    id: "loc_wh_queens",
    name: "Queens Warehouse",
    type: "warehouse",
    branch: "Queens Branch",
    stagingAreas: [
      "Zone 1 — Receiving",
      "Zone 2 — Pickup",
      "Counter Pickup",
      "Yard / Outdoor Pallet Rack",
    ],
  },
  { id: "loc_counter", name: "Counter Shop", type: "counter", branch: "Brooklyn HQ" },
  { id: "loc_van_mike", name: "Mike's Van", type: "truck", branch: "Brooklyn HQ", primaryTech: "Mike Alvarez", vehicle: "Ford Transit · BX-4421" },
  { id: "loc_van_jose", name: "Jose's Van", type: "truck", branch: "Brooklyn HQ", primaryTech: "Jose Ramirez", vehicle: "Ford Transit · BX-5108" },
  { id: "loc_van_carlos", name: "Carlos's Van", type: "truck", branch: "Queens Branch", primaryTech: "Carlos Tran", vehicle: "Mercedes Sprinter · QN-9920" },
];

// Kept in lockstep with the live ItemKind in lib/api/inventory.ts - the two are
// structurally compared wherever a mock Item feeds a real-typed prop.
export type ItemKind = "material" | "service";
export type Trade = "locksmith" | "door" | "security" | "hvac" | "plumbing";
export type ItemStatus = "active" | "on_backorder" | "discontinued";

export type StockAtLocation = {
  locationId: string;
  onHand: number;
  reserved: number;
  min?: number;
  max?: number;
};

export type Item = {
  id: string;
  sku: string;
  mpn?: string;
  upc?: string;
  name: string;
  category: string;
  trade: Trade;
  kind: ItemKind;
  uom: string;
  unitCost: number;
  sellPrice: number;
  serialized: boolean;
  hazmat: boolean;
  status: ItemStatus;
  vendor: string;
  stock: StockAtLocation[];
  serials?: string[];
  photoUrl?: string;
  updatedAt: string;
  // Price Book Phase A additions (PRD §6.A, rev 2026-05-28) ----------------
  brandId?: string;            // FK brand.id
  visibility?: ItemVisibility; // 'catalog' | 'internal_only'; defaults computed from kind
  customerName?: string;       // marketing-friendly name; falls back to `name` when null
  customerDescription?: string; // marketing copy; falls back to `description` when null
  keyFeatures?: string[];      // 3-5 short bullet strings for Catalog cards + Customer-Present Mode (Phase B/C)
  // photos array spec'd in §6.A.5 lands in Phase B; field reserved on the type
  // so consumers don't need a refactor when uploads ship.
  // photos?: ItemPhoto[];
  listPrice?: number;          // customer-facing price override; when null, markup engine computes from unit cost
};

// Inline SVG placeholders so a few seeded items show "with photo" out of the box.
function svgPhoto(initials: string, bg: string, fg = "#ffffff"): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='${bg}'/><stop offset='1' stop-color='${bg}' stop-opacity='0.7'/></linearGradient></defs><rect width='100' height='100' fill='url(%23g)'/><text x='50' y='62' font-family='-apple-system, system-ui, sans-serif' font-size='34' font-weight='700' fill='${fg}' text-anchor='middle'>${initials}</text></svg>`;
  return `data:image/svg+xml;utf8,${svg.replace(/#/g, "%23")}`;
}

export const items: Item[] = [
  {
    id: "itm_001",
    sku: "ASA-MUL-C-114",
    mpn: "MUL-T-LOCK 114",
    upc: "045678910011",
    name: "Mul-T-Lock C-Series Cylinder, IC Core, 6-Pin",
    category: "Cylinders",
    trade: "locksmith",
    kind: "material",
    uom: "EA",
    unitCost: 38.5,
    sellPrice: 92.0,
    serialized: false,
    hazmat: false,
    status: "active",
    vendor: "ASA / Mul-T-Lock NA",
    stock: [
      { locationId: "loc_wh_main", onHand: 64, reserved: 8, min: 24, max: 120 },
      { locationId: "loc_counter", onHand: 12, reserved: 2 },
      { locationId: "loc_van_mike", onHand: 6, reserved: 0, min: 4, max: 12 },
      { locationId: "loc_van_jose", onHand: 3, reserved: 1, min: 4, max: 12 },
      { locationId: "loc_van_carlos", onHand: 5, reserved: 0, min: 4, max: 12 },
    ],
    photoUrl: svgPhoto("MUL", "#b45309"),
    brandId: "brd_mul",
    visibility: "catalog",
    updatedAt: "2026-05-23T15:42:00Z",
  },
  {
    id: "itm_002",
    sku: "SCH-COM-DLR",
    mpn: "ND80PD-RHO-626",
    upc: "045678910028",
    name: "Schlage ND Series Cylindrical Lock, Storeroom, 626",
    category: "Locksets",
    trade: "door",
    kind: "material",
    uom: "EA",
    unitCost: 188.0,
    sellPrice: 425.0,
    serialized: false,
    hazmat: false,
    status: "active",
    vendor: "Allegion / Banner Solutions",
    stock: [
      { locationId: "loc_wh_main", onHand: 22, reserved: 4, min: 10, max: 40 },
      { locationId: "loc_counter", onHand: 3, reserved: 0 },
      { locationId: "loc_van_mike", onHand: 2, reserved: 0, min: 2, max: 4 },
      { locationId: "loc_van_jose", onHand: 0, reserved: 0, min: 2, max: 4 },
      { locationId: "loc_van_carlos", onHand: 1, reserved: 1, min: 2, max: 4 },
    ],
    brandId: "brd_sch",
    visibility: "catalog",
    updatedAt: "2026-05-22T10:11:00Z",
  },
  {
    id: "itm_003",
    sku: "HES-1006-630",
    mpn: "HES 1006-630",
    upc: "045678910035",
    name: "HES 1006 Electric Strike, 12/24 VDC, 630 Finish",
    category: "Electric Strikes",
    trade: "security",
    kind: "material",
    uom: "EA",
    unitCost: 142.0,
    sellPrice: 315.0,
    serialized: true,
    hazmat: false,
    status: "active",
    vendor: "ADI / Anixter",
    stock: [
      { locationId: "loc_wh_main", onHand: 18, reserved: 6, min: 8, max: 30 },
      { locationId: "loc_counter", onHand: 2, reserved: 0 },
      { locationId: "loc_van_mike", onHand: 1, reserved: 0, min: 1, max: 2 },
      { locationId: "loc_van_jose", onHand: 1, reserved: 0, min: 1, max: 2 },
      { locationId: "loc_van_carlos", onHand: 0, reserved: 0, min: 1, max: 2 },
    ],
    serials: ["HES-A8821", "HES-A8822", "HES-A8823"],
    photoUrl: svgPhoto("HES", "#7c3aed"),
    brandId: "brd_assa",
    visibility: "catalog",
    updatedAt: "2026-05-24T08:02:00Z",
  },
  {
    id: "itm_004",
    sku: "DSC-NEO-HS2128",
    mpn: "HS2128NK",
    upc: "045678910042",
    name: "DSC PowerSeries Neo HS2128 Alarm Panel",
    category: "Alarm Panels",
    trade: "security",
    kind: "material",
    uom: "EA",
    unitCost: 215.0,
    sellPrice: 540.0,
    serialized: true,
    hazmat: false,
    status: "active",
    vendor: "ADI",
    stock: [
      { locationId: "loc_wh_main", onHand: 6, reserved: 2, min: 4, max: 12 },
      { locationId: "loc_counter", onHand: 0, reserved: 0 },
      { locationId: "loc_van_mike", onHand: 1, reserved: 0 },
      { locationId: "loc_van_jose", onHand: 0, reserved: 0 },
      { locationId: "loc_van_carlos", onHand: 1, reserved: 0 },
    ],
    serials: ["NEO-22441", "NEO-22442", "NEO-22443"],
    updatedAt: "2026-05-21T17:30:00Z",
  },
  {
    id: "itm_005",
    sku: "LCN-4040XP-AL",
    mpn: "4040XP-RH",
    name: "LCN 4040XP Surface Door Closer, Aluminum",
    category: "Door Closers",
    trade: "door",
    kind: "material",
    uom: "EA",
    unitCost: 198.0,
    sellPrice: 440.0,
    serialized: false,
    hazmat: false,
    status: "active",
    vendor: "Allegion / CRL",
    stock: [
      { locationId: "loc_wh_main", onHand: 14, reserved: 3, min: 6, max: 24 },
      { locationId: "loc_counter", onHand: 1, reserved: 0 },
      { locationId: "loc_van_mike", onHand: 2, reserved: 1 },
      { locationId: "loc_van_jose", onHand: 1, reserved: 0 },
      { locationId: "loc_van_carlos", onHand: 0, reserved: 0 },
    ],
    brandId: "brd_sch",
    visibility: "catalog",
    updatedAt: "2026-05-20T11:18:00Z",
  },
  {
    id: "itm_006",
    sku: "HVC-CAP-45-5",
    mpn: "TRCFD455CH",
    upc: "045678910059",
    name: "Dual Run Capacitor 45/5 MFD 440V",
    category: "Capacitors",
    trade: "hvac",
    kind: "material",
    uom: "EA",
    unitCost: 11.25,
    sellPrice: 38.0,
    serialized: false,
    hazmat: false,
    status: "active",
    vendor: "Ferguson HVAC",
    stock: [
      { locationId: "loc_wh_main", onHand: 92, reserved: 6, min: 40, max: 180 },
      { locationId: "loc_counter", onHand: 18, reserved: 0 },
      { locationId: "loc_van_mike", onHand: 8, reserved: 1, min: 6, max: 15 },
      { locationId: "loc_van_jose", onHand: 11, reserved: 0, min: 6, max: 15 },
      { locationId: "loc_van_carlos", onHand: 4, reserved: 1, min: 6, max: 15 },
    ],
    photoUrl: svgPhoto("CAP", "#ea580c"),
    updatedAt: "2026-05-24T07:55:00Z",
  },
  {
    id: "itm_007",
    sku: "HVC-FIL-20X25-M11",
    name: "Pleated Air Filter 20x25x1, MERV 11",
    category: "Air Filters",
    trade: "hvac",
    kind: "material",
    uom: "EA",
    unitCost: 6.4,
    sellPrice: 22.0,
    serialized: false,
    hazmat: false,
    status: "active",
    vendor: "Ferguson HVAC",
    stock: [
      { locationId: "loc_wh_main", onHand: 240, reserved: 12, min: 100, max: 400 },
      { locationId: "loc_counter", onHand: 30, reserved: 0 },
      { locationId: "loc_van_mike", onHand: 22, reserved: 4, min: 12, max: 36 },
      { locationId: "loc_van_jose", onHand: 18, reserved: 2, min: 12, max: 36 },
      { locationId: "loc_van_carlos", onHand: 9, reserved: 0, min: 12, max: 36 },
    ],
    updatedAt: "2026-05-23T13:00:00Z",
  },
  {
    id: "itm_008",
    sku: "HVC-R410A-25LB",
    mpn: "R410A-25",
    name: "R-410A Refrigerant, 25 lb Cylinder",
    category: "Refrigerant",
    trade: "hvac",
    kind: "material",
    uom: "CYL",
    unitCost: 245.0,
    sellPrice: 520.0,
    serialized: true,
    hazmat: true,
    status: "active",
    vendor: "Ferguson HVAC",
    stock: [
      { locationId: "loc_wh_main", onHand: 4, reserved: 1, min: 2, max: 8 },
      { locationId: "loc_counter", onHand: 0, reserved: 0 },
      { locationId: "loc_van_mike", onHand: 1, reserved: 0 },
      { locationId: "loc_van_jose", onHand: 1, reserved: 0 },
      { locationId: "loc_van_carlos", onHand: 0, reserved: 0 },
    ],
    serials: ["CYL-R410-552201", "CYL-R410-552202"],
    updatedAt: "2026-05-19T09:40:00Z",
  },
  {
    id: "itm_009",
    sku: "PLB-COP-3-4-L",
    name: "Copper Pipe, Type L, 3/4 in × 10 ft",
    category: "Copper Pipe",
    trade: "plumbing",
    kind: "material",
    uom: "FT",
    unitCost: 4.85,
    sellPrice: 11.5,
    serialized: false,
    hazmat: false,
    status: "active",
    vendor: "Winsupply",
    stock: [
      { locationId: "loc_wh_main", onHand: 420, reserved: 30, min: 200, max: 800 },
      { locationId: "loc_counter", onHand: 0, reserved: 0 },
      { locationId: "loc_van_mike", onHand: 0, reserved: 0 },
      { locationId: "loc_van_jose", onHand: 40, reserved: 0, min: 20, max: 60 },
      { locationId: "loc_van_carlos", onHand: 20, reserved: 0, min: 20, max: 60 },
    ],
    updatedAt: "2026-05-22T16:20:00Z",
  },
  {
    id: "itm_010",
    sku: "PLB-PEX-1-2-RED",
    name: "PEX-A Tubing, 1/2 in × 100 ft, Red",
    category: "PEX Tubing",
    trade: "plumbing",
    kind: "material",
    uom: "ROLL",
    unitCost: 38.0,
    sellPrice: 96.0,
    serialized: false,
    hazmat: false,
    status: "on_backorder",
    vendor: "Winsupply",
    stock: [
      { locationId: "loc_wh_main", onHand: 0, reserved: 4, min: 6, max: 20 },
      { locationId: "loc_counter", onHand: 0, reserved: 0 },
      { locationId: "loc_van_mike", onHand: 0, reserved: 0 },
      { locationId: "loc_van_jose", onHand: 1, reserved: 1 },
      { locationId: "loc_van_carlos", onHand: 0, reserved: 0 },
    ],
    updatedAt: "2026-05-23T11:05:00Z",
  },
  {
    id: "itm_011",
    sku: "KAB-PEAKS-IC-T7",
    mpn: "PIN-7-PIN-IC",
    name: "Kaba Peaks Preferred IC 7-Pin Cylinder",
    category: "Cylinders",
    trade: "locksmith",
    kind: "material",
    uom: "EA",
    unitCost: 72.0,
    sellPrice: 165.0,
    serialized: false,
    hazmat: false,
    status: "active",
    vendor: "ASA",
    stock: [
      { locationId: "loc_wh_main", onHand: 28, reserved: 4, min: 12, max: 60 },
      { locationId: "loc_counter", onHand: 4, reserved: 0 },
      { locationId: "loc_van_mike", onHand: 3, reserved: 0, min: 3, max: 8 },
      { locationId: "loc_van_jose", onHand: 2, reserved: 0, min: 3, max: 8 },
      { locationId: "loc_van_carlos", onHand: 3, reserved: 0, min: 3, max: 8 },
    ],
    brandId: "brd_kaba",
    visibility: "catalog",
    updatedAt: "2026-05-20T14:00:00Z",
  },
  {
    id: "itm_012",
    sku: "HID-PROX-26",
    name: "HID ProxPoint Plus Reader, Wiegand 26",
    category: "Access Readers",
    trade: "security",
    kind: "material",
    uom: "EA",
    unitCost: 85.0,
    sellPrice: 195.0,
    serialized: true,
    hazmat: false,
    status: "active",
    vendor: "ADI",
    stock: [
      { locationId: "loc_wh_main", onHand: 10, reserved: 3, min: 6, max: 20 },
      { locationId: "loc_counter", onHand: 1, reserved: 0 },
      { locationId: "loc_van_mike", onHand: 2, reserved: 1 },
      { locationId: "loc_van_jose", onHand: 0, reserved: 0 },
      { locationId: "loc_van_carlos", onHand: 2, reserved: 0 },
    ],
    serials: ["HID-PP-99811", "HID-PP-99812", "HID-PP-99813"],
    brandId: "brd_assa",
    visibility: "catalog",
    updatedAt: "2026-05-22T08:42:00Z",
  },
  {
    id: "itm_013",
    sku: "DOR-WGT-CMB-FRP",
    name: "Door Weatherseal Kit, Commercial, Frame + Bottom",
    category: "Weather Seals",
    trade: "door",
    kind: "material",
    uom: "KIT",
    unitCost: 32.0,
    sellPrice: 85.0,
    serialized: false,
    hazmat: false,
    status: "active",
    vendor: "CRL",
    stock: [
      { locationId: "loc_wh_main", onHand: 36, reserved: 5, min: 12, max: 60 },
      { locationId: "loc_counter", onHand: 6, reserved: 0 },
      { locationId: "loc_van_mike", onHand: 2, reserved: 0 },
      { locationId: "loc_van_jose", onHand: 3, reserved: 0 },
      { locationId: "loc_van_carlos", onHand: 4, reserved: 1 },
    ],
    updatedAt: "2026-05-21T09:12:00Z",
  },
  {
    id: "itm_014",
    sku: "SVC-LCK-LBR-HR",
    name: "Locksmith Labor — Hourly",
    category: "Labor",
    trade: "locksmith",
    // Was "labor" - retired kind. It kept billing as SERVICE either way; the
    // explicit internal_only below is what actually keeps it off the catalog.
    kind: "service",
    uom: "HR",
    unitCost: 65.0,
    sellPrice: 165.0,
    serialized: false,
    hazmat: false,
    status: "active",
    vendor: "Internal",
    stock: [],
    visibility: "internal_only",
    updatedAt: "2026-05-01T00:00:00Z",
  },
  {
    id: "itm_015",
    sku: "SVC-REKEY-RES",
    name: "Residential Rekey — Up to 6 Cylinders",
    category: "Service",
    trade: "locksmith",
    kind: "service",
    uom: "EA",
    unitCost: 0,
    sellPrice: 189.0,
    serialized: false,
    hazmat: false,
    status: "active",
    vendor: "Internal",
    stock: [],
    updatedAt: "2026-05-01T00:00:00Z",
  },
];

export type MovementType =
  | "receive"
  | "transfer"
  | "consume"
  | "return"
  | "adjust";

export type Movement = {
  id: string;
  occurredAt: string;
  itemSku: string;
  itemName: string;
  type: MovementType;
  qty: number;
  fromLocationId?: string;
  toLocationId?: string;
  reference: string;
  actor: string;
  // P5 Action-log enrichment (server-joined; absent on mock/legacy rows).
  itemId?: string;
  jobId?: string;
  jobNumber?: string;
  invoiceId?: string;
  invoiceNumber?: string;
  /** §14 H2: which Logistic Order issued these units (server-joined). */
  logisticOrderId?: string;
  logisticOrderNumber?: string;
  fromLocationName?: string;
  toLocationName?: string;
  actorUserId?: string;
  /** Cost snapshot — present ONLY when the server didn't cost-strip (canSeePricing). */
  unitCost?: number;
};

export const movements: Movement[] = [
  {
    id: "mv_2201",
    occurredAt: "2026-05-24T08:14:00Z",
    itemSku: "HVC-CAP-45-5",
    itemName: "Dual Run Capacitor 45/5 MFD",
    type: "consume",
    qty: 1,
    fromLocationId: "loc_van_mike",
    reference: "Job #J-1842 · Rolex 5th Ave HVAC PM",
    actor: "Mike Alvarez",
  },
  {
    id: "mv_2200",
    occurredAt: "2026-05-24T07:55:00Z",
    itemSku: "ASA-MUL-C-114",
    itemName: "Mul-T-Lock C-Series Cylinder",
    type: "transfer",
    qty: 2,
    fromLocationId: "loc_wh_main",
    toLocationId: "loc_van_jose",
    reference: "Transfer Req #TR-330",
    actor: "Counter / Stephanie",
  },
  {
    id: "mv_2199",
    occurredAt: "2026-05-23T16:42:00Z",
    itemSku: "DSC-NEO-HS2128",
    itemName: "DSC PowerSeries Neo HS2128",
    type: "receive",
    qty: 6,
    toLocationId: "loc_wh_main",
    reference: "PO #PO-2261 · ADI",
    actor: "Stephanie (Counter)",
  },
  {
    id: "mv_2198",
    occurredAt: "2026-05-23T15:11:00Z",
    itemSku: "HVC-FIL-20X25-M11",
    itemName: "Air Filter 20x25x1 MERV 11",
    type: "consume",
    qty: 4,
    fromLocationId: "loc_van_jose",
    reference: "Job #J-1839 · McDonald's Atlantic Ave",
    actor: "Jose Ramirez",
  },
  {
    id: "mv_2197",
    occurredAt: "2026-05-23T11:08:00Z",
    itemSku: "HES-1006-630",
    itemName: "HES 1006 Electric Strike",
    type: "transfer",
    qty: 1,
    fromLocationId: "loc_wh_main",
    toLocationId: "loc_van_mike",
    reference: "Transfer Req #TR-329",
    actor: "Stephanie (Counter)",
  },
  {
    id: "mv_2196",
    occurredAt: "2026-05-22T14:35:00Z",
    itemSku: "SCH-COM-DLR",
    itemName: "Schlage ND Series Storeroom",
    type: "adjust",
    qty: -1,
    fromLocationId: "loc_van_carlos",
    reference: "Cycle count variance — Bin V-3",
    actor: "Carlos Tran",
  },
];

// Trade tint for the chip on staging/approval rows. Same three-role shape as
// approvalTypeTint() in stock-approvals.ts. NOTE: trade is a taxonomy, not a
// status, and the semantic palette has no trade family, so the five trades
// collapse onto three intents here - locksmith/hvac both read warning and
// door/plumbing both read info. The chip label still carries the trade name.
export const tradeColor: Record<Trade, string> = {
  locksmith: "bg-warning-surface text-warning-text ring-warning-border",
  door: "bg-info-surface text-info-text ring-info-border",
  security: "bg-ai-surface text-ai-text ring-ai-border",
  hvac: "bg-warning-surface text-warning-text ring-warning-border",
  plumbing: "bg-info-surface text-info-text ring-info-border",
};

export function totalOnHand(item: Item) {
  return item.stock.reduce((sum, s) => sum + s.onHand, 0);
}
export function totalReserved(item: Item) {
  return item.stock.reduce((sum, s) => sum + s.reserved, 0);
}
export function totalAvailable(item: Item) {
  return totalOnHand(item) - totalReserved(item);
}
export function isLowStock(item: Item) {
  return item.stock.some((s) => s.min != null && s.onHand < s.min);
}
export function inventoryValue(item: Item) {
  return totalOnHand(item) * item.unitCost;
}
