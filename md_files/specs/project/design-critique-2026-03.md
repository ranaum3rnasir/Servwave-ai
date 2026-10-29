# ALPHA CRM — Full Design Critique
**Date:** March 2026 | **Viewport:** 1440×900 | **Benchmark:** Linear, Vercel Dashboard, Stripe, Jobber

---

## 01 — Login Page
**Overall:** Functional but forgettable — the first impression communicates "template", not "product".

### What works
- Primary blue "Sign In" button is the clear CTA — no ambiguity
- Field labels are clean, placeholder text is appropriately muted
- Form width is reasonable; doesn't fight the viewport

### What to improve
- **Brand Identity:** Pure white background + minimal logo = no brand moment. The login page is the emotional hook — this one would pass for any SaaS app. Jobber has a bold left-panel illustration; Linear has a signature dark-mode charm. → Add a full-bleed left panel (brand color, geometric pattern, or a key value-prop callout like "Your whole operation. One screen.")
- **Typography:** "ALPHA CRM" uses the primary blue at ~32px bold but as plain text with no mark/icon — it's a wordmark that looks accidental, not designed. → Add the briefcase icon from the sidebar (it already exists) tightly set to the left of the word "ALPHA" in white-on-blue or give the word "ALPHA" and "CRM" different weights.
- **Spatial System:** The card floats in the dead center of a full-white page. At 1440px wide this is a lot of nothing. → Either go split-panel or add a subtle gradient/texture to the background (e.g. `bg-gradient-to-br from-blue-50 to-slate-100`).
- **Component Craftsmanship:** The form card's shadow is nearly invisible — it feels like it's drawn directly on the white page rather than lifted above it. → `shadow-lg` or `shadow-xl` creates the premium "card above a surface" feel.
- **Color:** The "Password" label renders in a darker blue-ish tone. It appears slightly different from "Email" — potential color inconsistency in label rendering (could be a browser rendering artifact but worth verifying). → Ensure all field labels use the same token.

### Priority changes
- 🔴 P1: Add left-panel brand moment — split layout with brand color + tagline on left, form on right
- 🟡 P2: Increase card elevation — `shadow-xl` + subtle `ring-1 ring-black/5`
- 🔵 P3: Background texture — `bg-slate-50` or very subtle gradient instead of pure white

---

## 02 — Dashboard
**Overall:** This is the single biggest credibility gap — the "home" of the app is an empty stub.

### What works
- Sidebar is fully rendered here and works well as the navigation anchor
- "Hi, Welcome Back!" header copy is warm and personal — keep the tone

### What to improve
- **Data Visualization (Critical):** The entire content area is an empty blue-gray void with a tiny white card saying "Welcome, System Admin / Role: ADMIN". This is an abandoned placeholder, not a dashboard. A $179/month B2B CRM user opens this every morning — it should immediately communicate the state of their business. → Build the actual dashboard: today's scheduled jobs, open leads count, revenue this month, recent activity feed.
- **Brand Identity:** The dashboard is the most-seen screen. Its emptiness signals to any evaluator that the product is incomplete. This will kill demos.
- **Spatial System:** The `p-4` content padding with a single small card in the top-left corner leaves 85% of the canvas blank.

### Priority changes
- 🔴 P1: Implement a real dashboard (4-cell KPI strip: Revenue MTD, Open Leads, Jobs Today, Unread/Pending) + a jobs-today timeline + recent activity list — this is Step 9 but even a minimal version would transform the impression
- 🔴 P1: Until the real dashboard is built, show a meaningful "Today's Overview" card with data from the DB rather than just the role name
- 🔵 P3: The header greeting "Hi, Welcome Back!" should use the user's actual first name ("Hi, Ran!")

---

## 03 — Leads List
**Overall:** One of the strongest screens — dense, functional, and clearly communicates the pipeline state.

### What works
- KPI strip (5 cells, `divide-x`) is clean and immediately useful — "49 Unassigned" in red/warning context tells the dispatcher exactly where to look
- Avatar initials in customer cells bring warmth and quick visual scanning
- Status badges are appropriately sized with color-coding
- "Referral" source badge rendered in a colored pill stands out from the `—` empty values — good visual contrast
- The table density is right for a power-user list: comfortable without being airy

### What to improve
- **Typography:** All column headers are all-caps at small size — good. But the truncated "ESTIM..." and "ASS..." column headers are sloppy. Either widen the columns or rename to shorter labels ("EST." / "ASSIGNEE"). → Column header truncation is never acceptable; fix column widths or labels.
- **Color System:** The KPI strip icons (small gray outline icons) are barely readable and decorative at best — they add no semantic meaning. "UNASSIGNED 49" should communicate urgency — a red/amber accent number rather than black would direct attention. → Color-code the value numbers in KPI cells based on severity: green for Won, red for Unassigned, neutral for others.
- **Navigation:** The count badge "54" next to "Leads" in the page title (`Leads  54`) uses a subtle gray badge that looks accidental. → Style this as a proper count badge: `text-muted-foreground text-sm font-medium` in a rounded container, or just drop it and rely on the KPI strip.
- **Data Visualization:** The KPI strip shows raw counts but no trend. "0 New This Week" — is that good or bad? There's no baseline. → Add trend arrows (↑↓) with a softer secondary line: "↓ 12 vs last week" in `text-xs text-muted-foreground`.

### Priority changes
- 🔴 P1: Fix truncated column headers ("ESTIM..." → "ESTIMATES" or resize, "ASS..." → "ASSIGNED")
- 🟡 P2: Color-code KPI numbers based on urgency/state (e.g. Unassigned in amber)
- 🔵 P3: Add delta/trend indicators to KPI cells

---

## 04 — Lead Detail
**Overall:** The best-designed detail page — the 2-column layout is well-executed and information hierarchy is clear.

### What works
- Breadcrumb is clean and non-intrusive (← Leads > Lead from Ran Test)
- Hero section with status badge + dropdown + Edit/Assign actions — professional
- KPI strip (4 cells) below the hero is well-placed and communicates value instantly
- Right sidebar ordering (Customer → Service Locations → Assigned To → Notes) follows a logical read-order
- "PRIMARY" badge on the service location is a small detail that adds professional polish
- The estimates sub-table with number/status/total is appropriately compact

### What to improve
- **Component Craftsmanship:** The "Schedule Walkthrough" button renders in near-black/very dark — it visually dominates the entire left column and competes with the actual page hierarchy. It's styled like a P0 emergency action but a walkthrough scheduling is a secondary workflow. → Change to an outline button with an icon, or use the primary blue for this action and make it smaller.
- **Color System:** The "Won" badge on the hero is green with good saturation, but the status dropdown chevron next to it creates an unusual "badge + arrow" combination. → Keep status badge as read-only display; move the status-change affordance to the Edit dialog only, or make the dropdown arrow more clearly a toggle.
- **Typography:** "SERVICE REQUEST" and "WALKTHROUGH" section labels are all-caps small-caps — consistent and authoritative. But the section label weight/color is similar to body text, making sections feel continuous rather than compartmentalized. → Give section labels a left border accent (`border-l-2 border-primary pl-2`) or a slight background tint for visual grouping.
- **Empty States:** The "No walkthrough scheduled" state is just plain text below the empty walkthrough zone. → A tiny calendar illustration or icon + message ("No walkthrough yet — schedule one to qualify this lead") would communicate intentionality.
- **Motion:** The "+ Tag" button is small and low-contrast — it looks like a broken element. Tags are a power feature. → Style it more clearly as a clickable action: `border-dashed border rounded-full px-2 py-0.5 text-xs hover:border-primary hover:text-primary`.

### Priority changes
- 🔴 P1: De-emphasize "Schedule Walkthrough" button — change from dark/black to outline or secondary style
- 🟡 P2: Section label visual separation — subtle left-border accent or `text-muted` vs `text-foreground` hierarchy
- 🔵 P3: Designed empty state for Walkthrough zone

---

## 05 — Customers List
**Overall:** Polished and distinctive — the avatar initials + colored circles are the strongest visual element in the entire app.

### What works
- Colored avatar circles (ED=teal, RT=blue, ET=blue) immediately make the list feel human and scannable
- "Instagram" source badge in rose-pink is eye-catching and makes the referral source data feel alive
- LEADS/JOBS count circles are compact and readable — subtle but informative
- Column structure is well-chosen: customer identity → contact → location → activity counts

### What to improve
- **Color System:** The Leads and Jobs count circles use a very faint outline style with muted numbers. They communicate counts but feel low-confidence. The Jobs count "5" has a teal outline (because there are active jobs?) but the distinction isn't clear from legend or tooltip. → Be explicit: color these circles by state (e.g. 5 jobs = green ring if active, blue if scheduled, gray if all closed) and add tooltip on hover.
- **Typography:** Email addresses appear as secondary text below the customer name — good. But the email color is the same muted gray as all secondary text, making rows where the email is long feel visually cluttered. → Consider hiding email by default in compact rows and showing on hover, or abbreviating it.
- **Component Craftsmanship:** The black "+ Add Customer" button (dark, not primary blue) breaks consistency — the Leads list uses blue for "New Lead". This inconsistency signals a lack of a unified button style system.
- **Spatial System:** Between the KPI strip and the toolbar (Search / Filter / Export / Columns / Add Customer), there's a comfortable gap. But the Filter and Columns buttons look visually similar in weight — users may not immediately distinguish them from each other. → The primary CTA (Add Customer) should be the clear dominant button; secondary actions (Export, Columns) should be lighter/ghost.

### Priority changes
- 🔴 P1: Unify primary CTA button color — all "+ [New Entity]" buttons should use `bg-primary` (blue), not black
- 🟡 P2: Give LEADS/JOBS count circles semantic color based on activity state
- 🔵 P3: Consider email truncation in compact rows

---

## 06 — Customer Detail
**Captured state:** Loading spinner — raw `C`-shaped arc on empty gray background.

### What this reveals
- **Loading State (Critical):** The customer detail page takes long enough that a 500ms screenshot captures a bare spinner. This is the worst possible loading experience — a large gray void with a small arc. At 1440×900 there is ~1.1M pixels of nothing.
- **Empty/Loading States:** No skeleton screen, no content structure hint, no brand presence during load. Stripe Dashboard shows card skeletons that match the exact shape of the loaded content — the transition from skeleton to real data is instant and painless. Vercel shows animated gray blocks matching the table structure.

### What to improve
- **Motion & Loading:** Replace the bare spinner with a skeleton screen that mirrors the actual Customer Detail layout: hero skeleton (rectangle at 300px), KPI strip skeleton (4 equal cells), content area skeleton (2 columns, left = 3 text blocks, right = sidebar items). → Use `animate-pulse bg-muted rounded` blocks. This is ~30 lines of JSX and transforms the perceived performance dramatically.
- **Iconography:** The spinner is a plain browser-style arc (`C` shape) — not branded. → The spinner should match the design system: a custom ring using the primary blue (`border-primary`).

### Priority changes
- 🔴 P1: Implement skeleton loading screens for all detail pages (Customer, Estimate, Job) — this is the single highest-ROI loading improvement
- 🟡 P2: Brand the spinner — use `border-primary` ring style, not default gray arc

---

## 07 — Estimates List
**Overall:** Clean and well-structured — the WIN RATE KPI is the standout moment.

### What works
- 6-cell KPI strip works well for the estimates pipeline — each status has its own cell with both count and dollar amount, giving a complete financial picture at a glance
- "WIN RATE 100%" as the final rightmost cell is the hero stat — users will look there first
- The status badges ("Sent" in blue outline, "Approved" in green fill) have good semantic contrast
- EST-XXXX number links in blue are clearly clickable

### What to improve
- **Typography:** KPI numbers (0, 1, 4) are bold but not large enough to scan from across a meeting room. The secondary dollar amounts (`$0.00`, `$4,782.63`) are the same size as the count numbers — they should be visually subordinate. → Make the count number `text-3xl font-bold tabular-nums`, the dollar amount `text-xs text-muted-foreground` below it. The contrast between "4" and "$4,782.63" should be 3:1 in size.
- **Color System:** "New Estimate" primary CTA is near-black (dark navy/almost black). Should be the primary blue. Same inconsistency seen in Customers and Price Book.
- **Data Visualization:** The WIN RATE cell shows "100% / $4,782.63 / $4,782.63" — the fraction is great data but the formatting is confusing. → Format as: `100%` large, `↑ $4,782.63 won of $4,782.63 sent` as a tooltip or secondary line.
- **Iconography:** The small icons next to each status label (paper/send/check/X/circle/arrow icons) add visual texture but are quite small and pixelated at this scale. → Ensure all KPI strip icons are rendered at 20px and use `stroke-width="1.5"`.

### Priority changes
- 🔴 P1: Unify primary CTA button to `bg-primary` blue (not dark)
- 🟡 P2: Increase KPI number size — `text-3xl` for counts, `text-sm text-muted` for amounts
- 🔵 P3: Improve WIN RATE cell formatting — percentage big, fraction text secondary

---

## 08 — Estimate Detail
**Captured state:** Loading spinner — same bare-arc issue as Customer Detail.

### What this reveals
- Confirms the pattern: all detail pages use bare spinner, no skeleton screens
- The estimate detail page is one of the most data-rich views (hero, KPI, line items, deposit, job status, notes, actions) — its skeleton would be especially impactful to design

### Priority changes
- 🔴 P1: Same as #06 — skeleton screens for all detail pages

---

## 09 — Estimate Form (new without lead_id)
**Captured state:** Error state — "A lead_id parameter is required to create an estimate."

### What this reveals
- **Error State Design:** The error message is a raw red alert text + plain "Go to Leads" button with no surrounding context. This is a real error state that real users will hit (if they navigate directly to `/estimates/new`). It looks broken.
- The error zone takes up 3 lines at the very top of the content area; the rest of the page is empty gray

### What to improve
- **Empty/Error States:** This error should be a proper "landing" state: centered card, relevant icon (e.g. `FileQuestion` or `AlertCircle`), clear explanation, prominent CTA. → Replace the inline red text with a centered card: icon + heading "Estimates require a lead" + body "Select a lead first, then create an estimate from the lead detail page." + primary CTA button "Browse Leads".
- **Navigation:** The "Go to Leads" button is plain outline style — not visually prominent enough for a recovery CTA. → Use `variant="default"` (blue) for the recovery CTA.

### Priority changes
- 🔴 P1: Design the error state as a proper centered card with icon + explanation + prominent CTA
- 🟡 P2: Consider adding a redirect — if no `lead_id`, auto-redirect to `/leads` after 2 seconds with a toast explaining why

---

## 10 — Jobs List
**Overall:** Solid and consistent with the other list pages — the urgent job warning icons are a distinctive and functional detail.

### What works
- Orange triangle "⚠" icons next to urgent job numbers are immediately meaningful — dispatchers scan these first
- The customer cell showing both name and company (Ohad Azran / Alpha Doors & Security) adds density without clutter
- Status badge color variety (Scheduled=blue, Cancelled=gray, Unassigned=amber, Completed=green) is well-differentiated
- "New Urgent Job" in black communicates urgency through the color contrast (deviates from primary blue intentionally)

### What to improve
- **Color System:** The "Unassigned" status badge uses a muted amber/orange outline. "Unassigned" jobs should feel more urgent — a filled amber badge or a `bg-amber-100 text-amber-800 border border-amber-200` would be more alarming. The current soft outline reads as low-priority.
- **Typography:** The KPI strip counts (1, 3, 0, 1, 1) need more visual weight — same note as Estimates list: `text-3xl font-bold` for the counts.
- **Data Visualization:** The "SCHEDULED" column shows a date when assigned, or `—` when not. For scheduled jobs, showing the date+time with a relative indicator ("Tomorrow 9AM" vs "3/5/2026") would be more actionable.
- **Iconography:** The clock icon for UNASSIGNED, calendar for SCHEDULED, play for IN_PROGRESS, checkmark for COMPLETED, circle-cross for CANCELLED are all present in the KPI strip. But they're the same gray stroke weight as the labels — they look decorative. → Color the icons to match the badge color for each status: amber clock, blue calendar, green check.

### Priority changes
- 🟡 P2: Color KPI strip icons to match their status semantic color
- 🟡 P2: Color-code the "Unassigned" badge more aggressively (filled amber, not outline)
- 🔵 P3: Relative dates in SCHEDULED column ("Tomorrow" / "In 2 days" / "3/5")

---

## 11 — Job Detail
**Captured state:** Loading spinner — same bare-arc issue.

### Priority changes
- 🔴 P1: Skeleton screen — same as Customer + Estimate detail

---

## 12 — Schedule
**Overall:** The most architecturally sophisticated screen — 3-column calendar layout with drag-and-drop affordances. The structure is excellent but the empty calendar feels like a void.

### What works
- The 3-panel layout (unassigned jobs | calendar | legend+shortcuts) is exactly right for a dispatch tool — Linear-level information architecture
- "Drag to calendar or click to assign" instruction text is clear and onboarding-friendly
- The LEGEND panel (Scheduled/In Progress/Walkthrough/Urgent/Conflict) with colored dots is well-executed
- SHORTCUTS panel is a power-user feature that telegraphs "this is a serious tool"
- Standard / By Technician view toggle is well-placed
- The keyboard shortcut displayed alongside the Search action (`⌘K`) is excellent UX polish

### What to improve
- **Page Title:** The header shows "ALPHA CRM" as the page title instead of "Schedule". This is a bug — the `<Header>` component isn't receiving the page title from this page. → Fix: SchedulePage should set its title via whatever mechanism other pages use (likely the breadcrumb/header title prop).
- **Empty State (Calendar):** The 7-column week grid is completely empty. The unassigned jobs panel has 1 job (JOB-2026-0004) but the calendar shows nothing because that job has no scheduled time (or is on a different week). This empty calendar looks abandoned rather than "no events scheduled". → Add a subtle empty state in the calendar area: "No jobs scheduled this week — drag from the panel on the left to schedule." in the center of the grid area.
- **Color System:** The calendar time axis (6AM to 8PM labels) uses the default `react-big-calendar` style — small, gray, potentially a system font. → Ensure all calendar text uses Inter, matches the design system font and color tokens.
- **Color System:** The calendar grid lines are very subtle (light gray) which is actually correct for density. But the "current time" indicator (the thin blue horizontal line at 12PM) appears barely visible. → Make the current-time line more prominent: `border-primary border-t-2` with a small circle dot at the left edge.
- **Component Craftsmanship:** The unassigned job card (JOB-2026-0004) in the left panel looks like a simple text card with no elevation or hover state. → Give it a `cursor-grab` pointer, a subtle `hover:shadow-md hover:border-primary/50` state, and a drag handle icon to make it feel physically draggable.
- **Motion:** Drag-and-drop on a calendar needs satisfying feedback — the event should follow the cursor smoothly, drop targets should highlight in blue, and a brief spring animation on drop would make the interaction feel premium.

### Priority changes
- 🔴 P1: Fix page title — header should say "Schedule" not "ALPHA CRM"
- 🔴 P1: Add empty-state guidance text in the calendar grid when no events are visible
- 🟡 P2: Style the unassigned job cards with `cursor-grab` + `hover:shadow-md hover:border-primary/50`
- 🔵 P3: More prominent current-time indicator

---

## 13 — Price Book
**Overall:** Functional and consistent with other list pages — no major design problems but no distinctive moments either.

### What works
- KPI strip (4 cells: Total Items, Services, Materials, Categories) gives quick inventory snapshot
- The item thumbnail in the table row (small square image/icon) is a unique visual feature no competitor has
- "Material" badge in amber and "Active" badge in green are correctly semantic
- Items/Categories tab switcher is clean

### What to improve
- **Brand Identity:** The header shows "ALPHA CRM" as the page title instead of "Price Book" — same bug as Schedule page.
- **Component Craftsmanship:** The thumbnail placeholder (gray square with a door outline) looks like a broken image / default icon. The thumbnail at table row height is very small and the icon detail is lost. → Either use a more clearly styled placeholder (`bg-muted rounded-md flex items-center justify-center text-muted-foreground`) or simply omit it from the item-list view (show in detail/edit only).
- **Color System:** The "Add Item" CTA is again black/dark — not primary blue. Same system-wide inconsistency.
- **Spatial System:** There's a lot of empty space below the single "Door" row. With sparse data the page looks unfinished. → The table body's empty state (when there are items but the list is short) doesn't need fixing — it's data-driven. But the bottom half of the page being empty makes the KPI strip and single row look orphaned. This is a real-world concern for new accounts.
- **Empty States:** "Categories" tab likely shows 0 categories — that tab's empty state should have a designed prompt ("No categories yet — add one to organize your price book items").

### Priority changes
- 🔴 P1: Fix page title (both Schedule and Price Book use "ALPHA CRM" — this is a routing/title bug affecting multiple pages)
- 🔴 P1: Unify primary CTA to blue (this is the 4th screen with a black "+ Add" button)
- 🟡 P2: Improve the thumbnail placeholder to be more intentional
- 🔵 P3: Design an empty state for Categories tab

---

## Cross-Cutting Observations

### System-Wide Issues (highest priority)

**1. The Black CTA Problem**
Multiple pages use `bg-black` or very dark navy for the primary CTA button:
- Customers: "+ Add Customer" = black
- Estimates: "+ New Estimate" = dark
- Jobs: "+ New Urgent Job" = black (intentional for urgency)
- Price Book: "+ Add Item" = black

Only the Leads page uses the correct `bg-primary` blue for "+ New Lead".

This inconsistency is the #1 craftsmanship signal. A user switching between pages has no consistent visual anchor for "the action button." Fix: standardize all list-page primary CTAs to `variant="default"` (primary blue). Keep "+ New Urgent Job" in black/red as a deliberate exception.

**2. Detail Page Loading States**
Customer Detail, Estimate Detail, and Job Detail all captured as bare spinners. The loading state is a single `C`-arc spinner on an empty gray-blue void. At 1440×900 this is visually painful. Skeleton screens would cost ~30-50 lines per page and produce an immediate perceived-performance improvement.

**3. Page Title Bug on Schedule and Price Book**
Both show "ALPHA CRM" as the `<Header>` title. This reads as a placeholder that was never replaced. These should show "Schedule" and "Price Book" respectively.

**4. Dashboard is a Stub**
The most-seen page in the app is essentially a debug readout ("Welcome, System Admin / Role: ADMIN"). This will fail every demo and every new-user impression. Even a minimal real dashboard (today's jobs strip + pipeline KPIs) would transform the product's perceived completeness.

**5. Typography Hierarchy — KPI Numbers**
All KPI strips across all pages use the same text size for the count number and the supporting detail text. The count (the thing that matters) should be visually larger (`text-2xl` or `text-3xl`) while the label and period text should be lighter and smaller (`text-xs text-muted-foreground`). Currently the visual relationship is too flat.

---

## Top 5 Design Investments
(Ranked by perceived quality improvement per engineering hour)

### 🥇 #1 — Skeleton Loading Screens for All Detail Pages
**Impact:** Every detail page navigation currently shows an empty void. Skeleton screens match the actual content layout and make the app feel fast even when it isn't.
**Effort:** ~2 hours (one skeleton component per detail page — Customer, Estimate, Job)
**Result:** Eliminates the most jarring moment in the app's core workflows.

### 🥈 #2 — Unify Primary CTA Button Color to `bg-primary`
**Impact:** Right now a user switching between Customers, Estimates, and Jobs sees 3 different primary button colors. This single change makes the app feel like a designed product rather than a collection of pages.
**Effort:** ~20 minutes (find all `className` on primary CTA buttons and normalize to `variant="default"`)
**Result:** Immediate design coherence across every list page.

### 🥉 #3 — Build a Real Dashboard (even minimal)
**Impact:** The dashboard is the first screen after login, seen multiple times per day by every user. A minimal real implementation (today's jobs timeline, pipeline funnel counts, revenue MTD) turns "prototype" into "product."
**Effort:** ~1 day (Step 9 accelerated — pull from existing APIs, 4 KPI cards + jobs-today list)
**Result:** Removes the #1 "this isn't finished" signal from the app.

### #4 — KPI Number Typography Upgrade
**Impact:** Every list and detail page has a KPI strip. Making the count number 3× larger than its supporting label creates immediate visual impact on the most important data in the app.
**Effort:** ~30 minutes (update KPI strip component(s) — increase count to `text-3xl font-bold tabular-nums`, drop label to `text-xs`)
**Result:** Every KPI strip looks like a Stripe or Vercel dashboard stat, not a data label.

### #5 — Login Page Brand Moment
**Impact:** First impression, demo starting point, and the most photographed/screenshotted page in any SaaS product.
**Effort:** ~2 hours (left panel with brand color + tagline + geometric pattern or illustration; form on right with slightly elevated card)
**Result:** The app stops looking like a shadcn template and starts looking like a product that was designed.

---

## Final Verdict

**Where it sits:** Solidly between "functional prototype" and "beta-ready product". The structure, information architecture, and data density decisions are all right — these are hard to get right and ALPHA CRM gets them right. The list pages (especially Leads and Customers) already feel close to ship-ready.

**What holds it back from "designed product":** Three categories of issue:
1. *Finishing bugs* — black CTAs, wrong page titles, bare spinners — these read as incomplete regardless of how good the underlying architecture is
2. *Missing depth* — typography hierarchy, color semantics, loading states — 1-2 engineer-days to fix, 10× the visual payoff
3. *Empty screens* — the dashboard stub and bare error states signal to anyone evaluating the product that it isn't finished

**The opportunity:** Every FSM competitor (ServiceTitan, Jobber, Housecall Pro) has dated UI that was built in 2015-2018 and never fully modernized. ALPHA CRM already has cleaner structural bones than any of them. Close the finishing gaps and this product looks unmistakably modern — the kind of CRM a contractor shows their spouse and says "look at this, it actually looks good."

**Strongest existing design moment:** The Customers list with colored avatar initials + source badges. It's warm, human, and scan-friendly in a way that feels intentional.

**Biggest cheapness signal:** The bare spinner loading state on detail pages. It makes the app feel slow and unfinished simultaneously.
