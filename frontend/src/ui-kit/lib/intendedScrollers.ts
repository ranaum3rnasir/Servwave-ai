/**
 * The sideways scrollers the app means to have - the mobile gate's exemption list.
 *
 * Product rule (mobile PRD, decision 3): an admin or configuration table that is
 * too wide for the screen scrolls sideways INSIDE ITS OWN BOX, with its
 * identifying first column held in place, and the page itself never scrolls
 * sideways. Cards are for field and customer tables and the main record lists,
 * not for these.
 *
 * Each name below is one such box. A table opts in with `scrollBox="<name>"` on
 * the kit `Table` / `DataTable` (or the legacy `components/data/table`), which
 * renders the marker `data-mobile-scroll-x`, set to that name, on its scroll container and
 * makes the first column sticky. The mobile gate (`frontend/e2e/mobile`) imports
 * this list: a marked scroller whose name is not here is still an offender, and
 * a listed admin table whose first column scrolls out of its box fails too.
 *
 * Adding a name here is a product decision (another table is allowed to scroll
 * sideways on a phone), not a way to quiet the gate. `intended-scrollers.test.ts`
 * holds the list to exactly the names in use.
 */
export const ADMIN_SCROLL_TABLES = [
  // Reports: every report grid is one ReportTable (pages/v2/reports/components/reportTable.tsx).
  'report-table',
  // Marketing analytics.
  'marketing-channels',
  'marketing-profitability',
  'marketing-organic',
  // Settings.
  'settings-users',
  'settings-locations',
  'settings-tax-rates',
  'settings-phone-numbers',
  // The Phone page's routing tables: call groups and call flows (mobile slice 49).
  'phone-call-groups',
  'phone-call-flows',
  // The Phone page's call log from md up (mobile slice 71): eleven columns, 1,258 px, in a box that is
  // narrower than that on every screen but a very wide one. Below md it is cards, not this box.
  'phone-call-log',
  // The Phone page's Numbers tab (mobile slice 75): eight columns, 1,040 px; it had no box of its own, so
  // on a phone the whole page scrolled sideways. The Number column is pinned.
  'phone-numbers',
  // Inventory administration.
  'inventory-items',
  'inventory-assets',
  'inventory-low-stock',
  'inventory-activity',
  'inventory-logistic-orders',
  'inventory-price-book',
  'inventory-purchase-orders-open',
  'inventory-purchase-orders-history',
  'inventory-vendors',
] as const;

export type AdminScrollTable = (typeof ADMIN_SCROLL_TABLES)[number];

/**
 * The accessible name of each box. A scroll box is a keyboard-focusable region
 * (axe `scrollable-region-focusable`): with nothing focusable inside it - an
 * empty list, a read-only grid - a keyboard user could not otherwise reach it
 * to scroll it sideways. A focusable region needs a name, which a screen reader
 * announces before the table. User-visible copy: no vendor names.
 */
export const ADMIN_SCROLL_TABLE_LABELS: Record<AdminScrollTable, string> = {
  'report-table': 'Report table',
  'marketing-channels': 'Channels table',
  'marketing-profitability': 'Profitability table',
  'marketing-organic': 'Organic traffic table',
  'settings-users': 'Users table',
  'settings-locations': 'Locations table',
  'settings-tax-rates': 'Tax rates table',
  'settings-phone-numbers': 'Phone numbers table',
  'phone-call-groups': 'Call groups table',
  'phone-call-flows': 'Call flows table',
  'phone-call-log': 'Call log table',
  'phone-numbers': 'Numbers table',
  'inventory-items': 'Items table',
  'inventory-assets': 'Assets table',
  'inventory-low-stock': 'Low stock table',
  'inventory-activity': 'Activity table',
  'inventory-logistic-orders': 'Logistic orders table',
  'inventory-price-book': 'Price book table',
  'inventory-purchase-orders-open': 'Open purchase orders table',
  'inventory-purchase-orders-history': 'Purchase order history table',
  'inventory-vendors': 'Vendors table',
};

/**
 * The attributes every admin scroll box renders: the gate's marker, and a named
 * region in the tab order (see `ADMIN_SCROLL_TABLE_LABELS`).
 */
export function scrollBoxAttributes(name: AdminScrollTable) {
  return {
    [INTENDED_X_SCROLLER_ATTR]: name,
    role: 'region',
    'aria-label': ADMIN_SCROLL_TABLE_LABELS[name],
    tabIndex: 0,
  } as const;
}

/**
 * The box's focus ring, for keyboard focus only: a pointer click on a row draws
 * nothing, so a desktop looks as it did. Drawn inside the box, which clips
 * anything outside it.
 */
export const SCROLL_BOX_FOCUS_CLASS =
  'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring';

/**
 * Intended sideways scrollers that are not admin tables. The one-row tab strip
 * (pages/v2/_shared/tabs.tsx) scrolls its tabs in place by design.
 *
 * `dialog-line-table`: the PO and item-group line tables inside the inventory
 * dialogs (NewPODialog, PODetailDialog, GeneratePODialog, AddGroupDialog). The
 * mobile PRD's inventory area pass says they "scroll instead of clipping"
 * (mobile slice 31): a row of inputs (SKU, Description, UoM, Qty, Unit $, Ext.)
 * cannot fold into a phone's width, and until then an `overflow-hidden` wrapper
 * cut the money columns off. No first column is pinned: each row is a form, and
 * its first cell (a line number or an item picker) is not what identifies it.
 *
 * `lifecycle-rail` (mobile slice 75): the job page's lifecycle rail (components/jobs/JobLifecycleBar.tsx).
 * It has a node per visit, so its length is not fixed (its own comment says why it scrolls: without
 * a scroller a job with several trips clips its last nodes away). The nodes are buttons, so the box
 * is already reachable from the keyboard.
 *
 * `record-list` and `line-items-table` (mobile slice 75): the two wide tables that are not admin
 * tables. The main record lists (leads, customers, jobs, estimates, invoices: `DataTable` with no
 * `scrollBox`) are cards below md and a table from md up; that table is wider than a tablet's box
 * (1,100 to 1,500 px) and has always scrolled sideways inside it, on the desktop too. The line-items
 * table on an estimate or invoice (`LineItemsTable`) is 1,040 px and does the same from md up (below
 * md it is the card editor of slice 59). Neither pins a column: the record list's first column is a
 * checkbox, and the line table's is a drag handle. Naming them records that this is the design on
 * tablets; the page itself still never scrolls sideways.
 *
 * `email-body`: the HTML body of a received message in the inbox reader. A sender's table or
 * image can be wider than a phone, and cannot be reflowed (it is the sender's markup); it scrolls
 * inside the message box and never widens the page (mobile slice 46).
 *
 * `payments-quick-filters`: the Payments page's row of quick-filter chips (All, Succeeded, ... Needs attention).
 * The approved v7 payments mockup draws it as one row that scrolls sideways (`.chips { overflow-x: auto }`) and the
 * spec (7.4) says so; seven pill chips with counts are wider than a phone, and wrapping them would push the table
 * down. The chips are buttons, so the row is already reachable from the keyboard.
 */
export const OTHER_INTENDED_X_SCROLLERS = [
  'tab-strip', 'dialog-line-table', 'lifecycle-rail', 'record-list', 'line-items-table', 'email-body', 'payments-quick-filters',
] as const;

/**
 * The attributes of a dialog's line-table scroll box (see `dialog-line-table`
 * above): the gate's marker, and a named region in the tab order so a keyboard
 * user can scroll a box whose rows hold nothing focusable.
 */
export const DIALOG_LINE_TABLE_SCROLL = {
  'data-mobile-scroll-x': 'dialog-line-table',
  role: 'region',
  'aria-label': 'Line items',
  tabIndex: 0,
} as const;

/**
 * The attributes of an email body's scroll box (see `email-body` above): the gate's marker, and a
 * named region in the tab order so a keyboard user can scroll a wide table sideways.
 */
export const EMAIL_BODY_SCROLL = {
  'data-mobile-scroll-x': 'email-body',
  role: 'region',
  'aria-label': 'Message content',
  tabIndex: 0,
} as const;

export type IntendedXScroller = AdminScrollTable | (typeof OTHER_INTENDED_X_SCROLLERS)[number];

/** Every name the gate accepts on `data-mobile-scroll-x`. */
export const INTENDED_X_SCROLLERS: readonly IntendedXScroller[] = [
  ...ADMIN_SCROLL_TABLES,
  ...OTHER_INTENDED_X_SCROLLERS,
];

/** The marker attribute, shared with the gate. */
export const INTENDED_X_SCROLLER_ATTR = 'data-mobile-scroll-x';
