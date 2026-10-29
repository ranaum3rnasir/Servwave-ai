# ALPHA CRM Dashboard -- Visual Design Specification

> Authoritative visual spec for the dashboard (Step 9A).
> Date: 2026-04-13
> Audience: Frontend implementors. Every class, value, and timing is final.

---

## 1. Visual Hierarchy & Layout Grid

### Page-Level Structure

The dashboard lives inside the standard content area (`ml-sidebar mt-header p-4`). No breadcrumbs -- it is the home screen. The outer wrapper is:

```
<div className="space-y-5">
  {/* Greeting */}
  {/* KPI Strip */}
  {/* Needs Attention */}
  {/* Two-Column: Revenue Chart + Schedule Snapshot */}
  {/* Activity Feed */}
</div>
```

`space-y-5` (20px) between all major sections. This is tighter than the `space-y-6` (24px) used on list pages -- justified because the dashboard packs more sections into the viewport and we need the greeting + KPIs + Needs Attention visible without scrolling on a 1080p monitor.

### Two-Column Zone

The revenue chart and schedule snapshot sit side-by-side:

```
<div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
  <div className="lg:col-span-3"> {/* Revenue Chart -- 60% */} </div>
  <div className="lg:col-span-2"> {/* Schedule Snapshot -- 40% */} </div>
</div>
```

A 5-column grid with 3/2 split produces a 60/40 ratio. Gap is `gap-5` (20px) matching the vertical rhythm. Below `lg` (1024px) both stack vertically.

### Card Standards

All dashboard cards use the existing card pattern without exception:

```
bg-white rounded-xl shadow-card border border-border
```

Internal padding varies by card type:
- KPI strip cells: `px-5 py-4`
- Needs Attention card: `p-0` (items have their own internal padding)
- Chart card: `p-5` (chart needs breathing room from card edge)
- Schedule snapshot: `p-0` (header has its own padding, list items have theirs)
- Activity feed: `p-0` (list items have their own padding)

---

## 2. KPI Strip Design

### Structural Pattern

The dashboard KPI strip follows the exact same pattern as InvoicesPage and CustomersPage. One `Card` with `p-0 overflow-hidden`, containing a grid with `divide-x divide-border`:

```
<Card className="p-0 overflow-hidden">
  <div className="grid grid-cols-2 divide-x divide-border lg:grid-cols-5">
    {/* 5 cells */}
  </div>
</Card>
```

5 cells on desktop (lg+), 2 columns on smaller screens. This is consistent with InvoicesPage's 5-cell strip.

### Cell Internal Layout

Each cell:

```jsx
<div className="flex items-center gap-4 px-5 py-4">
  <Icon className="h-5 w-5 shrink-0 text-gray-400" />
  <div className="min-w-0 flex-1">
    <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">
      {label}
    </p>
    <div className="flex items-baseline gap-2 mt-0.5">
      <p className="text-3xl font-bold tabular-nums text-text-primary">
        {value}
      </p>
      {/* Trend indicator */}
    </div>
  </div>
</div>
```

The value uses `text-3xl font-bold tabular-nums` -- identical to every existing KPI strip. No elevation from the list page pattern. Consistency is more important than novelty.

### Trend Indicator

Placed inline with the value using `items-baseline`:

```jsx
<span className={cn(
  "inline-flex items-center gap-0.5 text-xs font-semibold",
  trend > 0 && "text-emerald-600",
  trend < 0 && "text-red-600",
  trend === 0 && "text-text-secondary"
)}>
  {trend > 0 ? <TrendingUp className="h-3 w-3" /> : 
   trend < 0 ? <TrendingDown className="h-3 w-3" /> : 
   <Minus className="h-3 w-3" />}
  {Math.abs(trend)}%
</span>
```

- **Good trends** (revenue up, leads up): `text-emerald-600`
- **Bad trends** (overdue up, conversion down): `text-red-600` -- the color flips based on semantic meaning, not direction. Revenue going down is red. Overdue going down is green.
- **Flat**: `text-text-secondary` with a horizontal `Minus` icon
- Font: `text-xs font-semibold` (12px, 600 weight)
- Arrow icon: `h-3 w-3` (12x12px) -- small enough to be subordinate to the value

### "Bad" Values

Certain KPIs use semantic coloring on the value itself when the count is non-zero:
- **Overdue invoices** (count or amount): `text-red-600` when > 0, `text-text-primary` when 0
- **Unassigned jobs**: `text-amber-600` when > 0
- This exactly matches InvoicesPage's treatment of overdue amounts in `text-red-600`

### Hover & Click

Each KPI cell is wrapped in a clickable container:

```jsx
<button
  onClick={() => navigate(targetUrl)}
  className="flex items-center gap-4 px-5 py-4 w-full text-left 
             transition-colors hover:bg-primary-subtle/50 
             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
>
```

Hover: `bg-primary-subtle/50` (`#f5f5f5` at 50% opacity) -- barely visible warmth, consistent with table row hover. No elevation change on hover -- this is a strip cell, not a standalone card.

### Loading State

Each cell shows the existing skeleton pattern:

```jsx
<div className="mt-1 h-7 w-20 animate-pulse rounded bg-background-light" />
```

`h-7` (28px) to match the `text-3xl` line height. `w-20` for currency values, `w-12` for counts.

---

## 3. "Needs Attention" Card

### Card Shell

```jsx
<Card className="p-0 overflow-hidden">
  <div className="flex items-center justify-between px-5 py-3 border-b border-border">
    <h2 className="text-sm font-semibold text-text-primary">Needs Attention</h2>
    <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700 tabular-nums">
      {totalCount}
    </span>
  </div>
  <div className="divide-y divide-border">
    {/* items */}
  </div>
</Card>
```

The card header uses `text-sm font-semibold` (14px, 600 weight) -- same as card titles throughout the app. The count badge uses `bg-red-50 text-red-700` -- danger-family colors, but softened with the 50-shade background.

### Individual Item Row

```jsx
<button
  onClick={() => navigate(targetUrl)}
  className="flex items-center gap-3 px-5 py-3 w-full text-left 
             transition-colors hover:bg-background-light/50 group"
>
  {/* Left accent */}
  <div className={cn(
    "w-1 self-stretch rounded-full shrink-0",
    urgency === 'critical' && "bg-red-500",
    urgency === 'warning'  && "bg-amber-400",
    urgency === 'info'     && "bg-blue-400"
  )} />
  
  {/* Icon */}
  <div className={cn(
    "flex items-center justify-center h-8 w-8 rounded-lg shrink-0",
    urgency === 'critical' && "bg-red-50 text-red-600",
    urgency === 'warning'  && "bg-amber-50 text-amber-600",
    urgency === 'info'     && "bg-blue-50 text-blue-600"
  )}>
    <CategoryIcon className="h-4 w-4" />
  </div>
  
  {/* Text */}
  <div className="flex-1 min-w-0">
    <p className="text-sm font-medium text-text-primary truncate">
      {/* e.g., "3 overdue invoices" */}
    </p>
    <p className="text-xs text-text-secondary truncate">
      {/* e.g., "$4,200 total outstanding" */}
    </p>
  </div>
  
  {/* Chevron */}
  <ChevronRight className="h-4 w-4 text-text-secondary shrink-0 
                           opacity-0 group-hover:opacity-100 transition-opacity" />
</button>
```

### Urgency Levels & Color Mapping

| Level | Left Accent | Icon Background | Icon Color | Trigger Examples |
|-------|------------|-----------------|------------|------------------|
| `critical` | `bg-red-500` | `bg-red-50` | `text-red-600` | Overdue invoices (30+ days), jobs past deadline |
| `warning` | `bg-amber-400` | `bg-amber-50` | `text-amber-600` | Unassigned jobs, stale leads (24h+), expiring estimates |
| `info` | `bg-blue-400` | `bg-blue-50` | `text-blue-600` | Uncollected deposits, pending estimates |

The left accent bar is `w-1` (4px), `self-stretch`, `rounded-full` -- a thin vertical pill that acts as a severity indicator without dominating the row. This approach echoes how many CRM tools and notification trays communicate severity: a quiet but unmistakable color strip.

### Empty State

```jsx
<div className="flex flex-col items-center justify-center py-8 px-5">
  <CheckCircle2 className="h-8 w-8 text-emerald-400 mb-2" />
  <p className="text-sm font-medium text-text-primary">All clear</p>
  <p className="text-xs text-text-secondary mt-0.5">Nothing needs attention right now</p>
</div>
```

Celebratory but restrained. The green check icon provides positive reinforcement. No emoji, no confetti.

### Overflow Treatment

Show a maximum of 6 items. If more exist:

```jsx
<div className="px-5 py-2.5 text-center border-t border-border">
  <button className="text-xs font-medium text-primary hover:underline">
    View {remainingCount} more items
  </button>
</div>
```

This navigates to a dedicated "attention items" view or expands the list inline (implementation decision, not a visual spec concern).

### Standing Out Without Alarming

The card uses the standard `shadow-card border border-border` -- no special border color, no red outline, no alarming background. The severity is communicated entirely through the internal left accent bars and icon backgrounds. When there are critical items, the aggregate count badge in the header (`bg-red-50 text-red-700`) provides a gentle alert. When there are no items, the card is the calmest element on the page.

---

## 4. Revenue Chart Styling

### Chart Type

**Vertical bar chart** with rounded top corners. Bars over lines because:
- Bars communicate discrete time buckets (days/weeks) more intuitively
- They fill the card with visual weight -- important for the dashboard's centerpiece chart
- Our monochrome palette benefits from solid fills rather than thin lines

### Chart Card Structure

```jsx
<Card className="p-5">
  <div className="flex items-center justify-between mb-4">
    <h2 className="text-sm font-semibold text-text-primary">Revenue</h2>
    <div className="flex items-center gap-1">
      {/* Period selector: 7D | 30D | 90D */}
      {periods.map(p => (
        <button className={cn(
          "px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
          active === p 
            ? "bg-primary text-white" 
            : "text-text-secondary hover:bg-background-light hover:text-text-primary"
        )}>
          {p}
        </button>
      ))}
    </div>
  </div>
  <div className="h-52">
    {/* Chart rendered here */}
  </div>
</Card>
```

Chart container height: `h-52` (208px). This is sufficient for a clear bar chart while leaving room for the schedule card beside it. The period selector uses pill-style buttons with `bg-primary text-white` for the active state -- consistent with how tab-style toggles work across the app.

### Bar Colors

Primary bar color: `#242424` (primary charcoal) at 85% opacity -- `rgba(36, 36, 36, 0.85)`. This maintains the monochrome identity while allowing subtle visual separation from the card background. On hover, bars transition to full opacity `#242424`.

If a target/comparison line is shown, it uses `#e5e7eb` (border gray) as a dashed line -- `strokeDasharray: "6 4"`, `strokeWidth: 1.5`.

### Axis & Grid Styling

- **Y-axis labels**: `text-[11px] text-text-secondary tabular-nums fill-[#6b7280]` -- using the standard secondary text color
- **X-axis labels**: `text-[11px] text-text-secondary fill-[#6b7280]`
- **Horizontal grid lines**: `stroke: #f0f0f0`, `strokeWidth: 1` -- lighter than the border color so they recede behind bars
- **No vertical grid lines** -- clean, uncluttered
- **No chart border/outline** -- the card provides containment

### Tooltip

```jsx
<div className="bg-primary text-white rounded-lg px-3 py-2 shadow-hover text-xs">
  <p className="font-semibold">{formattedDate}</p>
  <p className="tabular-nums mt-0.5">{formatCurrency(value)}</p>
</div>
```

Dark tooltip (`bg-primary text-white`) with `shadow-hover` elevation. `rounded-lg` (8px). This inverts the normal card-on-white pattern and creates clear visual separation. The tooltip follows the cursor with a `12px` vertical offset.

### Introducing Color Without Breaking Monochrome

The revenue chart is intentionally monochrome. Charcoal bars on a white background. This is a deliberate design choice: the dashboard's "data visualization color" IS the primary brand color. When future charts need multiple series (e.g., pipeline funnel, AR aging breakdown), use this progression:

| Series | Color | Hex | Tailwind |
|--------|-------|-----|----------|
| Primary | Charcoal 100% | `#242424` | `primary` |
| Secondary | Charcoal 50% | `#919191` | `primary-light` at 70% opacity |
| Tertiary | Charcoal 25% | `#c8c8c8` | `secondary-dark` |
| Quaternary | Border gray | `#e5e7eb` | `border` |

This 4-step monochrome gradient keeps charts on-brand. Semantic colors (green/red/amber/blue) are reserved exclusively for status-bearing data: AR aging buckets use `text-red-600` for 90+ days, `text-amber-600` for 60+ days, etc. Charts that display categorical data (like lead sources or job types) may use the existing status badge color families as fills.

---

## 5. Today's Schedule Snapshot

### Visual Format

A compact list grouped by technician, not a timeline. Timelines waste horizontal space and are hard to read in a narrow 40% column. A grouped list is denser and more scannable.

### Card Structure

```jsx
<Card className="p-0 overflow-hidden flex flex-col" style={{ maxHeight: '340px' }}>
  <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
    <h2 className="text-sm font-semibold text-text-primary">Today's Schedule</h2>
    <button 
      onClick={() => navigate('/schedule')}
      className="text-xs font-medium text-primary hover:underline"
    >
      View full schedule
    </button>
  </div>
  <div className="overflow-y-auto flex-1 divide-y divide-border">
    {/* Technician groups */}
  </div>
</Card>
```

Max height matches the revenue chart card beside it. Internal scrolling if content overflows.

### Technician Group

```jsx
<div>
  <div className="flex items-center gap-2 px-5 py-2 bg-slate-50/70">
    <Avatar className="h-5 w-5">
      <AvatarFallback className="bg-primary text-white text-[10px] font-semibold">
        {initials}
      </AvatarFallback>
    </Avatar>
    <span className="text-xs font-semibold text-text-primary">{techName}</span>
    <span className="text-[10px] text-text-secondary ml-auto tabular-nums">
      {jobCount} jobs
    </span>
  </div>
  {/* Job items */}
</div>
```

The technician header uses `bg-slate-50/70` -- the same background as table headers, maintaining visual consistency but slightly transparent to feel lighter.

### Job Item

```jsx
<div className="flex items-center gap-3 px-5 py-2.5 hover:bg-background-light/50 cursor-pointer">
  <span className="text-xs tabular-nums text-text-secondary w-14 shrink-0">
    {startTime}
  </span>
  <div className={cn(
    "w-1.5 h-1.5 rounded-full shrink-0",
    status === 'COMPLETED'   && "bg-emerald-500",
    status === 'IN_PROGRESS' && "bg-blue-500",
    status === 'SCHEDULED'   && "bg-gray-300",
  )} />
  <div className="flex-1 min-w-0">
    <p className="text-sm text-text-primary truncate">{customerName}</p>
  </div>
  <span className="text-[10px] text-text-secondary shrink-0">{jobNumber}</span>
</div>
```

The status dot is `w-1.5 h-1.5 rounded-full` -- 6x6px, a minimal indicator:
- `bg-emerald-500` for COMPLETED
- `bg-blue-500` for IN_PROGRESS  
- `bg-gray-300` for SCHEDULED (not yet started)
- `bg-amber-500` for UNASSIGNED (should not appear here, but fallback)

Time is fixed-width (`w-14`) to create a clean visual column.

---

## 6. Activity Feed Design

### Card Structure

```jsx
<Card className="p-0 overflow-hidden">
  <div className="flex items-center justify-between px-5 py-3 border-b border-border">
    <h2 className="text-sm font-semibold text-text-primary">Recent Activity</h2>
  </div>
  <div className="divide-y divide-border">
    {/* 5-7 items */}
  </div>
</Card>
```

### Item Layout

```jsx
<div className="flex items-start gap-3 px-5 py-3">
  <div className={cn(
    "flex items-center justify-center h-7 w-7 rounded-full shrink-0 mt-0.5",
    typeStyles[event.type].bg
  )}>
    <EventIcon className="h-3.5 w-3.5" style={{ color: typeStyles[event.type].iconColor }} />
  </div>
  <div className="flex-1 min-w-0">
    <p className="text-sm text-text-primary">
      <span className="font-medium">{event.actor}</span>
      {' '}{event.description}
    </p>
    <p className="text-xs text-text-secondary mt-0.5">{relativeTime}</p>
  </div>
</div>
```

### Event Type Styling

| Event Type | Icon | Circle BG | Icon Color |
|-----------|------|-----------|------------|
| Payment received | `DollarSign` | `bg-emerald-50` | `#059669` (emerald-600) |
| Invoice sent | `Send` | `bg-blue-50` | `#2563eb` (blue-600) |
| Estimate approved | `CheckCircle2` | `bg-emerald-50` | `#059669` |
| Job completed | `Wrench` | `bg-emerald-50` | `#059669` |
| Lead created | `UserPlus` | `bg-blue-50` | `#2563eb` |
| Job assigned | `Calendar` | `bg-blue-50` | `#2563eb` |
| Estimate declined | `XCircle` | `bg-red-50` | `#dc2626` (red-600) |
| Invoice overdue | `AlertTriangle` | `bg-red-50` | `#dc2626` |

The icon circle is `h-7 w-7 rounded-full` (28px diameter). Larger than status dots, smaller than avatar circles. The circle background uses the `-50` shade of the semantic color family.

### Typography Density

- Actor name: `font-medium` (500 weight) -- visually anchors the line
- Action text: normal weight (400) -- subordinate
- Timestamp: `text-xs text-text-secondary` -- minimally visible
- `mt-0.5` gap between text and timestamp

### New Item Animation

When the feed refreshes and a new item appears at the top:

```css
@keyframes feed-slide-in {
  from { opacity: 0; transform: translateY(-8px); }
  to   { opacity: 1; transform: translateY(0); }
}
.feed-item-new {
  animation: feed-slide-in 300ms ease-out;
}
```

Duration: 300ms. Easing: `ease-out`. Only the newest item animates -- not the entire list. This is subtle enough to draw attention without being distracting during an 8-hour workday.

---

## 7. Greeting / Header Area

### Layout

```jsx
<div className="flex items-baseline justify-between">
  <div>
    <h1 className="text-xl font-semibold text-text-primary">
      {greeting}, {firstName}
    </h1>
    <p className="text-sm text-text-secondary mt-0.5">
      {dayOfWeek}, {formattedDate} -- Here's your shop today.
    </p>
  </div>
  {/* Optional: quick action button for Admin/Dispatcher */}
</div>
```

### Typography

- Greeting: `text-xl font-semibold text-text-primary` (20px, 600 weight) -- same size as every other page heading (InvoicesPage, CustomersPage all use `text-xl font-semibold`)
- Subtitle: `text-sm text-text-secondary` (14px, 400 weight)

### Greeting Logic

| Hour Range | Greeting |
|-----------|---------|
| 5:00 - 11:59 | Good morning |
| 12:00 - 16:59 | Good afternoon |
| 17:00 - 4:59 | Good evening |

### Date Format

`"Monday, April 14"` -- spelled-out day of week, spelled-out month, numeric day. No year (the dashboard is always about today). Rendered via `toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })`.

### Warmth Without Cheese

The greeting uses the first name only, not "Welcome back!" or motivational quotes. The subtitle "Here's your shop today." is conversational but professional -- it frames the dashboard as a briefing, not a celebration. The period at the end conveys matter-of-factness.

---

## 8. Color Usage Summary

### The Monochrome Rule

The dashboard follows the same monochrome-with-semantic-accents philosophy as every other page. No new colors are introduced. Every color used on the dashboard already exists in the design system or in the status-badge component.

### Color Budget

| Element | Colors Used | Source |
|---------|------------|--------|
| Page chrome, text, borders | `#242424`, `#6b7280`, `#e5e7eb`, `#fafafa`, `#ffffff` | Existing palette |
| KPI trend arrows | `emerald-600`, `red-600`, `text-secondary` | Semantic: good/bad/neutral |
| Chart bars | `#242424` at 85% opacity | Primary brand |
| Needs Attention accents | `red-500`, `amber-400`, `blue-400` | Semantic severity |
| Schedule status dots | `emerald-500`, `blue-500`, `gray-300` | Existing status colors |
| Activity feed icons | `emerald-50/600`, `blue-50/600`, `red-50/600` | Existing status families |
| Bad-value KPIs | `red-600`, `amber-600` | Existing pattern (InvoicesPage) |

### What Is NOT Used

- No gradients anywhere
- No new hue families beyond what exists in status-badge.tsx
- No colored card backgrounds (cards are always `bg-white`)
- No colored chart axes or backgrounds
- No brand-color tinting on the page background

---

## 9. Animations & Micro-interactions

### Page Load Sequence

All cards render simultaneously with their loading skeletons. No staggered appearance. Staggered loading feels sluggish in operational software. When data arrives, each card transitions from skeleton to content independently (TanStack Query's per-query loading states handle this naturally).

### KPI Value Animation

**No counting animation.** KPI values render as final numbers immediately. Counting animations (where numbers "roll" from 0 to the target) are delightful for marketing dashboards seen once a day. For an operational tool opened 20+ times a day, they become a 300ms delay repeated hundreds of times. The skeleton-to-value transition is the only animation.

### Chart Drawing

The bar chart uses a simple fade-in for all bars simultaneously:

```css
@keyframes chart-fade {
  from { opacity: 0; }
  to   { opacity: 1; }
}
```

Duration: 200ms. No sequential bar-by-bar animation. No grow-from-zero. Operational speed over showmanship.

### Hover States

| Element | Hover Effect | Duration |
|---------|-------------|----------|
| KPI cells | `bg-primary-subtle/50` background | `150ms ease` |
| Needs Attention items | `bg-background-light/50` background | `150ms ease` |
| Schedule job items | `bg-background-light/50` background | `150ms ease` |
| Activity feed items | None (not interactive) | -- |
| Chart bars | Opacity to 100% + tooltip | `150ms ease` |
| Period selector buttons | Background change per spec | `150ms ease` |

All transitions: `transition-colors` with default Tailwind duration (150ms). No transforms, no scale changes, no elevation changes within cards.

### Refresh Indicator

When background data refetch occurs (TanStack Query refetching), show a subtle pulse on the card header. A thin 2px `bg-primary` bar at the top of the affected card, using `animate-pulse`:

```jsx
{isFetching && !isLoading && (
  <div className="absolute top-0 left-0 right-0 h-0.5 bg-primary/30 animate-pulse rounded-t-xl" />
)}
```

This appears only during refetch (not initial load, which uses skeletons). It is nearly invisible -- 2px tall, 30% opacity -- but provides feedback that data is updating.

---

## 10. Responsive Behavior

### Desktop (1280px+)

Full layout as specified. KPI strip: 5 columns. Two-column chart zone: 3/2 split. Everything visible above and with one short scroll.

### Tablet (768px - 1023px)

- Sidebar hidden (hamburger menu) -- existing behavior
- KPI strip: `grid-cols-3` on first row, `grid-cols-2` on second row (CSS handles via `grid-cols-2 md:grid-cols-3 lg:grid-cols-5`)
- Two-column zone stacks: Revenue chart full-width, schedule snapshot full-width below
- Needs Attention card: unchanged (it is already single-column)
- Activity feed: unchanged

### Mobile (< 768px)

- KPI strip: `grid-cols-2` -- 3 rows of 2, last cell spans full width
- Two-column zone stacks vertically
- Schedule snapshot: limited to 3 technicians, "View all" link
- Activity feed: limited to 3 items
- Greeting subtitle hidden (save vertical space): only show `"Good morning, {firstName}"`

### KPI Strip Column Transitions

```
lg:  [KPI1 | KPI2 | KPI3 | KPI4 | KPI5]        -- 5 cols
md:  [KPI1 | KPI2 | KPI3]                         -- 3 cols
     [KPI4 | KPI5      ]
sm:  [KPI1 | KPI2]                                 -- 2 cols
     [KPI3 | KPI4]
     [KPI5          ]
```

The `divide-x` utility creates vertical dividers. On smaller screens where cells wrap to new rows, dividers between rows are handled by also applying `divide-y` on the outer container at the `md` breakpoint where wrapping begins: `lg:divide-y-0 divide-y divide-x-0 lg:divide-x`. The exact implementation may need a wrapper per row at smaller breakpoints to maintain clean divider behavior.

---

## Appendix: Component File Structure

```
frontend/src/
  pages/
    DashboardPage.tsx           -- Main page component, data fetching, layout
  components/
    dashboard/
      DashboardKPIStrip.tsx     -- 5-cell KPI strip with trends
      NeedsAttentionCard.tsx    -- Priority action items
      RevenueChart.tsx          -- 30-day bar chart (Recharts)
      ScheduleSnapshot.tsx      -- Today's jobs by technician
      ActivityFeed.tsx           -- Recent events list
```

Each component receives data as props. All data fetching lives in `DashboardPage.tsx` using TanStack Query. Chart rendering uses Recharts (already a project dependency candidate; if not installed, use the lightest chart library compatible with the design spec).
