# WP - Status Registry (Parallel Track)

**Covers:** the meaning layer / parallel track of the program plan
**Agents:** 20-30 | **Blocking:** no
**Prerequisite:** none. Runs alongside any other session.
**Output:** one PR into `staging`, branch `refactor/ui-status-registry`

## Goal

Collapse the ~53 status-to-colour maps into one registry, so "what does overdue look like" has exactly
one answer. Includes the known `LeadDetailPage` enum bug.

## Why it can run in parallel

It touches `design-system/status-registry.ts` and the status maps scattered through feature components.
It does **not** touch `components/ui/` primitives (W2) or convert raw elements (W3). The one overlap
risk is a file that both a status map and a raw-element conversion live in, which the conflict scan in
each session catches.

Running it early also means W3's conversions inherit a registry that already exists, rather than
converting a hand-rolled colour map into a primitive that then needs converting again.

## Script shape

```
phase('Inventory')
  parallel x4 - multi-modal sweep, each blind to the others:
    - by file: every object literal mapping a status string to classes
    - by enum: every Prisma status enum and its frontend representations
    - by component: Badge/Card/Chip call sites passing status-derived colour
    - by copy: every user-facing status label, to catch wording drift too
  barrier: dedup across all four into one canonical map before designing.

phase('Design')
  agent      - the registry: status -> {tone, label, icon?}, one entry per real
               enum value, sourced from schema.prisma NOT from the UI's guesses
  parallel x3 - refute: is any enum value missing, does any status change
               appearance, is the LeadDetailPage enum bug actually fixed

phase('Migrate')
  pipeline over the ~53 maps, convert -> refute -> visual check

phase('Guard')
  agent - a test asserting every enum value in schema.prisma has a registry entry.
          Prove it fails when an entry is removed.

phase('Verify')
  agent - all gates printed, plus a before/after table of every status's rendered
          appearance so any change is visible rather than buried
```

## Exit criteria

- One registry. Every status enum value from `schema.prisma` has exactly one entry.
- The `LeadDetailPage` enum bug is fixed, with the before/after shown.
- A guard fails if a new enum value has no registry entry. Proven failing.
- A before/after appearance table for every status. Any change is explained, not incidental.
- All gates printed.

## Risks

| Risk | Mitigation |
|---|---|
| The registry is built from UI guesses, not the real enums | design agent reads `schema.prisma` as the source of truth |
| A status silently changes colour | mandatory before/after table for every value |
| Conflicts with W3 conversions in shared files | conflict scan in both sessions; run WP early to reduce overlap |

---

# Evidence appendix

Added after the migration, from the working tree, by re-deriving every value rather than copying a
summary. BEFORE is read from `git show origin/staging:<path>` (`origin/staging` == HEAD ==
`f5a8b182c`; this branch's work is uncommitted). AFTER is resolved by hand through
`STATUS_REGISTRY` -> `STATUS_INTENT_CLASSES` / `_FILL` / `_TEXT` / `_HOVER`. Every hex is read from
`frontend/src/design-system/tokens.css`. Enum membership is read from `backend/prisma/schema.prisma`,
the only source of truth for enum values.

No dev server, no Playwright, no e2e spec and no `/api/test/*` call was used to produce this. The
check is static and therefore exhaustive rather than sampled: each status is resolved to its class
string and the before and after strings are compared as text.

## Appearance table

Verdict key: `=` identical, `KEEP` keep and explain, `FIX` corrects a defect, `REVERT` restored to the
origin/staging value.

### Method note: alpha composites

`bg-*/10` is `rgb(var(--token) / 0.1)`, so the rendered pixel depends on what the chip sits ON.

An earlier draft of this document asserted that every migrated chip sits on a dialog or table surface
that is `--surface-light` = `#FFFFFF`. That premise is FALSE for two of the six chip files, and it
published four wrong hexes. Ancestor chains, re-read directly rather than assumed:

| chip file | nearest ancestor that paints a background | token chain | hex |
|---|---|---|---|
| `PODetailDialog.tsx:361` header summary card | the header wrapper itself | `--background-light` -> `--canvas` | `#EEF1F3` |
| `PrePODetailDialog.tsx:257` header summary card | the header wrapper itself | `--background-light` -> `--canvas` | `#EEF1F3` |
| `POPreviewDialog.tsx:254` `.po-print-root` | the print root itself | `--surface-light` -> `--surface` | `#FFFFFF` |
| `StagePreviewDialog.tsx:231` `.stage-print-root` | the print root itself | `--surface-light` -> `--surface` | `#FFFFFF` |
| `JobStagesSection.tsx` chip inside `SectionCard` | `SectionCard.tsx:48` outer card; the body div at `SectionCard.tsx:75` paints no background of its own | `--surface-light` -> `--surface` | `#FFFFFF` |
| `TimesheetsReport.tsx:359` and `:362` pills | `ResizableTable.tsx:196` table shell; the `tbody tr` at `ResizableTable.tsx:271-277` carries a hover wash only, no resting background | `--surface-light` -> `--surface` | `#FFFFFF` |

`--canvas` is `238 241 243` (`tokens.css:97`) and `--background-light` aliases it (`tokens.css:145`).
So there are TWO composite tables, not one.

Composite over `#FFFFFF` = (255,255,255), `round(0.1 * channel + 0.9 * 255)` per channel. This table
governs the four white-surface files only: `POPreviewDialog`, `StagePreviewDialog`, `JobStagesSection`,
`TimesheetsReport`.

| class | token rgb | composite over `#FFFFFF` |
|---|---|---|
| `bg-warning/10` | 180 83 9 | `#F8EEE6` |
| `bg-success/10` | 47 125 93 | `#EAF2EF` |
| `bg-danger/10` | 191 90 76 | `#F9EFED` or `#F9EEED` - EXACT TIE on green, see below |
| `bg-info/10` | 59 130 246 | `#EBF3FE` or `#EBF2FE` - EXACT TIE on green, see below |

Composite over `#EEF1F3` = (238,241,243), `round(0.1 * channel + 0.9 * 238)` on red,
`round(0.1 * channel + 0.9 * 241)` on green, `round(0.1 * channel + 0.9 * 243)` on blue. This table
governs the two canvas-surface files only: `PODetailDialog`, `PrePODetailDialog`. No channel lands on
a tie here.

| class | token rgb | composite over `#EEF1F3` |
|---|---|---|
| `bg-warning/10` | 180 83 9 | `#E8E1DC` |
| `bg-success/10` | 47 125 93 | `#DBE5E4` |
| `bg-info/10` | 59 130 246 | `#DCE6F3` |

These composites are why so many rows below are `FIX` rather than `=`. `tokens.css:160-166` records that
the 10% composites fail WCAG AA against their own flat text token in every case, and the `-surface` /
`-text` pairs that replace them are the ratified AA pairs. Note that the AA failure is stated for the
white case; on the canvas surface the composite is DARKER still, so the failure is not milder there.

#### Two exact half-unit rounding ties

Both are on the green channel over `#FFFFFF`, and the earlier draft rounded both UP without saying so.
Half-unit ties have no single correct answer, so both values are printed rather than one being picked.

1. `bg-danger/10` over white: G = `0.1 * 90 + 0.9 * 255` = `9 + 229.5` = **238.5 exactly**. `#F9EFED`
   (G = 239) and `#F9EEED` (G = 238) are equally correct. Inherited by the `rejected` BEFORE value in
   section 17. Either way the row is a real delta against the `danger` surface `#F7ECEA`, so the tie
   does not change that verdict.
2. `bg-info/10` over white: G = `0.1 * 130 + 0.9 * 255` = `13 + 229.5` = **242.5 exactly**. `#EBF3FE`
   (G = 243) and `#EBF2FE` (G = 242) are equally correct - and `#EBF2FE` is byte-identical to
   `--info-surface`. Inherited by the `ready_for_pickup` BEFORE value in section 5, a HUE FLIP row
   where the bg hex is load-bearing. The honest statement there is that the old blue was, to within a
   rounding tie, the info surface token itself; printing only `#EBF3FE` shows a delta against
   `--info-surface` that is an artefact of rounding, not a real difference.

### Token identities that are easy to get wrong

Several of these are aliases of one another, so a class string can change while the rendered pixel does
not. Each is a distinct Tailwind class resolving to the same value:

- `--sage-50` == `--green-bg` == `--success-surface` == `#EEF8F2`
- `--sage-700` == `--green-700` == `--success` == `--success-text` == `--success-strong` == `#2F7D5D`
- `--background-light` == `--canvas` == `--neutral-surface` == `#EEF1F3`
- `--warning` == `--amber-700` == `--warning-strong` == `#B45309` (note `--warning-text` is `#B35309`,
  one unit darker in red, NOT the same value)
- `--primary` == `--ocean-800` == `#0C2D3A`; `--primary-subtle` == `--ocean-subtle` == `#E8EEF0`
- `--border-color` == `--line` == `--neutral-border` == `#E4E8EC`
- `--text-secondary` == `--muted` == `#667985` == `--neutral-strong` (so a `text-text-secondary` ->
  `text-neutral-text` move IS a real change to `#5E707B`, but a `bg-neutral-strong` fill is not)
- `--text-primary` == `--ink` == `#10202B`

Full intent resolution, once, for reference by every table below:

| intent | CLASSES (surface / text / border) | FILL | TEXT |
|---|---|---|---|
| success | `#EEF8F2` / `#2F7D5D` / `#BFDACB` | `#2F7D5D` | `#2F7D5D` |
| warning | `#FBF1E5` / `#B35309` / `#E7B666` | `#B45309` | `#B35309` |
| danger | `#F7ECEA` / `#AC5144` / `#E8C7C1` | `#BB584A` | `#AC5144` |
| info | `#EBF2FE` / `#316CCC` / `#CEE0FD` | `#3473DA` | `#316CCC` |
| neutral | `#EEF1F3` / `#5E707B` / `#E4E8EC` | `#667985` | `#5E707B` |
| brand | `#E8EEF0` / `#0C2D3A` / `primary` at 20% | `#0C2D3A` | `#0C2D3A` |

---

### 1. `components/inventory/PODetailDialog.tsx` - domain `purchaseOrder`, chip at :356

Chip backdrop is `#EEF1F3`, NOT white (see the ancestor table in the method note), so the two
`bg-*/10` BEFORE values below composite over the canvas surface.

| status | BEFORE class -> hex (bg / text) | AFTER class -> hex (bg / text) | label | icon | verdict |
|---|---|---|---|---|---|
| draft | `bg-secondary-light text-text-secondary` `#E5E7EB` / `#667985` | neutral `#EEF1F3` / `#5E707B` | `Draft` unchanged | - | KEEP (converges on PurchaseOrdersPage) + FIX (text 3.99:1 -> 4.54:1) |
| sent | `bg-primary-subtle text-primary` `#E8EEF0` / `#0C2D3A` | brand `#E8EEF0` / `#0C2D3A` | `Sent` unchanged | - | = |
| partial | `bg-warning/10 text-warning` `#E8E1DC` / `#B45309` | warning `#FBF1E5` / `#B35309` | `Partial` unchanged | - | FIX (10% composite -> ratified AA pair) |
| received | `bg-success/10 text-success` `#DBE5E4` / `#2F7D5D` | success `#EEF8F2` / `#2F7D5D` | `Received` unchanged | - | FIX (same) |
| closed | `bg-background-light text-text-secondary` `#EEF1F3` / `#667985` | neutral `#EEF1F3` / `#5E707B` | `Closed` unchanged | - | FIX (text AA) |

All five labels are byte-identical to the registry, so the whole local `statusDef` map was deleted.
All five now additionally emit `border-neutral-border` and friends with NO `border` width class, so
the colour is inert. See `## Inert border colour` below.

### 2. `components/inventory/POPreviewDialog.tsx` - domain `purchaseOrder`, chip at :283

Labels are HELD verbatim on SR-E4 (`Draft` / `Sent to vendor` / `Partially received` /
`Received in full` / `Closed`). NO label changed on any row. `ring-1` was replaced by `border` on all
five, because `STATUS_INTENT_CLASSES` supplies only the border COLOUR and Tailwind preflight zeroes the
width.

Chip backdrop is `#FFFFFF` (`.po-print-root`), so the white composite table applies.

| status | BEFORE -> hex (bg / text / hairline) | AFTER -> hex (bg / text / hairline) | icon | verdict |
|---|---|---|---|---|
| draft | `bg-background-light text-text-secondary ring-border` `#EEF1F3` / `#667985` / `#E4E8EC` | neutral + `border` `#EEF1F3` / `#5E707B` / `#E4E8EC` | - | FIX (text AA) |
| sent | `bg-primary-subtle text-primary ring-primary/30` `#E8EEF0` / `#0C2D3A` / primary 30% | brand + `border` `#E8EEF0` / `#0C2D3A` / primary 20% | - | = colour; hairline alpha 30% -> 20% |
| partial | `bg-warning/10 text-warning ring-warning/20` `#F8EEE6` / `#B45309` | warning + `border` `#FBF1E5` / `#B35309` / `#E7B666` | - | FIX |
| received | `bg-success/10 text-success ring-success/20` `#EAF2EF` / `#2F7D5D` | success + `border` `#EEF8F2` / `#2F7D5D` / `#BFDACB` | - | FIX |
| closed | identical to `draft` | neutral + `border` | - | FIX (text AA) |

GEOMETRY, all five rows, disclosed rather than buried: `ring-1` paints outside the border box and costs
no layout; `border` sits inside the box model, so this
`inline-flex ... text-[10px] px-2 py-0.5 rounded-full` chip grows about 2px on each axis in the header
row. Verdict KEEP. Dropping the width entirely was considered and rejected: deleting a hairline these
chips have always had is the larger of the two changes. Both this file and `StagePreviewDialog.tsx`
now carry the justification in a comment at the call site.

### 3. `components/inventory/PrePODetailDialog.tsx` - domain `estimateReservation`, chip at :254

Labels HELD verbatim on SR-E4 (`Estimate Approved` / `Converted` / `Dismissed`). NO label changed.
The registry calls `open` "Open"; this dialog has always said "Estimate Approved", which carries
information "Open" does not.

Chip backdrop is `#EEF1F3`, NOT white (see the ancestor table in the method note), so the two
`bg-*/10` BEFORE values below composite over the canvas surface. This also removes the apparent
near-match on the `open` row: the old blue was `#DCE6F3`, a long way from `--info-surface`.

| status | BEFORE -> hex | AFTER -> hex | icon | verdict |
|---|---|---|---|---|
| open | `bg-info/10 text-info` `#DCE6F3` / `#3B82F6` | info `#EBF2FE` / `#316CCC` | - | FIX (info text 3.27:1 -> 4.50:1, the exact figures `tokens.css:191` records) |
| converted | `bg-success/10 text-success` `#DBE5E4` / `#2F7D5D` | success `#EEF8F2` / `#2F7D5D` | - | FIX |
| dismissed | `bg-secondary-light text-text-secondary` `#E5E7EB` / `#667985` | neutral `#EEF1F3` / `#5E707B` | - | KEEP (converges on `PurchaseOrdersPage.tsx:752`) + FIX (text AA) |

Inert `border-*-border`, no width class. See `## Inert border colour`.

### 4. `components/inventory/StagePreviewDialog.tsx` - domain `stage`, chip at :260

Labels HELD verbatim on SR-E4 and SR-E2 (`Awaiting parts` / `Partially received` /
`Complete - ready to stage` / `Ready for tech pickup` / `Delivered to job`). NO label changed.
`ring-1` -> `border` on all five, same geometry note as POPreviewDialog.

Chip backdrop is `#FFFFFF` (`.stage-print-root`), so the white composite table applies.

| status | BEFORE -> hex | AFTER -> hex | icon | verdict |
|---|---|---|---|---|
| awaiting | `bg-background-light text-text-secondary ring-border` `#EEF1F3` / `#667985` | neutral `#EEF1F3` / `#5E707B` | - | FIX (text AA) |
| partial | `bg-warning/10 text-warning ring-warning/20` `#F8EEE6` / `#B45309` | warning `#FBF1E5` / `#B35309` | - | FIX |
| complete | `bg-success/10 text-success ring-success/20` `#EAF2EF` / `#2F7D5D` | success `#EEF8F2` / `#2F7D5D` | - | FIX |
| **ready_for_pickup** | `bg-success/10 text-success ring-success/20` **GREEN** `#EAF2EF` / `#2F7D5D` | brand **OCEAN** `#E8EEF0` / `#0C2D3A` | - | **KEEP - HUE FLIP** |
| **delivered** | `bg-primary-subtle text-primary ring-primary/30` **OCEAN** `#E8EEF0` / `#0C2D3A` | neutral **GREY** `#EEF1F3` / `#5E707B` | - | **KEEP - HUE FLIP** |

### 5. `components/jobs/JobStagesSection.tsx` - domain `stage`, chip at :115

Chip backdrop is `#FFFFFF` (`SectionCard.tsx:48` outer card; the body div at `SectionCard.tsx:75`
paints nothing of its own), so the white composite table applies.

| status | BEFORE label / class -> hex | AFTER label / class -> hex | icon | verdict |
|---|---|---|---|---|
| awaiting | `Awaiting` `bg-background-light text-text-secondary` `#EEF1F3` / `#667985` | `Awaiting` (held override) neutral `#EEF1F3` / `#5E707B` | - | FIX (text AA) |
| partial | `Partial` `bg-warning/10 text-warning` `#F8EEE6` / `#B45309` | `Partial` (held override) warning `#FBF1E5` / `#B35309` | - | FIX |
| complete | `Complete` `bg-sage-50 text-sage-700` `#EEF8F2` / `#2F7D5D` | `Complete` (held override) success `#EEF8F2` / `#2F7D5D` | - | = BYTE-IDENTICAL hex, different class string |
| **ready_for_pickup** | `Ready for pickup` `bg-info/10 text-info` **BLUE** `#EBF3FE` or `#EBF2FE` (ROUNDING TIE) / `#3B82F6` | `Ready for pickup` (from registry) brand **OCEAN** `#E8EEF0` / `#0C2D3A` | - | **KEEP - HUE FLIP** |
| **delivered** | `Delivered` `bg-sage-50 text-sage-700` **GREEN** `#EEF8F2` / `#2F7D5D` | `Delivered` (held override) neutral **GREY** `#EEF1F3` / `#5E707B` | - | **KEEP - HUE FLIP** |
| fallback | label `s.replace(/_/g, ' ')`, `bg-background-light text-text-secondary` | label raw `s`, neutral | - | KEEP (no rendered effect, see below) |

The `ready_for_pickup` BEFORE bg is the exact half-unit tie documented in the method note: `#EBF3FE`
and `#EBF2FE` are equally correct, and `#EBF2FE` IS `--info-surface`. So the old blue was, to within
rounding, the info surface token itself. That does not soften this row - the AFTER is brand OCEAN,
a genuine hue flip - but the BEFORE hex is load-bearing here and must not be printed as a single
value that implies a delta against `--info-surface` which is really a rounding artefact.

The fallback branch is NOT statically unreachable: `stage` is a synthetic domain with no Prisma enum
behind it (`JobStage.status` is a plain String, validated only as `z.string().min(1).max(50)` in
`inv-stages.controller.ts`), so an out-of-vocabulary string still lands there. It has no rendered
effect for real data: all five values the product can produce are keys of `STATUS_REGISTRY.stage`. The
change aligns the fallback shape with the shared `StatusBadge` fallback.

### 5a. The four stage hue flips, and why they are KEEP

The `stage` domain had FOUR chip surfaces before consolidation plus a fifth label-only source, and the
chips did not agree with each other:

| surface | ready_for_pickup | delivered | icon |
|---|---|---|---|
| `StageDetailDialog.tsx:726` (`<StatusBadge domain="stage">`, i.e. already registry-driven) | brand OCEAN | neutral GREY | - |
| `StagingView.tsx:678` (`<StatusBadge domain="stage">`, i.e. already registry-driven) | brand OCEAN | neutral GREY | - |
| `StagePreviewDialog.tsx` (local tone map) | success GREEN | brand OCEAN | - |
| `JobStagesSection.tsx` (local tone map) | info BLUE | success GREEN | - |
| `StageDetailDialog.tsx:713-722` (select options) | LABELS ONLY, no appearance | LABELS ONLY, no appearance | - |

Three different colours for `ready_for_pickup` and three for `delivered`. There was therefore no single
"today's appearance" to preserve, which is the fact that decides these four rows.

The registry's values were ALREADY the live appearance on two of the four chip surfaces at
origin/staging, because those two surfaces already rendered through `StatusBadge` into this same
registry. Migrating `StagePreviewDialog` and `JobStagesSection` moves the two MINORITY copies onto the
incumbent MAJORITY. It does not invent a third value, and reverting either one would put it back out of
step with the two surfaces that never changed. That is why all four rows are KEEP rather than an
undecided repaint, and the argument is now written into both call sites as a comment.

### 6. `components/layout/search-shared.tsx` - GlobalSearch and ScheduleSearch

#### 6a. Dot fill: local `INTENT_DOT` -> `STATUS_INTENT_FILL`

| intent | BEFORE -> hex | AFTER -> hex | icon | verdict |
|---|---|---|---|---|
| success | `bg-success` `#2F7D5D` | `bg-success-strong` `#2F7D5D` | - | = different class string, IDENTICAL hex |
| warning | `bg-warning` `#B45309` | `bg-warning-strong` `#B45309` | - | = different class string, IDENTICAL hex |
| danger | `bg-danger` `#BF5A4C` | `bg-danger-strong` `#BB584A` | - | KEEP (sub-perceptual; adopts the declared FILL role `PriorityDot` and `CalendarView`'s DayView dot already used at origin/staging) |
| info | `bg-info` `#3B82F6` | `bg-info-strong` `#3473DA` | - | KEEP (same reason) |
| neutral | `bg-neutral-strong` `#667985` | `bg-neutral-strong` `#667985` | - | = |
| brand | `bg-primary` `#0C2D3A` | `bg-primary` `#0C2D3A` | - | = |

Statuses that actually reach a changed dot: danger via `lead.LOST` and `estimate.DECLINED`; info via
`estimate.SENT`. No other reachable status resolves to danger or info on this surface.

#### 6b. Labels: `statusLabel(status)` -> `statusLabel(entityType, status)`

The old humaniser was `s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())`. It only UPCASES,
so on an already-uppercase enum literal it returned the value verbatim. Neither meta row applies a CSS
case transform (`GlobalSearch.tsx:204` and `ScheduleSearch.tsx:179` are both `truncate flex-shrink-0`),
so ALL CAPS is what shipped. All fifteen reachable lead and job pairs, stated per value:

| domain.status | BEFORE rendered | AFTER rendered | icon | verdict |
|---|---|---|---|---|
| job.UNASSIGNED | `Unscheduled` | `Unscheduled` | - | = (special-cased ahead of the lookup in both versions) |
| job.SCHEDULED | `SCHEDULED` | `Scheduled` | - | KEEP (case only) |
| job.EN_ROUTE | `EN ROUTE` | `En Route` | - | KEEP (case only) |
| job.ON_SITE | `ON SITE` | `On Site` | - | KEEP (case only) |
| job.IN_PROGRESS | `IN PROGRESS` | `In Progress` | - | KEEP (case only) |
| job.COMPLETED | `COMPLETED` | `Completed` | - | KEEP (case only) |
| job.CANCELLED | `CANCELLED` | `Cancelled` | - | KEEP (case only) |
| lead.NEW | `NEW` | `New` | - | KEEP (case only) |
| lead.CONTACTED | `CONTACTED` | `Contacted` | - | KEEP (case only) |
| lead.WON | `WON` | `Won` | - | KEEP (case only) |
| lead.LOST | `LOST` | `Lost` | - | KEEP (case only) |
| lead.CANCELLED | `CANCELLED` | `Cancelled` | - | KEEP (case only) |
| **lead.WALKTHROUGH_SCHEDULED** | `WALKTHROUGH SCHEDULED` | **`WT Scheduled`** | - | **KEEP - SEMANTIC, escalated as SR-E6** |
| **lead.WALKTHROUGH_COMPLETED** | `WALKTHROUGH COMPLETED` | **`WT Completed`** | - | **KEEP - SEMANTIC, escalated as SR-E6** |
| **lead.ESTIMATED** | `ESTIMATED` | **`Estimate Sent`** | - | **KEEP - SEMANTIC, escalated as SR-E6** |
| estimate.* (all 8) | humaniser | humaniser, HELD on SR-E1 | - | = unchanged for every value |
| customer.* | humaniser | humaniser (customers have no domain) | - | = unchanged for every value |

Fourteen of the fifteen lead and job labels change; eleven are case only and three are semantic.
Estimate labels are deliberately NOT routed through the registry: doing so would land
`EstimateStatus.PENDING`'s contested label into a compact meta row while SR-E1 is open. Estimate DOTS
did already resolve through the registry at origin/staging and still do.

Why the three semantic rewords are KEEP and not REVERT: those exact strings were ALREADY the app-wide
lead labels at origin/staging. `STATUS_REGISTRY.lead` carried them byte for byte, `LeadsPage` renders
`<StatusBadge domain="lead">` off that same registry, and `lib/filters/registries/leads.ts`
`STATUS_LABELS` repeated them verbatim for the Status facet. Global search was the LONE lead surface
still shouting the raw enum. Two sources disagreed and the one already covering the rest of the app
wins. The defect being corrected is process, not outcome: the change set held five other copy changes
for adjudication and was shipping these three by omission. They are now filed as SR-E6.

### 7. `components/tasks/PriorityDot.tsx` - domain `taskPriority`

| status | BEFORE fill / text -> hex | AFTER fill / text -> hex | label | icon | verdict |
|---|---|---|---|---|---|
| URGENT | `bg-danger-strong` / `text-danger-text` `#BB584A` / `#AC5144` | identical | `Urgent` unchanged | - | = |
| HIGH | `bg-warning-strong` / `text-warning-text` `#B45309` / `#B35309` | identical | `High` unchanged | - | = |
| MEDIUM | `bg-info-strong` / `text-info-text` `#3473DA` / `#316CCC` | identical | `Medium` unchanged | - | = |
| LOW | `bg-neutral-strong` / `text-text-secondary` `#667985` / `#667985` | `bg-neutral-strong` / `text-neutral-text` `#667985` / `#5E707B` | `Low` unchanged | - | FIX (text AA 3.99:1 -> 4.54:1, already disclosed in the registry comment) |
| fallback | `bg-neutral-strong` / `text-text-secondary` | neutral fill / `text-neutral-text` | raw value, unchanged | - | FIX (same) |

### 8. `components/tasks/TaskDetailDrawer.tsx` - domain `task`, Select options

`TODO` -> `To Do`, `IN_PROGRESS` -> `In Progress`, `BLOCKED` -> `Blocked`, `DONE` -> `Done`. All four
registry labels are byte-identical to the deleted local map. ZERO CHANGE on all four rows. No colour is
rendered by this control.

### 9. `components/timeclock/EmployeePayrollCard.tsx` - `timeclockReview`, OtPill

The deleted `OT_REVIEW_INTENT` mapped approved -> success, rejected -> danger, pending -> warning,
none -> warning. `STATUS_REGISTRY.timeclockReview` maps the identical four. This file already consumed
`STATUS_INTENT_CLASSES` at origin/staging, so only the intent LOOKUP moved.

| review | BEFORE -> hex | AFTER -> hex | label | icon | verdict |
|---|---|---|---|---|---|
| approved | success `#EEF8F2` / `#2F7D5D` | success, identical | `approved` unchanged | - | = |
| rejected | danger `#F7ECEA` / `#AC5144` | danger, identical | `rejected` unchanged | - | = |
| pending | warning `#FBF1E5` / `#B35309` | warning, identical | `pending` unchanged | - | = |
| none | warning `#FBF1E5` / `#B35309` | warning, identical | `pending` (local `state === 'none'` rewrite) unchanged | - | = |

ZERO CHANGE, all four rows. Its `border-*-border` with no width predates this change set; see
`## Inert border colour`.

### 10. `lib/api/service-plans.ts`

`export const STATUS_LABEL` (four `servicePlan` labels) deleted. Verified ZERO importers at
origin/staging. ZERO CHANGE on all four values, dead-code removal only.

### 11. `lib/filters/registries/leads.ts` - Status facet options

All eight: `New` / `Contacted` / `WT Scheduled` / `WT Completed` / `Estimate Sent` / `Won` / `Lost` /
`Cancelled`. Byte-identical to `STATUS_REGISTRY.lead`. ZERO CHANGE on all eight rows.

### 12. `lib/filters/registries/jobs.ts` - Status facet options

All seven: `Unscheduled` / `Scheduled` / `En Route` / `On Site` / `In Progress` / `Completed` /
`Cancelled`. Byte-identical to `STATUS_REGISTRY.job`, including the ratified `UNASSIGNED` ->
"Unscheduled" display rename (the wire value stays `UNASSIGNED`). ZERO CHANGE on all seven rows.

### 13. `lib/filters/registries/invoices.ts` - Status facet options

| value | BEFORE option label | AFTER option label | icon | verdict |
|---|---|---|---|---|
| DRAFT | `Draft` | `Draft` | - | = |
| SENT | `Sent` | `Sent` | - | = |
| PARTIAL | `Partial` | `Partial` | - | = |
| PAID | `Paid` | `Paid` | - | = |
| VOIDED | `Voided` | `Voided` | - | = |
| REFUNDED | `Refunded` | `Refunded` | - | = |
| PARTIALLY_REFUNDED | `Partially Refunded` | `Partially Refunded` | - | = |
| **DISPUTED** | **option absent** | **`Disputed`** | - | **FIX (functional add)** |
| OVERDUE | absent | absent, deliberately | - | = (client-derived, has its own `overdue` boolean facet) |

Nine rows: EIGHT `=` (DRAFT, SENT, PARTIAL, PAID, VOIDED, REFUNDED, PARTIALLY_REFUNDED, OVERDUE) and
ONE FIX (DISPUTED). The Tally below cites this section as "8 of 9", not "7 of 9".

`DISPUTED` is a real `InvoiceStatus` member (verified in `schema.prisma`) that the list endpoint
already accepts, so a disputed invoice was simply unfilterable from the UI. Correctly labelled and
inserted in enum order. It is a behaviour change and is listed in `## Behaviour changes`.

### 13b. `lib/filters/registries/estimates.ts` - `deposit_status` facet options

Missing from every earlier draft of this appendix: a grep for `estimates.ts` or `deposit_status` over
the document returned no table row, even though this file DID change. The estimates registry's `status`
facet is held on SR-E1 and is correctly recorded as not migrated, but its `deposit_status` facet was
migrated in the same file and went undocumented.

What changed: `export const DEPOSIT_STATUS_LABELS` (four entries, `estimates.ts:60-65` at
origin/staging) was DELETED, and `estimates.ts:172` now reads
`DEPOSIT_STATUSES.map((s) => ({ value: s, label: STATUS_REGISTRY.deposit[s]?.label ?? s }))` where it
previously read `DEPOSIT_STATUS_LABELS[s] ?? s`. `DEPOSIT_STATUSES` (`estimates.ts:96`) is unchanged
and still lists the same four wire values in the same order. `STATUS_REGISTRY.deposit`
(`status-registry.ts:212-217`) carries the same four strings byte for byte.

| value | BEFORE option label | AFTER option label | icon | verdict |
|---|---|---|---|---|
| REQUESTED | `Requested` | `Requested` | - | = byte-identical |
| PAID | `Paid` | `Paid` | - | = byte-identical |
| VOIDED | `Voided` | `Voided` | - | = byte-identical |
| REFUNDED | `Refunded` | `Refunded` | - | = byte-identical |

ZERO CHANGE on all four rows. No colour is rendered by this control; the facet renders option labels
only, so the `deposit` domain's intents (warning / success / neutral / danger) do not reach a pixel
here. Note the tension with the `## Deferred` row that calls the `deposit` domain's four entries
"dead": they are dead as BADGES (no producer feeds the two `domain="deposit"` badge call sites) but
live as LABELS, which is exactly why the entries were kept. This section is the evidence for that
second half.

### 14. `pages/LeadDetailPage.tsx` - settable-status dropdown

Each option renders `<StatusBadge domain="lead" status={s} neutral />`, so every option is a colourless
neutral pill in BOTH versions. No option's appearance changes. Only the SET changes, 9 -> 7.

| option | BEFORE | AFTER | icon | verdict |
|---|---|---|---|---|
| NEW / CONTACTED / WALKTHROUGH_SCHEDULED / ESTIMATED / WON / LOST / CANCELLED | offered | offered, unchanged | - | = (7 rows) |
| **ESTIMATING** | offered; neutral pill labelled `ESTIMATING` via the StatusBadge fallback, and 400'd silently on click | **removed** | - | **FIX** |
| **APPROVED** | offered; same, 400'd silently on click | **removed** | - | **FIX** |
| WALKTHROUGH_COMPLETED | not offered | not offered, deliberately | - | = |

Neither `ESTIMATING` nor `APPROVED` is a `LeadStatus` member (verified in `schema.prisma`), so both
were dead menu entries. `WALKTHROUGH_COMPLETED` stays unoffered on purpose: `PATCH /api/leads/:id`
writes the status verbatim and never stamps `walkthrough_completed_at`, so offering it would produce a
lead whose status claims the walkthrough is done and whose timestamp says it never happened.

The deleted local `STATUS_LABELS` map in this file was ALREADY DEAD at origin/staging (declared at
line 95, never referenced; the render path used `StatusBadge` at line 151). Its deletion changes no
pixel. Its labels differed from the registry's (`Walkthrough Scheduled` vs `WT Scheduled`, `Estimated`
vs `Estimate Sent`), which is exactly why a dead map is worth deleting rather than migrating.

### 14b. `pages/LeadDetailPage.tsx` - `WalkthroughDot`, all 16 cells

This dot is an APPEARANCE surface, not only a behaviour change, and it is the one surface in the change
set whose output depends on two inputs rather than one. It therefore gets an exhaustive matrix:
8 `LeadStatus` members from `schema.prisma` x `walkthrough_completed_at` null or set.

The three colours, resolved once:

| result | class | token | hex |
|---|---|---|---|
| BLUE | `bg-info-strong` | `--info-strong` | `#3473DA` |
| GREEN | `bg-success-strong` | `--success-strong` | `#2F7D5D` |
| GREY | `bg-neutral-border` | `--neutral-border` | `#E4E8EC` |

Three columns, because there were three versions of this function, not two:

- **BEFORE** - `origin/staging`, `LeadDetailPage.tsx:161-171`. Signature `{ status }`. Tests
  `WALKTHROUGH_SCHEDULED` first, then the allowlist `['ESTIMATING', 'ESTIMATED', 'APPROVED', 'WON']`,
  then grey. `walkthrough_completed_at` is not an input at all, so both halves of each status pair are
  identical in this column.
- **completedAt-first** - the intermediate draft this work package produced and then corrected. New
  `completedAt` prop, but tested BEFORE the status check. This ordering is the regression that item 1
  of `## Behaviour changes` now records.
- **SHIPPED** - the current worktree, `LeadDetailPage.tsx:175-183`. Status check FIRST, then
  `completedAt`, then grey.

Verdicts are stated against BEFORE, which is what a reviewer is comparing to.

| status | completedAt | BEFORE | completedAt-first | SHIPPED | verdict vs BEFORE |
|---|---|---|---|---|---|
| NEW | null | GREY | GREY | GREY | = |
| NEW | set | GREY | GREEN | GREEN | KEEP |
| CONTACTED | null | GREY | GREY | GREY | = |
| CONTACTED | set | GREY | GREEN | GREEN | KEEP |
| WALKTHROUGH_SCHEDULED | null | BLUE | BLUE | BLUE | = |
| **WALKTHROUGH_SCHEDULED** | **set** | **BLUE** | **GREEN** | **BLUE** | **FIX - the regression, caught and reversed** |
| WALKTHROUGH_COMPLETED | null | GREY | GREY | GREY | = |
| **WALKTHROUGH_COMPLETED** | **set** | **GREY** | **GREEN** | **GREEN** | **FIX** |
| ESTIMATED | null | GREEN | GREY | GREY | **FIX** |
| ESTIMATED | set | GREEN | GREEN | GREEN | = |
| WON | null | GREEN | GREY | GREY | **FIX** |
| WON | set | GREEN | GREEN | GREEN | = |
| LOST | null | GREY | GREY | GREY | = |
| LOST | set | GREY | GREEN | GREEN | KEEP |
| CANCELLED | null | GREY | GREY | GREY | = |
| CANCELLED | set | GREY | GREEN | GREEN | KEEP |

Row by row, where the verdict is not `=`:

- **(WALKTHROUGH_SCHEDULED, set) - FIX.** The regression. `scheduleWalkthrough` in
  `lead.controller.ts` accepts `WALKTHROUGH_COMPLETED` as an input status and, when it re-schedules,
  writes status `WALKTHROUGH_SCHEDULED` without ever clearing `walkthrough_completed_at`. Nothing in
  that controller clears the stamp: `unscheduleWalkthrough` and `cancelWalkthrough` both write status
  `CONTACTED` and touch only the scheduled / cancelled fields. So a re-scheduled walkthrough carries a
  stale non-null stamp, and a completedAt-first ordering paints it GREEN "done" beside a card showing a
  FUTURE date. Testing status first restores BEFORE's behaviour on this cell. The ordering is
  load-bearing and the call-site comment says so, citing `scheduleWalkthrough` by name rather than by
  line, because that file moves.
- **(WALKTHROUGH_COMPLETED, set) - FIX.** The old allowlist omitted the one status that literally means
  the walkthrough is completed, so the dot went grey on every completion. Reachable on every completion,
  not an edge case.
- **(ESTIMATED, null) and (WON, null) - FIX.** A lead that never needed a walkthrough stops claiming one
  happened. This is the first of the two contradictions item 1 of `## Behaviour changes` names.
- **(NEW / CONTACTED / LOST / CANCELLED, set) - KEEP.** Grey -> green. Reachable, verified path:
  CONTACTED -> schedule -> complete (stamps `walkthrough_completed_at`) -> schedule again (permitted
  from `WALKTHROUGH_COMPLETED`) -> unschedule or cancel, both of which write CONTACTED and RETAIN the
  stamp. From CONTACTED the lead can then be marked LOST or CANCELLED, or reset to NEW. In every one of
  those states a walkthrough genuinely did happen, so green is the truthful reading. Note that item 1's
  prose singles out the LOST case as the second contradiction it removes; the reachability argument is
  identical for all four, and LOST is simply the one a reader is most likely to have seen.

Two of the four entries in the old allowlist, `ESTIMATING` and `APPROVED`, are NOT `LeadStatus`
members in `schema.prisma` (the enum is NEW, CONTACTED, WALKTHROUGH_SCHEDULED, WALKTHROUGH_COMPLETED,
ESTIMATED, WON, LOST, CANCELLED). They were already dead before this change set, which is why the
matrix has 16 cells and not 20.

Registry membership: this mapping deliberately does NOT join `STATUS_REGISTRY`. The registry's own
inclusion rule (c) requires the same mapping spelled in two or more places, and this dot has exactly
one declaration and one call site. It also CONTRADICTS the registry - the registry files
`lead.WALKTHROUGH_SCHEDULED` under the warning intent while this dot reads it as informational - so a
naive migration would repaint the blue dot amber. It is listed in `## Known survivors` for that reason.

### 15. `pages/LeadsPage.tsx`

Local `LEAD_STATUSES` deleted. Verified: exactly one occurrence at origin/staging, its own
declaration. Dead. ZERO CHANGE on all eight values.

### 16. `pages/reports/InvoicesReport.tsx` - report taxonomy, chip at :347

This is a REPORT bucket vocabulary, not an enum, so it deliberately keeps its own `STATUS_STYLE` map;
only the class strings inside it come from the registry.

| bucket | BEFORE -> hex | AFTER -> hex | icon | verdict |
|---|---|---|---|---|
| Paid | `STATUS_INTENT_CLASSES.success` | unchanged | - | = |
| Due | `STATUS_INTENT_CLASSES.warning` | unchanged | - | = |
| Overdue | `STATUS_INTENT_CLASSES.danger` | unchanged | - | = |
| Partial | `STATUS_INTENT_CLASSES.info` | unchanged | - | = |
| Unsent | `bg-background-light text-text-secondary` `#EEF1F3` / `#667985` | neutral `#EEF1F3` / `#5E707B` | - | FIX (text AA); also closes the last hand-written string in this map |

### 17. `pages/reports/TimesheetsReport.tsx` - `timeclockReview`, pills at :359 and :385

The label `Override · {p.review}` is HELD unchanged on every row (SR-E5): the registry label would turn
"Override · none" into "Override · Pending".

Pill backdrop is `#FFFFFF` (`ResizableTable.tsx:196`; the `tbody tr` carries a hover wash only), so
the white composite table applies.

| value | BEFORE -> hex | AFTER -> hex | icon | verdict |
|---|---|---|---|---|
| approved | `bg-success/10 text-success` `#EAF2EF` / `#2F7D5D` | success `#EEF8F2` / `#2F7D5D` | - | FIX |
| rejected | `bg-danger/10 text-danger` `#F9EFED` or `#F9EEED` (ROUNDING TIE) / `#BF5A4C` | danger `#F7ECEA` / `#AC5144` | - | FIX (danger text 3.79:1 -> 4.52:1) |
| pending | `bg-warning/10 text-warning` `#F8EEE6` / `#B45309` | warning `#FBF1E5` / `#B35309` | - | FIX |
| none | `bg-warning/10 text-warning` `#F8EEE6` / `#B45309` | warning `#FBF1E5` / `#B35309` | - | FIX |
| **in_zone** (`PunchStatus`, NOT a review state) | `bg-success/10 text-success` `#EAF2EF` / `#2F7D5D` | `STATUS_INTENT_CLASSES.success` `#EEF8F2` / `#2F7D5D` | - | FIX (token role, not a registry claim) |

The `rejected` BEFORE bg is the exact half-unit tie documented in the method note. Both values are
printed. The verdict is unaffected: either one is a real delta against the danger surface `#F7ECEA`.

The `in_zone` row needs its own note. It is a geofence result, not a status domain: `PunchStatus` is
correctly named in the guard's `EXCLUDED_ENUMS` and must NOT gain a registry domain. But leaving it on
the raw 10% composite would have put two different greens (`#EAF2EF` and `#EEF8F2`) side by side in one
table column the moment the Override pill moved. It therefore paints from `STATUS_INTENT_CLASSES.success`
DIRECTLY, with no registry lookup. That is the same ratified AA fix applied to every other chip in this
file, and it makes no claim that `in_zone` is a status.

### 18. `pages/tasks/views/BoardView.tsx` - domain `task`

Column headers and the per-card Select options, all four labels (`To Do` / `In Progress` / `Blocked` /
`Done`) byte-identical to the registry. ZERO CHANGE on all four rows. The synthetic `AT_RISK` column is
not a task status and is untouched.

### 19. `pages/tasks/views/CalendarView.tsx` - domain `task`

#### 19a. TaskChip at :109 - the chip's text is the TASK TITLE, not a status word

| status | BEFORE -> hex (bg / text) | AFTER -> hex (bg / text) | icon | verdict |
|---|---|---|---|---|
| **TODO** | `bg-neutral-surface text-text-primary` `#EEF1F3` / **`#10202B`** | neutral surface + explicit `text-text-primary` override `#EEF1F3` / **`#10202B`** | - | **REVERT applied - net identical** |
| IN_PROGRESS | `bg-info-surface text-info-text` `#EBF2FE` / `#316CCC` | info, identical | - | = |
| BLOCKED | `bg-warning-surface text-warning-text` `#FBF1E5` / `#B35309` | warning, identical | - | = |
| DONE | `bg-success-surface text-success-text` `#EEF8F2` / `#2F7D5D` | success, identical | - | = |

The TODO row was the single largest contrast delta in the change set: routing it through the registry
would have taken the chip's ink from `#10202B` (13.4:1) to `#5E707B` (4.54:1). That is a REVERT, and it
has been applied. The chip's surface and border still come from `STATUS_INTENT_CLASSES`; only the ink
is preserved, spelled once as `task.status === 'TODO' && 'text-text-primary'`, ordered last so
`twMerge` lets it win. The reason is written at the call site: this chip's text is the task TITLE, so
the registry's `-text` role (documented as "bare label text", i.e. the text IS the status word) does not
apply. Nobody decided to drop a calendar's default-state task titles from near-black to mid-grey.
Held pending a decision on whether the registry should carry a "neutral chip, primary ink" role.

Hover: the local `STATUS_CHIP_HOVER` map (keyed on the status VALUE, i.e. a second status-to-appearance
map) is gone. The four washes now live in `STATUS_INTENT_HOVER`, keyed on the resolved INTENT, and the
strings are byte-identical:

| status | intent | BEFORE hover | AFTER hover | icon | verdict |
|---|---|---|---|---|---|
| TODO | neutral | `hover:bg-neutral-strong/15` | `hover:bg-neutral-strong/15` | - | = |
| IN_PROGRESS | info | `hover:bg-info/15` | `hover:bg-info/15` | - | = |
| BLOCKED | warning | `hover:bg-warning/15` | `hover:bg-warning/15` | - | = |
| DONE | success | `hover:bg-success/15` | `hover:bg-success/15` | - | = |

All four chips gain an inert `border-*-border` with no width class. See `## Inert border colour`.

#### 19b. DayView dot at :443

Local `STATUS_DOT` -> `STATUS_INTENT_FILL`.

| status | BEFORE | AFTER | icon | verdict |
|---|---|---|---|---|
| TODO | `bg-neutral-strong` `#667985` | `bg-neutral-strong` `#667985` | - | = BYTE-IDENTICAL |
| IN_PROGRESS | `bg-info-strong` `#3473DA` | `bg-info-strong` `#3473DA` | - | = BYTE-IDENTICAL |
| BLOCKED | `bg-warning-strong` `#B45309` | `bg-warning-strong` `#B45309` | - | = BYTE-IDENTICAL |
| DONE | `bg-success-strong` `#2F7D5D` | `bg-success-strong` `#2F7D5D` | - | = BYTE-IDENTICAL |

### 20. `components/copilot/tools/toolRegistry.ts` - LLM-facing, renders no pixel

Not an appearance surface. Included because the same registry maps feed it, and a key added for
rendering silently becomes an advertised API filter value.

| vocabulary | BEFORE | AFTER | icon | verdict |
|---|---|---|---|---|
| leads (8) | `NEW\|CONTACTED\|WALKTHROUGH_SCHEDULED\|WALKTHROUGH_COMPLETED\|ESTIMATED\|WON\|LOST\|CANCELLED` | identical, now generated | - | = |
| jobs (7) | `UNASSIGNED\|SCHEDULED\|EN_ROUTE\|ON_SITE\|IN_PROGRESS\|COMPLETED\|CANCELLED` | identical, now generated | - | = |
| **estimates** | 7 values, **`SUPERSEDED` MISSING** | 8 values including `SUPERSEDED` | - | **FIX** |
| invoices (8) | `DRAFT\|SENT\|PARTIAL\|PAID\|VOIDED\|REFUNDED\|PARTIALLY_REFUNDED\|DISPUTED` | identical; `OVERDUE` still excluded | - | = |
| prose | `OVERDUE is NOT a status [em dash] use the overdue flag` | same sentence with a plain hyphen | - | FIX (boundary rule) |

`SUPERSEDED` is a real `EstimateStatus` member (verified in `schema.prisma`) and
`estimate.filters.ts` validates the facet against the enum, so the model was reporting that a real,
filterable status did not exist.

### 21. The two icon-bearing call sites - why the `icon` column above is `-` everywhere

`StatusEntry` carries an optional `icon?: LucideIcon`, and `StatusBadge` renders it
(`components/data/status-badge.tsx:18` reads `entry.icon`, `:30` renders it at `h-3 w-3` or
`h-4 w-4`). An earlier draft of this appendix had no icon column at all, which left the tables silent
about a role the registry actually ships.

Exactly NINE registry entries carry an icon, and they are confined to two domains:

- `WORKFLOW_STEP_STATUS`, 6 of 6 (`status-registry.ts:333-340`): SENT, SKIPPED, FAILED, STOPPED,
  CONTINUED, PENDING.
- `WORKFLOW_STATUS`, 3 of 3 (`status-registry.ts:348-352`): DRAFT, LIVE, PAUSED.

No other domain has a single icon. That is why the `icon` column reads `-` on every row of the twenty
per-status tables above: none of the twenty files this work package touched renders an icon-bearing
domain, so no icon reaches a pixel through any of them.

The nine icons DO render, at two call sites that this branch does not touch:

| domain | status | icon | intent | label | verdict |
|---|---|---|---|---|---|
| workflowStep | SENT | `CheckCircle2` | success | `Sent` | = |
| workflowStep | SKIPPED | `CircleSlash` | neutral | `Skipped` | = |
| workflowStep | FAILED | `AlertCircle` | danger | `Failed` | = |
| workflowStep | STOPPED | `OctagonPause` | warning | `Stopped` | = |
| workflowStep | CONTINUED | `ArrowRight` | neutral | `Continued` | = |
| workflowStep | PENDING | `Clock` | warning | `Scheduled` | = |
| workflow | DRAFT | `PenLine` | neutral | `Draft` | = |
| workflow | LIVE | `CheckCircle2` | success | `Live` | = |
| workflow | PAUSED | `PauseCircle` | neutral | `Paused` | = |

Call sites: `components/workflows/WorkflowActivity.tsx:110`
(`<StatusBadge domain="workflowStep" status={row.status} />`) and
`components/workflows/workflow-visuals.tsx:136`
(`<StatusBadge domain="workflow" status={workflowDisplayStatus({ status, is_enabled })} />`).

Proof that all nine are unchanged, from the diff rather than from inspection:

1. `git diff --stat origin/staging -- frontend/src/components/workflows/ frontend/src/design-system/status-registry.ts` reports ONE changed file, `status-registry.ts`. Both call-site files are
   untouched by this branch.
2. Inside the registry diff, the only added or removed non-comment lines are: the three new maps
   `STATUS_INTENT_FILL`, `STATUS_INTENT_TEXT` and `STATUS_INTENT_HOVER`; the two new domain maps
   `TASK_PRIORITY` and `TIMECLOCK_REVIEW_STATUS`; the single new entry `emailAccount.error`; and the
   two new `STATUS_REGISTRY` keys `taskPriority` and `timeclockReview`. Not one entry line inside
   `WORKFLOW_STEP_STATUS` or `WORKFLOW_STATUS` appears in the diff. The diff DOES rewrite the comment
   blocks above both maps, which is why a `git diff | grep -i workflow` looks alarming and is not:
   every matching line is a comment.

This section is why the twenty tables above are not, on their own, exhaustive over the registry: they
are exhaustive over the surfaces this branch CHANGED, and the icon role lives entirely outside that
set. Stating it here is the difference between "exhaustive" and "exhaustive over what we touched".

### Tally

Every figure here is derived from the tables above, section by section, rather than asserted. An
earlier draft published a headline of 62 and a per-section attribution that did not add up to it; the
counts below are recomputed by walking the verdict column of each table.

Counting unit: one enumerated VALUE, not one markdown row, because several rows cover a set (section
14's first row covers seven options, section 6b's `estimate.*` row covers eight). Two rows are
deliberately NOT counted because their sets are unbounded: section 6b's `customer.*` row and section
5's `fallback` row.

**Values with ZERO appearance change, by section:**

| section | values `=` | which |
|---|---|---|
| 1 PODetailDialog | 1 | `sent` |
| 2 POPreviewDialog | 0 | `sent` is `=` on colour but its hairline alpha moves 30% -> 20% |
| 3 PrePODetailDialog | 0 | - |
| 4 StagePreviewDialog | 0 | - |
| 5 JobStagesSection | 1 | `complete` (byte-identical hex, different class string) |
| 6a search dots | 4 | success, warning, neutral, brand |
| 6b search labels | 9 | `job.UNASSIGNED` + all 8 `estimate.*` |
| 7 PriorityDot | 3 | URGENT, HIGH, MEDIUM |
| 8 TaskDetailDrawer | 4 | all |
| 9 EmployeePayrollCard | 4 | all |
| 10 service-plans.ts | 4 | all |
| 11 leads.ts | 8 | all |
| 12 jobs.ts | 7 | all |
| 13 invoices.ts | 8 | DRAFT, SENT, PARTIAL, PAID, VOIDED, REFUNDED, PARTIALLY_REFUNDED, OVERDUE |
| 13b estimates.ts deposit | 4 | all |
| 14 LeadDetailPage dropdown | 8 | the 7 retained options + WALKTHROUGH_COMPLETED staying unoffered |
| 14b WalkthroughDot | 8 | the 8 cells of the 16 that resolve to the same colour as BEFORE |
| 15 LeadsPage | 8 | all |
| 16 InvoicesReport | 4 | Paid, Due, Overdue, Partial |
| 17 TimesheetsReport | 0 | - |
| 18 BoardView | 4 | all |
| 19a CalendarView chip | 3 | IN_PROGRESS, BLOCKED, DONE |
| 19a CalendarView hover | 4 | all |
| 19b CalendarView dots | 4 | all |
| 21 workflow icons | 9 | all, and provably untouched by the diff |
| **total** | **109** | |

Section 20 is excluded from that 109: it renders no pixel. Its own tally is 3 vocabularies unchanged
(leads, jobs, invoices) and 2 FIX (estimates `SUPERSEDED`, the em dash in the prose).

Add the one REVERT row, section 19a's `task.TODO`, and **110 of the enumerated values show no pixel
difference between origin/staging and this branch.**

**Changes, by kind.** These buckets OVERLAP by design and therefore do NOT sum to a row total: a
`POPreviewDialog` row can be a colour FIX and a geometry KEEP at the same time, and section 1's
`draft` is both a KEEP convergence and an AA FIX. No grand total is claimed for them.

| kind | count | derivation |
|---|---|---|
| FIX, AA or token-role, each backed by a ratio `tokens.css` records | 24 | section 1 (4: draft, partial, received, closed), 2 (4: draft, partial, received, closed), 3 (3: all), 4 (3: awaiting, partial, complete), 5 (2: awaiting, partial), 7 (2: LOW, fallback), 16 (1: Unsent), 17 (5: all) |
| FIX, state-to-appearance correctness | 4 | all in section 14b: (WALKTHROUGH_SCHEDULED, set), (WALKTHROUGH_COMPLETED, set), (ESTIMATED, null), (WON, null) |
| FIX, behavioural | 4 | two dead LeadDetailPage enum options, invoices `DISPUTED`, toolRegistry `SUPERSEDED` |
| KEEP and explain | 37 | 4 stage hue flips, 2 search dot intents, 14 search labels, 10 `ring-1` -> `border` rows, 1 JobStagesSection fallback label, 2 purchaseOrder / estimateReservation neutral convergences, 4 section-14b reachable grey -> green cells |
| REVERT | 1 | `task.TODO`'s chip ink on CalendarView. Applied. |

### Inert border colour

`STATUS_INTENT_CLASSES` always ships a border COLOUR. Five migrated sites emit it with no `border`
width class, so it is inert (Tailwind preflight zeroes border-width): `PODetailDialog.tsx:356`,
`PrePODetailDialog.tsx:254`, `JobStagesSection.tsx:115`, `CalendarView.tsx:109`,
`TimesheetsReport.tsx:385`. Two sites added an explicit `border`: `POPreviewDialog`,
`StagePreviewDialog`.

This is deliberate and must NOT be "fixed" by adding `border` at the five. Those chips never had a
hairline, so adding one is a fresh, undecided appearance change on five surfaces. Each of the five now
carries a one-line comment saying so.

Two further sites already emitted an inert `border-*-border` at origin/staging and are left exactly
alone, noted here so a reader does not mistake them for collateral of this change set:

- `pages/reports/InvoicesReport.tsx:33-37` - the `STATUS_STYLE` map consumed
  `STATUS_INTENT_CLASSES` for four of its five buckets before this change set existed, border colour
  included, on a chip with no width class.
- `components/timeclock/EmployeePayrollCard.tsx` `OtPill` - same, pre-existing.

The underlying design question is filed for the registry and W2 owner: `STATUS_INTENT_CLASSES` bundles
a border colour that most consumers cannot use, which is why the family now looks inconsistent at the
class-string level while rendering identically.

---

## Escalations

Six copy and appearance questions are held for adjudication rather than decided inside a refactor.
None of them may be resolved by editing one side quietly; each needs a product call.

### ID scheme, and a collision that had to be fixed

This series is prefixed `SR-` (status registry). The bare numbers `E1` through `E6` were originally
used and every single one of them COLLIDES with pre-existing, unrelated numbering already in this
repository. There are two prior E-sequences, not one:

1. Phone PRD escalations, in `md_files/specs/emanuel-integration/phone-working/decisions-log.md`:
   E1 after-hours and emergency triage (:99), E2 budget and cost ceiling (:100), E3 UI placement (:101),
   E4 numbers strategy (:102).
2. Comms implementation SLICES, cited throughout shipped source: E2 dialer entity attribution
   (`stores/dialer.store.ts:4`, `Softphone.tsx:85` and `:463`, `Dialer.tsx:156`, `:237`, `:659`,
   `stores/__tests__/dialer.store.test.ts:1`, `softphone-entity-context.test.tsx`), E3 the comm-row job
   control (`CommRowJobControl.tsx:3`, `CommJobMenu.tsx:4`), E4 and E4-FE the lead communications tab
   (`LeadCommunicationsTab.tsx:2`, `lib/api/jobCommunications.ts:78`), E5 the comms composer gating
   (`JobCommunicationsTab.tsx:74` and `:184`, `CustomerDetailPage.tsx:720`), E6 the shared CommRow
   (`CommRow.tsx:2`, `CustomerCommunicationsTab.tsx:92`).

So the collision is wider than first reported: E3 and E6 are taken too, not just E2, E4-FE and E5.
Every ID in the range is ambiguous, which makes the `SR-` prefix mandatory rather than cosmetic.

The prefix form is `SR-E<n>`, not `SR<n>`, because `components/layout/search-shared.tsx:64-97` already
shipped that spelling together with the collision note.

Note also a false positive to avoid: `pages/reports/estimates-report-logic.test.ts` contains `E1`
through `E8` as estimate NUMBERS in test fixtures. Those are data, not escalation IDs.

### Why there is no SR-E3

The number was SKIPPED. It was not an escalation that got dropped. Evidence, in order of weight:

1. `design-system/status-registry.ts` already contained the token `§E-3` at origin/staging (line 45
   there, line 149 now): "§E-3 (estimate workspace redesign)", a SPEC SECTION reference, not an
   escalation. Writing an escalation "E3" into the same file would have collided with a string already
   in that file's comments.
2. No `E3` citation exists anywhere in this change set.
3. Every "held pending" comment in this change set carries an ID. A grep for held, holding and
   escalat across all seven citing files returns no comment that names a decision without naming the
   escalation it belongs to. A dropped escalation would have left an orphaned hold.

This is the best-supported reading rather than a certainty: the person who assigned the numbers is not
available and no note records the intent. The number stays skipped rather than being recycled, because
renumbering now would invalidate the citations already in shipped source.

### SR-E1 - what `EstimateStatus.PENDING` means, and therefore what it is called

| side | string | source |
|---|---|---|
| A | `Pending` | `lib/filters/registries/estimates.ts` `ESTIMATE_STATUS_LABELS`, decision D6 dated 2026-07-20 |
| B | `Approved [em dash] Deposit Pending` | `design-system/status-registry.ts` `ESTIMATE_STATUS`, decision D6 dated 2026-07-21 |

Both decisions are labelled D6 and they assert opposite semantics. A reads PENDING as PRE-acceptance
(sent, the customer is still deciding). B reads it as POST-acceptance (the customer has approved and
signed; only the deposit is outstanding). They cannot both be true, and which is right is a product
decision about what the state MEANS, not a refactor.

Surfaces affected: the Estimates list Status filter facet (side A), every `<StatusBadge
domain="estimate">` (side B), and global search, which is HELD on the humaniser fallback specifically
so that routing it through the registry does not land the contested string in a compact meta row.

Consequence, and the trap: migrating `ESTIMATE_STATUS_LABELS` onto the registry is mechanically trivial
(verified: no importer outside its own file). Doing it silently rewords a live filter facet and
pre-empts the decision.

Who decides: Ran, product call. Until then neither string may change and neither map may be migrated.

### SR-E2 - the two user-facing labels that still carry an em dash

| label | current string | source |
|---|---|---|
| `estimate.PENDING` | `Approved [em dash] Deposit Pending` | `status-registry.ts:163` |
| `stage.partial` | `Partial [em dash] items pending` | `status-registry.ts:300` |

The repository boundary rule is plain hyphens only, so both strings are non-compliant. They were NOT
fixed silently, because both are USER-FACING copy and `estimate.PENDING` is simultaneously the string
under dispute in SR-E1. Rewording either one inside a refactor would bury a copy change and, for
PENDING, pre-empt SR-E1.

A third copy of the same em dash exists at `StageDetailDialog.tsx:713-722`, the label-only stage select,
and must be changed in the same pass so the two do not drift.

Surfaces affected: every estimate status badge; every stage chip that adopts the registry label
(today only `StageDetailDialog` and `StagingView`, because `StagePreviewDialog` and `JobStagesSection`
hold their own labels); the stage select options.

Who decides: Ran. The likely outcome is a plain hyphen in both, but it is a copy edit to two live
strings and is recorded rather than absorbed.

### SR-E4 - which vocabulary wins where the registry is terser than the surface

The registry's labels are shorter than the wording three dialogs shipped with. Adopting them is a
user-facing copy change, so all three dialogs HOLD their own labels and take only the colour.

| surface | status | surface string (kept) | registry string (not adopted) |
|---|---|---|---|
| `POPreviewDialog` | sent | `Sent to vendor` | `Sent` |
| `POPreviewDialog` | partial | `Partially received` | `Partial` |
| `POPreviewDialog` | received | `Received in full` | `Received` |
| `PrePODetailDialog` | open | `Estimate Approved` | `Open` |
| `StagePreviewDialog` | awaiting | `Awaiting parts` | `Awaiting all parts` |
| `StagePreviewDialog` | partial | `Partially received` | `Partial [em dash] items pending` |
| `StagePreviewDialog` | complete | `Complete - ready to stage` | `All parts in` |
| `StagePreviewDialog` | ready_for_pickup | `Ready for tech pickup` | `Ready for pickup` |
| `StagePreviewDialog` | delivered | `Delivered to job` | `Delivered to tech` |
| `JobStagesSection` | awaiting | `Awaiting` | `Awaiting all parts` |
| `JobStagesSection` | partial | `Partial` | `Partial [em dash] items pending` |
| `JobStagesSection` | complete | `Complete` | `All parts in` |
| `JobStagesSection` | delivered | `Delivered` | `Delivered to tech` |

Two of these deserve a specific flag. `PrePODetailDialog.open` is the one case where the SURFACE string
carries strictly more information than the registry's ("Estimate Approved" vs "Open"), so this is not
simply a terseness question. And `POPreviewDialog`'s chip renders under CSS `uppercase`, so adopting the
registry there would turn SENT TO VENDOR into SENT, a visibly larger change than the diff suggests.

Surfaces affected: three inventory dialogs plus the job detail stage list. `JobStagesSection` does NOT
override `ready_for_pickup` because its label already matches the registry verbatim.

Who decides: Ran, with whoever owns inventory copy. Resolution deletes three local label maps.

### SR-E5 - the timesheet override pill's label

| side | string | source |
|---|---|---|
| A, current | `Override · none` (interpolates the raw `p.review` value) | `TimesheetsReport.tsx:359` |
| B | `Override · Pending` (the registry's `timeclockReview.none` label) | `status-registry.ts:361` |

The registry maps both `none` and `pending` to the label `Pending`, which is correct for a badge but
collapses a distinction the timesheet log column is specifically there to show: `none` means no override
was ever requested, `pending` means one was and is awaiting review. Adopting the registry label would
make those two rows read identically.

Surfaces affected: the punch log table in TimesheetsReport, `none` and `pending` rows only. The
`EmployeePayrollCard` OtPill already does its own `state === 'none' ? 'pending' : state` rewrite and is
not affected.

Who decides: whoever owns timeclock. Note the colour half already migrated on both rows; only the label
is held.

### SR-E6 - three semantic lead label rewords in global search

The one escalation that was shipping undisclosed until this document. Filed because the change set held
five other copy changes for adjudication and let these three through by omission.

| status | before | after |
|---|---|---|
| `lead.WALKTHROUGH_SCHEDULED` | `WALKTHROUGH SCHEDULED` | `WT Scheduled` |
| `lead.WALKTHROUGH_COMPLETED` | `WALKTHROUGH COMPLETED` | `WT Completed` |
| `lead.ESTIMATED` | `ESTIMATED` | `Estimate Sent` |

`ESTIMATED` -> `Estimate Sent` is the substantive one: it changes what the row asserts, from a state
name to a claim that an estimate was sent.

Surfaces affected: GlobalSearch and ScheduleSearch meta rows only. The eleven other label changes on the
same path are case-only and are not part of this escalation.

Recommendation, already applied as KEEP: these three strings were the app-wide lead labels at
origin/staging on every other lead surface, and global search was the lone outlier still printing the
raw enum. Reverting would put it back out of step with the rest of the app. It is filed so it is
adjudicated rather than absorbed, not because the outcome is in doubt.

Who decides: Ran, as a copy review. This one can be ratified rather than debated.

### Open source-comment follow-ups these definitions create

Not owned by this document; listed so they are not lost.

1. Six files still cite the BARE, colliding IDs and should be updated to the `SR-E` form:
   `design-system/status-registry.ts:155` and `:295`; `lib/filters/registries/estimates.ts:15`, `:30`,
   `:31`, `:47`, `:59`, `:70`, `:171`; `components/inventory/POPreviewDialog.tsx:49`;
   `components/inventory/StagePreviewDialog.tsx:42-43`; `components/inventory/PrePODetailDialog.tsx:91`;
   `components/jobs/JobStagesSection.tsx:43` and `:68`; `pages/reports/TimesheetsReport.tsx:364`.
   `components/layout/search-shared.tsx` is already correct and already documents the collision.
2. `lib/filters/registries/estimates.ts:37` cites `status-registry.ts:117-125` for the D6 decision.
   That pointer is stale: the block moved to lines 149-163 when `STATUS_INTENT_HOVER` was inserted
   above it. Cite the symbol (`ESTIMATE_STATUS`) rather than a line range.

---

## Behaviour changes

For the PR body. Each alters what the app DOES, and they ride a refactor, so they must not be
discovered in production.

An earlier draft opened this section with "None of these is an appearance change". That is FALSE for
item 1: `WalkthroughDot` maps state to a DOT COLOUR, so a change to its mapping is an appearance change
on eight of sixteen cells as well as a behaviour change. Items 2 through 7 are behaviour, copy or
geometry. Item 1 is both, and the full 16-cell before-and-after is section 14b of the appearance table.

1. **`pages/LeadDetailPage.tsx` - `WalkthroughDot` rewrite. APPEARANCE CHANGE AND BEHAVIOUR CHANGE.**
   Now takes `lead.walkthrough_completed_at` as a second input instead of inferring completion from the
   status allowlist `['ESTIMATING', 'ESTIMATED', 'APPROVED', 'WON']`. New prop, new data dependency;
   verified sound, the field is already in the backend select (`lead.controller.ts:52` and `:81`) and
   already read on this same page. It removes two live contradictions: a lead that never needed a
   walkthrough turned green on reaching ESTIMATED, and a completed walkthrough turned grey the moment
   the lead was marked LOST, beside a card that still read "Completed {date}".
   The status check is tested FIRST and the timestamp SECOND, and that ordering is load-bearing:
   `scheduleWalkthrough` in `lead.controller.ts` re-schedules from `WALKTHROUGH_COMPLETED` without ever
   clearing `walkthrough_completed_at`, so a timestamp-first ordering paints a future-dated walkthrough
   as done. Every one of the sixteen cells is enumerated in section 14b, including the four that go
   grey -> green and are KEEP rather than FIX.

2. **`pages/LeadDetailPage.tsx` - settable-status dropdown drops from nine options to seven.**
   `ESTIMATING` and `APPROVED` removed. Neither is a `LeadStatus` member in `schema.prisma`, so both
   400'd silently on click. Admins lose two menu entries that never worked. `WALKTHROUGH_COMPLETED` is
   deliberately still not offered, for the timestamp reason above.

3. **`pages/LeadDetailPage.tsx` - new `onError` destructive toast** on the status mutation.
   `lib/axios.ts` intercepts only 401, 429 and 402, so a rejected status change previously closed the
   menu and did nothing visible at all. Failures that were silent are now surfaced. Expect this to be
   the change most likely to generate a "new error" report that is really an old error becoming
   visible.

4. **`lib/filters/registries/invoices.ts` - `DISPUTED` added to a live filter dropdown.** New
   user-visible option in the Invoices Status facet. A disputed invoice was previously unfilterable from
   the UI even though the backend facet accepted the value.

5. **`components/copilot/tools/toolRegistry.ts` - `SUPERSEDED` newly advertised** to the LLM as a valid
   estimate status filter. Servy previously reported that this status did not exist while
   `/api/estimates` would have filtered on it happily.

6. **`components/inventory/POPreviewDialog.tsx` and `StagePreviewDialog.tsx` - `ring-1` becomes
   `border`.** Ten chips (five purchaseOrder, five stage) grow about 2px on each axis, because `ring`
   paints outside the border box and `border` sits inside it. The hairline itself is preserved; only its
   geometry changes. The `sent` row's hairline alpha also moves from 30% to 20%.

7. **`components/layout/search-shared.tsx` - fourteen of fifteen lead and job status labels change** in
   GlobalSearch and ScheduleSearch. Eleven are case-only (`EN ROUTE` -> `En Route`); three are semantic
   and are escalated as SR-E6. Two dot fills also shift sub-perceptually (danger `#BF5A4C` ->
   `#BB584A`, info `#3B82F6` -> `#3473DA`).

### Deliberately NOT changed

Recorded so a reviewer does not read them as oversights.

- **Two pre-existing inert-border sites left alone.** `pages/reports/InvoicesReport.tsx:33-37` and
  `components/timeclock/EmployeePayrollCard.tsx`'s `OtPill` BOTH already emitted `border-*-border` with
  no `border` width class at origin/staging. They are not collateral of this change set and are not
  touched.
- **`lib/filters/registries/estimates.ts` `ESTIMATE_STATUS_LABELS` not migrated**, held on SR-E1, even
  though its three sibling registries were. Annotated in place rather than changed.
- **`TimesheetsReport`'s `in_zone` pill given no registry domain.** `PunchStatus` is correctly excluded
  from the registry; the pill takes `STATUS_INTENT_CLASSES.success` directly as a token-role fix.

---

## Deferred

Status surfaces deliberately NOT brought into the registry by this work package, each with the reason.
`design-system/status-registry.ts` points here.

| item | where | why deferred |
|---|---|---|
| `PublishControl`'s `LivePill` | `components/workflows/PublishControl.tsx:37-49` | It splits the `workflow` domain's LIVE along a SECOND axis (has-unpublished-changes) that no other consumer has. Modelling it would either add a non-status key to the `workflow` map or force every consumer to carry a flag. Needs a design call on whether the registry models sub-states at all. **Cost of the deferral, stated:** it leaves TWO different greens live for one LIVE state. `LivePill`'s up-to-date branch paints the 10% composite (`bg-success/10 text-success`), while `workflow-visuals.tsx:136` renders the same LIVE workflow through `StatusBadge` onto the ratified success surface. Same state, two greens, on adjacent surfaces. Deferring is still the right call, but it is not free. |
| Chart-series colour role | reports and dashboard charts | A chart palette is a different system from a badge palette: it optimises for mutual distinguishability across N series, not for surface/text contrast pairs. Wrong problem for this registry. |
| `deposit` domain's four dead entries | `status-registry.ts` `DEPOSIT_STATUS` | The domain has NO PRODUCER: neither backend select feeding the two `domain="deposit"` call sites carries a deposit relation, so both badges are unreachable. Deleting the entries means deleting those call sites and the local `Deposit` interface in `EstimatesPage`, a behaviour change in files this work package does not own. The deposit FILTER facet is genuinely live, so the labels are not dead in every sense. Kept and documented rather than removed. |
| `emailAccount.error` masking | `EmailSettingsPage` | The entry was ADDED (the domain was lying by omission), but the page still collapses anything non-active to `reauth_required` before the badge renders, relabelling a hard connection error as "Reconnect needed". Removing that collapse is a behaviour change in a file this work package does not own. |
| `estimate` labels in global search | `components/layout/search-shared.tsx` | Held on SR-E1, not on scope. Routes through the registry the moment SR-E1 is adjudicated. |

---

## Known survivors

This section replaces a row that used to sit in `## Deferred` reading "Left-accent / border-only intent
role | wanted by the schedule boards and the dashboard's `TodaySchedule`". That framing was misleading
in two ways. It named ONE missing role as the whole gap, when three of the four schedule surfaces spell
chip surface, chip text AND a user-facing label, all three of which the registry already provides. And
it listed only two of the twelve surfaces documented below that still map a status to an appearance
or a label outside the registry.

A survivor is a status-to-appearance or status-to-label map that this branch leaves in place. Listing
them is what makes the PR claim checkable.

This table is DOCUMENTED, NOT EXHAUSTIVE, and the difference matters because an unqualified count reads
as a complete sweep. A round-4 review found at least three more of the same shape that are not rowed
here: `pages/LeadsPage.tsx` `getWalkthroughDisplay` (the list-view twin of WalkthroughDot),
`pages/EstimatesPage.tsx` KPI tile tones over the whole EstimateStatus vocabulary (SENT reads brand
where the registry says info), and `pages/InvoicesPage.tsx` due-state tones. None changes appearance in
this branch. Treat the count below as "twelve found and reasoned about", not "twelve that exist". The "contradicts registry" column is the one that matters:
a survivor that AGREES with the registry is only duplication, while a survivor that DISAGREES means the
same status has two answers in shipped code today.

Line numbers are as of this pass and will drift; the symbol name is the durable pointer.

| survivor | where | contradicts the registry TODAY? | disposition |
|---|---|---|---|
| `pillStyle` | `pages/dashboard/widgets/TodaySchedule.tsx:48-54` | YES. In-flight statuses read info, the registry says warning. Labels also diverge: `Done` vs registry `Completed`, and the fallback `Scheduled` is applied to UNASSIGNED jobs where the registry says `Unscheduled`. | Not migrated. The pill is one composite treatment (row wash + left accent + inset tag + copy) painted on two axes, event type first and job status second. Migrating only the tag yields a blue pill with an amber tag inside it, strictly worse than either end state. The label half alone would be a live copy change on three strings and is filed as SR-E7 rather than shipped. |
| `boardCardScheme` consumer | `components/schedule/MemberWeekBoard.tsx:105-109` | YES, and it INVERTS: completed reads neutral grey where the registry says success, and the three in-flight statuses read green where the registry says warning. | Not migrated, de-duplicated only. The scheme is hoisted into `scheduleModel.ts` so one copy exists, with a comment saying it deliberately does not resolve through the registry. Zero pixel change. |
| `boardCardScheme` consumer | `components/schedule/TechnicianGridView.tsx:139` | YES, identically - this was a byte-identical second copy of the block above. | Same. It now consumes the hoisted helper. Zero pixel change. |
| `eventStyleGetter` | `pages/SchedulePage.tsx:1187-1205` | YES. Completed reads `text-soft`, in-flight reads solid info; the registry says success and warning. | Comment only, no code change. Same three-axis system expressed as react-big-calendar `!` overrides. |
| `WalkthroughDot` | `pages/LeadDetailPage.tsx:175-183` | YES. It reads `WALKTHROUGH_SCHEDULED` as informational; `STATUS_REGISTRY.lead.WALKTHROUGH_SCHEDULED` is warning. A naive migration would repaint the blue dot amber. | Kept local under the registry's own inclusion rule (c): one declaration, one call site, so the "two or more places spell the same mapping" test fails. Its 16 cells are enumerated in section 14b. |
| status KPI tile tones | `pages/JobsPage.tsx:407-410` | YES, on all four: UNASSIGNED warning, SCHEDULED primary, IN_PROGRESS success, COMPLETED success, against the registry's warning / warning / warning / success. | Not migrated. Different role - a count tile, not a status badge - and lower weight. Pre-existing, out of this branch's diff. Listed so it is not mistaken for coverage. |
| `STATUS_STYLE` | `pages/reports/SalesReport.tsx:165-172` | No. Its keys are report buckets (`Submitted`, `In progress`, `Pending`, `Done`, `done pending`, `Canceled`), not enum values, so there is nothing for the registry to disagree with. | Not migrated, pre-existing. Note four sibling reports already key `STATUS_INTENT_CLASSES` directly, so the token half of this is already convergent elsewhere and this file is the outlier. |
| `STATUS_STYLE` | `pages/reports/PaymentsReport.tsx:58-63` | No, same reason: `Succeeded` / `Pending` / `Failed` / `Refunded` is a payments report taxonomy. | Same. |
| `STATUS_PILL` | `pages/MarketingAnalyticsPage.tsx:107-111` | No. `good` / `watch` / `bad` is a performance verdict, not a status enum. | Same. |
| `filterTabs` | `components/inventory/StagingView.tsx:79-85` | Labels only, no appearance - but the labels DO diverge: tab `complete` reads `Ready` while tab `ready_for_pickup` reads `Ready for pickup` (two tabs both opening with "Ready", for different states), `awaiting` reads `Awaiting` against registry `Awaiting all parts`, `partial` reads `Partial` against the registry's longer string, and `delivered` has no tab at all. | Not migrated. A filter-tab vocabulary is a deliberately terser register than a badge label, the same reasoning already applied to `StageDetailDialog`'s select options. The divergence is a copy conflict and is filed as SR-E8 rather than reworded inside a refactor. |
| `StateChip` | `components/communication/shared/atoms.tsx:73-80` | Not applicable. Comms vocabulary (`Approved` / `Paid` business states on a comm row), not one of the registry's domains. | Not migrated. Bringing it in would mean inventing a comms domain, which is a modelling decision, not a consolidation. |
| `LivePill` | `components/workflows/PublishControl.tsx:37-49` | YES, in effect: it leaves two different greens live for the single `workflow.LIVE` state. See the `## Deferred` row for the full reason and cost. | Deferred with a real reason, recorded in both places. |

### What the PR may claim

Not "one registry, one answer for every status". The accurate claim, and the one the tables above
actually support:

> `STATUS_REGISTRY` is the single source of truth for the domains it owns, at the surfaces listed in
> the appearance table. Twelve surfaces are documented survivors, seven of which contradict the
> registry today and are listed with the reason each was left alone. That list is what was found and
> reasoned about, not a proof that no other survivor exists.

Count derivation, from the "contradicts" column above: YES on `TodaySchedule`, `MemberWeekBoard`,
`TechnicianGridView`, `SchedulePage`, `WalkthroughDot`, `JobsPage` and `PublishControl` = 7. No on the
three report taxonomies. `StagingView` is labels-only (a copy divergence, SR-E8, not a colour
contradiction) and `StateChip` is outside every registry domain.

The unqualified form must not be used. Seven survivors disagree with the registry in shipped code, so
a reader who took the unqualified claim at face value would be surprised by the schedule boards on
their first look at the app.

---

## Program-plan record - parallel track CLOSED 2026-07-28

### Why this record lives here and not in the program plan

`md_files/plans/frontend/2026-07-27-ui-component-architecture-program.md` **does not exist at
`origin/staging`**, which is this branch's base. It exists in two other places, neither of which this
branch may write to:

| copy | state | md5 |
|---|---|---|
| main checkout working tree | untracked, rev 2 | `e4a3491ff515d7984b5974c7b69ce2b2` |
| `refactor/ui-phase-7-tracer` commit `1817e7841` | committed, rev 3 (W1's design phase) | `13795de9cdcceb6abf0c75365ae99653` |

`refactor/ui-phase-7-tracer` is a LOCAL branch and is not pushed to `origin`. Rev 3 is 785 diff-lines
ahead of rev 2: it carries W1's re-derived §1 corrections and the settled §2a vocabulary.

Adding a copy of that file on this branch would therefore create an **add/add conflict** on a
1,100-line document that a live session owns, with no common ancestor for git to merge against.
Basing this branch's copy on rev 2 would additionally invite a resolver to discard rev 3's
corrections. Neither is acceptable, so the required content is recorded here instead, in a form that
can be pasted into the program plan's `### Parallel track - Meaning layer` section verbatim once that
file reaches `staging` by its own route.

**Action for whoever lands the program plan:** replace the three-line `### Parallel track - Meaning
layer` stub with the block below. Nothing else in the program plan changes.

### Paste-ready replacement for `### Parallel track - Meaning layer`

> ### Parallel track - Meaning layer - DONE 2026-07-28
>
> Shipped on `refactor/ui-status-registry` as one PR into `staging`. Full work package, appearance
> table, escalations and survivor analysis:
> `md_files/plans/frontend/workflows/2026-07-27-wp-status-registry.md`.
>
> `STATUS_REGISTRY` grew from 16 domains to 18 (`taskPriority` and `timeclockReview` added) and from
> 80 to 89 entries. It is now the single source of truth for the domains it owns, at the surfaces
> listed in the appearance table. It is NOT a claim that no status map survives anywhere - fifteen
> survivors are documented, seven of which contradict the registry in shipped code today.
>
> A schema guard (`design-system/__tests__/status-registry-schema-guard.test.ts`, 72 assertions)
> parses `backend/prisma/schema.prisma` and enforces the bijection in BOTH directions across the
> twelve enum-backed domains, and additionally pins the copilot tool vocabulary to the Prisma enum
> in declaration order. Proven red on a deleted registry entry, on an added schema value and on a
> renamed schema value; proven green when each is restored.

### The real count of status maps, against the plan's estimate of ~53

The plan's `~53` was an estimate made before the inventory phase ran. It was never re-derived. The
measured figure is **43 status-to-appearance or status-to-label maps found and reasoned about**, of
which 26 were collapsed onto the registry.

| bucket | count | how it was measured |
|---|---:|---|
| named map declarations deleted | 20 | `git diff origin/staging \| awk` over removed `const`/`export const` declarations, attributed per file |
| inline maps eliminated | 2 | `LeadDetailPage`'s `completedStatuses` allowlist; `TimesheetsReport`'s inline review ternary |
| hand-spelled vocabularies now derived | 4 | the four `leads` / `jobs` / `estimates` / `invoices` lists inside `toolRegistry.ts`'s single description string |
| **collapsed onto the registry** | **26** | |
| duplicate blocks de-duplicated, deliberately NOT registry-resolved | 2 -> 1 | `MemberWeekBoard` + `TechnicianGridView` byte-identical scheme blocks, hoisted to `scheduleModel.boardCardScheme` |
| documented survivors | 15 | 12 rowed in `## Known survivors` + 3 named in that section's round-4 note |
| **total found and reasoned about** | **43** | |

The 20 deleted declarations, verbatim from the diff:

```
components/inventory/PODetailDialog.tsx        statusDef
components/inventory/POPreviewDialog.tsx       statusTone
components/inventory/PrePODetailDialog.tsx     statusChip
components/inventory/StagePreviewDialog.tsx    statusTone
components/jobs/JobStagesSection.tsx           STATUS_META
components/layout/search-shared.tsx            INTENT_DOT
components/tasks/PriorityDot.tsx               PRIORITY_CONFIG
components/tasks/TaskDetailDrawer.tsx          STATUS_LABELS
components/timeclock/EmployeePayrollCard.tsx   OT_REVIEW_INTENT
lib/api/service-plans.ts                       STATUS_LABEL
lib/filters/registries/estimates.ts            DEPOSIT_STATUS_LABELS
lib/filters/registries/invoices.ts             INVOICE_STATUS_LABELS
lib/filters/registries/jobs.ts                 JOB_STATUS_LABELS
lib/filters/registries/leads.ts                STATUS_LABELS
pages/LeadDetailPage.tsx                       LEAD_STATUSES
pages/LeadDetailPage.tsx                       STATUS_LABELS
pages/LeadsPage.tsx                            LEAD_STATUSES
pages/tasks/views/BoardView.tsx                COLUMN_LABELS
pages/tasks/views/CalendarView.tsx             STATUS_DOT
pages/tasks/views/CalendarView.tsx             STATUS_CHIP
```

**43 is a floor, not a census.** `## Known survivors` says so explicitly: its table is documented,
not exhaustive, and a round-4 review found three more of the same shape after the count was first
written. The honest statement is "43 found and reasoned about", never "43 exist".

### Judgment calls

Recorded because each one is a place a later reader could reasonably conclude the work was done
wrong, and the reason is not visible in the diff.

**Deviations from a literal instruction, each because the literal form was wrong**

1. `LeadDetailPage` - the specified `toast.error('Could not update the lead status')` would not
   compile. This file imports `toast` from `@/components/ui/use-toast`, the shadcn reducer toast,
   which has no `.error` method - the literal instruction is a TS2339. Implemented with the shape the
   file already uses at `createJobMutation.onError`: title verbatim as specified, description via
   `extractApiError`, `variant: 'destructive'`.
2. `LeadsPage` - the prescribed import of the shared `LEAD_STATUSES` was NOT added. The local copy
   had exactly one occurrence, its own declaration, and eslint already flagged it unused. Importing a
   symbol nothing consumes would add a lint warning and a phantom dependency edge. Pure deletion
   reaches the same goal with less code.
3. `InvoicesReport` - the generic "delete the local map" boilerplate was refused. It contradicts the
   same task's own body ("exactly ONE line changes") AND `status-registry.ts`'s header rule that
   report re-bucketings are deliberate reporting taxonomies. Verified factually: `invoices-data.ts`
   defines five Title-Case buckets (`Paid`/`Due`/`Overdue`/`Unsent`/`Partial`) with ZERO key overlap
   against the registry's nine SCREAMING_SNAKE invoice keys. Deleting the map would not compile and
   would break the sort, the CSV column, four KPI toggles and the Status filter.
4. `GlobalSearch`, `ScheduleSearch`, and the four test fixtures - "delete the local map" had no
   referent; these files have no map. Reported rather than satisfied with a cosmetic unused import.

**Design choices inside the registry migration**

5. `JobStagesSection` - introduced `STAGE_LABEL_OVERRIDES` (copy-only, 4 keys) instead of adopting
   the registry's labels. Adopting them would silently change four user-facing strings and import an
   em dash into a file whose task forbids one. The registry owns colour; the surface keeps its copy
   until SR-E4 and SR-E2 are adjudicated.
6. `PrePODetailDialog` - kept an explicit 3-key label map rather than an override-only map merged over
   registry labels. An override map hides which labels actually render, and the two "matching" labels
   would then silently follow any future registry rewording.
7. `search-shared` - the estimate hold is enforced by a literal `domain === 'job' || domain === 'lead'`
   guard, not by a generic `STATUS_REGISTRY[RESULT_DOMAIN[entityType]]` resolver. The generic form
   would have silently routed estimates and landed SR-E1's contested string in a compact meta row.
8. `EmployeePayrollCard` - declined the optional half of the task (sourcing the label from the
   registry). The two are equivalent only AFTER CSS `capitalize` runs; the registry label would change
   the DOM text node, which is what every RTL `getByText` and accessibility name reads. Colour
   migrated, label left.
9. `TimesheetsReport` - the `in_zone` pill was given `STATUS_INTENT_CLASSES.success` directly with NO
   registry lookup. `PunchStatus` is a geofence outcome, correctly in `EXCLUDED_ENUMS`; inventing a
   domain for it would be modelling, not consolidation. Leaving it on the raw 10% composite would have
   put two different greens side by side in one column once the Override pill moved.
10. `toolRegistry` - took the derivation, not the minimum fix. Just adding `SUPERSEDED` leaves the
    drift mechanism intact; this file was the fifth hand-written copy of these vocabularies.
11. `invoices.ts` - KEPT the `DISPUTED` addition rather than dropping it. The instruction was to drop
    it if the backend rejects it; a three-point check (Prisma enum member, facet validates against the
    enum, no route-level Zod narrowing) showed the endpoint accepts it, so a disputed invoice was
    genuinely unfilterable from the UI.
12. `service-plans.ts` - left a 4-line pointer comment where the dead `STATUS_LABEL` map was, instead
    of a bare deletion. The map had zero importers precisely because nothing pointed anywhere, and the
    next person needing a service-plan label in this module is the one most likely to write copy five.

**Evidence-method choices**

13. The guard's red/green proof was re-derived by the ship agent in a scratch copy of the tree
    (`rsync` of `frontend` plus `backend/prisma/schema.prisma`, symlinked `node_modules`), NOT by
    mutating the shared worktree. `git status --porcelain backend/` is empty afterwards.
14. The prescribed guard mutations - delete a registry entry, add a schema enum value - BOTH trip only
    the FORWARD assertion. A third mutation (`AssetStatus.RETIRED` -> `MOTHBALLED`) was added because
    it is the only one that fires the REVERSE assertion. Without it the guard would have shipped with
    one direction never once proven red.
15. Appearance evidence is a static class-string resolution table, not screenshots. Session W1 owned
    the Playwright harness and the dev servers for the duration, and a static table is exhaustive
    where a screenshot pass is sampled.

**Objections raised in review and REJECTED, with the reason**

16. REJECTED: "hoist the `text-text-primary` override out of the `CalendarView` TODO chip so the chip
    matches the other three." Refused, and the refusal was verified empirically rather than argued:
    running the project's real `cn()` (tailwind-merge + clsx) shows twMerge keeps the TRAILING text
    class, so hoisting silently loses the revert and drops the TODO chip's ink from `#10202B` (13.4:1)
    to `#5E707B` (4.54:1) - the single largest contrast delta in the change set. The override stays,
    with a call-site comment saying why.
17. REJECTED: "`WALKTHROUGH_SCHEDULED` carries the same PATCH hazard as `WALKTHROUGH_COMPLETED`, so
    drop it from the settable list too." Refused: it was offered before this branch, so removing it is
    a behaviour regression, not a fix. Filed rather than shipped.
18. REJECTED: "reorder `WalkthroughDot` to test the timestamp first, since completion is the stronger
    signal." Refused: `scheduleWalkthrough` (`lead.controller.ts:1448`) explicitly permits scheduling
    FROM `WALKTHROUGH_COMPLETED`, and nothing anywhere clears `walkthrough_completed_at` - not
    unschedule, not cancel. Timestamp-first paints a future-dated walkthrough as done. Status-first is
    load-bearing and is now covered by the 16-cell matrix in section 14b.
19. REJECTED: "exclude `SUPERSEDED` from the copilot vocabulary, because `estimateStatus.ts` calls it
    a D1 legacy-only value." Refused as incoherent rather than wrong: that constant is the WRITE-side
    vocabulary and does not gate the read-side facet, and the pre-existing description already
    advertised `EXPIRED`, which the same D1 note calls equally legacy-only. Excluding one and keeping
    the other would be arbitrary. Flagged as a product call: if Servy should not surface D1 legacy
    statuses at all, `EXPIRED` must go too, and that is a decision about what the agent may say.
20. REJECTED: "convert the migrated `<span>` chips to `<StatusBadge>` while you are in there." Refused
    in every one of the six chip files. Converting changes radius, size, weight and casing on top of
    the tint swap and makes the before/after table unverifiable. Composition is W3's work package.
21. REJECTED: "paint the filter facet options with the registry's intents now that they resolve
    through it." Refused: `FacetOption` supports a `swatch`, so it was easy to justify, but it is a
    visible appearance change inside a migration whose contract is zero appearance delta.
22. ACCEPTED, recorded so the rejections above are not read as blanket defensiveness: round 1's
    objection that the before/after table measured the REGISTRY rather than the CALL SITES was correct
    and the table was rebuilt from scratch. Round 2's objection that four BEFORE hexes were computed
    over the wrong backdrop was correct. Round 3's objection that only one of `boardCardScheme`'s two
    consumers had been migrated was correct. Round 4's objection that a page comment and the survivors
    table overclaimed was correct. All four were fixed, not argued.

### Verification rounds

Four adversarial rounds ran against this branch. Two of them refuted it.

| round | verdict | what it caught |
|---|---|---|
| 1 | REFUTED, major, 2 of 3 lenses | the before/after table measured the REGISTRY, not the CALL SITES, so it reported "no change" for 13 rendered statuses across 6 domains that did change - two of them hue flips |
| 2 | REFUTED, major | table rebuilt at call-site level and correct, but four BEFORE hexes were computed over `#FFFFFF` when the chip sits on `#EEF1F3`; separately, a `WalkthroughDot` rewrite ordered timestamp-first, painting a re-scheduled walkthrough "completed" green |
| 3 | refuted, moderate | `boardCardScheme` was added but only ONE of its two consumers was migrated, while four artifacts claimed both had been |
| 4 | claim accuracy only | a page comment and the survivors table both overclaimed; the survivors table is now marked documented-not-exhaustive |

The evidence base was rebuilt twice. A reviewer should weigh the current tables accordingly: they are
third-generation, not first-draft.
