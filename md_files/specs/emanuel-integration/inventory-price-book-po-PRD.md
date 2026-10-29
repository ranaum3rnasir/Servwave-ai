# `[PRODUCT]` — Product Requirements Document
## Inventory + Price Book + Purchase Orders Modules (within FSM + CMMS Platform)

**Author:** Director Architect (synthesized from 9-agent research + Emanuel Dahan interview)
**Version:** v1.1 Draft (rev 2026-05-26)
**Date:** 2026-05-26
**Status:** Phase 5 Revision — UX Increment Locked from Prototype
**Audience:** Senior developer / engineering team building MVP

**Legend:**
- `[ASSUMPTION — Director recommendation]` = Director chose without explicit Emanuel input; revisit at review
- `[DEFERRED]` = Decision deferred; placeholder until resolved
- `[Agent N]` = Research source citation (see Appendix G)
- `[PROTOTYPE v1.1]` = Locked from /dashboard interactive prototype; binding on engineering build

**v1.1 changelog (UX increment from prototype review with Emanuel, 2026-05-25):**
- Item record gets `photo_url` field + camera-capture path on mobile (§5.1, §5.2)
- Vendor / Category / Location all become dropdown-with-inline-create (§5.4, §6.2, §7.6)
- Cross-cutting filter popover on inventory list (trade · kind · stock state · vendor · flags) (§5.4)
- Full edit mode on every catalog item (§5.4, §6 acceptance criteria)
- "Restock" as a first-class flow distinct from formal PO receiving (§5.2.1, §7.4)
- **CSV Import + Export** locked spec for Inventory list (§5.4.B) — locked column set on export, alias-mapped column auto-detection on import, AI auto-categorize toggle, SKU-collision triage
- **Reserve Levels** (min / max thresholds) captured at Add Item time per location (§5.4.A) — drives low-stock badge + KPI count + filter; adds `stock_balance.min_qty` / `max_qty` (Appendix A.3)
- **KPI tiles as toggle filters** + **hide-by-default detail panel** with slide-in animation (§5.4.A)
- **Stock-state filter is location-aware** + **count text adapts** to filter combo (§5.4.A)
- **Low-Stock Health by Location grid** — color-coded per-location cards (green/yellow/red severity by min ratio), auto-renders when Low Stock filter is active (§5.4.A.i)
- **Edit Location** flow with **admin RBAC gate** — pencil icon on each row, opens dialog in edit mode for `owner` / `admin` / `warehouse_manager` / `inventory_admin` (§5.4.A.ii, §11.7) — adds `inventory.location.manage` permission + centralized client-side role helpers
- **Branch as a managed entity** — dropdown-with-inline-create inside Add/Edit Location (§5.4.A.iii) — promotes branch from a free-text label to a first-class row in the `branch` table (Appendix A.1) with code · address · phone · manager · timezone fields
- **Primary Tech + Vehicle pickers** in Add/Edit Location use the org's tech roster — tech dropdown shows trade + certs, vehicle auto-fills from tech's assigned vehicle (override-safe), Vehicle field has a datalist of known org vehicles (§5.4.A.iv)
- **Stock-Out Approval queue** — field techs scan to consume / return / transfer / write-off, request queues for manager sign-off before stock_movement posts. New `stock_action_approval` table (Appendix A.7), new RBAC permission, new "Approvals" view tab + amber "Needs Approval" KPI tile (§5.4.A.v)
- **Phone-camera scan + role-aware post-match actions** in ScanDialog — "Phone Camera" button triggers rear camera on mobile, after match a 2–3 action panel shows role-appropriate options (Open / Add stock / Request approval) (§5.4.A.vi)
- **Scan → smart routing**: matched code routes to existing item (no duplicates ever created); unmatched code auto-opens Add Item dialog with the scanned code pre-filled as SKU via the new `prefilledCode` prop (§5.4.A.vi)
- **Transfer dialog gains bulk-to-staging modes**: Single item · By PO · By Job — bulk pick all lines from an open PO or job-linked POs and stage them to the job staging area in one submit (§5.4.A.vii)
- **Approval Detail Dialog** — clicking any approval card opens a full-context modal with item card, movement request, requester tech (branch + vehicle + certs), job context strip (job #/customer/site/scheduled), tech's reason, optional approval note, and Approve/Reject footer (§5.4.A.v.4a)
- **Stage Detail Dialog** with inline edit + activity audit feed — every staging card opens a modal with 3-column overview (job/tech/staged-at) + editable line items + per-field audit trail with relative timestamps; unsaved edits show inline with an "unsaved" pill; `job_stage` gets `audit_log` jsonb + `updated_at` columns (§7.4.A.6, Appendix A.6)
- **"+ New Request" entry point on Approvals page** — back-office override that lets dispatcher / admin submit any of 4 approval types (Consume / Transfer / Return / Write-off) on behalf of a field tech; new request lands at top of pending queue (§5.4.A.v.4b)
- **Item picker = "dropdown OR scan"** locked pattern — every dialog that asks for an item gets a "Scan" button next to the dropdown. ScanDialog gains `pickerMode` flag that replaces the multi-action panel with a single "Use this item" CTA (§5.4.A.v.4b)
- **Single-item transfer destination type pills + unified cross-search** — Single Item mode in Transfer dialog adds Location · Job/PO segmented control; Job/PO mode uses a unified search that auto-detects whether you typed a job # or PO # and finds the right entity (§5.4.A.vii)
- **PO Preview + Print/Save-as-PDF** — every popup that references a Purchase Order (CreateStageDialog, StagingView From-PO picker + stage cards, StageDetailDialog, TransferDialog PO destination, RestockDialog vendor-PO source) surfaces an Eye-icon **Preview PO** affordance that opens a fully-formatted, print-ready document (vendor + ship-to + job context + line items with unit cost + extended totals + signature block). Footer offers **Save as PDF** and **Print** — both route through `window.print()` so the browser's native print dialog handles PDF export with zero added dependencies. `@media print` CSS isolates only the document for printing (§7.2.A)
- **Pickup Ticket Preview + Print + Save-as-PDF + Email** — every staging entry's detail popup gains a five-button footer (`Close · Preview · Email · Print / PDF · Edit Stage`). Preview opens `StagePreviewDialog` (Job · Tech · Staged-At cards, notes banner, line-items table with backorder column, totals strip, sign-out + manager signature lines). Email opens `EmailComposeDialog` with suggested-recipient chips (assigned tech, branch manager, dispatch, counter), pre-filled subject + body summarizing the ticket, and an auto-generated `pickup-ticket-<Job#>.pdf` attachment chip. Print/PDF flows route through `window.print()` with print-isolated CSS so only the document renders (§7.4.A.7)
- New **Job Staging** sub-module under Inventory (§7.4.A) — tracks partial shipments, backorders, ready-for-pickup against a specific Job
- "From PO" picker auto-creates a staging entry from an open logistics order (§7.2, §7.4.A)
- Pickup-from-vendor address now on Vendor record (§7.6) and surfaced in staging UX
- Job/Tech pickers throughout staging UX auto-fill customer/site/trade/schedule and vehicle context (§3, §6, §11.7)
- **Add Item dialog — Name is the only required field** (rev 2026-05-26): SKU is now optional (placeholder reads *"Auto-generated if blank"*); on save with no SKU the system auto-generates one via the `ITM-<NAME-SLUG>-<RAND>` pattern, same algorithm as the existing AI Suggest button. Unit Cost is also no longer required (defaults to `0` when blank — first Restock writes the real cost). Only Item Name carries the rose `*` indicator (§5.4.A line 310, Appendix A.2). Rationale: lowest-friction onboarding for trade businesses that want to catalog items by name first and let codes/costs settle later; matches the anti-mandatory-fields stance taken against ServiceTitan PO tyranny (§4.3 VoC line 103). *(Note: the SKU prefix was originally trade-derived; superseded by the trade-agnostic sweep — see entry below.)*
- **Restock dialog — "From which van" picker for truck returns** (rev 2026-05-26): when `source = truck_return`, the dialog now renders a required **"From which van"** dropdown listing every Truck-type location with primary tech + **live per-item on-hand count** per option (e.g. *"🚚 Mike's Van · Mike Alvarez · 4 on hand"*). The destination warehouse/van is auto-disabled in the list so a van can't be returned to itself. On submit, `handleRestock` posts the symmetric movement — destination credited AND source van decremented (floored at 0) in the same state update — and the confirmation toast names the van (*"Received 2 × ASA-MUL-C-114 into Main Warehouse · Truck return · Mike's Van"*). New `fromLocationId` field on the Restock payload + new `items` prop on RestockDialog so the picker reflects live state across consecutive receives (§5.4.A line 319, Appendix A.4 `stock_movement.from_location_id` already supports this).
- **Inventory UI is trade-agnostic** (rev 2026-05-26): every place in the inventory experience that asked the user to classify an item by trade has been stripped, because this CRM is for **all trades** by design and per-item trade classification is friction without payoff. Specifically: (a) **AddItemDialog** removes the Trade dropdown — Category dropdown now spans 2 columns and lists all categories flat (no per-trade grouping); SKU auto-generator uses `ITM-` prefix (was trade-prefixed). (b) **InventoryPage** removes the trade chip from item rows and the right-side detail panel; drops the `Trade` column from CSV export. (c) **FiltersPopover** removes the Trade filter section + trade chip from the active-filter strip. (d) **AddCategoryDialog** removes the "Scope to Trade" pill picker — every category is org-wide. (e) **ImportCSVDialog** drops `trade` from the column mapping + required fields + sample CSV template. Data model preserved: `Item.trade` still exists silently as `"general"` (default) so POs, Staging, Approvals, and Tech records that reference trade via job/tech context don't break — those describe what kind of *work* a job/tech is doing, not how an inventory item is classified (§5.4.A line 310, §5.4.B import spec, §6.2 categories, §11.7 RBAC unchanged).
- **ApprovalDetailDialog — "Email Team" button** (rev 2026-05-26): footer gains a new **Email Team** button (Mail icon, outlined indigo) between Close and Reject in the pending-and-canApprove view-mode branch. Opens a new `ApprovalEmailDialog` nested at `zIndex={80}` with `lockEscape`. Composer pre-fills To with the **warehouse_lead at the requester's branch** (falls back to branch manager + approvals@ alias if no lead at that branch), suggested-recipient chips for branch manager / approvals alias / requester FYI, subject `Stock-Out Approval Needed · <SKU> · Job <#>`, and a body listing type, item, qty/value, From/To location, serial captured, job context, tech's reason, and a deep link `/approvals/<id>`. Attachment chip references `approval-request-<id>.pdf`. On send, fires the parent `onEmailSent` callback → ApprovalsView toasts `📧 Approval request emailed to N recipient(s) · <emails>` (§5.4.A.v.4a).
- **NewApprovalRequestDialog — "Submit + Email Team" button** (rev 2026-05-26): when an admin/dispatcher submits an approval request on behalf of a tech via the "+ New Request" entry point on the Approvals page (§5.4.A.v.4b), the footer now offers a secondary **Submit + Email Team** button (outlined indigo, Mail icon) alongside the primary Submit for Approval. It validates the form, submits to create the `StockApproval` row (parent's `onSubmit` callback now returns the created approval), then opens the same `ApprovalEmailDialog` pre-filled with the just-created request. Approver pool is scoped to the **requester tech's branch** so a request created on behalf of a Queens tech routes to the Queens approver list (not Brooklyn HQ). Submit-only path unchanged.
- **PrePODetailDialog shipped end-to-end + NewPODialog job-link auto-fills line items** (rev 2026-05-28): two related closes on the Purchase Orders page in one pass. **(1) Pre-PO row click now opens a real detail dialog** — previously clicking an RFQ or Estimate Reservation row in the Pre-PO tab fired a scaffold `alert("[scaffold] RFQ row → opens EstimateComparisonDialog to pick the winning vendor. Wires next.")` (or the reservation equivalent). The owner's read on it was: *"When I press on the pre-PO to open the PO and see the estimate stage of the PO, I cannot see it. Can you fix it so when I press it I can see all the items and see the estimate when we send an email to the customer, when we send an email to the vendor to get the price quote, or when the customer responds to that PO by email inside the PO?"* This rev replaces the alert with a real **`PrePODetailDialog`** component that mirrors `PODetailDialog`'s shape (header summary card · inner tab strip · status-adaptive footer) but adapts content to the row kind. **Three tabs**, common across RFQ + Reservation: (a) **Items** — line list (`#` · SKU mono · description · UoM · qty right-aligned) with a footer total-units strip. The 8-row EST-5521 (NYC DOE PS-321) reservation renders all 8 SKUs at their reserved qty (4 LCN closers, 2 HES strikes, 2 Schlage cyl locks, 2 Mul-T-Lock cores, 1 each of FRP door, Kaba IC, locksmith hour, rekey service). (b) **Vendor Quotes** (RFQ rows) — compact 3-row comparison table: Vendor · Total · Lead · vs Cheapest delta% · Notes. Recommended row gets a `Crown` icon + emerald row tint; the "Cheapest" and "Fastest" cells get colored badges. A green recommendation banner above the table calls out the composite-score winner with vendor name, total, lead-days, and *"60% price · 25% lead · 15% reliability"* scoring formula. An **"Open full side-by-side comparison →"** button at the bottom-right launches the existing `EstimateComparisonDialog` (§7.2.B) at `zIndex={80}` with `lockEscape`, so the operator can drill into the full per-line breakdown. **Estimate** (Reservation rows) — sky-tinted banner with `CheckCircle2` icon · *"Customer-approved estimate"* label · EST-#### · approved-on date · customer email · preferred vendor; below it a full line table with synthesized per-line extended prices (proportional from `reservedTotal × qty/totalUnits` until per-line unit prices land in the data model) and a footer *"Reserved Total"* row. (c) **Email Activity** — chronological thread of every outbound + inbound message tied to the row. Each `EmailThreadEntry` renders as a card with a colored kind chip (`RFQ sent` indigo · `Vendor quote` emerald · `Estimate sent` sky · `Customer reply` emerald · `Follow-up` slate), direction arrow, sender / recipient, timestamp, full subject + body in `<pre>` preserving whitespace, and attachment chips (`Paperclip` icon · filename). The reservation's "Estimate EST-5521 · PS-321 Lobby Door Hardware · $6,482" outbound + Linda Carter's *"approved as quoted"* inbound reply both render top-to-bottom. RFQ rows show the outbound RFQ to all 3 vendors plus each vendor's quote reply (e.g. *"Maria Velez @ ASA / Mul-T-Lock NA · Re: RFQ-0042 · Quote attached · 5-day lead"*). **Status-adaptive footer:** RFQ with `status: "ready_to_compare"` → *"Compare quotes & pick winner"* primary (also opens EstimateComparisonDialog); RFQ with `status: "awaiting_quotes"` → *"Send reminder to vendors"* disabled with helper text *"Waiting on N of 3 vendors"*. Reservation → *"Convert to Purchase Order"* primary with helper *"Reserved $X,XXX.XX · awaiting PO conversion"*. **(2) NewPODialog auto-fills line items from the linked job** — owner read: *"I want as well, when the auto generates from the job link. If this job link has a PO existing, it can add. The line item inside the job is what needs to be picked up or what needs to create the PO on."* When the operator picks a job in the Job Link typeahead (§7.4.B.8), the dialog now does a three-way lookup against `estimateReservations` / `rfqs` / `existingPOs` filtered by `jobNumber` and reacts: (a) **Reservation match wins** — if any `EstimateReservation` has `jobNumber === job.jobNumber`, every reserved line resolves against the items catalog by `itemSku` (skipping inactive items defensively) and pre-populates the dialog's line-items table; the vendor select primes from `reservation.preferredVendor` if currently empty. (b) **RFQ fallback** — if there's no reservation but an open RFQ on the job, lines pre-populate from `rfq.lines` and the vendor primes from `rfq.quotes.find(q => q.recommended)?.vendor`. (c) **Existing-PO callout** — an amber banner above the line-items table lists every still-open PO for the linked job (status `draft | sent | partial`) with vendor, item count, and received progress (e.g. *"PO-2261 · ADI / Anixter · 3 items (15/22 units received)"*) plus the helper line *"Items on those POs are already in flight — add lines here only for SKUs the existing POs don't cover."* — the cross-check the owner explicitly asked for so the operator doesn't double-order SKUs the vendor is already shipping. (d) **Auto-fill banner** — an indigo `Sparkles`-icon banner above the line-items table reads *"Auto-filled N lines from EST-XXXX"* (or *"from RFQ-XXXX"*) with body copy explaining the source and an inline **× Clear** action that resets the lines back to one empty starter row and dismisses the banner. (e) **Empty-form guard** — auto-fill only fires when the operator hasn't started editing lines yet (`lines.length === 1 && !lines[0].itemId && qty in ["", "1"]`); manual edits are never clobbered. (f) **Unlink-job behavior** — clicking the Unlink action on the linked-job pill clears the auto-filled lines AND the banner (since those lines belonged to the previous job), restoring the single-empty-row baseline. **Data shape extensions to `pre-po.ts`:** `RFQ` and `EstimateReservation` both gain `lines: PrePOLine[]` (real items, not just the existing `linesSummary` count) and `emails: EmailThreadEntry[]` (RFQ-out + vendor replies for RFQ rows; estimate-out + customer reply for reservation rows). `PrePOLine` is `{ itemSku · itemName · qty · uom }`; `EmailThreadEntry` is a typed discriminated union with `direction`, `kind`, `from`, `to[]`, `subject`, `body`, `sentAt`, optional `attachments[]`. All seeded rows ship with realistic line counts (RFQ-0042 has 4 SKUs / 28 units, EST-5521 has 8 SKUs / 14 units, RFQ-0044 has 6 SKUs / 41 units, etc.) and realistic email threads (Maria Velez at ASA · Tom Bryce at ADI · Janet Liu at Stanley for RFQ-0042; Linda Carter at NYCDOE for EST-5521; etc.). `EstimateReservation` also gains optional `customerEmail?: string` for the Email Activity tab's recipient display. **Jobs seed:** `data/jobs.ts` gains 4 new rows (J-1872 Chase Bank · J-1874 Brooklyn Brewery · J-1876 Sweetgreen · J-1877 NYC DOE PS-321) so the jobs referenced by the RFQs + reservation actually exist in the typeahead — picking *"NYC"* in the Job Link search now surfaces J-1877 and triggers the 8-line auto-fill from EST-5521 as a first-class demo path. **Qty column fix:** during verification the per-row qty input was invisible — `value="1"` was set but hidden behind the browser's native ↑↓ spinner arrows AND the column was being squeezed by the long Item column (Tailwind's `w-24` is treated as a *preference* by the table layout, not a floor). Fixed by (i) switching to `min-w-[6.5rem]` on the Qty `<th>` so the column has a hard floor, (ii) centering the value (`text-center` + `tabular-nums`), and (iii) suppressing the native spinner arrows with `[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`. **Delete button visibility:** the existing per-row trash button used `text-slate-400` faint styling that was easy to miss AND the action column was being pushed off the right edge of the `lg`-sized dialog. Fixed by (i) restyling the trash as a clearly bordered chip (`inline-flex h-7 w-7 ... border border-slate-200 bg-white ... hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600`), (ii) adding `min-w-[3rem]` to the action `<th>` so it can't be squeezed, (iii) bumping the dialog from `size="lg"` (max-w-2xl, 672px) to `size="xl"` (max-w-4xl, 896px) so the 4-column line-items table fits without overflow. Owner instruction: *"how do I delete the item if I want to? Can we add a delete option on the corner?"* — answer: the option was always there, the modal width was hiding it. **Files:** new `dashboard/src/components/PrePODetailDialog.tsx` (~450 LOC — Modal wrapper · header summary card · 3 inner tabs · items / quotes / estimate / email-thread renderers · nested EstimateComparisonDialog at z=80); `dashboard/src/components/PurchaseOrdersPage.tsx` (PrePODetailDialog import + `prePOActive` state slot + `handlePrePOClick` wires RFQ + Reservation rows to the new dialog · Draft rows still route to PODetailDialog · `NextActionButton` now takes an `onClick` prop instead of firing its own scaffold alert · NewPODialog gets `reservations={seedReservations}` + `rfqs={seedRFQs}` props); `dashboard/src/components/NewPODialog.tsx` (new `reservations: EstimateReservation[]` + `rfqs: RFQ[]` props · `autoFillSource` state · `pickJob` extended with the 3-source lookup + line resolution + vendor priming · `unlinkJob` extended to clear auto-filled lines · new `jobsOpenPOs` `useMemo` for the existing-PO callout · existing-PO amber banner + auto-fill indigo banner rendered above the line-items table · qty input + action column styling fixes · Modal `size` bumped to `xl`); `dashboard/src/data/pre-po.ts` (`PrePOLine` + `EmailThreadEntry` new exported types · `RFQ.lines` + `RFQ.emails` + `EstimateReservation.lines` + `EstimateReservation.emails` + `EstimateReservation.customerEmail` field additions · realistic seed data for every row); `dashboard/src/data/jobs.ts` (4 new job rows so RFQ + reservation `jobNumber` references resolve in the typeahead). Build verify: `npx tsc --noEmit` clean, `vite build` clean (1803 modules, no errors). Verified end-to-end via Claude Preview against `localhost:5174`: clicked RFQ-0042 row → dialog opened with 4 items, 3-vendor compare with ASA recommended, 4-message email thread; clicked EST-5521 reservation → 8 items, sky estimate banner with $6,482 reserved + Stanley Security preferred vendor, 2-message customer thread; opened Create PO → typed *"NYC"* → picked J-1877 → 8 lines auto-populated with correct qty (4, 2, 2, 2, 1, 1, 1, 1) + indigo *"Auto-filled 8 lines from EST-5521"* banner + Stanley primed in Vendor field; typed *"Rolex"* → picked J-1850 → amber *"This job already has 1 open PO — PO-2261 · ADI / Anixter · 3 items (15/22 units received)"* callout. (§7.2.B EstimateComparisonDialog · §7.4.B.8 NewPODialog · §7.4.B.9 PrePODetailDialog — all updated below.)
- **NewPODialog — Item picker promoted from inline popover to full-view modal browser** (rev 2026-05-28): the searchable popover shipped earlier the same rev (see entry below) was clipped at ~1 visible row by NewPODialog's body overflow — the popover lived inside the line-items `<table>` cell which sits inside the Modal body with its own scroll. Visually only one item rendered before the bottom edge cut off the rest, defeating the point of a searchable list. Owner read on it: *"I don't like how it's open. I want to see full view so when I press it, I can see the tab when you open the scroll down, and also the search by category, queue, and everything."* This rev replaces the popover-anchored design with a **dedicated `ItemSearchModal`** that opens on top of NewPODialog at `zIndex={70}`. **Trigger stays the same** — the per-row picker button still shows the picked item name + SKU (or the *"— pick an item —"* placeholder) with a chevron on the right edge, looking like a normal form input. **Click → modal opens** with a proper full-view browse surface: (a) **Large search input** at top (autofocused on open, `Search` icon glyph, placeholder *"Search by name, SKU, MPN, or category…"*) — bigger than the prior inline version, focus-ringed in indigo, filters in real time via the same `name + sku + mpn + category` haystack; (b) **Category filter chips** in a horizontally-wrapping row immediately below the search — every unique category present in the items list gets a chip with its count (*"Cylinders · 6"*, *"Electric Strikes · 4"*, etc.), sorted alphabetically; an *"All · N"* chip sits to the left as the reset; the active chip flips to indigo-on-white; click the active chip a second time to clear; the chip row is the *"queue / categories"* affordance the owner explicitly asked for; (c) a small **count + active-filter strip** below the chips reading *"Showing X of Y items · Cylinders · matching 'mul-t-lock'"* with a one-click **Clear filters** link on the right when any filter is non-default; (d) a **tall scrollable list** (max-h-[24rem] ≈ 384px, fits ≈ 12–14 rows comfortably without needing to scroll the modal itself) with **vendor-aware grouping preserved** — the chosen vendor's catalog still floats to the top under a sticky indigo *"&lt;VendorName&gt; catalog · N"* sub-header, cross-vendor items render below a sticky slate *"Cross-vendor · N"* sub-header (sticky so the operator always sees which bucket they're browsing as they scroll); each row is larger than the prior inline version (12px name + 11px metadata vs. 10px) with the metadata line now showing SKU mono · category · *"per &lt;UoM&gt;"* · optional vendor (when cross-vendor), so each row carries more of the catalog data the operator needs to disambiguate similar parts. **"+ Add a new item"** button moves from the popover footer to the **modal footer left edge** (indigo background, Plus icon, secondary label *"custom / one-off"*) — it's now the most prominent action in the picker chrome instead of buried below a scrolled list. **Modal stack semantics:** ItemSearchModal opens at `zIndex={70}` so it sits above NewPODialog (50). AddItemDialog (when "+ Add a new item" is clicked) now opens at `zIndex={80}` so it sits above the picker modal in turn. Escape / × / backdrop click each peel one modal at a time — same pattern as the rest of the app's nested modals. **Empty state:** when no items match the current filters, the list shows *"No items match the current filters. Use **+ Add a new item** below to create a custom one."* — pointing the operator at the create path when their search genuinely turns up nothing. **State:** new internal `categoryFilter: string` slot on ItemSearchModal alongside the existing `query`; both reset on close so each picker open starts fresh. **Why a modal instead of a bigger popover:** the inline popover was structurally trapped — even bumping its `max-height` further would just have it hidden behind the modal body's scroll. Portal-rendering the popover to escape the modal would have worked but adds positioning math + scroll-tracking + viewport-clamping logic for marginal UX gain. A nested modal is the cleaner pattern, matches the existing app conventions (POPreviewDialog stacks above StageDetailDialog the same way), and gives the operator a properly-scoped "browse the full catalog" surface that no popover constraint affects. **Files:** `dashboard/src/components/NewPODialog.tsx` (replaces the prior `ItemPicker` body — now just the trigger button + nested ItemSearchModal; new `ItemSearchModal` subcomponent ~150 LOC inline; `ItemRow` reused with larger styling; AddItemDialog `zIndex` bumped to 80 at the call site so the nested-modal stack stays right). Build verify: `npx tsc --noEmit` clean, `vite build` clean (1803 modules, 610ms, no errors). Owner instruction: *"I don't like how it's open. I want to see full view so when I press it, I can see the tab when you open the scroll down, and also the search by category, queue, and everything."*
- **NewPODialog — Line-item picker becomes a searchable combobox with inline "+ Add a new item"** (rev 2026-05-28): the line-item row in NewPODialog (see entries below) originally used a plain `<select>` populated with every active item in the catalog. Two problems hit the operator the moment they opened it: (1) at 50+ items the dropdown forces vertical scrolling — no way to type to filter — and (2) custom one-off parts (a specialty cylinder pulled from a supplier the operator just called, a service-trip product number the catalog doesn't carry yet) couldn't be ordered without bailing out to InventoryPage → Add Item → save → return to NewPODialog and start over. This rev replaces the native `<select>` per row with a dedicated **`ItemPicker`** combobox component (lives inline at the bottom of `NewPODialog.tsx`) and threads an **AddItemDialog mount** through the dialog so new items can be created without leaving the PO flow. **ItemPicker closed state:** looks like a regular form input — shows the picked item's name + monospace SKU (or the *"— pick an item —"* placeholder), with a `ChevronDown` glyph on the right edge. Click anywhere on the input to expand. **ItemPicker open state:** a popover positioned absolute below the trigger with three vertical sections: (a) a sticky **search input** (autofocused on open, `Search` icon glyph, placeholder *"Search by name, SKU, MPN, category…"*) — typing filters the list in real-time via a `useMemo` over a concatenated `name + sku + mpn + category` haystack, case-insensitive substring match; (b) the **filtered, vendor-aware list** — when a vendor is selected on the PO, items belonging to that vendor's catalog render under an indigo *"&lt;VendorName&gt; catalog · N"* sub-header at the top of the list, with cross-vendor items rendered below a slate *"Cross-vendor · N"* divider (the cross-vendor row shows the item's actual vendor in the metadata line so the operator knows what they're picking); each row shows the item name + truncated metadata (SKU mono · category · optional vendor) + a `CheckCircle2` indicator on the currently-selected row; (c) a pinned **"+ Add a new item"** footer button (indigo, only rendered when the parent wires `onAddItem`) — clicking it closes the popover and opens AddItemDialog scoped to the row that triggered it. **Add new item flow:** AddItemDialog opens at `zIndex={70}` (above NewPODialog at default 50) so the stack reads correctly. The dialog reuses the full AddItem form (every field — SKU, name, category, kind, UoM, unit cost, sell price, vendor, brand, group, visibility, starting stock, photo, etc.) so the new item is a fully-formed catalog row with no shortcuts. On Save, NewPODialog runs the same `NewItem → Item` conversion that InventoryPage uses (`registerNewItem` helper — auto-generates `id`, sets `status: "active"`, seeds `stock` from `startingStock`, stamps `updatedAt = now`), pushes the new Item up to PurchaseOrdersPage via the `onAddItem` callback (which prepends to the hoisted `allItems` state), and **auto-selects the new item on the row that opened the dialog** — the operator never has to find their just-created item in the list. **State hoisted up to PurchaseOrdersPage (rev 2026-05-28):** the items / vendors / categories / brands / item-groups lists are now real React state on `PurchaseOrdersPage` instead of static imports — `allItems`, `allVendorsCatalog`, `allCategoriesCatalog`, `allBrandsCatalog`, `allItemGroupsCatalog`. NewPODialog receives them as props plus matching setters wrapped as `onAddItem` / `onAddVendor` / `onAddCategory` callbacks. New items / vendors / categories created from inside a NewPODialog session **persist for the rest of the page session** — they show up in subsequent PO drafts on the same page load, and they show up in the vendor / category filter dropdowns. (Reset on full app reload per the prototype convention; production swap-out writes the new item to the catalog API and reloads from there.) **Outside-click + Escape:** the picker popover closes on any mousedown outside its container (scoped via `boxRef`) and on Escape (`keydown` listener with `e.stopPropagation()` so the outer NewPODialog doesn't also receive it). The search query resets every time the popover closes — fresh state on every open. **Empty state:** when the search yields zero matches, the body renders *"No items match \"&lt;query&gt;\". Create a new item via the footer below."* — pointing the operator at the inline-create path when they genuinely need a new SKU. **AddItemDialog change:** new optional `zIndex?: number` prop on `AddItemDialog` (passed through to its Modal) so nested mounts can layer above their parent. Default behavior unchanged when `zIndex` is omitted. **Files:** `dashboard/src/components/NewPODialog.tsx` (~210 LOC added — `ItemPicker` + `ItemRow` subcomponents, `registerNewItem` helper, `addItemForRow` state, AddItemDialog mount at end of return, new optional props `onAddItem` / `onAddVendor` / `categories` / `onAddCategory` / `brands` / `itemGroups`); `dashboard/src/components/PurchaseOrdersPage.tsx` (new imports of `categories` / `brands` / `itemGroups` + their types from `data/inventory`, five new state slots for the hoisted catalogs, six new props on the `<NewPODialog>` element); `dashboard/src/components/AddItemDialog.tsx` (new optional `zIndex` prop threaded into Modal). Build verify: `npx tsc --noEmit` clean, `vite build` clean (1803 modules, 554ms, no errors). Owner instruction: *"On the 'Pick an item', I want to have also the option to search for an item and create a new one if needed, for if it's a customized item or they need to go pick something special. I want to have the option to add an item from here, and also I want to have the option to search between the items, not just scroll down."*
- **NewPODialog — Job Link gains a typeahead that auto-fills from the jobs table** (rev 2026-05-28): the Job Link fieldset in NewPODialog (shipped earlier the same rev — see entry immediately below) originally rendered four independent free-text inputs (Job # · Customer · Trade · Site / Notes). For POs tied to an existing job in the system this was friction — the operator had to type all four manually even though the data was already in `jobs[]`. This rev replaces the four-input experience with a **single search-once auto-fill-everything** affordance. **UI:** the fieldset now leads with a search input (*"Find a job by # · customer · site…"*) carrying a `Search` icon. Typing into it opens a 6-row dropdown of matches; an empty query shows the top-6 **open** jobs (status `scheduled` or `in_progress`, sorted by `scheduledFor` ascending so the most imminent job is on top). Each row shows the job# in indigo monospace + a trade pill + the customer name + the truncated site address. **Pick a job → all four fields auto-fill** (Job # · Customer · Site · Trade). The search input is replaced by a **green linked-job pill** (`CheckCircle2` icon + job# + customer + site truncated to one line + an `Unlink` action on the right edge). The four fields below stay **editable post-pick** so the operator can adjust customer copy or site notes without breaking the link. **Search semantics:** case-insensitive substring match across the concatenated `jobNumber + customer + site + trade` haystack — typing *"equinox"* finds J-1862 (customer match), *"hudson yards"* finds it (site match), *"J-1862"* finds it (job# match), *"security"* finds every security-trade job. Up to 6 matches render; longer lists are truncated. **No-match handling:** if the query has no hits, the dropdown shows *"No matching jobs. Fill in the fields below to record a custom job link."* — the four fields below stay available so the operator can record a job# that isn't yet in the system (e.g. a phone-confirmed job that hasn't been entered yet). This preserves the prior manual-entry path while making the existing-job path one click. **Unlink behavior:** clicking Unlink clears the linked-job pill AND clears the four auto-filled fields below back to empty — *"this PO isn't tied to a job anymore"* is honest, no leftover ghost data. The operator can re-search or type from scratch. **Outside-click + Escape:** the dropdown closes on any mousedown outside the search box (`mousedown` listener on `document` scoped via `jobBoxRef`) and inherits Modal's Escape-to-close. **State:** new `jobSearch: string`, `linkedJobId: string | null`, `jobDropdownOpen: boolean` slots on the dialog; new `jobs: Job[]` prop sourced from `data/jobs.ts` via `PurchaseOrdersPage`. The dialog also takes a `pickJob(job)` handler that sets `linkedJobId` + cascades job# / customer / site / trade into the existing field state, and an `unlinkJob()` that resets all five. **Why one input instead of four:** the four-input pattern asks the operator to know information they may not have memorized — they remember the customer but not the job#, or the site but not which jobNumber it maps to. The typeahead lets them search by whatever they remember, and the system finds the rest. For one-off POs that aren't tied to a job, the manual-entry path stays available below the search — so the change is net-additive, not a removal. **Files:** `dashboard/src/components/NewPODialog.tsx` (new state + `useEffect` outside-click listener + `jobMatches` memo + `pickJob`/`unlinkJob` handlers + JSX swap of the legacy field layout for the linked-job-pill OR search-input branch); `dashboard/src/components/PurchaseOrdersPage.tsx` (new `jobs as seedJobs` import from `data/jobs.ts`, new `jobs={seedJobs}` prop on `<NewPODialog>`). Build verify: `npx tsc --noEmit` clean, `vite build` clean (1803 modules, 634ms, no errors). Owner instruction: *"On the job link, I want the job or the customer or the site to auto-generate the actual job linked to it. If it is the job existing in the system, you can find it and add the information automatically."*
- **Create PO — NewPODialog shipped end-to-end** (rev 2026-05-28): the *"+ Create PO"* button in the top-right of the Purchase Orders page (§7.X) was a scaffold that fired a placeholder `alert("[scaffold] NewPODialog ships in the next rev (PRD §7.X.4).")` — clicking it produced no usable behavior. This rev closes the loop with a real **`NewPODialog`** component that drafts a PO in one form, saves it as `status: "draft"` so the new row lands on the **Pre-PO tab**, and bumps the user to that tab so the just-created row is visible immediately. **Field set (standard set per owner decision):** (a) **Vendor** (required) — dropdown sourced from the inventory `vendors` table (`status: "active"` only), sorted alphabetically, with a `Truck` icon glyph inside the input; (b) **Expected Delivery** (optional) — native `<input type="date">`; (c) **Job Link** fieldset (all optional) — Job # · Customer · Trade dropdown (`locksmith` · `door` · `security` · `hvac` · `plumbing` · `multi`) · Site / Notes free-text; (d) **Line Items** (required, ≥1) — a mini-table where each row picks an `Item` from a dropdown and sets a quantity. The item dropdown is **vendor-aware**: when a vendor is picked the items belonging to that vendor's catalog sort to the top of the list with cross-vendor items still selectable below (sorted in two groups via the `am - bm` comparator). Picking the item auto-fills `itemSku` + `itemName` + `uom` on the resulting `POLine` so the downstream PO model stays consistent with the existing seed data shape. Lines have an Add line button + per-row 🗑 remove (last remaining line is non-removable so the operator can't end up with an empty PO). **Save semantics:** clicking **Save Draft PO** validates vendor + every line item picked + every qty > 0, generates the next sequential PO number by scanning `existingPOs` for the largest `PO-#####` pattern and incrementing (`nextPONumber()` helper, floor of 2300 so a fresh seed always produces ≥ PO-2301), stamps `orderedAt: new Date().toISOString()`, sets every line's `qtyReceived: 0`, and calls `onCreate(po)`. The page's `handleCreatePO` prepends to `allPOs` (via the existing `setAllPOs` hoisted-state setter from rev 2026-05-28), switches the active tab to `pre-po`, and fires an emerald confirmation toast (*"&lt;PO#&gt; saved as draft"*) using the same `setReceiveToast` channel that the receive-event flow uses. **Validation surface:** inline rose banner at the top of the dialog body for missing vendor, missing line items, missing item pick on any row, or non-positive qty. Errors clear on next valid edit. **Status flow continuation:** drafts live on Pre-PO until the operator promotes them — clicking a draft row in Pre-PO opens the existing `PODetailDialog` (§7.X.3) where *"Send to vendor"* flips status to `sent` and the row migrates to the Open tab. The dialog deliberately stops at draft creation; promote / send / receive are owned by other dialogs that already exist. **What's deliberately out of scope (defers to follow-up revs):** per-line unit-cost capture (the existing `poTotal` helper still estimates at $50/unit until PODetailDialog gains the price-book join — same constraint flagged on the seed POs); attachments / quote PDFs (covered by RFQ flow, not draft PO creation); shipping address override (defaults to the vendor's `pickupAddress` via existing PO-preview rendering — exposing the override in this dialog is a small follow-up if needed). **Files:** new `dashboard/src/components/NewPODialog.tsx` (~330 LOC — full dialog, line-item table, validation, PO-number generator); `dashboard/src/components/PurchaseOrdersPage.tsx` (`NewPODialog` import + `vendors`/`items` re-imports from `data/inventory`, `newPOOpen` state, `handleCreatePO` function that prepends to `allPOs` + jumps to Pre-PO + toasts, replaces the alert() with `setNewPOOpen(true)`, renders `<NewPODialog>` alongside the existing PODetailDialog / POPreviewDialog / POEmailDialog / PrePODetailDialog stack). Build verify: `npx tsc --noEmit` clean, `vite build` succeeds (1803 modules, 595ms, no errors). Rationale: the existing PO scaffold could only display seeded POs — operators had no way to draft a new order from the UI, which made the Pre-PO + Open + History triage tabs read-only in practice. Drafting a PO is the head of the PO lifecycle; without it the page is incomplete. Owner instruction: *"When I press 'Create a new PO', it doesn't let me. Can you fix that as well?"*
- **Categories tab — full CRUD with banner-style hero photos + trade tagging** (rev 2026-05-28): the Price Book → Categories tab (§6.A.2) was a **read-only mirror** of the Inventory page's category list — a 2-column list of compact icon-row cards with a callout banner saying *"Categories are managed from the Inventory page's Showing row — that's the single source of truth."* Catalog managers working inside the Price Book had to bounce back to Inventory to add a new category or rename one, breaking the workflow. This rev closes that loop. The Categories tab is now a **first-class management surface** — same banner-style card grid as Groups, with **+ Add Category** in the header, hover-revealed **Edit / Delete** affordances over the banner, and a full photo-upload flow inside `AddCategoryDialog`. **Data model:** `Category` type gains `photoUrl?: string` (parallels `Brand.logoUrl` and `ItemGroup.photoUrl` shipped earlier the same rev) — production maps to a signed object-storage URL, prototype inlines a `data:` URI via `FileReader.readAsDataURL`. No seed photos for the existing 14 categories — operators upload per-category on demand, matching the Group-photos scope decision. **AddCategoryDialog rewrite:** previously rendered just Name + Description fields. Now leads with the **banner-style upload tile** (full-form-width, 2:1 aspect, same dashed-border idle / solid-on-hover affordance as AddGroupDialog), followed by Category Name (required), a new **Trade dropdown** (optional — `Locksmith · Door · Security · HVAC · Plumbing`, surfacing the long-existing-but-never-editable `Category.trade` field), and Description. Photo picker accepts PNG / JPG / SVG / WebP ≤ 512 KB with the same inline-error MIME / size validation as the Brand / Group uploads; "🗑 Remove" link clears the photo. Edit mode pre-fills all four fields including the photo preview; create mode opens blank. **PriceBookPage CategoriesTab rewrite:** the read-only static-mirror component was replaced with an interactive card grid mirroring `GroupsTab` — 2:1 hero banner on top (`<img>` when `photoUrl` is set, slate-gradient + centered `List` icon fallback otherwise), name + trade chip (color-toned per trade — amber locksmith, sky door, violet security, emerald HVAC, cyan plumbing) + description + item count below. Edit (pencil) and Delete (trash) buttons float top-right over the banner as backdrop-blurred white pills, visible on hover only — same pattern as Groups. The misleading *"managed from Inventory page"* callout was removed (replaced by a one-line count + axis description). **CRUD wiring on `PriceBookPage`:** the previously-imported-but-stale `seedCategories` reference inside the Categories tab now reads from the already-lifted `allCategories` state (closing a latent bug where adding a category via the row-click AddItemDialog updated `allCategories` but the tab kept showing the old static seed). Three new handlers: **create** prepends to `allCategories`; **update** maps over `allCategories` and — if the name changed — propagates the rename to every `item.category` matching the old name so nothing shows as uncategorized (same pattern as the rename cascade on `InventoryPage` line 1231); **delete** guards on `itemsByCategoryName.get(c.name) > 0` and refuses with *"Can't delete \"X\" — N item(s) still in this category. Re-categorize them first."* before falling through to the standard confirm-prompt. **Bonus fix:** the **Items tab's Category filter dropdown** now also reads from `allCategories` instead of `seedCategories`, so newly-added categories show up in that filter dropdown immediately (was rendering off the static import). **Why this matters:** with Brands and Groups already supporting full CRUD + photo upload from the Price Book, leaving Categories as a read-only mirror was inconsistent — operators reasonably expected the same affordances across all three taxonomy tabs. The owner's framing: *"In the price book category, the categories to be editable. Also, if I want to add new ones, I want to have the option to add new ones as well from there. Again, for the categories, I want to have the option to add a picture for the categories as well, of the type, so they can be visual."* **Scope (this rev):** edits to categories on the Price Book Categories tab are page-local state (same prototype-state pattern as the Brand and Group CRUD already shipped) — true cross-page sync between InventoryPage's category list and PriceBookPage's is a larger change deferred to a follow-up. **Production swap-out:** real category-photo uploads go to object storage with a signed URL returned in `category.photo_url`; the data URI is a v1.1-only convenience. Verified end-to-end on localhost: navigated Price Book → Categories, clicked Edit on Cylinders, uploaded an SVG via the hidden file input, saved, confirmed the Cylinders card's banner now renders the uploaded `data:image/svg+xml;base64,…` photo and other cards keep their `List`-icon fallback. Files: `dashboard/src/data/inventory.ts` (`Category` type gains `photoUrl?: string`), `dashboard/src/components/AddCategoryDialog.tsx` (banner upload tile + file picker + Remove + MIME / size validation + Trade dropdown — full rewrite of the previous Name/Description-only form), `dashboard/src/components/PriceBookPage.tsx` (interactive `CategoriesTab` replaces the read-only mirror, `AddCategoryDialog` mount with `onCreate` / `onUpdate` handlers + rename-cascade through `items`, new `itemsByCategoryName` count map, Items tab category dropdown re-wired to live state). PRD updates: §6.2 DDL gains `photo_url text NULL` + a note that AddCategoryDialog is a co-equal management surface on both Inventory and Price Book; §6.A.2 tabs table row for Categories flipped from *"mirror of the Inventory Category list"* to *"full CRUD with banner-style hero photos"*; §6.A.8 acceptance criteria flip the "mirrors Inventory" bullet and add three new rev-2026-05-28 bullets (add/edit/photo, rename cascade, delete guard); §6.A.10 implementation status gets a rev-2026-05-28 entry; Appendix A.2 `category` DDL mirrors the new column.
- **Group hero photos — upload + render end-to-end on Groups tab** (rev 2026-05-28): the Item Group entity (§6.11) gains a new optional `photo_url` column for a **hero shot of the product family** — uploaded once per group so techs + customers recognize an "Electric Strikes" or "ND-Series" card at a glance before any individual item photo is set. **AddGroupDialog** gains a **banner-style upload area** (full-form-width, 2:1 aspect, ≈ 192×96) at the top of the form above the Parent Brand picker. Same upload mechanics as the brand-logo work that shipped the same rev: file picker accepts `image/png` · `image/jpeg` · `image/svg+xml` · `image/webp`, ≤ 512 KB; `FileReader.readAsDataURL` → data URI on the record; "🗑 Remove" link clears; inline validation rejects wrong MIME / oversize files. **PriceBookPage Groups tab** card was restructured to **lead with a hero banner** (5:2 aspect, full card width, rounded top corners) — `<img>` when `photo_url` is set, otherwise a slate-gradient + centered `Layers` icon fallback so empty cards still look intentional. The card's Edit / Delete affordances now float over the banner top-right as backdrop-blurred white pills (visible on hover only) instead of inline next to the name, keeping the photo's visual weight uncluttered. **Scope (this rev):** no seed photos shipped for the 16 existing groups — operators upload during demo / onboarding (per the owner's design choice — keeps the prototype lightweight and the populated-state authentic vs. fake-looking placeholder thumbnails). **Production swap-out:** real uploads go to object storage with a signed URL returned in `item_group.photo_url`; the inline data URI is a v1.1-only convenience. Files: `dashboard/src/data/inventory.ts` (`ItemGroup` type extension), `dashboard/src/components/AddGroupDialog.tsx` (banner upload tile + file-picker + Remove + validation), `dashboard/src/components/PriceBookPage.tsx` (Groups tab card restructured around the new banner). PRD updates: §6.11 DDL gains `photo_url text NULL`; §6.11 AddGroupDialog UX spec spells out the upload mechanics; §6.11 acceptance criteria gain three rev-2026-05-28 bullets (upload→render, hover Edit/Delete float-over-banner, validation rejects bad files); §6.A.10 implementation status gains a rev-2026-05-28 shipped bullet; Appendix A.4 `item_group` DDL mirrors the new column. Forward note: when **item-level photo upload** ships in Phase B alongside the Catalog tab, the group's `photo_url` becomes the **fallback hero** for any item in that group that doesn't have its own photo yet — single per-group photo covers a dozen un-photographed items so the customer-facing Catalog never has empty cards.
- **Brand logos — upload + render end-to-end on Brands tab** (rev 2026-05-28): the rev-2026-05-27 Phase A spec declared `Brand.logo_url` on the schema but the upload UI and the Brands-tab render were both stubbed. This rev closes the loop. **AddBrandDialog** gains a 64×64 logo tile at the top-left of the form (sibling of the Brand Name input) — clicking it opens a native file picker accepting `image/png` · `image/jpeg` · `image/svg+xml` · `image/webp`, ≤ 512 KB. On pick the file is read via `FileReader.readAsDataURL` and the resulting data URI is stored on the brand record; a small "🗑 Remove" link clears it. Helper copy below the Name field: *"PNG / JPG / SVG / WebP · square works best · ≤ 512 KB"*. Validation surfaces inline error messages for wrong MIME or oversize files (no silent failures). **PriceBookPage Brands tab** card header is restructured: the prior tiny `Tag` icon next to the brand name is replaced by a prominent **56×56 logo tile** at the top-left of the card, with the name + description flowing to its right. When `logo_url` is null the tile falls back to a 2-letter colored-monogram avatar (indigo-100 bg + indigo-700 text + indigo-200 ring) so cards without logos still look intentional. **Seed:** all 6 brands ship with pre-rendered monogram-badge SVG logos encoded inline as `data:image/svg+xml` strings via a new `brandLogoSvg(monogram, accent, accent2)` helper in `data/inventory.ts` — Mul-T-Lock (MTL, red→amber), Medeco (MED, maroon), ASSA Abloy (AA, blue), Schlage (SCH, slate), Kaba (KB, teal), Honeywell (HON, red) — so the demo populates cleanly with zero CDN dependency. **Production swap-out:** real customer uploads go to object storage (S3 / GCS) with a signed URL returned in `brand.logo_url`; the inline data URI seeded for the prototype is a v1.1-only convenience. **Scope (this rev):** logos render on the internal Brands tab cards only. Customer-facing surfaces (Catalog tab cards · estimates / invoices line-items · AddItemDialog brand picker) stay out of scope and ship with the rest of the Catalog rendering in Phase B. Files: `dashboard/src/data/inventory.ts` (new `brandLogoSvg` helper + 6 brands seeded with `logoUrl`), `dashboard/src/components/AddBrandDialog.tsx` (logo tile + file picker + Remove + MIME / size validation), `dashboard/src/components/PriceBookPage.tsx` (Brands tab card header restructured to lead with the 56×56 logo tile + monogram-avatar fallback). PRD updates: §6.10 UX spec for AddBrandDialog spells out the logo upload mechanics, §6.10 acceptance criteria gain three rev-2026-05-28 bullets, §6.A.10 implementation status gains a rev-2026-05-28 shipped bullet.
- **Price Book Items tab — KPI tiles are clickable filter triggers, single-active across all four** (rev 2026-05-28): the four KPI tiles at the top of the Items tab (`In Catalog` · `Hidden from Catalog` · `With Photo` · `No Price Set`) are now real button-tiles using the same locked-filter pattern as Staging (§7.4.A.2), Items KPI on Inventory (§5.4.A), and Vendors (§7.6.A) — click jumps the items table to the matching slice, click again clears. **At most one tile is active at any moment** — the four tiles are mutually exclusive across **all** dimensions, not just within visibility. Clicking any tile that isn't already active sets that tile's filter AND clears the other three. Clicking the active tile clears it back to *"no tile filter"*. This is a single-radio-style affordance — the operator sees one slice at a time and never has to reason about overlapping filters. **Underlying state** in `PriceBookPage.tsx` keeps three pieces (`filterVisibility: "all" | "catalog" | "internal_only"`, `filterPhoto: "all" | "with"`, `filterPrice: "all" | "missing"`) so the filter row's existing `All visibility` dropdown stays compatible. Mutual exclusion is enforced in two places: (a) each tile's `onClick` sets its target value and resets the other two state slots to `"all"`; (b) the visibility dropdown's `setFilterVisibility` is wrapped so picking any non-`all` value also clears `filterPhoto` + `filterPrice`. The invariant — *at most one of the three state slots is non-`"all"` at any moment* — holds across **both** entry paths (tile click AND dropdown pick). `filterPhoto` and `filterPrice` are KPI-tile-only dimensions (no dropdown counterpart) — the dropdown row stays Brand / Group / Category / Visibility, because *"has a photo?"* and *"is the price set?"* are sparse single-signal questions that don't need their own multi-value dropdowns. Active state on the lit tile: indigo `ring-2 ring-indigo-500` outline + a tiny white-on-indigo **`FILTERED`** pill rendered to the right of the label inside the tile. Inactive tiles: regular tinted background, no ring, no pill. Each tile is a `<button>` carrying `aria-pressed`, an `aria-label` describing the filter target (e.g. *"Show only items currently in the customer-facing catalog"*), and a matching `title` tooltip so the affordance is discoverable on hover. KPI numbers themselves remain **global** (computed from the full `items` list, not from `filteredItems`) so the counts stay stable as the active tile rotates. The existing *"No items match the active filters."* empty-state row renders when the active tile narrows the table to zero rows. **Why single-active instead of stackable orthogonal dimensions:** the first cut of this rev (earlier on 2026-05-28) made `With Photo` + `No Price Set` independent orthogonal filters that could stack with `In Catalog` / `Hidden from Catalog`. Owner feedback the same day: *"I don't want to have the option to press two tabs at the same time. I want each tab individually, so when I press the other one, it goes to the other one."* The tile row reads as a one-of-N radio in practice — operators expect picking one to release the others, same as flipping through tabs. Stackable filters can return as a follow-up if a real use-case surfaces; for now single-active is the locked behavior. **Files:** `dashboard/src/components/PriceBookPage.tsx` (state additions + four toggle handlers that clear-the-others + wrapped `setFilterVisibility` + KPITile refactor to button + `active` + `onClick` + `ariaLabel`). See spec §6.A.2.a + acceptance criteria added to §6.A.8 + status note appended to §6.A.10.
- **NewApprovalRequestDialog — role-aware Requested By / From Location / To Location scoping** (rev 2026-05-27): the dialog now scopes every user-pickable field by the **logged-in user's role** instead of letting any user pick any tech or any location. Three tiers: (a) **Field techs** (`field_technician`, `subcontractor_tech`) — Requested By auto-locked to themselves (rendered + disabled), From Location auto-locked to their assigned van, and when action_type = `transfer_to_van` the To Location is also auto-locked to that same van. Helper text under each locked field reads *"🔒 Locked to your assigned van"*. The lock is **role-only — there is no override permission**, no admin grant that flips it off, so a field tech can never pull stock from another tech's van and never request a transfer into another tech's van regardless of seniority. This is a deliberate guardrail against tech-to-tech stock laundering (a tech pulling from a coworker's van to cover a count they're short on, hiding shrinkage). (b) **Branch-scoped back-office** (`warehouse_manager`, `dispatcher`, `office_admin`) — From and To dropdowns render every location org-wide, but **locations outside the user's branch render as `<option disabled>`** with a muted style + 🔒 icon (visible-but-not-pickable, so the user has spatial awareness that other branches exist). Requested By is filtered to techs at the user's branch with a *"Showing techs at &lt;Branch Name&gt; (N)"* helper line. (c) **Global roles** (`owner`, `admin`, `inventory_admin`, `purchaser`) — no scoping; the dialog renders exactly as today with every location + every tech selectable. Scoping is driven by three pure helpers added to `data/current-user.ts` (§11.7) — `getRequesterOptions(user)`, `getFromLocationOptions(user)`, `getToLocationOptions(user, actionType)` — each returning `{ selectable, readonly }` so the dialog renders disabled options uniformly. The Phase-2 RBAC migration swaps the static role checks for a `useCurrentUser()` hook in exactly one place. Edge case: a field tech with no `assigned_vehicle_id` (onboarding before vehicle assignment) sees a rose banner *"Your account isn't assigned to a vehicle yet — ask dispatch to set this up before requesting stock-out"* with both Submit buttons disabled. Scope of this rev is limited to `NewApprovalRequestDialog`; `RestockDialog` and `TransferDialog` keep their current behavior — forward note in §11.7 says apply the same helpers when those dialogs are next touched (§5.4.A.v.4b, §11.7).
- **Price Book Items tab — rows are now click-to-edit** (rev 2026-05-27): every row in the Price Book → Items tab is now a click target that opens the existing `AddItemDialog` in **edit mode** pre-filled with that item's full record (SKU · brand · group · category · vendor · photo · unit / sell price + live GM% · serialized + hazmat · visibility). Catalog managers can update prices, swap vendors, toggle visibility, or fix customer-facing copy without leaving the Price Book page — no navigation back to Inventory required. The visibility chip in the last column keeps its single-click toggle (now wraps `e.stopPropagation()` so a chip click doesn't *also* open the edit dialog). Keyboard: rows are `tabIndex={0}` with `Enter` opening the dialog and an indigo focus ring for affordance. New `editingItem` state in `PriceBookPage`; new `allVendors` + `allCategories` local state seeded from inventory.ts so inline "+ Add new vendor" / "+ Add new category" actions inside the edit dialog work for the session (same pattern as `InventoryPage`). Save handler patches the row in `items[]` in place (copies every editable field + bumps `updatedAt`). No changes to `AddItemDialog.tsx` itself — edit mode was already wired from the Inventory side; the dialog just gets a second host page (§6.A.2 Items tab + new §6.A.2.b Row click opens Edit dialog).
- **AddVendorDialog — PO Transmit Method is now multi-select** (rev 2026-05-27): the *"PO Transmit Method"* pill picker on the Add New Vendor dialog was single-select (radio); it now supports **multi-select**, so operators can tick every channel a vendor actually accepts (Email + Vendor Portal + EDI + Phone / Will-Call in any combination — real vendors commonly take EDI for normal orders, Phone for emergency will-call, and Email for backup all at once). Active pills get an indigo ring + a tiny ✓ check icon; helper copy under the label reads *"Pick every channel this vendor accepts — you can use any of them when sending a PO. The first one you check is the default."* When ≥2 channels are selected an indigo helper line appears below the pills: *"N channels selected · default: &lt;first&gt;"*. Last-pill guard prevents un-checking the only remaining method (`disabled` + tooltip *"At least one transmit method must stay selected"*) so the vendor can never end up with an empty set. **Data model:** new `Vendor.transmitMethods?: TransmitMethod[]` field stores the full set; the existing `Vendor.transmitMethod` (singular) is preserved as the **primary / default** channel and is always equal to `transmitMethods[0]`, so every reader that expects a single string — VendorCard chip, VendorDetailDialog display + edit-mode picker, AddItemDialog vendor preview strip, EstimateComparisonDialog quote line, POEmailDialog recipient derivation — keeps working without changes. New `TransmitMethod` type alias exported from `data/inventory.ts` as the shared source of truth. Legacy vendors without `transmitMethods` are treated as `[transmitMethod]`. (§7.6 Vendor Management — new PO Transmit Method multi-select bullet).
- **Address autocomplete on every address field (Google Places API)** `[SPEC-ONLY v1.1 rev 2026-05-27]`: every place the app asks the user to type a street address is now spec'd as a typeahead **`<AddressAutocompleteInput>`** component backed by **Google Places API (Place Autocomplete + Place Details)**. As the user types — anywhere from a partial street name to a ZIP — a dropdown surfaces ranked suggestions; picking one auto-fills the full structured address (street + unit + city + state + ZIP + country + lat/lng + Google `place_id`) and writes both the legacy single-string `address text` column AND a new `address_components jsonb` companion column so existing PO / ticket / staging rendering keeps working unchanged. **Coverage:** **AddVendorDialog → `vendor.pickup_address`** (§7.6 — the "PICKUP / SHIP-FROM ADDRESS" field with placeholder *"Will-call counter address — surfaced on pickup tickets"*), **AddBranchDialog → `branch.address`** (§5.4.A.iii), **CreateStageDialog → Vendor Pickup Location override → `job_stage.pickup_address`** (§7.4.A.4 — inline-editable info card that defaults from the picked vendor's pickup_address), and **any future address field** by reusing the same component. The **PO Ship-To block in `POPreviewDialog`** (§7.2) automatically benefits — it renders from `purchase_order.ship_to_location_id`'s `branch.address_components` once those are populated, no separate input needed. **Provider tuning** per the prototype: `componentRestrictions: { country: 'us' }` (US-only for v1.1; international is `[DEFERRED]` to Phase 2); `locationBias` set to the user's branch lat/lng (radius 80 km) so a Brooklyn dispatcher typing *"123 Main"* gets NYC-area matches ranked above identically-named addresses in other states; `fields: ['address_components', 'geometry', 'formatted_address', 'place_id']` (only what the form needs — keeps Place Details billed at the **Basic** tier, ~$5/1k); session tokens passed end-to-end so a full type-then-select counts as **one** ~$0.017 session instead of N autocomplete-keystroke charges. **Manual-entry fallback**: if the API returns no suggestions or the JS bundle fails to load, the input degrades to a plain `<input type="text">` so onboarding never blocks (helper text below the input switches to *"⚠ Autocomplete unavailable — enter address manually"*). Tech-stack row added in §11.1; full component contract + data shape + key-management notes in new §11.1.A. **Implementation status**: spec-only for now — the prototype keeps the existing plain text inputs; the autocomplete is wired in when the team is ready to enable Google billing + key restrictions. PRD describes the target state so downstream specs (PO layout, ticket layout, address-parsing helpers, search-by-state filters) can be written against it.
- **Sidebar IA — Inventory parent group gains an explicit "Inventory" first child + Price Book becomes its own page** (rev 2026-05-27): the left-nav Inventory group used to have three children (Price Book · Purchase Orders · Vendors) with the prototype's parent click landing on the "Price Book" item — which was actually the multi-tab inventory dashboard (Items + Staging + Approvals). That conflation is now fixed by adding a **new explicit `Inventory` sub-item as the first child** of the Inventory parent. The four children render in this exact order: **(1) Inventory → (2) Price Book → (3) Purchase Orders → (4) Vendors**. The new Inventory sub-item routes to the existing `InventoryPage` component (Items / Staging / Approvals tabs — every spec to date under §5.4.A, §5.4.A.i–vii, §7.4.A). The **Price Book** sub-item now routes to a brand-new `PriceBookPage` placeholder (§6.A — coming-soon shell that points at the existing §6 Price Book Module functional spec for eventual scope). **Click behavior** matches the established VendorsPage pattern from rev 2026-05-27 (§7.6.A): clicking the parent **label** auto-routes to the first child (`Inventory`); clicking the **chevron** toggles expand/collapse of the children list without routing; the parent Inventory row stays visually active when the current route is any of the four children so the breadcrumb stays coherent. **Icon for the new Inventory sub-item**: stacked-boxes icon (Lucide `Boxes` recommended) — distinguishes it from the existing Tag (Price Book), Cart (Purchase Orders), Truck (Vendors). **Routing diff** vs prior spec: `Route` union adds `"inventory"` and `"price-book"` literals; `Sidebar`'s `currentRoute` / `onNavigate` plumbing (already added in rev 2026-05-27 §7.6.A) handles both new routes uniformly; default app-load route = `"inventory"` (Items tab default inside the page). Updates §5.4.A line 346 (now lists four children in order), §7.6.A line 1628 (removes "Price Book" from the decorative-placeholders list — both Inventory and Price Book are now real routes), adds new §5.4.A.viii (Sidebar IA full spec + acceptance criteria), adds new §6.A (Price Book page placeholder). Owner-noted next step: the Price Book page UX itself ships in a follow-up rev — owner will design after this session.
- **Price Book — Phase A spec + Brand + Item Group entities + per-item Visibility flag** (rev 2026-05-27): the rev-2026-05-27 placeholder for the Price Book page (§6.A) is replaced with the full **Phase A** spec — the data spine for the customer-facing Price Book experience. **Three-level taxonomy** lands: existing **Category** stays as the cross-brand part-type axis; new **Brand** (manufacturer — Mul-T-Lock, Medeco, ASSA Abloy, Schlage, Kaba, Honeywell — first-class entity with logo, website, default markup %, default vendor) and new **Item Group** (product family within a brand — C-Series, Maxum, Primus, etc.) round out the model. Every `item` row picks up nullable `brand_id` + `group_id` FKs (group must match brand when both set), plus new **`visibility item_visibility_enum`** column (`'catalog'` | `'internal_only'`) defaulting from `item.type` (material/service/bundle → catalog · labor/fee/discount → internal_only), plus customer-facing copy fields (`customer_name`, `customer_description`, `key_features jsonb`), plus a `photos jsonb` field (same StageAttachment shape from §7.4.A.10, restricted to `kind:'image'` in v1) and a `list_price numeric(19,4)` override field. **PriceBookPage** rewrites from placeholder to a real tabbed page: **Items · Brands · Groups · Categories · Catalog** (the Catalog tab renders a Phase-B placeholder strip so the URL + ordering lock in early). **Inventory side** picks up the new taxonomy with minimal additive changes: new **Brand** + **Group** filter pills on the Showing row (parallel to the existing Location + Category pills from rev 2026-05-27 — Group dropdown scopes to selected Brand when active), a **Visibility chip column** on the items table (`🌐 Catalog` indigo vs `🔒 Internal` slate; click to toggle, admin-gated), and **AddItemDialog** gains Brand + Group + Visibility fields plus a collapsible *"Customer-facing copy"* section so the new fields are captured in v1. **Phase B** (next rev) layers the Catalog tab rendering + photo upload UX + customer-copy editing surface; **Phase C** layers Customer-Present Mode + PDF export + shareable customer link + estimate/invoice catalog-display-mode integration. Phasing is additive — Phase A tabs and fields stay locked when B and C land. New PRD sections: §6.A (Phase A page spec + acceptance criteria), §6.A.10 (Implementation status — what shipped vs deferred), §6.10 (Brand entity), §6.11 (Item Group entity); seed data adds 6 brands × ~2-3 groups each (16 groups total) so the populated state demos cleanly out of the box. Schema additions land in Appendix A.4 (Price Book) and Appendix A.2 (item table). Shipped end-to-end on localhost: PriceBookPage rewritten from placeholder to a real 5-tab page · AddBrandDialog + AddGroupDialog · AddItemDialog gains Brand/Group/Visibility fields · 6 of 15 seeded items backfilled with brand+group · `itm_014` Locksmith Labor flipped to `visibility: 'internal_only'` to demo smart defaults. Deferred to a follow-up (still in §6.A.7 spec, not yet built): Brand + Group filter pills on Inventory Showing row · Visibility chip column on Inventory items table · customer-facing copy editing UX (Phase B) · BrandDetailDialog / GroupDetailDialog rich detail views.
- **Inventory Category selector — inline Edit + Delete per row, admin-gated** (rev 2026-05-27): each category row in the Showing-row Category dropdown now carries hover-revealed ✏ **Edit** + 🗑 **Delete** icon buttons on the right edge, gated by `canManageLocations(currentUser.role)` (same admin check as Locations). Edit opens `AddCategoryDialog` in edit mode (new `editCategory` + `onUpdate` props) pre-filled with the current name + description; saving a rename propagates the new name to every `Item` carrying the old name so the items table doesn't show stale "Uncategorized" rows, and if the active filter was pointed at the renamed category the filter follows the rename. Delete is **blocked when any items still use the category** — a *"⚠ &lt;Name&gt; can't be deleted — N items still in this category"* toast fires (deliberate guardrail; the operator is asked to re-categorize first). When zero items use the category, a confirm prompt fires, the category is removed from `allCategories`, and if it was the active filter the dropdown resets to All. In the same pass the **per-row item-count badges were removed** from each category row — the operator clicks the row to see the items anyway and the static numbers were noise on a frequently-scanned list; totals stay visible on the trigger pill + the sticky All-Categories reset row. Non-admin view (`canManage = false`) renders the dropdown without any Edit/Delete affordance — view-only filtering for techs. New `editCategory` / `onUpdate` props on `AddCategoryDialog`, new `canManage` / `onEditCategory` / `onDeleteCategory` props on `CategorySelector`, new `editingCategory` state in `InventoryPage` driving the dialog (§5.4.A Category selector — inline Edit + Delete bullet).
- **Inventory "Showing" row — new Category selector pill next to Locations** (rev 2026-05-27): the Showing row on the Inventory page gains a second pill, **"All Categories"**, sitting immediately to the right of the existing Locations pill. Same visual language — folder-tree icon, label + small *"N categories configured"* subtitle, live count of matching items, chevron — clicking pops a dropdown with (a) a sticky **All Categories** reset row, (b) a scrollable list of every configured `Category` showing name + 9px description + per-category item count (indigo highlight + ✓ check on the active row), and (c) a pinned indigo **"+ Add new category"** footer that opens the existing `AddCategoryDialog` and, on save, appends the new category to `allCategories` AND auto-selects it as the active filter so the items table narrows immediately. Filter state is wired through the existing `Filters` shape — new `filters.categories: string[]` field added to `FiltersPopover.tsx` + included in `activeFilterCount()` — so picks made via the pill stay in sync with the right-side Filters popover and surface in the Active-Filter chip strip. A unified **"Clear filter"** link appears next to both pills whenever Location or Category is non-default and resets both in one click. Rationale: counter staff frequently want to scope the items list to *"just cylinders"* or *"just access-control"* — pre-rev they had to open the Filters popover, scroll to Categories, click; post-rev it's one always-visible click alongside Location, with inline category creation when the taxonomy doesn't already cover what they need. New file: `src/components/CategorySelector.tsx` (§5.4.A Location selector bullet + acceptance criteria).
- **Vendors page — Category filter dropdown adds inline create + rename** (rev 2026-05-27): the filter-row category picker on `VendorsPage` (§7.6.A) was a native `<select>` listing distinct categories. It's now a popover-style picker (`<CategoryManagerDropdown>`, new component in `dashboard/src/components/`) that doubles as a lightweight management surface for the org's category vocabulary. Open state: `All categories` row at the top (clears the filter), scrollable list of every category with a hover-revealed ✏️ pencil per row that swaps the row into an inline rename input, and a pinned `+ Add new category` button at the bottom that expands into an inline create input. Both inputs support `Enter` to commit / `Esc` to cancel and reject empty / collision values with a rose footer error. **Rename cascade:** `VendorsPage.handleRenameCategory(old, new)` rewrites every `vendor.category === old` to `new` in one state update; if the active filter was pointing at `old` it follows the rename so the operator doesn't lose their place. **Add semantics:** new categories live in a separate `extraCategories: string[]` state on `VendorsPage` (so a category can exist before any vendor is attached to it) — the visible list is the union of `vendors[*].category` + `extraCategories`. Toasts: `🏷 Category "<name>" added`, `✏️ Category renamed: "<old>" → "<new>"`. The slate footer inside the panel reads *"Renaming a category updates every vendor that uses it. New categories become available everywhere in the app."* so the operator knows the cascade is happening. Production schema: persist to a `vendor_category (id, organization_id, name, archived_at)` lookup table — see §7.6.A *"Category dropdown — inline add + rename"*. **Rationale:** category vocabulary curation already happens in two places — the Add/Edit Vendor dialogs (`<VendorCategoryPicker>`, scoped to one vendor) and now the filter dropdown (scoped to the whole list). Doing the management *while you're looking at the filter* is the natural place for bulk-y curation, so we don't need a separate Settings → Categories page in v1.
- **Vendors page — KPI tiles are clickable filter triggers + Top Vendor moves into Spend Analytics** (rev 2026-05-27): two changes to the `VendorsPage` header (§7.6.A). (1) **Locked clickable-tile pattern:** every tile in the page-header KPI row is now a real button matching the locked pattern used on the Items KPI tiles (§5.4.A) and the Staging KPI tiles (§7.4.A.2) — click jumps to the matching sub-tab and (for Active Vendors) flips a row-filter so the page reflects what the tile is showing. Active state gets an indigo ring + a small `FILTERED` pill next to the label so the operator can see the link between the tile and the current view. Wiring: **Active Vendors → Directory tab + status=Active**, **Total Spend YTD → Spend Analytics tab**, **Categories → By Category tab**. Hover lifts shadow; keyboard focus shows the standard indigo focus-visible ring; tiles carry `aria-pressed` so screen-readers announce the filter state. (2) **Top Vendor tile removed from the row.** The page-header now shows three tiles instead of four; the "who do we spend the most on?" story is conveyed by the **#1 row of the Spend Leaderboard inside the Spend Analytics tab** — that row already carries a 🥇 `Award` rank icon, the vendor name, category, YTD spend, and share-of-spend bar. An intermediate amber-gradient banner pinned above the leaderboard was tried and removed the same day (rev 2026-05-27) because it duplicated information already present in the #1 row. Rationale: the *"top vendor"* conversation actually happens when the operator pulls up the leaderboard, not at-a-glance in the page header — keeping it where the spend math lives tells a cleaner story (header = "what / how many", Analytics tab = "money story, leader at top of the list"). See §7.6.A.
- **VendorDetailDialog — PO Transmit multi-select parity with AddVendorDialog** (rev 2026-05-27): the PO Transmit pill picker in the Vendor Detail dialog's edit mode was still single-select after the AddVendorDialog gained multi-select (sibling entry above); editing an existing vendor regressed the operator to one channel at a time, undoing whatever multi-channel mix had been captured at add-time. The edit-mode picker is now full multi-select parity with `AddVendorDialog` — same pill behavior (active pills get an indigo ring + a tiny ✓ check icon, helper copy *"Pick every channel this vendor accepts — first one checked is the default."*, last-pill guard with `disabled` + tooltip *"At least one transmit method must stay selected"*, indigo helper line *"N channels selected · default: &lt;first&gt;"* when ≥2 are selected), plus a small white-on-indigo **`DEFAULT`** badge on the primary chip when the set has more than one channel, so the operator can see at a glance which method will be the default without scanning the helper line. **Data flow:** `DraftFields.transmitMethod` (singular) is replaced with `DraftFields.transmitMethods: TransmitMethod[]`; `toDraft` promotes legacy single-value vendors via `vendor.transmitMethods ?? [vendor.transmitMethod]` so loading an older record into edit mode doesn't lose information; the diff function patches BOTH the array AND the back-compat singular field on save (`patch.transmitMethod = transmitMethods[0]`, `patch.transmitMethods = [...transmitMethods]`), so every reader that depends on a single string keeps working unchanged (VendorCard chip · AddItemDialog vendor preview strip · POEmailDialog recipient derivation · EstimateComparisonDialog quote line). **Read-mode rendering:** the *"PO via"* row in the Account card now joins every channel (`PORTAL · PHONE · EMAIL`) instead of showing just the primary; the dialog's pickup-card footer line *"PO transmit:"* renders the same set + a muted *"(default: portal)"* annotation when more than one is configured. **New helpers** local to `VendorDetailDialog.tsx`: `transmitMethodsEqual(a, b)` (length + order-preserving compare so promoting a channel to primary is detected as a change) and `toggleTransmitMethod(list, method)` (matches the AddVendorDialog inline toggle — last-one is a no-op, otherwise add-if-missing / remove-if-present). The shared `TransmitMethod` type alias added in the previous rev is now imported into VendorDetailDialog so the dialog and the picker speak the same vocabulary. (§7.6 PO Transmit Method bullet — *"Edit-dialog parity"* sub-paragraph; §7.6.A Account card spec — *"transmit method becomes a multi-select row of pills"*).
- **VendorDetailDialog — Recent POs row click opens PO Preview** (rev 2026-05-27): the *"Recent purchase orders"* table on the Vendor Detail dialog (last 5 POs sorted by `orderedAt` desc — see §7.6.A entry below) was a static list — an operator scrolling a vendor's order history had no way to drill into any specific PO without first closing the Vendor Detail dialog, navigating to the Purchase Orders page, and looking the PO up by number. Every row in the table is now a one-click target that opens the existing **`POPreviewDialog` (§7.2.A)** on top of the Vendor Detail, so the operator can read the full PO document (header · vendor + ship-to · job context · line items with unit cost + extended totals · signature block · `Email PO` / `Save as PDF` / `Print` toolbar) without losing their place. **Mechanics:** each `<tr>` in the table is converted to `role="button" tabIndex={0}` with an `onClick` handler that calls `setPreviewPONumber(po.poNumber)` and an `onKeyDown` handler that intercepts `Enter` / `Space` to fire the same setter (keyboard accessibility parity); the row carries a hover/focus indigo-tinted background (`hover:bg-indigo-50/60 focus:bg-indigo-50/60`), `cursor-pointer`, and a `title={"Preview <PO#>"}` so the affordance is discoverable on hover. The PO code cell switches from `text-slate-900` to `text-indigo-700` so the actionable identifier reads visually like every other tappable PO# in the app. **Nested rendering:** a new `previewPONumber: string | null` state on `VendorDetailDialog`, cleared in the same `useEffect` that resets edit state when the dialog closes (so re-opening a different vendor never carries over a stale preview number). The return JSX is wrapped in a fragment; `<POPreviewDialog>` renders after `</Modal>` with `open={!!previewPONumber}`, `poNumber={previewPONumber}` (the existing lookup path on the preview dialog resolves the PO from the `purchaseOrders` table), `zIndex={80}`, and `lockEscape` so a stray Esc closes only the preview and not the underlying Vendor Detail. This is the same nested-preview pattern already locked in for `StageDetailDialog` → `POPreviewDialog` (rev 2026-05-26 — see entry for that dialog), so the modal-stack semantics are identical (Esc / × / backdrop click each peel one layer at a time; the parent's focus + scroll position survive). (§7.2.A PO Preview is reused as-is — no changes to the preview dialog itself; §7.6.A *"Recent purchase orders"* bullet updated below).
- **TopBar bell — low-stock / backorder rows pop out an action dialog with Restock now CTA** (rev 2026-05-27 v4): the v3 routing already snapped the user to the Items tab + applied the low_stock / backorder filter + selected the matching item in the side drawer — but that still left the operator one filtered-list-scan away from the action they actually wanted: *"give me this item, with a Restock button right here."* This rev adds a small pop-out dialog (`LowStockActionDialog.tsx`, new) that mounts on top of the now-filtered Items tab the moment a `low_stock` or `backorder` alert is clicked. The dialog shows: (1) **Item card** — photo (or letter avatar fallback) + name + category · UOM · vendor + total on-hand-across-N-locations summary. (2) **Below-reorder-threshold table** (low_stock only) — one row per offending location showing `<onHand> / <min> min` in mono right-aligned, amber-tinted card so the operator can see *where exactly* the shortage is without scanning the side drawer. (3) **Vendor-overdue banner** (backorder only) — rose-tinted explainer noting that the vendor delivery is overdue and that Restock writes an immediate receipt against a manual count or alternate-source vendor without double-paying the still-open backorder PO line. (4) **Walk-away copy** — *"Walking away? Close this pop-up — the item stays filtered + selected on the Items tab so you can come back to it without re-finding it."* (5) **Footer**: secondary **Close** button (walk-away path, the existing filtered-list-with-drawer-open state remains underneath) + primary indigo **📦 Restock now** button. **Restock-now wiring:** clicking *Restock now* closes the action dialog and opens the existing `RestockDialog` (§5.4.A Restock) — which already accepts an `initialItemId` prop and reads from the same `selectedId` state we set during the alert reduce — so the dialog opens pre-filled with this item, the operator picks a location + quantity + source (vendor PO / manual receive / truck return) and submits in seconds. **Z-index stacking:** `LowStockActionDialog` renders at `zIndex={70}`, between the underlying Items tab (50) and the bell dropdown's `POPreviewDialog` (80). **State flow:** new `lowStockAction: { itemId, kind: "low_stock"|"backorder" } | null` state on `InventoryPage`, set inside the existing alert reducer alongside `setSelectedId(hit.id)` so the side drawer + the action dialog open together (drawer for browsing, dialog for acting). The `kind` lets the same dialog component handle both alert flavors with kind-specific copy + the offending-locations table only when it applies. **Why both surfaces:** the side drawer is the "what the item looks like in the catalog" view (full per-location breakdown, reserved counts, photo, vendor). The action dialog is the "what do you want to do about it" pop-out. They serve different jobs and rendering both means the operator never has to choose between context and action — they can read the drawer behind the dialog, then either restock from the dialog or close it and keep browsing in the filtered list.
- **TopBar bell — alert clicks work from ANY route** (rev 2026-05-27 v3): the v2 navigation entry below shipped the routing logic inside `InventoryPage` — which meant the bell silently no-op'd if the user clicked a row while on the **Vendors** or **Price Book** route (those pages don't mount `InventoryPage`, so the bus had no subscriber). The fix lifts the subscription up to **`App.tsx`** — always mounted — so clicking any row from any route does the right thing: App sets `route = "inventory"` (so `InventoryPage` mounts if it wasn't already) and forwards the intent down to `InventoryPage` as a `pendingAlert?: { alert: InventoryAlert; nonce: number }` prop. `InventoryPage`'s `useEffect([pendingAlert?.nonce])` then runs the same reducer that previously lived inside the bus subscription — switching to the right tab, applying the right filter, opening the right dialog. **Why a nonce**: because React reuses the `InventoryPage` instance across route switches when possible (and even when it doesn't, the prop identity has to change to re-fire the effect on a repeat click of the same alert). Stamping a fresh `Date.now()` on every emission makes the prop "new" each time, so the effect re-runs deterministically. **Files changed**: `App.tsx` (now owns the singleton `subscribeAlertIntent(…)` subscription + `pendingAlert` state + forwards it as a prop); `InventoryPage.tsx` (drops its own bus import, accepts the `pendingAlert` prop, watches `pendingAlert?.nonce` in the same reducer effect). The bus (`src/lib/alert-bus.ts`) stays unchanged — its purpose is exactly this kind of cross-tree fan-out, so lifting the subscriber doesn't compromise the architecture. **Verified live** from the Vendors route: click bell → click "PEX-A Tubing" backorder row → page snaps to Inventory + Items tab + Backorder filter (1 row) + the PEX-A item drawer open, in a single user gesture. (§5.4.A.ix updated below — the routing matrix is unchanged but the implementation note now says "App owns the subscription; InventoryPage receives `pendingAlert` as a prop.")
- **TopBar bell — per-row click navigates to the relevant page / dialog** (rev 2026-05-27): the v1 dropdown (entry below) shipped read-only — rows had a hover affordance but no click action. This rev wires every row to its target so the operator can jump from "what's hot" to the actual page in one click. **Per-kind routing**: (1) `low_stock` row → switches to the **Items** tab + applies the **Low Stock** stock-state filter (replaces any conflicting `in_stock`/`out_of_stock`/`backorder` filter, preserving any non-conflicting filters like vendor or category) + selects the matching item (right-side detail drawer slides in on the row when `ref.itemSku` resolves). (2) `backorder` row → same as low_stock but with the **Backorder** filter; item drawer opens on the matched item. (3) `pending_approval` row → switches to the **Approvals** tab + opens `ApprovalDetailDialog` by `ref.approvalId` (filter auto-flips to *Pending* so the row stays visible behind the dialog). (4) `staging_no_area` and `staging_ready` rows → switch to the **Staging** tab + open `StageDetailDialog` by `ref.stageId`. (5) `po_partial` row → opens **`POPreviewDialog`** by `ref.poNumber` directly on top of the current tab (no tab switch — the PO doc is a "pop-out page" the operator can read without losing their place). (6) Empty `ref` falls back to no-op (defense-in-depth). **Mechanics — the subscribe-after-emit race fix**: a naive pub/sub would fire the intent the moment the row is clicked, but `ApprovalsView` and `StagingView` only mount when their tab becomes active, so their subscriber would mount *after* the event was fired and miss it. Two-step solution: (a) `InventoryPage` itself holds a singleton bus subscription (it's always mounted while route === inventory) and reduces every incoming alert into local state (`view`, `filters.stockStates`, `selectedId`, `alertPreviewPONumber`, plus two intent objects); (b) for the sub-view-owned dialogs, the intent is **forwarded via props** as a `{ id, nonce }` pair where `nonce = Date.now()` changes on every click — the sub-view's `useEffect([intent.id, intent.nonce])` opens the dialog the first time it mounts AND re-opens on every subsequent click of the same id. No race, no replay buffer, no `setTimeout` hacks. **NotificationsDropdown row UX** rev: each `<li>` now carries `role="button" tabIndex={0}` with `onClick` + `onKeyDown` (Enter/Space) firing `emitAlertIntent(alert) + setOpen(false)` so clicking a row closes the dropdown and triggers the navigation in the same gesture; rows pick up a `cursor-pointer` + indigo-tinted hover/focus background + an indigo-tinted title hover-color so the affordance is discoverable; the row's `title` attribute now reads *"Open · &lt;timestamp&gt;"* (was just the timestamp). **Bus** (`src/lib/alert-bus.ts`) — small pure pub/sub (`emitAlertIntent(alert)` + `subscribeAlertIntent(fn)` returning an unsubscribe function); each subscriber's throw is caught locally so one buggy listener can't break the others. v1 has one subscriber (`InventoryPage`) — the API stays open for future surfaces (e.g. a Dashboard widget that also listens to bell alerts). **Files changed:** new `src/lib/alert-bus.ts`; `NotificationsDropdown.tsx` (rows clickable + emit + close); `InventoryPage.tsx` (subscribe + reduce alerts into view + filters + selectedId + pendingApprovalIntent + pendingStageIntent + alertPreviewPONumber; renders a top-level `<POPreviewDialog>` outside the view tabs for the po_partial path); `ApprovalsView.tsx` + `StagingView.tsx` (each accepts a `pendingIntent?: { id, nonce } | null` prop and opens its existing detail dialog when the prop fires). See updated §5.4.A.ix for the navigation matrix + acceptance criteria.
- **TopBar bell — inventory attention queue dropdown** (rev 2026-05-27): the bell icon in the TopBar was a static red dot with no behavior. It is now a real notifications dropdown that aggregates every inventory state currently asking for the operator's attention into one categorized list — so the user can see "what's hot" without scanning the InventoryPage KPI tiles, the Approvals tab, the Staging tab, and the Purchase Orders page separately. Six alert kinds are aggregated and rendered as grouped sections in the panel: **(1) Stock-out approvals pending** (rose, `critical`) — every `StockApproval.status === "pending"`, titled e.g. *"Consume 2 × HVC-CAP-45-5"*, subtitled with the requester tech + From location + Job# / To location. **(2) On backorder** (rose, `critical`) — every `Item.status === "on_backorder"`, titled with the item name, subtitled `<SKU> · vendor <name>`. **(3) Low stock** (amber, `warning`) — every material item where `isLowStock(item)` is true AND the item is not also flagged backorder (backorder owns that surface); subtitle enumerates the offending locations as `<Location>: <onHand>/<min>` joined with ` · `. **(4) Staging area not set** (amber, `warning`) — every `JobStage` whose status is `complete` or `ready_for_pickup` but `stagedArea` is empty, so the tech reading the pickup ticket on their phone has no clue where in the warehouse to walk (matches §7.4.A.6a *"tell the tech where"* amber prod). **(5) POs partially received** (sky, `warning`) — every `PurchaseOrder.status === "partial"`, showing `<remaining> of <total> units still owed` so the buyer can chase the vendor for the rest. **(6) Ready for pickup** (emerald, `info`) — every `JobStage.status === "ready_for_pickup"`, telegraphed positively (the stage is *done*, the tech just needs to roll). **Severity model:** each alert carries `severity: "critical" | "warning" | "info"`; the bell badge color follows the worst severity present (rose > amber > emerald > slate-when-empty), and three small severity chips in the dropdown header break the total down (`6 critical · 7 warning · 1 info` etc.). The badge label shows the **total count**, capped to `9+` so the badge stays single-digit-wide; total of zero hides the badge entirely. **Sorting:** within a group, alerts sort by their alert-worthy timestamp desc (`Item.updatedAt` for stock alerts, `StockApproval.requestedAt`, `JobStage.updatedAt ?? createdAt`, `PurchaseOrder.orderedAt`), so the freshest signal sits on top of each list. Groups themselves are ordered by triage priority — pending approvals → backorder → low stock → staging-no-area → PO partial → ready-for-pickup. **Panel UX:** anchored top-right under the bell, 380px wide (clamped to viewport on narrow screens), max-height 480px with scrollable body. Header shows the title + a subtitle reading *"N items across M categories"* + the three severity chips + an `×` close button. Each row: a small severity-colored dot · 12px title · 10.5px subtitle (truncated) · relative-time chip (e.g. *"9m ago"*) on the right, with the full ISO timestamp as a tooltip on hover. Section headers show kind icon + label + count chip on the right. **Empty state:** when the alert total is zero, the body renders a centered emerald `CheckCircle2` + *"All clear"* + helper copy *"No low stock, no backorders, no pending approvals, and every staging job is squared away."* — operators see the positive signal too, so the dropdown is worth opening even on a quiet day. Footer: muted *"Live view · updates as inventory state changes"* + a Close button. **Close paths:** Escape key · outside mousedown · the `×` icon button · the footer Close button. **Implementation:** new `src/lib/inventory-alerts.ts` (pure, read-only, recomputes on every render — takes `{ items, locations, purchaseOrders, jobStages, stockApprovals }` and returns `InventoryAlert[]` + a `groupAlerts` reducer + a `severityCounts` helper + a `relativeShort` formatter). New `src/components/NotificationsDropdown.tsx` owns the trigger button (replaces the inline bell in `TopBar.tsx`) and the panel. The TopBar shrinks back to a simple shell that mounts `<NotificationsDropdown />` alongside the Help icon. **v1 scope:** read-only — rows have hover affordance and a tooltip but the per-row click is a no-op for this rev. Wiring each row to its target page / dialog (low-stock row → InventoryPage with the Low-Stock filter pre-applied; approval row → ApprovalDetailDialog by id; PO row → POPreviewDialog; staging row → StageDetailDialog) is a follow-up; the `InventoryAlert.ref` shape (`itemSku? · poNumber? · stageId? · approvalId?`) is already in place so the routing work is one file. **Rationale:** counter staff and managers told the owner they were missing things — a tech's stock-out request sat for 2 days because nobody looked at the Approvals tab, a partial PO never got chased because the buyer was looking at the InventoryPage Items list — *"give me one place that tells me what's hot."* The bell was already there carrying a meaningless red dot; making it the real attention queue is the cheapest path to that one-place-tells-me-everything outcome. See full spec §5.4.A.ix.
- **Vendor — multiple contacts per vendor** (rev 2026-05-27): the AddVendorDialog and VendorDetailDialog used to expose a single `Contact Person · Email · Phone` triplet. Real vendors have multiple humans (Orders rep + AP + Branch manager + After-hours dispatch + Returns desk); operators were stuffing the second/third into the Notes box and losing them in PO email pickers. Both dialogs now ship a labelled **"Additional contacts (N)"** strip under the primary fields with a **`+ Add contact`** button on the right; each card has its own `name` / `role` / `email` / `phone` inputs in a 2-column grid + a trash X. Role is free-form (e.g. *"AP"*, *"Branch Manager · Jamaica NY"*, *"After-hours"*). Read-mode in VendorDetailDialog shows the primary contact as before, then a horizontally-separated sub-section listing every extra contact with `mailto:` / `tel:` deep links. The VendorCard gains a tiny indigo `+N` pill next to the primary contact name when extras exist. Data model: new `VendorContact = { id, name?, email?, phone?, role? }` type exported from `data/inventory.ts`; new `Vendor.additionalContacts?: VendorContact[]` field (legacy records without it are treated as `[]`). Submit + patch normalises the list — entries with all four optional fields empty are dropped so the array doesn't accumulate phantom rows from partially-filled cards. Production schema diff: new `vendor_contact` table (`id, organization_id, vendor_id, name, email, phone, role, sort_order, created_at, updated_at` with a `CHECK (coalesce(name, email, phone, role) IS NOT NULL)` to reject empty rows) — see Appendix A.5. Seed: ADI / Anixter ships with three extras (AP rep · Branch Manager · After-hours dispatch). The existing primary `contactPersonName / contactEmail / contactPhone` fields stay on the Vendor record untouched so every reader that expects a single contact (PO header docs, email composer "first suggested recipient", VendorCard) continues to work without changes. Future rev: surface every `additionalContacts` entry as a one-click suggested recipient in `POEmailDialog` and `EmailComposeDialog` (tracked as a follow-up). See full spec §7.6.
- **Staging attachments — required photos / videos / PDF pages before "Ready for pickup"** (rev 2026-05-26): every `JobStage` now carries an optional `photos?: StageAttachment[]` collection of staging attachments. At least ONE attachment is **required** to transition `status → ready_for_pickup` and to send the Pickup Ticket email — the warehouse-floor evidence travels with the ticket so the tech (or customer reviewing the doc) can verify the pallet matches before loading. New panel sits between the Job/Tech/Staged-At three-column overview and the Notes block in `StageDetailDialog` (§7.4.A.6) — rose-bordered when blocked, emerald-tinted when populated, slate-bordered when empty-but-not-blocking. Three capture modes (always-on, mobile-first): **📷 Take photo** uses a hidden file input with `accept="image/*" capture="environment"` — on phones this opens the rear camera directly; on desktop it falls back to the file picker. **🎥 Record video** uses `accept="video/*" capture="environment"` — opens the phone's video-record mode. **📤 Upload file** uses `accept="image/*,video/*,application/pdf"` with `multiple` — accepts any mix of photos, videos, and PDFs from the device. Per-kind handling: images become inline `<img>` thumbnails (4:3 cover); videos become inline `<video>` thumbnails with a Play overlay + a `m:ss` duration chip in the corner (duration probed via a hidden `HTMLVideoElement.onloadedmetadata`); PDFs trigger the **PDF page picker** modal (see below). Each attachment carries `kind: "image" | "video"`, `source: "camera" | "upload" | "pdf-page"`, `dataUrl`, `mimeType`, `caption` (defaults to filename), `uploadedAt`, `uploadedBy`, plus optional `durationSeconds`, `sizeBytes`, `pdfPageNumber`, `pdfFileName`, `poNumber`. Per-kind size caps: 8 MB image · 100 MB video · 25 MB PDF. **PDF page picker** is a nested modal (`zIndex={95}`): pdf.js renders every page to a PNG canvas, then shows a checkbox grid (every page selected by default — opt-out, not opt-in); operator can `Select all` / `Clear` / click individual pages, then `Attach N pages` commits each selected page as its own `image` attachment with `source: "pdf-page"` + `pdfFileName` + `pdfPageNumber`. PDF-derived attachments show a small indigo `📄 p.#` badge in the thumbnail corner so reviewers can tell scanned packing slips from photos. **Mandatory gate** wires three guards in `StageDetailDialog`: (1) the `"Ready for pickup"` option in the status dropdown is `disabled` with label suffix `"— photo required"` when `photoCount === 0`; programmatic attempts to set the status surface an inline error; (2) the **Save Changes** button is disabled with tooltip *"Upload at least one staging photo before marking this stage Ready for pickup"* when `form.status === "ready_for_pickup" && photoCount === 0`; (3) the **Email** button in the read-mode footer carries the same `photoBlock` disable + tooltip so a stage that drifts into ready_for_pickup with zero photos can never be emailed to the tech. A rose banner inside the panel reiterates the block. Audit log: every add and remove appends a `StageAuditEntry` with `field: "attachments"`, oldValue/newValue = count, and a human-readable comment (e.g. *"2 photos + 1 video added · source: camera"* or *"Removed image: IMG_1234.jpg"*). **Render parity:** `StagePreviewDialog` (§7.4.A.7) adds a 3-up attachment grid between Notes and Line Items showing kind-aware thumbnails (image / video-with-play / PDF-page-with-badge), with a summary line `"N photos + M videos + P PDF pages"`. `EmailComposeDialog` (§7.4.A.9) gains an attachment thumbnail strip beside the auto-generated PDF chip, and the body now lists `"Attached: N photos + M videos + P PDF pages — verify the pallet before you load."` instead of just a photo count. **Lightbox:** clicking any thumbnail opens a fullscreen lightbox — `<video controls autoplay>` for videos, `<img>` for images — with caption / uploader / timestamp / PO# / PDF source footer. **Dep added:** `pdfjs-dist@^4` for client-side PDF page rendering; worker loaded from `/node_modules/pdfjs-dist/build/pdf.worker.min.mjs` with `standardFontDataUrl` configured so render doesn't stall waiting for font data. PDF parse + per-page render are bounded by 30 s / 20 s timeouts so a malformed file can never hang the UI. **Phone-first rationale:** counter staff already shoot pallet photos on their phones; the previous flow was *"text Stephanie a photo → she emails it to the tech"*. Now the photo lives on the stage record alongside the rest of the audit trail. See full spec §7.4.A.10.
- **Staging area picker — prominent "+ Add new" + persistence as preset + audit log** (rev 2026-05-26): three follow-ups to the §7.4.A.6a picker. (1) **Prominent + at top:** the "Add custom area…" footer link is replaced with a full-width indigo **"➕ Add new staging area"** button pinned to the top of the dropdown panel (right under the header *"Staging area in &lt;Warehouse&gt;"*). Clicking expands into an inline input + Save + ✕-cancel row with the hint *"Saved areas become presets for every future stage in &lt;Warehouse&gt;."*. (2) **Persistence as preset:** saving a new area pushes the value onto `parentLocation.stagingAreas` so it appears as a configured preset for every subsequent stage in that warehouse — not just a one-off on the current stage. In production this is a `PATCH /inventory_locations/{id}` writing `staging_areas`; in the v1 prototype we mutate the in-memory `locations` array (same object referenced everywhere in the app). (3) **Audit log on every change:** `StagingView.setStagedArea` now appends a `StageAuditEntry` to the stage's `auditLog` on every pick / change / clear. Entry shape: `{ id, at, actorName: currentUser.name, field: "stagedArea", oldValue, newValue, comment }` where `comment` reads *"Placed in &lt;Area&gt;"* for a fresh pick, *"Moved from &lt;Old&gt; to &lt;New&gt;"* for a change, or *"Cleared (was &lt;Old&gt;)"* for a clear. The stage's `updatedAt` is also bumped. Entries surface in `StageDetailDialog`'s Activity feed alongside other audit-logged edits, so the operator can see *who* put the parts *where* and *when*. Also adds `e.stopPropagation()` on the picker wrapper + trigger button so clicks don't bubble to the stage card's expand/detail handler — the picker is its own interactive surface (§7.4.A.6a Staging area picker — updated).
- **RFQ comparison — "Get 3 Estimates" before committing to a PO** (rev 2026-05-26): brand-new workflow on the "New Job" dialog (`CreateStageDialog`) that lets the operator fan a line-item list out to **multiple vendors as an RFQ**, then pick the best quote BEFORE creating the real PO. Adds an amber **"📋 Get 3 Estimates"** button in the footer between Cancel and Preview PO; disabled until at least one line item has a quantity. Clicking opens a new nested `EstimateComparisonDialog` (`zIndex={80}`, `lockEscape`) that shows three vendor cards side-by-side. New file: `src/lib/rfq.ts` exposes `generateQuotes(lines)` which (a) seeds the first candidate as the catalog's default vendor for the highest-extension line, (b) fills in the next two alphabetically from the `vendors` table excluding `Internal`, (c) applies a deterministic ±7% unit-cost variance per candidate × per-line ±3% noise (hash-stable so re-opens are consistent), (d) staggers in-stock so the #2 candidate carries a "Some items on backorder — adds ~3 days" amber note + per-line `BO` flags, (e) derives reliability (3.5–5.0 ⭐) + past-jobs (4–60) from a vendor.id hash. Composite scoring: `composite = price_score × 0.6 + lead_score × 0.25 + reliability_norm × 0.15`, each metric normalized to the best quote in this RFQ; the highest composite wins and gets `recommended: true`. The dialog renders: (1) an emerald **RECOMMENDED** banner at top (Crown icon · winner total · lead · stars · past-jobs count); (2) a 3-column grid of vendor cards each showing total (with `+X.X% vs cheapest` delta), 🟢 CHEAPEST · ⚡ FASTEST · 🔥 TOP-RATED superlative pills, per-line breakdown table (SKU · Qty · Unit · Ext · BO flag), and a per-card "Use This Vendor" CTA; (3) a "How we ranked these" formula explainer footer; (4) a "RFQ Sent To 3 Vendors" list of the items. Clicking any "Use [Vendor]" button (or the footer **"Use Recommended · &lt;Vendor&gt;"** CTA) fires `onPickWinner(quote)` → parent's `applyWinningQuote()` writes the winner's `vendor.name` onto every line in the form, pre-fills each line's `expectedDate` from the quote's per-line `leadTimeDays` if not already set, closes the comparison dialog, and surfaces an inline emerald toast in the CreateStageDialog body: *"🏆 &lt;Vendor&gt; selected from N-item RFQ · all lines updated"* (auto-dismiss 4.5s). The CreateStageDialog stays mounted so the operator can finalize and click "Create Pickup". Production wiring: the prototype's deterministic mock-quote generator is replaced by a real RFQ-out / quote-in pipeline (vendor portal API, EDI 850-RFQ, or email-with-tracked-reply); the comparison-and-rank UX is unchanged. See full spec §7.2.B.
- **CreateStageDialog PO-prefilled header renamed** (rev 2026-05-26): when the New-Job dialog is opened via the "From PO" picker on the Staging tab (i.e. `prefilledFromPO` is set), the modal title now reads **"New Job · from PO-####"** instead of *"New Job Pickup · from PO-####"* — the word *"Pickup"* was removed because "from PO" already signals the workflow and the shorter title reads cleaner on narrow screens. The standalone (no-PO) variant keeps its existing **"New Job Pickup"** title; only the prefilled-from-PO header is shortened. Subtitle copy unchanged (§7.4.A.3 Create-stage flows).
- **Trade field removed from "New Job Pickup" (CreateStageDialog)** (rev 2026-05-26): completes the trade-agnostic sweep — the "New Job Pickup" dialog (`CreateStageDialog`) no longer exposes a Trade dropdown. The top row is now a 2-column grid `Job · Customer` (was 4-col with Trade as the third); the auto-fill banner under the Job picker reads *"Auto-filled customer · site · schedule"* (trade removed); the unused `tradeOptions` constant is gone. `JobStage.trade` stays in the data model and continues to be auto-derived from the linked job (or defaults to `"multi"` when the user types a brand-new job number) — downstream surfaces that lean on trade (StageCard trade chip, stage detail, pickup ticket) keep working without change because they read it from job context, not per-stage classification. Matches the same anti-mandatory-classifier philosophy already applied to AddItemDialog / FiltersPopover / AddCategoryDialog / ImportCSVDialog (§7.4.A.4 CreateStageDialog field spec).
- **CreateStageDialog — auto-link the most recent open PO when an existing job is picked** (rev 2026-05-26): selecting an existing job in the "New Job Pickup" dialog now runs an open-PO lookup against that job's `jobNumber` (`status NOT IN ('received','closed')`, sorted `orderedAt DESC`) and auto-applies the most recent match: `linkedPOId` is set, the Items-Ordered list is replaced with that PO's lines via `applyPOLines(po)`, the "Linked to PO-####" chip + inline Preview-PO button appear next to the Items-Ordered heading, the Pickup-From-Vendor + Vendor-Pickup-Location pair is filled from the PO's vendor, and the footer **Preview PO** button becomes enabled — all in one pick. The "Auto-fill from PO" section dropdown is **filtered to that job's open POs only** (instead of the org-wide open-PO list) with an emerald *"N PO(s) on this job"* badge alongside; if zero POs are on the job the dropdown's placeholder reads `— no PO on this job —` and the Items-Ordered list resets to a single empty line so the user can add items / type a custom PO# inline. Switching to a different existing job replaces any previously auto-linked PO with the new job's most-recent open PO (or clears it); picking *"+ New job (type below)…"* also clears the link. Rationale: counter staff almost always create a staging entry for a PO they already cut — the previous "Job → scroll org-wide PO list → pick" sequence was the highest-friction step in the dialog and the source of cross-job PO mix-ups (§7.4.A.4 CreateStageDialog field spec).
- **Staging tab — "Complete" KPI tile renamed to "Ready"** (rev 2026-05-26): the 3rd KPI tile + its matching chip-row pill change label from *"Complete"* → *"Ready"* for plain-language parity with how counter staff actually describe stages whose parts are all on hand. Label-only change — the underlying `job_stage.status` enum value stays `complete` (no schema migration, semantic distinction from `ready_for_pickup` preserved), click behavior is unchanged (still filters cards by `status === 'complete'`). *(An earlier draft of this rev also introduced a `Filter ↔ Staging-Area` segmented toggle in the chip row that surfaced location-based pills; reverted same day per owner feedback — chip row stays status-only.)* (§7.4.A.2 UX — Staging tab).
- **Stage-card header — click `J-####` or customer name to open Full Transaction** (rev 2026-05-26): the chevron + the rest of the header row keep their original behavior of toggling the accordion. The `J-####` job badge and the customer-name span are now their own interactive buttons that **open the Stage Detail Dialog (Full Transaction view — §7.4.A.6) directly** — same target as the "Open Full Transaction" footer button, but reachable in one click from the header without expanding the accordion first. Both buttons `stopPropagation` so the accordion does NOT also toggle; both pick up a hover underline + indigo focus ring + a *"Open Full Transaction"* tooltip. The outer header was converted from `<button>` to `<div role="button" tabIndex={0}>` with Enter/Space key handling so the nested `<button>` elements are valid HTML. *(An earlier draft of this rev wired the click to `POPreviewDialog`; switched to the Full-Transaction dialog same day per owner feedback — the PO# pill inside the expanded line-item table still opens `POPreviewDialog` for users who specifically want the PO doc.)* (§7.4.A.2 Stage cards bullet).
- **CreateStageDialog — vendor-pickup stages land directly in "Ready for pickup"** (rev 2026-05-26): when an operator creates a new pickup with the **Pickup From Vendor** field set, the resulting `job_stage.status` is now `ready_for_pickup` instead of falling through the qty-driven `awaiting → partial → complete` chain. Rationale: these stages have no warehouse-receive step — the parts are already sitting at the vendor's counter and the tech just needs to drive there. Forcing them through the receive flow was bookkeeping for an event that never happens; landing them in Ready-for-pickup matches how counter staff actually describe the workflow (*"I cut the PO, it's at ADI, tell Mike to swing by"*). Warehouse-staged stages (no `pickupVendorId`) keep the original qty-driven status assignment. Status hand-off into `delivered` (Mark Delivered to Tech action) is unchanged (§7.4.A.4 Pickup From Vendor bullet + §7.4.A.5 acceptance criteria).
- **CreateStageDialog — per-line Vendor dropdown + multi-vendor PO split on email** (rev 2026-05-26): each row in the Items-Ordered list now exposes a **Vendor** `<select>` (was a free-text input) populated from the org's `vendors` table (excluding `Internal`), so the operator can re-assign individual lines to whichever vendor is cheapest / fastest / has stock without leaving the dialog. When the lines span more than one distinct vendor, the dialog enters **multi-vendor mode**: an amber *"📧 N vendors — split PO on email"* chip appears next to the Items-Ordered heading, and the footer email-vendor button label flips from *"Email PO to Vendor"* → **"Email N Vendor POs"**. Clicking it walks the operator through a sequential queue of `POEmailDialog` composers — one per vendor — each pre-filled with a synthetic sub-PO numbered `<original-PO#>-A` / `-B` / `-C` / … (letter suffix in the order vendors first appear in the line list; preserves audit chain to the parent PO), only that vendor's line items, the vendor's own `sales@<domain>` recipient (branch buyer Cc), and a `po-<PO#>-<suffix>.pdf` attachment chip. After each Send the composer re-renders with the next vendor's PO; the pending Awaiting-at-warehouse stage is held in state across the queue and only committed via `onCreate(...)` after the **final** vendor's send. Cancelling mid-queue aborts the entire flow and does NOT commit the stage. A `useRef<boolean>` guard absorbs the trailing `onClose` that `POEmailDialog.handleSend` fires alongside `onSent`, so the queue doesn't collapse between sends. Rationale: a single Job often pulls from 2–3 vendors (alarm panel from ADI, locksets from ASA, electric strike from Allegion); counter staff used to have to cut multiple POs from the PO module first or send one vendor everything. Now one staging entry tracks the whole shipping order; three vendor-specific emails go out simultaneously, each with only their portion (§7.4.A.4 Per-line Vendor + multi-vendor split bullet, §7.4.A.5 acceptance criteria).
- **CreateStageDialog — "Email PO to Vendor" footer action — send the order + create the stage in one click** (rev 2026-05-26): the dialog footer now exposes a third primary action **"📧 Email PO to Vendor"** between Preview PO and Create Pickup. This is the *shipping* counterpart to the existing "Pickup From Vendor" workflow (which is for in-person counter pickup): instead of staging for the tech to drive over, the operator emails the PO to the vendor to order the parts and have them shipped to our warehouse. On click the dialog validates the form, builds a `JobStage` with `status = "awaiting"`, `pickupVendorId = undefined`, `stagedLocationId =` the first warehouse-type location (defaults to Main Warehouse), and `qtyReceived = 0` on every line; then opens the existing `POEmailDialog` (nested at `zIndex={80}`, `lockEscape`) pre-filled with the linked PO's recipients (vendor sales / orders, branch buyer Cc, AP alias), subject `Purchase Order · <PO#> · <Vendor>`, body listing every line with received/ordered counts, and a `po-<PO#>.pdf` attachment chip. On Send → the parent commits the staged `JobStage` via `onCreate(...)` and the dialog closes, so one click both ships the order email and lands the staging record. The button is disabled with tooltip *"Link a PO above to email the vendor"* when no `prefilledFromPO` or `linkedPOId` is set. Together with the existing vendor-pickup branch above, the dialog now covers both vendor flows: Pickup (counter pickup → Ready-for-pickup status) and Ship (vendor delivers → Awaiting at the warehouse) (§7.4.A.4 CreateStageDialog field spec + §7.4.A.5 acceptance criteria).
- **Stage Detail Dialog — always-edit mode for in-progress stages** (rev 2026-05-26): the Full Transaction dialog (`StageDetailDialog` — §7.4.A.6) is now status-aware on open. **In-progress stages** (`status === "awaiting"` or `"partial"` — work still happening) **open already in edit mode** — every field is live (Status / Assigned Tech / Staged At dropdowns, Notes textarea, date inputs, per-line `qtyReceived` number inputs) so the operator never has to click "Edit Stage" to make a routine update. **Finished stages** (`status === "complete"` / `"ready_for_pickup"` / `"delivered"`) keep their classic behavior — open read-only with an "Edit Stage" button in the footer for occasional post-completion corrections. Footer is mode- + status-aware: in always-edit mode the full doc toolbar stays present (`Close · Preview · Email · Print/PDF · Save Changes`) so the operator can still preview / email / print the pickup ticket while editing; `Save Changes` is disabled with tooltip *"No changes to save yet"* until `pendingAudit.length > 0`, then flips to `Save Changes (N)`. No separate `Cancel` in always-edit mode — `Close` (and `×` / Esc) handle abandonment via the same dirty-prompt the read-mode flow uses (there's no prior read state to revert to). The pre-existing audit-log, dirty-prompt, photo-gate, and save-merges-into-`auditLog` mechanics are unchanged (§7.4.A.6 Edit model + acceptance criteria).
- **Staging area picker — portalled panel escapes ancestor clipping** (rev 2026-05-26): the `<StagingAreaPicker>` dropdown is now rendered via `createPortal(..., document.body)` with `position: fixed` instead of `absolute`, so it can never be clipped by the stage card's `overflow-hidden`, the scrollable stage-list container, or any modal it sits inside. Position is computed from the trigger's `getBoundingClientRect()` on open + on every window resize / capture-phase scroll, and the panel auto-flips upward (`placeAbove`) when there's more room above than below. `maxHeight` is bounded by viewport space (220–480px) and clamped so the panel never overflows the screen. Internal layout is now `flex-col` with a fixed header + fixed "+ Add new staging area" button + `flex-1 overflow-y-auto` scrollable preset list + a pinned "Clear staging area" footer — so both the add affordance and the clear action stay visible while only the preset list scrolls. Outside-click + Escape close the picker against both the trigger and the portalled panel refs. Pairs with the earlier "Staging area picker — prominent + Add new + persistence + audit log" entry above (§7.4.A.6a Staging area picker).
- **Staging area picker — pin the exact zone within the warehouse** (rev 2026-05-26): adds a second level of "where" to job staging. Before this rev, a stage's `stagedLocationId` told you the warehouse but the tech still had to guess which shelf/zone inside it. Now each warehouse-type `Location` carries an optional `stagingAreas: string[]` (Main Warehouse seeded with `["Zone A — Receiving Dock", "Zone B — Pickup Shelf", "Zone C — Bulk Aisle", "Counter Pickup Shelf", "Backroom Holding", "Loading Dock"]`; Queens Warehouse seeded with 4 zones for cross-branch demo), and each `JobStage` carries an optional `stagedArea?: string` free-form field that references one. New reusable component `<StagingAreaPicker>` exposes a small dropdown pill: indigo when set (`📍 Zone B — Pickup Shelf ▼`) or amber-pulse when unset (`📍 Pick a staging area ▼`); pops a panel with all configured presets + a "Clear staging area" link + a "Add custom area…" inline input so floor-plan tweaks don't need a settings round-trip. Wired into the StageCard expanded body as a new indigo strip — *"📍 STAGING AREA IN MAIN WAREHOUSE"* on the left, picker pill on the right; an amber *"Tell the tech where"* badge appears when the stage is complete/ready_for_pickup but no area set. Also surfaced on the StageCard header line (`Staged at Main Warehouse · Zone B — Pickup Shelf` in indigo) and on the **Pickup Ticket preview** "STAGED AT" card (indigo pill below the warehouse address) so the tech reading the ticket on their phone knows exactly where to walk. New `StagingView.setStagedArea(id, next)` mutator + toast `📍 <Job#> staged in <Area>`. Also fixed a pre-existing oversight in `StagePreviewDialog`: the "STAGED AT" card was hard-coding "Main Warehouse" regardless of which warehouse the stage actually pointed to — now reads the real `stagedLocationId` from the seeded `locations` table (§7.4.A.1 schema diff, §7.4.A.7 Pickup Ticket spec).
- **Identity-aware signatures — sig adapts to the logged-in user** (rev 2026-05-26): each `<SignatureField>` is now **identity-aware**: it knows both the *assigned signer* for that block (the tech on the pickup ticket, the branch manager in the buyer slot, etc.) AND the *currently logged-in user* (`currentUser` prop). The field's behavior auto-adapts so the signature always reflects who is actually at the keyboard: (a) **If the logged-in user IS the assigned signer** — e.g. Mike (tech) opens his pickup ticket on his phone, or Emanuel (Brooklyn HQ manager) opens his own buyer block — the field shows a small emerald banner *"👤 This block is yours — auto-personalized for &lt;Name&gt;."* and offers their adopted signature for one-tap apply. (b) **If the logged-in user is NOT the assigned signer** — e.g. Emanuel opens a pickup ticket assigned to Jose at the counter — a new **"Signing as:"** pill toggle appears at the top of the field with two options: `[Jose Ramirez]` (the assigned tech, default, preserves doc intent) or `[👤 Emanuel Dahan (you)]` (sign on behalf as yourself). Clicking a pill swaps the underlying `signerId` so the right adopted signature gets looked up in localStorage and the right name pre-fills the typed-name input + the captured `SignatureValue.signerId` reflects the actual person who signed (audit-correct). The signed state also gains a small emerald **"👤 You"** badge in the caption when the doc was signed by the current user — paired alongside the existing "✨ Auto-applied" badge for adopted signatures. Wire-up: StagePreviewDialog passes `currentUser={currentUser}` to both tech and manager blocks; POPreviewDialog passes it to the buyer block; ApprovalDetailDialog passes it to the approver block (where the assigned signer IS the current user by definition, so only the banner shows, no toggle). New `currentUser?: { id, name }` prop on `<SignatureField>` is additive (existing call sites without it keep behaving as before). See §7.4.A.8 for the updated spec.
- **Email / Save-as-PDF / Print on every preview — parity sweep** (rev 2026-05-26): the Pickup Ticket already had `Close · Email Ticket · Save as PDF · Print` (§7.4.A.7). This rev brings the other two inventory previews up to parity: (a) **POPreviewDialog** gains a new **Email PO** button driving a new `POEmailDialog` (recipient suggestions = vendor sales + vendor orders + branch buyer + AP alias + purchasing alias; To pre-filled with `sales@<vendor-domain>` derived from the vendor name; Cc pre-filled with the branch buyer; subject `Purchase Order · <PO#> · <Vendor>`; body lists ship-to, order/expected dates, every line with received/ordered counts, and an "Acknowledge receipt + confirm expected ship date" CTA; attachment chip `po-<PO#>.pdf`). Nested at `zIndex={80}` with `lockEscape`; the parent `POPreviewDialog` accepts an `onEmailSent({poNumber, to, subject})` callback that StagingView wires to a toast `✉ PO <#> emailed to N recipient(s) · <first-email>`. (b) **ApprovalDetailDialog** gains **Save as PDF + Print** buttons in both the pending-and-can-approve footer (alongside Email Team) and the closed/non-approver footer (alongside a new Email button). Adds `.approval-print-root` wrapper + `@media print` CSS that hides modal chrome and form inputs (`.approval-print-hide` on the Approval Note + Approver Signature pad + Rejection Reason + "your role can view" hint) so the printed page renders only the request body, status, audit trail, and any captured signature. Result: every inventory preview now has the same three-button toolbar pattern — **Email · Save as PDF · Print** — plus its document-specific primary action (Print, or Approve, or Send) (§7.2.A line 800, §7.4.A.7 line 982, §7.4.A.9 new).
- **Inline e-signatures on every preview (DocuSign-style)** (rev 2026-05-26): every doc that previously had a placeholder *"Signature / date"* line is now a **live, typed, re-usable signature pad** — the recipient can sign right inside the preview on web or mobile, no separate signing app, no PDF round-trip. Coverage: (a) **Pickup Ticket** (`StagePreviewDialog`) — Tech Pickup Sign-out + Warehouse/Counter Manager blocks; (b) **PO Preview** (`POPreviewDialog`) — Authorized By (buyer/manager) block, with Vendor Acknowledgement remaining a placeholder line because the vendor signs via their own emailed link; (c) **Stock-Out Approval** (`ApprovalDetailDialog`) — new **Approver Signature** block that **gates** the "Approve · post movement" button (disabled until signed; tooltip explains why). Mechanics: each block is a `<SignatureField>` component (new — see §7.4.A.8) that exposes two paths: (1) **Type to sign** — full-name input + live cursive preview rendered in the Caveat script font + optional "Adopt for future documents" checkbox; (2) **Apply my signature** — one-tap re-use of an already-adopted signature pulled from `localStorage` (key `fieldos:sig:<userId>`; in production this lives on the user profile). Signed state shows the cursive name + signer label + ISO timestamp + a small "Re-sign" pill in the corner; auto-applied signatures get a tiny indigo "Auto-applied" badge for audit. Approver-signed notes are appended to the approval's `review_comment` (`Signed by <Name> · <date>`) so the audit log in §8.2 stays append-only. New file: `src/lib/signatures.ts` (storage + types) + `src/components/SignatureField.tsx` (the field + a `SignedBadge` for compact list views). Stylesheet adds Google Fonts Caveat import + a `.sig-script` utility class. See full spec §7.4.A.8.
- **Bulk Restock from below-min items** (rev 2026-05-26): new flagship workflow that lets ops generate Purchase Orders for every below-min item in **one action**. Two entry points: (1) a global **"Restock All Low Stock · by Location"** emerald button next to the "Showing" location dropdown, visible only when the Low Stock filter is active — covers every location at once; (2) a small emerald **"Restock"** pill in the top-right corner of each card in the Low-Stock Health by Location grid (§5.4.A.i), visible only when that card has `lowCount > 0` — scopes the dialog to that single location. Both routes open `BulkRestockDialog` which:
  - Computes below-min items per location (compares `stock_balance.on_hand_qty` vs `min_qty`)
  - **Suggests order qty** = `(max_qty ?? min_qty × 2) − on_hand_qty`, clamped ≥ 1 — editable per line
  - **Groups by location → vendor → lines** with collapsible per-location cards; each vendor sub-group becomes **one PO** (one PO cannot mix vendors)
  - Per-location header shows `<icon> <name> · <primary_tech> · N lines · M POs · $TOTAL`; per-vendor header shows `→ PO to <Vendor> · N lines · $X`
  - Line table per vendor: SKU · Item · On Hand (rose if 0, amber if low) · Min · editable Order Qty · Unit Cost · Extended
  - Top summary: `N purchase orders · M lines across L locations · $TOTAL`
  - Footer CTA: **"Create N Purchase Orders · Send for Approval"** — creates POs in `Pending Approval` status (routed to the approval queue)
  - Empty state: green checkmark + "Everything is at or above its reserve level."
  - Hint footer: "Vans receive stock via internal transfer from the warehouse after the warehouse PO is received — the van-tagged POs document the demand and target qty."
  - On submit, `handleBulkCreatePOs` fires a per-location breakdown toast: `✓ N POs created · M lines · $T · pending approval. Main Warehouse (1 PO · $760) · Jose's Van (3 POs · $1530) · Carlos's Van (3 POs · $1144)`
  - New `filterLocationId?: string` prop on BulkRestockDialog scopes the entire flow to a single location for the per-card pill entry point; title becomes `Restock · <Location Name>` and subtitle scopes accordingly. (§5.4.A.i, §7.2 PO creation; new schema field `purchase_order.ship_to_location_id` — Appendix A.5 — to record which location each PO is destined for, supporting van-tagged POs.)
- **Vendors page — dedicated route with directory, by-category, and spend-analytics views** (rev 2026-05-27): the **Vendors** sidebar item under Inventory is now a real navigation target instead of a decorative placeholder. Clicking it routes the right-pane to a brand-new `VendorsPage` component (App-level `route` state in `App.tsx`, `Sidebar` rewired with `currentRoute` + `onNavigate` props; Inventory and its child items stay visually grouped — picking Vendors keeps the parent Inventory row lit so the breadcrumb stays coherent). The page mirrors the InventoryPage shell pattern: **Operations > Inventory > Vendors** breadcrumb, page title + descriptive subtitle ("Master vendor list · spend tracking · purchasing power…"), top-right **`+ Add Vendor`** CTA (gated by `canEditCatalog`), 4 KPI tiles (**Active Vendors** count · **Total Spend YTD** dollar value · **Top Vendor** name + % share of YTD · **Categories** count of distinct types), three sub-tabs (**Directory · By Category · Spend Analytics** — defaults to Directory), and a filter row (search by name/contact/account#/email/category + category dropdown + Active/Inactive/All status segmented control + `N of M vendors` count). **Directory tab** renders the cards in a responsive 1/2/3-col grid; **By Category tab** groups the same cards by `vendor.category` with section headers showing `<category> · <count> · $<YTD> YTD`; **Spend Analytics tab** is a leaderboard table ranked by YTD spend with columns rank · vendor + contact rep · category · YTD spend · share-of-spend bar · MoM % delta (↑/↓ chip) · POs · last ordered, with a footer reminder *"Purchasing power = your share of total inventory spend… lead with your YTD volume to ask for better terms"*. Row click in any view opens the `VendorDetailDialog`. Spend math joins each PO's `lines[]` to the catalog by SKU and sums `qtyOrdered × item.unitCost` per vendor across all-time / YTD / this-month / last-month buckets (`computeAllVendorSpend()` in new `src/lib/vendor-spend.ts`), so totals stay live as POs are added or items repriced — no separate spend table needed for v1. New files: `VendorsPage.tsx`, `VendorCard.tsx`, `VendorDetailDialog.tsx`, `DeleteVendorDialog.tsx`, `VendorCategoryPicker.tsx`, `lib/vendor-spend.ts`. Vendor data model extended with `contactPersonName?`, `website?` (URL), `status?: "active" | "inactive"` (soft-archive flag, missing = active); seed data backfilled for all 7 prototype vendors with realistic rep names + phones + websites. See full spec §7.6.A.
- **Vendor Detail Dialog — in-place edit + soft archive + delete-with-block** (rev 2026-05-27): each vendor card opens a full-context modal that reuses the universal `<Modal editAction>` pattern from the rev-2026-05-27 Edit affordance entry. **Header** carries the `✏️ Edit` button (left of X, admin-gated via `canEditCatalog`) that flips to an amber `EDITING` pill on click. **Body** is a three-column overview (**Contact** card · **Account** card · **Pickup / Ship-from** card) followed by 4 spend cards (YTD · This Month with `▲ X%` MoM delta · All-Time · Avg PO with top-item subtitle), then a Recent Purchase Orders table (last 5 with PO# · job/customer · ordered date · status pill · extended total). Edit mode swaps every field into inputs at the right spot (contact person · email · phone · website · account # · terms select · lead-time days · transmit-method pill picker · pickup textarea · notes textarea · name · category picker), the footer flips to `Cancel · Save Changes` (Save disabled when nothing changed OR name is empty; tooltip explains the block), and `lockEscape` engages so a stray Esc can't wipe edits. **Footer** in view-mode: `Close · Email Vendor` (mailto, only when email on file) `· Archive | Reactivate` (soft-archive toggle, amber, admin-only) `· Delete` (rose outlined, admin-only). **Delete flow** routes through a new `DeleteVendorDialog`: if the vendor is referenced by any open PO (`status IN draft/sent/partial`) OR by any inventory item's `item.vendor`, hard-delete is **blocked** with a clear rose banner *"Cannot delete — vendor is still in use"* and an amber **Soft Archive Instead** CTA replaces the destructive button; the dialog lists the actual blocking POs (PO# · job · customer · status pill) and up to 6 linked items (SKU · name, with `+ N more…` truncation) so the user can see exactly what's holding the deletion. If nothing is blocking, the footer's red **Delete Vendor** is enabled and a small amber "this is permanent" warning sits in the body. Archive toggles `vendor.status` between `active` and `inactive` — historical POs keep their reference, but the vendor stops surfacing in active pickers (status filter on the page defaults to Active so archived vendors hide unless you flip the toggle). Save toasts `✏️ <Name> updated`, archive toasts `📦 Archived <Name> · still on historical POs`, reactivate toasts `✓ Reactivated <Name>`, delete toasts `🗑 Vendor "<Name>" deleted`. See full spec §7.6.A.
- **Vendor Category — dropdown of existing categories with inline "+ Add new"** (rev 2026-05-27): the Category field in both `AddVendorDialog` and the `VendorDetailDialog` edit mode is now a smart picker (`<VendorCategoryPicker>` — new reusable component) instead of a free-text input. The control renders as a native `<select>` showing every distinct `vendor.category` from the live vendors list (computed in `VendorsPage` and passed down as `existingCategories: string[]`), sorted alphabetically, with `Select a category…` as the empty placeholder, a `──────────` visual divider, and `+ Add new category…` as the last option. Picking an existing option commits the category immediately; picking the `__new__` sentinel swaps the select for an autofocused text input with a small `✕` cancel button that returns to the select state. The picker also detects when an existing vendor's category isn't in the known options (e.g. legacy data created before this picker existed) and starts in the new-mode input pre-filled with the legacy value, so editing those vendors still feels natural. The component takes an optional `inEdit` prop that flips the border + focus-ring tint from indigo to amber so it visually matches the `VendorDetailDialog` edit-mode banner. Result: the same category gets typed *zero times* after the first vendor in that bucket — exactly the "by the category I create" UX the owner asked for. Files: new `VendorCategoryPicker.tsx`; wiring in `AddVendorDialog.tsx`, `VendorDetailDialog.tsx`, `VendorsPage.tsx`. See full spec §7.6.A *"Category picker"*.
- **Universal "Edit" affordance in the Modal header + in-place edit on the Stock-Out Request** (rev 2026-05-27): the shared `<Modal>` component gains an optional `editAction` prop that renders a small outlined **`✏️ Edit`** button immediately to the left of the X in the header — opt-in per dialog so existing form-style modals (Add Item, Restock, Transfer, etc.) are unaffected. When `editing` flips true the button swaps to an amber **`✏️ EDITING`** pill so the modal header advertises its dirty state from across the screen. First consumer is `ApprovalDetailDialog` (§5.4.A.v.4a), which now supports **in-place editing of a stock-out request** without leaving the dialog: clicking Edit captures the current approval into a `draft` and swaps the display values for inputs on the editable fields (qty · destination location · serial captured · job # · customer · tech's reason). The Movement Request card's qty number becomes a typed number input (rose-bordered when ≤ 0, indigo otherwise) and the *≈ value* preview recomputes live against the draft qty. The header `lockEscape` flips on while editing so a stray Esc can't wipe pending changes. Footer in edit mode swaps to `Cancel · Save Changes` — Save is disabled when nothing has changed or qty is invalid; tooltip explains why. Save calls a new `onEdit(id, patch)` callback up to `ApprovalsView.applyEdit`, which merges the patch into state and toasts `✏️ <SKU> updated · <diff summary>` (e.g. *"qty 1 → 2"*, or *"reason, dest → Carlos's Van"*). **Permissions** route through a new `canEditApproval(approval, user)` helper in `current-user.ts`: admin-tier roles (`owner` / `admin` / `warehouse_manager` / `inventory_admin`) can always edit; the original submitter can edit only while `status === "pending"`. The Edit button hides for everyone else. **Post-decision edits are audit-logged, not silenced** — `StockApproval` gains an optional `modifications?: ApprovalModification[]` array (`{ at, byName, note, postDecision }`); every Save appends one entry derived from a per-field diff. When `approval.status !== "pending"`, the in-edit amber banner reminds the user *"This request was already &lt;approved/rejected&gt; — edits will be marked **post-decision** in the audit log."* and the toast reads `✏️ <SKU> edited after decision · audit logged (<diff>)`. A new **Modifications** block renders below the Decision Audit strip whenever `modifications.length > 0`, listing each entry as `<timestamp> — <name> edited <diff summary>` with a small amber **post-decision** pill when applicable, so the request's lifecycle is never silently rewritten. Files touched: `Modal.tsx` (editAction prop + Pencil-icon button / EDITING pill), `stock-approvals.ts` (`ApprovalModification` type + `modifications?` field on `StockApproval`), `current-user.ts` (`canEditApproval` helper), `ApprovalDetailDialog.tsx` (draft state · diff helper · in-place inputs · Modifications block · edit-mode banner + footer), `ApprovalsView.tsx` (`applyEdit` handler + `onEdit` wiring). The `editAction` pattern in `Modal.tsx` is reusable — same hook will land in the other read-only detail dialogs (`StageDetailDialog` already-edit-mode flow excepted, `StagePreviewDialog`, `POPreviewDialog`, `EstimateComparisonDialog`) in a follow-up pass so every detail popup gets the same "click Edit · fix the field · Save Changes" muscle memory. See full spec §5.4.A.v.4a Edit affordance.
- **Purchase Orders page — dedicated route with Pre-PO · Open · History tabs + status-adaptive PODetailDialog + end-to-end Receive flow** (rev 2026-05-28): the **Purchase Orders** sidebar item under Inventory is now a real navigation target instead of a decorative placeholder. New `PurchaseOrdersPage` mounts at the `"purchase-orders"` Route slot with the same shell pattern as VendorsPage: breadcrumb `Operations › Inventory › Purchase Orders`, page title + subtitle, top-right **`+ Create PO`** CTA (opens NewPODialog placeholder this rev — full design locked in §7.4.B.8), **4 KPI tiles with single-active semantics** (Pre-PO pending · Open POs with `$X,XXX.XX in flight` hint · **Late** · **Arriving this week**) where only one tile can be lit at a time and clicking the lit tile or any sub-tab clears the filter, **3 sub-tabs** (Pre-PO · Open · History, default = Open), a search + Vendor + Trade filter row, and a per-tab table that adapts its columns to the lifecycle stage. **Pre-PO tab** unifies 3 row types into a single sorted list (Age DESC): RFQs (in-flight 3-vendor quotes), Draft POs (`status: "draft"`), and Estimate Reservations (material commits against approved customer estimates) — new `pre-po.ts` data file defines `RFQ`, `EstimateReservation`, `PrePOLine`, `RFQQuote`, `EmailThreadEntry` types + seed data (3 RFQs · 2 Reservations · 2 Drafts). **Open tab** sorts late rows first then by expected ASC; expected date renders rose with a 🔴 dot when past today, amber within 7 days. **History tab** PO# is itself a button that opens POPreviewDialog directly for fast audit lookups. Row click anywhere opens **`PODetailDialog`** (new) — a status-adaptive modal with header summary (status pill · vendor · trade · ordered → expected timeline), 4 inner tabs (**Lines** default · Activity · Documents · 3-Way Match), and a footer whose primary action changes per status: `draft → Send to vendor`, `sent → Receive items`, `partial → Receive remaining` (+ left-aligned *"Received N of M units · X% complete"* hint), `received → Close PO`, `closed → no primary`. Email + Preview/Print are always present and mount nested at `zIndex={80}` with `lockEscape` (POEmailDialog · POPreviewDialog). **Receive flow** is end-to-end: clicking the primary in `sent`/`partial` enters a Lines-tab edit mode (emerald banner with Reset + Receive-all quick actions, per-row clamped number input + per-row +1 button matching the StagingView pattern, footer swaps to `Cancel · Save Receipt` emerald primary). Save calls the new **`lib/po-receive.applyReceive(poId, lineUpdates)`** helper which (1) auto-derives the new PO status from line totals (`derivePOStatus`: 0 received → sent, partial → partial, all → received), (2) replaces the entry in `purchaseOrders[]`, (3) **bumps `items[sku].stock(loc_wh_main).onHand` by each positive delta** at Brooklyn HQ Main Warehouse, (4) **mirrors the deltas to the linked `JobStage.items[sku].qtyReceived`** when `po.stagedAsJobStageId` is set and re-computes the stage's `awaiting → partial → complete` status, and (5) returns a `ReceiveResult` with everything the caller needs to surface a toast. Page-level toast format: *"✓ PO-2308 updated · +30 units received · stock bumped at Main Warehouse · Brooklyn HQ · staging stg_002 → complete"* (stage segment omitted when no link; auto-dismiss 4.5s). Inventory + Staging pages observe the new values on next render via the shared-seed-array pattern (cross-tab bus deferred — `[OPEN-7.4.B-9]`). Files: new `PurchaseOrdersPage.tsx`, `PODetailDialog.tsx`, `PrePODetailDialog.tsx`, `data/pre-po.ts`, `lib/po-receive.ts`; modified `Sidebar.tsx` (`Route` union + child `route:`), `App.tsx` (route branch), `data/purchase-orders.ts` (+2 draft POs in seed). See full spec §7.4.B.
- **Item Groups redesigned — "Group" now means a preset bundle of line items, not a product family within a brand** (rev 2026-05-28): the prior `ItemGroup` concept (Mul-T-Lock C-Series, Schlage ND-Series, Kaba Peaks Preferred — product families *inside* a brand, with items referencing their group via `item.group_id`) was **fully retired** and the word "Group" was repurposed for what Workiz / ServiceTitan call an **Item Group** or **preset bundle**: a saved list of line items (parts + labor + dispatch fees) that drops onto an estimate or invoice by name, auto-populating every line for fast turnaround. The owner's framing, after walking through Workiz's edit-item-group flow as a reference pattern: *"This is something I like better inside the price book in the group to create something like a set estimate group or preset invoice group. When you create a group, you can put the line item inside, and when you want to create a fast estimate of a fast invoice, you just put the name of the group. It's generated automatically, the estimate of the invoice with all the preset item label and everything inside for easy turnaround… Let's do it in our way, the better way."* **Brainstorming locked 6 product decisions** before code touched the repo: (1) **Replace, not coexist** — the product-family Group concept goes away entirely; items now hang directly off Brand (`Brand → Item`, not `Brand → Group → Item`). (2) **Both display modes per bundle** — every bundle picks *Individual items* (each line surfaces as its own row on the customer's estimate) or *Flat rate* (one lump-sum line; underlying lines stay internal for cost / margin tracking). (3) **Pricing is live with per-line override** — bundle lines pull each item's current Price Book price by default but can be overridden per bundle (so a "Standard Rekey" bundle can charge $40/hr for labor even if the standard labor item lists $50/hr). (4) **Flat-rate price defaults to sum, allows custom override** — `flat_rate_price_override` is optional; when null the customer sees the sum of lines, when set the customer sees the override (e.g. "Standard Rekey: $189 flat" even if parts only sum to $282 — internal margin tracking still computes against the sum). (5) **Lines can be real Price Book items OR free-form one-offs** — a line either references `item.id` (with optional price / cost overrides) or carries a free-form name + price for things like "Travel fee — $50" that don't deserve a standing inventory item. (6) **No category on bundles, no brand on bundles** — bundles are cross-brand by definition (a door-install kit has a Schlage lock + Stanley hinges + Klein tools); we kept the surface flat (name + description + photo + lines) and skipped category filing to keep the create flow fast. **Data model (Appendix A.4 rewritten):** the old brand-scoped `item_group` table is dropped. New `item_group` table = bundle (`id · organization_id · name · description · photo_url · group_type item_group_type_enum · flat_rate_price_override numeric · is_active · created_at · updated_at`) where `item_group_type_enum = ('flat_rate' | 'individual')`. New `item_group_line` table holds the lines (`id · item_group_id FK · sequence int · item_id FK NULL · name text NOT NULL · quantity numeric · price_override numeric NULL · cost_override numeric NULL · notes text`). The `item.group_id` column is dropped — items only reference Brand now. **Bundle dialog (AddGroupDialog rewrite — `xl` modal):** banner-style 4:1 photo upload at top → Bundle Name (required) + Active toggle → Description → **Customer-facing format** radio cards (Individual items vs Flat rate, indigo-tinted when active) → **Flat-rate price (optional override)** input (only renders when Flat rate is active; placeholder shows `Default = $X.XX (sum of items)`) → **Items in this bundle** section with a typeahead search box (matches name / SKU / customer name across the full item catalog) and a **+ Free-form line** button → lines table (Item · Qty · Price · Cost · Margin% · Amount · 🗑) where every numeric cell is an editable input — leaving Price blank means "use the referenced item's live price." Free-form rows render with a small amber **FREE-FORM** chip below the name input. Footer rows: **Subtotal (sum of lines)** + **Customer sees ($XXX flat rate / itemized)** rendered in indigo bold. Save validates name presence, ≥ 1 line, non-empty free-form names, positive quantities, and (for flat-rate override) a non-negative number. **Groups tab on PriceBookPage (rewritten as bundle browser):** indigo explainer banner at top describing preset bundles → search-by-name + All-formats / Individual / Flat-rate filter dropdown + count chip + **+ New Bundle** CTA → 3-column responsive grid of bundle cards. Each card: hero banner (2:1 aspect — uploaded photo when set, indigo-tinted gradient + `Layers` icon fallback otherwise) with a top-left format chip (amber "Flat rate" / sky "Itemized") and an optional slate "Inactive" badge below it · hover-revealed Edit (pencil) / Delete (trash) pills floated top-right with backdrop blur · body shows name + description + a slate-tinted line-summary box (`N LINES` header + first 3 lines as `{qty}× {name}` + `+N more…` overflow) + footer row with `CUSTOMER SEES $XX.XX` in big indigo (showing the flat-rate override or the sum, whichever applies) and a color-toned `MARGIN N%` (emerald ≥ 50% · amber 25–50% · rose < 25%) on the right. Empty state shows a dashed-border card with a `Layers` icon + *"No bundles yet — create your first preset bundle"* + a CTA. **Cleanup propagated across the app:** (a) **Items tab** dropped the `Brand · Group` column → just `Brand`; dropped the Group filter dropdown from the filter row; the `itemsByGroup` memo + `groupsFilterBrand` state were removed. (b) **Brands tab** dropped the "Groups" count tile (cards now show only the Items count) and the `+ Add group` pill at the bottom of each card; `BrandsTab` no longer takes `groupCountByBrand` or `onAddGroupForBrand` props; deleting a brand no longer cascades into groups (none to cascade into). (c) **AddItemDialog** dropped the `Group` `<select>` from the Price Book panel (now `Brand · Visibility` — `grid-cols-2` instead of `grid-cols-3`); the `itemGroups` prop + `groupId` form field + `groupId` in `NewItem` payload + `handleBrandChange`'s clear-group logic were all removed. (d) **Seed cleanup** — `groupId: "grp_..."` was stripped from all 6 seeded items via `sed -i '' '/^    groupId: "grp_/d'`; the legacy 16-group `itemGroups` seed array was replaced with **5 seeded bundles** (`Standard Rekey Service` flat $189 / 3 lines · `Residential Lockout Service` flat $165 / 2 lines · `Single Door Access Install` itemized $1,380 / 4 lines · `HVAC Capacitor Replacement` flat $235 / 3 lines · `Electric Strike Install — Commercial` itemized / 3 lines) that exercise every dialog path (flat-rate + override, itemized, free-form lines, real-item lines with and without per-line price overrides). (e) **InventoryPage / NewPODialog / PurchaseOrdersPage** dropped their `allItemGroups` / `seedItemGroups` / `initialItemGroups` references and the `itemGroups={...}` prop pass-through into AddItemDialog (the prop no longer exists). **Estimate-side integration** (the "type bundle name → auto-generate the estimate" half of the vision) is documented as the next-phase target in §6.11 but **not built in this prototype** — we don't have a customer-facing Estimate page yet (only `EstimateComparisonDialog` for PO vendor comparison). The build scope for this rev was Bundle CRUD only; estimate-side ships when the Estimate page lands. **Verified end-to-end on `localhost:5174`**: navigated Price Book → Groups → confirmed the 5 seeded bundles render with correct format chips, line summaries, customer-sees prices and margin %s; clicked **+ New Bundle** → confirmed the bundle editor dialog opens with the photo banner, name field, both format toggles, items search + free-form button, empty lines table; hovered Standard Rekey Service → clicked Edit → confirmed dialog opens as *"Edit Bundle · Standard Rekey Service"* with all 3 lines pre-filled at correct qty (1, 1, 1) and prices populated from the referenced items' live `listPrice`/`sellPrice` values (165, 92), with the Flat rate toggle correctly highlighted (border-indigo-500 / bg-indigo-50) and the $189 flat-rate override pre-filled in the input. **Files touched:** `dashboard/src/data/inventory.ts` (`ItemGroup` type rewritten · `ItemGroupLine` type added · `ItemGroupType` exported · 5 seed bundles replace the 16 product-family groups · `Item.groupId` field removed · 6 seed items scrubbed of `groupId`), `dashboard/src/components/AddGroupDialog.tsx` (full rewrite as bundle editor — `~450 LOC`), `dashboard/src/components/PriceBookPage.tsx` (`GroupsTab` rewritten as bundle browser; `ItemsTab` dropped Group column + filter; `BrandsTab` dropped Groups count + Add-group pill; dialog mount passes `items={...}` instead of `brands={...} lockedBrandId={...}`; `groupSearch` + `groupTypeFilter` state replace `groupsFilterBrand`), `dashboard/src/components/AddItemDialog.tsx` (Group field + `itemGroups` prop + `groupId` form field + payload field all removed; panel title changed to "Brand · Visibility"), `dashboard/src/components/InventoryPage.tsx` (`allItemGroups` state + `ItemGroup` type import + `groupId` payload field + `itemGroups={...}` pass-through removed), `dashboard/src/components/NewPODialog.tsx` (`itemGroups` prop + import + `groupId` payload field + pass-through into AddItemDialog removed), `dashboard/src/components/PurchaseOrdersPage.tsx` (`allItemGroupsCatalog` state + `seedItemGroups` import + `ItemGroup` type import + pass-through removed). **PRD updates this rev:** §6.A.2 tabs table — Groups row rewritten from "Manage product-family groups (CRUD, nested under Brand) — card grid filterable by brand" to bundle browser description; §6.A.8 acceptance criteria — old product-family Group criteria removed, 6 new bundle-behavior criteria added (CRUD + format toggle + flat-rate override + free-form lines + live pricing + per-line override); §6.A.10 implementation status — new shipped entry below; §6.11 Item Group entity — section fully rewritten from "product family within a brand" to "preset bundle" spec; §6.2 Item Taxonomy — taxonomy diagram updated from `Brand → Group → Item` to `Brand → Item` with a paragraph noting the redesign; Appendix A.4 — old brand-scoped `item_group` DDL replaced with the new bundle `item_group` + `item_group_line` tables, `item.group_id` column dropped from the schema sketch.

---

# 1. Executive Summary

## 1.1 Product Vision

`[PRODUCT]` is an **FSM + CMMS platform** with first-class **Inventory + Price Book + Purchase Order** modules built for **any field service trade**. Where competitors treat inventory as an afterthought (Jobber, HCP) or treat the price book as a list manager (everyone), `[PRODUCT]` treats both as the **operating system for monetization** — a margin model with a field-sales UI, an evidence ledger that posts trusted financial actions to accounting, and a procurement workflow that finally handles returns, credits, and three-way match as first-class flows.

## 1.2 Target Customer

Any FSM service provider — explicitly horizontal across all 15 trades the research catalogs (locksmith, door, electronic security, garage door, HVAC, plumbing, electrical, fire & life safety, appliance, pest, pool/spa, landscape, roofing, cleaning, handyman). No beachhead segment for design polish [A2]; trade templates seed the schema per trade, customer-supplied content fills it.

## 1.3 Scope of This PRD

- **Inventory Module** — multi-location stock, serialization, lot/batch (schema only v1), kits/bundles, transfers, consumption, returns, cycle counts, customer/asset linkage.
- **Price Book Module** — services, materials, labor, bundles, memberships, contracts, customer overrides, markup engine with cost-band tiers and margin floors, GBB option presentation, bulk import/AI cleanup/category rules, versioned publish.
- **Purchase Order Module** — manual / low-stock / from-job / from-estimate creation, amount+role approvals, partial/full receiving, vendor bills, returns to vendor, credit memos, three-way match with exceptions queue.
- **Cross-cutting**: AI/automation, mobile UX, technical architecture, hardware compatibility (refer-only), compliance hooks, NFRs, pricing/packaging, MVP scope.
- **Out of scope for this PRD**: dispatch UX (deferred — jobs have `assigned_tech_id` + `scheduled_at` fields editable in a basic list view, but no calendar/drag-drop/route-map UX ships v1), full CMMS preventative-maintenance UX (Phase 2), customer portal beyond magic-link views, marketing site, sales playbooks.

## 1.4 Top 5 Differentiators

1. **Cross-Trade Jobs with Segments** — one Job, multiple trade segments, each with its own tech + asset + line items; one invoice, one signature, one cost rollup. Multi-trade operators get a workflow competitors cannot match without re-architecture [A53, Agent 11].
2. **Returns + Credits + Three-Way Match as first-class flows** — `vendor_return`, `credit_memo`, `three_way_match_exception` ship in v1. No competitor publicly does this [A5, Agent 2, Agent 3].
3. **AI-Native across all three modules** — Smart Search + Voice-to-Parts + Vendor Invoice OCR + Catalog Ingestion AI + Owner Morning Brief in MVP, with rigorous trust framework and per-tenant cost gating. No competitor publicly markets AI in I/PB/PO [A4, Agent 7, Agent 2].
4. **Universal Asset Model** — one `Asset` table with typed subtypes (Opening, Panel, Equipment, Appliance, Sprinkler Riser, Pool Body, Roof Section) unifies CMMS + service history + warranty + inspections across every trade [A6, Agent 11].
5. **Tamper-evident audit log + commercial-grade procurement** — hash-chain `audit_log` + multi-step approval engine + variance-detection exceptions queue, positioned for Rolex/McDonald's-tier commercial accounts who require forensic integrity [A20, A49, Agent 3].

## 1.5 Top 5 Risks

1. **Horizontal-mush** — going broad across all FSM trades + no beachhead anchor risks "fits every trade, excels at none" reputation. Mitigation: best-in-class generic primitives + trade-template guided setup + obsessive polish on 5 flagship workflows [A2, A11, contradicts research].
2. **AI COGS runaway** — Vendor Invoice OCR is the cost swing factor; heavy users on Starter tier can destroy unit economics. Mitigation: per-tier OCR quotas + overage billing + optional hard cap [A51].
3. **Self-serve trial conversion** — 14-day trial + BYO content means users can land in an empty product. Mitigation: flagship onboarding workflow (5 funded workflows = #1 is first-run trial) + AI catalog ingestion + trade templates with 10-15 service placeholders per trade [A11, A52].
4. **Multi-platform engineering load** — RN + iOS + Android + offline-first + 5 AI features + Returns/3WM + Universal Asset + Cross-Trade Segments is a substantial v1. Mitigation: hire RN-specialized engineers; treat 5 flagship workflows as "flawless" budget; everything else "functional" [A11, A23].
5. **QBO sync drift + QBD strategy deferred** — operational inventory in FSM + summary journal entries to QBO is the right architecture but is a known industry footgun. QBD support is `[DEFERRED]` — no commitment v1 or Phase 2; revisit on customer demand. QBD-anchored prospects filtered out at launch. Mitigation: ship per-tenant per-entity QBO queue + CDC reconciliation + daily backfill; soft-handle QBD prospects with "no commitment yet" honest narrative [A9, A39, Agent 4].

## 1.6 Success Criteria (Headline Metrics — see §17 for full)

- **Time to first valuable action** in trial < 30 minutes (flagship onboarding workflow target).
- **Tech part-add latency** p95 < 3 seconds end-to-end (search/scan/voice + attach to job + cost rollup).
- **OCR confidence on vendor receipts** ≥ 90% confirm-only (no manual line repair at counter).
- **PO 3WM exception rate** < 5% of received POs (signals data quality + tolerance config working).
- **Trial → paid conversion** > 15% by Month 3.

---

# 2. Background & Strategic Context

## 2.1 Why This Product Exists

Field service businesses are drowning in inventory and price book pain that incumbents fail to solve [Agent 1 VoC]:

- **"It took probably 6 months total for them to finally upload the price book."** (r/HVAC) — setup is a months-long data-entry project, not a feature.
- **"There is no integrated inventory management."** (r/Locksmith) — lighter FSMs have no real native inventory; users bolt on second systems.
- **"It would show 0$ on everything."** (r/HVAC on ServiceTitan) / **"Nothing caches to your phone."** (r/HVAC on Service Fusion) — mobile/offline reliability collapses in the field.
- **"Installers def hated it as they were expected to try and input all the parts they used."** (r/HVAC) — truck-stock part capture is too slow, so margins leak silently.
- **"The fix isn't more inventory tracking, it's forcing parts into the workflow before the job can be closed."** (r/smallbusiness) — owners have given up on voluntary capture; they want enforcement.
- **"I can't save it without having to fill out ALL the blanks."** (App Store, ServiceTitan, Feb 2024) — mandatory PO field tyranny is a hated anti-pattern.

Owners want governance over freedom, real job-cost answers, mobile-first speed, and built-in features instead of add-on stacking — a "smaller feature set that is operationally real" beats glossy lists.

## 2.2 Market Gap

The five leading FSM CRMs each have specific gaps [Agent 2]:

| Competitor | Inventory | Price Book | PO | Notable Strength | Notable Gap |
|---|---|---|---|---|---|
| ServiceTitan | 9/10 | 9/10 | 9/10 | Deepest cohesion; supplier catalogs | Admin-heavy; "Powerful but underused" trap; no returns/credits |
| Workiz | 5.5/10 | 7/10 | 6/10 | User-location permissions; flat-rate composition | Inventory as add-on; thin docs |
| Housecall Pro | 3.5/10 | 8.5/10 | 2.5/10 | Visual Price Book; multi-option proposals | Inventory punted to Ply; no native PO |
| Jobber | 2/10 | 6.5/10 | 1.5/10 | Transparent pricing; GraphQL API | No native inventory; no native PO |
| Zoho FSM | 5/10 | 6.5/10 | 4.5/10 | WO→SO reservation; mass updates | PO outside FSM; horizontal-mush |

**Universal gaps across all five:** Serialized tracking, three-way match, returns/credits, AI in I/PB/PO, approval thresholds, cross-trade jobs, multi-trade commercial positioning.

`[PRODUCT]` directly targets every universal gap — and goes horizontal across trades where competitors lean residential-home-services or vertical-only.

## 2.3 Emanuel's Domain Authority

Emanuel Dahan runs a multi-trade commercial FSM business (locksmith + door + electronic security) serving Rolex / McDonald's / TikTok-tier accounts. He is the operator-author: the workflows in this PRD trace to lived multi-trade commercial reality, not abstract research. Where his calls contradict research (flagged at A2 — no beachhead anchor), operator wins.

## 2.4 Strategic Bets Being Made

1. **Horizontal beats vertical** in FSM `[A1]` — schema-agnostic + trade templates + universal Asset model.
2. **Build the engine, never the content** `[A1]` — BYO price book; product never ships flat-rate content as a deliverable.
3. **AI is the wedge** `[A4]` — five P0 AI features at MVP, positioning around "field evidence to trusted financial action."
4. **Commercial-grade procurement is the moat** `[A5, A20]` — returns + credits + 3WM + hash-chain audit log + multi-step approval (Phase 2).
5. **Cross-trade jobs is the killer feature** `[A53]` — one Job, multiple Segments, multi-tech, single invoice — competitors literally cannot match without re-architecture.
6. **Self-serve trial across all tiers** `[A3]` — anyone can sign up, try, convert; demo motion optional and reserved for Enterprise.
7. **Refer-only on hardware** `[A13]` — publish certified list + Hardware Health Check; never become a reseller.

---

# 3. Target Users & Personas

Six personas. All workflows must be designed against at least one.

## 3.1 Owner (Emanuel-class)
- **JTBD**: Protect margin; trust the numbers; standardize operations; reduce dependency on tribal knowledge.
- **Pains**: Months-long setup; opaque job-cost; tech non-adoption; mobile failures destroying trust.
- **Gains from `[PRODUCT]`**: Owner Morning Brief (AI, A4); margin/AR/turn dashboards (native v1); audit log forensic integrity (A20); markup engine governance (A43).
- **Device profile**: Mostly desktop; mobile for ad-hoc.

## 3.2 Operations Manager / Dispatcher
- **JTBD**: Schedule the right tech at the right time; respond to emergencies; balance loads.
- **Pains**: Dispatch UX in incumbents (Service Fusion, FieldEdge) feels archaic; no real-time tech location.
- **Gains from `[PRODUCT]`**: Job assignment + scheduling fields in list view (no calendar UI v1 — full dispatch `[DEFERRED]` to Phase 2); mobile push for emergencies (A59.6); Cross-Trade Job multi-tech assignment (A53).
- **Device profile**: Desktop primary; tablet secondary.

## 3.3 Office Admin / Bookkeeper
- **JTBD**: Reconcile to accounting; close the books; chase AR; cleanup tech-entered data.
- **Pains**: Free-text line items dirtying reports; QBO sync drift; bulk price updates manual.
- **Gains from `[PRODUCT]`**: Free-text with governance (A45); QBO summary journal entries with explicit linkage (A39); bulk update with AI cleanup (A4 + A44); 3WM exception queue (A5).
- **Device profile**: Desktop.

## 3.4 Field Technician (Installer + Service Tech)
- **JTBD**: Complete the job; capture parts/work for invoicing; present the estimate; collect signature.
- **Pains**: Slow part entry; broken mobile in low-signal areas; sales theater feeling on GBB; ego-bruising surveillance optics.
- **Gains from `[PRODUCT]`**: Voice-to-parts (A4); local-first sync (A23); rotate-to-customer mode (Agent 5); 3-state pricing authority with guardrails (A50); closeout enforcement role-based (A7).
- **Device profile**: Phone primary (BYOD or rugged Android per A13/A13.A); occasional tablet for Customer Present Mode.

## 3.5 Counter / Shop Staff
- **JTBD**: Receive vendor deliveries; pick parts; serve walk-in customers; handle returns.
- **Pains**: Manual receiving; ad-hoc returns; cash drawer not synced.
- **Gains from `[PRODUCT]`**: Scan-driven receiving with OCR (A4 + A31); Counter-Shop Kit hardware (refer-only A13); Stripe Terminal for in-person (A19).
- **Device profile**: Desktop + tablet at counter; rugged scanner.

## 3.6 Subcontractor / 1099 Tech `[A16]`
- **JTBD**: Execute assigned jobs; submit time/parts; get paid.
- **Pains**: Don't trust software that exposes other techs' margin; need restricted scope.
- **Gains from `[PRODUCT]`**: `subcontractor_tech` RBAC role with restricted scopes (no margin, no other techs' jobs, no price book edit) and cost-rate override.
- **Device profile**: BYOD.

---

# 4. Trade Coverage Strategy

## 4.1 Trades Supported at Launch (15)

All 15 trades the research covers ship trade templates at GA `[A1, A52]`:

| Trade | Template Priority | Asset Subtypes | Notable Compliance |
|---|---|---|---|
| Locksmith | High (Emanuel) | Opening (cylinder/IC), Customer Key System | NASTF VSP, state licenses (TX/NJ/NC/NY/IL) |
| Door (commercial + residential) | High (Emanuel) | Opening (hardware set, fire rating) | AAADM, IDEA, wind-load |
| Electronic Security | High (Emanuel) | Panel, Controller, Reader, Credential | UL 294, BICSI, low-voltage state |
| Garage Door | High (Emanuel adjacent) | Opening + Spring Spec + Opener | DASMA, IDEA, wind-load |
| HVAC | Standard | Equipment (refrigerant, AIM Act flag) | EPA 608 (cert + cylinder log), AIM Act |
| Plumbing | Standard | Equipment + Backflow Assembly | ASSE, permits |
| Electrical | Standard | Panel + Wire (per-foot) | NEC version, state contractor |
| Fire & Life Safety | Standard | Sprinkler Riser, Fire Panel, Extinguisher | NFPA 72/25/10, NICET, UL 827 |
| Appliance | Standard | Appliance (model/serial/warranty) | OEM warranty workflow |
| Pest Control | Standard | (chemical lot/applicator-cert) | FIFRA, EPA applicator |
| Pool/Spa | Standard | Pool Body (chemistry + dosage) | PHTA CPO |
| Landscape | Standard | Route + Irrigation Zone | NALP |
| Roofing | Standard | Roof Section (squares + measurement) | Local licensing |
| Cleaning | Standard | (site sqft + crew + checklist) | OSHA HazCom |
| Handyman | Light | (minimal) | Light |

## 4.2 Trade Template Depth at Signup `[A52]`

Each template includes:
- **Categories** (e.g., Lockout, Rekey, Install for locksmith)
- **10-15 starter service name placeholders** (name only, no prices; user activates and prices)
- **Default agreement types** (maintenance, monitoring, inspection contracts as applicable)
- **Technician credential types** (NASTF VSP, AAADM, EPA 608, NICET, etc.)
- **Custom field definitions** for the trade's Asset subtypes
- **Default vendor routing** (generic CSV/EDI v1, named partnerships in P2)

Total content authoring: ~200 placeholders + 15 structure configs = 1-2 weeks for Emanuel + AI assist.

## 4.3 Schema Strategy: Universal + Typed Extensions `[A1, A6, Agent 11]`

The base schema is trade-agnostic (Customer, Site, Asset, Job, Estimate, Invoice, Item, Vendor, PO). Trade-specific quirks live in **typed extension tables** attached to Asset subtypes (Opening, Panel, Equipment, Appliance, etc.) and item attribute sidecars. New trade onboarding = add subtype + configure custom fields + no migration.

---

# 5. Inventory Module — Functional Requirements

## 5.1 Data Model Summary (full DDL in Appendix A)

Core entities: `item`, `item_variant`, `unit_of_measure`, `inventory_location`, `stock_balance`, `stock_movement` (immutable ledger), `serial_number`, `lot` (schema v1, UX P2), `item_attribute_definition`, `item_attribute_value`, `asset` + subtypes.

**`[PROTOTYPE v1.1]` field additions:**
- `item.photo_url text` — S3 URL of a single primary photo; multi-photo gallery is P2.
- `item.deleted_at timestamptz` — soft-delete already in §A.3, surfaced now in delete UX with audit-log entry on every change.
- `vendor.pickup_address text` (§7.6) — vendor's will-call / pickup location; powers staging UX.

## 5.2 Core Workflows

### 5.2.1 Warehouse
- Multi-location: Organization → Branch → Warehouse → Bin (sub-location) `[A26]`.
- Receiving: scan barcode → confirm qty → photo of packing slip → putaway → posts `stock_movement` (type=receive).
- Pick: search/scan item → reserve → mark picked → posts `stock_movement` (type=transfer).
- Counts: micro-count of 5 bins per session default; whole-warehouse counts as deliberate workflow `[A27]`. Variance generates `stock_movement` (type=adjust) with reason code.

### 5.2.2 Truck Stock
- Each tech has dedicated truck location by default; tenant can configure multi-tech-per-truck `[A23]`.
- Tech consumes from authorized locations only (RBAC `authorized_locations[]`) `[A22]`.
- Truck stock starts at 0 — established via transfer from warehouse OR receive direct from vendor.
- Replenishment: min/max thresholds + AI-suggested reorder (Phase 2 P1).

### 5.2.3 Transfers
- Truck-to-truck: nearby tech availability shown with ETA + distance; transfer request action.
- Auto for non-serialized items; require-approval for serialized `[A59.12]`.
- Source posts `stock_movement` (type=transfer_out); destination posts `stock_movement` (type=transfer_in).
- Conflict UX in field language; never silent overwrite `[Agent 5]`.

### 5.2.4 Consumption (Use Part on Job)
- Tech opens Job → "Use part" sheet → quantity-first UX with +/- → optional serial capture → save.
- Job cost timing: at consumption `[A46]`.
- Local-first immediate balance display; server reconciles + may return conflict (`inventory_conflict` 409).
- Voice-to-parts as alternate entry path (AI A4): "two filters, one capacitor" → parser → catalog match → confirm.

### 5.2.5 Returns (Customer to Truck/Warehouse)
- Explicit post-job states: Return to truck / Return to warehouse.
- Owed-core badge tied to vendor + due date, surfaced on home screen + job closeout `[Agent 5]`.
- Posts `stock_movement` (type=return).

### 5.2.6 Cycle Counts
- Micro-counts of 5 bins (Agent 5 pattern) default.
- Tech UX: prompt → scan bin label → scan each item → confirm count → variance auto-posts adjustment.
- Cycle count prioritization (deterministic risk scoring, Phase 2 AI P0): high-volatility items + high-value items + items long-untouched surface first.

### 5.2.7 Serialized Items
- Forced serialization for: security panels, controllers, NVRs, HVAC equipment, appliance equipment, garage door openers, fire panels, pool equipment, hosted-license seats `[A28]`.
- Each serial has lifecycle: `in_stock` / `transferred` / `installed_at_asset` / `returned` / `core_returned`.
- Install action binds serial to Asset (Agent 11 pattern).

### 5.2.8 Kits / Bundles
- `catalog_item` with `kind='bundle'` + `catalog_item_component` children (Agent 3).
- Bundle consumption decomposes to component consumption.
- Bundles preserved at job-level edits (Workiz pattern, Agent 2) — master not mutated.

### 5.2.9 Cores
- `core_deposit_returnable_flag` + `core_deposit_amount` on item `[A59.14]`.
- Schema v1; UX Phase 2.

## 5.3 Mobile Inventory Workflows (per Agent 5)

- "Find part" bottom sheet as canonical entry point with **Have on truck / Nearby truck / Shop / Order** result categories.
- Action-oriented result cards (Use part / Request transfer / Reserve / Create PO).
- One-handed thumb-reachable; 48-56dp button heights; high-contrast light + dark modes; glove-mode auto-enabled on rugged profiles.
- Barcode scan default: native VisionKit (iOS) / ML Kit (Android); Bluetooth scanners as first-class (Socket S720, Zebra CS6080).

## 5.4 Admin/Owner Inventory Workflows

- Web admin: bulk item import (CSV + AI categorize), bulk price update (CSV + rules + AI cleanup + simulate-before-publish), warehouse setup, location config, RBAC roles + authorized_locations.
- Reports: turn rate, stockout frequency, shrinkage, valuation, location-by-location, tech-by-tech consumption.
- Cycle count scheduling.

### 5.4.A `[PROTOTYPE v1.1]` Inventory list UX (locked from prototype)

Locked patterns from the /dashboard interactive prototype that engineering should build to:

- **Single inventory page** with CRM shell: left nav has two top-level rows (Dashboard · Jobs · Customers · **Inventory** · Estimates · Reports) PLUS top search bar. **Inventory is a collapsible parent group** with **four nested children rendered in this exact order: Inventory · Price Book · Purchase Orders · Vendors** (rev 2026-05-27). Children render with a left-edge vertical guide line and slightly smaller type to make the hierarchy obvious. Inventory defaults to expanded so the structure is discoverable on first load. Chevron rotates 90° to indicate state. **Clicking the parent label routes to the first child** (`Inventory`) so the parent click always lands on the dashboard, never on the secondary Price Book page. Clicking the **chevron** toggles expand/collapse without routing. The parent **Inventory** row stays visually active when the current route is any of the four children — same pattern as VendorsPage (rev 2026-05-27, §7.6.A). Sub-items can carry their own badges (e.g. Purchase Orders shows the open-PO count). Full sidebar IA spec in §5.4.A.viii.
- **View tabs at the top of Inventory**: `Items` (default) and `Staging` (count + green "N ready" highlight badge when stages are ready-for-pickup). Staging spec in §7.4.A.
- **4 KPI tiles** in the Items view header: Active SKUs · Low Stock · Backorder · Inventory Value (at unit cost, all locations).
- **Action bar** in the page header: `Scan QR/Barcode` · `Restock` (emerald) · `Transfer` · `Import CSV` · `Export` · `+ Add Item` (primary indigo).
- **Location selector** (single dropdown, replaces tab strip): shows the active location + branch + tech + vehicle context; click opens a popover listing every location with per-location item counts + a footer **"+ Add Location / Van"** action that opens the AddLocationDialog.
- **Category selector (rev 2026-05-27):** sits immediately to the right of the Location selector in the "Showing" row — a second pill labelled **"All Categories"** (or the active category name) with a small *"N categories configured"* subtitle and a live count badge of items matching. Click opens a portal-free popover with a sticky **All Categories** reset row, a scrollable preset list of every `Category` record (name · 9px description · indigo highlight + ✓ check when active), and a pinned indigo **"+ Add new category"** footer button that opens the existing `AddCategoryDialog`. On save → the new category is appended to `allCategories`, auto-selected as the active filter (single-select model: replaces any prior category selection), and a *"✓ Category 'X' added — now filtering"* toast fires. The category filter feeds the same `Filters` shape used by the kebab-Filters popover — a new `filters.categories: string[]` field — so any category picks made via the right-side **Filters** popover stay in sync with the Showing-row pill. A unified **"Clear filter"** link appears next to both pills whenever either is non-default and resets both `activeLoc → "all"` and `filters.categories → []` in one click. Rationale: counter staff frequently want to scope the items list to *"just cylinders"* or *"just access-control hardware"* — pre-rev they had to open the Filters popover, scroll to Categories, click. Post-rev it's one click + always visible alongside Location.
- **Category selector — inline Edit + Delete per row (rev 2026-05-27):** each category row in the dropdown carries two hover-revealed icon buttons on the right edge — **✏ Edit** and **🗑 Delete** — gated by `canManageLocations(currentUser.role)` (same admin check used for Locations). Per-row item-count badges were **removed** in this rev because the operator clicks the row to see the items anyway, and the static numbers were adding visual noise to a frequently-scanned list; the trigger pill + the sticky All-Categories reset row still surface the totals for at-a-glance scope.
  - **Edit (✏)** opens the existing `AddCategoryDialog` in edit mode (new `editCategory` + `onUpdate` props): the title becomes *"Edit Category · &lt;Name&gt;"*, the subtitle reads *"Rename or update the description. The new name propagates to every item in this category."*, the primary button label flips to *"Save Changes"* (pencil icon). On save, the category record is updated in `allCategories` AND every `Item` with `i.category === oldName` is patched to the new name so the items table stays consistent (no orphaned "Uncategorized" rows). If the active filter was pointed at the renamed category, the filter follows the rename. Toast: *"✓ Category renamed: 'Old' → 'New'"* when the name changed, otherwise *"✓ Category '&lt;Name&gt;' updated"* for description-only edits.
  - **Delete (🗑)** is blocked when any items still carry the category — a *"⚠ '&lt;Name&gt;' can't be deleted — N item(s) still in this category. Re-categorize them first."* toast fires and nothing is removed (deliberate guardrail against orphaning items). When the category has zero items, a `confirm("Delete category '&lt;Name&gt;'? This can't be undone.")` prompt fires; on accept, the category is removed from `allCategories`, and if it was the active filter the dropdown resets to All. Toast: *"🗑 Category '&lt;Name&gt;' deleted"*.
  - **Non-admin view (`canManage = false`)** — the Edit/Delete icons don't render at all. Field techs see a clean view-only list and can still pick a category to filter their items table.
- **Search + Filter strip**: SKU / name / category / vendor / UPC / MPN search + a `Filters` button that opens a popover with 5 multi-select sections — Trade, Item Kind, Stock Status (in-stock / low / out / backorder), Vendor, Flags (Serialized / Hazmat). Active filters surface as a chip strip below the search row with individual remove buttons + Clear all.
- **Items table** columns: checkbox · SKU · Item (with **36×36 photo thumbnail** + trade/serialized/hazmat/backorder chips) · Category · On Hand (low-stock warning icon if below per-location min) · Reserved · Available · Unit Cost · Locations breakdown chips · row-level kebab menu.
- **Location-scoped numbers**: when the active location filter is set to a specific warehouse/van, the On Hand / Reserved / Available cells **switch to per-location numbers** (not cross-location totals); the "Locations" column header relabels to "Also at" and the active location is hidden from the chips. Filter excludes items with 0 on-hand at that location.
- **Right detail panel** (slides in when a row is selected): item photo header (56×56) · SKU + name + trade/category chips · per-location stock table with min thresholds · serial numbers · recent stock movements timeline · action buttons: **Restock** (emerald primary) · **Transfer** (indigo) · **Edit** · **Delete** (rose icon).
- **Add Item dialog** must include: photo upload + camera capture (`<input type="file" accept="image/*" capture="environment">` for mobile camera), SKU (with AI Suggest button), vendor dropdown with inline "+ Add new vendor", item name, trade, category dropdown with inline "+ Add new category", item kind, UoM, unit cost, sell price (with live GM% badge), serialized + hazmat toggles, optional **starting stock + reserve levels** per location (see below). **All fields visible without inner scroll on standard desktop (≥1280×900).**
- **Required-fields rule** (rev 2026-05-26): **Item Name is the only mandatory field** in the Add Item dialog — only it carries the rose `*` indicator. SKU is optional; placeholder reads *"Auto-generated if blank"*; on save with no SKU the system auto-generates one via the `ITM-<NAME-SLUG>-<RAND>` pattern (e.g. `ITM-MUL-T-LOCK--742`) using the same algorithm as the AI Suggest button. Unit Cost is optional and defaults to `0` when blank (first Restock writes the real cost; weighted-avg costing kicks in from the first receive). Rationale: lowest-friction onboarding — ops can catalog items by name first, codes/costs settle later; matches the anti-mandatory-fields stance vs ServiceTitan (§4.3 VoC).
- **Trade-agnostic Add Item form** (rev 2026-05-26): the Trade dropdown has been **removed** from the Add Item / Edit Item dialog because this CRM is for **all trades** by design — per-item trade classification adds friction without payoff. Category dropdown spans 2 columns (filling the slot Trade vacated) and lists all categories flat — no per-trade grouping, no "Other trades" optgroup. Data model: `Item.trade` defaults silently to `"general"` so downstream PO/Staging/Approval/Tech UIs that reference trade (via job/tech context — NOT inventory classification) keep working. See changelog entry "Inventory UI is trade-agnostic" for the full sweep across InventoryPage, FiltersPopover, AddCategoryDialog, ImportCSVDialog, CSV export.
- **Starting Stock + Reserve Levels** section in Add Item dialog (4 inputs in one row):
  - **Location** dropdown (any inventory_location).
  - **Starting Qty** — initial on-hand at that location; posts an immutable `stock_movement` (type=receive) on save. Optional — can be 0 (item is catalogued but not yet stocked).
  - **Min · Reserve** *(amber-tinted to visually highlight as the par level)* — the always-on-hand reserve target. Writes to `stock_balance.min_qty` at the location. Drives the **low-stock ⚠ badge**, the Low Stock KPI tile count, and the Low Stock filter chip. Optional but strongly encouraged.
  - **Max · Reorder Cap** — ceiling for auto-replenish suggestions. Writes to `stock_balance.max_qty`. Caps Phase 2 demand-forecasting recommendations. Optional.
  - **Independent of qty**: user can set min/max without setting a starting qty — the threshold takes effect immediately as soon as any stock arrives via Restock / Transfer.
  - **Per-location** in v1.1: sets reserve for one location at a time. Phase 2 adds a "Set min for every truck" bulk action (e.g. *"keep 4 capacitors on every van"*).
- **Edit Item dialog** = same form, pre-filled from the item, Starting Stock block hidden (stock changes go through movements/transfers/restock — never direct quantity edit). Title: "Edit Item · `<SKU>`". CTA: "Save Changes".
- **Restock dialog** posts `stock_movement` (type=receive) and increments on-hand. Source selector pill: `vendor_po` / `manual_receive` / `customer_return` / `counted_in` / `truck_return`. Reference field is required for vendor_po (PO #), manual_receive (slip #), customer_return (Job/RMA #). Live preview shows `<location> <current> → <new>` on hand + total cost.
- **Truck-return source-van picker** (rev 2026-05-26): when `source = truck_return`, the dialog renders a required **"From which van"** dropdown listing every Truck-type location with primary tech + **live per-item on-hand count** per option (e.g. *"🚚 Mike's Van · Mike Alvarez · 4 on hand"*). The current destination is auto-disabled in the list (a van cannot be returned to itself). On submit, the parent's `handleRestock` posts the symmetric movement — destination credited AND source van decremented (floored at 0) in the same state update; the confirmation toast names the van. Schema: `stock_movement` rows for truck returns carry `from_location_id = <van>` + `to_location_id = <warehouse>`, paired as `transfer_out` + `transfer_in` (same pattern as Transfer dialog). RestockDialog accepts a live `items` prop so the picker's on-hand badges reflect successive receives without remount.
- **Transfer dialog** posts paired `stock_movement` (transfer_out + transfer_in). Item picker, From / To location with live on-hand context (tech + vehicle for trucks), qty + Max button, reason dropdown, serialized-item approval warning.
- **Add Vendor / Add Category / Add Location** all open as nested modals on top of Add Item, with `lockEscape` so the parent dialog ignores Esc while the child is open. On save, the new entity is added to the org-scoped list AND auto-selected in the parent dropdown. Toast confirms.
- **KPI tiles are toggle-filters**: Active SKUs · Low Stock · Backorder · Inventory Value each act as a one-click filter. Tile shows indigo ring + "filtered" badge when active. The three stock-state tiles are mutually exclusive (clicking one swaps the active state); trade/vendor/flag filters still stack independently.
- **Right detail panel is hidden by default** — no empty-state placeholder. Renders only when an item is selected, with a `panel-slide-in` 180ms ease-out animation. Closes on the `×` button in its header or by selecting a different row.
- **Stock-state filter is location-aware**: when both a stock-state filter (Low Stock / Out of Stock / Backorder / In Stock) AND a specific location are active, the stock check evaluates against THAT location's stock row (`onHand`, `min`, `reserved`) — not cross-location totals. Items healthy at one location but low at another don't show up under the location they're healthy at. The location filter is also more permissive when Low Stock or Out of Stock is active — it includes items with 0 on-hand at the location (they're the worst offenders and must be visible).
- **Count text adapts** to the active filter combo: *"15 of 15 items"* (none) → *"1 low-stock item at Main Warehouse"* (low + location) → *"3 backordered items"* (backorder only).

### 5.4.A.i `[PROTOTYPE v1.1]` Low-Stock Health by Location grid

Rendered between the Showing dropdown and the search row, **only when the Low Stock filter is active**. Auto-hides on filter clear.

- One card per `inventory_location`. Each card is clickable to drill the items table into that location.
- **Severity rules** (computed from per-location `stock_balance.min_qty` vs `on_hand_qty`):
  - 🟢 **Green** ("healthy") — no items below min at this location
  - 🟡 **Yellow** ("watching") — 1+ items below min, all ≥ 50% of min (mild reorder due)
  - 🔴 **Red** ("critical") — ≥ 1 item < 50% of min (refill immediately)
- Card content: top accent strip in the severity color · location icon + name · big count of items below min · critical sub-count if any (`N critical (< 50% of min)`) · worst-offender hint (`Worst: <SKU> <onHand>/<min>`).
- Empty-state per card: emerald card with *"All items at or above reserve"*.
- Header legend rollup: `🟢 N healthy · 🟡 N watching · 🔴 N critical`.
- Active card (matching `activeLoc`) gets indigo `ring-2 ring-offset-1` for clear current-selection feedback.
- **Per-card "Restock" pill** (rev 2026-05-26) — top-right corner of every card where `lowCount > 0`. Small emerald button with PackagePlus icon + "Restock" label. Click opens `BulkRestockDialog` scoped to that single location via the `filterLocationId` prop. `stopPropagation` so the card's drill-into-location click handler doesn't also fire. Healthy cards keep the severity checkmark in the same corner. (Container outer element switched from `<button>` to `<div>` to allow the nested pill button — button-inside-button is invalid HTML.)
- **Global "Restock All Low Stock · by Location" button** (rev 2026-05-26) lives in the Showing row above this grid, visible only when the Low Stock filter is active — opens the same `BulkRestockDialog` with no location scope (every below-min item across every location).

### 5.4.A.ii `[PROTOTYPE v1.1]` Edit Location (admin-gated)

- **Affordance**: pencil icon on each row in the Showing dropdown popover. Hidden by default, shown on row hover (`group-hover:opacity-100`) AND only rendered when the current user role passes `canManageLocations(role)`.
- **Permitted roles** (locked v1.1, extensible in admin RBAC settings): `owner`, `admin`, `warehouse_manager`, `inventory_admin`. Non-admin roles see the dropdown but no pencil icons + no admin hint footer.
- **Footer hint** in the popover when admin: *"🛡 Admin · hover any location to edit"* — so the affordance is discoverable without hovering every row.
- **Edit dialog** reuses `AddLocationDialog` with an `editLocation` prop (same pattern as Edit Item). Title flips to *"Edit Location · `<name>`"*. Subtitle: *"Change tech assignment, vehicle, branch, or rename. Stock at this location is preserved."* CTA: *"Save Changes"*.
- **Editable fields**: type (Truck/Van/Warehouse/Counter/Staging — allows reclassification), name, branch, primary tech, vehicle.
- **Immutable**: `id` of the location (so all `stock_balance` + `stock_movement` FK references stay valid); stock quantities (those still go through Transfer/Restock as immutable ledger entries per §5.2.1).
- **Audit log**: every location update writes an `audit_log` entry with `action='location.updated'`, `before_json` + `after_json` capturing the field-level diff.
- **Cross-references update live**: Showing dropdown trigger · location stock health grid · "Also at" chips in items table · Recent Stock Movements timeline in detail panel · Transfer dialog From/To picker — all reflect the new name/tech immediately.

**Centralized role-check helper** (locked):

```ts
// data/current-user.ts — populated from auth context in production
export function canManageLocations(role: UserRole): boolean {
  return ["owner", "admin", "warehouse_manager", "inventory_admin"].includes(role);
}
export function canEditCatalog(role: UserRole): boolean {
  return ["owner", "admin", "office_admin", "inventory_admin"].includes(role);
}
export function canDeleteCatalog(role: UserRole): boolean {
  return ["owner", "admin", "inventory_admin"].includes(role);
}
```

All admin-gated UI in v1.1 reads from these helpers — so when RBAC settings ship in Phase 2, there's one place to swap the static check for a `useCurrentUser()` hook or DB-backed role-permission lookup.

### 5.4.A.iii `[PROTOTYPE v1.1]` Branch as a managed entity

- Branch is no longer free-text on `inventory_location.branch`. It's a first-class row in the new `branch` table (Appendix A.1) with `code`, `address`, `phone`, `manager_name`, `timezone`, `notes`.
- Inside the Add/Edit Location dialog, **Branch** is rendered as a dropdown of every org branch with an inline **"+ Add new branch…"** option AND an icon-only **"+"** button next to the picker (same component pattern as Vendor / Category / Location).
- The nested AddBranchDialog captures: **name** (required) · **code** (3–6 char short identifier shown in chips) · address · phone · branch manager · **timezone** (dropdown of US timezones, defaults to `America/New_York`) · notes. Opens with `zIndex={60}` over the parent location dialog; parent gets `lockEscape` while the child is open. The **address** field uses the shared `<AddressAutocompleteInput>` component spec'd in §11.1.A (Google Places API typeahead) — picking a suggestion auto-fills the structured `address_components jsonb` companion column on `branch` `[SPEC-ONLY v1.1 — prototype keeps plain text input until Google billing is enabled]`.
- After save, the new branch is added to the org-wide list and **auto-selected** in the parent dropdown. Toast: *"✓ Branch '<name>' added — selected for this location"*.
- 3 seeded branches at GA per trade-template defaults: `Brooklyn HQ · BHQ`, `Queens Branch · QNS`, `Bronx Branch · BX` — replaceable by tenant during onboarding.
- **Branch chip pattern**: any branch reference in the UI displays as `<name> · <code>` (e.g. "Brooklyn HQ · BHQ") so the short code is always visible for at-a-glance recognition in dense rows.
- Branch deletion is `[DEFERRED]` to admin settings (Phase 2) — for v1.1 a branch with linked locations / techs / POs can't be removed via this dialog.

### 5.4.A.v `[PROTOTYPE v1.1]` Stock-Out Approvals (field-tech sign-off workflow)

**Problem solved:** Field techs scan parts out of their van on-site (consume on job · return to warehouse · write-off · transfer in) — but managers + logistics need a moment of sign-off **before** the stock_movement actually posts. Today this lives in tribal trust + after-the-fact reconciliation; v1.1 makes it a first-class queue.

#### 5.4.A.v.1 Data model

```sql
stock_action_approval (id uuid PK, organization_id uuid FK,
                       requested_at timestamptz, requested_by_user_id uuid FK app_user(id),
                       action_type action_type_enum,   -- consume_on_job · return_to_warehouse · writeoff · transfer_to_van
                       item_variant_id uuid FK, catalog_item_id uuid FK,
                       qty numeric(18,6), uom_id uuid FK,
                       from_location_id uuid FK inventory_location(id),
                       to_location_id uuid NULL FK inventory_location(id),
                       job_id uuid NULL FK job(id),
                       reason text,
                       serial_captured text NULL,
                       photo_url text NULL,
                       status approval_status_enum,    -- pending · approved · rejected
                       reviewed_at timestamptz NULL, reviewed_by_user_id uuid NULL,
                       review_comment text NULL,
                       posted_movement_id uuid NULL FK stock_movement(id),  -- set after approve
                       created_at)
-- ix_approval_pending (organization_id, status) WHERE status = 'pending'
```

#### 5.4.A.v.2 Flow

1. Field tech scans a part on their phone (ScanDialog → see §5.4.A.vi).
2. After match, the dialog shows role-aware actions. Tech sees **"Take out from van · request approval"** as the primary stock-out path; admin / logistics sees **"Add stock (Restock)"** as a direct action without queueing.
3. Picking the tech path creates a `stock_action_approval` row with `status='pending'` — **no `stock_movement` posts yet**. Stock balances unchanged until approval.
4. Approver (role passes `canApproveStockActions`) reviews the queue in the **Approvals** tab. On approve → server posts the `stock_movement` (consume / transfer / writeoff per `action_type`), updates `stock_balance`, and links it on `posted_movement_id`. On reject → row marked `rejected` with required comment; balances untouched.

#### 5.4.A.v.3 RBAC (locked v1.1)

- **Submit approval request**: any role with `inventory.stock.consume` (default for `field_technician`, `subcontractor_tech`).
- **Approve / reject**: `owner`, `admin`, `warehouse_manager`, `inventory_admin`, `purchaser`.
- **Auto-approve (skip the queue)**: same approver-role set can also use **"Add stock (Restock)"** directly from scan or via the Restock button — those don't queue.
- Centralized helper: `canApproveStockActions(role)` in `data/current-user.ts` (see §11.7 pattern).

#### 5.4.A.v.4 Approvals tab UX

A third top-level view tab alongside Items + Staging, surfaced with an amber **"N pending"** highlight badge next to the count when any approvals are pending.

- 4 stat tiles at the top: **Pending · Approved Today · Rejected · Total**. **All 4 are clickable as toggle filters** — same UX as the Inventory KPI tiles (§5.4.A): the active tile gets an indigo ring + "filtered" badge, hover gets a subtle shadow. Clicking is equivalent to picking the matching pill in the FILTER row below; state stays in sync between both surfaces.
- Filter pill row: Pending / Approved / Rejected / All (counts).
- Each **card is a click-target** (no inline expand) — opens the **Approval Detail Dialog** (§5.4.A.v.4a) for full transaction context. Compact card surface shows:
  - Action-type chip (colored — consume=indigo, return=emerald, writeoff=rose, transfer=sky)
  - SKU code chip · qty + UoM · item name · status chip
  - Requester tech name · from-location · to-location (if applicable) · job # + customer (if applicable) · timestamp
  - Hover affordance on the right: *"Open full transaction →"*
- Approve action (from detail dialog) → posts the stock_movement, transitions to `approved`, toast: *"✓ Approved {qty} × {sku} · stock movement posted"*.
- Reject action → requires inline comment (rose-tinted input inside the detail dialog), transitions to `rejected`, toast.
- Non-admin viewers (e.g. dispatcher) see the queue but can't approve — Approve/Reject buttons hidden, helper banner inside detail dialog: *"Your role can view but not approve. Ask a warehouse manager, inventory admin, or owner."*

#### 5.4.A.v.4a Approval Detail Dialog (locked from prototype)

When any approval card is clicked, opens a full-context modal so the approver can make an informed decision without leaving the queue:

- **Header**: `Stock-Out Request · <SKU>` + subtitle line *"Submitted by <tech name> on <full timestamp>"*.
- **Top strip**: action-type chip + status chip + request ID + timestamp.
- **Three-column overview** below the strip:
  - **Item card** — photo thumbnail (or icon if none) · SKU code · full name · trade + category chips · unit cost · vendor.
  - **Movement Request card** (indigo tint) — big qty number + UoM · *≈ value* (qty × unit cost) · from-location with truck icon · to-location with map-pin icon (if applicable) · serial captured (mono-font, if any).
  - **Requested By card** — tech initials avatar · name · role · branch · vehicle · full **certifications** list (chips). This is the moment the approver verifies the tech has the right credentials for the job they're consuming on (e.g. NASTF VSP for restricted locksmith parts, EPA 608 for refrigerant draws).
- **Job Context strip** (emerald) — Job # · Customer · Site · Scheduled For (with weekday/time). "Open Job →" link to jump to the job record (Phase 2 deep-link to dispatch UX).
- **Tech's Reason** — italicized quote block of the requester's free-text reason.
- **Decision audit** strip (visible only when already approved/rejected) — approver name · decision timestamp · review comment quote.
- **Modifications** strip (rev 2026-05-27, visible only when `approval.modifications` is non-empty) — chronological list of in-place edits made to the request via the Edit affordance (see below). Each entry renders as `<short timestamp> — <name> edited <diff summary>` with a small amber **post-decision** pill when the edit landed after the request was approved or rejected. Sits immediately below Decision Audit so the lifecycle reads top-to-bottom.
- **Approval Note** (optional) input visible when pending + canApprove — gives the approver a place to leave a confirmation note (e.g. *"Confirmed serial match with customer"*) that's persisted with the audit log.
- **Rejection mode** — clicking Reject swaps the bottom row for a required `<textarea>` titled *"Rejection Reason (required) — the tech sees this"* + a red "Confirm Reject" CTA. Cancel returns to view mode.
- **Footer** in pending view-mode: Close · **Email Team** (outlined indigo, Mail icon) · Reject · **Approve · post movement** (emerald primary). In rejection mode: Cancel · **Confirm Reject** (rose primary). In **edit mode** (rev 2026-05-27): Cancel · **Save Changes** (indigo primary, disabled until at least one field has changed and qty is valid).
- **Email Team flow** (rev 2026-05-26): clicking Email Team opens `ApprovalEmailDialog` nested at `zIndex={80}` with `lockEscape`. Composer derives recipients from the requester tech's branch: pre-selects the warehouse_lead at that branch (fallback chain: branch manager → `approvals@` alias) and exposes quick-add chips for the full approver pool + requester FYI. Subject `Stock-Out Approval Needed · <SKU>` (+ `· Job <#>` if linked). Multi-section body covers type · item · qty/value · from/to · serial captured · job context · tech's reason · deep link `/approvals/<id>`. PDF attachment chip `approval-request-<id>.pdf` is auto-generated from the live request. On send, the parent ApprovalsView toasts `📧 Approval request emailed to N recipient(s) · <emails>`. Send is mocked in v1 prototype — real wiring uses `POST /approvals/<id>/email` against the org's SMTP or a delivery service.
- **Edit affordance — in-place edit of a stock-out request** (rev 2026-05-27): the modal header now carries an opt-in **`✏️ Edit`** button (left of the X) wired through the shared `<Modal editAction>` prop. Visibility is gated by a new `canEditApproval(approval, user)` helper in `current-user.ts`: admin-tier roles (`owner` / `admin` / `warehouse_manager` / `inventory_admin`) see Edit unconditionally; the original submitter sees it only while `status === "pending"`. Clicking Edit captures the live approval into a local `draft` and the header pill swaps to an amber **`✏️ EDITING`** badge so the modal's dirty state is unmistakable from across the screen. The following fields swap from display to inputs (everything else stays locked):
  - **Qty** (Movement Request card) — typed number input, rose-bordered when ≤ 0, indigo otherwise; the *≈ value* preview underneath recomputes live against the draft qty so the approver sees the new dollar impact in real time.
  - **Destination Location** (`toLocationName`) — free-text input on the same arrow-and-mappin row; renders blank when the original was empty so the operator can add a destination after the fact (e.g. for a write-off that turned into a return).
  - **Serial captured** — mono-font input in the same card, placeholder `e.g. HES-A8821`. Renders even when the original had no serial so a missed scan can be backfilled.
  - **Job #** and **Customer** (Job Context strip) — text inputs (mono for the job #) inside the emerald-bordered strip; both can be filled in even if the original request had neither, which causes the Job Context strip to render in edit mode regardless.
  - **Tech's Reason** — textarea (2 rows), placeholder *"Describe what / where / why"*; renders even when the original had no reason.
- **Edit-mode banner** — an amber callout sits above the (hidden) approve/reject controls: *"Editing this request. Use **Save Changes** below to commit, or **Cancel** to discard."* When `status !== "pending"` it appends: *"This request was already &lt;status&gt; — edits will be marked **post-decision** in the audit log."*
- **`lockEscape` engages while editing** so a stray Esc keystroke can't wipe pending changes; the X (and Cancel on the footer) clear the draft.
- **Save flow** — Save Changes is disabled until at least one field differs AND `qty > 0`; tooltip explains the block (`"No changes to save"` / `"Quantity must be greater than zero"` / `"Save changes — will be logged as post-decision edit"` when status is non-pending). On click, the dialog computes a per-field diff (`diffDraft`) into both a `patch: EditablePatch` and a human-readable `summary: string[]` (e.g. `["qty 1 → 2", "dest → Carlos's Van"]`), appends a new `ApprovalModification` entry (`{ at: now, byName: currentUser.name, note: summary.join(", "), postDecision: status !== "pending" }`) onto the existing modifications array, and emits `onEdit(id, patch)` up to `ApprovalsView`. The parent's `applyEdit` merges the patch into its `approvals[]` state and toasts: `✏️ <SKU> updated · <diff>` for a pending-state edit, `✏️ <SKU> edited after decision · audit logged (<diff>)` for a post-decision edit.
- **Audit trail** — `StockApproval` gains an optional `modifications?: ApprovalModification[]` field (`{ at: ISO timestamp, byName: string, note: string, postDecision: boolean }`); the Modifications strip in the dialog body renders the running history. Post-decision edits are never silenced — they always show up with a visible amber pill so a reviewer can tell *what* changed *when* and *whether the decision was already on the books*.
- **Reusable Modal pattern** — `Modal.tsx` exports a new `ModalEditAction` type and an `editAction?: { onClick, visible?, editing?, label?, title? }` prop. When `visible !== false && !editing` it renders the Edit button; when `editing` it renders the EDITING pill. Existing modals that don't pass the prop are unchanged. The same hook will land in the remaining read-only detail dialogs (`StagePreviewDialog`, `POPreviewDialog`, `EstimateComparisonDialog`) in a follow-up — `StageDetailDialog` is already-edit-mode for in-progress stages (§7.4.A.6) so it doesn't need a separate Edit button.
- **Production wiring**: `applyEdit` is mocked in the v1 prototype against in-memory state. Real backend writes through `PATCH /approvals/<id>` against the editable subset (`qty`, `reason`, `job_number`, `customer`, `serial_captured`, `to_location_name`) and appends each row to `approval_modifications` (`approval_id`, `at`, `actor_id`, `note`, `post_decision boolean`) — a new audit table joined into the existing `audit_log` rollup so the request's lifecycle stays queryable end-to-end.

#### 5.4.A.v.4b `[PROTOTYPE v1.1]` "+ New Request" entry point on Approvals page

A primary indigo **"+ New Request"** button anchors the top-right of the Approvals view header. Clicking opens `NewApprovalRequestDialog` — a focused form for back-office staff to submit an approval request on behalf of a field tech (covers the case where a tech calls in, can't scan, or where dispatch initiates a stock movement that still needs sign-off).

**Dialog spec:**

- **Action Type card grid** — 4 mutually exclusive cards, each with icon + label + 1-line hint:
  - **Consume on Job** (Briefcase icon, indigo tint) — needs a linked Job
  - **Transfer to Van** (Truck icon, sky tint) — needs a destination location
  - **Return to Warehouse** (Undo icon, emerald tint) — needs a destination location
  - **Write-off** (Trash icon, rose tint) — no destination, reason mandatory
- **Requested By (Tech)** dropdown — list of `field_tech` + `subcontractor_tech` users, **filtered by the logged-in user's role scope** (see "Role-aware field scoping" below). When a field tech opens the dialog this field is auto-locked to themselves (rendered + disabled). Branch-scoped back-office sees only techs at their own branch; global roles see all techs org-wide. Helper line shows the selected tech's branch + vehicle.
- **Item** dropdown — full material catalog with SKU + name.
- **Quantity · From Location · To Location** — 12-col grid; To Location only renders when action_type requires it (`needsTo` flag in spec). **From Location** and **To Location** options are scoped to the logged-in user's role per the matrix in "Role-aware field scoping" below: field techs see only their assigned van (locked); branch-scoped staff see other-branch locations as visible-but-disabled `<option disabled>`; global roles see everything as selectable. Lock + helper text *"🔒 Locked to your assigned van"* renders below any auto-locked field.
- **Linked Job** dropdown — only renders for `consume_on_job` action.
- **Reason** textarea — required for all types; placeholder copy varies by action.
- **Preview strip** at the bottom — live `<icon> <SKU> <qty> <UoM> → <action label> · <job#> · <customer>` so the user sees the final shape before submit.
- **Footer CTAs**: Cancel · **Submit + Email Team** (rev 2026-05-26, secondary outlined indigo with Mail icon) · **Submit for Approval** (primary indigo with Send icon).
- **Submit + Email Team flow** (rev 2026-05-26): validates the form using the same `buildRequest()` path as the Submit-only button, calls the parent's `onSubmit` (which now **returns the created `StockApproval`** so the dialog can email about it accurately), then opens the same `ApprovalEmailDialog` used by the Detail Dialog (§5.4.A.v.4a) nested at `zIndex={80}` with `lockEscape`. Approver pool is scoped to the **requester tech's branch** — a request on behalf of a Queens tech routes to Queens approvers, a Brooklyn tech routes to Brooklyn HQ. After the email is sent (or the composer cancelled), the parent dialog resets + closes. Submit-only path remains unchanged.

**Role-aware field scoping** (rev 2026-05-27):

The dialog scopes Requested By · From Location · To Location based on the logged-in user's role. Source of truth is three helpers in `data/current-user.ts` (§11.7) — `getRequesterOptions(user)`, `getFromLocationOptions(user)`, `getToLocationOptions(user, actionType)` — each returning `{ selectable, readonly }`. The dialog renders `selectable` options enabled and `readonly` options as `<option disabled>` with a muted style + 🔒 icon, so cross-scope locations are *discoverable but unusable* for branch-scoped users.

| Role tier | Requested By | From Location | To Location (Transfer-to-Van) |
|---|---|---|---|
| `field_technician`, `subcontractor_tech` | **Auto-locked to self** (rendered + disabled) | **Auto-locked to their van** | **Auto-locked to their van** |
| `warehouse_manager`, `dispatcher`, `office_admin` *(branch-scoped)* | Filtered to techs at their branch | Their branch's locations selectable · other branches render as `<option disabled>` + 🔒 icon | Same scope as From |
| `inventory_admin`, `admin`, `owner`, `purchaser` *(global)* | All techs org-wide | All locations | All locations |

**Field-tech specifics:**

- Requested By, From Location, and (when applicable) To Location each render as a single locked `<option>` with helper text *"🔒 Locked to your assigned van"* below the field — the tech is told *why*, not just *what*.
- The lock is **role-only** — there is no override permission, no admin grant that flips it off. A tech can never pull stock from another tech's van and never request a transfer into another tech's van, regardless of seniority. This is a deliberate guardrail against tech-to-tech stock laundering (a tech pulls from a coworker's van to cover a count they're short on, hiding shrinkage).
- The action card grid still shows all 4 action types (Consume / Transfer / Return / Write-off); only the *locations* and *requester* are locked. A tech can still pick any action type against their own van's stock.
- **Edge case — tech with no vehicle assigned**: if `currentUser.assigned_vehicle_id` is null (e.g. onboarding before dispatch finishes vehicle setup), the dialog renders a rose banner *"Your account isn't assigned to a vehicle yet — ask dispatch to set this up before requesting stock-out."* and both `Submit for Approval` + `Submit + Email Team` buttons are disabled.

**Branch-scoped specifics:**

- Other-branch locations are **visible-but-disabled** (not hidden) so the user has spatial awareness that the system *has* a Queens warehouse, they just can't operate against it from their Brooklyn login. Hover tooltip on disabled options: *"Queens Branch — outside your scope"*.
- The Requested By list shows only techs whose `branch_id` matches the logged-in user's `branch_id`. Helper text below the dropdown reads *"Showing techs at &lt;Branch Name&gt; (N)"* with a live count — so a dispatcher knows the list is filtered, not empty by mistake.

**Global-role specifics:**

- `owner`, `admin`, `inventory_admin`, `purchaser` see the dialog with no scoping applied — every location selectable, every tech selectable, no greyed-out options, no helper text.
- This is the only tier that can submit a request on behalf of a tech at a *different* branch than the logged-in user's own (e.g. an owner at HQ submitting on behalf of a Queens tech who called in).

**Acceptance criteria additions** (rev 2026-05-27):

- [ ] A `field_technician` logged in as Carlos Tran opens the dialog → Requested By is pre-filled "Carlos Tran" and disabled · From Location shows only "QN-9920 · Mercedes Sprinter" (his van) and is disabled · helper text *"🔒 Locked to your assigned van"* renders under each.
- [ ] A `field_technician` selects `transfer_to_van` action type → To Location is also auto-locked to their own van (cannot pick another tech's van as destination).
- [ ] A `warehouse_manager` at Brooklyn HQ opens the dialog → From Location lists Brooklyn HQ's warehouse + counter + every Brooklyn-branch van as enabled · Queens Branch warehouse + Queens vans render as `<option disabled>` with the 🔒 icon and the "Queens Branch — outside your scope" tooltip.
- [ ] A `warehouse_manager` at Brooklyn HQ opens the dialog → Requested By dropdown lists only Brooklyn-branch techs · helper line reads "Showing techs at Brooklyn HQ (N)".
- [ ] An `owner` opens the dialog → no scoping applied; every location and every tech is selectable.
- [ ] A field tech with no `assigned_vehicle_id` opens the dialog → rose banner explains they need dispatch to assign a vehicle first · both Submit buttons are disabled.
- [ ] The action card grid (Consume / Transfer / Return / Write-off) is unaffected by role — all 4 action types remain selectable for every role; only the location and requester scoping changes.
- [ ] Phase-2 migration to DB-backed RBAC swaps the three helpers in `data/current-user.ts` without any change to the dialog component itself.

**After submit**:
- Creates a `stock_action_approval` row with `status='pending'`, prepended to the list (so the new request is visible at the top).
- Filter auto-snaps to `Pending` so the new entry is in view even if user was on Approved/Rejected before.
- Toast: *"📋 Approval request submitted · `<qty>` × `<sku>` · `<tech name>`"*.

**Acceptance criteria:**

- [ ] Back-office user (dispatcher / admin) can submit a Transfer-to-Van request on behalf of a field tech in <20 sec.
- [ ] Submitting a Consume request without a linked job is blocked with a clear error.
- [ ] The new request is visible in the queue the instant the dialog closes, no refresh.
- [ ] Field-tech roles can also reach this dialog (Phase 2 will replace this form with the scan-driven flow as the primary entry for techs; this dialog stays as a back-office override).

**Item picker — scan affordance** (locked v1.1):

Right next to the Item dropdown is a small **"Scan"** button (indigo-tinted icon button) that opens `ScanDialog` in **pickerMode=true**. In picker mode:
- The dialog still supports manual entry, "Start Scanning" simulator, and **"Phone Camera"** (rear camera via `<input capture="environment">`).
- The standard multi-action post-match panel is **replaced** by a single full-width CTA: **"✓ Use this item · `<SKU>`"** — that's the only thing the picker is for.
- On click → returns the matched `Item` to the parent dialog via `onMatch(item)`, closes itself, parent's Item dropdown auto-syncs.
- ScanDialog uses `zIndex=60` in picker mode so it stacks above the parent modal cleanly. Parent gets `lockEscape` while picker is open.

This pattern — **"item-picker that's actually a barcode scan"** — should be reused wherever a form asks for an item, including (future): bulk count dialog · transfer dialog · cycle count entry · vendor bill OCR review · receipt line capture. Locked component pattern: `ScanDialog pickerMode` + dropdown-with-scan-button.

#### 5.4.A.v.5 KPI tile

A 5th KPI tile **"Needs Approval"** (amber, shield icon) joins Active SKUs / Low Stock / Backorder / Inventory Value on the Items tab. Click → switches to the Approvals tab. Number is the pending count.

### 5.4.A.vi `[PROTOTYPE v1.1]` Phone-camera scan + role-aware post-match actions

- Scan dialog gains a **"Phone Camera"** button next to "Start Scanning". The button triggers a hidden `<input type="file" accept="image/*" capture="environment">` so on mobile devices it opens the rear camera directly. After image capture, a barcode-detection pass runs (BarcodeDetector API where supported, ML Kit on Android wrapper, VisionKit on iOS — same SDK stack as PRD §10.4); on desktop the input falls back to file picker and OCR.
- After a successful match, the dialog shows a **post-match action panel** with role-aware buttons:
  - **Open item details** (always) — opens the right detail panel for the matched item.
  - **Add stock (Restock)** (admin / logistics / inventory_admin / purchaser only) — opens RestockDialog pre-filled with the matched item; posts movement directly.
  - **Take out from van · request approval** (field_technician / subcontractor_tech) — submits a `stock_action_approval` row (see §5.4.A.v) and surfaces a toast routing the user to the Approvals tab.
  - **Submit as field-tech request** (admin testing helper) — same outcome as the tech path, lets admins exercise the queue for training/QA.
- The dialog header subtitle stays *"Native VisionKit (iOS) / ML Kit (Android) · Bluetooth scanner supported"* — Bluetooth wedge scanners still feed the manual entry input directly.
- **No-match → create-new auto-route**: when the scanned code doesn't resolve to any existing `item` / `item_variant` (by SKU · UPC · MPN), the no-match panel surfaces a **"✨ Create new item from this scan"** CTA that closes the scan dialog and opens the Add Item dialog with the scanned code **pre-filled as SKU** (`prefilledCode` prop). Helper text: *"Opens the Add Item dialog with `<CODE>` pre-filled · AI auto-categorize runs on save."*
- **Match → existing-item auto-route**: when the scanned code matches an existing item, the post-match action panel's primary stock-out actions (Restock for admin / Request approval for tech) operate on **that exact item** — never creates a duplicate `item` row. SKU collisions are impossible by construction because the system matches BEFORE giving the user any "create" affordance.
- **AddItemDialog `prefilledCode` prop** is locked: any caller that has a code captured externally (scan · CSV import row · vendor catalog reference) can pass it through to pre-populate the SKU field on dialog open. Edit mode (`editItem`) takes precedence over `prefilledCode` if both are set.

### 5.4.A.vii `[PROTOTYPE v1.1]` Transfer dialog — bulk-to-staging modes

The Transfer dialog now supports three modes, selected via a segmented control at the top:

1. **Single item** (default · existing behavior) — pick one item, transfer N units from one location to another. Posts paired `stock_movement` (transfer_out · transfer_in).
2. **By PO** — pick (or search) an open Purchase Order; bulk-transfer all its line items from a warehouse/counter to the job staging area. Each PO line is rendered as a checkbox row with editable qty (defaults to `qtyOrdered - qtyReceived`).
3. **By Job** — pick a Job; the dialog auto-pulls every open PO linked to that job (`purchase_order.job_id`) and shows their lines grouped by PO with the same checkbox-row pattern.

**Search affordance** in "By PO" mode: free-text input matches against PO number · vendor name · linked job number · customer name (case-insensitive `OR`). Dropdown options are filtered live; option count surfaced in the placeholder.

**Destination is implied** in bulk modes: always the job-staging area associated with the PO's or Job's `pickup_vendor_id` / `staged_location_id` (or the org's default staging warehouse if none set). The user picks only the **From Location** (limited to warehouse / counter types — vans can't be a bulk source).

**On submit (bulk)**:
- Posts one `stock_movement` (type=transfer_out) per selected line at the from-location.
- Creates OR updates a `job_stage` row for the source (PO's or Job's) — if a stage already exists, line items merge; if not, one is created.
- Toast confirms with line count + total units + destination, e.g. *"✓ Staged 3 lines · 13 units from Main Warehouse → Job Staging · PO-2305 · Equinox Hudson Yards"*.
- View auto-switches to the Staging tab so the user immediately sees their just-staged work.

**Locked field constraints**:
- Bulk modes only accept **warehouse** or **counter** locations as the source. Van-to-staging is `[DEFERRED]` to Phase 2 (use Single Item mode or the Approvals queue today).
- A bulk submission with zero checked lines is rejected with a clear error.
- Serialized items in bulk: same serial-capture-at-handoff rule applies as Single Item mode; UX shows a yellow inline note when any selected line is on a serialized item.

**Single Item destination type pills** (locked v1.1):

Inside Single Item mode, a 2-pill segmented control above the From/To row lets the user choose where the ONE-item transfer is going:

- **Location** — direct stock movement (existing behavior, default).
- **Job / PO** — routes to staging. TO field becomes a **unified cross-search picker** that queries **both** jobs and open POs simultaneously. Type `J-1850` and you get the matching job; type `PO-2305` and you get the matching PO; type a vendor name and you get POs from that vendor; type a customer name and you get both matching jobs AND their linked POs. Results are tagged with a `Job ·` or `PO ·` prefix so the kind is unambiguous.

When a result is picked, the right-side context card swaps from `LocationCard` to a **JOB STAGING** / **PO STAGING** card that surfaces the destination's job # · customer · site · scheduled date / ETA so the user has full destination context. The selected confirm pill in the search field shows `[Job] J-1850 · Rolex 5th Ave` or `[PO] PO-2305 · ADI / Anixter` so the user always sees which type they picked.

**Cross-search ranking**: results where the search query matches the entity's identifier prefix (e.g. `"J-185"` matches `"J-1850"` as prefix) bubble to the top of the list ahead of fuzzy customer/vendor matches. Limits to 30 mixed results.

**On submit (Job or PO destination)**:
- Stock is deducted from the From location (the source).
- A single-line bulk-stage-transfer is dispatched via the existing `onBulkStageTransfer` callback — same plumbing as the "By PO" / "By Job" bulk modes, just with `lines.length === 1`.
- View auto-routes to the Staging tab; toast confirms the stage entry was created/updated.

This unifies the "I just need to send THIS one part to that job" flow with the bulk "stage everything from this PO" flow under a single dialog — no separate Quick-Stage modal needed.

**Acceptance criteria:**

- [ ] Picking Job mode + selecting a job + qty + submitting creates a `job_stage_line` on that job's stage (or creates a new stage if none exists) AND deducts qty from `stock_balance` at the from-location.
- [ ] Searchable picker matches across the documented fuzzy-search fields and limits results to 30 entries.
- [ ] Closing/cancelling the dialog with a job/PO selected but no qty entered does NOT mutate any stock.
- [ ] Switching destination type mid-flow clears the prior selection (no half-stale state).

**Acceptance criteria:**

- [ ] Bulk PO transfer of a 5-line PO completes in ≤ 30 sec p95 (one click, defaults accepted).
- [ ] Stage entry shows the transferred lines as `qty_received` immediately (no separate "receive" step needed for items transferred from warehouse → staging — they're already on-hand at the org).
- [ ] Cancelling the dialog mid-flow drops all bulk selections cleanly; no stock is moved.
- [ ] Switching modes mid-flow preserves none of the prior mode's input (cleaner UX than half-stale state).

### 5.4.A.viii `[PROTOTYPE v1.1 rev 2026-05-27]` Sidebar IA — Inventory parent group + 4 children

The left-nav **Inventory** group is a collapsible parent that contains **four nested children** rendered in this exact order:

1. **Inventory** — routes to the existing `InventoryPage` (Items + Staging + Approvals tabs; full UX spec across §5.4.A, §5.4.A.i–vii, §7.4.A). Icon: stacked-boxes (Lucide `Boxes` recommended).
2. **Price Book** — routes to the new `PriceBookPage` placeholder (§6.A — coming-soon shell that points at §6.1–6.9 for eventual scope). Icon: Tag (existing).
3. **Purchase Orders** — decorative placeholder in v1; wiring follows when the dedicated PO page lands. Icon: Cart (existing). Carries the open-PO count badge.
4. **Vendors** — routes to `VendorsPage` (Directory / By Category / Spend Analytics sub-tabs; full UX spec in §7.6.A). Icon: Truck (existing).

**Click behavior:**

| Target | Behavior |
|---|---|
| Parent **Inventory** label | Routes to the **first child** (`Inventory`) — same effect as clicking the first child directly. Auto-expands the children list if it was collapsed. |
| Parent **chevron** ↕ | Toggles expand / collapse of the children list **without** routing. Chevron rotates 90° to indicate state. |
| Any child row | Routes to that child's page. Active-route highlight (indigo background + indigo left border) renders on the clicked row only. |
| Parent row visual active state | Inventory parent row stays visually lit (subtle indigo background) when the current route is **any** of the four children — so the breadcrumb / sidebar stay coherent. Same pattern as VendorsPage rev 2026-05-27 (§7.6.A). |

**Children render:** left-edge vertical guide line, slightly smaller type than parent, badge slot on the right for status counts (Purchase Orders shows the open-PO count today; Inventory could surface the Needs-Approval count or low-stock count in a future rev — out of scope this rev).

**Default app-load route:** `"inventory"` — first-time visitors land on the inventory dashboard's Items tab so the most common task (look at items / stock levels) is one paint away.

**Sub-tab default inside InventoryPage:** Items tab (existing default per §5.4.A line 347). Staging and Approvals tabs are still reachable via the in-page tab strip; the sidebar IA change doesn't alter the in-page tab UX.

**Routing plumbing** (already added in rev 2026-05-27 §7.6.A and extended here):

- `Route` union type extends to include `"inventory"` and `"price-book"` literals (in addition to `"vendors"` already added in §7.6.A).
- `Sidebar` accepts `currentRoute: Route` + `onNavigate: (r: Route) => void` props (unchanged shape — just two more route values).
- Each child `NavItem` carries a `route` field; clicking it calls `onNavigate(route)`. The parent **Inventory** row's click handler is wired to call `onNavigate("inventory")` (i.e. first child) so label-click and first-child-click are equivalent.
- The parent's active state is computed as `INVENTORY_ROUTES.includes(currentRoute)` where `INVENTORY_ROUTES = ["inventory", "price-book", "purchase-orders", "vendors"]`.

**Why a separate "Inventory" sub-item instead of making the parent itself the route?**

(a) Visual clarity — every page in the group gets its own row in the sidebar, so a new operator scanning the rail immediately sees that *Inventory* is one of four things they can do, not the umbrella label of three things plus a hidden default. (b) Consistent click affordance — every clickable sidebar entry is a child row; the parent's job is *grouping*, not *routing*. (c) Backwards-compatible URLs — the existing `InventoryPage` keeps its URL; only the sidebar rendering changes.

**Acceptance criteria:**

- [ ] On first app load, the sidebar shows the Inventory parent expanded with **four children in this order: Inventory · Price Book · Purchase Orders · Vendors**.
- [ ] Clicking the **Inventory parent label** routes to the Inventory dashboard (Items tab) — not Price Book, not Vendors, not any other page.
- [ ] Clicking the **chevron** next to the Inventory parent toggles expand/collapse of the four children **without** routing.
- [ ] Clicking the **Inventory** sub-item routes to the Inventory dashboard.
- [ ] Clicking the **Price Book** sub-item routes to the §6.A placeholder page.
- [ ] Clicking the **Vendors** sub-item routes to the §7.6.A VendorsPage.
- [ ] Clicking the **Purchase Orders** sub-item is a no-op in v1 (decorative placeholder — unchanged from prior behavior); badge still renders the open-PO count.
- [ ] The parent **Inventory** row visually stays active when the current route is any of the four children.
- [ ] Direct navigation to `/inventory` lands on the Inventory dashboard on first paint; direct navigation to `/price-book` lands on the §6.A placeholder on first paint — both with no flash of unrelated content.
- [ ] Default app-load route is `"inventory"` (Items tab).
- [ ] The new "Inventory" sub-item uses the stacked-boxes icon (Lucide `Boxes`), distinguishing it from the Tag (Price Book), Cart (Purchase Orders), and Truck (Vendors) icons.

### 5.4.A.iv `[PROTOTYPE v1.1]` Primary Tech + Vehicle pickers (locked from prototype)

For truck-type locations in the Add/Edit Location dialog:

- **Primary Tech** is a dropdown of `app_user` rows where `role ∈ {field_tech, subcontractor_tech}`. Each option displays `Name · primary_trade [· 1099]` so the picker doubles as a quick capability filter.
- **"Unassigned"** is the first option — used for spare vans, project-staging trucks, or trucks pending re-assignment.
- Below the picker, a helper line surfaces the tech's `branch` + their `certs` (e.g. *"👤 Brooklyn HQ · ASSE Backflow"*) — gives the dispatcher confidence before assigning a tech to a specific job-vertical's van.
- Free-text values stored in `inventory_location.primary_tech_name` from older data (or imported records) appear as a disabled `<option>` so the user sees what's currently set even if the tech isn't in the system. They can then re-select a real tech to normalize.

- **Vehicle** is a text input bound to an HTML5 `<datalist>` of every distinct `app_user.vehicle` already in use across the org — gives the user dropdown suggestions while still allowing free-text entry (e.g. for a brand-new vehicle that doesn't have a tech assigned yet).
- **Auto-fill on tech pick**: when the user selects a tech with a `vehicle` value, the Vehicle field auto-fills from `app_user.vehicle`. An emerald confirmation chip appears: *"✨ Auto-filled from {tech.name}'s assigned vehicle"*.
- **Override-safe**: the auto-fill only writes when the Vehicle field is empty OR currently matches one of the known tech vehicles — so a manual override (e.g. "Rental — U-Haul 24-ft this week") is never silently overwritten if the user later changes the tech.

**Acceptance criteria:**

- [ ] Tech picker lists every active field_tech + subcontractor_tech in the org, sorted by primary trade.
- [ ] Selecting a tech with an assigned vehicle auto-populates the Vehicle field on first selection.
- [ ] Vehicle datalist suggests every distinct vehicle currently in use in the org (deduplicated).
- [ ] Free-text vehicle values are preserved across tech changes if the user has manually overridden the auto-fill.

### 5.4.A.ix `[PROTOTYPE v1.1 rev 2026-05-27]` TopBar bell — inventory attention queue dropdown

The bell icon in the TopBar (top-right, next to the Help icon) is the **inventory attention queue** — a single dropdown that aggregates every state across the inventory subsystem that's currently asking for the operator's attention. Replaces the previous static red-dot indicator that had no behavior.

**Aggregated alert kinds** (six categories, ranked by triage priority):

| # | Kind | Severity | Source | Title / subtitle |
|---|------|----------|--------|------------------|
| 1 | `pending_approval` | `critical` | `StockApproval.status === "pending"` | *"Consume 2 × HVC-CAP-45-5"* · `<tech> · <fromLoc> → <toLoc>` or `<jobNumber>` |
| 2 | `backorder` | `critical` | `Item.status === "on_backorder"` | `<item.name>` · `<sku> · vendor <vendor>` |
| 3 | `low_stock` | `warning` | `isLowStock(item)` AND `status !== "on_backorder"` AND `kind === "material"` | `<item.name>` · `<sku> · <loc>: <onHand>/<min>` joined per offending location |
| 4 | `staging_no_area` | `warning` | `JobStage.status IN ("complete","ready_for_pickup")` AND `!stagedArea` | `<jobNumber> · <customer>` · *"Tell the tech where in the warehouse — area not set"* |
| 5 | `po_partial` | `warning` | `PurchaseOrder.status === "partial"` | `<poNumber> · <vendor>` · `<remaining> of <total> units still owed [· <jobNumber>]` |
| 6 | `staging_ready` | `info` | `JobStage.status === "ready_for_pickup"` | `<jobNumber> · <customer>` · *"Ready · <tech>[ · <stagedArea>]"* |

**Severity ordering** drives the bell badge color: `rose` if any `critical` alerts exist, else `amber` if any `warning`, else `emerald` if any `info`, else hidden (no badge when total is zero). Badge label is the total count capped to `9+`. Tooltip on the bell reads *"N inventory alerts"* (or *"Inventory alerts — all clear"* when empty).

**Panel layout** (anchored top-right, 380px wide, max-h 480px, shadow-xl card):

- **Header** (slate-50 bar): title *"Inventory needs attention"* (12px bold) · subtitle *"N items across M categories"* (10px muted) · three severity chips on the right (`6` rose pill · `7` amber pill · `1` emerald pill — only the non-zero ones render) · `×` close button.
- **Body** (scrollable when content overflows max-h):
  - For each non-empty kind group, a **section** with:
    - **Section header** (tinted background matching the kind's severity): kind icon (e.g. `ShieldAlert` for approvals, `Package` for backorder, `AlertTriangle` for low stock, `MapPin` for staging-no-area, `Truck` for PO partial, `CheckCircle2` for ready) · uppercase 11px label · count chip on the right.
    - **Row list** (divided): each row is a `<li>` with a 1.5px severity-tinted dot + 2-line text block (truncated title · truncated subtitle) + a relative-time chip on the right (`Clock` icon + e.g. *"9m ago"*). Hover lifts to slate-50. Full ISO timestamp surfaces in the row's `title` attribute on hover for forensic precision.
  - **Empty state** (when the alert total is zero): centered emerald `CheckCircle2` + *"All clear"* + helper copy *"No low stock, no backorders, no pending approvals, and every staging job is squared away."* — operators get the positive confirmation too.
- **Footer** (slate-50 bar): muted *"Live view · updates as inventory state changes"* + a Close button (text, indigo, hover bg).

**Close paths:** `Escape` key (handler on `document` registered while open) · outside `mousedown` (handler checks `rootRef.current.contains(e.target)`) · the `×` icon in the header · the Close button in the footer. All four set `open=false`.

**Sorting:**

- Within each group, alerts sort by their alert-worthy timestamp **desc** (`Item.updatedAt` for stock alerts; `StockApproval.requestedAt`; `JobStage.updatedAt ?? createdAt`; `PurchaseOrder.orderedAt`). Freshest first so the most-recently-touched signal sits at the top of each list.
- Groups themselves render in a fixed triage order: `pending_approval → backorder → low_stock → staging_no_area → po_partial → staging_ready`.

**Data shape** (`src/lib/inventory-alerts.ts`):

```ts
export type InventoryAlertKind =
  | "low_stock" | "backorder" | "pending_approval"
  | "staging_ready" | "staging_no_area" | "po_partial";

export type InventoryAlertSeverity = "critical" | "warning" | "info";

export type InventoryAlert = {
  id: string;
  kind: InventoryAlertKind;
  severity: InventoryAlertSeverity;
  title: string;
  subtitle: string;
  at?: string;                  // ISO timestamp for in-group sort + tooltip
  ref?: {                       // optional structured ref for future jump-on-click
    itemSku?: string;
    poNumber?: string;
    stageId?: string;
    approvalId?: string;
  };
};

export function computeInventoryAlerts(input: {
  items: Item[];
  locations: Location[];
  purchaseOrders: PurchaseOrder[];
  jobStages: JobStage[];
  stockApprovals: StockApproval[];
}): InventoryAlert[];

export function groupAlerts(alerts: InventoryAlert[]): InventoryAlertGroup[];
export function severityCounts(alerts: InventoryAlert[]): { critical, warning, info };
export function relativeShort(iso?: string, now?: Date): string;
```

The function is **pure and read-only** — it never mutates the inputs and can be re-computed on every render. In v1 it reads the in-memory seed tables; production wires it to the same Postgres views that back the InventoryPage KPI tiles, with a 60 s polling refresh (or a Supabase realtime subscription on the underlying tables once the realtime channel is wired in §11.5).

**Trigger ownership:** `NotificationsDropdown.tsx` owns the bell button + the panel as a single self-contained unit. `TopBar.tsx` mounts the component next to the Help icon and otherwise has no notification concerns. This isolates the dropdown's `open` state, outside-click ref, and alert recomputation from the TopBar — a future "messages" or "tasks" dropdown can mount as a sibling without leaking state into TopBar.

**Per-row navigation (rev 2026-05-27 v2):** rows are now fully clickable — each `<li>` carries `role="button" tabIndex={0}` with `onClick` + `onKeyDown` (Enter/Space) firing `emitAlertIntent(alert) + setOpen(false)` so clicking a row both closes the panel and navigates in the same gesture. Rows pick up `cursor-pointer`, an indigo-tinted hover/focus background, and an indigo-tinted title hover-color; the row's `title` reads *"Open · &lt;timestamp&gt;"*.

| Alert kind | Click behavior |
|---|---|
| `low_stock` | Switch to **Items** tab + apply **Low Stock** stock-state filter (replaces conflicting in_stock / out_of_stock / backorder; preserves vendor / category / kind filters) + select the matching item (detail drawer slides in) |
| `backorder` | Switch to **Items** tab + apply **Backorder** filter + select the matching item |
| `pending_approval` | Switch to **Approvals** tab + open `ApprovalDetailDialog` by `ref.approvalId` (filter auto-flips to *Pending* so the row stays visible behind the dialog) |
| `staging_no_area` | Switch to **Staging** tab + open `StageDetailDialog` by `ref.stageId` |
| `staging_ready` | Switch to **Staging** tab + open `StageDetailDialog` by `ref.stageId` |
| `po_partial` | Open `POPreviewDialog` by `ref.poNumber` **on top of the current tab** — no tab switch (PO doc is a pop-out the operator can read without losing their place) |
| (any with empty `ref`) | No-op (defense-in-depth) |

**Routing implementation:** new pure pub/sub `src/lib/alert-bus.ts` (`emitAlertIntent` + `subscribeAlertIntent`). `InventoryPage` (always mounted while route === inventory) holds the single subscriber and reduces every incoming alert into local state:

```ts
useEffect(() => subscribeAlertIntent((alert) => {
  switch (alert.kind) {
    case "low_stock":  setView("items"); setFilters(f => ({ ...f, stockStates: […, "low_stock"] })); if (alert.ref?.itemSku) setSelectedId(matchBySku); break;
    case "backorder":  setView("items"); setFilters(f => ({ ...f, stockStates: […, "backorder"] })); if (alert.ref?.itemSku) setSelectedId(matchBySku); break;
    case "po_partial": setAlertPreviewPONumber(alert.ref!.poNumber); break;
    case "pending_approval":   setView("approvals"); setPendingApprovalIntent({ id, nonce: Date.now() }); break;
    case "staging_no_area":
    case "staging_ready":      setView("staging");   setPendingStageIntent({ id, nonce: Date.now() }); break;
  }
}), []);
```

**Subscribe-after-emit race fix:** `ApprovalsView` and `StagingView` mount only when their tab is active, so a naive in-child `subscribeAlertIntent(…)` would miss the event the very first time their tab is opened by the bell. The fix: `InventoryPage` forwards the intent **via props** as `pendingIntent: { id: string; nonce: number } | null`. The sub-view's effect watches both `id` and `nonce` (which is `Date.now()`-stamped on every click) so it re-fires for repeat clicks of the same id too:

```ts
// ApprovalsView / StagingView
useEffect(() => {
  if (!pendingIntent) return;
  setOpenDetailId(pendingIntent.id);    // (filter is also bumped in ApprovalsView)
}, [pendingIntent?.id, pendingIntent?.nonce]);
```

No replay buffer, no `setTimeout`, no global window event — just two pieces of state that React renders top-down. The bus stays in the architecture because (a) the `po_partial` branch needs no sub-view forwarding (`InventoryPage` renders its own top-level `<POPreviewDialog>` and consumes the intent directly), and (b) future surfaces (e.g. a Dashboard widget) can subscribe to the same bus without re-plumbing.

**Top-level `<POPreviewDialog>`:** `InventoryPage` renders one `<POPreviewDialog open={!!alertPreviewPONumber} poNumber={alertPreviewPONumber} zIndex={80} lockEscape />` next to the toast (i.e. outside the per-tab JSX) so the PO preview opens regardless of which tab is active when the user clicks the `po_partial` row.

**Cross-route navigation (rev 2026-05-27 v3):** the v2 routing logic lived entirely inside `InventoryPage`'s bus subscription — which meant that clicking a row from the **Vendors** or **Price Book** route (or any future non-Inventory route) silently no-op'd because `InventoryPage` wasn't mounted to receive the intent. The fix lifts the subscription up to **`App.tsx`**, which is always mounted. App reduces every alert into two pieces of state — `route` (force-set to `"inventory"`) and `pendingAlert: { alert: InventoryAlert; nonce: number } | null` — and forwards `pendingAlert` to `InventoryPage` as a prop. `InventoryPage`'s reducer effect watches `pendingAlert?.nonce` so it re-fires on every click (the `Date.now()` nonce makes the prop identity new each time, defeating React's reuse-when-possible optimization that would otherwise skip the effect on repeat clicks of the same alert). The bus stays in the architecture for the same reason it did at v2 — future surfaces (a Dashboard widget, a header search command palette) can subscribe to the same bus without re-plumbing — but the *active* subscriber is now App, not InventoryPage.

```ts
// App.tsx
useEffect(() => subscribeAlertIntent((alert) => {
  setRoute("inventory");
  setPendingAlert({ alert, nonce: Date.now() });
}), []);

// InventoryPage receives pendingAlert as a prop and reduces it.
```

**Low-stock / backorder action pop-out (rev 2026-05-27 v4):** for `low_stock` and `backorder` alerts the v3 routing already snapped the user to Items + applied the filter + selected the item in the side drawer. But that still left the operator one filtered-list-scan away from the action they actually wanted: *"give me this item, with a Restock button right here."* This rev adds a small pop-out dialog (`LowStockActionDialog.tsx`, new) that mounts on top of the now-filtered Items tab the moment a `low_stock` or `backorder` alert is clicked.

The dialog renders:
1. **Item card** — photo (or letter-avatar fallback) + name + `<category> · <uom> · vendor <name>` + total on-hand-across-N-locations summary.
2. **Below-reorder-threshold table** (low_stock only) — one row per offending location showing `<onHand> / <min> min` in mono right-aligned, amber-tinted card so the operator sees *where exactly* the shortage is without scanning the side drawer.
3. **Vendor-overdue banner** (backorder only) — rose-tinted explainer: *"This item's vendor delivery is overdue. **Restock** writes an immediate receipt against a manual count or alternate-source vendor; the existing back-ordered PO line stays open so you don't double-pay."*
4. **Walk-away copy** — *"Walking away? Close this pop-up — the item stays filtered + selected on the Items tab so you can come back to it without re-finding it."*
5. **Footer** — secondary **Close** button (walk-away path; the filtered Items tab + side drawer underneath remains exactly as is) + primary indigo **📦 Restock now** button.

**Restock-now wiring:** clicking *Restock now* closes the action dialog and opens the existing `RestockDialog` (§5.4.A Restock). RestockDialog already accepts `initialItemId` and reads from `selectedId` — which we set during the alert reduce — so it opens pre-filled with the right item. The operator picks location + qty + source (vendor PO / manual receive / truck return) and submits in seconds.

**Z-index stacking:** `LowStockActionDialog` renders at `zIndex={70}`, between the underlying Items tab (50) and the bell dropdown's nested `POPreviewDialog` (80). The side drawer sits at the Items-tab's native z-index so the user can read full per-location stock behind the dialog.

**Why both surfaces:** the side drawer is the "what the item looks like in the catalog" view (full per-location breakdown, reserved counts, photo, vendor, every location not just the offending ones). The action dialog is the "what do you want to do about it" pop-out. They serve different jobs and rendering both means the operator never has to choose between context and action — read the drawer behind, restock from the dialog, or close and keep browsing in the filtered list.

```ts
// InventoryPage state added at v4:
const [lowStockAction, setLowStockAction] = useState<{
  itemId: string;
  kind: "low_stock" | "backorder";
} | null>(null);

// Inside the alert reducer (low_stock / backorder branches):
if (hit) {
  setSelectedId(hit.id);                                    // drawer
  setLowStockAction({ itemId: hit.id, kind: alert.kind });  // pop-out
}
```

**Why this exists:** before this rev, the only signals inventory had were buried — owners had to scan the InventoryPage KPI tiles for low-stock + backorder counts, the Approvals tab for pending sign-offs, the Staging tab for "ready_for_pickup" stages, and the Purchase Orders page for partial receipts. Stock-out approvals routinely sat for 1–2 days because nobody opened the Approvals tab. Partial POs didn't get chased because the buyer was looking at the Items list. Owner's ask was literal: *"give me one place that tells me what's hot."* The bell was already there carrying a meaningless red dot — repurposing it as the real attention queue is the cheapest path to that single-place-tells-me-everything outcome, and the dropdown's footer copy (*"Live view · updates as inventory state changes"*) is a deliberate trust signal that the badge is honest, not stale.

**Acceptance criteria:**

- [ ] Bell button shows a tinted badge with the total alert count when total > 0; badge is hidden when total === 0.
- [ ] Badge tint is rose if any `critical` alert exists, else amber if any `warning`, else emerald if any `info`, else hidden.
- [ ] Badge label caps to `9+` so the badge stays single-digit-wide. Tooltip on the bell reads *"N inventory alerts"* or *"Inventory alerts — all clear"*.
- [ ] Clicking the bell toggles the panel open/closed; `aria-expanded` reflects the state; the bell gets an indigo ring while open.
- [ ] Panel header renders the title + *"N items across M categories"* subtitle + non-zero severity chips + `×` close.
- [ ] Each non-empty kind renders as a section with the correct tint, icon, label, and count chip; sections are ordered `pending_approval → backorder → low_stock → staging_no_area → po_partial → staging_ready`.
- [ ] Within a section, alerts sort by `at` desc so the most-recent signal is on top.
- [ ] Each row shows a severity dot, a truncated 2-line text block, and a relative-time chip; the full ISO timestamp surfaces as a hover tooltip.
- [ ] When total === 0, the body renders the emerald *"All clear"* empty state instead of any sections.
- [ ] Pressing Escape, clicking outside the panel, clicking the `×` icon, or clicking the Close footer button all close the panel.
- [ ] Computing alerts is pure and read-only (no mutations to `items / locations / purchaseOrders / jobStages / stockApprovals`); the function returns identical output for identical inputs.
- [ ] **(rev 2026-05-27 v2)** Each row is keyboard-accessible (`role="button" tabIndex={0}` with Enter / Space).
- [ ] Clicking a `low_stock` row → tab=Items, `filters.stockStates` includes `low_stock` (and excludes `in_stock` / `out_of_stock` / `backorder`), and `selectedId` resolves to the matching item.
- [ ] Clicking a `backorder` row → tab=Items, `filters.stockStates` includes `backorder` (and excludes `in_stock` / `out_of_stock` / `low_stock`), and `selectedId` resolves to the matching item.
- [ ] Clicking a `pending_approval` row → tab=Approvals + filter=Pending + `ApprovalDetailDialog` opens with the right approval.
- [ ] Clicking a `staging_no_area` or `staging_ready` row → tab=Staging + `StageDetailDialog` opens with the right stage.
- [ ] Clicking a `po_partial` row → `POPreviewDialog` opens by `poNumber` on top of the current tab; tab is **not** switched.
- [ ] Every navigation click also closes the dropdown panel in the same gesture.
- [ ] The dropdown's `×` icon and Close button still work and **do NOT emit any alert intent** (they only close the panel — navigation is row-only).
- [ ] Re-clicking the same alert after closing the resulting dialog re-opens that dialog (the `nonce` re-fires the sub-view's effect).
- [ ] **(rev 2026-05-27 v3)** Clicking any alert row while on a non-Inventory route (Vendors, Price Book, Purchase Orders) snaps the user to the Inventory route in a single gesture; the same per-kind routing then applies as if the user had started on Inventory.
- [ ] **(rev 2026-05-27 v3)** Repeat clicks of the same alert from the same route re-fire the reducer effect (the `pendingAlert.nonce` changes every emission).
- [ ] **(rev 2026-05-27 v4)** Clicking a `low_stock` or `backorder` row opens `LowStockActionDialog` at `zIndex={70}` on top of the now-filtered Items tab, with the matched item populated.
- [ ] **(rev 2026-05-27 v4)** `LowStockActionDialog` shows the item card, the offending-locations table (low_stock only) or the vendor-overdue banner (backorder only), walk-away copy, and a primary **Restock now** CTA.
- [ ] **(rev 2026-05-27 v4)** Clicking **Restock now** closes the action dialog and opens `RestockDialog` pre-filled with the same item (`initialItemId` resolves from the `selectedId` set during the alert reduce).
- [ ] **(rev 2026-05-27 v4)** Clicking **Close** dismisses the pop-out and leaves the underlying Items tab + filter + side drawer + `selectedId` exactly as they were — the walk-away path keeps state for "come back to it later".

### 5.4.B `[PROTOTYPE v1.1]` CSV Import + Export (Inventory)

CSV is the canonical bulk-edit format. Import is the on-ramp from vendor catalogs / spreadsheets / other FSM tools (PRD §8.1.4 Catalog Ingestion); Export is the off-ramp for back-office reconciliation, owner spreadsheets, and accountant hand-offs.

**Export (one-click download from header `Export` button):**

- Always exports the **currently visible items** — i.e. respects the active location filter, the search box, AND the filter popover state. (No "export all" override in v1.1; if user wants everything, they clear filters first.)
- Filename pattern: `inventory-<location-slug>-<YYYY-MM-DD>.csv` (e.g. `inventory-all-locations-2026-05-25.csv`, `inventory-mike-s-van-2026-05-25.csv`).
- UTF-8 with BOM so Excel opens it correctly.
- RFC-4180 escaping: fields containing `,` / `"` / newlines are double-quoted; literal `"` characters are doubled.
- Locked column set (18, in this order):
  `SKU, Name, Category, Trade, Kind, UoM, Unit Cost, Sell Price, Total On Hand, Total Reserved, Total Available, Vendor, MPN, UPC, Serialized (Y/blank), Hazmat (Y/blank), Status, Locations Breakdown, Updated At`
- `Locations Breakdown` is a single cell of `<Location>:<qty>` pairs joined by ` | ` — chosen for human-readability in Excel; structured per-location export is `[DEFERRED]` to Phase 2 via the Fivetran connector.
- Empty filter result → no file written; toast: *"No items to export with current filters"*.

**Import (modal flow from header `Import CSV` button):**

- File constraints: `.csv` only, ≤ 20 MB, UTF-8, header row required. Larger imports go through the back-office bulk-import pipeline (Phase 2).
- **Drop-zone OR file picker** with a "Need a sample CSV?" expandable that shows a copy-paste-ready 2-row example.
- **Auto-map step** — the importer fuzzy-matches user CSV headers against canonical fields using an alias dictionary. Required mappings: `SKU`, `Name`, `Unit Cost`. Optional: Category, Trade, Kind, UoM, Sell Price, Vendor, MPN, UPC, Serialized, Hazmat.
- **Alias dictionary (locked, extensible per tenant in Phase 2):**

| Target field | Accepted source headers (case-insensitive, normalized for `_`/`-`/` `) |
|---|---|
| `sku` | sku · part number · part # · partnumber · part_no · item code · code |
| `name` | name · item name · description · item description · title |
| `category` | category · cat · group · class |
| `trade` | trade · discipline · service line |
| `kind` | kind · type · item type |
| `uom` | uom · unit · unit of measure · u/m |
| `unitCost` | unit cost · cost · vendor cost · wholesale · buy price |
| `sellPrice` | sell price · price · list price · retail · msrp |
| `vendor` | vendor · supplier · manufacturer · mfr · brand |
| `mpn` | mpn · manufacturer part · mfr part · mfg part |
| `upc` | upc · ean · gtin · barcode |
| `serialized` | serialized · serial tracked · track serial |
| `hazmat` | hazmat · hazardous |

  Fuzzy match runs in two passes: (1) exact normalized match, (2) substring contains. The detected mapping is shown in a grid that the user can override per field via dropdown.
- **Preview** — first 5 parsed rows shown as a sticky table; user verifies mapping looks right before committing.
- **AI auto-categorize toggle** (default ON) — when checked, missing/low-confidence categories run through the Catalog Ingestion AI (§8.1.4) after rows are persisted. A review queue opens (Phase 2 UI; v1.1 surfaces it as a toast hint).
- **Boolean parsing**: `Y` · `Yes` · `True` · `1` (case-insensitive) → true; everything else → false. Applied to `serialized` and `hazmat`.
- **Enum validation + fallbacks**:
  - `trade` must be one of {`locksmith`, `door`, `security`, `hvac`, `plumbing`}; unknown → `locksmith` (and flagged in review queue).
  - `kind` must be one of {`material`, `service`, `labor`, `bundle`, `fee`}; unknown → `material`.
  - `uom` blank → `EA`.
- **SKU collisions**: detected against existing catalog at import time. v1.1 still inserts the new row (with a `imp_` ID prefix to disambiguate); the collision count is surfaced in the toast for triage: *"✓ Imported 47 items · 3 SKU collisions flagged in review queue"*. Phase 2 will offer per-row resolve options (skip / overwrite / merge).
- **Audit log**: every row imported writes an `audit_log` entry with `actor_type='user'`, `action='item.imported'`, source filename + row index in `reason_code`, full row JSON in `after_json` (no `before_json` for inserts).

**Acceptance criteria:**

- [ ] Owner can export current view to CSV and re-open in Excel without UTF-8 corruption.
- [ ] A 1000-row vendor catalog CSV imports + AI-categorizes in <60 sec p95 (matches §11.6 perf target).
- [ ] Required-field mapping (SKU / Name / Unit Cost) blocks the Import button until satisfied.
- [ ] Unknown trade/kind values fall through to defaults + appear in the post-import review queue.
- [ ] CSVs with commas / quotes / newlines inside cells parse correctly (Excel-edited files).

## 5.5 Edge Cases & Failure Modes

- **Negative stock on truck (offline)**: allowed on non-serialized consumables with auto-reconciliation task `[A25]`. Warehouses: never allow. Serialized: never.
- **Two techs grab last unit**: row-locked commit order; second tech gets `inventory_conflict` 409 with three recovery actions (transfer / PO / mark backordered).
- **Offline consume + reconnect**: batch upload commands; server dedupes by `client_operation_id`; conflicts surface in field language.

## 5.6 Acceptance Criteria (high level)

- [ ] Tech can add part to job via barcode scan, voice, or text search in <3 sec p95.
- [ ] Stock movement ledger is immutable; corrections are new entries, never edits.
- [ ] Cycle count of 5 bins completes in <5 min p95 with variance auto-posted.
- [ ] Offline tech can consume parts; sync resolves on reconnect with conflict UX if needed.
- [ ] Owner can configure RBAC to lock techs to authorized truck/branch locations.
- [ ] Serialized items track install location, warranty, current asset binding.

---

# 6. Price Book Module — Functional Requirements

## 6.A `[PROTOTYPE v1.1 rev 2026-05-28]` Price Book page — Phase A (taxonomy + items + brand + bundle entities)

The **Price Book** sub-item under the Inventory parent group (§5.4.A.viii) routes to a dedicated `PriceBookPage`. Phase A (this rev) ships the data spine: **Brand + Category taxonomy, per-item visibility flag, preset Item Group bundles, and the four tabs** that surface them. Phase B (next rev) layers the customer-facing **Catalog tab** with product photos, marketing copy, and key-features bullets. Phase C (later rev) layers **Customer-Present Mode + PDF export + shareable customer link**. The phasing is additive — each tab and field locked in Phase A stays locked when Phase B and C land.

**File location:** `src/components/PriceBookPage.tsx` (replaces the rev-2026-05-27 placeholder).

### 6.A.1 Item taxonomy (rev 2026-05-28)

```
Brand              (Mul-T-Lock, Medeco, ASSA Abloy, …)        — the manufacturer
Category           (Cylinders, Padlocks, Strikes, Hinges, …)  — cross-brand part type
```

Per-item FKs (all nullable so generic / un-classified items are allowed):
- `item.brand_id uuid NULL FK brand(id)` — the maker. Generic store-brand items leave this NULL.
- `item.category_id uuid NULL FK item_category(id)` — already exists, unchanged.

Why two parallel axes (not nested): trade businesses think in *"all the Mul-T-Lock items"* (brand) AND in *"all the cylinders regardless of brand"* (category). Two taxonomies side-by-side cover both navigation patterns without forcing a single hierarchy.

**Note on the old "Group" concept (rev 2026-05-28 redesign):** the prior `item.group_id` FK referenced a brand-scoped product-family Group (`C-Series`, `ND-Series`, `Peaks Preferred`). That concept was **retired** in the Item Groups redesign — `item.group_id` is dropped, and the word "Group" now means a **preset bundle** of line items for fast estimate / invoice creation (see §6.11). Bundles do not subdivide a brand; they are cross-brand by definition and don't reference items via FK in the other direction either (lines reference items, but items don't know which bundles include them).

### 6.A.2 Page tabs

| Tab | Purpose | Phase |
|---|---|---|
| **Items** | Flat searchable list of every catalog item; **four clickable KPI tiles** (In Catalog / Hidden / With Photos / Without Prices) — each tile is a one-click filter trigger (see §6.A.2.a, rev 2026-05-28); filter pills Brand · Category · Visibility (**Group filter dropped rev 2026-05-28** — Groups no longer relate to items; see §6.11 redesign); columns hero-thumb · customer name (fallback internal name) · SKU · **Brand** (Group sub-line dropped rev 2026-05-28) · Category · List Price · Visibility chip; **rows are click-to-edit** — opens AddItemDialog in edit mode pre-filled with the clicked item (rev 2026-05-27 — see §6.A.2.b) | A (default tab) |
| **Brands** | Manage brand entities (CRUD) — card grid with logo · name · item count · default markup · website chip (the prior "Groups" count tile and per-brand `+ Add group` pill were removed rev 2026-05-28 when Groups stopped meaning product families — see §6.11) | A |
| **Groups** | **Preset bundles** for fast estimate / invoice creation (rev 2026-05-28 redesign — see §6.11). Each bundle is a saved list of line items (parts + labor + dispatch fees) with a customer-facing format toggle: **Individual items** (every line surfaces on the estimate) or **Flat rate** (one lump-sum line; underlying items stay internal for margin tracking). Card grid filterable by name + format; card shows hero photo · format chip · description · first 3 lines · CUSTOMER SEES price · MARGIN %. **+ New Bundle** opens `AddGroupDialog` (xl modal: photo upload · name · description · format radio · optional flat-rate price override · items table with search-as-you-type item picker + "+ Free-form line" for one-off charges + editable per-line price / cost overrides + subtotal & customer-sees footer rows). Lines reference real Price Book items (live pricing with optional per-bundle override) or are free-form (one-off name + price). Drop a bundle onto an estimate by name → every line auto-populates (estimate-side flow documented as next-phase target — not built in this prototype since no Estimate page exists yet). | A |
| **Categories** | Full CRUD for the cross-brand category vocabulary — banner-style card grid (rev 2026-05-28) with hero photo per category, name, optional trade chip, description, item count; **+ Add Category** in the header opens AddCategoryDialog; hover-revealed Edit (pencil) / Delete (trash) over the banner; delete blocked when any item still references the category. Co-equal with the InventoryPage Category selector — both surfaces edit the org's `category` table | A |
| **Catalog** | Customer-facing presentation surface — grid of photo cards, Customer-Present Mode trigger, PDF export, share link | **B (placeholder this rev)** |

The Catalog tab in Phase A renders as a coming-soon strip *"Catalog view ships in Phase B — product photos + customer-facing copy come next."* — the tab is visible so the URL + ordering lock in early.

### 6.A.2.a `[PROTOTYPE v1.1 rev 2026-05-28]` Items tab — KPI tiles as clickable filter triggers

The four KPI tiles at the top of the Items tab are real button-tiles that double as one-click filter triggers — same locked pattern shipped on the Inventory Items KPI row (§5.4.A), the Staging KPI row (§7.4.A.2), and the Vendors page header (§7.6.A). Each tile renders as a `<button>` with `aria-pressed` reflecting its active state, plus an `aria-label` describing the filter target (e.g. *"Show only items currently in the customer-facing catalog"*) for screen-reader parity.

**Tiles, in render order:**

| Tile | Tone | Filter dimension | What active state does | Click again |
|---|---|---|---|---|
| **In Catalog** | indigo | `filterVisibility` | sets `filterVisibility = "catalog"` (only items where `visibility = 'catalog'` show) | clears to `"all"` |
| **Hidden from Catalog** | slate | `filterVisibility` | sets `filterVisibility = "internal_only"` (only labor / fees / internal SKUs show) | clears to `"all"` |
| **With Photo** | emerald | `filterPhoto` (new dimension, rev 2026-05-28) | sets `filterPhoto = "with"` (only items where `photoUrl` is set show) | clears to `"all"` |
| **No Price Set** | amber | `filterPrice` (new dimension, rev 2026-05-28) | sets `filterPrice = "missing"` (only items where BOTH `sellPrice` and `listPrice` are unset show) | clears to `"all"` |

**Toggle semantics — single-active across all four tiles (rev 2026-05-28, owner-locked):**

The four tiles behave as a **one-of-N radio row** — at any moment at most one tile is active. Clicking any non-active tile sets its filter AND clears the other three; clicking the active tile clears it back to *"no tile filter"*. This holds even though the underlying state is three independent slots — the invariant is enforced in the click handlers, not by collapsing the state into a single union. (An earlier draft of this rev on 2026-05-28 allowed `With Photo` + `No Price Set` to stack with `In Catalog` / `Hidden from Catalog` as orthogonal filters; owner reverted the same day with *"I don't want to have the option to press two tabs at the same time. I want each tab individually, so when I press the other one, it goes to the other one."*)

State machine:

| User action | `filterVisibility` | `filterPhoto` | `filterPrice` |
|---|---|---|---|
| Click `In Catalog` (when none active or another active) | `"catalog"` | `"all"` | `"all"` |
| Click `In Catalog` (when already active) | `"all"` | `"all"` | `"all"` |
| Click `Hidden from Catalog` (when none active or another active) | `"internal_only"` | `"all"` | `"all"` |
| Click `Hidden from Catalog` (when already active) | `"all"` | `"all"` | `"all"` |
| Click `With Photo` (when none active or another active) | `"all"` | `"with"` | `"all"` |
| Click `With Photo` (when already active) | `"all"` | `"all"` | `"all"` |
| Click `No Price Set` (when none active or another active) | `"all"` | `"all"` | `"missing"` |
| Click `No Price Set` (when already active) | `"all"` | `"all"` | `"all"` |
| Pick non-`all` value in visibility dropdown | matches pick | `"all"` | `"all"` |
| Pick `All visibility` in visibility dropdown | `"all"` | _unchanged_ | _unchanged_ |

**Invariant**: at most one of the three state slots is non-`"all"` at any moment. Enforced in two places — (a) every tile click handler explicitly sets the other two slots to `"all"`, (b) the `setFilterVisibility` setter passed to `ItemsTab` is wrapped so picking any non-`all` dropdown value also clears `filterPhoto` + `filterPrice`. Picking `All visibility` does NOT touch the photo / price slots because the dropdown's "all" path is also reachable by clicking the active visibility tile, which would have already cleared those slots — so the photo / price state can only be non-`all` when the visibility dropdown is currently on `"all"` already.

`filterPhoto` and `filterPrice` are KPI-tile-only filter dimensions — no dropdown counterpart in the filter row. The dropdown row stays Brand / Group / Category / Visibility because *"has a photo?"* and *"is the price set?"* are sparse single-signal questions that don't need their own multi-value dropdowns; the tile click IS the filter.

**Visual states:**

- *Inactive*: tile renders its tinted background + label + value + hint exactly as it did pre-rev. No ring, no pill.
- *Active*: tile picks up an indigo `ring-2 ring-indigo-500` outline + a tiny white-on-indigo **`FILTERED`** pill (`bg-indigo-600`, 9px uppercase, rendered to the right of the label inside the tile header row).
- *Hover (any state)*: shadow lift (`hover:shadow-sm`).
- *Keyboard focus*: standard `focus-visible:ring-2 focus-visible:ring-indigo-300` (matches every other clickable KPI tile in the app).

**KPI numbers stay global.** The values rendered on the tiles (`catalogCount`, `internalCount`, `withPhoto`, `withoutPrice`) are computed from the **full** `items` list, not from `filteredItems`. So clicking a tile narrows the table without altering any of the four counts — the tile values stay stable across filter combinations so the operator can see "I have 3 with photos total" even when only `Hidden from Catalog` is active and the table shows 1 row. This matches the locked-tile contract used everywhere else in the app: tiles describe the **fleet**, the table describes the **slice**.

**Empty state copy is unchanged** — the existing *"No items match the active filters."* row in the items table renders when the combined filter narrows to zero rows (e.g. `No Price Set` is on but every seeded item has a sell or list price set → `0 of 15 items` count chip + the empty-state row).

**Rationale:** the operator already sees *"3 with photo, 0 without prices"* at a glance and instinctively wants to click the number to investigate. Pre-rev the only path was: scroll down → open the filter row → find the matching dropdown → pick the option → scroll back up. One-click drill-in matches every other KPI surface in the app, and adding two new tile-only filter dimensions (`filterPhoto`, `filterPrice`) is cheaper than carving out two more dropdown columns for sparse single-signal questions.

**Production schema note:** no schema change. The new `filterPhoto` + `filterPrice` dimensions are pure client-side derivations from the existing `item.photo_url` and `item.sell_price` / `item.list_price` columns; queries that back the eventual server-paginated Items list will append `WHERE photo_url IS NOT NULL` and `WHERE sell_price IS NULL AND list_price IS NULL` filters when those URL params are set.

**Files:** `dashboard/src/components/PriceBookPage.tsx` (new `filterPhoto` + `filterPrice` state, extended `filteredItems` memo dependencies, four toggle handlers passed to `ItemsTab`, four `<KPITile>` invocations carrying `onClick` + `active` + `ariaLabel`, `KPITile` refactored from a plain `<div>` to a dual-mode `<div>` / `<button>` that renders the FILTERED pill + indigo ring when `active` is true). No other components touched.

### 6.A.2.b `[PROTOTYPE v1.1 rev 2026-05-27]` Items tab — row click opens Edit dialog

Every row in the Items-tab table is **click-to-edit** — clicking anywhere on the row (except the Visibility chip in the last column, which has its own click handler) opens the existing `AddItemDialog` in edit mode pre-filled with that item's full record. Save commits the patched item back into the local `items[]` state via `setItems(...)`; on close, the dialog unmounts and the table renders the updated row in place (no full-page reload, no navigation, no separate edit page).

**Mechanics:**
- Each `<tr>` in the items table gets `onClick={() => onEditItem(it)}`, `tabIndex={0}`, `cursor-pointer` styling, an `Enter`-key keyboard handler, and a `title="Click to edit this item"` tooltip. A focus ring (`focus:ring-2 focus:ring-inset focus:ring-indigo-300`) makes the row accessible for keyboard navigation.
- The Visibility-chip `<button>` in the last column calls `e.stopPropagation()` before firing `onToggleVisibility(...)` so clicks on the chip don't *also* open the Edit dialog. Same pattern applies to any future row-level action buttons (delete, archive, duplicate, etc.).
- A new `editingItem: Item | null` state field on `PriceBookPage` drives the dialog: `<AddItemDialog open={!!editingItem} editItem={editingItem} ... />`. The dialog reuses every existing edit-mode behavior already built for the Inventory page (§5.4.A AddItem dialog spec) — SKU + name + category + brand + group + visibility + vendor + photo + unit/sell price + GM% live-calc badge + serialized/hazmat toggles. No new dialog component needed.
- **Vendor + Category state**: PriceBookPage now holds `allVendors` and `allCategories` local state (seeded from `inventory.ts`) so inline "+ Add new vendor" / "+ Add new category" actions inside the edit dialog work for the session. Mirrors `InventoryPage`'s pattern.
- **Save handler** patches the row in `items[]` in place — copies every editable field from the payload (`sku`, `name`, `category`, `trade`, `kind`, `uom`, `unitCost`, `sellPrice`, `serialized`, `hazmat`, `vendor`, `photoUrl`, `brandId`, `groupId`, `visibility`), bumps `updatedAt` to `new Date().toISOString()`, and closes the dialog.

**Acceptance criteria:**

- [ ] Clicking any `<tr>` in the Items-tab table opens the `AddItemDialog` in edit mode pre-filled with that item's record. Header reads *"Edit Item · &lt;SKU&gt;"*.
- [ ] Clicking the Visibility chip in the last column toggles visibility WITHOUT also opening the Edit dialog (event propagation stops at the chip).
- [ ] Saving an edit closes the dialog, the table re-renders with the patched row in place, and `item.updatedAt` is updated. KPI tiles (In Catalog / Hidden / With Photos / Without Prices) recompute against the new state.
- [ ] Pressing `Enter` on a focused row (Tab-navigated) opens the dialog the same as a click. `cursor-pointer` + indigo focus ring make the row's interactivity obvious.
- [ ] The "+ Add new vendor" and "+ Add new category" inline-create paths inside the edit dialog persist for the session — the new vendor/category appears in the dropdown the next time the dialog opens.

**Rationale:** Phase A's job is to make every item record easily editable from the Price Book surface (where catalog managers spend most of their time tuning customer-facing copy, prices, and visibility) without forcing them to navigate back to the Inventory page for every tweak. Click-to-edit on the row matches the pattern users already know from spreadsheets and from how Brands / Groups are edited via their own card click in the sibling tabs.

**Files:** `dashboard/src/components/PriceBookPage.tsx` (new `editingItem` state, new `allVendors` / `allCategories` local state, new `onEditItem` prop passed to `ItemsTab`, `<tr>` upgraded to click-to-edit + `stopPropagation` on the Visibility chip, new `<AddItemDialog>` mount with `editItem` + save handler at the bottom of the page). No changes needed to `AddItemDialog.tsx` itself — edit mode was already wired from the Inventory side and just gets a second host page.

### 6.A.3 Per-item visibility (catalog vs internal_only)

New column **`item.visibility item_visibility_enum`** with values `'catalog'` | `'internal_only'`, default computed from `item.type` at insert time:

| `item.type` | Default `visibility` | Reasoning |
|---|---|---|
| `material` | `catalog` | Parts you sell to customers |
| `service` | `catalog` | Sellable services (rekey, dispatch, etc.) |
| `bundle` | `catalog` | Kits you sell as a package |
| `labor` | `internal_only` | Internal labor codes — customer sees a labor line on the estimate, they don't browse a labor catalog |
| `fee` | `internal_only` | Overhead / surcharges |
| `discount` | `internal_only` | Internal pricing tool |

The owner can flip visibility either way per item — the default is a smart guess, never a hard lock. The catalog-tab grid (Phase B) and any future customer-facing surface filter `WHERE visibility = 'catalog'`; internal-only items still appear in the Items + Inventory tables for ops staff.

UI surface:
- **Inventory items table** (§5.4.A) — new column with a chip: `🌐 Catalog` (indigo) or `🔒 Internal` (slate). Right-edge actions menu gets a *"Toggle visibility"* item.
- **Price Book Items tab** — same chip column. Filter pill "Visibility" with options All / Catalog only / Internal only.
- **AddItemDialog / Edit Item dialog** — new field, segmented control between `🌐 Catalog` and `🔒 Internal`. Default flips when the operator changes `item.type`.

### 6.A.4 Customer-facing copy fields (Phase A schema; Phase B UX)

New fields on `item`:
- `customer_name text NULL` — marketing-friendly name (e.g. *"Mul-T-Lock C-Series High-Security Cylinder"*). The catalog tab + every customer-facing surface use this; ops surfaces (Inventory items table, restock dialog, scan flow) use the existing `item.name`. When `customer_name IS NULL`, the catalog falls back to `item.name` with a small amber *"Marketing name not set"* badge.
- `customer_description text NULL` — short marketing copy (1-3 sentences). Same fallback to `item.description` when null.
- `key_features jsonb NULL` — array of 3-5 short bullet strings shown in Customer-Present Mode + on the printed PDF catalog. Shape: `["Pick-resistant", "Drill-resistant", "Restricted keyway"]`. When null, the features block is omitted.

Phase A locks the schema — the AddItemDialog gains the three optional fields in a collapsible *"Customer-facing copy (Phase A — used by Catalog in Phase B)"* section so the data is captured today and the Catalog tab can render it immediately on Phase B ship.

### 6.A.5 Photos (Phase A schema; Phase B UX)

New field on `item`:
- `photos jsonb NULL` — array of attachment objects, **same shape** as `StageAttachment` from the staging-photos spec (§7.4.A.10, rev 2026-05-26) but restricted to `kind: 'image'` only in v1. Shape per entry: `{ id, kind: 'image', source: 'camera' | 'upload', dataUrl, mimeType, caption?, uploadedAt, uploadedBy, sortOrder, isHero }`. The first photo (lowest `sortOrder`, or the one with `isHero: true`) is the hero shot rendered on catalog cards and estimate line items. **Hero-fallback chain** (rev 2026-05-28): when `item.photos` is empty, the renderer falls back to `item_group.photo_url` (the group's hero — see §6.11), then to a stock placeholder if no group photo is set either. This means one per-group photo (e.g. one "Electric Strikes" shot) covers every un-photographed item in that group. Phase B adds the upload UX; Phase A locks the field shape.

Multi-photo behavior:
- Drag-to-reorder in the AddItemDialog photo panel (Phase B)
- Hero auto-set to index 0 when an `isHero: true` entry is missing
- Per-photo size cap: 8 MB (parity with staging photos)
- Per-item max photos: 12 (catalog UX gets cluttered beyond that; PDF export sticks to first 6)

### 6.A.6 Pricing fields (Phase A schema; markup engine §6.4 still authoritative)

New field on `item`:
- `list_price numeric(19,4) NULL` — the customer-facing price. When set explicitly, this overrides the markup-engine computation (§6.4). When NULL, the engine computes it as `unit_cost × (1 + markup_pct)` using the highest-priority markup that applies to this item (per-item override → group default → brand default → category default → org default). Catalog cards show the resolved value either way; an amber *"No price set"* state surfaces only when both `list_price IS NULL` AND the markup engine can't resolve a markup (no markup configured anywhere up the chain).

Phase A adds the field + the resolver logic; Phase B adds the editing UX (per-item override input in the ItemDetailDialog, bulk update flow in the Markup Engine sub-page — already spec'd §6.4-6.5).

### 6.A.7 Inventory-side additions (consumes the new taxonomy)

The Inventory page (§5.4.A) picks up the new taxonomy with minimal additive changes — same patterns as the rev-2026-05-27 Category selector:

- **Brand filter pill** on the Showing row, immediately to the right of the existing Location + Category pills. Dropdown lists every configured brand + a sticky "All Brands" reset row + an inline "+ Add new brand" footer that opens AddBrandDialog and auto-selects the new brand as the active filter. Active count + selected-brand chip behavior mirrors Category exactly.
- **Group filter pill** on the Showing row, immediately to the right of Brand. Same component pattern. When a Brand filter is active, the Group dropdown is scoped to that brand's groups only (helper line *"Showing groups under &lt;Brand&gt; (N)"*). When no Brand filter is active, the Group dropdown shows every group across all brands, grouped by brand in section headers.
- **Visibility chip column** in the Items table — `🌐 Catalog` (indigo background, indigo-700 text) or `🔒 Internal` (slate background, slate-600 text). Sits between Category and List Price columns. Click the chip to toggle visibility (admin-gated by `canEditCatalog`).
- **AddItemDialog updates** — new fields:
  - **Brand** dropdown with inline "+ Add new brand" footer
  - **Group** dropdown (filtered by selected Brand; disabled with helper *"Pick a brand first"* when Brand is empty), inline "+ Add new group" footer that creates the group under the selected brand
  - **Visibility** segmented control (Catalog / Internal) — auto-set from item type on type-change; manual override sticks
  - Collapsible *"Customer-facing copy"* section: `customer_name`, `customer_description`, `key_features` (3-5 chips with inline add/remove)
  - Phase B will add the photos panel; Phase A leaves a placeholder note in the dialog footer *"📷 Photo upload ships in Phase B"*.

### 6.A.8 Acceptance criteria (Phase A)

- [ ] Clicking the **Price Book** sidebar sub-item routes to PriceBookPage with the **Items** tab active by default.
- [ ] The page renders four tabs in this order: **Items · Brands · Groups · Categories · Catalog** (Catalog tab shows a Phase-B placeholder strip).
- [ ] **Brands tab** lists every configured brand as a card; "+ Add Brand" opens AddBrandDialog; saving a new brand prepends it to the grid + surfaces a toast. **(rev 2026-05-28)** The brand card shows only the Items count (no Groups count) and no per-brand "+ Add group" pill — Groups no longer subdivide a brand, see §6.11.
- [ ] **(rev 2026-05-28)** **Groups tab — preset bundle browser**: lists every active bundle as a card; "+ New Bundle" opens `AddGroupDialog`; saving a new bundle prepends it to the grid + opens to the new card. Each card renders a format chip ("Flat rate" amber / "Itemized" sky) at top-left of the hero banner, the bundle name + description, a line summary (first 3 lines `{qty}× {name}` + `+N more…` overflow), and a footer row with the **CUSTOMER SEES** price + a color-tone-bucketed **MARGIN %** (emerald ≥ 50% · amber 25–50% · rose < 25%). Hover reveals Edit (pencil) + Delete (trash) over the banner. Search-by-name + format-filter dropdown narrow the grid live.
- [ ] **(rev 2026-05-28)** **Bundle dialog — Individual vs Flat-rate toggle**: `AddGroupDialog` exposes a two-card radio for `groupType`; picking `flat_rate` reveals an optional `flatRatePriceOverride` input below it whose placeholder displays `Default = $X.XX (sum of items)`; leaving the override blank means "use the sum on the customer's estimate," entering a number means "charge this flat price regardless of line totals." Switching back to Individual hides the override input (value is retained in form state until save).
- [ ] **(rev 2026-05-28)** **Bundle lines — real items + free-form**: the items table inside `AddGroupDialog` accepts two row kinds. **Real-item rows** are added via the typeahead search box (matches name / SKU / customer name across the full item catalog) — name is read-only mirror of `item.name`, Qty / Price / Cost cells are editable, and Price/Cost left blank fall through to the referenced item's live `listPrice` / `sellPrice` / `unitCost`. **Free-form rows** are added via the "+ Free-form line" button — name + Qty + Price + Cost are all required-editable, and the row renders a small amber `FREE-FORM` chip below the name input. Both kinds participate in the subtotal + customer-sees totals.
- [ ] **(rev 2026-05-28)** **Bundle live pricing + per-line override**: when no per-line override is set, the bundle reflects each item's current Price Book price automatically — raising an item's `listPrice` immediately updates every bundle that references it. Setting a per-line override pins the override and ignores future changes to the referenced item. Cost overrides behave the same way.
- [ ] **(rev 2026-05-28)** **Bundle save validation**: Name is required; at least one line is required; free-form lines require a non-empty name; quantities must be > 0; flat-rate price override (when present) must be a non-negative number. Invalid save shows an inline rose banner above the form with the specific error.
- [ ] **(rev 2026-05-28)** **Items tab no longer offers a Group filter** (Brand · Category · Visibility only) and the Brand·Group column collapsed to Brand only — the legacy product-family Group concept is gone (see §6.11 redesign).
- [ ] **(rev 2026-05-28)** **Categories tab** is a full CRUD surface — `+ Add Category` in the header opens `AddCategoryDialog` blank; saving prepends the new category to the grid; hovering any category card reveals Edit (pencil) and Delete (trash) over the banner; Edit pre-fills name, trade, description, and the photo preview.
- [ ] **(rev 2026-05-28)** **Categories tab photo upload** — `AddCategoryDialog` accepts PNG / JPG / SVG / WebP ≤ 512 KB through a banner-style picker (2:1 aspect); after save the chosen image renders as the card's hero banner on the Categories tab and the icon-fallback tile is replaced; cards without a photo continue to render the `List`-icon-on-slate-gradient placeholder.
- [ ] **(rev 2026-05-28)** **Category rename cascade** — saving an edit that changes the category name updates `Category.name` AND rewrites every `item.category` that matched the old name in the same render, so no item ever appears uncategorized after a rename.
- [ ] **(rev 2026-05-28)** **Category delete guard** — clicking Delete on a category that any item still references shows `Can't delete "X" — N item(s) still in this category. Re-categorize them first.` and aborts; categories with zero references fall through to the standard confirm prompt and are removed from the grid on accept.
- [ ] **(rev 2026-05-28)** **Items tab category filter reads live state** — adding a new category from the Categories tab (or via the inline "+ Add new category…" path on AddItemDialog) makes it appear in the Items tab's Category filter dropdown without a page reload.
- [ ] **Items tab** lists every item from the catalog with the new Visibility chip column; filter pills Brand / Category / Visibility narrow the list live (Group filter dropped rev 2026-05-28 — see §6.11).
- [ ] **Inventory page Showing row** gains Brand filter pill alongside Location + Category (the previously-spec'd Group filter is removed rev 2026-05-28).
- [ ] **Inventory items table** gains the Visibility chip column; clicking the chip toggles visibility (admin-gated).
- [ ] **(rev 2026-05-28)** **AddItemDialog** captures Brand + Visibility + customer-facing copy fields (the Group field was removed when Groups stopped meaning product families — see §6.11); saving a new item with `type = "material"` defaults `visibility = "catalog"`; saving with `type = "labor"` defaults to `"internal_only"`.
- [ ] The Catalog tab placeholder cleanly states *"Catalog view ships in Phase B"* so visitors don't expect functionality.
- [ ] **(rev 2026-05-28)** Each of the four KPI tiles on the Items tab is a real `<button>` with `aria-pressed` reflecting state; clicking `In Catalog` narrows the items table to catalog-only rows and lights the tile with an indigo ring + `FILTERED` pill; clicking the same tile again clears the filter back to All.
- [ ] **(rev 2026-05-28, single-active rule)** At most one of the four KPI tiles is `aria-pressed="true"` at any moment. Clicking any non-active tile sets that tile's filter AND releases whichever other tile was previously active. Verifiable by clicking each tile in sequence — after every click, exactly one tile (or zero, after a clear-click) is active.
- [ ] **(rev 2026-05-28, single-active rule)** Picking a non-`all` value in the `All visibility` dropdown lights the matching visibility tile (`In Catalog` or `Hidden from Catalog`) AND clears any active photo / price tile in the same tick — the invariant holds across the dropdown entry path too, not just clicks on the tiles themselves.
- [ ] **(rev 2026-05-28)** Clicking `With Photo` narrows the items table to items where `photoUrl` is set; clicking `No Price Set` narrows to items missing both `sellPrice` and `listPrice`. Both are KPI-tile-only filter dimensions (no dropdown counterpart in the filter row).
- [ ] **(rev 2026-05-28)** KPI tile numbers stay stable as the active tile rotates (computed from the full `items` array, not from `filteredItems`); the count chip on the right of the filter row updates to `N of M items` to reflect the active slice.

### 6.A.9 Forward note — what Phase B and Phase C add

- **Phase B**: Catalog tab rendering — grid of photo cards (hero shot + customer_name + list_price pill), photo upload UX on AddItemDialog (drag-to-reorder + camera capture on mobile), customer copy editing UX, "📷 Photo coming soon" placeholder cards for un-photographed items, internal-only items hard-filtered out. **Hero-photo fallback chain** (added rev 2026-05-28 alongside group `photo_url`): when rendering an item card on the Catalog tab or estimate / invoice line, the hero image resolves in this order — `item.photos[0]` (first uploaded item photo, when present) → `item_group.photo_url` (group hero, when the item is assigned to a group with a photo) → a tasteful stock placeholder. This means a single per-group photo (e.g. one electric strike) covers every un-photographed item in the "Electric Strikes" group without the customer ever seeing an empty card, and lets operators populate the catalog visually with one upload per group instead of one per item.
- **Phase C**: Customer-Present Mode fullscreen view (gallery swipe + key features + big price tile), PDF catalog export (printed leave-behind for site visits), shareable customer link (`pricebook.fieldos.com/<org>/<token>`), estimate/invoice line-item `display_mode: 'catalog' | 'minimal'` integration so customer docs render hero photos + marketing copy when set.

Full brand entity spec in §6.10, full item_group entity spec in §6.11, schema diffs in Appendix A.4 + A.2.

### 6.A.10 Implementation status (Phase A — what shipped rev 2026-05-27)

The Phase A spec above was implemented in the v1.1 prototype dashboard at `dashboard/src/`. The following landed end-to-end and is testable on localhost:

**Shipped:**
- ✅ Brand + Item Group entities in `data/inventory.ts` — 6 brands (Mul-T-Lock, Medeco, ASSA Abloy, Schlage, **Kaba** added rev 2026-05-27, Honeywell) and 16 groups across them.
- ✅ Item type extended with `brandId`, `groupId`, `visibility`, `customerName`, `customerDescription`, `keyFeatures`, `listPrice` (Phase B layers photo upload on top of the reserved field).
- ✅ Seed-item backfill — 6 existing items mapped to brand + group (`itm_001` → Mul-T-Lock C-Series, `itm_002` → Schlage ND-Series, `itm_003` → ASSA Abloy HES Strikes, `itm_005` → Schlage LCN Closers, `itm_011` → Kaba Peaks Preferred, `itm_012` → ASSA Abloy HID Readers); `itm_014` Locksmith Labor flipped to `visibility: 'internal_only'` to demo the smart-default-by-kind rule.
- ✅ `PriceBookPage` rewritten from rev-2026-05-27 placeholder to a real **5-tab** page (Items · Brands · Groups · Categories · Catalog). Catalog tab renders a Phase-B placeholder strip so the URL + tab ordering lock in early.
- ✅ Items tab — KPI tiles (In Catalog / Hidden / With Photo / No Price), search input, 4 filter dropdowns (Brand / Group / Category / Visibility), items table with photo thumb · brand+group column · category · resolved price · clickable visibility chip (toggles `catalog` ↔ `internal_only` live).
- ✅ **(rev 2026-05-28)** Items tab — KPI tiles are now **clickable filter triggers with single-active behavior** (§6.A.2.a). All four tiles render as `<button>` with `aria-pressed`. The four tiles behave as a one-of-N radio row — clicking any non-active tile sets that tile's filter AND clears the other three (enforced in every click handler + in the wrapped `setFilterVisibility` setter so the invariant holds across both the tile-click and visibility-dropdown entry paths). Active state shows an indigo ring + a tiny `FILTERED` pill; click the active tile to clear. Verified end-to-end on localhost: clicked `In Catalog` (→ table 14 rows), then `With Photo` (→ `In Catalog` released, `With Photo` lit, 3 rows), then `Hidden from Catalog` (→ `With Photo` released, `Hidden` lit, 1 row), then `Hidden` again (→ all clear, 15 rows). Also drove the visibility dropdown directly to `internal_only` while `No Price Set` was active — `No Price Set` released and `Hidden from Catalog` lit in the same render. (Earlier in the day, the first cut shipped stackable orthogonal photo / price filters; owner reverted same-day to the single-active behavior above — see PB2 decision-log entry.)
- ✅ Brands tab — card grid with brand logo (real 56×56 image per rev 2026-05-28 bullet below; falls back to a 2-letter monogram avatar) + description + item count + group count + default markup + website link + "Add group" CTA per card; hover-revealed Edit / Delete; delete blocked when items reference (alert with count).
- ✅ **(rev 2026-05-28) Brand logos — upload + render end-to-end.** `Brand.logoUrl` (already declared on the type rev 2026-05-27) is now wired everywhere it needs to be: `AddBrandDialog` gained a 64×64 logo tile at the top-left of the form (sibling of the Name field) — clicking it opens a file picker accepting PNG / JPG / SVG / WebP, ≤ 512 KB; on pick the file goes through `FileReader.readAsDataURL` and the resulting data URI is stored on the brand record. A "Remove" link clears the logo. The Brands tab card now leads with a 56×56 logo tile (replacing the small `Tag` icon in the prior rev), with a colored 2-letter-monogram avatar fallback when `logoUrl` is null. All 6 seeded brands ship with pre-rendered monogram-badge SVG logos (Mul-T-Lock → red→amber, Medeco → maroon, ASSA Abloy → blue, Schlage → slate, Kaba → teal, Honeywell → red), encoded inline as `data:image/svg+xml` strings via the new `brandLogoSvg()` helper in `data/inventory.ts` so the prototype demos cleanly with zero CDN dependency. **Production swap-out:** real customer uploads go to object storage (S3 / GCS) with a signed URL returned in `logo_url`; the `data:` URI seeded for the prototype is a v1.1-only convenience. **Scope (rev 2026-05-28):** logos render on the internal Brands tab cards only — Catalog tab + AddItemDialog brand picker + estimates/invoices stay out of scope this rev (deferred to Phase B alongside the rest of the customer-facing Catalog rendering).
- ✅ Groups tab — card grid filterable by brand; each card leads with a hero photo banner (rev 2026-05-28 — real upload when set, slate-gradient + Layers-icon fallback when null), parent-brand chip below the banner; same Edit / Delete guardrail (now floated over the banner top-right per rev 2026-05-28 bullet below).
- ✅ **(rev 2026-05-28) Group hero photos — upload + render end-to-end.** `ItemGroup.photoUrl` is a new column on the group entity (§6.11, Appendix A.4). `AddGroupDialog` gained a **banner-style upload area** (full-form-width, 2:1 aspect, ≈ 192×96) at the top of the form above the Parent Brand picker — same upload mechanics as the brand logo (file picker → `FileReader.readAsDataURL` → data URI on the record; "🗑 Remove" link clears; inline validation rejects wrong MIME / oversize; PNG / JPG / SVG / WebP, ≤ 512 KB). The Groups tab card on `PriceBookPage` was restructured to **lead with a hero banner** (5:2 aspect, full card width, rounded top corners) instead of the prior inline `Layers` icon next to the name — when `photoUrl` is null the banner falls back to a slate-gradient with a centered `Layers` icon (subtle, doesn't compete with populated cards next to it). Edit / Delete buttons now float **over the banner top-right** as backdrop-blurred white pills, visible on hover only — they stay out of the way of the photo's visual weight. **Use case** matches the owner's framing: an "Electric Strikes" group gets a hero photo of an electric strike, an "ND-Series" group gets a cylindrical-lock shot, etc. — so techs and customers recognize the product family at a glance before any individual item is photographed (item-level photos remain a Phase B deliverable). **Scope (this rev):** no seed photos shipped for the existing 16 groups — operators upload photos on a per-group basis during demo / onboarding (per design choice — keeps the prototype lightweight and the populated-state authentic vs. fake-looking placeholder thumbnails). Files: `dashboard/src/data/inventory.ts` (`ItemGroup` type gains `photoUrl?: string`; no seed values), `dashboard/src/components/AddGroupDialog.tsx` (banner upload tile + file picker + Remove + MIME / size validation, mirrors AddBrandDialog), `dashboard/src/components/PriceBookPage.tsx` (Groups tab card restructured — hero banner first, content area second, action buttons floated over banner).
- ✅ **(rev 2026-05-28) Item Groups redesigned — "Group" now means a preset bundle of line items, not a product family within a brand.** The prior product-family `ItemGroup` (C-Series · ND-Series · Peaks Preferred — nested under Brand, referenced by `item.group_id`) was fully retired and the word "Group" was repurposed for Workiz-style **preset bundles** — saved lists of parts + labor + dispatch fees that drop onto an estimate / invoice by name for fast turnaround. **Data model:** `ItemGroup` type rewritten end-to-end on `data/inventory.ts`: `{ id · name · description? · photoUrl? · groupType: "flat_rate" | "individual" · flatRatePriceOverride?: number · isActive · lines: ItemGroupLine[] }`. New `ItemGroupLine` type `{ id · itemId?: string · name · quantity · priceOverride?: number · costOverride?: number · notes? }` — when `itemId` is set the line references a real Price Book item (price / cost pull live from `item.listPrice ?? sellPrice` / `item.unitCost` unless overridden); when `itemId` is undefined the line is **free-form** (operator-typed name + price + cost, used for one-offs like "Travel fee — $50"). `Item.groupId` removed from the type and scrubbed from every seed item via `sed -i '' '/^    groupId: "grp_/d'`. The 16-row `itemGroups` seed (Mul-T-Lock C-Series / MT5+ / Junior · Medeco Maxum / M3 / X4 · etc.) was replaced with 5 realistic bundles that exercise every dialog path: **Standard Rekey Service** (flat $189 / 3 lines including a free-form pinning kit · 41% margin), **Residential Lockout Service** (flat $165 / 2 lines including a free-form travel charge · 73% margin), **Single Door Access Install** (itemized $1,380 / 4 lines — HID reader + DSC panel + HES strike + 2hr labor · 59% margin), **HVAC Capacitor Replacement** (flat $235 / 3 lines including a free-form service-call fee), **Electric Strike Install — Commercial** (itemized / HES strike + weatherseal + 1.5hr labor). **AddGroupDialog rewrite (`xl` modal, ~450 LOC):** banner-style 4:1 photo upload at top → Bundle Name (required) + Active toggle → Description textarea → **Customer-facing format** radio cards (Individual items vs Flat rate, indigo-tinted active state with descriptive subtext) → **Flat-rate price (optional override)** input (only renders when Flat rate is active; placeholder shows `Default = $X.XX (sum of items)`) → **Items in this bundle** panel with a typeahead search box (matches name / SKU / customer name across the full item catalog, max 8 results) and a **+ Free-form line** button → lines table with editable Qty / Price / Cost / Margin% / Amount cells. Real-item rows show a thumbnail + name + SKU sub-line; free-form rows show an editable name input + a small amber **FREE-FORM** chip. Footer rows: **Subtotal (sum of lines)** and **Customer sees (flat rate / itemized)** rendered in indigo bold. Save validates name presence, ≥ 1 line, non-empty free-form names, positive quantities, and (for flat-rate override) a non-negative number — inline rose banner on failure. **GroupsTab rewritten on PriceBookPage (bundle browser):** indigo explainer banner → search-by-name + format-filter dropdown + count chip + **+ New Bundle** CTA → responsive 3-column grid of bundle cards. Each card: hero banner (2:1 aspect — uploaded photo when set, indigo gradient + `Layers` icon fallback otherwise) with a top-left format chip (amber "Flat rate" / sky "Itemized") and optional slate "Inactive" badge; hover-revealed Edit (pencil) + Delete (trash) pills floated top-right with backdrop blur; body with name + description + a slate-tinted line-summary box (`N LINES` + first 3 lines + `+N more…` overflow) + footer with **CUSTOMER SEES $XX.XX** in big indigo and a color-tone-bucketed **MARGIN N%** (emerald ≥ 50% · amber 25–50% · rose < 25%). Empty state: dashed-border card with `Layers` icon + *"No bundles yet — create your first preset bundle"* + CTA. **Cleanup propagated app-wide:** Items tab dropped the `Brand · Group` column → just `Brand`, dropped the Group filter dropdown, removed `itemsByGroup` memo + `groupsFilterBrand` state. Brands tab dropped the "Groups" count tile + the per-brand `+ Add group` pill. AddItemDialog dropped the Group `<select>` (now `Brand · Visibility` — `grid-cols-2` instead of `grid-cols-3`), removed the `itemGroups` prop + `groupId` form field + `groupId` in payload + `handleBrandChange`'s clear-group logic. InventoryPage / NewPODialog / PurchaseOrdersPage dropped their `allItemGroups` / `seedItemGroups` / `initialItemGroups` state, removed the `ItemGroup` type imports, and dropped the `itemGroups={...}` pass-through into AddItemDialog. **Estimate-side integration** (the "type bundle name → auto-generate the estimate" half of the owner's vision) is documented in §6.11 as the next-phase target but **not built in this prototype** — there is no customer-facing Estimate page yet (the existing `EstimateComparisonDialog` is for vendor PO comparison, not customer estimates). Scope this rev was Bundle CRUD only; the bundle-picker on estimates ships when the Estimate page lands. **Verified end-to-end on `localhost:5174`:** navigated Price Book → Groups → confirmed 5 seeded bundles render with correct format chips, line summaries, customer-sees prices, and color-toned margin %s; clicked **+ New Bundle** → confirmed dialog opens with photo banner, name field, both format toggles, items search box, free-form button, and empty lines table; hovered Standard Rekey Service → clicked Edit → confirmed *"Edit Bundle · Standard Rekey Service"* opens with all 3 lines pre-filled at correct qty (1, 1, 1), live prices populated from referenced items (165 from `itm_014` labor, 92 from `itm_001` cylinder), the Flat rate toggle correctly highlighted (`border-indigo-500 bg-indigo-50`), and the $189 flat-rate override pre-filled in the input. Files: `dashboard/src/data/inventory.ts` (type rewrite + new `ItemGroupLine` + `ItemGroupType` export + 5 seed bundles + `groupId` scrub from 6 items), `dashboard/src/components/AddGroupDialog.tsx` (full rewrite as bundle editor), `dashboard/src/components/PriceBookPage.tsx` (GroupsTab + ItemsTab + BrandsTab updates + dialog mount), `dashboard/src/components/AddItemDialog.tsx` (Group field removal), `dashboard/src/components/InventoryPage.tsx` + `NewPODialog.tsx` + `PurchaseOrdersPage.tsx` (legacy ItemGroup references removed).
- ✅ **(rev 2026-05-28) Categories tab — full CRUD with banner-style hero photos + trade tagging.** The prior read-only mirror was replaced with a first-class management surface mirroring the GroupsTab pattern. `Category` type gains `photoUrl?: string` (Appendix A.2). `AddCategoryDialog` was rewritten end-to-end: leads with a **banner-style upload tile** (full-form-width, 2:1 aspect, same dashed-border idle / solid-on-hover affordance and same MIME / size validation as the Brand-logo and Group-photo uploads — PNG / JPG / SVG / WebP, ≤ 512 KB, `FileReader.readAsDataURL` → data URI on the record, "🗑 Remove" link clears), followed by Category Name (required), a new **Trade dropdown** (optional — `Locksmith · Door · Security · HVAC · Plumbing`, surfacing the previously-hidden `Category.trade` field for editing), and Description. Edit mode pre-fills all four fields including the photo preview. `PriceBookPage` CategoriesTab was rewritten from a read-only static-mirror component to an interactive card grid mirroring `GroupsTab`: 2:1 hero banner on top (`<img>` when `photoUrl` is set, slate-gradient + centered `List` icon fallback otherwise), name + trade chip (color-toned per trade — amber locksmith, sky door, violet security, emerald HVAC, cyan plumbing) + description + item count below, hover-revealed Edit / Delete buttons floated top-right over the banner as backdrop-blurred white pills. The misleading *"managed from Inventory page"* callout was removed. CRUD wiring lifts onto the existing `allCategories` state (closing a latent bug where the Categories tab kept showing static seed data while inline-create from the row-click AddItemDialog already updated `allCategories`); the **rename cascade** rewrites every `item.category` that matches the old name when the user changes a category's name (same pattern as the InventoryPage rename cascade); the **delete guard** blocks deletion when any item still references the category and shows a count-prompt before falling through to the standard confirm. **Bonus fix:** Items tab's Category filter dropdown also re-wired to read from `allCategories` so newly-added categories appear in the filter immediately. Verified on localhost: navigated Price Book → Categories, clicked Edit on Cylinders (dialog opened with name `Cylinders`, trade `Locksmith`, description pre-filled), uploaded an SVG via the hidden file input, saved, confirmed the Cylinders card's banner now renders the uploaded `data:image/svg+xml;base64,…` photo and the 13 other categories continue to show the icon fallback. **Scope (this rev):** edits to categories on the Price Book Categories tab are page-local state (matches the Brand / Group prototype convention) — true cross-page sync between InventoryPage and PriceBookPage is a follow-up. Files: `dashboard/src/data/inventory.ts` (`Category` type extension), `dashboard/src/components/AddCategoryDialog.tsx` (rewrite — banner upload + trade picker), `dashboard/src/components/PriceBookPage.tsx` (interactive CategoriesTab, dialog mount with `onCreate`/`onUpdate` handlers + rename cascade through `items`, new `itemsByCategoryName` count map, Items tab category dropdown re-wired to live state).
- ✅ `AddBrandDialog` (new file) — required name + optional logo, website, description, default markup %, default vendor (dropdown of existing vendors), is-active toggle.
- ✅ `AddGroupDialog` (new file) — required name + parent brand (pre-fillable + lockable when opened from a brand detail), optional description, default markup %, is-active toggle.
- ✅ `AddItemDialog` gains a new indigo-tinted **Brand · Group · Visibility** section between Item Kind and Unit Cost. Brand dropdown auto-fills vendor when brand has `defaultVendorId`; Group dropdown is disabled until brand picked + scoped to selected brand; Visibility is a 2-segment control that auto-flips when Item Kind changes (material → catalog, labor → internal_only); footer note *"Photo upload + customer-facing copy ship in Phase B"*.
- ✅ `handleSave` in `InventoryPage.tsx` persists the new `brandId` / `groupId` / `visibility` fields on both create + edit paths.

**Deferred to a follow-up (still spec'd in §6.A.7 — not yet implemented):**
- ⏸ **Brand + Group filter pills on the Inventory page's Showing row** (alongside Location + Category). Skipped this rev because the Inventory items table already serves ops-side use without the new filters, and the same filters ARE present on the Price Book Items tab. Plan: add `BrandSelector` + `GroupSelector` components (modeled on the existing `CategorySelector`) and slot into `InventoryPage.tsx`'s Showing row.
- ⏸ **Visibility chip column on the Inventory items table** (parallel to the chip already shipped on the Price Book Items tab). Skipped for parity — adds a column to a wide table that already needs care; defer until a follow-up cleans up the Inventory table layout.
- ⏸ **Customer-facing copy fields in AddItemDialog** (`customer_name`, `customer_description`, `key_features` editor). Field shape is locked in the data model + on the `Item` type; UI lands in Phase B alongside the Catalog tab rendering.
- ⏸ **`BrandDetailDialog` + `GroupDetailDialog` full detail views with items-in-this-brand list**. Phase A ships create + edit (via the Add dialogs in edit mode) + inline delete; the rich detail dialogs with item lists are Phase B polish.

**Build status:** `npx tsc --noEmit` clean. `npx vite build` succeeds; chunk-size warning is pre-existing and not related to this rev.

## 6.10 `[PROTOTYPE v1.1 rev 2026-05-27]` Brand entity

A **Brand** represents the manufacturer of an item — Mul-T-Lock, Medeco, ASSA Abloy, Schlage, Honeywell, etc. First-class entity with its own CRUD, surfaced as a filter dimension in both Inventory and Price Book, and (in Phase B) used as a card label on customer-facing catalog cards.

**Data model:**

```sql
brand (
  id uuid PK,
  organization_id uuid NOT NULL FK organization(id),
  name text NOT NULL,
  logo_url text NULL,                            -- vendor-logo image; rendered on brand cards + (Phase B) catalog cards
  website text NULL,                             -- public marketing site
  description text NULL,                         -- internal note about the brand (rep contact, payment quirks, etc.)
  default_markup_pct numeric(9,4) NULL,          -- when set, overrides org markup for every item in this brand; per-item / per-group still wins
  default_vendor_id uuid NULL FK vendor(id),     -- the vendor we usually buy this brand from (auto-fills item's vendor on AddItemDialog when brand is picked)
  is_active boolean DEFAULT true,                -- soft-archive; archived brands hidden from new-item dropdowns but kept on historical items
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (organization_id, name)
);

-- Indexes
CREATE INDEX ix_brand_org ON brand(organization_id);
CREATE INDEX ix_brand_org_active ON brand(organization_id) WHERE is_active;
```

**UX — AddBrandDialog:**

- Required: name
- Optional: **logo upload** (single image, square works best, 256×256 recommended, ≤ 512 KB · accepts `image/png` · `image/jpeg` · `image/svg+xml` · `image/webp`) — rendered as a 64×64 tile at the top-left of the form, sibling of the Name input; click the tile to open the native file picker; pick → `FileReader.readAsDataURL` → store on `brand.logo_url`. A small "🗑 Remove" link below the tile clears the logo. In production, the data URI is replaced by an `s3://…` (or equivalent object-storage) signed URL on upload-commit; for the v1.1 prototype the data URI is persisted as-is so localStorage round-trips work without a backend.
- Optional: website URL (validated), description textarea, default markup %, default vendor (dropdown of existing vendors with inline "+ Add new vendor"), is_active toggle (defaults to true)
- Same dialog component pattern as AddCategoryDialog / AddVendorDialog
- Save creates the row, prepends to brand list, surfaces toast *"✓ Brand '&lt;name&gt;' added"*

**UX — BrandDetailDialog:**

- Read-only by default; pencil icon flips to edit mode (admin-gated by `canEditCatalog`)
- Shows: logo · name · website · description · default markup · default vendor · is_active toggle · created_at · updated_at
- **Items in this brand** section — table of every item where `item.brand_id = brand.id`, with quick filter / search; click an item row → opens ItemDetailDialog
- **Groups in this brand** section — list of every `item_group` where `brand_id = brand.id`; click → opens GroupDetailDialog
- Footer: Close · Save Changes (when in edit mode) · Delete (admin-gated, blocked when items still reference the brand — same guardrail as Category delete in rev 2026-05-27)

**Seed (v1.1 prototype):**

Six brands seeded to demonstrate the populated state and exercise the taxonomy:
1. **Mul-T-Lock** — high-security cylinders, padlocks (default vendor: ASA / Mul-T-Lock NA)
2. **Medeco** — high-security cylinders, deadbolts
3. **ASSA Abloy** — commercial locks, electric strikes, HES, HID (default vendor: Allegion / Banner Solutions)
4. **Schlage** — residential + commercial deadbolts, LCN closers (Allegion family) (default vendor: Allegion / Banner Solutions)
5. **Kaba** — dormakaba Peaks Preferred high-security cylinders + Simplex pushbutton locks *(added rev 2026-05-27 to map the existing seeded item `itm_011` Kaba Peaks Preferred)*
6. **Honeywell** — access control, sensors, intrusion + fire alarm panels (default vendor: ADI / Anixter)

**Acceptance criteria:**

- [ ] Brands tab on PriceBookPage lists all 6 seed brands as cards.
- [ ] "+ Add Brand" opens AddBrandDialog; saving a new brand prepends to the grid.
- [ ] **(Phase B — deferred per §6.A.10)** Brand card click opens BrandDetailDialog with editable fields + items-in-this-brand list. *Phase A ships create + edit via AddBrandDialog in edit mode (hover ✏ icon) + inline delete; the rich detail dialog with the items list is Phase B polish.*
- [ ] Deleting a brand is blocked when any item still references it; warning toast surfaces the count and asks the user to re-assign first.
- [ ] Setting `default_markup_pct` on a brand AND leaving per-item `list_price` empty results in the catalog card showing the computed price (`unit_cost × (1 + brand.default_markup_pct)`), assuming no group-level or per-item override is set.
- [ ] Brand's `is_active = false` removes it from new-item dropdowns but keeps it visible on historical items.
- [ ] **(rev 2026-05-28)** Uploading a logo on AddBrandDialog → save → the new brand's card on the Brands tab renders the uploaded image as a 56×56 tile at the top-left of the card. Removing the logo on edit reverts the card to a 2-letter-monogram avatar in the same slot.
- [ ] **(rev 2026-05-28)** All 6 seeded brands (Mul-T-Lock, Medeco, ASSA Abloy, Schlage, Kaba, Honeywell) render distinct, recognizable monogram-badge logos out of the box without any user upload.
- [ ] **(rev 2026-05-28)** Uploading a file larger than 512 KB or a non-image MIME (`.pdf`, `.docx`, etc.) shows an inline error message and does not write to `brand.logo_url`.

## 6.11 `[PROTOTYPE v1.1 rev 2026-05-28]` Item Group entity (preset bundles)

> **Concept changed rev 2026-05-28.** The prior `ItemGroup` represented a product family within a Brand (Mul-T-Lock C-Series, Schlage ND-Series, Kaba Peaks Preferred) and items referenced their group via `item.group_id`. That concept was retired in the Item Groups redesign. The word "Group" is now repurposed for **preset bundles** — saved lists of line items (parts + labor + dispatch fees) that drop onto an estimate or invoice by name. Items no longer reference groups; lines inside a group reference items.

An **Item Group** is a saved bundle of line items used to populate estimates and invoices fast. Each bundle picks a customer-facing display mode and holds a list of lines.

**Customer-facing display modes:**

- **`individual`** — every line surfaces as its own row on the customer's estimate / invoice (parts + labor itemized; the customer sees the breakdown).
- **`flat_rate`** — the bundle renders as **one lump-sum line** on the estimate. The underlying lines stay internal for cost / margin tracking. The customer-facing price defaults to the sum of lines but can be overridden via `flat_rate_price_override` (e.g. *"Standard Rekey: $189 flat"* even if parts only sum to $282).

**Line semantics:**

- **Real-item line** (`item_group_line.item_id` set) — references a Price Book item. The line's price / cost pull live from `item.list_price` / `item.sell_price` / `item.unit_cost` by default. `price_override` and `cost_override` can pin a per-bundle value (e.g. "labor in the Standard Rekey bundle is $40/hr even if the standard labor item lists $50/hr"). Changing an item's price later automatically reflects in every bundle that doesn't override.
- **Free-form line** (`item_group_line.item_id IS NULL`) — operator-typed name + price + cost. Used for one-off charges like *"Travel fee — $50"* or *"Custom permit"* that don't deserve a standing inventory item. `name` and `price_override` are required for free-form lines.

**Data model:**

```sql
-- [PROTOTYPE v1.1 rev 2026-05-28 §6.11] Item Group — preset bundle of line items
CREATE TYPE item_group_type_enum AS ENUM ('flat_rate', 'individual');

item_group (
  id uuid PK,
  organization_id uuid NOT NULL FK organization(id),
  name text NOT NULL,                                          -- e.g. "Standard Rekey Service"
  description text NULL,                                       -- one-liner shown on card + dialog
  photo_url text NULL,                                         -- hero photo on the Groups tab card; prototype inlines data: URI via FileReader, production = signed object-storage URL
  group_type item_group_type_enum NOT NULL DEFAULT 'individual',
  flat_rate_price_override numeric(12,2) NULL,                 -- only meaningful when group_type='flat_rate'; NULL = use sum of lines
  is_active boolean NOT NULL DEFAULT true,                     -- archived bundles hide from estimate / invoice picker
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE INDEX ix_item_group_org_active ON item_group(organization_id) WHERE is_active;

-- [PROTOTYPE v1.1 rev 2026-05-28 §6.11] Item Group Line — one row per line in a bundle
item_group_line (
  id uuid PK,
  item_group_id uuid NOT NULL FK item_group(id) ON DELETE CASCADE,
  sequence int NOT NULL DEFAULT 0,                             -- display order inside the bundle
  item_id uuid NULL FK item(id) ON DELETE RESTRICT,            -- NULL = free-form line
  name text NOT NULL,                                          -- mirror of item.name for real-item lines; operator-typed for free-form
  quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
  price_override numeric(12,2) NULL,                           -- override item's list price; REQUIRED for free-form lines
  cost_override numeric(12,2) NULL,                            -- override item's unit cost
  notes text NULL,                                             -- optional per-line note shown below name in editor
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (item_id IS NOT NULL OR price_override IS NOT NULL),   -- free-form lines must carry a price
  CHECK (item_id IS NOT NULL OR length(trim(name)) > 0)        -- free-form lines must carry a name
);

CREATE INDEX ix_item_group_line_group_seq ON item_group_line(item_group_id, sequence);
CREATE INDEX ix_item_group_line_item ON item_group_line(item_id) WHERE item_id IS NOT NULL;

-- The legacy item.group_id column was DROPPED in this rev — items no longer
-- reference groups; lines inside groups reference items via item_group_line.item_id.
-- ALTER TABLE item DROP COLUMN group_id;
```

**Computed values (application layer):**

- `line.effective_price = COALESCE(line.price_override, item.list_price, item.sell_price, 0)` — used on the customer's estimate when the bundle is dropped in.
- `line.effective_cost  = COALESCE(line.cost_override,  item.unit_cost, 0)` — used for internal margin tracking.
- `bundle.subtotal = SUM(line.effective_price × line.quantity)` for every line in the bundle.
- `bundle.cost_basis = SUM(line.effective_cost × line.quantity)`.
- `bundle.customer_price = (group_type = 'individual') ? subtotal : COALESCE(flat_rate_price_override, subtotal)` — what the customer sees as the bundle's total / line price on the estimate.
- `bundle.margin_pct = (customer_price - cost_basis) / customer_price × 100`.

**UX — AddGroupDialog (bundle editor, `xl` modal):**

1. **Hero photo** (optional) — banner-style 4:1 picker at top, accepts `image/png` / `jpeg` / `svg+xml` / `webp` · ≤ 512 KB · `FileReader.readAsDataURL` → data URI (prototype) → signed object-storage URL (production). "🗑 Remove" link clears.
2. **Bundle Name** (required) + **Active** toggle in a side-by-side row.
3. **Description** (optional) — textarea, one-line summary shown on the bundle card.
4. **Customer-facing format** — two radio cards (indigo-tinted active state): **Individual items** ("Every line shows on the estimate — parts + labor itemized") vs **Flat rate** ("One lump-sum line on the estimate. Items stay internal.").
5. **Flat-rate price (optional override)** — only renders when group_type = 'flat_rate'. Numeric `$` input with placeholder `Default = $X.XX (sum of items)`. Leaving blank means "use the sum on the customer's estimate"; entering a number means "charge this flat price regardless of line totals."
6. **Items in this bundle** panel with a typeahead search box (matches name / SKU / customer name across the full item catalog — max 8 results dropdown) + a **+ Free-form line** button.
7. **Lines table** with columns Item · Qty · Price · Cost · Margin% · Amount · 🗑. Real-item rows show a thumbnail + name + SKU sub-line; free-form rows show an editable name input with a small amber `FREE-FORM` chip below. Qty / Price / Cost are all editable inline. Leaving Price or Cost blank on a real-item row means "use the referenced item's live price / cost."
8. **Footer rows**: **Subtotal (sum of lines)** + **Customer sees (flat rate / itemized)** — the latter rendered in big indigo bold (reflects either `flatRatePriceOverride` or the sum, depending on group_type + override presence).

**Save validation:** name required; ≥ 1 line; free-form lines require non-empty name; quantities > 0; flat-rate override (when set) ≥ 0. Failures render in a rose banner above the form.

**UX — GroupsTab on PriceBookPage (bundle browser):**

- Indigo explainer banner at top: *"Preset bundles for fast estimate + invoice creation. Build a bundle once (parts + labor + dispatch fees), then drop it onto any estimate by name — every line populates automatically. Pick Individual items to show the breakdown to the customer, or Flat rate to charge a single lump sum."*
- Filter row: search-by-name input · format-filter dropdown (All formats / Individual items / Flat rate) · `N of M bundles` count chip · **+ New Bundle** primary CTA.
- 3-column responsive grid of bundle cards. Each card:
  - **Hero banner** (2:1 aspect) — `<img>` when `photo_url` is set; indigo-tinted gradient + `Layers` icon fallback otherwise.
  - **Top-left format chip** over the banner — amber pill "Flat rate" or sky pill "Itemized". Optional slate "Inactive" pill below it when `is_active = false`.
  - **Top-right Edit / Delete pills** — backdrop-blurred white pills floated over the banner, hover-revealed (`opacity-0` → `opacity-100`).
  - **Body**: bundle name (h3) + description + a slate-tinted line-summary box (`N LINES` header + first 3 lines as `{qty}× {name}` + `+N more…` overflow when > 3).
  - **Footer**: bottom-aligned row with **CUSTOMER SEES $XX.XX** in big indigo (left) and a color-tone-bucketed **MARGIN N%** (right; emerald ≥ 50% · amber 25–50% · rose < 25%). When `group_type = 'flat_rate'` AND `flat_rate_price_override` differs from subtotal, a small `items sum: $X.XX` line appears below the customer-sees price.
- **Empty state**: dashed-border card with `Layers` icon + *"No bundles yet — Create your first preset bundle. Standard rekey jobs, lockout service, HVAC capacitor swap — bundle them once and reuse on every estimate."* + an inline **+ New Bundle** CTA.

**Seed (v1.1 prototype):** 5 bundles that exercise every dialog path:

| Name | Format | Customer Price | Lines | Notes |
|---|---|---|---|---|
| Standard Rekey Service | Flat rate | $189 (override) | 3 (labor + cylinder + free-form pinning kit) | Demonstrates flat-rate override + free-form line |
| Residential Lockout Service | Flat rate | $165 (override) | 2 (0.5hr labor + free-form travel) | Demonstrates partial-hour qty + free-form |
| Single Door Access Install | Individual | $1,380 (computed) | 4 (HID reader + DSC panel + HES strike + 2hr labor) | Demonstrates itemized format, no override |
| HVAC Capacitor Replacement | Flat rate | $235 (override) | 3 (capacitor + 1hr labor with per-line price override + free-form service-call fee) | Demonstrates per-line price override |
| Electric Strike Install — Commercial | Individual | computed | 3 (HES strike + weatherseal kit + 1.5hr labor) | Demonstrates itemized + fractional qty |

**Acceptance criteria:**

- [ ] Groups tab on PriceBookPage lists every active bundle as a card; "+ New Bundle" opens `AddGroupDialog`; saving a new bundle prepends it to the grid.
- [ ] Search box narrows the grid by name + description match; format-filter dropdown narrows by `group_type`.
- [ ] Hovering a bundle card reveals Edit (pencil) + Delete (trash) pills over the banner top-right; Delete shows a confirm prompt mentioning that estimates already saved with the bundle are unaffected.
- [ ] `AddGroupDialog` exposes a two-card radio for `groupType`; picking `flat_rate` reveals the `flatRatePriceOverride` input with placeholder showing the computed sum; switching back to `individual` hides the input.
- [ ] Adding a real-item line via the typeahead search creates a row with the item's name pre-filled (read-only mirror), qty default 1, and Price / Cost cells showing the item's live values as placeholders (blank inputs = "use live").
- [ ] Adding a free-form line via the "+ Free-form line" button creates a row with editable name + qty + price + cost (all required); the row displays a `FREE-FORM` amber chip.
- [ ] Setting `price_override` on a real-item row pins the override; clearing the input falls back to the referenced item's live price.
- [ ] The dialog's subtotal row updates live as quantities / prices change; the Customer sees row reflects `flat_rate_price_override` when set, or the sum otherwise.
- [ ] Save validates: non-empty name, ≥ 1 line, free-form name required, quantity > 0, flat-rate override ≥ 0 — failures render in a rose banner above the form.
- [ ] Bundle card footer shows `CUSTOMER SEES $X.XX` in indigo and `MARGIN N%` color-toned (emerald ≥ 50% · amber 25–50% · rose < 25%); flat-rate bundles with an override different from the sum show `items sum: $X.XX` below the customer-sees price.
- [ ] Empty Groups tab shows the dashed-border empty-state card with a clear CTA.

**Forward note — estimate-side flow (next phase, not built this rev):** the "type the bundle name on an estimate → every line auto-populates" half of the vision lands when the customer-facing Estimate page ships. The bundle picker will be a typeahead on the estimate's line-items table that, on selection, expands the bundle: for `group_type = 'individual'` it appends each line as its own row (with `price = line.effective_price`); for `group_type = 'flat_rate'` it appends a single line at `bundle.customer_price` and the underlying lines render only in the internal margin view. Bundle deletions never retroactively edit estimates that already include them — saved estimates are immutable snapshots. The bundle-picker UX, the expand-vs-collapse toggle for flat-rate bundles on the internal margin view, and the "edit-in-place" overrides at the estimate level are all spec'd alongside the Estimate page in a future PRD section.

## 6.1 Data Model Summary

Per Agent 3 + A6/A41/A43:
- `catalog_item` (service / material / labor / bundle / fee / discount)
- `catalog_item_component` (BOM/bundle composition, GBB option groups)
- `catalog_option_group` + `catalog_option_group_member` (GBB / single-select / multi-select)
- `markup_rule` + `markup_rule_tier` (cost-band markup with rounding rules + margin floors)
- `price_book` + `price_book_version` (versioned publish, effective-dated)
- `price_book_entry` (immutable ledger of resolved prices)
- `price_tier` (quantity breaks)
- `customer_price_override` (per-customer one-off)
- `contract_price` (Agreement-tied negotiated)
- `vendor_cost` (cost ledger, effective-dated)
- `price_history` (audit of sell-price changes)
- **`brand`** `[PROTOTYPE v1.1 rev 2026-05-27]` — manufacturer entity (Mul-T-Lock, Medeco, ASSA Abloy, …); see §6.10
- **`item_group`** `[PROTOTYPE v1.1 rev 2026-05-28 — redesigned]` — preset bundle of line items for fast estimate / invoice creation (Standard Rekey, Camera Install Kit, Lockout Service, …). Formerly product-family-within-a-brand (C-Series, Maxum, Primus) — that concept was retired; the table was repurposed. See §6.11.
- **`item_group_line`** `[PROTOTYPE v1.1 rev 2026-05-28]` — one row per line in a bundle; references a real item OR carries a free-form name + price. See §6.11.
- **`item.brand_id`** + **`item.visibility`** + **`item.customer_name`** + **`item.customer_description`** + **`item.key_features`** + **`item.photos`** + **`item.list_price`** — Phase A field extensions to the existing `item` row (Appendix A.2); see §6.A.3–6.A.6. **(`item.group_id` was dropped rev 2026-05-28 when the Item Groups redesign retired product families — items no longer reference Groups; Groups reference items via `item_group_line.item_id` instead.)**

## 6.2 Item Taxonomy

`catalog_item.kind`: service / material / labor / bundle / fee / discount.
`catalog_item.pricing_model`: unit / hourly / flat_rate / formula / bundle_fixed / sum_components.

**`[PROTOTYPE v1.1]` Category as first-class entity:**

Categories are no longer free-text on `catalog_item.category`. They live in a managed list:

```sql
category (id uuid PK, organization_id uuid FK, name text, trade trade_type_enum NULL,
          description text,
          photo_url text NULL,                  -- [PROTOTYPE v1.1 rev 2026-05-28 §6.A.10] hero photo for the category, rendered as a 2:1 banner on Price Book → Categories cards; prototype inlines a data: URI via FileReader, production swaps to a signed object-storage URL
          created_at, updated_at, deleted_at)
catalog_item.category_id uuid FK category(id)   -- replaces free-text category column
```

UX consequence: every place that asked for a category (Add Item, Edit Item, bulk import) presents a dropdown of the org's categories with **"+ Add new category…"** as the last option (opens nested AddCategoryDialog). ~~Categories may be optionally **scoped to a trade** — trade-scoped categories surface first under the matching trade, then "Other trades" optgroup. Trade-agnostic categories (Labor, Service, etc.) always show.~~ **Superseded (rev 2026-05-26)** — every category is now org-wide; the "Scope to Trade" pill picker was removed from AddCategoryDialog because the CRM is trade-agnostic by design. Category dropdowns list every category flat with no per-trade grouping. The schema field `category.trade` is retained as nullable and defaults to `NULL` for new categories; existing trade-scoped seed categories remain readable but are not surfaced in the new UI. **Re-surfaced (rev 2026-05-28)** — AddCategoryDialog (now used as a co-equal management surface on both InventoryPage and the Price Book Categories tab) once again exposes a **Trade dropdown** (optional, no `None` requirement) so operators can tag new categories with a trade for filtering and reporting; existing categories keep their pre-rev-2026-05-26 trade tags rather than losing them.

**`[PROTOTYPE v1.1 rev 2026-05-28]` Category photo for visual recognition.** The `category` row gains a `photo_url` column for an optional hero shot of the part type — so the Price Book → Categories tab renders a Cylinders / Strikes / Capacitors photo on each card instead of a generic icon. Upload UX in AddCategoryDialog matches the Brand-logo and Group-photo flows (banner-style 2:1 picker, PNG / JPG / SVG / WebP ≤ 512 KB, FileReader → data URI in the prototype, signed object-storage URL in production); the Price Book Categories tab card renders the photo as a 2:1 hero banner with a slate-gradient + List-icon fallback when null (see §6.A.2 + §6.A.10).

14 starter categories ship with the trade-template defaults: Cylinders, Locksets, Electric Strikes, Alarm Panels, Door Closers, Capacitors, Air Filters, Refrigerant, Copper Pipe, PEX Tubing, Access Readers, Weather Seals, Labor, Service.

## 6.3 Good/Better/Best Handling

- GBB engine ships in v1 [A8].
- Default ON for residential-leaning trade templates (HVAC, plumbing residential, garage door residential).
- Default OFF for commercial-leaning trade templates (locksmith commercial, security, commercial door, fire & life safety, commercial roofing).
- Tenant override always available, per quote / per customer / per job type.
- Customer Present Mode rendering: side-by-side on tablet, stacked on phone, single recommended-option badge, plain-language scope bullets, 1-2 proof photos, lead time, warranty/membership impact, financing teaser (Wisetack).

## 6.4 Markup Engine

- Cost-band tiers (different markup % at different cost ranges) `[A43]`.
- Margin floors (block sell prices below configured GM).
- Rounding rules (nearest cent, nearest dollar 99, etc.).
- Cost source enums: manual / vendor_cost / inventory_avg_cost / last_vendor_cost.
- Modifier rules: after-hours premium, emergency surcharge, member discount.
- Simulate-before-publish: preview margin impact + price changes count before commit.
- Sane defaults per trade template (prevent ServiceTitan's "20% adoption of Dynamic Pricing" trap).

## 6.5 Bulk Update Workflow

- CSV import: upload → preview → AI auto-categorize new SKUs (AI feature A4) → validate → publish as new `price_book_version`.
- Category rules: "apply +12% markup to category=Filters" → preview → publish.
- AI cleanup: detect outliers (margin too low, duplicate SKUs, missing categories) → suggest fixes → user accept/reject.
- Always versioned + reversible.

## 6.6 Customer-Specific Pricing & Memberships

All three overlay mechanics ship v1 `[A41]`:

- **Customer overrides**: one-off price for specific customer's specific item. Priority + effective-from/effective-to.
- **Contract pricing**: tied to `Agreement` object; member rate per customer + term-bounded.
- **Membership tier pricing**: two-column member/non-member presentation (Sera pattern). Settable at branch/department level.

Resolution order: customer override → contract price → membership tier → standard price book entry → cost+markup fallback. Resolution source returned to API caller for transparency.

## 6.7 Mobile Presentation Flow (Customer Present Mode)

- Two-surface model: **Tech Edit Mode** (internal: cost, margin, vendor, mapping, rules) vs **Customer Present Mode** (clean: options, photos, narratives, financing).
- "Rotate to customer view" is a deliberate animated mode change with privacy scrub (Agent 5).
- Three pricing states for tech: standard / guardrailed adjust / approval-required `[A50]`.
- Customer signature: own-device link via SMS/email default, in-person fallback `[A32]`.
- Change orders preserve signed baseline as child object `[A33]`.

## 6.8 Content Strategy

- **BYO content** [A1]. Product never ships flat-rate content. Trade templates ship structure + 10-15 placeholder service names per trade [A52].
- AI catalog ingestion accelerates BYO (A4) — CSV upload + AI categorize + review workbench.
- No partnership with Profit Rhino / New Flat Rate / Coolfront in v1 (their content covers HVAC/plumbing/electrical only — not Emanuel's wedge trades anyway).

## 6.9 Acceptance Criteria

- [ ] Owner can bulk-import 1000+ SKUs via CSV with AI auto-categorization in <10 min including review.
- [ ] Tech can present GBB on phone in Customer Present Mode with rotate animation + privacy scrub.
- [ ] Customer can sign on own device via SMS link; signature event audit-logged.
- [ ] Markup rule simulation shows price changes count + margin impact before publish.
- [ ] Customer override pricing resolves with source attribution in API response.

---

# 7. Purchase Order Module — Functional Requirements

## 7.1 Data Model Summary

Per Agent 3 + A5/A49:
- `vendor`, `purchase_order`, `purchase_order_line`
- `purchase_order_approval`, `purchase_order_status_history`
- `purchase_receipt`, `purchase_receipt_line`
- `vendor_bill`, `vendor_bill_line`
- `vendor_return` (new for v1)
- `credit_memo` (new for v1)
- `three_way_match_exception`

## 7.2 PO Creation Flows

Four entry points:
1. **Manual** — back-office draft.
2. **From low stock** — auto-suggest based on min/max + truck profile + pipeline.
3. **From job** — "Need part" on Job screen → check truck/nearby/warehouse first → Create PO if none viable (Agent 5 — never let PO become patch for broken inventory UX).
4. **From estimate** — material reservation for approved estimate.

Progressive disclosure: vendor + need-by + job + items now; finance completes back-office fields async [Agent 2 wedge vs ServiceTitan's mandatory-fields tyranny].

### 7.2.A `[PROTOTYPE v1.1]` PO Preview + Print as PDF

**Need:** Every popup that references a Purchase Order must offer a one-click way to **preview the PO as a fully-formatted document** and **print it / save it as PDF**. This is the operator's "I need to actually look at the paperwork" affordance — used during receiving, picking up from the vendor counter, transferring stock against a PO, restocking against a vendor PO, and creating a staging entry from a logistics order.

**Where the affordance appears (single source of truth — `POPreviewDialog`):**
- **CreateStageDialog** — two parallel affordances:
  - **Inline** next to the "Linked to PO-XXXX" chip in the line-items section, a small Eye-icon **Preview PO** chip.
  - **Footer** between *Cancel* and *Create Pickup* — a full-sized **Preview PO** button with Eye icon, so the operator can confirm the source document without scrolling back up. Disabled with a tooltip ("Link a PO above to enable preview") when no PO is linked yet; clicking falls back to the `prefilledFromPO` when the dialog was opened from the From-PO picker.
- **StagingView "From PO" picker** — every row in the dropdown shows a Preview button next to the lines/units summary so logistics can verify the document before committing to stage from it.
- **StagingView stage-card line items** — the per-line PO number is rendered as an indigo Eye-icon button that opens the preview.
- **StageDetailDialog** — same per-line treatment: PO number is a clickable Eye-icon button.
- **TransferDialog** — when the destination is a PO (`pickedPO`), the "PO staging" destination card shows a **Preview PO** button in the corner.
- **RestockDialog** — when `source = vendor_po`, a Preview button sits next to the reference-number input; the input also gets a `<datalist>` of all known PO numbers; Preview is disabled until the typed reference matches a real PO.

**Document layout (`POPreviewDialog`):**
- Letter-sized, 14mm × 16mm margins; `@media print` CSS isolates `.po-print-root` from the rest of the page, hides the modal chrome / sidebar / nav, and prints only the document.
- **Header:** FieldOS logo tile + Branch (name, address, phone, manager) on the left · "PURCHASE ORDER" label + bold PO number + status badge on the right.
- **Two columns:** Vendor block (name, category, pickup address, email, account #, payment terms, lead time) · Ship-To block (FieldOS · Branch · Address) and a highlighted "For Job" card showing job#, customer, and site if the PO is linked to a job.
- **Meta strip:** Order Date · Expected · Trade · PO #.
- **Line-items table:** # · SKU · Description · Qty · UoM · Unit Cost (looked up from the price book's `items.unitCost`) · Extended · Recv'd (`qtyReceived / qtyOrdered`).
- **Totals:** Subtotal, Tax, Total — right-aligned, monospace.
- **Signature block:** Authorized By (branch manager) + Vendor Acknowledgement. Authorized-By is now a live **inline e-signature** (`<SignatureField>` — see §7.4.A.8) — type-to-sign with Caveat cursive preview + adopt-and-reuse. Vendor Acknowledgement remains a static placeholder line because the vendor signs via their own emailed tokenized link (rev 2026-05-26).
- **Footer:** "FieldOS · PO-#### · Generated MMM D, YYYY" + Page 1 of 1.

**Footer actions:**
- **Close** (secondary)
- **Email PO** (rev 2026-05-26, secondary, Mail icon, outlined indigo) — opens nested `POEmailDialog` (`zIndex={80}`, `lockEscape`) with vendor sales + vendor orders + branch buyer + AP + purchasing as suggested recipients; To pre-filled with `sales@<vendor-domain>`; Cc pre-filled with the branch buyer; subject `Purchase Order · <PO#> · <Vendor>`; body lists ship-to + order/expected dates + every line with received/ordered counts + an "Acknowledge receipt + confirm expected ship date" CTA; attachment chip `po-<PO#>.pdf`. On send, fires parent `onEmailSent({poNumber, to, subject})` → StagingView toasts `✉ PO <#> emailed to N recipient(s) · <first-email>`.
- **Save as PDF** (secondary, Download icon) — triggers `window.print()`; the browser's native print dialog includes "Save as PDF" as a destination, so no extra library is required for the prototype.
- **Print** (primary, Printer icon) — also `window.print()`.
- Helper microcopy: *"Browser print dialog includes 'Save as PDF' as a destination."*

**Nesting:** `POPreviewDialog` opens at `zIndex={80}` with `lockEscape` set when launched from inside another dialog (CreateStageDialog, StageDetailDialog, TransferDialog, RestockDialog) so the parent modal stays mounted and Esc closes only the preview.

**Graceful fallback:** When the supplied PO number can't be resolved (e.g. archived in an external ERP), the dialog renders a small amber notice — *"The requested PO could not be loaded for preview. It may have been archived or live in an external system. Try opening it from Inventory → Purchase Orders."* — instead of failing silently.

**Acceptance criteria:**
- Every popup that displays a PO number includes a visible affordance (Eye-icon button or chip) to open the preview.
- Preview opens in <100 ms with no fetch (driven by `purchaseOrders` seed + `items` price-book join).
- Pressing **Print** prints only the document — sidebar, top bar, and modal chrome are hidden via `@media print`.
- Pressing **Save as PDF** opens the same OS print dialog so the operator can choose "Save as PDF" as a destination.
- The preview is read-only — edits to the PO happen on the Purchase Orders sub-page, not from inside the preview.

### 7.2.B `[PROTOTYPE v1.1]` RFQ comparison — "Get 3 Estimates" before the PO (rev 2026-05-26)

**Why:** the cheapest path to a PO is to send the line items to **3 preferred vendors first**, collect their quotes, and pick the best one — not to default to whoever supplied the catalog. Real ops teams already do this manually over email; FieldOS makes the request, the comparison, and the vendor-swap inline.

**Entry point:** The **"📋 Get 3 Estimates"** button (amber, ClipboardList icon) lives in the `CreateStageDialog` footer between Cancel and Preview PO. Visible whenever the dialog is open; disabled until at least one line item has a quantity. Same dialog handles both "New Job Pickup" (no PO) and "New Job · from PO-####" (PO-prefilled) variants — in the PO-prefilled case, hitting Get 3 Estimates effectively asks *"what if we swap the supplier on this PO before committing?"*.

**Quote generator** (`src/lib/rfq.ts` · `generateQuotes(lines: RFQLine[]): VendorQuote[]`):

| Step | Logic |
|---|---|
| 1. Pick candidates | First = catalog default vendor for the highest-extension line. Next two = alphabetical from `vendors` excluding `Internal` and excluding the first. Pad if fewer than 3 distinct vendors exist. |
| 2. Variance | Per-vendor multiplier `[1.0, 1.07, 0.93]` × per-line ±3% noise (hash-stable so re-opens are consistent). |
| 3. Stock | The #2 candidate has a deterministic chance per line of being on backorder; those lines get a `BO` flag + add 3 days to their leadTimeDays. |
| 4. Reliability | `3.5 + hash01(vendor.id) × 1.5` → 3.5–5.0 stars. |
| 5. Past jobs | `4 + hash01("vendor.id\|past") × 56` → 4–60 jobs. |
| 6. Composite | `composite = price_score × 0.6 + lead_score × 0.25 + reliability_norm × 0.15` where each `*_score` is normalized to the best value in this RFQ. |
| 7. Winner | Highest composite gets `recommended: true`. Tie-break on lowest total. |

`quoteSuperlatives(quotes)` also returns `{cheapestVendorId, fastestVendorId, mostReliableVendorId}` so the UI can pin orthogonal callouts even when they don't match the composite winner.

**Component:** `<EstimateComparisonDialog>` (`src/components/EstimateComparisonDialog.tsx`)

Props: `{ open, onClose, lines: RFQLine[], onPickWinner(quote), zIndex?, lockEscape? }`. Mounts nested at `zIndex={80}` with `lockEscape` so the parent CreateStageDialog stays alive.

Layout:

1. **Recommendation banner** (emerald gradient, full-width) — 👑 Crown badge · *"RECOMMENDED"* · vendor name · *"Best composite score across price · lead time · reliability"* · winner total + lead + stars + past-jobs count on the right.
2. **3-column quote-card grid** (`lg:grid-cols-3`, single-column on smaller viewports). Each card has:
   - Header: vendor name (Crown icon if winner) · `#1 / #2 / #3` rank chip · category · payment terms.
   - Totals row: large `$X,XXX.XX` font-mono + either a green `TRENDING-DOWN CHEAPEST` chip OR `+X.X% vs cheapest` rose label.
   - KPI row: `Timer N-day lead` + `Zap FASTEST` chip (if applicable) · stars + `Flame TOP-RATED` chip (if applicable).
   - Subline: `N past jobs · vendor.transmitMethod`.
   - Amber note (if any items on backorder).
   - Per-line breakdown table: `Item (SKU + BO flag) · Qty · Unit · Ext`.
   - Per-card CTA: emerald **"Use This Vendor (Recommended)"** on the winner, slate outlined **"Use [Vendor] Anyway"** on the others.
3. **Scoring explainer** (slate footer card) — formula + how each metric is normalized + tie-break rule.
4. **"RFQ Sent To 3 Vendors"** card listing the line items being quoted on (truncated to first 4 + `+N more…` overflow).
5. **Footer CTAs:** Cancel · emerald primary **"Use Recommended · &lt;Vendor&gt;"** (disabled if no quotes).

**Apply winner (`CreateStageDialog.applyWinningQuote`):**

- Writes the winner's `vendor.name` onto every draft line in the form.
- Pre-fills each line's `expectedDate` from the quote's per-line `leadTimeDays` if the user hasn't already set one (`now + leadTimeDays`).
- Closes the comparison dialog.
- Surfaces an inline emerald toast in the CreateStageDialog body: *"🏆 &lt;Vendor&gt; selected from N-item RFQ · all lines updated"* (auto-dismiss 4.5s).
- Parent CreateStageDialog stays mounted so the operator can finalize details and click **Create Pickup**.

**Production wiring** (out of v1.1 prototype scope, documented for the build):

- Replace `generateQuotes()` with a real RFQ pipeline:
  - **Outbound:** vendor portal API · EDI 850-RFQ · email-with-tracked-reply (HTML form + per-vendor tokenized link).
  - **Inbound:** vendor responses parsed into the same `VendorQuote` shape (vendor portal webhook, EDI 855 acknowledgement → 832-style quote, or AI extraction from email replies).
- Quotes can return async — the UI degrades to "Awaiting quotes…" cards with progress (`N of 3 received · expected by &lt;deadline&gt;`).
- The scoring formula and the pick-and-apply UX are unchanged.
- The selected RFQ also stores back as `purchase_order.rfq_id` so the audit log shows which competing vendors were quoted before the PO landed.

**Acceptance criteria:**

- [ ] **Get 3 Estimates** button is present in the CreateStageDialog footer; disabled when no line item has a quantity.
- [ ] Clicking opens the comparison dialog nested at `zIndex={80}` with the parent still mounted.
- [ ] The dialog shows exactly 3 vendor cards, ordered by composite score, with the winner ringed in emerald.
- [ ] The winner gets a 👑 Crown badge + RECOMMENDED banner with total/lead/stars/past-jobs.
- [ ] Cheapest / Fastest / Top-rated superlative chips show on the matching card even when they don't match the composite winner.
- [ ] Each card lists every RFQ line with its quoted unit cost + extension + BO flag where on backorder.
- [ ] Clicking "Use [Vendor]" on any card (or the footer "Use Recommended" CTA) closes the comparison, writes that vendor onto every line of the parent form, sets each line's ETA from the quote's lead time if blank, and shows the emerald inline toast in the CreateStageDialog body.
- [ ] The parent CreateStageDialog stays mounted after winner selection so the user can click Create Pickup to commit.
- [ ] Re-opening the dialog with the same line items yields identical quotes (deterministic hash-based mock).

## 7.3 Approval Workflow

- Amount-based + role-based, single-step v1 `[A49]`.
- Per-org rules: "all POs > $X require manager approval"; "POs from role Y always require approval."
- Mobile push card to approver: Approve / Call tech / Reject with reason (Agent 5 pattern).
- Tech keeps talking with customer while approval pending; haptic on approve.
- Multi-step + vendor-type + job-type triggers Phase 2.

## 7.4 Receiving & Three-Way Match

- Open approved PO → Start receiving → scan part barcode/label → confirm qty → photo of packing slip → finish (Agent 5 counter flow).
- OCR pre-fills receipt header (date, vendor, subtotal, tax, total); tech confirms only [A31].
- Posts `purchase_receipt` + `purchase_receipt_line` with putaway location.
- Stock movements (type=receive) auto-generated.
- Partial receipts supported; back-order status tracked per line.
- Vendor invoice arrives → OCR (AI A4) → match against PO + receipt → `vendor_bill` + `vendor_bill_line` with `match_status` enum.
- Variance > tolerance (vendor.price_tolerance_percent + qty_tolerance_percent) → `three_way_match_exception` with type enum (qty_mismatch / price_mismatch / missing_receipt / missing_bill / orphan_line).
- AP queue UI for exception resolution; bulk-resolve actions.

## 7.4.A `[PROTOTYPE v1.1]` Job Staging — new sub-module

**Problem solved:** When parts arrive for a specific Job (often across multiple POs + multiple partial shipments + multiple vendors), the counter and office need a single place to see "what's in vs what's still backordered for this job" before the tech is dispatched. Today this lives in tribal knowledge + spreadsheets.

**Concept:** A `job_stage` is a holding entry that aggregates ordered items against a single Job. Lives under Inventory → Staging tab. Stages have an explicit lifecycle.

### 7.4.A.1 Data model

```sql
job_stage (id uuid PK, organization_id uuid FK, job_id uuid FK job(id),
           status job_stage_status_enum,   -- awaiting / partial / complete / ready_for_pickup / delivered
           pickup_vendor_id uuid NULL FK vendor(id),    -- if picking up from vendor
           pickup_address text NULL,                    -- defaults from vendor.pickup_address, editable
           pickup_address_components jsonb NULL,        -- [SPEC-ONLY v1.1 §11.1.A] structured shape from Google Places (lat/lng/place_id/components); written when user picks an autocomplete suggestion in CreateStageDialog's Vendor Pickup Location override
           staged_location_id uuid NULL FK inventory_location(id),  -- if staging at own location
           staged_area text NULL,                       -- rev 2026-05-26: free-form zone within staged_location (e.g. "Zone B — Pickup Shelf"). Sourced from inventory_location.staging_areas presets, but custom values allowed.
           assigned_tech_id uuid NULL FK app_user(id),
           scheduled_for timestamptz NULL,              -- denormalized from job.scheduled_at for at-a-glance
           notes text,
           created_at, updated_at)

-- rev 2026-05-26: inventory_location gains a list of named zones for
-- warehouse-type locations. Used by job_stage.staged_area and surfaced in
-- the StagingAreaPicker UI.
ALTER TABLE inventory_location
  ADD COLUMN staging_areas text[] NULL;

job_stage_line (id uuid PK, organization_id, job_stage_id uuid FK,
                catalog_item_id uuid FK, item_variant_id uuid FK,
                qty_ordered numeric, qty_received numeric,
                vendor_id uuid FK vendor(id),
                purchase_order_id uuid NULL FK purchase_order(id),
                purchase_order_line_id uuid NULL FK purchase_order_line(id),
                expected_date date NULL,
                received_serials text[],
                created_at)

-- rev 2026-05-26: staging attachments — see §7.4.A.10 for the UX spec.
-- At least one row is required before status can flip to 'ready_for_pickup'.
job_stage_attachment (id uuid PK, organization_id uuid FK,
                      job_stage_id uuid FK job_stage(id) ON DELETE CASCADE,
                      kind attachment_kind_enum,            -- 'image' | 'video'
                      storage_url text,                     -- prototype uses base64 dataURL; prod = S3/blob URL
                      mime_type text,
                      caption text,
                      uploaded_at timestamptz, uploaded_by_user_id uuid FK app_user(id),
                      source attachment_source_enum,        -- 'camera' | 'upload' | 'pdf_page'
                      pdf_page_number int NULL, pdf_file_name text NULL,
                      duration_seconds numeric NULL,        -- video only
                      size_bytes bigint NULL,
                      purchase_order_id uuid NULL FK purchase_order(id),  -- optional PO scope
                      created_at timestamptz)
```

`job_stage.status` derived state machine:
- `awaiting` — sum(qty_received) == 0
- `partial` — 0 < sum(qty_received) < sum(qty_ordered)
- `complete` — sum(qty_received) >= sum(qty_ordered) ; awaiting tech notify
- `ready_for_pickup` — explicit transition by counter; tech push notified
- `delivered` — tech picked up; closes the stage; transfers stock to tech's truck location

### 7.4.A.2 UX — Staging tab

- Header KPI tiles (5): Active Stages · Awaiting · Partial · **Ready** · Ready for pickup (rev 2026-05-26 — the 3rd-from-right tile was renamed from "Complete" to "Ready" for plain-language parity with how counter staff actually talk about stages whose parts are all on hand; the underlying `job_stage.status` enum value is still `complete` to avoid a schema migration and to keep the semantic distinction from `ready_for_pickup`). **All 5 are clickable as toggle filters** — same locked pattern as the Items KPI tiles (§5.4.A) and the Approvals stat tiles (§5.4.A.v.4): the active tile gets an indigo ring + "filtered" pill, hover adds a subtle shadow, click is equivalent to picking the matching pill in the FILTER row below; state stays in sync between both surfaces.
- Filter pill row: All / Awaiting / Partial / **Ready** / Ready for pickup (counts shown — chip label matches the renamed KPI tile; click behavior still filters cards by `status === 'complete'`).
- **Stage cards** (one per job_stage), expandable accordions:
  - Card head: `J-####` job badge · customer name · trade chip · status chip · site address · assigned tech (with vehicle) · scheduled date/time · staged-at vendor OR location · right-rail progress (`<received>/<ordered>` + colored progress bar + % complete).
  - **Dual-action header (rev 2026-05-26):** the chevron and the rest of the header row toggle the accordion as before, **except** the `J-####` badge and the customer-name span which are now interactive buttons that open the **Stage Detail Dialog (Full Transaction view — §7.4.A.6) directly** — same target as the "Open Full Transaction" footer button, but reachable in one click from the header without expanding the accordion first. Both buttons stop propagation so the accordion does NOT also toggle; they share an *"Open Full Transaction"* tooltip and pick up a hover underline + indigo focus ring for affordance. Rationale: counter staff most often want the full stage record (job + tech + staged-at + notes + line items + activity audit) — pre-rev they had to expand the card and scroll to the footer's "Open Full Transaction" button; post-rev one click on the job badge or customer name gets them there. (Implementation note: the outer header was converted from `<button>` to `<div role="button" tabIndex={0}>` with Enter/Space key handling so the nested `<button>` elements are valid HTML. An earlier draft of this rev opened `POPreviewDialog` instead; switched to the Full Transaction dialog same day per owner feedback — the PO# pill inside the expanded line-item table still opens `POPreviewDialog` for users who specifically want the PO doc.)
  - Expanded body: line-item table with SKU · name · vendor · PO# · ETA · received/ordered · backordered count · per-line **Receive +1** button (simulates partial delivery; in production, posts a `purchase_receipt_line` and bumps `job_stage_line.qty_received`).
  - Action footer: when status=`complete` → **Notify Tech · Ready for Pickup** (transitions to `ready_for_pickup` + sends push to tech). When status=`ready_for_pickup` → **Mark Delivered to Tech** (transitions to `delivered` + posts paired `stock_movement` transfer_in to tech's truck location).

### 7.4.A.3 Create-stage flows

Two entry points from the Staging header:

1. **+ New Pickup** (primary, manual) — opens CreateStageDialog with empty form.
2. **From PO** dropdown picker (count badge) — lists every open PO that isn't already linked to a stage. Picking one opens CreateStageDialog **pre-filled** with the PO's vendor, line items (qty, vendor, PO#, ETA), and — if the PO is already linked to a Job — auto-fills job context (customer/site/trade/schedule/assigned tech).

### 7.4.A.4 CreateStageDialog field spec

- **Job** picker — dropdown of all existing jobs (matches `J-####` + customer) with **"+ New job (type below)"** option. When an existing job is picked, **Customer, Site, Scheduled For, Assigned Tech all auto-fill** + made read-only with light-emerald background + small helper note "✨ Auto-filled customer · site · schedule". If "+ New job" is selected, free-text job number field appears below. The dialog **no longer exposes a Trade field** (rev 2026-05-26 — completes the trade-agnostic sweep); `job_stage.trade` is auto-derived from `job.trade` when an existing job is picked, defaults to `"multi"` otherwise.
- **Auto-link to existing PO on the job (rev 2026-05-26):** when an existing job is picked, the dialog runs a server-side lookup against `purchase_order` for `jobNumber = <selected job>` AND `status NOT IN ('received', 'closed')`. If at least one open PO matches, the **most recent** one (sorted by `orderedAt DESC`) is auto-linked: `linkedPOId` is set, the Items-Ordered list is replaced with the PO's lines via `applyPOLines(po)`, the "Linked to PO-####" chip + inline Preview-PO button appears next to the Items-Ordered heading, and the footer **Preview PO** button becomes enabled. The Pickup-From-Vendor + Vendor-Pickup-Location pair is auto-filled from the PO's vendor record. The "Auto-fill from PO" dropdown is **filtered to only that job's open POs** (instead of the org-wide open-PO list it shows when no job is selected); a small emerald "N PO(s) on this job" badge sits next to the dropdown. If no open PO exists on the selected job, the dropdown shows `— no PO on this job —` as the empty option and the Items-Ordered list resets to a single empty line so the counter staff can add items / type a custom PO# inline. Switching to a different job replaces the auto-linked PO with that job's most-recent open PO (or clears it). Picking `"+ New job (type below)…"` also clears any prior auto-link. **Rationale:** counter staff almost always create a staging entry *for an open PO they already cut* — auto-linking removes the second pick that used to require scrolling the org-wide PO list and prevents the common mistake of staging against the wrong PO when multiple jobs share a vendor.
- **Assigned Tech** — dropdown of all org techs (`app_user` filtered by `field_technician` + `subcontractor_tech` + `warehouse_lead` + `counter` roles). Each option shows `Name — Role · Primary trade`. Helper line under the picker shows `branch · vehicle`.
- **Pickup From Vendor** — dropdown of vendors (excluding "Internal"). When picked, an indigo info card surfaces with the **Vendor Pickup Location** (auto-filled from `vendor.pickup_address`, editable inline).
- **Vendor-pickup stages land directly in "Ready for pickup" (rev 2026-05-26):** when a stage is created with `pickupVendorId` set, the new `job_stage.status` is forced to `ready_for_pickup` regardless of `qtyReceived` totals — these stages skip the warehouse-receive flow entirely because the parts are sitting at the vendor's counter, not in our building. The tech just needs to drive to the vendor's pickup location and grab them. Warehouse-staged stages (no `pickupVendorId`) keep the original qty-driven status assignment (`awaiting` → 0 received, `partial` → some received, `complete` → all received). This means a freshly created vendor-pickup stage appears immediately under the **Ready for pickup** KPI tile + chip on the Staging tab, matching how counter staff actually describe the workflow — *"I cut the PO, it's at ADI, tell Mike to swing by."*
- **Footer "Email PO to Vendor" action — send the order + create the stage in one click (rev 2026-05-26):** for the *shipping* path (vendor delivers to us, not counter pickup), the dialog footer now exposes a third primary action **"📧 Email PO to Vendor"** between Preview PO and Create Pickup. The button is disabled with tooltip *"Link a PO above to email the vendor"* when there is no `prefilledFromPO` and no `linkedPOId`; otherwise the tooltip surfaces the target — *"Email PO-#### to &lt;Vendor&gt; to order + ship the parts here — creates an Awaiting stage at the warehouse on send"*. Clicking validates the form, runs `buildStage(/*shipMode*/ true)` which builds a `JobStage` with `status = "awaiting"`, `pickupVendorId = undefined`, `pickupAddress = undefined`, `stagedLocationId =` the first `inventory_location` of `type === "warehouse"` (falling back to `locations[0]`), and `qtyReceived = 0` on every line, then opens the existing `POEmailDialog` (`zIndex={80}`, `lockEscape`) with the linked PO. The composer pre-fills recipients (vendor sales / orders, branch buyer Cc, AP alias suggestion), subject `Purchase Order · <PO#> · <Vendor>`, body lists every line with received/ordered counts, and attaches a `po-<PO#>.pdf` chip — same composer wired into POPreviewDialog (§7.4.A.9). On send (`onSent` callback), the parent commits the built stage via `onCreate(...)`, resets the dialog, and closes — so one click sends the order *and* creates the awaiting-warehouse stage. Rationale: this completes the two-direction workflow on the dialog — Pickup (vendor counter → tech drives) was already covered by the "Pickup From Vendor" field + the auto-Ready-for-pickup status above; Ship (vendor delivers → warehouse receives) now has parity. Counter staff no longer has to email the vendor from a separate doc preview after creating the stage — the order goes out and the staging record exists simultaneously.
- **Per-line Vendor dropdown + multi-vendor PO split (rev 2026-05-26):** each row of the Items-Ordered list now exposes a **Vendor** `<select>` (was a free-text input) populated from the `vendors` table — excluding the `Internal` entry — so the operator can re-assign each line to whichever vendor is cheapest / fastest / in stock without leaving the dialog. When lines span more than one distinct vendor, the dialog enters **multi-vendor mode**, signalled by an amber chip alongside the Items-Ordered heading: *"📧 N vendors — split PO on email"* (tooltip lists the vendor names). In multi-vendor mode the footer button label flips from *"Email PO to Vendor"* → *"Email N Vendor POs"* and clicking it walks the operator through a **sequential queue of POEmailDialog composers — one per vendor**, each pre-filled with: (a) a synthetic per-vendor PO numbered `<original-PO#>-A` / `-B` / `-C` / … (letter suffix sequenced in the order vendors first appear in the line list, derived from `parentPO.poNumber` for clean audit chain), (b) only that vendor's line items, (c) the vendor's own `sales@<domain>` derived recipient + branch buyer Cc + standard composer body, (d) a `po-<PO#>-<suffix>.pdf` attachment chip. On Send of each composer, `vendorEmailIndex` advances and the same dialog re-renders with the next vendor's PO; the parent's `pendingShipStage` is held in state through the queue and only committed via `onCreate(...)` after the **final** vendor's send. A `useRef<boolean>` guard (`justSentVendorEmail`) absorbs the trailing `onClose` that `POEmailDialog.handleSend` fires alongside `onSent`, so the queue doesn't collapse between sends. Cancelling any composer mid-queue (X / Esc / Cancel button) aborts the whole flow and does NOT commit the pending stage. Single-vendor flow is unchanged — one composer, send once, stage commits, done. Rationale: a Job often pulls from 2–3 vendors (alarm panel from ADI, locksets from ASA, electric strike from Allegion) but counter staff used to have to either (a) cut three separate POs from the PO module first or (b) email a single vendor everything and hope they sub-source. Now one staging entry tracks the whole shipping order; three vendor-specific emails go out simultaneously, each with only their portion.
- **Items Ordered** dynamic line list:
  - Per line: item dropdown (catalog) · qty · UoM (auto) · vendor (defaults from item) · PO # · ETA · trash to remove.
  - **"Auto-fill from PO"** dropdown in the section header — picks any open PO and replaces the lines with that PO's lines + sets a "Linked to PO-####" badge. **Scope (rev 2026-05-26):** when an existing job is picked above, this dropdown is narrowed to that job's open POs only (with an emerald "N PO(s) on this job" badge alongside); when no job is picked, it falls back to the org-wide open-PO list. When the selected job has zero open POs, the dropdown's placeholder reads `— no PO on this job —` and the user can still add items manually via **+ Add item** + free-text PO#.
  - At least one line always present.
- **Notes** (optional) free-text.

### 7.4.A.5 Acceptance criteria

- [ ] Counter staff can create a staging entry from an open PO in <15 seconds (Job → auto-fill from PO).
- [ ] When the last line item's qty_received catches up to qty_ordered, stage auto-transitions to `complete`.
- [ ] Marking a stage `delivered` posts `stock_movement` entries that move all line items to the assigned tech's truck location (or staging-truck location if no tech assigned).
- [ ] An open PO that has been linked to a stage is excluded from the "From PO" picker (no double-staging).
- [ ] Stages persist independently of the underlying POs — closing a PO does not auto-close its linked stages; stages must be explicitly delivered or cancelled.
- [ ] **(rev 2026-05-26)** Picking an existing job in the CreateStageDialog auto-links the most recent open PO on that job (if any): the "Linked to PO-####" chip + emerald "N PO(s) on this job" badge appear, the Items-Ordered list is populated from that PO's lines, the Pickup-From-Vendor + Vendor-Pickup-Location are filled from the PO's vendor, and the footer Preview-PO button becomes enabled — all without a second pick.
- [ ] **(rev 2026-05-26)** Picking a job with zero open POs leaves the "Auto-fill from PO" placeholder reading `— no PO on this job —`, resets Items-Ordered to a single empty line, and keeps the footer Preview-PO button disabled until the user manually attaches/types a PO#.
- [ ] **(rev 2026-05-26)** Switching the Job picker to a different existing job replaces any previously auto-linked PO with the new job's most-recent open PO (or clears the link if the new job has none); the dropdown's filtered option list updates to match the new job.
- [ ] **(rev 2026-05-26)** Creating a pickup with a `Pickup From Vendor` selected sets the new `job_stage.status` to `ready_for_pickup` directly (skipping `awaiting` / `partial` / `complete`), so the stage appears under the **Ready for pickup** KPI tile + chip on the Staging tab immediately. Warehouse-staged stages (no vendor) keep the qty-driven status assignment.
- [ ] **(rev 2026-05-26)** Clicking the footer **"📧 Email PO to Vendor"** action validates the form, opens the existing `POEmailDialog` pre-filled with the linked PO (vendor `sales@<domain>` To, branch buyer Cc, PO# subject, line-item body, `po-<PO#>.pdf` attachment chip). On send, a `job_stage` row is committed with `status = "awaiting"`, `pickupVendorId = undefined`, `stagedLocationId =` the first warehouse-type location (defaults to Main Warehouse), and the dialog closes. The Staging tab's `Awaiting` chip count increments by 1; `Ready for pickup` is unchanged.
- [ ] **(rev 2026-05-26)** The **"Email PO to Vendor"** button is disabled with tooltip *"Link a PO above to email the vendor"* when no `prefilledFromPO` and no `linkedPOId` are set; enabled with tooltip *"Email PO-#### to &lt;Vendor&gt; to order + ship the parts here — creates an Awaiting stage at the warehouse on send"* when a PO is linked.
- [ ] **(rev 2026-05-26)** Each line item's **Vendor** field is a `<select>` populated from the `vendors` table (excluding `Internal`); changing a single line's vendor so it differs from the other lines puts the dialog into **multi-vendor mode**.
- [ ] **(rev 2026-05-26)** Multi-vendor mode surfaces an amber chip alongside the Items-Ordered heading reading *"N vendors — split PO on email"* (tooltip lists the vendors), and the footer button label flips to *"Email N Vendor POs"*.
- [ ] **(rev 2026-05-26)** Clicking *"Email N Vendor POs"* opens the `POEmailDialog` for vendor #1 (PO-####-A, only that vendor's lines, vendor's `sales@` recipient). Hitting **Send** swaps the same dialog to vendor #2 (PO-####-B), then vendor #3 (PO-####-C), etc., until every vendor in the line list has been emailed; only after the final Send does `onCreate(...)` commit the single Awaiting-at-warehouse stage and both dialogs close.
- [ ] **(rev 2026-05-26)** Cancelling any composer mid-queue (X / Esc / Cancel button) aborts the entire send and does NOT commit the pending stage — no partial-send orphan records.
- [ ] **(rev 2026-05-26)** The Staging tab's KPI tile labelled "Ready" (formerly "Complete") still filters cards by `status === 'complete'`; only the label changed.

### 7.4.A.6 `[PROTOTYPE v1.1]` Stage Detail Dialog (full edit + activity audit)

Clicking the **"Open Full Transaction"** button on any stage card (or the future stage row in the Approvals-like tabular view) opens a rich `StageDetailDialog` modal with full context and inline edit capability.

**Layout:**

- **Header**: `<Job#> · <Customer>` + subtitle *"Staging entry · `<received>/<ordered>` units received · `<pct>`% complete"*.
- **Status bar**: trade chip + (read mode) status chip OR (edit mode) status dropdown · progress bar with received/ordered numbers + percentage.
- **Three-column overview**:
  - **Job card** (emerald) — Job # · customer · site · scheduled-for (datetime-local input in edit mode).
  - **Assigned Tech card** — current tech name; dropdown of `field_tech` + `subcontractor_tech` users in edit mode; helper line shows branch + vehicle.
  - **Staged At card** — current staging location; in edit mode the dropdown lists **all** org locations grouped by type with optgroups: **Warehouses · Job-site Staging · Counter / Shop · Trucks / Vans (direct-to-van staging)**. Truck options show their `primaryTech · vehicle` for clear identification (so "direct stage to Carlos's Sprinter for tomorrow morning" is a one-pick action). Vendor pickup info surfaced when set.
- **Notes** — textarea in edit mode, plain text in view mode.
- **Line items table** — each row: SKU · serialized chip · name · vendor + PO# + ETA · received/ordered + UoM · backordered count or Complete marker. In edit mode, `qtyReceived` becomes an editable number input clamped to `[0, qtyOrdered]`. In view mode, `Receive +1` button surfaces on incomplete lines.
- **Activity audit feed** — sorted desc by timestamp, each entry: actor name · field-changed code block · old value (italic, slate) → new value (italic) · optional comment line · relative timestamp ("3h ago" / "May 24"). **Pending (unsaved) entries get an indigo background tint + "unsaved" pill** so the user sees their in-flight changes before saving.

**Edit model:**

- **Initial mode is status-aware (rev 2026-05-26):**
  - **In-progress stages (`status === "awaiting"` or `"partial"`):** the dialog **opens already in edit mode** — every field is live, no "Edit Stage" button needed. Operator is mid-flow; making them click an extra button to update a tech / scheduled-for / qty-received was the #1 friction complaint.
  - **Finished stages (`status === "complete"` / `"ready_for_pickup"` / `"delivered"`):** the dialog opens in **read mode** with an "Edit Stage" button in the footer for occasional corrections after the work is done.
- **Edit mode** mechanics are unchanged: every change adds a `stage_audit_log` entry to a local `pendingAudit` array; nothing persists until Save.
- **Footer is mode- + status-aware (rev 2026-05-26):**
  - **Finished stage, read mode (default):** `Close · Preview · Email · Print/PDF · Edit Stage` (indigo).
  - **Finished stage, edit mode** (entered via "Edit Stage"): `Cancel` (discards `pendingAudit`, reverts form state) · `Save Changes (N)` (disabled when N=0). Same as pre-rev.
  - **In-progress stage, always-edit mode (rev 2026-05-26):** `Close · Preview · Email · Print/PDF · Save Changes` — full doc toolbar stays present so the operator can still preview, email, or print the pickup ticket while editing; "Save Changes" sits at the end of the toolbar and is disabled until `pendingAudit.length > 0` (tooltip *"No changes to save yet"*) — when dirty, the label flips to `Save Changes (N)`. There is **no separate Cancel button** in this mode — the `Close` button (and `×` / Esc) handle abandonment via the same dirty-prompt that read-mode uses, since there's no prior read state to revert to.
- **Unsaved-changes guard**: clicking the `×` close button, hitting Esc, or clicking `Close` with `pendingAudit.length > 0` prompts a confirm.
- **Save action** writes the merged audit log into `job_stage.audit_log` (concatenates `stage.auditLog || []` with `pendingAudit`), bumps `job_stage.updated_at`, and emits a `staging.stage_updated.v1` event per changed field.

**Auditable field set (v1.1):**

- `status` · `notes` · `scheduledFor` · `assignedTechId` · `stagedLocationId` · `pickupVendorId` · `pickupAddress` · `stagedArea` (rev 2026-05-26) · `attachments` (rev 2026-05-26 — see §7.4.A.10; entries log add / remove counts + source)
- Per line: `items[i].qtyReceived` (changing this also rolls the stage status if it crosses an `awaiting → partial → complete` threshold)

**Schema additions (Appendix A.6):**

```sql
ALTER TABLE job_stage ADD COLUMN updated_at timestamptz;
ALTER TABLE job_stage ADD COLUMN audit_log jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Each audit_log entry shape:
{ id, at, actor_user_id, actor_name, field, old_value, new_value, comment }
```

**Hash-chain integration** (§A.7 `audit_log`): every persisted `job_stage.audit_log` entry ALSO writes a row to the org-wide `audit_log` table for the tamper-evident chain. The `job_stage.audit_log` jsonb field is the convenience denormalization for fast in-dialog rendering; the canonical record stays in `audit_log`.

**Acceptance criteria:**

- [ ] Click any stage card → "Open Full Transaction" opens the detail dialog with all info visible without scroll on a 1280×900 viewport.
- [ ] Editing a field, saving, and reopening shows the change in the Activity feed with a relative timestamp.
- [ ] Unsaved edits show inline in the Activity feed with an "unsaved" pill before Save is clicked.
- [ ] Closing the dialog with unsaved changes prompts a confirm; Cancel discards them, Save persists them.
- [ ] Editing `items[i].qtyReceived` auto-recomputes the stage `status` per the same rules as Receive +1.
- [ ] **(rev 2026-05-26)** Opening the detail dialog for an in-progress stage (`status` is `awaiting` or `partial`) renders every field already editable — Status / Assigned Tech / Staged At / Scheduled For are dropdowns or date inputs, Notes is a textarea, line `qtyReceived` cells are number inputs — and the footer is `Close · Preview · Email · Print/PDF · Save Changes` (no "Edit Stage" button, no separate "Cancel" button).
- [ ] **(rev 2026-05-26)** Opening the detail dialog for a finished stage (`status` is `complete`, `ready_for_pickup`, or `delivered`) opens read-only with the footer `Close · Preview · Email · Print/PDF · Edit Stage`. Clicking "Edit Stage" swaps to the classic `Cancel · Save Changes (N)` footer (revert path preserved for post-completion corrections).
- [ ] **(rev 2026-05-26)** In always-edit mode, "Save Changes" is disabled with tooltip *"No changes to save yet"* until `pendingAudit.length > 0`; once dirty, the label flips to `Save Changes (N)`.
- [ ] **(rev 2026-05-26 — staging attachments, §7.4.A.10)** A "Staging attachments (N)" panel renders between the three-column overview and the Notes block; it carries the three capture buttons (Take photo / Record video / Upload file). The panel border tints rose when the stage is `ready_for_pickup` with zero attachments (block state), emerald when one or more attachments are present, slate when empty-but-not-blocking.
- [ ] **(rev 2026-05-26 — staging attachments, §7.4.A.10)** The status dropdown's `"Ready for pickup"` option is `disabled` with the suffix `"— photo required"` whenever the stage has zero attachments. The footer's **Save Changes** and read-mode **Email** buttons are also `disabled` (with explanatory tooltips) when the form is set to `ready_for_pickup` with zero attachments.

### 7.4.A.6a `[PROTOTYPE v1.1]` Staging area picker — zone within the warehouse (rev 2026-05-26)

**Why:** before this rev, `stagedLocationId` told the tech which warehouse — but a busy warehouse is a maze. The tech still had to call the counter or walk every aisle to find their parts. Now the warehouse manager can pin the *exact* zone and the tech sees it everywhere the ticket appears.

**Schema:**

- `inventory_location.staging_areas text[] NULL` — list of named zones for warehouse-type locations. Configured per-branch so each floor plan can shape its own (Main Warehouse seeds: `["Zone A — Receiving Dock", "Zone B — Pickup Shelf", "Zone C — Bulk Aisle", "Counter Pickup Shelf", "Backroom Holding", "Loading Dock"]`; Queens Warehouse seeds 4 zones for cross-branch demo).
- `job_stage.staged_area text NULL` — the zone this stage is sitting in. Free-form (not FK) so a manager can record `"Mezzanine Bin 4"` without a settings round-trip.

**Component:** `<StagingAreaPicker>` (`src/components/StagingAreaPicker.tsx`)

Props: `{ parentLocation, value, onChange, compact?, className? }`. Renders a small pill-shaped trigger:

- **Set state:** indigo pill `📍 <Area> ▼` (e.g. *"📍 Zone B — Pickup Shelf ▼"*).
- **Unset state:** amber pill `📍 Pick a staging area ▼` so unset stages call attention.

Opens a panel with:

- Header showing `Staging area in <warehouse name>` + `N presets configured`.
- **Prominent "➕ Add new staging area"** button pinned at the top of the panel (right under the header) — full-width indigo, white text. Clicking expands inline into a New-staging-area input + Save + ✕-cancel row with hint *"Saved areas become presets for every future stage in &lt;Warehouse&gt;."* (rev 2026-05-26 — replaced the earlier bottom-footer "Add custom area…" link with this prominent top affordance after operator feedback).
- Scrollable preset list — each row a button; the active one shows an indigo background + ✓ checkmark.
- Custom value (if not in the preset list) appears as the first row.
- **Saved custom areas persist as presets** (rev 2026-05-26): hitting Save on a new area pushes it onto `parentLocation.stagingAreas` so every subsequent stage in that warehouse sees it as a configured preset — no settings trip needed. Prototype mutates the in-memory `locations` array; production calls `PATCH /inventory_locations/{id}` with the updated `staging_areas`.
- Bottom "Clear staging area" link in rose when a value is currently set.
- **Portalled panel — escapes ancestor clipping (rev 2026-05-26):** the dropdown panel is rendered through `createPortal(..., document.body)` with `position: fixed` instead of `absolute`, so it can never be clipped by the stage card's `overflow-hidden`, the scrollable stage-list container, or a modal it sits inside. Position is computed from the trigger's `getBoundingClientRect()` on open + on every window resize / capture-phase scroll, and the panel auto-flips upward (`placeAbove`) when there's more room above than below. `maxHeight` is bounded by viewport space (220–480px) and clamped so the panel never overflows the screen. The internal layout uses `flex-col` with a fixed header + fixed "+ Add new staging area" button + a `flex-1 overflow-y-auto` scroller for the preset list + a pinned "Clear staging area" footer when a value is set — so the add affordance and clear action stay visible while only the preset list scrolls. Outside-click + Escape close the picker against both the trigger and the portalled panel refs.

**Wire-up in StagingView:**

- Each `<StageCard>` gets a new `onChangeStagedArea?(next: string | undefined)` callback.
- `StagingView` adds a `setStagedArea(id, next)` reducer that updates the stage + fires a toast `📍 <Job#> staged in <Area>` (or `📍 <Job#> staging area cleared`).

**Where the area surfaces in the UI:**

- **Stage card header row** — appended to the "Staged at <Warehouse>" line in indigo: *"Staged at Main Warehouse · Zone B — Pickup Shelf"*.
- **Stage card expanded body** — new indigo strip between Line Items and Notes: `📍 STAGING AREA IN MAIN WAREHOUSE` on the left + the picker pill on the right. When the stage status is `complete` or `ready_for_pickup` and the area is unset, an amber `"Tell the tech where"` badge prods the manager.
- **Pickup Ticket preview** (`StagePreviewDialog`) — the "STAGED AT" card now shows the real warehouse name (fixing a pre-existing oversight that hard-coded "Main Warehouse") + an indigo `📍 <Area>` pill below the address so the tech reading the ticket on their phone walks straight to the right shelf.
- Vendor-pickup stages (`pickup_vendor_id IS NOT NULL`) suppress the picker — there's nothing to place on a shelf in our building.

**Acceptance criteria:**

- [ ] Expanding any complete / ready_for_pickup stage shows the "Staging area in <Warehouse>" strip with a picker pill.
- [ ] Opening the picker lists every entry in `parentLocation.stagingAreas` plus a custom-add row.
- [ ] Picking a preset updates the card header line and the picker pill immediately and fires the toast.
- [ ] Top "➕ Add new staging area" button (rev 2026-05-26) is the first action under the panel header; clicking expands an inline input + Save + ✕-cancel row. Enter saves; Esc cancels. The hint reads *"Saved areas become presets for every future stage in &lt;Warehouse&gt;."*
- [ ] Saving a new area writes it onto `parentLocation.stagingAreas`; closing and re-opening the picker for ANY stage in the same warehouse shows the new value as a configured preset (rev 2026-05-26).
- [ ] Every staging-area pick / change / clear appends a `StageAuditEntry` to the stage's `auditLog` (rev 2026-05-26) with `field: "stagedArea"`, old & new values, and a human-readable comment ("Placed in X" / "Moved from X to Y" / "Cleared (was X)"). The entry surfaces in StageDetailDialog's Activity feed.
- [ ] Clicks on the picker trigger and dropdown panel don't bubble to the parent stage card's expand/detail handler (rev 2026-05-26).
- [ ] Unset stages in `complete` / `ready_for_pickup` show the amber "Tell the tech where" prompt; setting any value clears the prompt.
- [ ] The Pickup Ticket preview shows the area as an indigo pill under the warehouse address.
- [ ] Vendor-pickup stages do *not* show the picker (nothing to place in our building).

### 7.4.A.7 `[PROTOTYPE v1.1]` Pickup Ticket Preview + Print + PDF + Email

Every staging entry (`StageDetailDialog`) can be turned into a **Pickup Ticket** — a formatted, print-ready, email-attachable document that drivers, techs, customers, or counter staff can act on without logging into the CRM.

**StageDetailDialog footer (read mode) — five buttons:**

`Close` · `Preview` · `Email` · `Print / PDF` · `Edit Stage`

- **Preview** opens `StagePreviewDialog` — the full ticket as it will print, with action buttons in its own footer.
- **Email** opens `EmailComposeDialog` directly (skipping the preview step for power users).
- **Print / PDF** opens `StagePreviewDialog` immediately on the print-ready document — from there the operator hits Save as PDF or Print.

**`StagePreviewDialog` document layout:**

- Letter-sized, 14mm × 16mm margins; `@media print` CSS isolates `.stage-print-root` so only the ticket prints (sidebar / topbar / modal chrome hidden).
- **Header:** FieldOS logo tile + Branch (name · address · phone · manager) on the left · "PICKUP TICKET" label + bold Job # + status badge on the right (color matches the stage status: amber for partial, emerald for ready/complete, indigo for delivered).
- **Three cards:** Job (Job# · Customer · Site · Scheduled-for · trade chip) · Assigned Tech (initials avatar, name, branch, vehicle, primary trade) · Staged At OR Pickup From Vendor (with address). When `stage.stagedArea` is set, the Staged-At card also shows an indigo `📍 <Area>` pill under the warehouse address (rev 2026-05-26) so the tech knows the exact zone within the warehouse. The card now resolves the warehouse name from the real `stagedLocationId` (was previously hard-coded to "Main Warehouse" — fixed rev 2026-05-26).
- **Notes banner** (only when stage has notes) — indigo card with "Notes for the picker / driver" label.
- **Staging attachments panel** (rev 2026-05-26 — only when `stage.photos.length > 0`): renders between Notes and Line Items. 3-column thumbnail grid showing kind-aware tiles — `<img>` for photos, `<video preload="metadata">` + Play overlay for videos, `<img>` + indigo `📄 p.#` corner badge for PDF-derived pages. Section header reads `Staging attachments (N) · X photos + Y videos + Z PDF pages` (kinds with zero counts are elided). Each thumbnail carries a caption footer (caption · uploader · date · optional PO#). When printed via `window.print()`, the attachments render on paper as thumbnail tiles; videos appear as their poster frame. See §7.4.A.10 for the full attachments spec.
- **Line items table:** `# · SKU · Description (+ serialized chip + serials if captured) · Vendor · PO# · ETA · UoM · Ordered · Received · Backorder · Status (Complete / Backorder pill)`.
- **Totals strip:** Lines · Units received `M / N` · Backorder count · Est. value at cost (from `items.unitCost`).
- **Signature block:** Tech Pickup Sign-out + Warehouse / Counter Manager — both rendered as live **inline e-signatures** (`<SignatureField>` — see §7.4.A.8). Tech and manager can each type to sign (live cursive preview) and adopt the signature for one-tap re-use on the next pickup ticket they touch (rev 2026-05-26).
- **Footer:** `FieldOS · Pickup ticket <Job#> · Generated <date>` · Page 1 of 1.

**`StagePreviewDialog` footer actions:**

`Close` · **Email Ticket** (opens `EmailComposeDialog`) · **Save as PDF** (download icon, calls `window.print()`) · **Print** (primary, calls `window.print()`)

**`EmailComposeDialog`:**

- **Suggested-recipients chip row** (indigo card) — one-click add for: Assigned Tech · Branch Manager · `dispatch@fieldos.io` · `counter@fieldos.io`. Chips already in the recipient list show emerald with a check.
- **To** (required, multi-recipient chip input — Enter/comma/semicolon to add, Backspace to delete the last chip, blur auto-adds). Validates against a permissive email regex; inline rose error banner for bad addresses.
- **Cc** (optional, same chip input).
- **Subject** (pre-filled: `Pickup Ticket · <Job#> · <Customer> (<N> lines)`).
- **Message body** (mono-font textarea, 12 rows, pre-filled):
  - Greeting → `Hi <tech-first-name>,` (falls back to `team`)
  - One-line summary: `Attached is the pickup ticket for <Job#> — <Customer> at <Site>.`
  - Scheduled time (if set)
  - Line items block (`• <SKU> · <name> — <received>/<ordered> <UoM>` with `(backorder N)` suffix when applicable)
  - Notes line (if set)
  - `Acknowledge with a reply when you're rolling.`
  - Sign-off: `— <Manager> · FieldOS · <Branch>`
- **Attachment chip** (read-only): `pickup-ticket-<Job#>.pdf · Auto-generated from the live ticket`.
- **Staging attachments strip** (rev 2026-05-26 — only when `stage.photos.length > 0`): row of small (~80×56) thumbnails beside the PDF chip — `<img>` for photos, `<video>` + Play overlay for videos, PDF-derived pages keep their `📄 p.#` badge. The pre-filled body also gains an `Attached: N photos + M videos + P PDF pages — verify the pallet before you load.` line replacing the old single-count photo summary. See §7.4.A.10.
- Footer: `Cancel` · `Send Email (<N> recipients)`.

**Wire-up:**

- `StageDetailDialog` accepts an optional `onEmailSent(stage, recipients)` callback so the parent (`StagingView`) can emit a toast: `✉ Pickup ticket for <Job#> sent to N recipient(s) · <first-email>`.
- Send is **mocked** in v1.1 — production wires this to the org's outbound mail service (Postmark / SES) and includes the rendered PDF as a real attachment generated by the print-route or a headless-Chrome PDF service.
- Both `StagePreviewDialog` and `EmailComposeDialog` mount at `zIndex 80 / 85` with `lockEscape` so the parent `StageDetailDialog` stays mounted and Esc closes only the topmost child.

**Acceptance criteria:**

- [ ] Pressing **Preview** from a stage popup shows the ticket exactly as it will print, including signature lines.
- [ ] Pressing **Print** (anywhere) prints only the ticket — no sidebar, no modal chrome.
- [ ] Pressing **Save as PDF** opens the OS print dialog where "Save as PDF" is the default destination on modern browsers.
- [ ] Pressing **Email** auto-fills To, Subject, Body, and the attachment chip with sane defaults derived from the stage.
- [ ] Sending mails fires a toast in the parent view confirming recipients.
- [ ] The dialog stack survives Esc presses one level at a time (email → preview → stage detail).
- [ ] **(rev 2026-05-26 — §7.4.A.10)** When the stage has one or more staging attachments, the printable ticket renders a 3-up "Staging attachments" panel between the notes banner and the line-items table; the email composer renders a thumbnail strip beside the PDF chip; the body's `Attached: …` line summarizes counts by kind. Both surfaces handle image, video (with Play overlay), and PDF-page (with `📄 p.#` badge) kinds correctly.
- [ ] **(rev 2026-05-26 — §7.4.A.10)** Sending the Pickup Ticket email is blocked (button disabled with explanatory tooltip) when the stage is in `ready_for_pickup` with zero attachments.

### 7.4.A.8 `[PROTOTYPE v1.1]` Inline e-signatures (DocuSign-style) (rev 2026-05-26)

**Goal:** every preview that ships out of FieldOS — to a tech, a manager, an approver, a vendor — can be **signed inside the doc itself**, on web or mobile, the moment it lands. No separate signing app, no PDF round-trip, no print-and-scan. The visual model mirrors DocuSign's "Adopt": the signer types their full name once, the rendered script-font signature becomes their re-usable signature, and subsequent docs offer one-tap "Apply my signature."

**Scope (rev 2026-05-26):**

| Doc | Component | Signature blocks |
|---|---|---|
| Pickup Ticket | `StagePreviewDialog` | Tech Pickup Sign-out · Warehouse / Counter Manager |
| Purchase Order | `POPreviewDialog` | Authorized By (buyer / manager). Vendor Acknowledgement remains a placeholder line — vendor signs via their own emailed link (out-of-band of FieldOS auth). |
| Stock-Out Approval | `ApprovalDetailDialog` | Approver Signature — **gates** the *Approve · post movement* button |

**Component:** `<SignatureField>` (new — `src/components/SignatureField.tsx`)

Props:

- `signerId?: string` — stable identity (FieldOS user id, tech id, or vendor handle). Used for saved-signature lookup. Omit for anonymous sign blocks.
- `defaultName?: string` — pre-fill the typed-name input.
- `role: string` — short uppercase label above the box (e.g. "Tech Pickup Sign-out").
- `signerLabel?: string` — caption shown under the signature once signed.
- `value?: SignatureValue | null` — controlled value (null = unsigned).
- `onSign(sig: SignatureValue): void` — fires when the signer applies a signature.
- `onClear?(): void` — fires when the signer hits "Re-sign".
- `readOnly?: boolean` — hides chrome (used by print-only mode after sign).
- `disableAdopt?: boolean` — hides the "Adopt for future documents" checkbox (used for one-off vendor blocks).

`SignatureValue` shape:

```ts
{
  fullName: string;
  signedAt: string;        // ISO timestamp
  method: 'typed' | 'auto_applied';
  signerId?: string;
}
```

**Visual states:**

1. **Unsigned + no saved signature:** dashed-border editor — "Type your full name to sign" input → live cursive preview in Caveat script font → optional "Adopt for future documents" checkbox → **Adopt & Sign** (or **Sign** if Adopt unchecked) button.
2. **Unsigned + has saved signature:** indigo card — "Your adopted signature" with the cursive preview + primary **Apply my signature** button + secondary "Sign differently" link + small ✕ to forget the adopted signature. One tap signs with `method: "auto_applied"`.
3. **Signed:** cursive name (`text-2xl text-indigo-800`) + signer label + timestamp + small "Re-sign" pill in the top-right corner. Auto-applied signatures get an indigo "✨ Auto-applied" badge in the caption for audit. When the signature was applied by the current user, the caption also shows an emerald "👤 You" badge.

**Identity-aware behavior (rev 2026-05-26):**

The field now takes a `currentUser?: { id, name }` prop and reconciles it against the **expected** signer (the `signerId` + `defaultName` pair that represents whoever the doc says should sign that block — assigned tech, branch manager, etc.). Three outcomes:

| Scenario | Banner / Toggle | Active identity | Adopted-sig lookup |
|---|---|---|---|
| `currentUser.id === signerId` (you ARE the assigned signer — e.g. Mike opens his pickup ticket on his phone) | Emerald banner: *"👤 This block is yours — auto-personalized for &lt;your name&gt;."* | `currentUser` | `fieldos:sig:<currentUser.id>` |
| `currentUser.id !== signerId` (e.g. Emanuel opens Jose's pickup ticket at the counter) | **"Signing as:"** pill toggle with `[Assigned name]` (default, indigo) · `[👤 You (your name)]` (slate, switchable) | Toggle-controlled; defaults to assigned | Swaps to the active identity's id |
| No `currentUser` provided (legacy call sites) | No banner, no toggle | `signerId` | `fieldos:sig:<signerId>` |

Toggling the active identity:

- Switches `signerId` used for the adopted-signature `localStorage` lookup (so the right person's sig is offered).
- Re-prefills the typed-name input with the active identity's name.
- Resets `editing` to false so the user re-enters from the saved-sig branch if available.
- Captures `SignatureValue.signerId` reflecting the **actual** signer, not the assigned one — so the audit trail records *who signed*, not *who was supposed to sign*.

Wire-up across the three preview dialogs:

- `StagePreviewDialog` passes `currentUser={currentUser}` to both Tech and Warehouse-Manager blocks. The manager block typically auto-personalizes for the logged-in branch manager (Brooklyn HQ: Emanuel Dahan); the tech block typically shows the toggle when an admin/counter person opens a ticket assigned to a different tech.
- `POPreviewDialog` passes `currentUser` to the Authorized-By block — buyers signing their own POs see the auto-personalize banner.
- `ApprovalDetailDialog` passes `currentUser` to the Approver Signature block — by construction the approver IS the current user, so the banner shows but no toggle is needed.

**Adopted-signature storage:**

- v1 prototype: `localStorage` under key `fieldos:sig:<userId>`, value `{ fullName, adoptedAt }` (`src/lib/signatures.ts` — `getSavedSignature`, `saveSignature`, `clearSignature`, `fmtSignedAt`).
- Production: lives on the user profile (`user.signature_full_name` + `user.signature_adopted_at` + audit IP / device). The component contract is unchanged — only the storage helper changes.

**Approval gate:**

- On `ApprovalDetailDialog`, the **Approve · post movement** button is `disabled` while `approverSig === null`. Tooltip explains: *"Sign the approval block below to enable."*
- On approve, the signature is captured into the approval's `review_comment` field as `Signed by <Name> · <Date·Time>` (or appended to an existing approver note as `<note> — Signed by <Name> · <Date·Time>`). This keeps the existing `stock_approvals` schema unchanged (no new column) while preserving append-only audit guarantees (§8.2).

**Print / PDF behaviour:**

- `<SignatureField readOnly>` (used by `@media print` mode) renders the signed value with no chrome — exactly what shows on paper. Unsigned blocks show the legacy "Signature / date" line so paper-first workflows still work.

**Mobile + email recipients (future, not v1):**

- The component is already viewport-agnostic — same UX on phone and desktop.
- Tokenized share links for external recipients (vendor PO acknowledge, customer estimate accept) → web view of the same `<SignatureField>` with `signerId = "vendor_<vendorId>"` or `"customer_<customerId>"`. Same DocuSign-style flow; the token guarantees identity. Tracked in §19 roadmap under "External signer links."

**Stylesheet:**

- `src/index.css` imports `https://fonts.googleapis.com/css2?family=Caveat:wght@500;700&display=swap` and exposes `.sig-script` (`font-family: "Caveat", "Brush Script MT", "Lucida Handwriting", cursive; font-weight: 700`) used by the field and by `<SignedBadge>` (compact list-view badge).

**Acceptance criteria:**

- [ ] Opening any of the three previews shows the recipient's signature block(s) with the typed-name editor pre-filled to their name.
- [ ] Typing in the editor renders a live cursive preview using the Caveat script font.
- [ ] Clicking **Adopt & Sign** persists the typed name to `localStorage` under `fieldos:sig:<userId>` and stamps the doc as signed.
- [ ] Opening the *next* preview that targets the same signer shows the "Apply my signature" one-tap card with their adopted signature.
- [ ] Tapping **Apply my signature** signs the doc with `method: "auto_applied"` and shows the "✨ Auto-applied" badge in the caption.
- [ ] On the Approval Detail, the **Approve · post movement** button is disabled until the Approver Signature block is signed; tooltip reads *"Sign the approval block below to enable."*
- [ ] After approve, the audit log shows `Signed by <Name> · <Date·Time>` in the review comment.
- [ ] **Re-sign** pill clears the signature in place — the editor returns to the "Apply my signature" or typed-name state depending on whether a saved signature still exists.
- [ ] **✕ Forget signature** on the saved-signature card removes the localStorage entry and falls back to the typed-name editor on the next doc.
- [ ] **Identity-aware (rev 2026-05-26):** When the logged-in user IS the assigned signer for a block, the field shows an emerald *"This block is yours — auto-personalized for &lt;Name&gt;"* banner; the typed-name input pre-fills with the current user's name; the saved-sig lookup uses the current user's id.
- [ ] **Identity-aware toggle (rev 2026-05-26):** When the logged-in user differs from the assigned signer, a "Signing as:" toggle appears with both names; the default is the assigned signer (preserves doc intent); clicking "you" swaps the input pre-fill, the saved-sig lookup target, and the captured `SignatureValue.signerId` so the audit log reflects the actual signer.
- [ ] **Signed-by-you badge (rev 2026-05-26):** When a signature was applied by the current user (either via auto-personalize or by switching the toggle to "you"), the signed-state caption shows an emerald "👤 You" badge in addition to any "✨ Auto-applied" badge.

### 7.4.A.9 `[PROTOTYPE v1.1]` Email · Save as PDF · Print — preview-action parity (rev 2026-05-26)

**Contract:** every inventory preview dialog ships the same three-button action toolbar so operators learn it once and use it everywhere. The toolbar lives in the modal footer, immediately to the left of any document-specific primary action (Approve, Send for Approval, etc.).

| Preview | Email button | Save as PDF | Print | Document-specific primary |
|---|---|---|---|---|
| **Pickup Ticket** (`StagePreviewDialog`, §7.4.A.7) | **Email Ticket** → `EmailComposeDialog` | ✓ | ✓ (primary indigo) | — |
| **Purchase Order** (`POPreviewDialog`, §7.2.A) | **Email PO** → new `POEmailDialog` (rev 2026-05-26) | ✓ | ✓ (primary indigo) | — |
| **Stock-Out Approval** (`ApprovalDetailDialog`) — pending + canApprove | **Email Team** → `ApprovalEmailDialog` | ✓ (rev 2026-05-26) | ✓ (rev 2026-05-26) | Reject · **Approve · post movement** |
| **Stock-Out Approval** — closed / non-approver | **Email** → `ApprovalEmailDialog` (rev 2026-05-26) | ✓ (rev 2026-05-26) | ✓ (rev 2026-05-26, primary indigo) | — |

**Mechanics — Save as PDF + Print:**

- Both buttons call `window.print()`. The browser's native print dialog includes "Save as PDF" as a destination on Chrome, Edge, Safari, Firefox — so no extra dependency is required for the v1 prototype.
- Each preview dialog injects a scoped `@media print` stylesheet on open and removes it on close. The stylesheet hides all UI except a single root wrapper class:
  - `StagePreviewDialog` → `.stage-print-root` (existing)
  - `POPreviewDialog` → `.po-print-root` (existing)
  - `ApprovalDetailDialog` → `.approval-print-root` (new — rev 2026-05-26)
- Form widgets that don't belong on paper (Approval Note input, Approver Signature pad, Rejection Reason textarea, "your role can view" hint) carry a `.approval-print-hide` class with `display: none !important` inside `@media print`. The printed page renders status badge, type pill, item card, movement card, requested-by card, job-context card, tech's reason, audit/review block (if any) — and any captured signature.

**Mechanics — Email composers:**

- Each preview's Email button opens a tailored composer (`EmailComposeDialog` / `POEmailDialog` / `ApprovalEmailDialog`) nested at `zIndex={80}` with `lockEscape` so the parent preview stays mounted and Esc closes only the composer.
- All three composers follow the same anatomy: suggested-recipient chip row (one-click add/remove with emerald ✓ when selected) → To chip-input (required) → Cc chip-input → Subject → multi-line message body (mono font) → attachment chip with auto-generated PDF filename → footer with Cancel + Send.
- `POEmailDialog` recipient pool: derives `sales@<vendor-domain>` and `orders@<vendor-domain>` from the first token of the vendor name (e.g. *"ADI / Anixter"* → `sales@adi.com`), plus the branch buyer (manager) + `ap@fieldos.io` + `purchasing@fieldos.io`. Vendor domain mapping is heuristic in the prototype; production reads from `vendor.contact_email_sales` / `contact_email_orders` on the Vendor record (§7.6 Vendor Management).
- `onSent` callbacks return `{ to, subject, body }`; each parent maps that to a domain-specific toast (`✉ Pickup ticket for <Job#> sent to N · <email>`, `✉ PO <#> emailed to N · <email>`, `📧 Approval request emailed to N · <email>`).
- Send is **mocked** in v1.1 — production wires this to the org's outbound mail service (Postmark / SES) and includes the rendered PDF as a real attachment generated by the print-route or a headless-Chrome PDF service.

**Acceptance criteria:**

- [ ] Opening any of the three preview dialogs surfaces an **Email · Save as PDF · Print** trio in the footer.
- [ ] **Email PO** on the PO preview pre-fills To with `sales@<vendor-domain>`, Cc with the branch buyer, subject `Purchase Order · <PO#> · <Vendor>`, and body listing ship-to + dates + every line with received/ordered counts.
- [ ] **Email Team / Email** on the Approval preview pre-fills the warehouse-lead at the requester's branch with full approver pool exposed as chips.
- [ ] **Save as PDF / Print** on the Approval preview hides the Approval Note input, Approver Signature pad, Rejection Reason textarea, and modal chrome — only the request body, status, and any captured signature render on paper.
- [ ] All three composers nest at `zIndex={80}` with `lockEscape`; Esc closes the composer first, the preview second.
- [ ] On successful send, the parent view fires a toast naming the doc + recipient count + first email.

### 7.4.A.10 `[PROTOTYPE v1.1]` Staging attachments — photos, videos, PDF pages (rev 2026-05-26)

**Why:** before this rev, a Pickup Ticket was a text-only document. The tech had no way to verify the pallet on their phone before driving to pick it up — counter staff routinely texted photos out-of-band and the evidence never lived on the stage record. This rev makes visual evidence a **first-class, mandatory** part of the stage lifecycle: at least one attachment (photo / video / PDF page) is required before a stage can transition to `ready_for_pickup` or be emailed.

**Schema (TypeScript / data model):**

```ts
export type StageAttachmentKind = "image" | "video";

export type StageAttachment = {
  id: string;
  kind: StageAttachmentKind;
  dataUrl: string;            // base64 in v1 prototype; production = S3 / blob URL
  mimeType?: string;          // e.g. "image/jpeg", "video/mp4", "image/png" (for PDF-derived pages)
  caption?: string;           // defaults to filename
  uploadedAt: string;         // ISO timestamp
  uploadedBy: string;         // currentUser.name at upload time
  source?: "camera" | "upload" | "pdf-page";
  pdfPageNumber?: number;     // present iff source === "pdf-page"
  pdfFileName?: string;       // present iff source === "pdf-page"
  durationSeconds?: number;   // present for video kind
  sizeBytes?: number;
  poNumber?: string;          // optional: scope an attachment to a specific PO on the stage
};

// Back-compat alias for any code path that still imports the old name.
export type StagePhoto = StageAttachment;
```

Added to `JobStage`:

```ts
JobStage {
  // …existing fields…
  photos?: StageAttachment[];   // field name kept for backward compat; type is the new union
}
```

**Production schema diff (Appendix A.6):**

```sql
CREATE TABLE job_stage_attachment (
  id                  uuid PRIMARY KEY,
  organization_id     uuid NOT NULL REFERENCES organization(id),
  job_stage_id        uuid NOT NULL REFERENCES job_stage(id) ON DELETE CASCADE,
  kind                attachment_kind_enum NOT NULL,    -- 'image' | 'video'
  storage_url         text NOT NULL,                    -- S3 / blob URL; replaces dataUrl in prod
  mime_type           text,
  caption             text,
  uploaded_at         timestamptz NOT NULL DEFAULT now(),
  uploaded_by_user_id uuid NOT NULL REFERENCES app_user(id),
  source              attachment_source_enum NOT NULL,  -- 'camera' | 'upload' | 'pdf_page'
  pdf_page_number     int NULL,
  pdf_file_name       text NULL,
  duration_seconds    numeric NULL,
  size_bytes          bigint NULL,
  purchase_order_id   uuid NULL REFERENCES purchase_order(id),  -- optional PO scope
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_jsa_stage ON job_stage_attachment (job_stage_id);
```

**Three capture modes (always visible, mobile-first):**

| Button | File input attrs | Phone behavior | Desktop behavior |
|---|---|---|---|
| 📷 **Take photo** | `accept="image/*" capture="environment"` | Opens rear camera in still-photo mode | Falls back to native file picker (typically with webcam option) |
| 🎥 **Record video** | `accept="video/*" capture="environment"` | Opens rear camera in video-record mode | Native file picker |
| 📤 **Upload file** | `accept="image/*,video/*,application/pdf" multiple` | Photo library + Files app (mixed selection allowed) | Standard file picker |

All three buttons disable when the dialog is in read-mode or when an upload is already in flight; the Upload File button shows a spinner + "Processing…" label during PDF rendering or video metadata probing.

**Per-kind handling:**

- **Image:** read as base64 dataURL via `FileReader.readAsDataURL`. Rendered as `<img>` in a 4:3 cover thumbnail. Caption defaults to the filename.
- **Video:** same FileReader path → dataURL; duration probed by mounting a hidden `<video preload="metadata">` and reading `onloadedmetadata.duration` (rounded to seconds, `m:ss` formatted via `formatDuration` helper). Thumbnail renders an inline `<video muted preload="metadata">` over which a Play icon sits in a centered `bg-black/30` overlay; duration chip pinned bottom-right.
- **PDF:** triggers the **PDF page picker** modal (see below). The PDF file itself is *not* persisted — only the user-selected, rendered page images. This is deliberate: the staging record carries the exact pages relevant to that pickup, not the whole multi-page packing slip.

**PDF page picker (`zIndex={95}`):**

1. On PDF upload, `renderPdfPages(file)` is called:
   - Dynamically imports `pdfjs-dist` via the served `/node_modules/pdfjs-dist/build/pdf.min.mjs` path with a `/* @vite-ignore */` annotation (Vite's dep-optimizer hangs on `pdfjs-dist` in this project's config — the explicit subpath bypasses pre-bundling).
   - Sets `GlobalWorkerOptions.workerSrc = "/node_modules/pdfjs-dist/build/pdf.worker.min.mjs"`.
   - Calls `getDocument({ data, cMapUrl, cMapPacked: true, standardFontDataUrl, useSystemFonts: false })` — the font config is required; without it pdf.js v4 stalls during render waiting for font data that never arrives.
   - For each page: gets viewport at `scale: 1.5`, renders into a canvas that is **temporarily appended to the DOM** under a hidden `<div>` (pdf.js v4 requires canvases to be DOM-attached during render — off-DOM canvases hang waiting on font face events), captures `canvas.toDataURL("image/png")`, then removes the container.
   - Parse is bounded by a **30 s timeout**, each page render by a **20 s timeout** — so a malformed file surfaces a clean error instead of hanging the UI.
2. Picker modal shows:
   - Header: filename · page count · selected count.
   - Toolbar: `Select all` · `Clear` (defaults: all pages selected — opt-out, not opt-in).
   - Page grid (2–4 cols responsive): each tile is an `<img>` of the rendered page + an indigo-ring/check-mark when selected.
   - Footer: `Cancel` · `Attach N pages` (disabled when N=0).
3. On commit, each selected page becomes a `StageAttachment` with `kind: "image"`, `source: "pdf-page"`, `pdfFileName`, `pdfPageNumber`. They render with a small `📄 p.#` badge in the thumbnail corner so the audit chain knows they came from a multi-page PDF.

**Mandatory enforcement (three guards):**

| Guard | Trigger | Block reason |
|---|---|---|
| **Status dropdown** | Operator opens the status dropdown in edit mode | `"Ready for pickup"` option carries `disabled={photoCount === 0}` + suffix `"— photo required"`. Programmatic attempts to set via `onChange` are intercepted: inline rose error appears in the photo panel, status is *not* changed. |
| **Save Changes** | Operator clicks Save with the form already set to `ready_for_pickup` and zero attachments | Button is `disabled` with tooltip *"Upload at least one staging photo before marking this stage Ready for pickup"*. |
| **Email button (read-mode footer)** | Stage drifted into `ready_for_pickup` with zero attachments (data drift case) and operator clicks Email | Button is `disabled` with the same tooltip. Forces the operator to enter edit mode and attach evidence before the tech can be notified. |

A rose-bordered banner inside the photo panel reiterates: *"This stage is marked Ready for pickup but has no attachments. Upload at least one photo, video, or PDF page before saving or emailing the tech."*

**Audit log integration:**

- Every add: `StageAuditEntry { field: "attachments", oldValue: <prior count>, newValue: <new count>, comment: "N photos + M videos added · source: camera" }`.
- Every PDF commit: `{ field: "attachments", comment: "N PDF pages from \"<filename>\" added" }`.
- Every remove: `{ field: "attachments", comment: "Removed image: <caption>" }`.
- Entries surface in the existing Activity feed (§7.4.A.6) sorted by timestamp; pending (pre-save) entries show with the standard "unsaved" pill.

**Lightbox:**

Clicking any thumbnail opens a fullscreen lightbox (`zIndex={90}`):
- Video → `<video controls autoplay muted={false}>` capped at `85vh`.
- Image → `<img>` capped at `85vh`.
- Caption strip below: caption · uploader · ISO timestamp · `poNumber` · `pdfFileName (p.#)` when applicable.
- Closes on backdrop click, the `×` button, or Esc.

**Pickup Ticket render (§7.4.A.7 `StagePreviewDialog`):**

A new "Staging attachments (N)" panel sits between Notes and Line Items, showing kind-aware thumbnails in a 3-column grid:
- Images: `<img>` in 4:3.
- Videos: `<video preload="metadata">` with Play overlay (the ticket is meant to be glanced; the still frame is enough to verify the pallet).
- PDF-page attachments: `<img>` with the `📄 p.#` corner badge.
- Each thumbnail has a caption footer (caption · uploader · date · optional PO#).
- Section header includes a breakdown summary: `"N photos + M videos + P PDF pages"`.

When printed via `window.print()` (the existing Print / Save-as-PDF path — §7.4.A.7), the attachments render on paper as thumbnail tiles. Videos appear as their poster frame (no play UI on paper).

**Email render (§7.4.A.9 `EmailComposeDialog`):**

- Pre-filled body now includes `Attached: 2 photos + 1 video + 3 PDF pages — verify the pallet before you load.` (only the kinds with non-zero counts appear).
- The attachment chip area gets a thumbnail strip: each attachment renders as a small (~80×56) preview — `<img>` or `<video>` with Play overlay; PDF-derived pages keep their `📄 p.#` badge. Sits beside the existing auto-generated `pickup-ticket-<Job#>.pdf` chip.

**Acceptance criteria:**

- [ ] In `StageDetailDialog`, a "Staging attachments (N)" panel renders between the three-column overview and the Notes block. It is rose-bordered when blocked, emerald-tinted when populated, slate-bordered when empty.
- [ ] The panel shows three buttons — **Take photo** · **Record video** · **Upload file** — disabled in read mode and during in-flight processing; the Upload File button shows a spinner + "Processing…" label while a PDF is being rendered.
- [ ] On a phone, **Take photo** opens the rear camera in still mode; **Record video** opens it in video-record mode. On desktop, both fall back to the native file picker. The hidden inputs carry `capture="environment"` and the appropriate `accept` MIME filter.
- [ ] **Upload file** accepts a mix of `image/*`, `video/*`, and `application/pdf` files in a single selection. Per-kind size caps: 8 MB image / 100 MB video / 25 MB PDF; oversized files surface a per-file amber warning and are skipped (other files in the same selection still process).
- [ ] Uploading an image appends a thumbnail to the grid; uploading a video appends a thumbnail with a centered Play overlay + a duration chip (`m:ss`) sourced from `HTMLVideoElement.onloadedmetadata`.
- [ ] Uploading a PDF opens the page-picker modal. The grid shows every page rendered to PNG via pdf.js; all pages are selected by default; `Select all` / `Clear` work as labeled; clicking a page toggles its selection; `Attach N pages` is disabled when N=0 and commits each selected page as its own `image` attachment with `source: "pdf-page"`.
- [ ] PDF-derived attachments show a `📄 p.#` corner badge in every surface (StageDetailDialog, StagePreviewDialog, EmailComposeDialog).
- [ ] The `"Ready for pickup"` option in the status dropdown is disabled with the label suffix `"— photo required"` when `(stage.photos ?? []).length === 0`. Selecting it programmatically surfaces an inline error and does not change status.
- [ ] **Save Changes** is disabled with the photo-required tooltip when the form is in `ready_for_pickup` with zero attachments. **Email** in the read-mode footer is disabled with the same tooltip under the same condition.
- [ ] Every add / remove appends a `StageAuditEntry` with `field: "attachments"` to the stage's audit log; the entry surfaces in the Activity feed with the standard "unsaved" pill until save.
- [ ] Clicking any thumbnail opens the fullscreen lightbox; videos play with native controls + autoplay; images render at `max-h-[85vh]`; the caption strip lists caption / uploader / timestamp / optional PO# / optional PDF source.
- [ ] **Pickup Ticket preview (`StagePreviewDialog`)** renders a "Staging attachments (N)" panel between Notes and Line Items with kind-aware thumbnails and a `N photos + M videos + P PDF pages` summary line.
- [ ] **Email composer (`EmailComposeDialog`)** pre-fills the body with an `Attached: …` summary line (only kinds with non-zero counts) and shows a thumbnail strip beside the auto-generated PDF chip.
- [ ] PDF parsing or per-page rendering that takes longer than 30 s (parse) / 20 s (render) surfaces a clean inline error in the photo panel instead of hanging the dialog. The dialog can still be closed.
- [ ] Seed data: J-1845 (`status: ready_for_pickup`) ships with **two** image attachments tagged `source: "camera"` so the prototype demonstrates the populated state out of the box.

**Dependencies:** `pdfjs-dist@^4` added to `dashboard/package.json` (~2 MB; lazy-imported only when a PDF is uploaded). No other runtime deps added.

**Future hardening (Phase 2):**

- Replace base64 `dataUrl` with S3 / blob storage URLs and presigned upload (production path).
- Add per-attachment thumbnail generation server-side (for very large videos that should not load full-resolution in the email composer).
- Per-PO scoping UI: when a stage covers multiple POs, let the operator tag each attachment with the relevant PO# at upload time. Schema already supports it via `purchase_order_id` on `job_stage_attachment`.
- Geolocation + capture-time metadata extraction (EXIF) for forensic audit — currently we only record `uploadedAt` (server time, not capture time).

## 7.4.B `[PROTOTYPE v1.1]` Purchase Orders page — new dedicated surface (rev 2026-05-28)

**Problem solved:** Before this rev, the **Purchase Orders** sub-item in the Inventory parent group (§5.4.A.viii) was *decorative* — it appeared in the sidebar with a count badge but had no route, no component, and clicking it did nothing. POs were only reachable indirectly (via the Staging tab's "From PO" picker, via the Restock dialog, via the per-line eye-icon Preview affordance). There was no single home that answered the question *"what's the state of every PO this branch has touched today?"* — open with vendor, late, awaiting receipt, drafted but not sent, quoted but not committed.

**Concept:** A dedicated `PurchaseOrdersPage` component routed at the `"purchase-orders"` Route slot, mounted at sidebar position `Inventory → Purchase Orders` (third child of the parent group, per §5.4.A.viii). The page is a **lifecycle dashboard** for every PO and pre-PO artifact, with a status-adaptive detail dialog (`PODetailDialog`) that handles edit + receive + email + preview in one place.

### 7.4.B.1 Route + sidebar wiring

- `Route` union (`Sidebar.tsx`) gains `"purchase-orders"` as the third member after `"price-book"`.
- Sidebar nav definition: the existing `"Purchase Orders"` child gains `route: "purchase-orders"` alongside its badge.
- `App.tsx` route map: `route === "purchase-orders" ? <PurchaseOrdersPage /> : …`.
- Inventory parent row stays visually active when `currentRoute === "purchase-orders"` (locked behavior in `Sidebar.handleParentClick` — no change needed; the parent already lights up for any child route).
- Default landing tab on first paint: **Open**. Rationale: the most common reason an owner / dispatcher / counter visits this page is *"what should I be worried about right now"* — Open contains the in-flight and overdue work; Pre-PO and History are intent-driven destinations.

### 7.4.B.2 Page architecture (top to bottom)

| Region | Purpose | Pattern |
|---|---|---|
| **Header strip** | Breadcrumb `Operations › Inventory › Purchase Orders` · `<h1>Purchase Orders</h1>` · subtitle *"Track every order from quote to receipt. Pre-PO quotes · open orders with vendors · received history."* · top-right **+ Create PO** primary CTA (indigo, mirrors Vendors page "Add Vendor"). | Same chrome as VendorsPage (§7.6.A) and PriceBookPage (§6.A). |
| **4 KPI tiles** | `Pre-PO pending` · `Open POs` · `Late` · `Arriving this week`. Each tile clickable; click jumps to the matching tab + applies the relevant row filter. | Locked KPITile + single-active semantics (see §7.4.B.3). |
| **Sub-tabs row** | `Pre-PO` · `Open` · `History`, with count badges. | TabButton component from VendorsPage. |
| **Search + filter row** | Search input (PO#, vendor, job#, customer, SKU) · Vendor filter dropdown · Trade filter dropdown · "Clear KPI filter" pill (visible only when a KPI tile is active). | Mirrors VendorsPage filter row. |
| **Table** | One row per PO/RFQ/reservation. Columns differ per tab (see §7.4.B.5). | Sortable, click-to-open-detail, hover reveals quick-action icons. |
| **Empty state** | Per-tab message — *"No quotes or drafts in flight"* / *"No open POs"* / *"No closed POs yet"*. | Centered card pattern from PriceBookPage placeholders. |

### 7.4.B.3 KPI tiles — single-active semantics (rev 2026-05-28)

Tile click rules — only **one** tile can be lit at any moment:

- Clicking a **different** tile **moves** the active state to it, jumps to the appropriate tab (`Pre-PO pending` → Pre-PO tab; `Open POs` / `Late` / `Arriving this week` → Open tab), and applies the tile's row filter.
- Clicking the **currently lit** tile **toggles it OFF**, clearing the filter the tile was applying. The tab stays where it is.
- Manually clicking a **sub-tab** (Pre-PO / Open / History) **also clears** any active KPI ring — otherwise a hidden tile would lie about its state. Reset = honest UI.
- The "Clear KPI filter ×" pill in the filter row offers a third way to clear, with a tooltip telling the user the lit tile can also be re-clicked.

**Implementation note:** a single `activeKPI: null | "prepo" | "open" | "late" | "week"` state variable owns truth. Each tile renders `active={activeKPI === "..."}`; the click handler diffs against the current value and either toggles off or moves + navigates.

**Tile contents:**

| Tile | Value source | Click behavior |
|---|---|---|
| **Pre-PO pending** | `prePORows.length` (RFQs + Drafts + Reservations) | Tab → Pre-PO. |
| **Open POs** | `openPOs.length` + hint `$X,XXX.XX in flight` (sum of POtotal across sent + partial) | Tab → Open · clears any sub-filter. |
| **Late** | `openPOs.filter(isLate).length` where `isLate` = `expectedDate < today AND status ∉ {received, closed}` | Tab → Open · filters table to late rows only. |
| **Arriving this week** | `openPOs.filter(isArrivingThisWeek).length` where window = `today …  today + 7 days` | Tab → Open · filters table to arriving-this-week rows. |

### 7.4.B.4 Pre-PO seed data — `pre-po.ts` (new file)

The Pre-PO tab unifies three row types into one table. Drafts already fit the `PurchaseOrder` shape (`status: "draft"`) and live in `purchase-orders.ts`. RFQs and Estimate Reservations carry metadata that doesn't fit a PO and live in `src/data/pre-po.ts`:

```ts
export type PrePOLine = { itemSku: string; itemName: string; qty: number; uom: string };

export type EmailThreadEntry = {
  id: string;
  direction: "outbound" | "inbound";
  kind: "rfq_sent" | "vendor_quote" | "estimate_sent" | "customer_reply" | "follow_up";
  from: string;
  to: string[];
  subject: string;
  body: string;
  sentAt: string;
  attachments?: { label: string; kind: "pdf" | "xlsx" | "image" }[];
};

export type RFQQuote = { vendor: string; total: number; leadTimeDays: number; recommended: boolean };

export type RFQ = {
  id: string; rfqNumber: string;
  jobNumber?: string; customer?: string; site?: string; trade?: Trade;
  requestedAt: string; responsesDueBy: string;
  linesSummary: { items: number; units: number };
  lines: PrePOLine[];
  quotes: RFQQuote[];                                  // length 3 per §7.2.B
  status: "awaiting_quotes" | "ready_to_compare" | "winner_picked";
  emails: EmailThreadEntry[];                          // RFQ-out + vendor-replies thread
};

export type EstimateReservation = {
  id: string; estimateNumber: string;
  jobNumber?: string; customer: string; customerEmail?: string; site?: string; trade?: Trade;
  approvedAt: string;
  reservedTotal: number;
  linesSummary: { items: number; units: number };
  lines: PrePOLine[];
  preferredVendor?: string;
  emails: EmailThreadEntry[];                          // estimate-out + customer-reply thread
};
```

Seed coverage: 3 RFQs (2 `ready_to_compare`, 1 `awaiting_quotes`), 2 Estimate Reservations, 2 Draft POs (`status: "draft"` rows added to `purchase-orders.ts`). All include realistic vendor names, NYC jobs, plausible totals, and (for RFQ + Reservation) full email threads.

**Discriminated union for the table:**

```ts
type PrePORow =
  | { kind: "rfq"; data: RFQ }
  | { kind: "draft"; data: PurchaseOrder }
  | { kind: "reservation"; data: EstimateReservation };
```

The page builds `prePORows` once per render, sorted **Age DESC** (oldest first — stalest items need attention most). Per-kind helpers (`prePOAge` · `prePORef` · `prePOVendor` · `prePOTrade` · `prePOJobLabel` · `prePOTotal`) extract comparable fields across the union so the table can render rows uniformly.

### 7.4.B.5 Table columns per tab

All three tabs share a common interaction model: row click opens `PODetailDialog` for real POs (drafts in Pre-PO open the dialog; RFQs and Reservations open `PrePODetailDialog` — separate component scoped to those flows). Hover reveals quick-action icon buttons on the right edge.

#### Pre-PO tab

| Col | Content |
|---|---|
| **Type** | Chip · `RFQ` (amber) · `Draft` (slate) · `Est. Reservation` (sky) |
| **Ref #** | `RFQ-####` / `PO-####` / `EST-####`, font-mono |
| **Vendor(s)** | For `RFQ`: `Crown` icon + winner vendor + *"+2 more quoted"*; if `awaiting_quotes`, *"N/3 quotes received"* in amber. For `Draft` / `Est. Reservation`: single vendor name or "—". |
| **Job / Customer** | Linked `J-####` + customer site (stacked) |
| **Lines / Units** | `N items · M units` |
| **Est. Total** | `$X,XXX.XX` mono — RFQ uses winning quote total; Draft uses line-sum at fallback unit cost; Reservation uses `reservedTotal`. |
| **Age** | "Nd ago" since `requestedAt` / `orderedAt` / `approvedAt`. Slate < 3 days · amber 3–7 days · **rose > 7 days** (stale signal). |
| **Next action** | Inline button (stops propagation on click). `Compare quotes →` (RFQ) · `Send to vendor →` (Draft) · `Convert to PO →` (Reservation). |

#### Open tab — `status ∈ {sent, partial}`

| Col | Content |
|---|---|
| **Status** | Pill · `Sent` (indigo) · `Partial` (amber) |
| **PO #** | PO-####, font-mono |
| **Vendor** | Vendor name + `Truck` icon |
| **Job / Customer** | `J-####` (indigo mono) over customer site (stacked); "— no job link —" when null |
| **Ordered** | Short date |
| **Expected** | Short date — **rose + 🔴 dot if late**; amber if within 7 days; slate otherwise |
| **Lines** | Count |
| **Total** | `$X,XXX.XX` mono |
| **Received** | Thin progress bar (emerald at 100%, amber otherwise) + `n/m` count |
| **Actions** | Hover reveals · 👁 Preview · ✉ Email · 📦 Receive (all `stopPropagation`) |

**Sort:** late rows first, then by `expectedDate ASC` (most urgent at the top).

#### History tab — `status ∈ {received, closed}`

| Col | Content |
|---|---|
| **Status** | Pill · `Received` (emerald) · `Closed` (slate) |
| **PO #** | PO-####, font-mono · **clickable directly to open POPreviewDialog** (faster for audit lookups, no detail dialog needed) |
| **Vendor** | Vendor name + `Truck` icon |
| **Job / Customer** | Same as Open tab |
| **Ordered** | Short date |
| **Received on** | Date (proxy = `expectedDate` until the model gains a real `receivedAt` field — `[OPEN-7.4.B-1]`) |
| **Lead time** | `Nd` (received − ordered) — used for vendor reliability tracking |
| **Total** | `$X,XXX.XX` |
| **Variance** | Placeholder column (`—`) pending three-way match wiring per §7.4 — `[OPEN-7.4.B-2]` |

**Sort:** by `orderedAt DESC` (most recent first) until `receivedAt` lands.

### 7.4.B.6 `PODetailDialog` — the row-click target

Replaces the previous scaffold-only alert. Mirrors the locked StageDetailDialog pattern (§7.4.A.6): header summary card · inner tabbed body · status-adaptive footer · edit-in-place via the Modal's `editAction` slot when the design lands edit fields.

**Props:**
```ts
type Props = {
  open: boolean;
  onClose: () => void;
  po: PurchaseOrder | null;
  onReceive?: (event: { poId: string; lines: { itemSku: string; qtyReceived: number }[] }) => void;
};
```

**Header:** `PO-#### · <Vendor>` as the Modal title. Subtitle: `<JobNumber> · <Customer> · <Site>` or *"No job link"*.

**Header summary card** (below the Modal chrome, full-bleed slate-50 strip):
- Status pill (slate `Draft` · indigo `Sent` · amber `Partial` · emerald `Received` · slate `Closed`)
- Vendor name with `Truck` icon
- Trade chip (when set)
- Right-aligned: `Ordered <date> › Expected <date>` (with a `ChevronRight` separator).

**Inner tab strip** (4 tabs, count badges on Lines):

1. **Lines** (default) — read-only or receive-mode (see §7.4.B.7). Columns: `# · SKU · Description · UoM · Ordered · Received (n/m) · Unit $ · Ext.` with Subtotal / Tax 8.875% NYC / Total footer (mono right-aligned). Unit cost falls back to a $50 prototype constant until the items table join lands — `[OPEN-7.4.B-3]`.
2. **Activity** — vertical event list. Today synthesized from PO status (PO created · Sent to vendor · Partial receipt · Fully received · PO closed) with an inline note that real `purchase_order_status_history` wiring lands when the backend ships it — `[OPEN-7.4.B-4]`. Each event row: index chip · label · actor · `fmtDate`.
3. **Documents** — placeholder card. Will list: PO PDF · vendor quote PDFs (if RFQ) · packing slip photos (from receive) · vendor bill (when 3-way match runs). Drag-drop upload zone at top. `[OPEN-7.4.B-5]`.
4. **3-Way Match** — conditional content:
   - `status ∈ {sent, partial}` → *"3-Way Match runs after receiving"* card with explainer.
   - `status ∈ {received, closed}` → placeholder for the real wiring per §7.4.

**Footer actions — status adaptive:**

| Status | Primary | Secondary (always present) |
|---|---|---|
| `draft` | **Send to vendor** (indigo, `Send` icon) — opens nested POEmailDialog (`[OPEN-7.4.B-6]`) | Close · Email · Preview/Print |
| `sent` | **Receive items** (indigo, `PackageCheck`) — enters receive mode in Lines tab | Close · Email · Preview/Print |
| `partial` | **Receive remaining** + left-aligned hint *"Received N of M units · X% complete"* (amber) | Close · Email · Preview/Print |
| `received` | **Close PO** (indigo, `CheckCircle2`) — marks closed (`[OPEN-7.4.B-7]`) | Close · Email · Preview/Print |
| `closed` | — | Close · Email · Preview/Print |

**Receive-mode footer** (replaces the normal footer while `receiving === true`):
- Left: emerald *"Receive mode · adjust qty per line · stock auto-updates on save"*
- Right: `Cancel` (reverts draft) · **Save Receipt** (emerald primary, `PackageCheck`)

**Nested dialogs** (mounted alongside the Modal at `zIndex={80}`, `lockEscape`):
- `POPreviewDialog` — opened via Preview / Print button; re-uses the printable doc with `@media print` isolation.
- `POEmailDialog` — opened via Email button; on send, fires an inline emerald confirmation toast inside PODetailDialog (`✉ PO emailed to N recipient(s) · <first-email>`, auto-dismiss 3.5s).

### 7.4.B.7 Receive flow — `lib/po-receive.applyReceive` (rev 2026-05-28)

Central helper that every receive-capable surface (PODetailDialog Lines tab, the existing StageDetailDialog inline receive controls, future scan-based receiving) goes through. Lives at `src/lib/po-receive.ts`.

**Signature:**
```ts
applyReceive(poId: string, lines: ReceiveLineUpdate[], opts?: { warehouseId?: string }): ReceiveResult

type ReceiveLineUpdate = { itemSku: string; qtyReceived: number }; // absolute value, not delta
type ReceiveResult = {
  updatedPO: PurchaseOrder;
  receivedDeltaUnits: number;
  warehouseId: string; warehouseName: string;
  stockTouchedSKUs: string[];
  stageId?: string; stageStatus?: StagingStatus;
};
```

**What happens on call:**

1. **PO status auto-derivation** (`derivePOStatus`) — `draft` and `closed` are terminal (user-driven). Otherwise:
   - `totalReceived === 0` → `sent`
   - `0 < totalReceived < totalOrdered` → `partial`
   - `totalReceived >= totalOrdered` → `received`
2. **PO seed mutation** — `purchaseOrders[idx]` is replaced with the new immutable `updatedPO`. Other consumers (POPreviewDialog default lookup, future Inventory side panels) read the new value on next render.
3. **Inventory bump** — for each line with a positive delta:
   - Find `items[i].stock.find(loc.locationId === warehouseId)` (default `loc_wh_main` — Brooklyn HQ Main Warehouse).
   - Increment `onHand += delta`. If the warehouse has no stock row yet, append one with `{ onHand: delta, reserved: 0 }`.
   - Never decrement on a receive (a downward edit is treated as a correction, not a return — returns flow through §7.5).
4. **Staging mirror** — when `po.stagedAsJobStageId` is set:
   - Find the matching `JobStage`.
   - For each staged line where `poNumber === po.poNumber AND itemSku === <line>`, bump `qtyReceived` by the delta.
   - Re-compute stage `status` from the new line totals (`awaiting` → `partial` → `complete`) and stamp `updatedAt`.
   - The Staging page picks up the new state on next render (no extra wiring needed — same shared-seed-array pattern).
5. **Return value** — caller gets `receivedDeltaUnits`, the warehouse name (for toast copy), the SKU list, and the staging mirror result if any.

**Receive-mode UX in PODetailDialog Lines tab:**

- Entering receive mode (`Receive items` / `Receive remaining` primary) seeds a `receiveDraft: Record<sku, qty>` from the current `po.lines.qtyReceived`.
- Quick-action strip above the table (emerald) with `Reset` (revert draft) and `Receive all` (every line → `qtyOrdered`) buttons.
- Each row's Received column becomes a clamped number input (`min=0`, `max=qtyOrdered`).
- A trailing per-row action column shows either a **+1** button (bumps one unit · matches StagingView's "Receive +1" pattern) or a green `Full` chip when the draft = ordered.
- On **Save Receipt**, the page-level `handleReceive` calls `applyReceive`, replaces the page's `allPOs` state, feeds the new PO back into PODetailDialog (so the dialog re-renders with the new status pill + footer primary), and fires a toast at the page level.

**Toast format:**
> ✓ PO-2308 updated · +30 units received · stock bumped at Main Warehouse · Brooklyn HQ · staging stg_002 → complete

Stage segment is omitted when the PO has no `stagedAsJobStageId`. Toast auto-dismisses after 4.5s; positioned bottom-center at `z-90` so it floats above the dialog.

### 7.4.B.8 `NewPODialog` — `+ Create PO` CTA target (shipped rev 2026-05-28)

The manual back-office entry point from §7.2.1. **Shipped** end-to-end in rev 2026-05-28 across several iterations (see changelog entries above for `NewPODialog` and `Create PO`); current behavior locked here.

**Shell:**
- Modal at default `zIndex={50}` with **`size="xl"`** (max-w-4xl ≈ 896px) — bumped from `lg` in the rev-2026-05-28 line-item-table fix so the 4-column Item · Qty · UoM · Delete table fits without overflow.
- Title: *"Create Purchase Order"* · Subtitle: *"Saves as a draft on the Pre-PO tab. Send to the vendor from PO Detail when you're ready."*

**Body fields:**

- **Vendor*** — dropdown of active `vendors[]` with `Truck` icon glyph inside the input, alphabetically sorted. Pre-fills from a linked job's reservation `preferredVendor` or RFQ winning quote when applicable (see Auto-fill below).
- **Expected Delivery** (optional) — native `<input type="date">`.
- **Job Link** (optional, full-width fieldset) — single search input *"Find a job by # · customer · site…"* with the rev-2026-05-28 typeahead that auto-fills Job # · Customer · Site · Trade in one click (see changelog entry for the typeahead spec). Picking a job also triggers **Auto-fill** below.
- **Existing-PO callout** (conditional, renders directly above the line-items table when the linked job has ≥1 open PO) — amber `ClipboardList`-icon banner: *"This job already has N open PO(s) — review before adding lines"* with a bulleted list of each existing PO (`PO-#### · &lt;vendor&gt; · N items (rec/ord units received)`). Footer copy: *"Items on those POs are already in flight — add lines here only for SKUs the existing POs don't cover."* Filter: existing PO status ∈ `{ draft | sent | partial }` — closed / received POs aren't relevant for double-order risk.
- **Auto-fill banner** (conditional, renders just above the line-items table when `pickJob` populated rows) — indigo `Sparkles`-icon banner: *"Auto-filled N lines from EST-XXXX"* (or RFQ-XXXX) with body copy *"These are items the customer already approved on the estimate — adjust qty or remove rows as needed."* (reservation source) or *"Pulled from the open RFQ for this job. Confirm the vendor matches the quote you're committing to."* (RFQ source). Right-edge **× Clear** action resets the lines to one empty row and dismisses the banner.
- **Line Items*** — table with rev-2026-05-28 styling fixes:
  - Header row: Item · **Qty** (`min-w-[6.5rem]` hard floor, centered) · **UoM** (`min-w-[3.5rem]`) · action column (`min-w-[3rem]`).
  - **Item picker** — full-view modal browser (`ItemSearchModal`) per the rev-2026-05-28 entry; vendor-aware grouping; inline *"+ Add a new item"* path opens AddItemDialog at z=80.
  - **Qty input** — `type="number"` with native ↑↓ spinner arrows suppressed via `[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`; centered + `tabular-nums`.
  - **Delete** — visible bordered chip (`inline-flex h-7 w-7 ... border border-slate-200 bg-white hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600`) with `Trash2` icon, in the rightmost column of every row. Disabled with helper title *"At least one line is required"* when only one row remains.
  - **+ Add line** button above the table.

**Auto-fill behavior** (when `pickJob` is triggered from the Job Link typeahead):

| Source for `job.jobNumber` | Action |
|---------------------------|--------|
| Estimate Reservation match (highest signal — customer approved) | Populate every `reservation.lines[]` row, resolve `itemSku` → catalog `Item.id`, set qty from the reservation. Prime Vendor with `reservation.preferredVendor` if currently empty. Banner reads *"from EST-XXXX"*. |
| Open RFQ match (only if no reservation) | Populate `rfq.lines[]`. Prime Vendor with `rfq.quotes.find(q => q.recommended)?.vendor` if currently empty. Banner reads *"from RFQ-XXXX"*. |
| Neither | No auto-fill; existing empty starter row left alone. |
| Existing open PO(s) match (any combination of above) | Render the amber existing-PO callout regardless of whether auto-fill fired. |

**Guard:** auto-fill only fires when the form is still untouched — `lines.length === 1 && !lines[0].itemId && lines[0].qty ∈ ["", "1"]`. Manual edits are never clobbered. **Unlink behavior:** clicking Unlink on the linked-job pill clears the auto-filled lines AND the banner, restoring the single-empty-row baseline (since those lines belonged to the previous job).

**Footer:**
- **Cancel** — closes the dialog.
- **+ Save Draft PO** (primary, indigo) — validates vendor + each line item picked + each qty > 0, generates the next sequential PO number, stamps `orderedAt`, persists `status: "draft"`, calls `onCreate(po)`. The page handler prepends to `allPOs`, jumps to the Pre-PO tab, and fires an emerald *"&lt;PO#&gt; saved as draft"* toast.

**Edge cases:**
- Tax computed from branch default rate (8.875% NYC seeded); editable per-PO via the existing PODetailDialog Lines tab — not in NewPODialog.
- Form reset on every open (no stale state across PO creations).
- Per-line unit cost capture defers to PODetailDialog (the `poTotal` helper still estimates at $50/unit until the price-book join lands).
- **Out of scope (defers to follow-up rev):** Get 3 Estimates inline (currently routed via PrePODetailDialog after the RFQ row exists); Send-to-Vendor fast path (currently a two-step — Save Draft → open in PODetailDialog → Send); duplicate-SKU merge with amber flash; vendor-change soft warning with cost re-price; new-vendor inline create with auto-select (vendor add wires via AddVendorDialog elsewhere).

### 7.4.B.9 `PrePODetailDialog` — RFQ / Estimate Reservation detail (shipped rev 2026-05-28)

Clicking an **RFQ** or **Estimate Reservation** row in the Pre-PO tab opens a dedicated `PrePODetailDialog` rather than reusing `PODetailDialog` (which is shaped around a real PO with `qtyReceived`, vendor email, three-way match). The dialog mirrors PODetailDialog's chrome — header summary card · 3 inner tabs · status-adaptive footer — but swaps the body to match the row kind.

**Header summary card** (sits just under the Modal title, full-width slate strip):
- Status chip — *"READY TO COMPARE"* emerald / *"AWAITING QUOTES"* amber / *"ESTIMATE APPROVED"* sky.
- Primary vendor pill with `Truck` icon — the recommended quote's vendor for RFQ, the `preferredVendor` for Reservation. RFQ rows also show an emerald **RECOMMENDED** badge next to the vendor name.
- Trade pill (when set on the row).
- Right-aligned meta strip: `<whenLabel>: <date>` → `<dueLabel>: <date>` · primary total in monospace bold.

**Tabs:**

| Tab | RFQ body | Reservation body |
|-----|----------|------------------|
| **Items** | Line list (`#` · SKU mono · description · UoM · qty right-aligned) with footer total-units strip. Both row kinds use the same renderer over `meta.lines: PrePOLine[]`. | Same renderer — sources from `reservation.lines`. |
| **Vendor Quotes** / **Estimate** | Tab label is *"Vendor Quotes"* with quote count badge for RFQ. Body: green recommendation banner (winning vendor + total + lead-days + composite-score formula) above a compact 5-col table: Vendor · Total · Lead · vs Cheapest delta% · Notes. Recommended row gets `Crown` icon + emerald tint. "Cheapest" / "Fastest" cells get colored superlative badges. Footer button **Open full side-by-side comparison →** launches `EstimateComparisonDialog` (§7.2.B) at `zIndex={80}` with `lockEscape`. If RFQ status is `awaiting_quotes` the body shows a hourglass placeholder: *"Quotes haven't come back yet · Sent to 3 vendors on &lt;date&gt; · Responses due &lt;date&gt;"* with a pointer to the Email Activity tab. | Tab label is *"Estimate"*. Body: sky-tinted banner (`CheckCircle2` icon · *"Customer-approved estimate"* · EST-#### · approved-on date · customer email · preferred vendor + right-aligned reserved total). Below it a 6-col line table: # · SKU · Description · Qty · UoM · Ext. Reserved (synthesized proportionally from `reservedTotal × qty/totalUnits` until per-line unit prices land in the data model — a small slate caveat box at the bottom names the constraint). Footer total row shows the reserved grand total. |
| **Email Activity** | Chronological thread (sorted by `sentAt` ASC) of every entry in `meta.emails: EmailThreadEntry[]`. Each entry renders as a card with: colored kind chip (`RFQ sent` indigo · `Vendor quote` emerald · `Estimate sent` sky · `Customer reply` emerald · `Follow-up` slate), direction label (*"→ Sent to"* / *"← Received from"*) with a `User` icon, sender/recipient, right-aligned timestamp, full subject (bold), body in `<pre>` preserving whitespace, attachment chips (`Paperclip` icon · filename) at the bottom. Inbound emails get a green left-border accent so the thread reads vendor-quote / customer-reply at a glance. | Same renderer — sources from `reservation.emails`. |

**Status-adaptive footer:**

| Row state | Primary CTA | Secondary buttons | Helper text |
|-----------|-------------|-------------------|-------------|
| RFQ · `ready_to_compare` | *"Compare quotes & pick winner"* (Crown icon, indigo, opens EstimateComparisonDialog) | Close · *"Open full comparison"* | *"✓ All 3 quotes received · ready to pick a winner"* |
| RFQ · `awaiting_quotes` | *"Send reminder to vendors"* (Send icon, **disabled**) | Close | *"⧗ Waiting on N of 3 vendors"* |
| Reservation | *"Convert to Purchase Order"* (ArrowRight icon, indigo) | Close | *"✓ Reserved $X,XXX.XX · awaiting PO conversion"* |

**Embedded full-comparison flow:** the *"Compare quotes & pick winner"* primary AND the *"Open full comparison"* secondary both call the same handler that toggles a local `showFullCompare` state, which mounts `<EstimateComparisonDialog>` nested at `zIndex={80}` with `lockEscape`, passing `lines={row.data.lines}` and an `onPickWinner` callback. v0.1 closes the nested dialog on pick without yet writing the winner back to the RFQ — that wiring lands in §7.4.B.4's "RFQ → Draft PO promotion" follow-up.

**Data shape (`pre-po.ts`, shipped this rev):**

```ts
export type PrePOLine = { itemSku: string; itemName: string; qty: number; uom: string; };

export type EmailThreadEntry = {
  id: string;
  direction: "outbound" | "inbound";
  kind: "rfq_sent" | "vendor_quote" | "estimate_sent" | "customer_reply" | "follow_up";
  from: string;
  to: string[];
  subject: string;
  body: string;
  sentAt: string;
  attachments?: { label: string; kind: "pdf" | "xlsx" | "image" }[];
};

// Both RFQ and EstimateReservation now carry:
//   lines: PrePOLine[]
//   emails: EmailThreadEntry[]
// EstimateReservation also carries optional customerEmail.
```

**Draft rows continue to route to PODetailDialog** (they already have a PO number + line shape that matches `PurchaseOrder`); only RFQ + Reservation rows open this dialog.

**Files:**
- `dashboard/src/components/PrePODetailDialog.tsx` (~450 LOC).
- `dashboard/src/components/PurchaseOrdersPage.tsx` — `prePOActive` state, `handlePrePOClick` routes by `r.kind`, `<PrePODetailDialog>` mounted alongside the existing PODetailDialog stack. The previously-scaffolded `NextActionButton` ("Compare quotes →", "Convert to PO →") in the Pre-PO row now bubbles its click up to `onRowClick` instead of firing its own alert.
- `dashboard/src/data/pre-po.ts` — types extended + every seeded row populated with realistic line + email data (3 RFQs · 2 Reservations).
- `dashboard/src/data/jobs.ts` — 4 jobs added (J-1872 · J-1874 · J-1876 · J-1877) so RFQ + Reservation `jobNumber` references resolve in the typeahead.

**Acceptance criteria (v1.1):**
- [ ] Clicking an RFQ row in Pre-PO opens PrePODetailDialog with the RFQ#'s lines, quotes, and email thread.
- [ ] Clicking a Reservation row in Pre-PO opens PrePODetailDialog with the EST#'s lines + customer estimate breakdown + customer email thread.
- [ ] Clicking a Draft row in Pre-PO still opens PODetailDialog (not PrePODetailDialog).
- [ ] The **Items** tab renders one row per `PrePOLine` with correct SKU + UoM + qty.
- [ ] On an RFQ with `status: "ready_to_compare"` the **Vendor Quotes** tab shows the green recommendation banner + 3-vendor table + functional *"Open full side-by-side comparison"* button (opens EstimateComparisonDialog at z=80).
- [ ] On an RFQ with `status: "awaiting_quotes"` the **Vendor Quotes** tab shows the hourglass placeholder with the *"Responses due"* date.
- [ ] On a Reservation the **Estimate** tab shows the sky banner + line table with synthesized extended prices that sum to `reservedTotal`.
- [ ] The **Email Activity** tab shows every email in chronological order with correct kind chip, direction label, sender/recipient, timestamp, body, attachments.
- [ ] The status-adaptive footer renders the right primary CTA + helper text per the table above.
- [ ] EstimateComparisonDialog opened from this dialog respects Escape (closes only the nested compare, not the parent dialog) thanks to `lockEscape`.

### 7.4.B.10 File inventory (this rev)

**Created:**
- `dashboard/src/components/PurchaseOrdersPage.tsx` — the page itself (header · 4 KPI tiles · 3 sub-tabs · search/filter · per-tab tables · dialog mounting · receive toast).
- `dashboard/src/components/PODetailDialog.tsx` — detail dialog (header summary · 4 inner tabs · status-adaptive footer · receive mode in Lines · nested Preview + Email dialogs · email-sent toast).
- `dashboard/src/components/PrePODetailDialog.tsx` — dedicated detail dialog for RFQ + Reservation rows (forward; per §7.4.B.9).
- `dashboard/src/data/pre-po.ts` — `RFQ`, `EstimateReservation`, `PrePOLine`, `RFQQuote`, `EmailThreadEntry` types + seed data.
- `dashboard/src/lib/po-receive.ts` — `applyReceive` + `derivePOStatus` helpers (central receive orchestration).

**Modified:**
- `dashboard/src/components/Sidebar.tsx` — `Route` union gains `"purchase-orders"`; child nav item gains `route: "purchase-orders"`; comment header updated.
- `dashboard/src/App.tsx` — imports `PurchaseOrdersPage`; router gains the third route branch.
- `dashboard/src/data/purchase-orders.ts` — appended 2 draft POs to seed the Pre-PO tab.

### 7.4.B.11 Acceptance criteria (v1.1)

- [ ] Clicking **Purchase Orders** in the sidebar routes to `PurchaseOrdersPage` in <100 ms with no flash.
- [ ] Default landing tab is **Open**.
- [ ] Sidebar parent **Inventory** stays visually active.
- [ ] Breadcrumb reads `Operations › Inventory › Purchase Orders`.
- [ ] Top-right **+ Create PO** button is present (currently opens the NewPODialog placeholder alert per §7.4.B.8).
- [ ] All 4 KPI tiles render with seeded counts; click jumps to the right tab + applies the right filter.
- [ ] Only **one** KPI tile can be lit at a time; clicking the lit tile clears the filter; clicking a sub-tab also clears any lit tile.
- [ ] Pre-PO tab shows 3 RFQs + 2 Drafts + 2 Reservations sorted by Age DESC; the `awaiting_quotes` RFQ shows *"N/3 quotes received"* amber.
- [ ] Open tab sort puts late rows first, then expected date ASC.
- [ ] Late rows render rose with a 🔴 dot; arriving-this-week renders amber.
- [ ] Hover an Open row → 3 icon buttons (👁 Preview · ✉ Email · 📦 Receive) appear and `stopPropagation` correctly.
- [ ] Clicking a real PO row opens **PODetailDialog**; clicking a History PO # opens **POPreviewDialog** directly.
- [ ] PODetailDialog inner tabs render their respective bodies (Lines · Activity · Documents · 3-Way Match); only Lines is fully functional in v1.1.
- [ ] Footer primary action adapts to status per the table above.
- [ ] **Email** footer button opens POEmailDialog nested at z=80; send fires the inline toast.
- [ ] **Preview / Print** footer button opens POPreviewDialog nested at z=80; Esc closes only the preview.
- [ ] **Receive items** flow enters receive mode; per-line +1 / number input / Receive all all work; Save Receipt:
  - [ ] writes the new `qtyReceived` per line
  - [ ] auto-derives the new PO status
  - [ ] bumps `items[sku].stock(loc_wh_main).onHand` by each positive delta
  - [ ] mirrors deltas to the linked `JobStage.items[sku].qtyReceived` when `po.stagedAsJobStageId` is set
  - [ ] re-computes the linked stage's status
  - [ ] surfaces the page-level emerald toast describing PO + delta + warehouse + (optional) staging mirror
- [ ] After a Save Receipt that fully receives a PO, the row leaves the Open tab and appears in History; the KPI counts update.
- [ ] Switching to the Inventory page after a receive shows the bumped on-hand counts at Brooklyn HQ.
- [ ] Switching to Inventory → Staging after a receive against a linked stage shows the mirrored `qtyReceived` + new stage status.

### 7.4.B.12 Open questions

- `[OPEN-7.4.B-1]` `PurchaseOrder` type lacks a true `receivedAt` field — History tab uses `expectedDate` as a proxy. Add `receivedAt: string` to the type, set it inside `applyReceive` when the PO transitions to `received`, and update the History sort.
- `[OPEN-7.4.B-2]` Variance column in History is a placeholder pending the three-way-match wiring per §7.4. Define the tolerance lookup (vendor.price_tolerance_percent · vendor.qty_tolerance_percent) and the badge tone matrix.
- `[OPEN-7.4.B-3]` Unit cost in PODetailDialog Lines tab + the page's `poTotal` helper use a $50 fallback. Replace with a join against `items.unitCost` (price book) once the items table is reachable from this surface.
- `[OPEN-7.4.B-4]` `purchase_order_status_history` is currently synthesized inside ActivityTabStub from PO status. Wire to the real append-only event stream when the backend ships it; each PO mutation (create · send · receive · partial-receive · close · cancel · re-open · edit · email) should append an event.
- `[OPEN-7.4.B-5]` Documents tab is a stub. Define: per-document type (PO PDF · vendor quote · packing slip · vendor bill), storage (S3 / blob), drag-drop upload UX, EXIF capture-time metadata, per-doc permissions.
- `[OPEN-7.4.B-6]` Draft → Send to vendor primary action is currently a `[scaffold]` alert. Wire to: persist `status: "sent"` + open POEmailDialog pre-filled + post a `sent_to_vendor` event to the activity log.
- `[OPEN-7.4.B-7]` Received → Close PO primary action is a `[scaffold]` alert. Define: closure preconditions (must have vendor bill matched? configurable per org?), the optional short-ship reason capture, and the activity log event.
- `[OPEN-7.4.B-8]` PrePODetailDialog full spec — UX for RFQ winner selection (re-use EstimateComparisonDialog body? Or new layout that includes the email thread inline?), Reservation → PO conversion flow.
- `[OPEN-7.4.B-9]` Cross-page event bus — today inventory and staging updates rely on the React state replace + shared seed mutation pattern. If a user has Inventory and PurchaseOrders open in two tabs, the second tab doesn't observe the change. Define an event bus (extension of the existing `alert-bus.ts` pattern) for cross-tab + cross-window sync once the backend lands.
- `[OPEN-7.4.B-10]` ⋯ overflow menu for PODetailDialog (Duplicate · Convert to template · Export as CSV · Print labels for received items · Cancel/Void with reason · Delete drafts only) — designed but not built; lands in the next rev.

## 7.5 Returns + Credits

- `vendor_return` flow: open completed receipt → mark items return → RMA number capture → photo evidence → reason code → submit.
- `credit_memo`: generated on vendor approval; reduces AP balance OR offsets future bill.
- Differentiator: no competitor ships this `[A5, Agent 2]`.

## 7.6 Vendor Management

- `vendor` master: payment terms, default lead time, tolerance %, transmit method, accounting_vendor_ref.
- `vendor_catalog_item` (Phase 2 deep): mapping of vendor part numbers to internal items.
- Vendor performance scoring (Phase 2 AI P1): on-time, accuracy, variance frequency.

**`[PROTOTYPE v1.1]` Vendor record additions:**

- `vendor.pickup_address text` — will-call / counter location for in-person pickup; surfaced in Staging UX as an auto-filled, editable info card when picking the vendor. The AddVendorDialog field labeled *"PICKUP / SHIP-FROM ADDRESS"* (placeholder *"Will-call counter address — surfaced on pickup tickets"*) uses the shared `<AddressAutocompleteInput>` component spec'd in §11.1.A — typeahead via Google Places API, picking a suggestion auto-fills the new `vendor.address_components jsonb` companion column with structured street + city + state + ZIP + lat/lng + Google `place_id` `[SPEC-ONLY v1.1 — prototype keeps plain text input until Google billing is enabled]`.
- **Inline create flow**: every place that asks for a vendor (Add Item, Restock, Add Stage) presents a dropdown of the org's vendors with **"+ Add new vendor…"** as the last option. The AddVendorDialog captures: name (required), category, account number, payment terms (Net 15/30/45/60 / COD / Prepaid), default lead time, PO transmit method (Email / Vendor Portal / EDI / Phone), contact email + phone, pickup address, notes. New vendor is added to the org-scoped list AND auto-selected in the parent picker.
- **PO Transmit Method — multi-select pill picker (rev 2026-05-27):** the AddVendorDialog "PO Transmit Method" field was a single-select radio-style pill picker; it's now **multi-select** — operators tick every channel a vendor accepts (Email + Vendor Portal + EDI + Phone / Will-Call in any combination, because real vendors take EDI for normal orders, Phone for emergency will-call, and Email for backup all at once). Helper copy under the label reads *"Pick every channel this vendor accepts — you can use any of them when sending a PO. The first one you check is the default."* Active pills get an indigo ring + a tiny ✓ check icon prepended to the label; when two or more are selected an indigo helper line appears below the pills reading *"N channels selected · default: &lt;first&gt;"*. **Last-pill guard:** the dialog enforces ≥1 method at all times — the only-still-selected pill renders `disabled` with tooltip *"At least one transmit method must stay selected"* so the operator can't end up with an empty set. **Data model (rev 2026-05-27):** new `Vendor.transmitMethods?: TransmitMethod[]` field holds the full set (one entry per ticked channel); the existing `Vendor.transmitMethod` (singular) is preserved as the **primary / default** channel and is always equal to `transmitMethods[0]` so back-compat for every reader that expects a single string is intact (VendorCard chip · VendorDetailDialog display + edit-mode pill picker · AddItemDialog vendor preview strip · EstimateComparisonDialog quote line · POEmailDialog recipient derivation). The new `TransmitMethod` type alias (`"email" | "edi" | "portal" | "phone"`) is exported from `data/inventory.ts` so downstream files share a single source of truth. **Legacy records** (older saved vendors without `transmitMethods`) are treated as `[transmitMethod]` — readers can do `vendor.transmitMethods ?? [vendor.transmitMethod]` to get the full list. Validation: submit rejects an empty set with the inline rose banner *"Pick at least one PO transmit method."* (defense-in-depth — the UI guard above prevents this state, but the server should validate too). **Edit-dialog parity (rev 2026-05-27):** the `VendorDetailDialog` edit-mode pill picker matches the AddVendorDialog behavior one-for-one — multi-select pills with the same active styling, check icon, last-pill `disabled` guard, helper line, and a small white-on-indigo `DEFAULT` badge on the primary chip when ≥2 are selected. `DraftFields.transmitMethods` (array) replaces the old `transmitMethod` singular in the draft state; `toDraft(vendor)` promotes legacy single-value records via `vendor.transmitMethods ?? [vendor.transmitMethod]`; `diffDraft` patches both `transmitMethod` (= `transmitMethods[0]`, back-compat) and `transmitMethods` (full array) when the set changes. Two helpers (`transmitMethodsEqual`, `toggleTransmitMethod`) sit alongside the dialog. **Read-mode display** in the same dialog joins every configured channel (`PORTAL · PHONE · EMAIL`) with a muted `(default: portal)` annotation when more than one is on file, matching the footer line *"PO transmit:"* on the pickup card.
- **Multiple contacts per vendor (rev 2026-05-27):** every vendor can now carry an arbitrary number of extra contacts beyond the primary contact person / email / phone fields shown in the screenshot. Each extra contact is a separate person — typical roster: Orders rep (the primary), Accounts Payable, Branch Manager, After-hours dispatch, Returns desk — and carries its own optional `name` · `email` · `phone` · `role` (free-form, e.g. *"AP"*, *"Branch Manager · Jamaica NY"*, *"After-hours"*). UX is the standard "+ Add contact" card pattern: the AddVendorDialog and the VendorDetailDialog (edit mode) both show the primary contact fields at the top, then a labelled **"Additional contacts (N)"** strip with a **`+ Add contact`** button on the right; clicking adds a new card with name / role / email / phone inputs in a 2-column grid + a trash X to remove. Cards are listed in insertion order; the first card (after the primary) is "Contact #2", then #3, and so on. **Read-mode rendering:** in the VendorDetailDialog the Contact card shows the primary info as before, then a horizontally-separated *"Additional contacts"* sub-section listing each entry as a compact card (name + role on the first line, then `mailto:` email and `tel:` phone with the standard icons). **Vendor card pill:** vendors with extra contacts show a small indigo `+N` pill next to the primary contact name on the VendorCard (and a matching `+N more` pill in the Contact card header of the detail dialog) so the operator knows there's more behind the click. **Data model (rev 2026-05-27):** new `VendorContact = { id, name?, email?, phone?, role? }` type exported from `data/inventory.ts`; new `Vendor.additionalContacts?: VendorContact[]` field. Submit / patch normalises the list — drops any entry with all four optional fields empty so the array doesn't accumulate phantom rows from partially-filled cards. Production schema diff: new `vendor_contact` table joined to `vendor` on `vendor_id` (see Appendix A.5). **Seed:** ADI / Anixter ships with three additional contacts (AP rep · Branch Manager · After-hours dispatch line) so the prototype demonstrates the populated state out of the box. **Email picker integration:** future revs of `POEmailDialog` and `EmailComposeDialog` will expose every additional contact as a one-click recipient chip alongside the existing `sales@<vendor-domain>` / `orders@<vendor-domain>` heuristic suggestions — same chip pattern, sourced from the real `Vendor.additionalContacts` list. *(Out of scope this rev — the chips currently derive from the vendor name + standard aliases; wiring them to `additionalContacts` is a one-file change to each composer, tracked separately.)*
- **Vendor preview strip**: when a vendor is selected in any dropdown, a three-cell strip surfaces below showing `Terms · Lead time · PO transmit method` for at-a-glance context.

### 7.6.A `[PROTOTYPE v1.1]` Vendors Page — directory · category · spend analytics (rev 2026-05-27)

The **Vendors** sidebar item under Inventory routes to a dedicated `VendorsPage` — the single screen where ops staff manage who they buy from, how much they spend with each, and how that translates into negotiating leverage. Three sub-tabs share the same vendor list, filter row, and per-vendor card so muscle memory is consistent across views.

**Routing wiring:**

- App-level `route` state (`"inventory" | "vendors"`, defaults to inventory) lives in `App.tsx`.
- `Sidebar` accepts `currentRoute: Route` + `onNavigate: (r: Route) => void` props. Each `NavItem` carries an optional `route` field; clicking calls `onNavigate(route)` and (for groups) also expands the child list. The parent **Inventory** row stays lit when the current route matches any of its children's routes (so Vendors keeps Inventory active in the rail).
- Other sidebar items (Dashboard / Jobs / Customers / Estimates / Reports / Purchase Orders) are decorative placeholders in v1; their wiring follows once those pages exist. **Inventory** (new child added rev 2026-05-27 — routes to the existing `InventoryPage` with Items + Staging + Approvals tabs) and **Price Book** (rev 2026-05-27 — routes to a coming-soon placeholder, see §6.A) are now real routes. Cycle Counts and the user footer are unchanged.

**Vendor data model extensions** (`src/data/inventory.ts`):

| Field | Type | Notes |
|---|---|---|
| `contactPersonName?` | string | The actual rep the operator talks to. Surfaced on the card, in the Contact column of the analytics leaderboard, and as the first field on the Detail dialog's Contact card. |
| `website?` | string (URL) | Vendor portal / catalog. Renders as a click-thru external link with the protocol stripped for display (`www.adiglobal.com` instead of `https://www.adiglobal.com/`). |
| `status?: "active" \| "inactive"` | enum | Soft-archive flag. Missing = active. Hard-delete is reserved for vendors that have no open POs and no linked inventory items; everything else uses archive. |

**Page header** (mirrors InventoryPage):

- Breadcrumb `Operations > Inventory > Vendors`, page title `Vendors`, descriptive subtitle: *"Master vendor list · spend tracking · purchasing power. Track who you buy from, how much, and what they cost you year to date — ammunition for negotiation."*
- Top-right **`+ Add Vendor`** primary button (admin-gated via `canEditCatalog`), opens the existing `AddVendorDialog` (now with Contact Person + Website + Pickup Address + Category picker — see *Category picker* below).
- **KPI tile row** (3-up, **all tiles clickable as locked filter triggers** — rev 2026-05-27 — same pattern as the Items KPI tiles (§5.4.A) and Staging KPI tiles (§7.4.A.2)):
  - **Active Vendors** — count of `vendor.status !== "inactive"`. Hint: `of N total · click to show only active`. **Click jumps to the Directory sub-tab and flips the status filter to Active.** Active state (Directory tab + status=Active): the tile gets an indigo ring + a tiny `FILTERED` pill next to the label.
  - **Total Spend YTD** — sum of all vendor YTD spend across the org. Hint: *"across all vendors · click for spend leaderboard"*. **Click jumps to the Spend Analytics sub-tab.** Active state (Analytics tab): indigo ring + `FILTERED` pill.
  - **Categories** — count of distinct `vendor.category` values. Hint: *"distinct vendor types · click to group by category"*. **Click jumps to the By Category sub-tab.** Active state (Category tab): indigo ring + `FILTERED` pill.
- **Top Vendor — removed from the KPI row (rev 2026-05-27)** and relocated to a prominent banner at the top of the Spend Analytics tab (see below). Rationale: the *"who do we spend the most on?"* conversation actually happens when the operator pulls up the spend leaderboard, not when they're glancing at the page header — keeping it out of the header row reclaims space for the three filter-triggering tiles and tells a cleaner story (page header = "what / how many", Analytics tab = "money story including the winner").

**Sub-tabs** (defaults to Directory):

1. **Directory** — responsive card grid (1 col mobile / 2 col tablet / 3 col desktop) of every vendor that passes the filter row.
2. **By Category** — same cards, grouped by `vendor.category` with a section header per group: `<category-name> · <vendor-count> · $<YTD> YTD`. Sorted alphabetically by category. Lets the operator answer *"which vendor do I use for what?"* at a glance.
3. **Spend Analytics** — a single leaderboard table ranked by YTD spend desc. Columns: rank (with a 🥇 `Award` icon on row 1, indicating the top vendor — no separate banner above; rev 2026-05-27 the prior amber-gradient banner was removed because the #1 row already conveys "who do we spend the most on" without duplicating the data) · vendor name + contact person subtitle · category · YTD spend (mono right-aligned) · share-of-spend bar (emerald, 24px wide, fills proportionally to the leader) · MoM trend (`TrendingUp` emerald or `TrendingDown` rose + signed % delta vs last month; `—` when there's no last-month baseline) · PO count · last-ordered relative date. The whole row is clickable → opens the Detail dialog. Footer banner reads *"Purchasing power = your share of total inventory spend. Vendors at the top of this list are your strongest negotiation levers — when you're about to start a big job, lead with your YTD volume to ask for better terms, faster ship, or discount tiers."*

**Filter row** (shared across all three tabs):

- Search input matches against `name`, `contactPersonName`, `accountNumber`, `contactEmail`, and `category` (case-insensitive substring).
- **Category dropdown — inline add + rename (rev 2026-05-27):** a custom popover-style picker (`<CategoryManagerDropdown>`, new) replaces the native `<select>` that used to sit here. Closed state shows the active selection as a button (`All categories` or the chosen category name) with a chevron. Open state shows: (1) an `All categories` row at the top that clears the filter; (2) a scrollable list of every category — each row has the category name on the left and a hover-revealed ✏️ pencil icon on the right that swaps the row into an inline rename input + ✓ save / ✕ cancel; (3) a pinned `+ Add new category` button at the bottom that expands into an inline create input + ✓ save / ✕ cancel; (4) a slate footer reading *"Renaming a category updates every vendor that uses it. New categories become available everywhere in the app."* — sets expectations for the cascade. **Rename cascade:** `VendorsPage.handleRenameCategory(old, new)` iterates the `vendors` state and rewrites every `vendor.category === old` to `new` in a single state update; if the active filter was pointing at `old` it follows the rename so the operator doesn't lose their place. Also updates any orphan (vendor-less) category in the `extraCategories` state. **Add semantics:** `handleAddCategory(name)` pushes the new name onto a separate `extraCategories: string[]` state in `VendorsPage` (so categories can exist before any vendor is attached to them) — the visible category list is the union of `vendors[*].category` + `extraCategories`. Toast fires on both: `🏷 Category "<name>" added` and `✏️ Category renamed: "<old>" → "<new>"`. **Validation:** rename rejects empty / collision with an existing different category; add rejects empty / case-insensitive collision. **Production note:** the prototype keeps `extraCategories` in component state; production persists to a `vendor_category` lookup table (`id, organization_id, name, archived_at`) so adds + renames survive page reloads and so a category can be soft-archived without losing the audit trail.
- Status segmented control (`All | Active | Inactive`, defaults to `Active` so archived vendors hide).
- Live `N of M vendors` count on the right.

**Vendor card** (`VendorCard.tsx`) — used in Directory + By Category:

- Header row: vendor name (truncated, indigo on hover) + category subtitle + `ACTIVE` / `INACTIVE` pill.
- Contact block: 👤 person · ✉ email (mailto, `stopPropagation` so card click still wins for non-link clicks) · 📞 phone (tel) · 🔗 website (target=_blank, rel=noopener, indigo).
- Account + terms row (2-col, monospace account #, lead-time days alongside Net 30 etc).
- **Spend strip** (emerald-tinted) — bold `$<YTD>` headline · `N POs · last <relative>` on the right · share-of-spend bar (scaled to the org's top vendor so the leader fills 100%, everyone else fills proportionally) · `X.X% of total inventory spend` caption.
- Footer mini-row: pickup address (truncated) + transmit-method chip (`PO via email|portal|edi|phone`).
- Hover lifts the card 0.5px and brightens the border to indigo-300.

**Vendor Detail Dialog** (`VendorDetailDialog.tsx`) — reuses the universal `<Modal editAction>` pattern from the *Universal Edit affordance* entry:

- **Header**: `Vendor · <name>` + subtitle `<category> · acct <account#>`. Carries the `✏️ Edit` button (admin-only, hidden in edit mode) flipping to the amber `EDITING` pill on click.
- **Hero strip**: category chip · active/inactive pill · vendor id (mono) · `Last ordered <relative>` (or *"No POs yet"*).
- **Three-column overview**:
  - **Contact card** — person · email (mailto) · phone (tel) · website (target=_blank). In edit mode, each row becomes a small labeled input with the matching icon.
  - **Account card** — Account # (mono) · Terms · Lead-time days · PO via transmit method (read-mode joins the full set as `PORTAL · PHONE · EMAIL` with a muted `(default: portal)` annotation when ≥2 are on file). In edit mode, account becomes a mono input, terms becomes a `<select>` of the canonical options, lead time becomes a number input, **transmit method becomes a multi-select row of pills (rev 2026-05-27)** with the same active styling / check icon / last-pill guard / *"N channels selected · default: &lt;first&gt;"* helper line as the AddVendorDialog picker (see §7.6 PO Transmit Method bullet — *"Edit-dialog parity"*), plus a small white-on-indigo `DEFAULT` badge on the primary chip when ≥2 are selected so the operator can see at a glance which channel will be the default.
  - **Pickup / Ship-from card** — pickup address line + notes blockquote below. In edit mode both become small textareas.
- **Spend cards** (only in view mode, 4-up): YTD ($full) · This Month ($full) with `▲ / ▼ X%` MoM delta · All-Time · Avg PO ($short) with `Top: <item-name>` truncated subtitle.
- **Recent purchase orders** table (only in view mode): last 5 POs sorted by `orderedAt` desc — PO# · Job/Customer · ordered date · status pill · extended total ($short). Empty state shows a dashed-border card *"No purchase orders on file for this vendor yet."*. **Row click opens PO Preview (rev 2026-05-27):** every `<tr>` carries `role="button" tabIndex={0}` with `onClick` + `Enter`/`Space` keyboard handlers that fire `setPreviewPONumber(po.poNumber)`; hover/focus tints the row indigo (`hover:bg-indigo-50/60 focus:bg-indigo-50/60`), cursor flips to `pointer`, and the PO code cell renders in `text-indigo-700` so the actionable identifier reads like every other tappable PO# in the app. The nested `<POPreviewDialog>` renders at `zIndex={80}` with `lockEscape`, matching the `StageDetailDialog → POPreviewDialog` nesting pattern (rev 2026-05-26) — Esc / × / backdrop click peels just the preview layer, the Vendor Detail underneath keeps its focus + scroll position, and `previewPONumber` is also cleared by the parent's `open=false` useEffect so re-opening a different vendor never carries over a stale preview number.
- **Edit-mode "Vendor identity" panel** (only in edit mode, amber bordered): vendor name (rose-bordered when empty — validation gate) + category picker.
- **Footer** in view mode: `Close · Email Vendor` (mailto, only when email on file) `· Archive | Reactivate` (amber outlined, admin-only) `· Delete` (rose outlined, admin-only). In edit mode: `Cancel · Save Changes` (Save disabled until at least one field differs and name is non-empty; tooltip explains the block).
- `lockEscape` engages while editing so a stray Esc keystroke can't wipe changes.

**Delete flow** (`DeleteVendorDialog.tsx`) — block-and-suggest-archive:

- Computes two collections on open: **open POs** referencing the vendor (`status IN ('draft','sent','partial')`) and **linked items** (`Item.vendor === vendor.name`).
- If either collection is non-empty, the dialog renders a rose-bordered banner *"Cannot delete — vendor is still in use"* with copy explaining that hard-delete would orphan records. The primary footer button is replaced with an amber **Soft Archive Instead** CTA. Body lists each blocking open PO (PO# · job · customer · status pill) and up to 6 linked items (SKU · name, with `+ N more…` overflow).
- If nothing is blocking, the dialog renders an emerald *"No open POs and no inventory items reference this vendor. Deletion is safe."* note. The footer's red **Delete Vendor** button is enabled, and a small amber *"hard-delete is permanent"* heads-up sits in the body.
- Cancel always available top-right and as the footer's first button.

**Archive (soft-delete)**: toggles `vendor.status` between `active` ↔ `inactive`. Inactive vendors stay linked to historical POs and Items (so reports + audit trails don't break) but hide from the page's default `Active` filter and don't appear in vendor dropdowns elsewhere. Re-activate is the same toggle from the Detail dialog's footer (`ArchiveRestore` icon + "Reactivate" label when status is inactive).

**Category picker** (`VendorCategoryPicker.tsx` — new reusable component):

- Renders as a native `<select>` showing every distinct `vendor.category` from the live `vendors[]` (passed down as `existingCategories: string[]` from `VendorsPage`), sorted alphabetically. First option is the empty placeholder (`Select a category…`), followed by all known categories, a `──────────` divider, then `+ Add new category…` as the last option.
- Picking an existing option commits immediately. Picking the `__new__` sentinel swaps the select for an autofocused text input with a small `✕` cancel button that restores the dropdown. The new value is live-bound, so whatever's in the input becomes the form's category on save.
- Detects "legacy" values (current value not in the known options) and starts in the new-mode input pre-filled — so editing a vendor whose category was free-typed before this picker existed still feels natural.
- Optional `inEdit?: boolean` prop flips the border + focus-ring tint from indigo (Add mode) to amber (Edit mode) so the field matches the parent dialog's edit-mode visual language.
- Wired into both `AddVendorDialog.tsx` and `VendorDetailDialog.tsx` edit mode. After this, the same category gets typed *zero times* after the first vendor in that bucket.

**Spend math** (`src/lib/vendor-spend.ts`):

- `computeVendorSpend(vendorName, pos, items, now?)` returns `{ allTime, ytd, thisMonth, lastMonth, momDelta, momDeltaPct, poCount, ytdPoCount, avgPoSize, lastOrderedAt, topItemSku, topItemName }`. The function joins each PO's `lines[]` to the catalog by SKU, multiplies `qtyOrdered × item.unitCost` per line, and buckets the resulting PO totals by `orderedAt` against `now` (defaults to `new Date()`). `topItemSku` is the SKU with the highest cumulative extension cost across all of that vendor's PO lines — useful for the *"Top: <item-name>"* subtitle on the Avg PO card.
- `computeAllVendorSpend(vendors, pos, items, now?)` returns a `Map<vendorName, VendorSpend>` — the index `VendorsPage` reads from in render.
- Helpers: `totalSpendYTD(index)`, `totalSpendAllTime(index)`, `topVendorByYTD(index)`, `vendorShareOfYTD(spend, index)`, `recentPOs(vendorName, pos, n=5)`, `poExtension(po, items)`, `fmtMoney` (short — `$X.Xk` / `$X.XM` thresholds), `fmtMoneyFull` (no abbreviation), `fmtPct(n, digits=1)`, `fmtRelativeDate(iso | null)`.
- Production wiring: replace the catalog-join with a real spend-rollup table populated from PO receiving — `vendor_spend_rollup (vendor_id, ytd_amount, this_month_amount, last_month_amount, last_ordered_at, top_item_sku, refreshed_at)` updated on every PO line received. The page-level math stays unchanged because all reads route through the same `VendorSpend` shape.

**Permissions**:

- Add / Edit / Delete / Archive a vendor: gated by the existing `canEditCatalog(role)` helper (`owner` / `admin` / `office_admin` / `inventory_admin`). All other roles see the page in read-only mode (no `+ Add Vendor` CTA, no edit pencil, no delete / archive buttons).

**Acceptance criteria:**

- [ ] Clicking `Vendors` in the sidebar routes the right-pane to the Vendors page in <100 ms, no flash of inventory content. Inventory parent row stays visually active in the rail.
- [ ] All 4 KPI tiles render real values derived from `computeAllVendorSpend()` — totals reconcile to within $1 of the sum of the leaderboard rows.
- [ ] Switching between the three sub-tabs preserves the search query, category filter, and status filter.
- [ ] Soft-archiving a vendor immediately removes it from the default Active filter but keeps its row visible when the filter is flipped to All or Inactive.
- [ ] Hard-deleting is blocked for any vendor with an open PO or linked inventory item; the block message names the actual conflicting records.
- [ ] Adding a vendor with a category that doesn't exist yet (via the *"+ Add new category…"* path) makes the new category available in the picker for the very next vendor without a page refresh.
- [ ] Clicking a row in Spend Analytics opens the same Detail dialog as clicking a card.
- [ ] Field tech / dispatcher roles see the page, can read everything, but cannot edit / delete / add (all CTAs hidden).

## 7.7 Mobile PO Workflows

- Tech "Need part" on Job → truck/nearby/warehouse check → Create PO fallback.
- Condensed composer pre-fills vendor + job + customer + asset + branch + receive-to.
- Mobile counter receiving (per §7.4).

## 7.8 Accounting Integration Touchpoints

- Per-document push to QBO: PO, Bill, Payment, Credit Memo `[A39]`.
- Summary journal entries for inventory movements (daily/weekly).
- LinkedTxn between local PO line ID and QBO bill line ID stored explicitly (Agent 4 critical rule).
- Lock-after-post: posted invoice/PO/bill financial fields read-only in FSM.

## 7.9 Acceptance Criteria

- [ ] Tech creates PO from Job in <30 sec on mobile with required fields only.
- [ ] Receiving at counter completes scan + OCR + photo + finish in <60 sec p95.
- [ ] 3WM exception detection runs on every bill; tolerance configurable per vendor.
- [ ] Returns generate vendor RMA + credit memo with audit trail.
- [ ] PO ↔ Receipt ↔ Bill linkage stored explicitly for QBO sync correctness.

---

# 8. AI & Automation Features (Phase 1)

## 8.1 P0 AI Bets in MVP (5 features, all in MVP per A4)

### 8.1.1 Smart Search (Inventory + Price Book)
- Hybrid: BM25 + embeddings + reranker.
- Hybrid over `item`, `item_variant`, `catalog_item`, plus vendor aliases, alt SKUs, MPN, UPC.
- pgvector inside Postgres (not Pinecone/Qdrant) [Agent 7 strong opinion].
- Embeddings: `text-embedding-3-small`.
- Target: p95 < 200ms; >90% top-5 recall on normalized books.
- Result cards action-oriented (per Agent 5): Use part / Request transfer / Reserve / Create PO.

### 8.1.2 Voice-to-Parts Entry
- Streaming STT: **Deepgram Nova-3** at $0.29/hour (NOT OpenAI Realtime Whisper at ~$1/hour — Agent 7 explicit; 3.5x cost savings).
- Per-tenant phrase boosting from real catalog data (don't share across tenants).
- Parser → catalog reconciliation → confirmation sheet → never auto-post.
- Confidence threshold: abstain on low confidence.
- Multi-language: English-only v1, Spanish Phase 2 `[A17]`.

### 8.1.3 Vendor Invoice OCR + Auto-Match
- Buy specialist OCR (Veryfi / Mindee / Rossum) — don't build [Agent 7 + Agent 4].
- Pipeline: photo → OCR → parse → catalog match → match against PO line → auto-create `vendor_bill_line` w/ `match_status`.
- Variance > tolerance → `three_way_match_exception`.
- Human review workbench (never auto-post without confirm at threshold).
- Cost: $20-150/tenant/month — this is the COGS swing factor.

### 8.1.4 Catalog Ingestion + Auto-Categorization
- ETL: CSV/XLSX upload to S3 → parse → AI categorize (text + image embeddings + classifier) → review workbench → merge into catalog.
- Critical for BYO content path (A1) — accelerates first-run trial onboarding (A11 #1 flagship workflow).
- Cost: $20-100/tenant/month bursty during imports.

### 8.1.5 Owner Morning Brief + NL Ops Queries
- Curated semantic layer over org data (jobs, margins, AR, inventory, alerts).
- LLM (GPT-4.1-mini primary, Claude Sonnet for harder reasoning) — never trained on tenant data.
- Cited answers (link to source records).
- Read-only — never writes.
- Email + push delivery; in-app conversation surface.

## 8.2 Workflow Integration

- Smart Search appears in: "Find part" sheet (mobile), price book editor (web), PO line composer.
- Voice-to-Parts appears in: "Use part" sheet (mobile), Job notes capture.
- OCR appears in: PO receiving, counter receipt capture, AP back-office.
- Catalog Ingestion appears in: signup wizard (trade template + import), bulk price update.
- Owner Brief appears in: email digest + dashboard widget + Owner home screen.

## 8.3 Accuracy Expectations and Failure Handling

Per Agent 7:
- Smart Search: >90% top-5 — fail-soft to no-results UX with three recovery paths.
- Voice: 80-93% noisy field, 90-97% clean — always confirm, never auto-post.
- OCR: 90-97% clean printed, 70-90% messy — review workbench mandatory.
- Catalog AI: 85-95% major-category — user accept/edit.
- Owner Brief: cited answers only; abstain on low confidence.

**Trust framework (AI proposes vs AI decides):**
- AI proposes: search results, voice transcriptions, OCR fields, catalog categories, brief facts.
- AI does NOT decide: post stock movement, create bill, mint SKU, set price, send PO, charge customer.
- Human in the loop at every money-moving boundary.

**Audit log requirement (every AI-influenced action):**
- Model + version, retrieved records, prompt class, output, confidence, user action, business outcome.
- Stored in `audit_log` with hash chain (A20).

## 8.4 Cost Model & Gating `[A51]`

- Bundle search + voice + brief + catalog AI in base tier.
- Meter Vendor Invoice OCR pages with per-tier quota + overage charge:
  - Starter: 100 pages/mo, $0.10/page overage.
  - Pro: 500 pages/mo, $0.10/page overage.
  - Enterprise: 2000 pages/mo, $0.08/page overage.
- Optional hard-cap per tenant.
- Per-tenant cost dashboard with current consumption + month projection.

Direct AI COGS target: $20-60/tenant/month moderate use.

## 8.5 Tech Stack Summary

| Layer | Choice |
|---|---|
| Primary LLM | OpenAI GPT-4.1-mini |
| Secondary LLM | Anthropic Claude Sonnet 4.6 |
| Batch / cost-sensitive | Gemini 2.5 Flash |
| STT (streaming) | Deepgram Nova-3 |
| Vector DB | pgvector (Postgres) |
| Embeddings | text-embedding-3-small |
| Doc OCR | Veryfi / Mindee / Rossum |
| Translation (Phase 2) | OpenAI Realtime Translate |

## 8.6 Phase 2+ AI Roadmap (Summarized)

Phase 2: Vendor-cost-aware repricing (biggest underserved SMB feature), demand forecasting, replenishment recommendations, cross-truck balancing, spend anomaly, vendor scoring, dispatcher assistant, document understanding, GBB auto-builder, estimate copilot, translation.

Phase 3: Photo-to-SKU (loose parts), lead-time prediction, vendor selection optimization, selective agentic POs.

**Killed (Agent 7 explicit):** Per-customer pricing AI (ethics/legal), autonomous estimate-from-photo, autonomous money-moving actions, AI-authored SOPs as source of truth.

---

# 9. Integration Requirements

## 9.1 P0 Integrations at Launch (MVP)

| Integration | Category | Direction | Auth | Effort |
|---|---|---|---|---|
| QuickBooks Online | Accounting | Bi (FSM-master operational; QBO-master accounting) | OAuth 2.0 | L |
| Stripe (Billing + Terminal + Tap to Pay) | Payments + Subscription Billing | Bi w/ webhooks | OAuth | M |
| Avalara AvaTax | Tax | Bi real-time | OAuth | M |
| Wisetack | Financing | One-way embed in PB | OAuth | S |
| Zapier App | iPaaS / Public webhooks | Outbound + inbound triggers | API key | S |
| Generic CSV/EDI ingest | Vendor Catalog | Inbound | N/A | M |
| Veryfi (or Mindee/Rossum) | Doc OCR | API | API key | M |
| Deepgram Nova-3 | STT | API streaming | API key | S |

Vendor-specific catalog partnerships (Ferguson / Winsupply / ADI / Banner / IDN / CRL) **deferred** `[A15]` — generic CSV/EDI ingest framework ships v1; named partnerships layered Phase 2 based on customer traction.

## 9.2 Per-Integration Spec

(Full per-integration spec in Appendix D.)

### 9.2.1 QuickBooks Online Deep Dive `[A39]`

**Entity ownership (FSM = operational master, QBO = accounting consequence):**

| Entity | Master | Direction |
|---|---|---|
| Customer | FSM | FSM → QBO after initial import |
| Vendor | Split | FSM owns operational; QBO owns payable fields |
| Catalog item (stocked material) | FSM | FSM → QBO Item (inventory/non-inventory mapping) |
| Bundle/options | FSM | FSM → QBO Bundle |
| Purchase Order | FSM | FSM → QBO |
| Vendor Bill | FSM | FSM → QBO with explicit LinkedTxn IDs |
| Invoice | FSM | FSM → QBO; lock financial fields after post |
| Payment | FSM/Stripe | Either way |
| Class/Location | QBO | QBO → FSM as reference |
| Tax codes | Avalara | External engine; QBO mapped |
| GL Accounts | QBO | Always QBO |

**Inventory sync model**: operational stock ledger lives in FSM. QBO receives **summary journal entries** for COGS/inventory asset adjustments (daily/weekly), NOT per-movement push `[A39]`. Truck stock, bin workflows, warehouse transfers all stay in FSM.

**The big three failure modes (Agent 4):**
1. **Stale-object/update races** — Intuit requires serial writes to list entities. Mitigation: per-tenant per-entity queue; no parallel writers.
2. **Missed or out-of-order webhooks** — Intuit explicit. Mitigation: CDC reconciliation, daily backfill.
3. **Item-model mismatch** — QBO lacks serials + multi-location. Mitigation: operational ledger stays in FSM; QBO never authoritative for stock.

**LinkedTxn rule (critical):** Store local PO line IDs and QBO bill line IDs explicitly. Never infer linkage after the fact.

**QBD strategy `[A9]`**: `[DEFERRED]` — skipped in MVP. No commitment to ship QBD support in Phase 2. Revisit only if customer demand emerges (Codat partner integration is the likely path when revisited).

### 9.2.2 Stripe Deep Dive `[A19]`

- **Stripe Billing**: SaaS subscription billing — Starter / Pro / Enterprise tiers + metered OCR overage.
- **Stripe Terminal**: in-person card-present (M2 reader, S700/S710 if customer-supplied).
- **Apple Tap to Pay**: no hardware required.
- **ACH Direct Debit**: B2B invoice payment.
- **Surcharging**: per-state configurable per branch; never default-on; legal disclosure required `[A59.11]`.
- Webhook-driven async; HMAC SHA-256 signature.

### 9.2.3 Avalara AvaTax `[A18]`

- Real-time tax determination on quote/invoice/PO.
- CRM responsibility: line classification, exemption certificate handling, address normalization.
- Multi-state commercial work supported day 1.
- Exemption certificate upload per customer + per jurisdiction `[A59.10]`.

### 9.2.4 Wisetack `[A56]`

- Embedded in price book at item or service level (`financing_eligible_flag` + `financing_fee_pct`).
- Customer Present Mode shows financing teaser above threshold (Agent 5 pattern).
- Dealer fee disclosure mandatory.
- Margin-aware: markup engine accounts for dealer fee impact.

## 9.3 Webhook / API Surface (for customers)

15 public webhook events `[Agent 4]`:

```
inventory.item.created / updated
inventory.balance.changed
inventory.transfer.completed
pricebook.item.created / updated
purchase_order.created / approved / sent / received / closed
vendor.bill.received / posted
vendor.created / updated
```

- CloudEvents JSON envelope.
- HMAC SHA-256 signature.
- Delivery ID + event ID.
- Exponential backoff retry up to 72 hours.
- Manual replay UI in admin.
- Dead-letter table after terminal failure.
- **Buy** outbound delivery infra (Svix or Hookdeck) — don't build [Agent 4].

Public REST API surface at `/api/v1` (see Appendix B).

## 9.4 Vendor Catalog Strategy `[A15]`

- Generic CSV/EDI ingest framework v1.
- AI auto-categorization on import (AI feature A4).
- Vendor cost effective-dated (`vendor_cost` table, Agent 3).
- Named partnerships (Ferguson, Winsupply, ADI, Banner, IDN, CRL) layered Phase 2 based on customer demand.
- ServiceTitan supplier pattern: **nightly catalog refresh + live PO-time price/availability check** — never claim real-time everything [Agent 4].

## 9.5 Phase 2+ Integrations

- Xero, Zoho Books, Helcim (P1)
- ADI / Banner / IDN / CRL / Ferguson / Winsupply (P1, customer-traction-driven)
- The New Flat Rate (P1, if customers demand)
- Okta SSO + SCIM (P1, enterprise sales enabler) `[A59.23]`
- Twilio SMS/WhatsApp (P1)
- Fivetran connector for BI export (P1)
- Sage Intacct, NetSuite (P2 enterprise)
- Square (P2 — Counter-Shop bundle scope creep)
- ~~QuickBooks Desktop via Codat~~ — `[DEFERRED]`, no Phase 2 commitment

---

# 10. Mobile UX Requirements

## 10.1 Platforms Supported at Launch

- **React Native** (single codebase, Expo workflow recommended) `[A10]`.
- **iOS + Android in parallel from Day 1** `[A10]`.
- PowerSync + on-device SQLite for sync `[A10]`.

## 10.2 Offline-First Behavior

- **Local-first architecture, NOT "offline mode"** — user never mentally switches `[Agent 5]`.
- Object-level sync state indicators: **Saved on this device / Waiting to send / Sent / Needs attention / Changed on server**.
- What works offline: today's jobs, recent customers, local stock zones, critical price book subset, pending estimates, PO approvals, attachment metadata.
- Conflict UX in **field language**, never silent overwrite:
  - "Another tech used the last capacitor while you were offline. Your note is saved. Choose next step." → three recovery actions.

## 10.3 Sync Architecture

- **Server-authoritative** for stock / PO / price `[A23]`.
- **Local-first optimistic** for drafts only.
- Mobile posts **commands** (not balances): `consume`, `transfer`, `return`, `count_delta`.
- Each command: `client_operation_id`, `device_id`, `occurred_at`, `local_base_version`.
- Server dedupes by (org_id, client_operation_id); validates under row lock; returns applied + conflicts + reconciled balances.

## 10.4 Hardware Support at Launch `[A13 — refer-only]`

Certified-device allowlist published; in-app Hardware Health Check ships in MVP; setup guides + MDM (Intune, Jamf) guides ship. Customers buy direct from authorized distributors. No reseller operations.

Reference devices (Agent 13):

| Category | Recommended | Notes |
|---|---|---|
| Native camera scan | iOS VisionKit, Android ML Kit | Day-1 default, zero hardware |
| BT scanner (companion) | Socket S720 MFi | Default BYOD companion |
| BT scanner (alt) | Zebra CS6080 | Alternate |
| Handheld 2D | Honeywell Xenon 1952g | Counter alt |
| Rugged Android | Zebra TC27 + DataWedge | Van/warehouse |
| Mobile printer (truck) | Brother RJ-4250WB | Receipts/labels |
| Desktop label printer | Zebra ZD421 | ZPL-first |
| Receipt printer (counter) | Epson TM-m30III | Counter |
| Payments | Stripe Terminal M2 / S700/S710 / Apple Tap to Pay | Per A19 |

## 10.5 Key UX Principles (Agent 5)

1. Local-first, not offline-mode.
2. Search begins with uncertainty (accept SKU aliases, OCR, scans, photos, model fragments).
3. Default action is next field decision.
4. Customer view and tech view are different products on same data.
5. Every critical action has recovery language.
6. One-handed thumb-reachable; 48-56dp button heights.
7. Field completion, not "mobile companion."
8. No mode-switching, no hidden state.
9. Trust through restraint on customer-facing surfaces.
10. Hardware stratification is a design concern.

## 10.6 Customer-Facing Screen Rotation Flow (Customer Present Mode)

State machine: **Diagnose → Build internally → Present externally → Accept → Commit next action**.

- Tech Edit Mode: A/B/C tabs, internal costs visible, employee notes, dispatch tags, stock counts, vendor names.
- Customer Present Mode: GBB stacked (phone) or side-by-side (tablet); plain-language scope; 1-2 proof photos; lead time; warranty/membership impact; financing teaser if above threshold; single recommended badge.
- Rotate-to-customer is deliberate animated mode change with privacy scrub.
- Customer signs on own device via SMS/email link by default (A32).
- Change orders preserve signed baseline as child object (A33).

## 10.7 Push Notification Priorities

4 events get interrupt priority `[A59.6]`:
1. Job reassignment / emergency dispatch.
2. PO approved or rejected.
3. Customer signed/accepted.
4. Inventory conflict on current job.

Everything else is inbox.

## 10.8 Voice Features

- Voice-to-parts on Job (AI A4).
- Voice ops queries for Owner Brief (AI A4).
- NEVER required path for pricing, approvals, signatures `[Agent 5]`.

## 10.9 Acceptance Criteria

- [ ] Inventory decision-time on mobile <10 sec p95 (Agent 5 headline NFR).
- [ ] Tech completes "Use part" → posted in <3 sec p95.
- [ ] 8h-offline tech with 500 queued ops syncs in <60 sec on reconnect.
- [ ] Customer Present Mode privacy scrub removes all internal fields before render.
- [ ] Hardware Health Check passes for all 10 launch reference devices.

---

# 11. Technical Architecture

## 11.1 Tech Stack `[Agent 3]`

| Layer | Choice | Why |
|---|---|---|
| Primary DB | PostgreSQL 18 (RLS, partial indexes, GIN, PostGIS, pg_trgm, unaccent) | Tenancy + indexing + geo |
| UUID generation | UUID v7 (native in PG 18) | Time-ordered, index-friendly |
| Search | Typesense | p95 <200ms for tech-facing search |
| Vector | pgvector (in same Postgres) | Relational-first product; keeps joins/ACID/ops simple |
| Mobile sync | PowerSync + on-device SQLite | Backend write validation, partial sync |
| Cache | Redis | Price resolution, idempotency, auth |
| Object store | S3 (presigned uploads) | Vendor catalogs, attachments |
| CDN | CloudFront (or equivalent) | Images, PDFs |
| Read replica | Postgres replica | Dashboards, bounded reporting |
| Warehouse (Phase 3) | ClickHouse | Event-heavy analytics |
| Event envelope | CloudEvents 1.0 | Standard, multi-consumer |
| Outbox relay | Polling publisher (start) → WAL/Debezium later | Portable; defers Kafka |
| Backend | Go (illustrative; not yet decided) | Performance + concurrency |
| Mobile | React Native (Expo) | Cross-platform + native bridges |
| Web | TBD (React + Next.js suggested) | Standard SaaS stack |
| Secrets | AWS Secrets Manager | Standard |
| KMS | AWS KMS | At-rest encryption |
| API key hash | Argon2id | Standard |
| Billing | Stripe Billing | Subscription + metered |
| Address autocomplete | Google Places API — Place Autocomplete (New) + Place Details (Basic data) | Best US coverage incl. small-biz / will-call counter addresses; session-token billing keeps cost ~$0.017 / full lookup (§11.1.A) `[SPEC-ONLY v1.1]` |

## 11.1.A `[SPEC-ONLY v1.1 rev 2026-05-27]` Address Autocomplete (Google Places API)

Every place the product asks a user to type a street address uses a single shared component, **`<AddressAutocompleteInput>`** (file location TBD at implementation time, `src/components/AddressAutocompleteInput.tsx` suggested). One component, one provider, one place to update billing or swap vendors.

**Sites that consume it** (mandatory wiring at implementation time):

| Site | Field | Section |
|---|---|---|
| AddVendorDialog | `vendor.pickup_address` (label *"PICKUP / SHIP-FROM ADDRESS"*) | §7.6 |
| AddBranchDialog | `branch.address` | §5.4.A.iii |
| CreateStageDialog → Vendor Pickup Location override | inline editable line — writes `job_stage.pickup_address` + `job_stage.pickup_address_components`; defaults from picked vendor's pickup address | §7.4.A.4 |
| POPreviewDialog → Ship-To block | *derived, not autocompleted* — renders from `purchase_order.ship_to_location_id` → `branch.address_components`; no separate autocomplete input on the PO doc itself | §7.2 |
| *Future:* Customer site address, Job site address, Tech home base | — | Phase 2 |

**Component contract:**

```ts
type AddressComponents = {
  formatted: string;        // Google's canonical formatted_address (display string)
  line1: string;            // street # + street name
  line2?: string;           // unit / suite / floor
  city: string;
  region: string;           // state code (US) — 2 letters
  postalCode: string;       // ZIP
  country: string;          // ISO-3166-1 alpha-2 (always "US" in v1.1)
  lat: number;
  lng: number;
  placeId: string;          // Google place_id — stable for re-querying
};

type AddressAutocompleteInputProps = {
  value: string;                                  // legacy single-string for back-compat
  components?: AddressComponents | null;          // structured shape (new)
  onChange: (value: string, components: AddressComponents | null) => void;
  label?: string;
  placeholder?: string;
  required?: boolean;
  // Bias suggestions toward this lat/lng + radius (defaults to user's branch)
  bias?: { lat: number; lng: number; radiusKm?: number };
  // Restrict to country codes (defaults to ["us"])
  countries?: string[];
  // Show "manual entry" helper if API unavailable
  fallbackOnError?: boolean;                      // default true
};
```

**Data shape — write both columns:**

Every row that stores an address now has two columns:

```sql
-- Legacy display column (existing)
address text NULL,
-- New structured companion (added at implementation time)
address_components jsonb NULL,  -- shape = AddressComponents above
```

The legacy `text` column stays the canonical display field (PO docs, pickup tickets, vendor cards all keep reading `address`). The new `jsonb` column powers structured queries — "all vendors in NY," "all branches within 50 km of this job," radius searches via PostGIS (`ST_DWithin(ST_MakePoint(lng, lat)::geography, ...)`). Both columns are written atomically when a user picks a suggestion; only the `text` column is written when the user falls back to manual entry (the `jsonb` stays `NULL` and a Phase-2 batch job back-fills it via Geocoding API).

Rows that already exist with `text`-only addresses keep working — the absence of `address_components` is the signal that the row needs back-fill, not a data error.

**Tables to add `address_components jsonb`** at implementation time:

- `vendor` (alongside existing `pickup_address text` → new `pickup_address_components jsonb`; plus a separate `address_components jsonb` for the vendor's billing/HQ address that pairs with `vendor.address_text`)
- `branch` (alongside existing `address text` → new `address_components jsonb`)
- `job_stage` (alongside existing `pickup_address text` → new `pickup_address_components jsonb`; this is the per-stage override set in CreateStageDialog when the operator edits the vendor's default pickup location for one specific job)
- *Future:* `customer.bill_to_address`, `customer.site_address`, `app_user.home_address`, `job.site_address` — wired in Phase 2 when the autocomplete pattern extends beyond vendor / branch / job_stage.

Note: `purchase_order` does **not** get a new column — the PO ship-to renders via `ship_to_location_id` (FK to `inventory_location` / `branch`), so the structured shape arrives for free once `branch.address_components` is populated. No PO-level address override exists in the v1.1 schema.

**Provider configuration:**

```ts
// places.config.ts — single source of truth
export const PLACES_CONFIG = {
  apiKey: process.env.NEXT_PUBLIC_GOOGLE_PLACES_API_KEY, // restricted to app domain(s)
  language: "en",
  componentRestrictions: { country: "us" },             // v1.1; Phase 2 expands
  fields: ["address_components", "geometry", "formatted_address", "place_id"], // Basic-tier only
  defaultBiasRadiusKm: 80,
};
```

Key restrictions (Google Cloud Console): HTTP referrer allowlist = `*.<app-domain>` only · API restriction = Places API + Maps JavaScript API only · daily quota cap to prevent runaway billing on a key leak.

**Session tokens** are required: every component instance generates a fresh `AutocompleteSessionToken` on mount and passes it to every `getPlacePredictions` call + the final `getDetails` call, so the whole type-then-select counts as one ~$0.017 session instead of N independent autocomplete charges. Token resets after `onChange` fires or after 3 min of idle.

**Bias:**

The dropdown ranks suggestions near the user's branch lat/lng (`bias.lat`/`bias.lng` defaults to `currentUser.branch.address_components` when present; falls back to org HQ branch; falls back to *unbiased* when neither is set, e.g. brand-new org with no addresses yet). Radius defaults to 80 km. Typing a ZIP that lies outside the bias radius surfaces results from that ZIP's area anyway — Google's algorithm treats bias as a soft prior, not a hard filter.

**Fallback (graceful degradation):**

1. **No suggestions for what the user typed** → the dropdown shows a single row *"Use this address as typed"* that commits the raw string with `components = null`.
2. **Maps JS bundle fails to load** (CSP block, ad blocker, offline) → component degrades to a plain `<input type="text">` with helper line *"⚠ Autocomplete unavailable — enter address manually"*. No error toast, no blocking modal — onboarding always works.
3. **API key invalid / quota exhausted** → same degradation path. Server-side telemetry logs the failure so ops can react; the user keeps typing without interruption.

**Privacy / compliance notes:**

- The `place_id` we store is a stable Google identifier and is **not PII** by itself — but pairing it with a customer name / job site means the combined record IS PII. Storage tier and audit-log treatment match the rest of `vendor` / `branch` rows (org-scoped, RLS-enforced, append-only audit).
- Per Google's terms, we **must not** cache `place_id` indefinitely without honoring refresh — re-validate via `getDetails(placeId)` at least every 30 days for active records (Phase 2 cron). For inactive / archived vendors and branches we keep the stored snapshot indefinitely; Google's TOS allows that.

**Acceptance criteria (when implementation lands — not v1.1):**

- [ ] Typing *"123 main"* into the AddVendorDialog pickup-address field surfaces a dropdown within 300 ms; picking a result auto-fills the input with `formatted_address` and writes `address_components` jsonb.
- [ ] The dropdown ranks NYC-area matches above identical names in other states for a user logged in at the Brooklyn HQ branch.
- [ ] Typing a ZIP (e.g. *"11217"*) surfaces addresses within that ZIP.
- [ ] Blocking the Maps JS bundle (DevTools → Network → block `*googleapis.com*`) degrades the input to plain text with the *"⚠ Autocomplete unavailable"* helper line; submitting still saves the typed value to `address text` with `address_components = null`.
- [ ] A single full type-then-select interaction generates exactly **one** Places billing session (verified in Google Cloud Console billing).
- [ ] PO Preview's Ship-To block reads `address_components.line1` / `city` / `region` / `postalCode` when present, falls back to the legacy `address text` string otherwise.
- [ ] PostGIS index on `(address_components->>'lat')::float, (address_components->>'lng')::float` supports a "vendors within 50 km of this job site" query in under 100 ms p95 (Phase 2 acceptance — not v1.1).

**Implementation status (v1.1):**

**Spec-only.** The prototype keeps the existing plain `<input type="text">` for every address field today. This section locks the target state so:

1. Other PRD sections (PO doc, ticket layout, future search-by-state filters) can reference the structured shape without ambiguity.
2. When the team is ready to enable Google billing + create the API key + restrict it to the production domain, exactly *one* component + *one* schema migration delivers autocomplete everywhere at once.
3. Provider lock-in is shallow: swapping to Mapbox / HERE / SmartyStreets later requires changing only `<AddressAutocompleteInput>` internals — every consuming dialog keeps the same `value` + `components` + `onChange` contract.

## 11.2 Multi-Tenancy

**Pooled DB, shared schema, organization_id on every row, RLS-enforced** `[Agent 3]`.

- App layer: `RequestContext` propagates `organization_id` in every command/query.
- DB layer: `set local app.current_tenant = '<org_uuid>'` per transaction. RLS policies use `current_setting('app.current_tenant')::uuid`.
- Every hot index leads with `organization_id`.
- Premium-tenant isolation (Phase 3): logical replication to dedicated DB, tenant router cuts traffic.

**Noisy-neighbor mitigations:**
- API: org-scoped Redis token bucket; separate interactive vs integration limits.
- Jobs: per-org worker concurrency caps.
- DB: partition time-series tables by month.
- Search: org-scoped collections or org-filter in Typesense.
- Queueing: partition key = `organization_id` or `organization_id:aggregate_type`.

## 11.3 Database Design (summary — full DDL in Appendix A)

- All mutable masters: `id, organization_id, created_at, updated_at, deleted_at, version`.
- All immutable ledgers: `id, organization_id, created_at, created_by`.
- Custom fields: typed sidecar tables (`*_attribute_definition`, `*_attribute_value`) — NOT JSONB EAV [A40, Agent 3].
- Partitioned monthly: `stock_movement`, `price_history`, `purchase_order_status_history`, `outbox_event`, `audit_log`, `webhook_delivery`.

## 11.4 API Design

- **REST-only** at `/api/v1` `[Agent 3 explicit; GraphQL rejected]`.
- Cursor pagination (`limit`, `starting_after`, `ending_before`).
- `If-Match: W/"<version>"` ETags on mutable PUT/PATCH.
- `Idempotency-Key` header on POST/async.
- Structured errors: `{ "error": { "code", "message", "details", "request_id" } }`.
- Auth matrix:
  - JWT/OIDC for first-party web/mobile.
  - OAuth 2.0 for third-party (QBO, Avalara, payments).
  - Scoped API keys for tenant server-to-server.
- Rate limits: 600/min/user interactive, 1,200/min/org API key, async cost-weighted.
- Versioning: major-in-path; `Deprecation` + `Sunset` headers for deprecations.

(Full endpoint catalog in Appendix B.)

## 11.5 Event-Driven Architecture

- **Transactional outbox** pattern: domain change + `outbox_event` row in same DB transaction `[Agent 3]`.
- Relay: polling publisher v1 → WAL tailing / Debezium later.
- CloudEvents 1.0 envelope.
- Consumers must be idempotent (relays publish more than once).

(Full event catalog in Appendix C.)

## 11.6 Performance Targets

| Operation | Target | Source |
|---|---|---|
| Technician search | p95 < 200ms | Agent 3 hard req |
| Stock consume API | p95 < 150ms online | Agent 3 |
| PO receipt posting (100 lines) | p95 < 500ms | Agent 3 |
| Price book import 10k rows validate | < 60s | Agent 3 |
| Price book publish (background) | < 5 min | Agent 3 |
| Mobile catch-up after 8h offline + 500 ops | < 60s | Agent 3 |

Scale target per large tenant: 50 techs, 100k SKUs, 1M stock movements/year.

R:W ratios: Inventory 4:1; Price Book 50:1; Procurement 8:1.

## 11.7 Security & RBAC

- TLS 1.2+ in transit; AWS KMS at rest.
- Secrets in AWS Secrets Manager.
- API keys: Argon2id hash; prefix-only display after creation; overlapping rotation windows; `last_used_at` + `last_used_ip` tracking.
- Audit log: append-only, `prev_hash` + `entry_hash` SHA-256 tamper-evident chain `[A20]`.

RBAC schema (Agent 3): `role`, `permission`, `role_permission`, `user_role` (scoped via `scope_type` + `scope_id`), `api_key`, `api_key_scope`.

Role families (v1):
- `owner`, `admin`, `office_admin`, `dispatcher`, `field_technician`, `subcontractor_tech`, `warehouse_manager`, `inventory_admin`, `purchaser`, `purchaser_approver`, `accountant`, `integration_bot`.

Permission examples:
- `inventory.item.read`, `inventory.stock.consume`, `inventory.stock.adjust`, `inventory.count.post`.
- `inventory.location.manage` (`[PROTOTYPE v1.1]` — edit/rename/reassign existing locations; granted to `owner`, `admin`, `warehouse_manager`, `inventory_admin`).
- `inventory.stock.approve` (`[PROTOTYPE v1.1]` — approve/reject pending stock-out requests from field techs; granted to `owner`, `admin`, `warehouse_manager`, `inventory_admin`, `purchaser`).
- `pricebook.read`, `pricebook.version.publish`.
- `purchase_order.create`, `purchase_order.approve`, `purchase_order.receive`.
- `vendor_bill.enter`, `vendor_return.create`, `credit_memo.issue`.
- `integration.webhook.manage`.

User-location enforcement: `field_technician.authorized_locations[]` `[A22]`.

**`[PROTOTYPE v1.1]` Client-side role-check pattern:**

All admin-gated UI reads from a centralized helper module (`data/current-user.ts` in the prototype) so the auth-to-permission mapping has one home. Helpers return boolean for the most common gates:

```ts
canManageLocations(role)   // owner · admin · warehouse_manager · inventory_admin
canEditCatalog(role)       // owner · admin · office_admin · inventory_admin
canDeleteCatalog(role)     // owner · admin · inventory_admin
```

**`[PROTOTYPE v1.1]` Scope helpers** (rev 2026-05-27) — return `{ selectable, readonly }` lists instead of booleans, so callers can render *visible-but-disabled* options for cross-scope items:

```ts
// data/current-user.ts — used by NewApprovalRequestDialog (§5.4.A.v.4b)
getRequesterOptions(user): { selectable: Tech[]; readonly: Tech[] }
getFromLocationOptions(user): { selectable: Location[]; readonly: Location[] }
getToLocationOptions(user, actionType): { selectable: Location[]; readonly: Location[] }
```

Scoping rules per role tier:

- **Field techs** (`field_technician`, `subcontractor_tech`) — `selectable = [own van]`, `readonly = []`. Other locations and other techs are not surfaced even as greyed entries; the tech sees a single locked field with the helper text *"🔒 Locked to your assigned van"*. There is no override permission — the role-only restriction is absolute (deliberate guardrail against tech-to-tech stock laundering).
- **Branch-scoped back-office** (`warehouse_manager`, `dispatcher`, `office_admin`) — `selectable = locations/techs at user.branch_id`, `readonly = everything else`. The dialog renders `readonly` options as `<option disabled>` with a muted style + 🔒 icon and a *"&lt;Other Branch&gt; — outside your scope"* tooltip.
- **Global roles** (`owner`, `admin`, `inventory_admin`, `purchaser`) — `selectable = all`, `readonly = []`. No scoping applied.

When Phase-2 RBAC settings ship, the static role checks inside these helpers swap for a `useCurrentUser()` hook or DB-backed permission lookup — the callers (dialog components) don't change.

**Forward note** (rev 2026-05-27): the three scope helpers above are wired into `NewApprovalRequestDialog` in this rev. The same helpers should be wired into `RestockDialog` (§5.4.A line 319) and `TransferDialog` (§5.4.A.vii) the next time those dialogs are touched — both currently rely on the legacy "any location" picker. The scan-driven flow (§5.4.A.vi) is safe-by-construction because it operates on the tech's current van implicitly, but the helpers should be the source of truth uniformly.

Server-side authorization remains the source of truth — these client checks are UX guards only (hide affordances when the action would be rejected anyway). Every gated action still passes through API authorization at the server.

---

# 12. Hardware Ecosystem `[A13 — refer-only]`

(Detailed device matrix in Appendix E.)

- Publish certified-device allowlist on marketing site + in-app Hardware Health Check.
- Setup guides for: Socket S720 pairing, Zebra DataWedge profile, Honeywell scanner, Brother printer, Stripe Terminal pairing, Apple Tap to Pay, Intune/Jamf MDM kiosk configs.
- No reseller operations in v1.
- Phase 2 (customer-traction-driven): consider reselling Counter-Shop Kit + Locksmith-Security Kit as differentiator SKUs.
- Three-tier scanning SDK strategy:
  - Native (VisionKit / ML Kit) for BYOD baseline.
  - Scandit premium add-on (Pro tier).
  - Cognex for direct part marks (edge case; not certified).
- ZPL-first print abstraction; Brother as adapter.
- NFC: Phase 2 (asset tagging, truck-bin labels).
- RFID: Phase 3.

---

# 13. Compliance & Regulatory `[A47 — minimal-but-extensible v1]`

## 13.1 v1 Scope

Schema + cross-cutting UX:
- **License/Certification tracking**: type, ID, jurisdiction, expiry, expiry-alert; per-technician.
- **Permit object**: linked to Job + AHJ + standards version.
- **SDS document storage**: linked to hazmat-flagged items; revision date tracked.
- **Audit trail**: hash-chained `audit_log` on every compliance object `[A20]`.

## 13.2 Trade-Specific Compliance — Schema Hooks Only v1

Schema accommodates these (typed Asset extension tables); detailed workflows ship Phase 2 per trade as customer demand emerges:

| Standard | Trade | Field Hooks |
|---|---|---|
| NASTF VSP / SDRM | Automotive locksmith | `tech.nastf_vsp_id`, `transaction_log` |
| State locksmith licensing | Locksmith | `license_number`, `state`, `renewal_date` |
| AAADM | Automatic doors | `cert_id`, `expiry` |
| IDEA / DASMA | Garage door | `cert_id`, `wind_load_rating` |
| EPA Section 608 | HVAC | `tech.608_cert_id`, `refrigerant_log_id` |
| EPA AIM Act | HVAC | `equipment_era`, `refrigerant_GWP`, `AIM_compatibility_flag` |
| ASSE backflow | Plumbing | `tester_cert_id`, `test_record_id` |
| NEC / NFPA 70 | Electrical | `code_version` per job |
| NFPA 72/25/10 | Fire | `inspection_frequency`, `next_due`, `deficiency_id` |
| UL 294 | Access control | `device_cert_class` |
| UL 681/827 | Alarm/monitoring | `system_class`, `cert_id` |
| NICET | Fire | `tech.nicet_level`, `expiry` |
| BICSI | Low voltage | `tech.bicsi_cert` |
| PHTA CPO | Pool/spa | `tech.cpo_cert`, `body_of_water_id` |
| FIFRA / EPA applicator | Pest | `applicator_cert`, `state_restriction` |
| OSHA HazCom | All chem-handling | SDS storage, acknowledgment |
| PHMSA Materials of Trade | Mobile chem transport | hazmat quantities, packaging |
| ISSA CIMS | Cleaning | site audit record |
| NALP | Landscape | tech skill designation per service type |

## 13.3 Tax Handling

- Avalara AvaTax integrated at launch (A18).
- Exemption certificate per-customer + per-jurisdiction with expiry.
- Per-state CC surcharge configuration (A59.11), never default-on, legal disclosure required.

## 13.4 Audit Trail Requirements

- Append-only `audit_log` table.
- Hash chain (`prev_hash`, `entry_hash` SHA-256) for tamper-evidence.
- Every compliance object change emits audit entry: actor, before/after, reason, IP, request_id.
- 7-year retention default; tenant-configurable.

---

# 14. Non-Functional Requirements

## 14.1 Performance

(See §11.6 for full latency targets.)

- Technician search p95 < 200ms.
- Stock consume p95 < 150ms online.
- PO receipt 100 lines p95 < 500ms.
- Price book import 10k rows < 60s validate.
- Mobile catch-up 8h offline + 500 ops < 60s.
- Inventory decision-time on mobile < 10 sec p95 (Agent 5 headline NFR).

## 14.2 Scalability

- 50 techs / 100k SKUs / 1M stock movements per year per large tenant `[Agent 3]`.
- 1,000-10,000 tenants pooled in shared DB; large tenants routable to dedicated infra (Phase 3 premium isolation).
- Time-series tables partitioned monthly.
- ClickHouse warehouse Phase 3 for event analytics.

## 14.3 Availability & Reliability

- Target: 99.9% uptime (43min/month allowed downtime).
- Multi-AZ DB.
- Read replica for dashboards.
- Webhook retry window 72 hours with exponential backoff.

## 14.4 Backup & DR

`[ASSUMPTION — Director recommendation, Agent 3 did not specify]`
- Daily full + continuous WAL archival.
- RPO target: 15 minutes.
- RTO target: 4 hours.
- Quarterly DR rehearsal.

## 14.5 Observability

`[ASSUMPTION — Director recommendation, Agent 3 did not specify]`
- OpenTelemetry instrumentation across services.
- Centralized logging (Datadog or equivalent).
- Metrics + tracing.
- Per-tenant cost dashboards (AI COGS, infra usage).
- Request ID + correlation ID + causation ID propagated through events.

## 14.6 AI COGS Per-Tenant Budget

- Target: $20-60/tenant/month moderate-use direct AI cost.
- Per-tenant cost monitoring dashboard.
- OCR quota + overage billing (A51).
- Optional hard-cap per tenant.

---

# 15. Pricing & Packaging

## 15.1 Tier Structure `[A3]`

Three tiers, per-tech/month, self-serve trial 14 days no credit card.

### Starter
- Core Inventory + Price Book + PO.
- Single branch / single warehouse.
- Up to 5 techs.
- Smart Search + Voice-to-Parts + Owner Brief AI bundled.
- Vendor Invoice OCR: 100 pages/mo included.
- QBO sync (basic — Items, Customers, Invoices, Payments).
- Stripe Terminal + Tap to Pay.
- Wisetack financing.
- Native Avalara tax.
- Mobile (iOS + Android).
- Magic-link customer views.
- Public webhooks + Zapier app.
- Native dashboards.
- Email support.

**Target price anchor (Director suggestion): ~$59/tech/mo annual, ~$79/mo monthly.**

### Pro
- Everything in Starter, plus:
- Multi-branch / multi-warehouse.
- Up to 25 techs.
- Full markup engine (cost-band tiers, margin floors, modifier rules).
- Customer overrides + Contract pricing + Membership tier pricing.
- Multi-step approvals (Phase 2 when ships).
- Returns / Credits / 3WM (in v1 per A5).
- Voice + Catalog Ingestion AI (full).
- Vendor Invoice OCR: 500 pages/mo included.
- QBO advanced sync (PO, Bill, Class/Location/Department, audit trail).
- Branded document templates (A58).
- Hash-chain audit log full access.
- Chat support.

**Target price anchor: ~$129/tech/mo annual, ~$159/mo monthly.**

### Enterprise
- Everything in Pro, plus:
- Unlimited techs / branches.
- Premium-isolation tenant routing (Phase 3).
- SSO + SCIM (Phase 2 when ships).
- ~~QBD via Codat~~ — `[DEFERRED]` (not in v1, no Phase 2 commitment).
- Avalara enterprise features.
- Vendor Invoice OCR: 2000 pages/mo included; $0.08/page overage.
- Dedicated CSM.
- 99.95% uptime SLA option.
- Custom data export (Fivetran connector Phase 2).

**Target price anchor: Quote / demo-led; $249+/tech/mo target floor.**

## 15.2 Per-Tech Seat Model

All tiers per-tech/month. No per-WO/per-job pricing (Agent 6: publicly punished by Coolfront precedent).

## 15.3 What's Gated to Higher Tiers

| Feature | Starter | Pro | Enterprise |
|---|---|---|---|
| Multi-branch / multi-warehouse | — | ✓ | ✓ |
| Customer overrides + Contract pricing + Membership | — | ✓ | ✓ |
| Full markup engine (cost-band, margin floor) | — | ✓ | ✓ |
| Returns + Credits + 3WM | — | ✓ | ✓ |
| Catalog Ingestion AI | — | ✓ | ✓ |
| Branded document templates | — | ✓ | ✓ |
| QBO advanced (PO, Bill, Class) | — | ✓ | ✓ |
| Multi-step PO approvals (Phase 2) | — | — | ✓ |
| ~~QBD via Codat~~ `[DEFERRED]` | — | — | — |
| SSO + SCIM (Phase 2) | — | — | ✓ |
| Premium tenant isolation (Phase 3) | — | — | ✓ |
| Dedicated CSM | — | — | ✓ |

## 15.4 Free Trial & Onboarding

- 14-day free trial, no credit card `[A59.3]`.
- Self-serve guided onboarding wizard (flagship workflow A11 #1).
- Optional paid "Concierge Setup" service `[A59.2]`.

## 15.5 Optional Add-Ons

- Vendor Invoice OCR overage: $0.10/page (Starter, Pro), $0.08/page (Enterprise).
- Scandit premium scanning SDK (Pro+ feature) — exact pricing TBD.

---

# 16. MVP Scope & Phase Plan

## 16.1 Phase 1 (MVP) — Ships at GA

**`[PROTOTYPE v1.1]` UX increment locked from /dashboard prototype:**
- Single inventory page with view tabs (Items + Staging — §5.4.A, §7.4.A)
- Item photo upload + camera capture (§5.1, §5.2)
- Vendor / Category / Location all dropdown-with-inline-create (§5.4.A, §6.2, §7.6)
- Filter popover w/ 5 multi-select sections (§5.4.A)
- Full edit mode on every catalog item (§5.4.A)
- Restock dialog distinct from formal PO receiving (§5.4.A, §7.4)
- CSV Import / Export with auto column mapping + AI categorize (§5.4.B)
- Low-Stock Health by Location grid + Edit Location admin RBAC gate (§5.4.A.i, §5.4.A.ii, §11.7)
- Branch as a managed entity with inline-create (§5.4.A.iii, Appendix A.1)
- Primary Tech + Vehicle pickers source from org tech roster + auto-fill (§5.4.A.iv)
- Stock-Out Approval queue + "Approvals" view tab + amber Needs Approval KPI (§5.4.A.v)
- Phone-camera scan + role-aware post-match action panel in ScanDialog (§5.4.A.vi)
- Transfer dialog bulk-to-staging modes (Single item · By PO · By Job) (§5.4.A.vii)
- Job Staging sub-module with stage cards + partial-shipment progress (§7.4.A)
- "From PO" picker + inline "Auto-fill from PO" in Add Stage dialog (§7.4.A.3)
- Pickup-from-vendor address surfaced from Vendor record (§7.6)
- Job + Tech pickers auto-fill staging context (§7.4.A.4)

**Core platform:**
- Multi-tenant Postgres + RLS.
- REST API at `/api/v1`.
- React Native iOS + Android.
- PowerSync + SQLite mobile sync.
- Web admin app.
- Stripe Billing + Terminal + Tap to Pay.
- Avalara AvaTax.
- Wisetack financing.
- QBO sync (basic + advanced per tier).
- Zapier app + 15 public webhooks.
- Hash-chain audit log.

**Inventory:**
- Multi-location (org → branch → warehouse → bin) `[A26]`.
- Truck stock with user-location RBAC `[A22]`.
- Serialization (forced for security/HVAC/appliance/garage/fire/pool/hosted-license) `[A28]`.
- Lot/batch schema only (UX P2).
- Kits/bundles.
- Transfers (auto for non-serialized; approval for serialized).
- Consumption (voice + scan + search + manual).
- Returns (to truck / to warehouse).
- Micro-count cycle counts `[A27]`.
- Closeout enforcement (configurable per role/customer/job) `[A7]`.

**Price Book:**
- Universal item taxonomy.
- Markup engine (cost-band tiers, margin floors, rounding, modifier rules) `[A43]`.
- GBB engine (trade-template default) `[A8]`.
- Customer overrides + Contract + Membership overlays `[A41]`.
- Bulk CSV import + AI categorize + category markup rules + simulate-before-publish `[A44]`.
- Versioned publish + price history.
- 3-state tech pricing authority `[A50]`.
- Wisetack financing embedded.

**Purchase Orders:**
- 4 creation paths (manual / low-stock / from-job / from-estimate).
- Progressive disclosure mobile composer (counter to ServiceTitan wedge).
- Amount + role-based single-step approval `[A49]`.
- Partial receiving + OCR receipt capture.
- Returns + Credits + Three-Way Match `[A5]`.
- Vendor management basic.
- Mobile counter receiving flow.

**Cross-Trade Jobs:**
- Single Job with multiple Segments (each Segment has tech + Asset + line items) `[A53]`.
- Single invoice, single signature, single cost rollup, per-segment profitability.

**Universal Asset Model:**
- One Asset table + typed subtype extensions (Opening, Panel, Equipment, Appliance, Sprinkler Riser, Pool Body, Roof Section, etc.) `[A6]`.
- Service history, warranty, inspection records, parent-child hierarchy.

**AI (5 features):**
- Smart Search.
- Voice-to-Parts (Deepgram).
- Vendor Invoice OCR (Veryfi/Mindee/Rossum).
- Catalog Ingestion + auto-categorize.
- Owner Morning Brief + read-only NL queries.

**Mobile UX:**
- Local-first PowerSync.
- Customer Present Mode + rotate-to-customer.
- Own-device signature default + in-person fallback.
- Change orders as child objects.
- Hardware Health Check + setup guides for 10 reference devices.

**Office / Web:**
- **NO dispatch UX** `[DEFERRED]` — jobs have `assigned_tech_id` + `scheduled_at` fields editable in a basic list view; no calendar/drag-drop/route-map UX ships v1. Full dispatch is Phase 2.
- Native operational dashboards.
- Branded customizable document templates `[A58]`.
- Bulk import + bulk update flows.
- RBAC admin.
- Magic-link customer views (no portal v1) `[A55]`.

**Compliance (schema-only v1):**
- License/cert tracking with expiry alerts.
- Permit linkage.
- SDS storage.
- Trade-specific Asset extension fields per §13.

**Trade Templates (15 trades):**
- Categories + 10-15 placeholder service names per trade + default agreements + credential types + custom field definitions + default vendor routing `[A52]`.

**Subcontractor support:**
- Minimal: `is_subcontractor` flag + cost-rate override + restricted RBAC role `[A16]`.

**i18n:**
- English-only v1 `[A17]`.

## 16.2 Phase 2 (3-6 months post-launch)

- **Full Dispatch UX**: calendar view + drag-drop scheduling + tech availability + route map + customer notifications + recurring scheduling. (Deferred from v1 per A57.)
- Vendor Catalog named partnerships (ADI, Banner, IDN, CRL — customer-traction-driven).
- ~~QBD via Codat~~ `[DEFERRED]` — no Phase 2 commitment; only revisit if customer demand emerges.
- The New Flat Rate, Profit Rhino (if customers demand).
- Okta SSO + SCIM.
- Square Terminal + alternative payment processors.
- Spanish i18n + Translation AI.
- Phase 2 AI: Vendor-cost-aware repricing, demand forecasting, replenishment recommendations, cross-truck balancing, spend anomaly detection, vendor performance scoring, dispatcher assistant, document understanding, GBB auto-builder, estimate copilot.
- Multi-step PO approvals (vendor + job-type triggers).
- Full lot/batch UX (HVAC refrigerant ledger, pest chemical tracking, pool chemistry).
- Full Customer Portal (replaces magic-link).
- KeyWatcher / KeyTrak integration (Locksmith-Security Kit).
- Fire & life safety inspection workflows (Asset deficiency UX).
- Tech earnings/commission tracking.
- Spiffs and incentives.
- Membership upsell prompts in tech UX.
- E-signature for vendor documents.
- Fivetran connector + BI export.
- Twilio SMS/WhatsApp + SendGrid.
- Xero, Zoho Books, Helcim.
- Phase 2 hardware: consider reselling Counter-Shop + Locksmith-Security bundles.
- Returns/RMA UX polish.
- Cycle count prioritization (deterministic risk scoring).

## 16.3 Phase 3 (6-12 months)

- Premium tenant isolation routing.
- ClickHouse warehouse for analytics.
- EDI 832/850/855/856 adapters.
- Sage Intacct, NetSuite (enterprise accounting).
- Coupa / Ariba PunchOut.
- Phase 3 AI: Photo-to-SKU (loose parts after barcode/nameplate matures), lead-time prediction, vendor selection optimization, selective agentic POs.
- RFID + BLE beacons (hardware).
- Multi-currency.
- International expansion.

## 16.4 Explicit Deferrals & Rationale

- **Full custom flat-rate content** (locksmith/door/security trades): Emanuel's BYO stance `[A1]` — customer-supplied content; product never ships flat-rate content as a deliverable.
- **Per-customer dynamic pricing AI**: explicit Agent 7 kill — ethics + legal.
- **Autonomous money-moving AI**: explicit Agent 7 kill — trust risk.
- **Full CMMS preventative maintenance UX**: Phase 2 (schema in v1; UX layered as customers adopt CMMS half).
- **Multi-trade reseller hardware operations**: refer-only stance `[A13]`.
- **Native QBD or partner QBD support**: `[DEFERRED]` — skipped MVP and not committed to Phase 2; QBD-anchored prospects walk away at launch; revisit only on customer demand.
- **Dispatch UX (calendar / drag-drop / route-map / customer notifications / recurring scheduling)**: deferred entirely from v1; basic `assigned_tech_id` + `scheduled_at` list-view fields are the only scheduling primitive shipped at launch; full dispatch Phase 2.

---

# 17. Success Metrics

## 17.1 Activation / Adoption (Leading Indicators)

- **Time to First Valuable Action (TTFVA)**: trial signup → first PO created or first job completed. Target: < 30 min (flagship workflow A11 #1). Measured weekly.
- **Trial → Paid Conversion Rate**: target > 15% by Month 3, > 25% by Month 6.
- **Onboarding Completion Rate**: % trial users completing trade template setup + first import + first customer + first job. Target > 60%.
- **Hardware Health Check Pass Rate**: % of new tenants whose configured hardware passes the in-app check. Target > 90%.

## 17.2 Module-Level Success Metrics

**Inventory:**
- % jobs closed with parts captured (closeout enforcement). Target > 85% installer roles.
- Stock movement disappearance rate (ledger integrity). Target 0.
- Avg cycle count duration (5-bin micro-count). Target < 5 min p95.
- Negative-stock reconciliation queue size. Target < 5 outstanding per tenant.

**Price Book:**
- Bulk import time for 1000 SKUs. Target < 10 min including AI categorize review.
- Price book line-item disappearance rate. Target 0.
- Markup rule adoption rate. Target > 70% tenants using at least one rule.
- GBB usage rate (when default-on). Target > 50% estimates use GBB.

**Purchase Orders:**
- Mobile PO creation time. Target < 30 sec p95.
- Counter receiving time. Target < 60 sec p95 for ≤10 line PO.
- 3WM exception rate. Target < 5% bills.
- Return-to-credit cycle time. Target < 7 days median.

**AI:**
- Smart Search top-5 hit rate. Target > 90%.
- Voice-to-Parts confirmation accuracy. Target > 90% clean audio.
- Vendor Invoice OCR confidence. Target > 90% (confirm-only path).
- Catalog Ingestion auto-categorize precision. Target > 85% accept-rate by user.
- Owner Brief read rate. Target > 50% weekly active owners.

## 17.3 Owner-Level Business Impact (Lagging)

- **Job profitability visibility**: % tenants with margin reporting "in use" (defined as logged into report ≥1x/week). Target > 70%.
- **Average ticket lift** for tenants who adopt GBB. Target +$200-400 (Nexstar benchmark).
- **Membership conversion rate** for residential-leaning tenants. Target > 25% of eligible customers.
- **Inventory turn improvement** for tenants who adopt min/max + replenishment. Target +30% YoY.

## 17.4 Tech Adoption (Lagging)

- **Mobile session frequency per tech per day**. Target > 5 sessions.
- **Voice-to-Parts usage rate per active tech**. Target > 40% of part captures within 30 days of adoption.
- **Tech NPS**. Target > 30 by Month 6.
- **Closeout enforcement override rate** (techs using "no parts" escape hatch). Target < 15%; investigate >20%.

## 17.5 Platform / Business Metrics

- **Net Revenue Retention**. Target > 110% by Month 12.
- **Gross Margin per tenant**. Target > 75% blended (AI COGS controlled).
- **Trial NPS**. Target > 40.
- **Production uptime**. Target 99.9%.

---

# 18. Risks & Mitigations

## 18.1 Technical Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Mobile sync corruption / data loss | High | Server-authoritative + commands not balances + immutable ledger + reconciliation queue (Agent 3 architecture) |
| AI hallucination on SKU/price/tax | High | Retrieval-only + schema-constrained outputs + deterministic calculators + abstain-on-low-confidence + human review at money-moving boundaries (Agent 7 framework) |
| OCR cost runaway | Med | Per-tier quotas + overage + optional hard cap (A51) + per-tenant dashboard |
| QBO sync drift | Med | Per-tenant per-entity queue + CDC reconciliation + daily backfill (Agent 4 design); operational ledger stays in FSM |
| PowerSync vendor lock-in | Med | Architecture is sync-engine-agnostic at boundary; PowerSync wins on backend write validation (Agent 5) — fall-back path: Replicache or custom |
| Multi-trade schema over-engineering | Med | Universal Asset + typed extensions (A6) generalizes; new trade = configuration not migration |
| QBO LinkedTxn misuse | High | Explicit ID storage rule (A39, Agent 4 critical); enforced in connector layer |

## 18.2 Market Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Horizontal-mush** (contradicts research A2) | High | 5 flagship workflows polish budget + trade-template guided setup + obsessive native primitives; revisit beachhead question post-launch with traction data |
| Trial → paid conversion below target | High | Flagship onboarding workflow (A11 #1) + AI catalog ingestion + 10-15 placeholders per trade (A52) + Concierge Setup paid service (A59.2) |
| BYO content cold-start abandonment | Med | Trade templates with placeholders + AI catalog ingestion + Concierge Setup |
| AI-native marketing claim erosion (one visible miss) | Med | Trust framework + audit log + abstain-on-low-confidence + UX language ("Last refreshed 3 hours ago") |
| QBD-anchored prospects walked away at launch (permanent) | High | No Phase 2 commitment per Emanuel call (T0.11 resolved). Soft-handle in sales: "QBO-only; QBD on roadmap only if demand emerges." Accept TAM filter. |
| **No dispatch UX in MVP** (T2.24 resolved D) — office staff scheduling friction | High | Basic list-view scheduling shipped; document workaround clearly; full dispatch sized for Phase 2 (~8-12 weeks). Watch trial-conversion data closely; if dispatch friction is the #1 lost-deal reason, accelerate. |
| ServiceTitan/HCP feature dump response | Low-Med | Defensible features are returns/credits/3WM + cross-trade Jobs + AI-native — competitor catch-up is 6-12 months |

## 18.3 Operational Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Self-serve trial support load | Med | In-app help + AI customer support deflection (internal use of Agent 7's owner brief pattern) + Concierge Setup paid escape hatch |
| Per-tenant cost variance blows margin | Med | OCR quotas + AI cost dashboard + hard-cap option (A51) |
| MDM / hardware support burden (even with refer-only) | Low | Hardware Health Check carries diagnostic; setup guides exhaustive; redirect to vendor RMA |
| Compliance schema gaps (a regulator audit fails) | Low-Med | Hash-chain audit log (A20) provides forensic floor; trade-specific cert UX layered Phase 2 as customers adopt |
| Multi-step approval engineering deferral | Low | Phase 2 commitment; commercial sales narrative includes "coming"; A49 amount+role v1 covers 80% |

## 18.4 Strategic Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Engineering team capacity for MVP scope | High | Hire RN-specialized engineers; consider contractor surge for AI features; 5 flagship workflows polish budget protects core experience even if scope slips |
| Naming / branding delay (A12 placeholder) | Low | Brand before launch; not blocking PRD or engineering |
| Sales motion absent at launch (self-serve only) | Med | Plan Enterprise demo motion for Month 3-6 as customer traction emerges |

---

# 19. Open Questions & Deferred Decisions

## 19.1 Director Assumptions Resolved at Review

| ID | Topic | Original assumption | Emanuel's resolution |
|---|---|---|---|
| T0.11 | QBD Strategy | Skip MVP + Codat Phase 2 | **`[DEFERRED]`** — Skip MVP, no Phase 2 commitment, revisit only on customer demand |
| T2.24 | Dispatch UX scope | B (mid: calendar + drag-drop + tech availability) v1 | **D — No dispatch UX in MVP.** Job assignment fields (`assigned_tech_id`, `scheduled_at`) editable in basic list view; full dispatch UX → Phase 2 |

**No outstanding Director assumptions remain.**

## 19.2 Phase 2 Decisions to Revisit

- Vendor catalog partnerships (which 3 first based on customer traction).
- Reference customers (Emanuel signoff pre-launch).
- Tier price anchors (validate vs market response).
- KeyWatcher integration depth (locksmith differentiation).
- Cycle count prioritization (AI weighting).
- Mobile push notification copy + cadence.
- Trade template starter content (Emanuel + AI co-authoring schedule).
- Concierge Setup service pricing.
- Wisetack integration depth (per-item vs per-service eligibility config).

## 19.3 Pre-Launch Brand Decisions

- Product name (replace `[PRODUCT]` placeholder per A12).
- Tagline confirmation ("FSM that turns field evidence into trusted financial action" candidate).
- Visual brand guidelines.
- Marketing site structure.

---

# 20. Appendices

## Appendix A — Data Model (Full DDL Sketch)

(Selected entities. Source: Agent 3 + interview decisions.)

### A.1 Tenant + Identity
```sql
-- organization (row in every other table FKs to this)
organization (id uuid PK, name text, slug text UNIQUE, created_at, updated_at)

-- [PROTOTYPE v1.1] branch — promoted from free-text to first-class entity
branch (id uuid PK, organization_id uuid FK, name text NOT NULL, code text NULL,
        address text NULL, phone text NULL, manager_user_id uuid NULL FK app_user(id),
        address_components jsonb NULL,    -- [SPEC-ONLY v1.1 §11.1.A] Google Places structured shape; written when user picks an autocomplete suggestion in AddBranchDialog. Powers locationBias for the org's other address fields + future "branches near job site" PostGIS queries.
        manager_name text NULL,           -- denormalized for free-text manager
        timezone text DEFAULT 'America/New_York',
        notes text, is_active boolean DEFAULT true,
        created_at, updated_at, deleted_at)
-- uq_branch_org_name (organization_id, name) WHERE deleted_at IS NULL
-- ix_branch_active (organization_id, is_active)

-- inventory_location.branch_id now FKs branch(id) instead of carrying free-text branch name

-- app_user
app_user (id uuid PK, organization_id uuid FK, email text, name text,
          is_subcontractor boolean, cost_rate_override numeric(12,2),
          sub_company_name text, sub_w9_on_file boolean,
          created_at, updated_at, deleted_at)

-- RBAC
role (id, organization_id, code, name)
permission (id, code, name, module)
role_permission (role_id, permission_id)
user_role (user_id, role_id, scope_type, scope_id) -- scope = branch / warehouse / location
api_key (id, organization_id, key_prefix, key_hash, status, expires_at, last_used_at, last_used_ip)
api_key_scope (api_key_id, scope_type, scope_id)
```

### A.2 Asset (Universal + Typed Extensions)
```sql
asset (id uuid PK, organization_id, customer_id, site_id, parent_asset_id,
       asset_type asset_type_enum, -- opening / panel / equipment / appliance / sprinkler_riser / pool_body / roof_section / generic
       name text, model text, serial text, install_date date, warranty_end_date date,
       location_id uuid FK inventory_location,
       created_at, updated_at, deleted_at)

asset_attribute_definition (id, organization_id, asset_type, field_key, field_label,
                            field_type field_type_enum, is_indexed boolean, is_required boolean)
asset_attribute_value (asset_id, definition_id, value_text, value_numeric, value_date, value_boolean)

asset_opening (asset_id PK, handing handing_enum, finish text, fire_rating text,
               opening_size text, ada_egress_flag boolean, hardware_set_id text,
               restricted_flag boolean, customer_owned_key_system_id uuid)
asset_panel (asset_id PK, controller_id text, firmware_version text, monitored_account_id text)
asset_equipment (asset_id PK, refrigerant_type text, refrigerant_gwp numeric, aim_compatibility_flag boolean, equipment_era text)
asset_appliance (asset_id PK, oem_part_fitment_matrix jsonb, warranty_window_start date, warranty_window_end date)
asset_sprinkler_riser (asset_id PK, nfpa_standard text, inspection_frequency frequency_enum, last_inspection_date date, next_inspection_due date)
asset_pool_body (asset_id PK, public_vs_residential_flag, health_dept_id text)
asset_roof_section (asset_id PK, squares numeric, sqft numeric, measurement_report_id text, aerial_provider text)

asset_service_history (id, asset_id, job_id, service_date, technician_id, summary, created_at)
asset_warranty (id, asset_id, warranty_type, start_date, end_date, terms text)
asset_inspection_record (id, asset_id, standard text, inspection_date, technician_id, result, deficiencies_count, evidence_url)
asset_deficiency (id, asset_id, inspection_record_id, detected_at, severity, description, disposition, resolved_at)
```

### A.3 Inventory
```sql
item (id uuid PK, organization_id, sku text, name text, kind item_kind_enum,
      category_id uuid FK category(id),                -- [PROTOTYPE v1.1] replaces free-text category
      brand_id uuid NULL FK brand(id),                 -- [PROTOTYPE v1.1 rev 2026-05-27 §6.10] manufacturer
      -- group_id was DROPPED rev 2026-05-28 §6.11 — Groups stopped meaning product families
      -- and now mean preset bundles; items no longer reference Groups, lines inside a Group
      -- reference items via item_group_line.item_id.
      visibility item_visibility_enum DEFAULT 'catalog', -- [PROTOTYPE v1.1 rev 2026-05-27 §6.A.3] 'catalog' | 'internal_only'; default computed from item.kind
      customer_name text NULL,                         -- [PROTOTYPE v1.1 rev 2026-05-27 §6.A.4] marketing-friendly name shown on customer-facing surfaces; falls back to item.name when null
      customer_description text NULL,                  -- [PROTOTYPE v1.1 rev 2026-05-27 §6.A.4] marketing copy; falls back to item.description when null
      key_features jsonb NULL,                         -- [PROTOTYPE v1.1 rev 2026-05-27 §6.A.4] array of 3-5 short bullet strings for Customer-Present Mode + PDF catalog
      photos jsonb NULL,                               -- [PROTOTYPE v1.1 rev 2026-05-27 §6.A.5] array of StageAttachment-shape objects (kind='image' only in v1); first/lowest sortOrder is the hero shot. (Hero-fallback chain originally chained through item_group.photo_url — superseded rev 2026-05-28 when Groups stopped meaning product families. New chain: item.photos[0] → stock placeholder.)
      list_price numeric(19,4) NULL,                   -- [PROTOTYPE v1.1 rev 2026-05-27 §6.A.6] customer-facing price override; when NULL the markup engine (§6.4) computes from unit_cost × (1 + resolved markup_pct)
      photo_url text,                                  -- [PROTOTYPE v1.1] LEGACY primary photo (single URL); superseded by photos jsonb above. Retained for back-compat with the v1.1 prototype's existing items table renderer. New code reads photos[0].dataUrl; legacy callers keep working until migrated.
      hazmat_flag boolean, sds_link text, regulated_purchase_flag boolean,
      restricted_protected_flag boolean, customer_owned_key_system_flag boolean,
      core_deposit_returnable_flag boolean, core_deposit_amount numeric(12,2),
      cut_to_length boolean, warranty_eligibility text,
      created_at, updated_at, deleted_at)

-- [PROTOTYPE v1.1 rev 2026-05-27 §6.A.3] Item visibility enum
CREATE TYPE item_visibility_enum AS ENUM ('catalog', 'internal_only');

-- [PROTOTYPE v1.1] Category as a managed entity (replaces free-text on item)
category (id uuid PK, organization_id uuid FK, name text, trade trade_type_enum NULL,
          description text,
          photo_url text NULL,                  -- [PROTOTYPE v1.1 rev 2026-05-28 §6.A.10] hero photo for the category, rendered as a 2:1 banner on Price Book → Categories cards (Cylinders, Electric Strikes, Capacitors, …); prototype: inline data: URI from FileReader; production: signed object-storage URL
          created_at, updated_at, deleted_at)

item_variant (id, item_id, sku text, name text, attributes jsonb,
              base_uom_id uuid, serialized boolean, lot_tracked boolean,
              model_serial_compatibility_matrix jsonb)

unit_of_measure (id, code, name, conversion_ratio_to_base, base_uom_id)

item_attribute_definition (...) -- typed sidecar
item_attribute_value (...) -- typed sidecar

inventory_location (id, organization_id, branch_id, location_type location_type_enum, -- warehouse / truck / bin / job_staging
                    parent_location_id, name, address, geog GEOGRAPHY(POINT),
                    primary_tech_id) -- nullable; for dedicated-truck pattern

stock_balance (organization_id, item_variant_id, location_id, on_hand_qty numeric(18,6),
               reserved_qty numeric(18,6), available_qty numeric(18,6),
               min_qty numeric(18,6) NULL,         -- [PROTOTYPE v1.1] reserve / par level — drives low-stock UX
               max_qty numeric(18,6) NULL,         -- [PROTOTYPE v1.1] reorder cap for auto-replenish suggestions
               updated_at)
-- PK: (organization_id, item_variant_id, location_id)
-- ix_stock_balance_available (organization_id, item_variant_id, available_qty desc)
-- ix_stock_balance_below_min (organization_id, location_id) WHERE on_hand_qty < min_qty  -- powers Low Stock KPI

stock_movement (id, organization_id, item_variant_id, from_location_id, to_location_id,
                movement_type movement_type_enum, -- receive / transfer / consume / return / adjust / writeoff
                quantity numeric(18,6), uom_id,
                reference_type, reference_id, -- e.g., work_order/123, purchase_receipt/456
                reason_code, occurred_at, created_at, created_by, client_operation_id text)
-- partitioned monthly by occurred_at
-- ix_stock_movement_variant_time, ix_stock_movement_reference

serial_number (id, organization_id, item_variant_id, serial text, status serial_status_enum,
               current_location_id, current_asset_id, manufacture_date, warranty_start, warranty_end)

lot (id, organization_id, item_variant_id, lot_code text, expiry_date date, manufacture_date date)
```

### A.4 Price Book
```sql
-- [PROTOTYPE v1.1 rev 2026-05-27 §6.10] Brand — manufacturer entity
brand (id uuid PK, organization_id uuid NOT NULL FK organization(id),
       name text NOT NULL,
       logo_url text NULL,
       website text NULL,
       description text NULL,
       default_markup_pct numeric(9,4) NULL,
       default_vendor_id uuid NULL FK vendor(id),
       is_active boolean DEFAULT true,
       created_at timestamptz DEFAULT now(),
       updated_at timestamptz DEFAULT now(),
       UNIQUE (organization_id, name))
-- ix_brand_org (organization_id)
-- ix_brand_org_active (organization_id) WHERE is_active

-- [PROTOTYPE v1.1 rev 2026-05-28 §6.11] Item Group — preset bundle of line items
-- (REDESIGN — the prior rev-2026-05-27 item_group represented a product family
-- within a brand and items referenced it via item.group_id. That concept was
-- retired; the table was repurposed for bundles. Migration drops brand_id and
-- default_markup_pct, adds group_type + flat_rate_price_override, and replaces
-- the (organization_id, brand_id, name) UNIQUE with (organization_id, name).)
CREATE TYPE item_group_type_enum AS ENUM ('flat_rate', 'individual');

item_group (id uuid PK, organization_id uuid NOT NULL FK organization(id),
            name text NOT NULL,
            description text NULL,
            photo_url text NULL,                    -- hero photo for the bundle; rendered as a banner on Groups tab card
            group_type item_group_type_enum NOT NULL DEFAULT 'individual',
            flat_rate_price_override numeric(12,2) NULL,  -- only meaningful when group_type='flat_rate'; NULL = use sum of lines
            is_active boolean NOT NULL DEFAULT true,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE (organization_id, name))
-- ix_item_group_org_active (organization_id) WHERE is_active

-- [PROTOTYPE v1.1 rev 2026-05-28 §6.11] Item Group Line — one row per line in a bundle
item_group_line (id uuid PK,
                 item_group_id uuid NOT NULL FK item_group(id) ON DELETE CASCADE,
                 sequence int NOT NULL DEFAULT 0,
                 item_id uuid NULL FK item(id) ON DELETE RESTRICT,  -- NULL = free-form line
                 name text NOT NULL,                                 -- mirror of item.name for real-item lines; operator-typed for free-form
                 quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
                 price_override numeric(12,2) NULL,                  -- override item's list price; REQUIRED for free-form lines
                 cost_override numeric(12,2) NULL,
                 notes text NULL,
                 created_at timestamptz NOT NULL DEFAULT now(),
                 CHECK (item_id IS NOT NULL OR price_override IS NOT NULL),
                 CHECK (item_id IS NOT NULL OR length(trim(name)) > 0))
-- ix_item_group_line_group_seq (item_group_id, sequence)
-- ix_item_group_line_item (item_id) WHERE item_id IS NOT NULL

catalog_item (id, organization_id, code, name, kind catalog_kind_enum,
              pricing_model pricing_model_enum, inventory_item_variant_id,
              status, deleted_at)

catalog_item_component (id, organization_id, parent_catalog_item_id, component_catalog_item_id,
                        quantity numeric(18,6), component_role role_enum,
                        sequence int, option_group_id)

catalog_option_group (id, organization_id, catalog_item_id, code, name,
                      group_type group_type_enum, -- good_better_best / single_select / multi_select
                      selection_min int, selection_max int, sort_order int)

catalog_option_group_member (id, organization_id, option_group_id, catalog_item_id,
                              display_label, is_default boolean, sort_order int)

markup_rule (id, organization_id, name, applies_to_kind,
             cost_source cost_source_enum, rounding_rule rounding_rule_enum,
             min_margin_percent numeric(9,6), is_active boolean)

markup_rule_tier (id, organization_id, markup_rule_id, min_cost_amount, max_cost_amount,
                  markup_percent numeric(9,6), markup_amount numeric(12,2), sort_order)

price_book (id, organization_id, name, currency_code char(3), status, created_at)

price_book_version (id, organization_id, price_book_id, version_no int,
                    effective_from timestamptz, effective_to timestamptz,
                    status version_status_enum, -- draft / published / archived
                    published_at, published_by, change_reason text)

price_book_entry (id, organization_id, price_book_version_id, catalog_item_id, tax_code_id,
                  pricing_mode pricing_mode_enum, unit_price_amount numeric(19,6),
                  flat_price_amount, hourly_rate_amount, cost_basis_amount,
                  markup_rule_id, rounding_rule, source_hash text) -- immutable
-- uq_price_book_entry (organization_id, price_book_version_id, catalog_item_id)

price_tier (id, organization_id, price_book_entry_id, min_qty numeric(18,6), max_qty,
            unit_price_amount, flat_price_amount, sort_order)

customer_price_override (id, organization_id, customer_id, catalog_item_id, priority int,
                          pricing_mode override_mode_enum, -- fixed_price / discount_percent
                          unit_price_amount, flat_price_amount, discount_percent numeric(9,6),
                          effective_from, effective_to, status)

contract_price (id, organization_id, contract_id, customer_id, catalog_item_id,
                pricing_mode, member_price_amount, discount_percent,
                effective_from, effective_to, status)

vendor_cost (id, organization_id, vendor_id, catalog_item_id, item_variant_id,
             vendor_catalog_item_id, uom_id, cost_amount numeric(19,6), currency_code char(3),
             source_type, source_reference, effective_from, effective_to)
-- immutable; ix_vendor_cost_current (org, catalog_item_id, vendor_id, effective_from desc)

price_history (id, organization_id, price_book_id, catalog_item_id,
               old_price_book_entry_id, new_price_book_entry_id,
               old_effective_price_amount, new_effective_price_amount,
               change_reason, changed_at, changed_by, import_job_id)
-- immutable; partitioned monthly
```

### A.5 Purchase Orders
```sql
vendor (id, organization_id, vendor_code text, name text, status,
        email, phone, address_text, default_currency_code char(3),
        payment_terms_code, po_transmit_method, default_lead_time_days,
        pickup_address text,                              -- [PROTOTYPE v1.1] will-call / counter address
        pickup_address_components jsonb NULL,             -- [SPEC-ONLY v1.1 §11.1.A] Google Places structured shape (line1/line2/city/region/postalCode/country/lat/lng/placeId); written when user picks an autocomplete suggestion in AddVendorDialog
        address_components jsonb NULL,                    -- [SPEC-ONLY v1.1 §11.1.A] structured shape for vendor.address_text — same Google Places shape, for the vendor's billing/HQ address (separate from pickup_address)
        price_tolerance_percent numeric(9,6) default 0.02,
        qty_tolerance_percent numeric(9,6) default 0,
        accounting_vendor_ref text, edi_partner_id text)
-- vendor.email / .phone above are the PRIMARY contact channel (back-compat
-- with single-contact readers); see vendor_contact below for the full list.

-- [PROTOTYPE v1.1] rev 2026-05-27: vendors can carry an arbitrary number of
-- extra contacts beyond the primary email/phone fields above (Orders rep,
-- AP, Branch Manager, After-hours dispatch, Returns desk, etc.). See §7.6
-- for the UX spec.
vendor_contact (id uuid PK, organization_id uuid FK,
                vendor_id uuid FK vendor(id) ON DELETE CASCADE,
                name text NULL,
                email text NULL,
                phone text NULL,
                role text NULL,                           -- free-form: "AP", "Branch manager", "After-hours"
                sort_order int NOT NULL DEFAULT 0,        -- preserves UI insertion order
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NULL)
-- ix_vendor_contact_vendor (vendor_id)
-- CHECK (coalesce(name, email, phone, role) IS NOT NULL)  -- reject empty rows

purchase_order (id, organization_id, po_number text, vendor_id, status po_status_enum,
                source_type po_source_enum, source_reference_type, source_reference_id,
                order_date, expected_date, ship_to_location_id, bill_to_location_id,
                currency_code, subtotal_amount numeric(19,4), tax_amount, total_amount,
                work_order_id, project_id, customer_id, approved_at, sent_at, closed_at, cancelled_at, notes)

purchase_order_line (id, organization_id, purchase_order_id, line_no int,
                     item_variant_id, catalog_item_id, vendor_catalog_item_id,
                     description, uom_id, ordered_qty, cancelled_qty, received_qty, billed_qty,
                     unit_cost_amount numeric(19,6), tax_code_id, line_status,
                     required_date, ship_to_location_id, work_order_id, project_id, customer_id)

purchase_order_approval (id, organization_id, purchase_order_id, step_no int,
                          approver_user_id, status, acted_at, comment, approval_limit_amount numeric(19,4))
-- immutable

purchase_order_status_history (id, organization_id, purchase_order_id,
                                from_status, to_status, changed_at, changed_by, reason_code, comment)
-- immutable; partitioned monthly

purchase_receipt (id, organization_id, receipt_number, purchase_order_id, vendor_id,
                  location_id, status, received_at, received_by, packing_slip_number,
                  asn_number, notes)

purchase_receipt_line (id, organization_id, purchase_receipt_id, purchase_order_line_id, line_no,
                       item_variant_id, accepted_qty, rejected_qty, damaged_qty, backordered_qty,
                       unit_cost_amount, lot_id, putaway_location_id, variance_reason_code)

vendor_bill (id, organization_id, bill_number, vendor_id, purchase_order_id, receipt_id,
             status, bill_date, due_date, currency_code, subtotal_amount, tax_amount, total_amount,
             external_accounting_ref, notes)

vendor_bill_line (id, organization_id, vendor_bill_id, purchase_order_line_id,
                  purchase_receipt_line_id, line_no, item_variant_id, catalog_item_id,
                  description, quantity, unit_cost_amount, line_amount numeric(19,4),
                  tax_code_id, match_status match_status_enum)

three_way_match_exception (id, organization_id, purchase_order_line_id, purchase_receipt_line_id,
                            vendor_bill_line_id, exception_type, status,
                            detected_at, resolved_at, resolved_by, notes)

-- v1 additions (returns + credits):
vendor_return (id, organization_id, return_number, vendor_id, purchase_receipt_id,
               status return_status_enum, requested_at, vendor_rma_number, reason_code, notes)

vendor_return_line (id, organization_id, vendor_return_id, purchase_receipt_line_id,
                     item_variant_id, quantity, unit_cost_amount, lot_id, photo_url)

credit_memo (id, organization_id, credit_memo_number, vendor_id, vendor_return_id,
              vendor_bill_id, status, amount numeric(19,4), issued_at, applied_at, notes)
```

### A.6 Cross-Trade Jobs
```sql
job (id, organization_id, job_number, customer_id, site_id, status,
     opened_at, closed_at, total_amount numeric(19,4), notes)

job_segment (id, organization_id, job_id, trade_type trade_type_enum,
             primary_tech_id, asset_id, status, segment_notes, scheduled_at, completed_at)

job_segment_line (id, organization_id, job_segment_id, line_no, line_type line_type_enum,
                  catalog_item_id, item_variant_id, description,
                  quantity, unit_price_amount, line_amount, tax_code_id, source_attribution)

-- [PROTOTYPE v1.1] Job Staging — see §7.4.A for the UX spec
job_stage (id uuid PK, organization_id uuid FK, job_id uuid FK job(id),
           status job_stage_status_enum,    -- awaiting / partial / complete / ready_for_pickup / delivered
           pickup_vendor_id uuid NULL FK vendor(id),
           pickup_address text NULL,        -- defaults from vendor.pickup_address, editable
           pickup_address_components jsonb NULL,  -- [SPEC-ONLY v1.1 §11.1.A] Google Places structured shape; written when CreateStageDialog's operator picks an autocomplete suggestion in the Vendor Pickup Location override. Defaults from vendor.pickup_address_components when the vendor is picked.
           staged_location_id uuid NULL FK inventory_location(id),
           assigned_tech_id uuid NULL FK app_user(id),
           scheduled_for timestamptz NULL,  -- denormalized from job.scheduled_at
           notes text,
           audit_log jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [PROTOTYPE v1.1] denormalized stage edit history; canonical record in audit_log table
           created_at, updated_at)

job_stage_line (id uuid PK, organization_id, job_stage_id uuid FK,
                catalog_item_id uuid FK, item_variant_id uuid FK,
                qty_ordered numeric(18,6), qty_received numeric(18,6),
                vendor_id uuid FK vendor(id),
                purchase_order_id uuid NULL FK purchase_order(id),
                purchase_order_line_id uuid NULL FK purchase_order_line(id),
                expected_date date NULL,
                received_serials text[],
                created_at)
-- ix_job_stage_line_po (organization_id, purchase_order_id)   -- powers "From PO" exclusion check

-- [PROTOTYPE v1.1] Staging attachments — see §7.4.A.10 for the UX spec
-- Holds photos, videos, and PDF-page-derived images. At least one row is
-- required before a job_stage can transition status → 'ready_for_pickup'.
job_stage_attachment (
  id                  uuid PRIMARY KEY,
  organization_id     uuid NOT NULL FK organization(id),
  job_stage_id        uuid NOT NULL FK job_stage(id) ON DELETE CASCADE,
  kind                attachment_kind_enum NOT NULL,        -- 'image' | 'video'
  storage_url         text NOT NULL,                        -- S3 / blob URL (prototype uses base64 dataURL)
  mime_type           text NULL,
  caption             text NULL,
  uploaded_at         timestamptz NOT NULL DEFAULT now(),
  uploaded_by_user_id uuid NOT NULL FK app_user(id),
  source              attachment_source_enum NOT NULL,      -- 'camera' | 'upload' | 'pdf_page'
  pdf_page_number     int NULL,                             -- only when source = 'pdf_page'
  pdf_file_name       text NULL,                            -- only when source = 'pdf_page'
  duration_seconds    numeric NULL,                         -- only when kind = 'video'
  size_bytes          bigint NULL,
  purchase_order_id   uuid NULL FK purchase_order(id),      -- optional PO scope for multi-PO stages
  created_at          timestamptz NOT NULL DEFAULT now()
);
-- ix_jsa_stage (job_stage_id)                              -- powers the photo-required guard on ready_for_pickup
```

### A.7 Cross-Cutting Infrastructure
```sql
-- [PROTOTYPE v1.1] Stock-out approval queue — see §5.4.A.v for UX spec
stock_action_approval (id uuid PK, organization_id uuid FK,
                       requested_at timestamptz, requested_by_user_id uuid FK app_user(id),
                       action_type action_type_enum,    -- consume_on_job · return_to_warehouse · writeoff · transfer_to_van
                       item_variant_id uuid FK, catalog_item_id uuid FK,
                       qty numeric(18,6), uom_id uuid FK,
                       from_location_id uuid FK inventory_location(id),
                       to_location_id uuid NULL FK inventory_location(id),
                       job_id uuid NULL FK job(id),
                       reason text, serial_captured text NULL, photo_url text NULL,
                       status approval_status_enum,     -- pending · approved · rejected
                       reviewed_at timestamptz NULL, reviewed_by_user_id uuid NULL,
                       review_comment text NULL,
                       posted_movement_id uuid NULL FK stock_movement(id),
                       created_at)
-- ix_approval_pending (organization_id, status) WHERE status = 'pending'

outbox_event (id uuid PK, organization_id, aggregate_type, aggregate_id, event_type,
              event_version int, partition_key, payload_json jsonb, headers_json jsonb,
              occurred_at, published_at, attempt_count int, last_error text)
-- partitioned monthly; ix_outbox_unpublished (published_at NULLS FIRST, occurred_at)

sync_tombstone (id, organization_id, table_name, entity_id, deleted_at, retention_until)

audit_log (id uuid PK, organization_id, actor_user_id, actor_type, module, entity_table,
           entity_id, action, before_json jsonb, after_json jsonb, reason_code,
           request_id, ip_address inet, created_at,
           prev_hash bytea, entry_hash bytea)
-- partitioned monthly; append-only; never UPDATE; hash chain

webhook_subscription (id, organization_id, target_url, event_types text[], signing_secret,
                       status, created_at)
webhook_delivery (id, subscription_id, event_id, delivered_at, response_status,
                  attempt_count, next_retry_at, status)
```

## Appendix B — API Endpoint Catalog (Selected)

```
GET    /api/v1/inventory/items?query=&filter[is_active]=
GET    /api/v1/inventory/items/{id}
POST   /api/v1/inventory/items
PATCH  /api/v1/inventory/items/{id}

GET    /api/v1/inventory/stock-levels?item_variant_id=&near=lat,lon&radius_miles=20
POST   /api/v1/inventory/movements/consume
POST   /api/v1/inventory/movements/transfer
POST   /api/v1/inventory/movements/return
POST   /api/v1/inventory/movements/adjust
POST   /api/v1/inventory/counts
POST   /api/v1/inventory/counts/{id}/post

GET    /api/v1/price-book/search?q=&customer_id=&as_of=
GET    /api/v1/price-book/items/{id}
POST   /api/v1/price-book/import-jobs
POST   /api/v1/price-book/versions/{version_id}/publish
GET    /api/v1/price-book/history?catalog_item_id=

GET    /api/v1/purchase-orders?filter[status]=open
POST   /api/v1/purchase-orders
PATCH  /api/v1/purchase-orders/{id}
POST   /api/v1/purchase-orders/{id}/approve
POST   /api/v1/purchase-orders/{id}/send
POST   /api/v1/purchase-orders/{id}/receipts
POST   /api/v1/purchase-orders/{id}/returns
GET    /api/v1/three-way-match/exceptions?filter[status]=open
POST   /api/v1/three-way-match/exceptions/{id}/resolve

GET    /api/v1/assets?filter[customer_id]=
POST   /api/v1/assets
GET    /api/v1/assets/{id}/service-history

GET    /api/v1/jobs?filter[status]=
POST   /api/v1/jobs
POST   /api/v1/jobs/{id}/segments
PATCH  /api/v1/jobs/{job_id}/segments/{segment_id}

POST   /api/v1/webhooks/subscriptions
POST   /api/v1/integrations/quickbooks/sync
POST   /api/v1/integrations/avalara/calculate-tax
POST   /api/v1/integrations/stripe/payment-intents

POST   /api/v1/ai/search                   -- smart search
POST   /api/v1/ai/voice-to-parts/sessions  -- start streaming session
POST   /api/v1/ai/ocr/jobs                 -- vendor invoice OCR submit
POST   /api/v1/ai/catalog-ingestion/jobs   -- bulk catalog import
GET    /api/v1/ai/owner-brief?period=day   -- owner morning brief

GET    /api/v1/health                       -- public health check
```

Conventions: cursor pagination, `Idempotency-Key`, `If-Match` ETag, structured error envelope, rate limits per §11.4.

## Appendix C — Event Catalog (CloudEvents 1.0)

```
inventory.item.created.v1
inventory.item.updated.v1
inventory.item_variant.created.v1
inventory.balance.changed.v1
inventory.stock_received.v1
inventory.stock_transferred.v1
inventory.stock_consumed_on_job.v1
inventory.stock_returned.v1
inventory.stock_adjusted.v1
inventory.serial_status_changed.v1

pricing.price_book_version_published.v1
pricing.price_updated.v1
pricing.markup_rule_changed.v1

procurement.po_created.v1
procurement.po_submitted.v1
procurement.po_approved.v1
procurement.po_sent.v1
procurement.po_partially_received.v1
procurement.po_received.v1
procurement.po_closed.v1
procurement.po_cancelled.v1
procurement.vendor_bill_entered.v1
procurement.vendor_return_created.v1
procurement.credit_memo_issued.v1
procurement.three_way_match_failed.v1

asset.created.v1
asset.updated.v1
asset.service_history_added.v1
asset.deficiency_detected.v1

job.created.v1
job.segment_assigned.v1
job.segment_completed.v1
job.closed.v1

# [PROTOTYPE v1.1] Job Staging events
staging.stage_created.v1
staging.stage_line_received.v1
staging.stage_partial.v1
staging.stage_complete.v1
staging.stage_ready_for_pickup.v1
staging.stage_delivered.v1
staging.stage_updated.v1    # [PROTOTYPE v1.1] emitted per field change via Stage Detail Dialog edit

# [PROTOTYPE v1.1] Stock-Out Approval events
approval.requested.v1
approval.approved.v1
approval.rejected.v1
approval.movement_posted.v1

estimate.created.v1
estimate.sent.v1
estimate.accepted.v1
estimate.declined.v1

integration.vendor_catalog_refreshed.v1
integration.accounting_sync_failed.v1
integration.ocr_complete.v1
integration.ai_search_query.v1
```

Envelope (per CloudEvents 1.0):
```json
{
  "specversion": "1.0",
  "id": "<uuid>",
  "source": "/organizations/<org_id>/inventory",
  "type": "inventory.stock_consumed_on_job.v1",
  "subject": "stock_movement/<id>",
  "time": "<RFC3339>",
  "datacontenttype": "application/json",
  "dataschema": "urn:product:events:inventory.stock_consumed_on_job.v1",
  "organizationid": "<org>",
  "correlationid": "req_...",
  "causationid": "cmd_...",
  "partitionkey": "<org>:stock",
  "data": { ... }
}
```

Delivery: HMAC SHA-256 signature header, exponential backoff up to 72h, manual replay UI, dead-letter table after terminal failure. Outbound delivery infra: **buy Svix or Hookdeck** (Agent 4).

## Appendix D — Integration Spec Details

(Per-integration spec template; see §9 for QBO + Stripe + Avalara + Wisetack deep dives.)

Template per integration:
- Auth method
- Sync direction
- Entities synced
- Conflict resolution
- Rate limits
- Known gotchas
- Build/buy/partner decision

## Appendix E — Hardware Compatibility Matrix (Certified-Device Allowlist)

| Category | Model | iOS | Android | SDK Required | Phase |
|---|---|---|---|---|---|
| Camera scan (native) | iOS VisionKit | ✓ | — | Built-in | 1 |
| Camera scan (native) | Android ML Kit / Google Code Scanner | — | ✓ | Built-in | 1 |
| Premium scan SDK | Scandit | ✓ | ✓ | Scandit (paid) | 1 (Pro+ feature) |
| BT scanner | Socket S720 | ✓ MFi | ✓ | CaptureSDK or HID | 1 |
| BT scanner | Zebra CS6080 | ✓ | ✓ | DataWedge / Link-OS | 1 |
| Handheld 2D | Honeywell Xenon 1952g | ✓ | ✓ | HID / SDK | 1 |
| Rugged Android | Zebra TC27 | — | ✓ | DataWedge keyboard wedge | 1 |
| Rugged Android | Zebra TC53/TC58 | — | ✓ | DataWedge | 1 (alt) |
| Rugged Android | Honeywell CT47 | — | ✓ | Honeywell SDK | 1 (alt) |
| Mobile printer | Brother RJ-4250WB / RJ series | ✓ | ✓ | Brother SDK / b-PAC | 1 |
| Mobile printer (rugged) | Zebra ZQ511 | ✓ | ✓ | Link-OS / ZPL | 2 |
| Desktop label printer | Zebra ZD421 | ✓ | ✓ | Link-OS / ZPL | 1 |
| Desktop label printer | Brother QL-1110NWB / QL-820NWB | ✓ | ✓ | Brother SDK | 1 (alt) |
| Receipt printer | Epson TM-m30III | ✓ | ✓ | Epson ePOS | 1 |
| Receipt printer | Star (TSP series) | ✓ | ✓ | Star SDK | 1 (alt) |
| Cash drawer | APG | — | — | RJ12 via receipt printer | 1 |
| Payment reader (mobile) | Stripe Reader M2 | ✓ | ✓ | Stripe Terminal SDK | 1 |
| Payment terminal (counter) | Stripe S700/S710 | n/a | n/a (Android-based) | Stripe Terminal | 1 |
| Payment (no hardware) | Apple Tap to Pay | ✓ | — | Stripe Terminal | 1 |
| Ring scanner | Zebra RS5100 / RS2100 | — | ✓ | DataWedge | 2 |
| Key control bridge | KeyWatcher API | — | — | Vendor API | 2 |
| Key control sync | KeyTrak Edge | — | — | Vendor data bridge | 2 |
| Direct part marks | Cognex Mobile Barcode | ✓ | ✓ | Cognex (paid) | 2 (edge case) |
| NFC asset tagging | iOS Core NFC / Android NFC | ✓ | ✓ | Built-in | 2 |
| RFID UHF | Various | ✓ | ✓ | Vendor SDK | 3 |
| BLE beacons | Various | ✓ | ✓ | Vendor SDK | 3 |

## Appendix F — Glossary

| Term | Definition |
|---|---|
| FSM | Field Service Management |
| CMMS | Computerized Maintenance Management System |
| GBB | Good / Better / Best (option-tier presentation) |
| 3WM | Three-Way Match (PO ↔ Receipt ↔ Bill) |
| RMR / MRR | Recurring Monthly Revenue / Monthly Recurring Revenue |
| ACaaS | Access Control as a Service |
| BYO | Bring Your Own (content) |
| AHJ | Authority Having Jurisdiction (local code official) |
| TTFVA | Time To First Valuable Action |
| NEC | National Electrical Code |
| NFPA | National Fire Protection Association |
| NASTF VSP | National Auto Service Task Force Vehicle Security Professional |
| NICET | National Institute for Certification in Engineering Technologies |
| AAADM | American Association of Automatic Door Manufacturers |
| IDEA | Institute of Door Dealer Education and Accreditation |
| DASMA | Door & Access Systems Manufacturers Association |
| ASSE | American Society of Sanitary Engineering |
| EPA 608 | EPA Section 608 (refrigerant certification) |
| AIM Act | American Innovation and Manufacturing Act (HFC phasedown) |
| FIFRA | Federal Insecticide, Fungicide, and Rodenticide Act |
| BICSI | Building Industry Consulting Service International |
| PHTA CPO | Pool & Hot Tub Alliance Certified Pool/Spa Operator |
| ISSA CIMS | International Sanitary Supply Association Cleaning Industry Management Standard |
| NALP | National Association of Landscape Professionals |
| RLS | Row-Level Security (Postgres) |
| CDC | Change Data Capture |
| MDM | Mobile Device Management |
| MFi | Made for iPhone (Apple certification) |
| HID | Human Interface Device (USB/BT class) |
| ZPL | Zebra Programming Language (printer) |
| LinkedTxn | QuickBooks linked-transaction reference |

## Appendix G — Research Source Citations

All research files in `/research/`:

1. **Agent 1 — Voice of Customer**: `Voice of the Customer on Inventory and Price Book in FSM CRMs.pdf`
2. **Agent 2 — Competitor Teardown**: `Competitor Teardown of Inventory Price Book and Purchase Orders in Leading FSM CRMs.pdf`
3. **Agent 3 — Data Model & Tech Architecture**: `Deep Research Backing Conversation for session None (1).pdf`
4. **Agent 4 — Integrations & Ecosystem**: `Integrations Playbook for Inventory, Price Book, and Purchase Orders in an FSM CRM.pdf`
5. **Agent 5 — Mobile/Field Tech UX**: `Mobile UX Playbook for Inventory Price Book and Purchase Orders in FSM CRMs.pdf`
6. **Agent 6 — Pricing Strategy & Flat-Rate Content**: `Pricing Strategy and Flat-Rate Price Book Strategy for FSM CRMs.pdf`
7. **Agent 7 — AI & Automation**: `AI Strategy for Inventory Price Book and Purchase Orders in FSM CRM.pdf`
8. **Agent 11 — Trade-Specific Requirements**: `Trade-Specific Inventory, Price Book, and PO Requirements for a Multi-Trade FSM CRM.pdf`
9. **Agent 13 — Hardware Ecosystem**: `Deep Research Backing Conversation for session None.pdf`

All interview decisions in `/working/answered.md` (A1–A59).
All synthesis in `/working/synthesis.md`.
Interview transcript in `/working/interview-log.md`.

---

# END OF PRD v1.0 Draft

**Director's note:** This PRD reflects 79/79 interview questions resolved (Phase 3 complete). Two Director assumptions are flagged for your review (T0.11 QBD strategy interpretation; T2.24 dispatch UX scope). All else traces to explicit Emanuel decisions or research-backed Director calls per delegation pattern. Phase 5 revision begins on your signal — review section-by-section, accept/edit/replace as needed.
