# ALPHA CRM Design System

> Indigo-on-slate design language, adapted for a data-dense Field Service Management CRM.
> Used 8+ hours/day by dispatchers, technicians, and admins — every decision prioritizes clarity and density over decoration.
>
> _(Migration note: ALPHA previously used a monochrome charcoal `#242424` chrome. That system is retired — the brand chrome is now indigo-600. Do not reintroduce charcoal anywhere in the chrome.)_

---

## 1. Visual Theme & Atmosphere

ALPHA CRM uses **indigo brand chrome on slate neutrals**. The chrome carries the brand in indigo-600; the surrounding surfaces stay slate and white — confident, modern, distraction-free. Color carries brand identity in the chrome AND meaning in status: status badges and semantic feedback states use their own immutable hues, distinct from the indigo brand.

The aesthetic is built on three principles:
- **Data first** — UI chrome should disappear; the data should read clearly
- **Semantic color, distinct from brand** — status color earns its place by communicating state, never overlapping the indigo chrome hue
- **Confident indigo chrome** — boldness through a single decisive brand color plus contrast, weight, and shadow

**Key characteristics:**
- Indigo (#4f46e5) for all brand chrome (nav, buttons, active states)
- Slate-50 (#f8fafc) page backgrounds — cool neutral
- Pure white (#ffffff) cards and surfaces
- Multi-layer shadow system (ring + contact + diffused) for card depth
- Inter font only — no display fonts; data density requires reliable body legibility
- Status colors (blue/green/amber/red) used exclusively for semantic meaning, kept distinct from the indigo brand

---

## 2. Color Palette & Roles

### Primary (Brand Chrome)
| Token | Hex | Role |
|-------|-----|------|
| `primary` | `#4f46e5` | CTAs, active nav, buttons, active states (indigo-600) |
| `primary-dark` | `#4338ca` | Hover on primary elements (indigo-700) |
| `primary-light` | `#6366f1` | Lighter accent, secondary interactive elements (indigo-500) |
| `primary-subtle` | `#eef2ff` | Active-nav tint, hover backgrounds, subtle highlights (indigo-50) |

### Neutral Base
| Token | Hex | Role |
|-------|-----|------|
| `background-light` | `#f8fafc` | App canvas — cool slate neutral (slate-50) |
| `surface-light` | `#ffffff` | Cards, panels, inputs, modals |
| `text-primary` / `text-text-primary` | `#0f172a` | Headings, primary body text, labels (slate-900) |
| `text-secondary` / `text-text-secondary` | `#475569` | Secondary labels, muted text, metadata (slate-600) |
| `border` | `#e2e8f0` | Dividers, input borders, table gridlines (slate-200) |

> **Why `#475569` for secondary text:** secondary/muted text must clear WCAG AA. `#475569` (slate-600) on white achieves ~7.5:1 (AA/AAA) — comfortably passes. Never use a lighter gray that fails AA contrast.

### Semantic (Status & Feedback)
| Token | Hex | Role |
|-------|-----|------|
| `success` | `#10B981` | Completed, paid, won states |
| `danger` | `#EF4444` | Error, destructive actions, overdue, lost |
| `warning` | `#F59E0B` | Unassigned, pending, expiring, partial |
| `info` | `#3B82F6` | Scheduled, sent, in-progress indicators |

### Status Badge Palette (do not change)
Status badges use explicit Tailwind color classes, not brand tokens, so they remain stable regardless of brand color changes:
- `bg-blue-50 text-blue-700 border-blue-200` — SCHEDULED, SENT, IN_PROGRESS
- `bg-emerald-50 text-emerald-700 border-emerald-200` — WON, COMPLETED
- `bg-warning/10 text-warning border-warning/20` — UNASSIGNED, PENDING, EXPIRED
- `bg-danger/10 text-danger border-danger/20` — LOST, DECLINED, OVERDUE
- `bg-gray-100 text-gray-600 border-gray-200` — DRAFT, CANCELLED, VOIDED

> **Indigo is a brand hue, not a status hue.** The `ESTIMATED` lead badge and the `Facebook` ad-source badge formerly used `indigo-50/700`, which now collides with the indigo brand chrome — they are remapped to a distinct hue (`sky-50/700`) in `status-badge.tsx` and the ad-source maps. Do not list indigo as a status color in this palette.

---

## 3. Typography Rules

### Font Family
- **All text:** `Inter` — the single font for the entire application
- **Fallback:** `system-ui, sans-serif`
- No display fonts. No Cal Sans. Inter handles all sizes from 10px table metadata to 32px KPI values.

### Hierarchy

| Role | Size | Weight | Line Height | Usage |
|------|------|--------|-------------|-------|
| Page heading | 20-24px | 600 | 1.25 | Page `<h1>`, section titles |
| KPI value | 28-32px | 700 | 1.0 | KPI strip numbers |
| Card title | 16px | 600 | 1.25 | Card headers, dialog titles |
| Body / table | 14px | 400-500 | 1.5 | Table cells, form labels, body text |
| Secondary / muted | 12-13px | 400 | 1.4 | Metadata, timestamps, helper text |
| Badge / chip | 11-12px | 500-600 | 1.0 | Status badges, filter chips |

### Principles
- Weight 600-700 for headings and KPI values — conveys authority without a display font
- Weight 400-500 for all body and table text — maximize readability at density
- Never go below 12px for interactive elements (accessibility)
- `tabular-nums` for all numeric data in tables and KPI values

---

## 4. Component Stylings

### Buttons
- **Primary CTA:** `bg-primary text-white hover:bg-primary/90 rounded-lg` — indigo with white text
- **Ghost/outline:** shadcn neutral variants (slate surfaces) — already neutral
- **Destructive:** `bg-danger text-white hover:bg-danger/90` — explicit red
- **Pill badges:** `rounded-pill` (9999px) — for status chips and filter counts
- **Filter count badge:** `bg-primary text-white text-[10px] font-semibold rounded-full px-1.5 py-0.5`

### Cards & Containers
- **Standard card:** `bg-white rounded-xl p-6 shadow-card border border-border`
- **Card shadow:** Cal.com 3-layer system — ring (hairline) + contact + diffused
  ```
  rgba(19,19,22,0.7) 0px 1px 5px -4px,
  rgba(34,42,53,0.08) 0px 0px 0px 1px,
  rgba(34,42,53,0.05) 0px 4px 8px 0px
  ```
- **Hover elevation:** Same as card but with deeper diffused layer (`shadow-hover`)
- **Inset/pressed:** `shadow-inset` — `rgba(0,0,0,0.16) 0px 1px 1.9px 0px inset`

### Inputs & Forms
- **Border:** `border border-border` (`#e2e8f0`)
- **Focus:** `focus:border-primary focus:ring-2 focus:ring-primary/20` — indigo tint ring
- **Radius:** `rounded-md` (6px) for inputs, `rounded-xl` (12px) for cards
- **Error:** `border-danger focus:ring-danger/20`

### Navigation
- **Sidebar width:** 240px (`w-sidebar`), white background, right-side shadow
- **Active nav item:** `bg-primary-subtle text-primary font-medium` — indigo-50 tint, indigo text/icon
- **Inactive nav item:** `text-text-secondary hover:bg-background-light hover:text-text-primary`
- **Header height:** 56px (`h-header`), white with bottom border
- **Create button:** `bg-primary text-white hover:bg-primary/90` — indigo CTA

### Data Tables
- **Header:** `bg-slate-50` — very light slate, distinct from white
- **Sort icons (active):** `text-primary` — indigo
- **Resize handle:** `after:bg-primary` — indigo
- **Row hover:** `hover:bg-background-light/50`
- **Sticky header:** Uses shadow to indicate scroll position

### Tab Navigation
- **Active tab text:** `data-[state=active]:text-primary` — indigo
- **Active underline:** `group-data-[state=active]:after:bg-primary` — indigo bar
- **Inactive:** `text-text-secondary hover:text-text-primary`

---

## 5. Layout Principles

### Spacing System (CRM-density — not marketing-page)
- **Content padding:** `p-4` — consistent across all pages, no max-width
- **Card internal:** `p-6` for standard cards, `p-4` for compact ones
- **Section gaps:** 16-24px between major page sections (`gap-4` to `gap-6`)
- **KPI strip:** `divide-x`, single card with inline cells — no inter-cell gaps

> **Critical CRM constraint:** Cal.com uses 80-96px section spacing for marketing. ALPHA CRM uses 16-24px. Dispatchers need to see 15-20 table rows without scrolling, not whitespace.

### Grid & Containers
- **No max-width:** Content fills available space (`w-full`) — works on all screen sizes
- **Detail pages:** Breadcrumbs → Hero card → Sidebar+tabs merged card (below)
- **List pages:** KPI strip → Filter bar → DataTable

### Fixed Chrome
- **Sidebar:** 240px fixed left, `inset-y-0`
- **Header:** 56px fixed top, full-width minus sidebar
- **Content:** `ml-sidebar mt-header overflow-auto h-screen`

---

## 6. Depth & Elevation

| Level | Shadow | Use |
|-------|--------|-----|
| Flat | none | Page canvas, plain text areas |
| Inset | `shadow-inset` | Pressed states, input wells |
| Card | `shadow-card` | All cards, panels, dialogs |
| Hover | `shadow-hover` | Cards on hover, dropdowns |

### Shadow Philosophy
Three-layer compositing (from Cal.com):
1. **Contact shadow** — `0px 1px 5px -4px` at 70% opacity: tight bottom edge grounding
2. **Ring border** — `0px 0px 0px 1px` at 8% opacity: hairline containment without CSS border width
3. **Diffused shadow** — `0px 4px 8px 0px` at 5% opacity: gentle ambient depth

Cards typically use both `shadow-card` AND `border border-border`. The ring shadow (8% opacity) stacks with the CSS border subtly — this is intentional and adds refinement.

---

## 7. Do's and Don'ts

### Do
- Use indigo `#4f46e5` for all brand chrome (buttons, active nav, primary actions)
- Use `#475569` (slate-600) for secondary/muted text — it clears WCAG AA (~7.5:1)
- Use the 3-layer shadow system for all cards
- Use semantic status colors for status badges — they are immutable indicators, kept distinct from the indigo brand
- Keep `bg-background-light` (`#f8fafc`, slate-50) for page backgrounds — cool neutral
- Use Inter weight 600-700 for headings/KPIs, 400-500 for body/tables
- Use `tabular-nums` for all numeric columns in tables

### Don't
- Don't reintroduce charcoal `#242424` anywhere in the chrome — the brand is indigo
- Don't use `bg-primary` for semantic indicators (progress bars, status badges) — use `bg-info`, `bg-success`, etc.
- Don't use indigo for a status hue — it collides with the brand chrome (use sky for the estimate-sent / Facebook cases)
- Don't use a secondary text color lighter than slate-600 — lighter grays fail WCAG AA contrast
- Don't add gradient backgrounds to data pages — reserve for login/marketing panels only
- Don't increase spacing beyond `gap-6` between content sections — maintain CRM density
- Don't introduce new font families — Inter handles everything needed

---

## 8. Responsive Behavior

### Breakpoints
| Breakpoint | Key changes |
|------------|-------------|
| `< lg` (1024px) | Sidebar hidden, hamburger menu, header adapts |
| `lg+` | Full sidebar + header layout |
| `< md` (768px) | Tables may scroll horizontally, some columns hidden |

### Sidebar
- `lg+`: Fixed 240px sidebar, always visible
- `< lg`: Hidden, triggered by hamburger button in header
- Collapsible to 64px icon-only mode via toggle button

### Tables
- Columns use `hidden md:table-cell` or `hidden lg:table-cell` for responsive visibility
- No horizontal page scroll — tables scroll within their container

### Touch Targets
- All interactive elements minimum 44x44px
- Sidebar nav items: `py-2.5` with `px-4` — adequate touch area
- Buttons: minimum `h-9` (36px) with `px-4`

---

## 9. Agent Prompt Guide

### Quick Color Reference
```
Primary (chrome):     #4f46e5 — indigo-600
Primary hover:        #4338ca — indigo-700
Primary subtle:       #eef2ff — indigo-50 (active-nav tint)
Text primary:         #0f172a — slate-900
Text secondary:       #475569 — slate-600
Page background:      #f8fafc — slate-50
Card background:      #ffffff — pure white
Border:               #e2e8f0 — slate-200
Success:              #10B981
Danger:               #EF4444
Warning:              #F59E0B
Info:                 #3B82F6
```

### Example Component Prompts

**Standard card:**
```
Create a card with bg-white rounded-xl p-6 shadow-card border border-border.
Use text-text-primary (#0f172a) for headings and text-text-secondary (#475569) for metadata.
```

**Primary CTA button:**
```
bg-primary text-white hover:bg-primary/90 rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors
```

**KPI strip:**
```
Create a single bg-white rounded-xl shadow-card border border-border card with divide-x children.
Each KPI cell: px-6 py-4. Value: text-3xl font-bold text-text-primary tabular-nums.
Label: text-xs text-text-secondary uppercase tracking-wide mt-1.
```

**Status badge:**
```
Use the StatusBadge component from components/ui/status-badge.tsx.
Never manually apply bg-primary to status indicators — use semantic colors.
```

**Data table header:**
```
bg-slate-50 text-xs font-semibold text-text-secondary uppercase tracking-wide.
Sort indicator: text-primary (indigo). Resize handle: after:bg-primary.
```

**Page layout:**
```
Full-height content area: p-4, no max-width.
Breadcrumbs at top, then hero card (shadow-card), then sidebar+tabs merged card below.
KPI strip uses divide-x single card pattern.
```

### Iteration Checklist
When reviewing AI-generated screens with this design system:
1. Verify the chrome is indigo (active nav, buttons, focus outlines should be `#4f46e5`, never charcoal)
2. Check backgrounds are `#f8fafc` (page, slate-50) and `#ffffff` (cards)
3. Confirm semantic colors appear ONLY on status badges, progress indicators, feedback states — and never use indigo (it's the brand hue)
4. Verify card shadows use the 3-layer system, not simple `shadow-sm` or `shadow-md`
5. Check secondary text is `#475569` (slate-600), not lighter grays that fail contrast

---

## CRM Density Adaptations

ALPHA CRM is an operational tool used 8+ hours/day, so it diverges from a typical marketing-page design system on density and accessibility. Key divergences:

| Design Choice | Typical marketing default | ALPHA CRM Adaptation | Reason |
|---------------|-----------------|---------------------|--------|
| Font | Display font + body font | Inter only | A display font is illegible at 12-14px table density |
| Section spacing | 80-96px | 16-24px | 8+ hours/day operational tool needs density, not breathing room |
| Secondary text | Lighter grays (often fail AA) | `#475569` slate-600 (passes AA ~7.5:1) | Accessibility requirement for extended-use software |
| Status colors | Decorative or absent | Full semantic palette, distinct from indigo brand | Dispatchers need instant visual scanning of job/lead/invoice status |
| Page background | Pure white | `#f8fafc` slate-50 | A subtle cool tint on extended use is easier on the eyes than pure white |
| Gradients | Decorative throughout | Login panel only (indigo gradient) | The login page can afford marketing aesthetics; data pages cannot |

---

## 10. Table System Standard

The ALPHA Table Standard governs all `<DataTable>` instances across the app. Every list page (Customers, Leads, Estimates, Jobs, Invoices) uses this system.

### 10.1 Visual Baseline

| Element | Value |
|---------|-------|
| Header background | `bg-slate-50` (`#f8fafc`) |
| Header border / gridlines | `#e2e5e9` |
| Body row gridlines | `#eceef1` |
| Header text | `text-xs font-semibold text-text-secondary uppercase tracking-wide` |
| Cell text | 14px / `text-sm`, weight 400–500 |
| Numeric / date columns | `tabular-nums` — always, no exceptions |
| Empty cell value | Blank (no em-dash, no "—", no "N/A") |
| Date format | Exact: `May 14 2026` — no ordinals, no abbreviations |

### 10.2 Identity Column

- Every table has exactly one identity column (e.g. customer name, lead number).
- The identity column is **locked** — non-hideable via the Columns menu (shown disabled + 🔒).
- It is **left-pinned** (sticky `position: sticky; left: 0`).
- When one or more columns are pinned, the rightmost pinned column carries a **right-edge shadow** to visually separate the pinned zone from scrollable columns.

### 10.3 Flex-Fill & Column Sizing

- **Weighted growable columns** (e.g. name, address) share remaining width via `flex` weights; they grow to fill the container.
- **Fixed-width columns** (e.g. status badge, currency, date) never grow.
- Manual drag-resize marks a column `manuallySized = true` — it exits flex-fill and holds its explicit pixel width.
- **No dead space guarantee:** the flex system ensures the table always fills its container width — no blank gray area to the right of the last column.
- **Resize widens the container:** dragging a column beyond the viewport width causes the table to horizontally scroll (the container, not the page).
- Global minimum column width: **64px**.

### 10.4 Resize Behavior

- Drag handle appears **in the header only** — not on body cells.
- **Double-click** the handle = auto-fit to content width, clamped to `[64px, 600px]`.
- Virtualization note: double-click auto-fit measures the visible window only (TanStack Virtual). Very wide content outside the render window will not widen the column.
- Resize handle styled with `after:bg-primary` (indigo) on hover/active.

### 10.5 Columns Menu

- Trigger: **"⚙ Columns ▾"** button in the table toolbar, right-aligned.
- Rendered as a **portaled popover** (never clipped by table overflow).
- Shows all columns as toggleable checkboxes; locked column shown as disabled with 🔒 icon.
- Three action buttons at the bottom of the popover:
  - **Save current view** — persists column visibility + widths server-side for the current user.
  - **Reset columns** — restores default visibility (does not affect widths).
  - **Reset widths** — restores all columns to their default flex/fixed widths.

### 10.6 Saved Views

- One saved view per user per table, stored server-side.
- Applied on page load (visibility + widths).
- Unsaved changes (toggle/resize) are kept **in-memory only** until the user explicitly clicks "Save current view".
- Navigating away discards unsaved in-memory changes.

### 10.7 Right-Click Header Context Menu

Right-clicking any non-locked header cell shows:
- **Reset this column width** — returns the column to its default width.
- **Reset all widths** — resets every column to defaults (same as the popover action).

### 10.8 Contact Cell Affordances (`ContactCell`)

Used for phone and email columns:
- Renders as a `tel:` or `mailto:` link.
- Shows a **copy ⧉ icon** on hover — copies the value to clipboard.
- Both the link and icon call `stopPropagation()` to prevent triggering the row-click navigation.
- `aria-label` is required on the copy icon (e.g. `aria-label="Copy email"`).
- Touch tap targets must be **≥ 44px** (apply `min-h-[44px]` or `p-2` padding as needed).

### 10.9 Placeholder Hygiene

Import artifacts must never be shown to users. Suppress these values at render time (display blank):

| Pattern | Source | Action |
|---------|--------|--------|
| `*@placeholder.local` | Email | Render blank |
| `bg-import-*` prefix emails | Historical data import | Render blank |
| `bg-import-phone:*` prefix | Historical data import | Render blank |
| `(000) 000-0000` | Default placeholder | Render blank |

### 10.10 Mobile Behavior

- **Resize:** drag handle is replaced with a touch-friendly handle (wider hit target); same double-tap = auto-fit behavior.
- **Right-click context menu:** has no touch equivalent — omit on touch devices. The Columns menu (10.5) is the correct touch path for column management.
- **ContactCell:** tap targets ≥ 44px (see 10.8).
- **Horizontal scroll:** the table container scrolls horizontally on narrow screens; the page itself never scrolls horizontally.
