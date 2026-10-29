# ServWave Design System

The human reference for the ServWave ("Calm Intelligence 2.0") visual system on the
`servwave` branch. It documents the token tiers, the full token table, the
reconciliation rule, the component + chart catalog, and the page-cleanup checklist.

> **To re-theme the app, edit `src/design-system/tokens.css` — nothing else.**
> Every color, radius, and shadow in the app resolves to a CSS custom property
> defined there. Change a value once and the whole app re-themes. Components and
> charts never hardcode a hex or a raw px radius.

---

## 1. Token tiers — where to change things

Three tiers, one source of truth (`src/design-system/tokens.css`):

| Tier | What | Example | You edit this when… |
|------|------|---------|---------------------|
| **1 — Primitives** | Raw palette, no meaning. Colors stored as **space-separated RGB channels** (`12 45 58`) so Tailwind can compose opacity (`bg-primary/10`). | `--ocean-800: 12 45 58;` | You want to retune a brand hue or add a new shade. |
| **2 — Semantic aliases** | Meaning, theme-aware. Reference primitives only. | `--primary: var(--ocean-800);` `--success: var(--green-700);` | You want to remap meaning (e.g. point `--primary` at a different primitive). |
| **3 — Consumption** | `tailwind.config.js`, components, charts read the tokens. **Never** hardcode a hex/px here. | `bg-primary`, `text-success`, `token('--primary')` | Building UI — you only consume, never define. |

**The plumbing (do not duplicate values into these — they read from tokens.css):**

- `src/design-system/tokens.css` — **the source of truth.** `:root` primitives + semantic aliases; `.dark` overrides.
- `src/design-system/tokens.ts` — typed, SSR-safe `token('--name')` accessor for JS/charts (Recharts, inline SVG, canvas) + `chartPalette` / `severityRamp`. Carries a static hex fallback map that **mirrors** tokens.css (used only in jsdom/SSR before CSS applies).
- `src/design-system/index.ts` — barrel: `import { token, chartPalette, severityRamp } from '@/design-system'`.
- `frontend/tailwind.config.js` — maps utility classes to `rgb(var(--…) / <alpha-value>)`; class names are unchanged from stock Tailwind/shadcn.
- `frontend/src/index.css` — imports `tokens.css` before the Tailwind layers.

Components consume **semantic** tokens (`--primary`), never primitives (`--ocean-800`).

---

## 2. Full token table

Values below are authoritative as of the current `tokens.css`. The hex in the
"Hex" column is the human-readable rendering of the RGB channels.

### Semantic colors (use these)

| Token / utility | Primitive | Hex | Meaning — when to use |
|-----------------|-----------|-----|------------------------|
| `--primary` / `bg-primary` | `--ocean-800` | `#0C2D3A` | Deep Ocean. Generic UI chrome + everyday interactive anchor: nav, buttons, links, tab underline, focus rings, selection. |
| `--primary-dark` | `--ocean-900` | `#071F2B` | Hover/pressed ocean. |
| `--primary-light` | `--ocean-700` | `#123F50` | Lighter ocean accent. |
| `--primary-subtle` | `--ocean-subtle` | `#E8EEF0` | Ocean tint chip / subtle fill. |
| `--success` / `text-success` | `--green-700` (sage-700) | `#2F7D5D` | Sage. **Business / approved / won / paid / completed**, and **positive data signals only.** Never chrome or nav. |
| `--warning` / `text-warning` | `--amber-700` | `#B45309` | Amber. In-flight / pending / sent / scheduled / expiring (status only). |
| `--danger` / `text-danger` | `--terracotta` | `#BF5A4C` | Terracotta. Loss / overdue / declined / disputed / destructive. |
| `--ai` / `text-ai` (`ai-600`) | `--indigo-600` | `#5B6DFF` | AI lavender→indigo. **AI moments only.** |
| `--info` | `--info` | `#3B82F6` | Info (status only). |
| `--notify` / `bg-notify` | `--notify-rose` | `#F43F5E` | Bright rose. **Notification-count badges ONLY** — never a general danger red. |

### Text & borders

| Token | Hex | Use |
|-------|-----|-----|
| `--text-primary` (`--ink`) | `#10202B` | Primary text. |
| `--text-secondary` (`--neutral-500`) | `#667985` | Secondary / labels / captions. |
| `--text-soft` (`--soft`) | `#8A9AA5` | Soft / least-emphasis text. |
| `--border-color` (`--line`) | `#E4E8EC` | Standard 1px borders / hairlines. |
| `--border-soft` | `#EEF1F3` | Softest divider / track. |

### Surfaces

| Token | Hex | Use |
|-------|-----|-----|
| `--canvas` / `--background-light` | `#EEF1F3` | App canvas (light). |
| `--surface` / `--surface-light` | `#FFFFFF` | Cards / sheets. |
| `--background-dark` | `#111827` | Dark canvas (`.dark`). |
| `--surface-dark` | `#1F2937` | Dark surface (`.dark`). |

**Component surface treatments** — the one place to retune these app-wide. Every table header (`data-table.tsx`, `ResizableTable.tsx`, incl. pinned/sticky cells) and every card section header (`SectionCard.tsx`) reads these tokens; no component hardcodes the colour. Utilities: `bg-table-header`, `bg-card-header`.

| Token | Default | Use |
|-------|---------|-----|
| `--table-header` | `#F3F5F7` (faint cool tint) | List/table column-header + pinned-header background. Change here → every table retints at once (set to `var(--surface)` for white, no-fill headers). |
| `--card-header` | `#F3F5F7` (faint cool tint) | Card section-header band (`SectionCard`). Set to `var(--surface)` for white headers everywhere. |

### Semantic tints (soft fills, status badges)

| Token | Hex | | Token | Hex |
|-------|-----|---|-------|-----|
| `--green-bg` | `#EEF8F2` | | `--red-bg` | `#F7ECEA` |
| `--amber-bg` | `#FBF1E5` | | `--indigo-bg` | `#F3F0FF` |

In components, prefer the opacity form (`bg-success/10`, `bg-danger/10`,
`bg-warning/10`, `bg-primary-subtle`) over the `*-bg` primitives — it stays
theme-aware via the channel format.

### Chart tints (categorical / ramp helpers)

| Token | Hex | | Token | Hex |
|-------|-----|---|-------|-----|
| `--green-mid` | `#6EA886` | | `--green-light` | `#B9D9C8` |
| `--amber-light` | `#E7B666` | | | |

### Radii

Radius is **6px everywhere** (cards / buttons / inputs / badges) via tokens; icon tiles use 5px.

| Token / utility | Value | Use |
|-----------------|-------|-----|
| `--radius-card` / `rounded-card` | `6px` | Cards, surfaces, tiles. |
| `--radius-control` / `rounded` | `6px` | Buttons, inputs, selects. |
| `--radius-badge` | `6px` | Status badges. |
| `--radius-ic` / `rounded-ic` | `5px` | Icon tiles. |
| `rounded-full` | — | **Reserved**: notification-count badges, avatars, switches **only** — never status badges. |

### Shadows

| Token / utility | Value | Use |
|-----------------|-------|-----|
| `--shadow-card` / `shadow-card` | `0 8px 24px rgb(12 45 58 / 0.06)` | Default card elevation. |
| `--shadow-soft` | `0 4px 12px rgb(12 45 58 / 0.04)` | Subtle lift. |
| `--shadow-hover` | `0 12px 32px rgb(12 45 58 / 0.10)` | Hover elevation. |
| `--shadow-inset` | `rgb(0 0 0 / 0.16) 0px 1px 1.9px 0px inset` | Inset detail. |

### Technician-mobile theme (`--tech-*`)

A **separate namespace** (`--tech-bg`, `--tech-primary`, `--tech-interactive`,
`--tech-accent`, `--tech-text*`, `--tech-border`, `--tech-surface`). It is **not**
part of the ServWave re-skin and has its own palette. Do not retune it when
changing ServWave tokens.

---

## 3. Reconciliation rule (read before picking a color)

We keep **ocean as primary** (not a green primary). So:

- **Deep Ocean `#0C2D3A` (`primary`)** = generic UI **chrome / interactive**: tab
  active underline, focus rings, links, selection, nav, default buttons.
- **Green `#2F7D5D` (`success` / sage-700)** = **business / approved / success**
  and **positive data signals only** (won / paid / completed / "up" trend).

Do **not** invert to a green primary, and do **not** use green for chrome or nav.
AI lavender (`ai-600`) is for AI moments only; notification rose (`notify`) is for
unread-count badges only.

---

## 4. Component catalog

All live in `src/components/ui/` unless the File column says otherwise. They
consume semantic tokens; pass extra classes via `className`.

| Component | File | Key behavior |
|-----------|------|--------------|
| **Button** | `button.tsx` | Variants: `default`=ocean (everyday anchor), `business`=sage (the one forward-motion CTA per page: create/save/send/approve/record-payment), `ai`=lavender→indigo gradient (AI only), `destructive`=terracotta, plus `outline`/`secondary`/`ghost`/`link`. 6px radius, focus ring = `primary`. |
| **Text** | `text.tsx` | The inline / block copy primitive. Heading owns the document outline, Text owns everything else that paints type. `as` span (default) / p / div - `size` 3xl / base / sm / xs / 3xs - `tone` primary / secondary / brand / danger / success / neutral - `weight` medium / semibold / bold - `align` left / center / right - `transform` uppercase - `tracking` wide. **Two rules that are load-bearing:** `size="base"` emits no class at all, it means "inherit the ancestor's size" (the alternative silently jumps every inheriting site to 16px), and no axis has a default, so a propless `<Text>` paints nothing and can be adopted before its axes are named. |
| **TextLink** | `link.tsx` | Inline text that navigates. Distinct from Button `variant="link"`, which is a 40px-tall inline-flex control and not inline text at all. `asChild` renders the child instead of an anchor, so one primitive serves both a react-router `<Link>` and a bare `<a href="tel:">`. `tone` brand (idle colour) - `hoverTone` brand (hover colour, a separate axis because the measured sites split between setting one and setting the other) - `weight` medium - `size` xs - `underline` hover (default) / none. |
| **Icon** | `icon.tsx` | A lucide glyph with a named box and a named colour. `as` = the glyph component, required - `size` = a 4px-grid step (2.5 through 12) emitting the square width/height pair - `tone` brand / secondary / primary / danger / success. Neither axis has a default: an Icon that says nothing inherits its colour and keeps whatever box the call site gave it. lucide's own pixel-count `size` is deliberately shadowed and omitted from the prop type so the collision cannot be reached by accident. |
| **Card** | `card.tsx` | `rounded-card border border-border bg-white shadow-card`, ink text. Sub-parts: `CardHeader/Title/Description/Content/Footer`. Padding via `pad`/`padX`/`padY` step numbers (legacy `padding` word scale still live alongside them). See §4.1 - Card is the one primitive still carrying its own copy of the padding maps. |
| **Surface** | `surface.tsx` | The tinted, bordered, padded container a banner or callout is made of - the shape Card cannot be, because a banner's copy takes the tone with it while Card deliberately leaves its content's colour alone. `tone` danger / neutral, painting fill, border colour and **text** colour as one triple - `bordered` bool, which sets the border *width* only, so a tinted-but-unoutlined surface and an untinted-but-outlined one are both expressible - `radius` lg - `accent` danger / success, the 2px left marker, coloured with the tone's *text* token rather than its border token because those are deliberately different values - plus the seven padding props from §4.1. |
| **Badge** | `badge.tsx` | 6px (not pill). `variant`: `default`=ocean, `secondary`=neutral tint, `destructive`=terracotta, `outline`, plus phase 7's `subtle` (the neutral fill and nothing else - no border colour, no text colour, so a chip inside a table cell keeps inheriting the cell's colour) and `bare` (paints nothing on top of the base at all). `intent` resolves a meaning through the status registry instead of hand-rolling a colour; prefer `StatusBadge` whenever the status has a domain entry to look up. Phase 7 also adds `padX` (a step number that **overrides** the base horizontal padding through twMerge, leaving the vertical half alone so the chip keeps its height), `weight` medium, `interactive` (the hover fill only - it paints, it does not make the element clickable) and `asChild`. **One thing that is not free, and is asserted rather than assumed:** Badge's base makes the element an inline-level flex container, so an ordinary inline chip adopting it gains an atomic box whose height includes its vertical padding. That is a rendered change. See §4 of `__tests__/badge.test.tsx`, which proves the shipped inline chip is reconstructible from props alone and pins exactly what the reconstruction costs. |
| **Separator** | `separator.tsx` | A rule, drawn one of two ways. `variant` solid (default; a 1px background-filled box) / dashed (drawn as a border, because a dash pattern is a property of a border and no background fill can produce it) - `tone` default / danger, which applies on the dashed branch **only** and is inert on solid. The two branches deliberately share no sizing utility: a filled box needs an explicit 1px on its thin axis, a border-drawn rule already has one, and emitting both would stack into a 2px rule. |
| **StatusBadge** | `status-badge.tsx` | The status mapper. 4 semantic tones by **meaning**: GREEN `bg-success/10 text-success` (won/approved/paid/completed), AMBER `bg-warning/10 text-warning` (in-flight: new/contacted/sent/scheduled/in-progress/expired), DANGER `bg-danger/10 text-danger` (lost/overdue/declined/disputed/refunded), GRAY `bg-background-light text-text-secondary` (draft/cancelled/voided). Add new statuses to `statusConfig` by meaning. |
| **Table** | `data/table.tsx` | Uppercase ~10.5px/700 muted header, **no fill**, hairline bottom border; 14px body cells; 1px row divider (last row drops it). Money columns right-align per column via `align="right"`, never globally. Phase-7 axes, one **bundle per measured header/cell signature** rather than one axis per class in the default string: `Table` `wrapper` auto / x / none - `TableBody` `divider` none / hairline (the section draws the rules at half strength instead of the rows) - `TableFooter` `variant` default / bare - `TableRow` `tone` default / danger, `divider` hairline / none, `muted`, `interactive` - `TableHead` `variant` default / plain / compact plus `align` - `TableCell` `tone` default / muted / highlight, `align`, `scale` sm / xs, `weight` normal / medium / semibold, `divider`. Both cell exports also take the seven padding props from §4.1, and a caller that passes **any** of them **replaces** that variant's default padding set outright rather than merging with it - merging would re-add a side the caller never wrote. |
| **Combobox** | `combobox.tsx` | The searchable branch of a dropdown, and a **sibling** of Select rather than a flag on it - Radix Select owns focus and its own typeahead, so a text input cannot live inside it. Popover + Input + listbox. Multi-field matching, pinned input, keyboard path (arrows / Enter / Esc), named empty state, optional `onCreate` for a list the user can add to - one fixed `+ Create …` row pinned below the options, outside the scroll area, with a constant label. Call sites do not reach for this directly - they use `SelectField`, which picks the branch by count. See §4.2. |
| **SelectField** | `form/SelectField.tsx` | The one dropdown entry point (100 call sites / 56 files). Options as a flat `{ value, label }[]`, and **because it can count them it applies §4.2 itself**: `>= 10` renders Combobox, `< 10` renders `Select`. No call site declares anything, so the rule is retroactive, automatic over the customer's data, and automatic over time - a fixed list that reaches ten converts on the commit that grows it. `searchable` overrides either way and is expected to have no callers. |
| **SearchablePanel** | `searchable-panel.tsx` | The one **entity-filter pill** panel (Inventory category + location pills, Vendors category pill). A Popover that owns an **always-on** search box, label+subtitle matching, a pinned reset row and a pinned footer CTA; rows arrive as `{ key, label, subtitle, render }` so each call site keeps its own row markup. A sibling of the 10-option rule, not an exemption from it - the count is deliberately not read here. See §4.2. |
| **Tabs** | `tabs.tsx` | **Underline** style (not segmented pill). Active = ink text + 2px **ocean** bottom border (`data-[state=active]:border-primary`); inactive = muted. |
| **KpiStrip / KpiTile** | `KpiStrip.tsx` | The one KPI standard. Value-first: uppercase 11px/700 muted label → 26px/800 tabular value → optional `<TrendDelta>` glyph → 12px caption. White surface, 6px, `shadow-card`, 18px padding. `tone` ∈ `neutral\|primary\|emerald\|amber\|rose` maps to token tints (`bg-success/10`, etc. — the tone *names* are API labels, not raw palette classes). Interactive tiles act as filters and show an ocean ring when `active`. |
| **TrendDelta** | `TrendDelta.tsx` | Canonical KPI trend glyph: inline mini line-graph SVG (`currentColor`) in a 6px tinted chip. `up` → rising line + `text-success bg-success/10`; `down` → falling line + `text-danger bg-danger/10`. |

Other shadcn-derived primitives (input, select, textarea, checkbox, dialog,
dropdown, sheet, etc.) inherit 6px + tokens. Some still carry stock `dark:*-slate-*`
defaults pending a dedicated dark-mode pass — those are tolerated by the guard (see §6).

### 4.1 Spacing vocabulary - the per-side amendment (phase 7)

Padding on a primitive is expressed as **4px-grid step numbers**, never as size
words. A designer typing a word from muscle memory cannot silently get a
different pixel value, because these props do not accept words at all.

The shared home is **`src/design-system/spacing.ts`**: the `PadStep` type, the
seven step maps, the `PadProps` interface a primitive spreads into its own prop
type, and the single `padClasses()` resolver. Tabs, Table and Surface all import
it. None of them copies it - copying is the drift this whole program exists to
kill.

**The amendment.** The settled vocabulary published `pad` / `padX` / `padY`
only. Phase 7 adds `padTop` / `padRight` / `padBottom` / `padLeft`. It is a
strict superset, and it mirrors Tailwind's own four-sided model, so it teaches
nobody a new concept.

**What forced it.** The tab rail at `src/pages/InvoiceDetailPage.tsx:905` pads
its **top side alone** - horizontal padding plus a top pad, and nothing at the
bottom. The closest expression in the published vocabulary is `padY={2}`, which
also adds 8px of padding at the bottom: a rendered change, which phase 7's
byte-identical-rendering constraint forbids outright. Measured per-side demand
in the Tabs cluster alone is 9 sites, so this is not a one-site convenience.
The rejected alternative was a bespoke `inset` step meaning "re-inset a rail
inside a padless Card" - it invents a second word for one shape, which the
vocabulary's own rule 1 forbids.

**Precedence:** per-side beats axis beats shorthand.
`padTop`/`padRight`/`padBottom`/`padLeft` > `padX`/`padY` > `pad`.

**Two behaviours that are easy to get wrong, both deliberate.**

- **Naming any single side expands the whole thing.** As soon as one side is
  set, every resolvable side is emitted individually and the shorthand is not
  emitted at all. `padX={4} padTop={2}` produces three per-side classes - top,
  right, left - not a horizontal shorthand plus a top one. The computed padding
  is identical; the class string is not, on purpose. tailwind-merge does not
  treat a later axis padding class as overriding an earlier shorthand one, so
  keeping both would let utility order inside the compiled stylesheet decide
  which side wins, instead of the component deciding.
- **A side that resolves to nothing emits nothing.** No step-0 class is
  synthesised for the sides you did not name. Padding is not universally zeroed
  by the preflight reset, so a zero on, say, a table cell would strip the
  padding the user-agent stylesheet gives it - again a rendered change.

**Step 10 joins the ladder.** The settled ladder is 0, 0.5, 1, 1.5, 2, 2.5, 3,
4, 5, 6, 8, 12. `spacing.ts` publishes that ladder plus **step 10** (40px), so
its scale is a strict superset of the one in `card.tsx`. `InvoicesPage:633` is a
centred loading paragraph whose vertical padding is step 10, and it is not a
one-off: a raw source scan of `frontend/src` (raw scan, supporting evidence
only, not a guard-derived number) finds the vertical step-10 utility 22 times
and the uniform step-10 utility 4 times. Without the step those sites cannot be
converted without changing what they render.

**Every class in those maps is written out in full, and must stay that way.**
Tailwind's scanner reads source text, so a class assembled at runtime from a
prefix and a step number is invisible to it: no CSS is generated, the element
renders with no padding, and Tailwind exits 0 without complaint. Never build one
of these strings by interpolation, however repetitive the maps look.
`src/design-system/__tests__/spacing.test.ts` asserts per map entry that the
literal is physically present in the module's own source.

**Known duplicate, scheduled.** `src/components/ui/card.tsx` still carries its
own private copies of the three padding maps and its own three-argument
`padClasses`. That is exactly the duplication `spacing.ts` exists to retire, and
migrating Card onto the shared module is **W2** work, not phase 7's. Until it
lands, Card's scale is the smaller one (no step 10) and Card has no per-side
props. Nothing in phase 7 changed what Card renders.

### 4.2 Dropdowns - the 10-option rule

**A dropdown with 10 or more options is a combobox. Below 10 it is a plain
select.** Nothing else is considered - not whether the list is hardcoded, not
whether a user can add to it, not which module it lives in. Job types are a fixed
enum of thirteen and get search; customer type is two and does not. A list that
is hardcoded in code *and* editable in settings does not become a special case -
only its length is read.

**The call site does not decide, and does not declare anything.** `SelectField`
receives its options as a flat `{ value, label }[]`, so it reads `options.length`
at render time and picks the branch itself. Three things follow, and they are the
reason the rule is written this way:

- **It is retroactive.** Every existing dropdown obeys it the moment the primitive
  does, including the ones nobody has audited.
- **It is automatic over data.** A vendor picker is a plain select for an org with
  six vendors and a combobox for an org with sixty. The same code, the same day.
  Nobody predicts the customer's data.
- **It is automatic over time.** A fixed list of three that later grows to ten
  becomes a combobox on the commit that adds the tenth option. No follow-up
  ticket, no audit, nothing to remember.

`searchable` exists as an explicit override in either direction. It is an escape
hatch with no expected callers; if overrides start accumulating, the number is
wrong and the number should move - in one place.

**Why the searchable branch is a separate primitive.** Radix Select owns focus and
ships its own single-keystroke typeahead, so a text input cannot live inside it.
That is a library constraint, not a styling choice: the searchable branch is
`components/ui/combobox.tsx` on Popover + Input + listbox, and `select.tsx` is
untouched. The composition was not invented there: `crm/AssigneeSelect.tsx` had
shipped it in production, and now renders the primitive instead of its own copy.

**What the searchable branch has to do.** Filtering alone reads as unfinished:

- Match every field a user might type, not the label alone - an item has to be
  reachable by `241CRL91723001`, by `Door Closer`, and by `CRL`.
- Input pinned above the scroll area, never scrolling away with the results.
- Current selection stays reachable when the query would exclude it.
- Keyboard: ArrowDown / ArrowUp on the focused trigger opens the list (as does
  Enter or Space), focus lands in the input on open, arrows move, Enter
  selects, Esc closes.
- Two differences from the plain select are accepted as inherent to a
  searchable list, not defects: once open, Space types a space into the search
  box rather than choosing a row, and typing filters the list rather than
  jumping to the first row that starts with that letter.
- Non-modal: an outside click closes the list AND reaches what it was aimed at.
  A surface that turns a click on its own body into an action (the schedule
  event editor opens the job page) must ignore clicks inside a floating list and
  clicks made while one was open - see `pages/v2/schedule/components/eventEditor.tsx`.
- A named empty state - "No vendors match 'xyz'", not a blank panel.
- A dropdown whose list the user can add to always shows ONE fixed create row
  (`onCreate`), pinned at the bottom of the open list below a divider and
  outside the scroll area: there the moment the list opens with nothing typed,
  the same row with the same label while the user searches, and still there
  when nothing matches. Plus icon, a constant label that names the thing
  ("Create category"; "Create new" by default), never one that echoes the
  query. Picking it hands over the tidied search text, so whatever was typed
  pre-fills the new name, and an empty search opens an empty form
  (`ui-kit/lib/createQuery.ts`). A row that only appeared after a user typed a
  name that did not exist was never discovered, so that pattern is retired.
  Fixed lists (priority, status) get no create row, and permission still
  decides who sees it - someone who may not create gets the plain list.

**Two ways to bypass the rule, both non-conforming.** Hand-composing
`<Select><SelectContent>{data.map(...)}</SelectContent></Select>` puts the option
count where the primitive cannot read it, so the rule silently does not apply -
24 files still do this and they are the migration. Raw `<select>` leaves the
design system altogether - 7 files. Hand-composed *literal* lists are fine and
are not the target; all 8 in the tree hold 2 to 5 items.

#### The remote tier is unbuilt, and its pickers are not violations

Nine dropdowns in the tree are hand-rolled and searchable and stay that way:

`timeclock/StoreAddressSearch.tsx`, `crm/address-autocomplete.tsx`,
`tasks/LinkedEntitySelect.tsx`, `pages/v2/tasks/components/linkedEntitySelect.tsx`,
`crm/PickOrCreateCustomer.tsx`, `pages/v2/_shared/pickCustomer.tsx`,
`crm/CustomerPickerWithCreate.tsx`, `jobs/items/PriceBookPicker.tsx`,
`inventory/lo/TrackedItemSearch.tsx`.

Each of them queries the SERVER as the user types - most behind a 300ms debounce
- rather than filtering an array already in memory. That is a different thing
from what the rule is about. §4.2 counts `options.length`, and a remote picker
has no such number: its list is a page of results for the current query, so
"ten or more options" is not a question that can be asked of it, let alone
answered at render time.

`Combobox` has no async contract today, and giving it one is its own piece of
work, not a line in a consolidation pass: a loading state, an error state, abort
of the superseded request, and a "no results" that has to distinguish *nothing
matched* from *nothing has come back yet* - because rendering the empty state
during the first round trip tells the user their query failed while it is still
in flight. Until that exists there is nothing for these nine to convert ONTO.

So: they are a deliberate, unbuilt tier, not a backlog of §4.2 violations, and
not evidence that the rule is unenforced. Converting one onto today's primitive
would replace a server search with a filter over whatever page happened to be
cached, which is a data-loss bug wearing a consistency fix. The client-side ones
were consolidated; these were not, on purpose.

**Three client-side surfaces also stay hand-rolled, and for stated reasons.**
`customers/BulkTagPopover.tsx` and `leads/TagInput.tsx` are multi-select over
coloured chips - neither entry point has a multi-select contract (both are
`value: string` and both close on commit). `crm/MultiAssigneeSelect.tsx` hit the
same gap and sidesteps it: it is an "add one" `Combobox` (value always empty, the
chosen set rendered as chips outside it), so it is no longer on the allowlist.
`crm/AssignTeamPopover.tsx` picks a crew and then commits it with an Assign
button plus notify toggles, so selecting a row is not selecting a value. And the
two `TimeCombobox` files match *times*, not strings, via `timeOptionMatchesQuery`
in `lib/date-input.ts` ("3p", "15:00", "1500"), and accept off-grid values that
are not in their own option list at all - a generic substring filter over `h:mm a`
labels is strictly worse, which is the same reasoning that keeps
`pages/v2/_shared/timeSelect.tsx` a documented exception.

#### On a phone: a short choice is a bottom sheet, a searchable picker is a screen

Below `md` (and on a phone held sideways) the overlay presentation of the **intent** decides what a
picker becomes - `ui-kit/lib/overlayPresentation.ts`, the one function every overlay asks. Nothing
branches on the user agent.

- **A short choice** - a status, a stage, a handful of labels - is `ui-kit/components/ui/choiceMenu.tsx`
  (`ChoiceMenu`). From `md` up it is the dropdown menu it always was; below `md` it is a bottom sheet
  with one 44 px row per option. Its options are data (`{ key, label, icon, current, onSelect }`), because a
  Radix menu item cannot live in a sheet and both layouts must offer the same rows in the same order.
  Do not hand-roll a status `DropdownMenu` on a record page.
- **A searchable picker** - the two Comboboxes, the customer picker, the linked-record picker, the
  assign pickers - is a **full-screen sheet** below `md` (`PickerFullscreen`): a titled header with a 44 px
  close, the search field directly under it (above the keyboard) and the results filling the rest and
  scrolling by touch. A picker renders EITHER its popover OR the sheet, never both:
  `const fullscreen = usePickerFullscreen()` then `fullscreen ? <PickerFullscreen ...> : <PopoverContent ...>`,
  and its results list takes `pickerListClass(fullscreen, '<popover height cap>')` so it fills the screen
  instead of capping at a popover's height. A list inside a popover that opens from a modal dialog also
  lets touch moves through the dialog's scroll lock (`useScrollLockEscape`).
- **Every popover, dropdown and select** carries a 10 px collision gutter, a height cap at the room Radix
  measured (it scrolls inside) and a maximum width of the viewport minus both gutters, by default - so a
  fixed 320 px panel can never be wider than a 320 px phone.

`SearchablePanel` (the entity-filter pills) is not yet on the full-screen path; it keeps its popover, which
now stays inside the screen like every other.

#### Entity-filter pills are ALWAYS searchable - a sibling rule, not an exemption

The ten-option rule above governs **dropdowns of options**: a flat list of short
labels, where ten is the point at which scanning stops beating typing. A second
family exists that the two Select entry points cannot see at all, because its
choices never arrive as `{ value, label }[]` bound for a Radix Select. It is the
**entity-filter pill**: a Popover with a pill trigger (icon + two-line
label/subtitle + count badge + chevron), a pinned reset row ("All Categories"),
a scrollable list of **entity rows carrying per-row edit/delete affordances**,
and a pinned footer CTA ("+ Add new category"). Inventory -> Items has two of
them; the Vendors page has a third.

**This family is searchable at every row count, and the count is deliberately
not read.** A row here is not a label: it is two lines carrying branch, driver,
vehicle and plate, with inline mutation affordances beside it and a create
action beneath it. Six of those are already denser to scan than ten bare labels,
and the rows accumulate subtitle fields over time while the row count stays
flat - so length is simply not the quantity that decides this family. The
six-row Locations pill earns search on the same grounds the fourteen-row
Categories pill does.

That is why this is a **sibling rule and not an exemption from the one above**.
Both rules put the decision inside the primitive and leave the call site
declaring nothing; they differ only in what the primitive reads, because they
are about two different controls. Asking "is it ten yet?" of a management
surface is the wrong question, not a question this family is excused from
answering.

**The primitive is `components/ui/searchable-panel.tsx` (`SearchablePanel`).**
It deliberately does **not** import `SEARCH_THRESHOLD` - importing it would
imply a gate that does not exist. It owns the popover, the always-on search box,
matching against **label AND subtitle** (so "Brooklyn" finds "Mike's Van"), the
pinned reset row and the pinned footer CTA. A call site hands it `rows`
(`key` / `label` / `subtitle` / `render`) plus its own row markup, so **what the
rows look like is untouched** - the panels' rows genuinely differ and
normalising them would be a rendered change to shipped surfaces. `resetRow` and
`footer` are outside the filtered list for the same reason §4.2 pins the
Combobox action row: a query that matches nothing is exactly when the user needs
"+ Add new category".

`design-system/__tests__/dropdown-bypass-guard.test.ts` **check 4** ratchets it:
a file that hand-composes a mapped `<PopoverContent>` while also carrying row
edit/delete affordances is a hand-rolled member of this family and fails,
against a three-entry reasoned allowlist. Its stated limit is a panel that
hand-rolls `createPortal` instead of using Popover - `inventory/StagingAreaPicker.tsx`
is that shape, and is a value editor on a stage card rather than a filter pill,
so it is left alone.

---

## 5. Chart language + primitives

Reusable, presentational chart primitives live in **`src/components/charts/`**
(barrel: `@/components/charts`). Every report/widget composes these — none
re-styles Recharts inline, and **all colors read from tokens** via `token()`,
`chartPalette`, and `severityRamp` (`@/design-system`).

- **Categorical palette** (`chartPalette`, spec order): green (sage-700) → teal/ocean → indigo (ai-600) → amber → slate. For series with no inherent semantic color.
- **Severity ramp** (`severityRamp`): green → terracotta, for "worse as it goes" scales (AR aging, etc.).
- **Shared theme** (`chartTheme.ts`): `axisTick` (muted 11px), `gridStroke`/`axisLineColor` (border token), `tooltipContentStyle` (white, 6px, card shadow), `trackColor` (border-soft) + SVG geometry helpers (`polar`, `describeArc`, `smoothPath`).

Primitives (with spec #): `WaveAreaChart` (#01), `CapsuleBar` (#02),
`StackedBars` (#03), `HorizontalBars` (#04), `Funnel` (#05), `ProgressDonut` (#06),
`GaugeArc` (#07), `SegmentedDonut` (#08), `SeverityBars` (#10), `Sparkline` (#12),
plus the shared **`ChartCard`** wrapper (6px, white, system shadow, no pill selects).

---

## 6. Guardrails

`src/design-system/__tests__/tokens-guard.test.ts` is a **scoped** static fence
(vitest). It scans only the canonical, already-migrated surface — the
`design-system/` and `charts/` dirs plus an explicit allowlist of migrated `ui/`
primitives — and fails the build if any of them reintroduces:

- a raw 6-digit hex color (outside `tokens.ts`/`tokens.css` and comments), or
- a raw Tailwind palette utility class (`bg-emerald-500`, `text-rose-600`,
  `border-slate-200`, …) in light mode.

It deliberately tolerates `dark:`-prefixed legacy shadcn slate defaults (deferred
to a dark-mode pass) and the hex in the token source files. Extend the migrated
`ui/` allowlist in that test when you reskin a new primitive. Keep this and the
existing `*.reskin.test.ts` guards green.

---

## 7. Page-cleanup checklist

When building or migrating a page, confirm each line (adapted from the
implementation spec):

**Color & tokens**
- [ ] No raw hex and no raw Tailwind palette classes (`bg-emerald-*`, `text-rose-*`, `bg-slate-500`, …). Consume semantic utilities (`bg-primary`, `text-success`, `border-border`).
- [ ] Reconciliation rule honored: ocean = chrome/interactive; green = business/approved/positive-data only. No green nav/chrome leak.
- [ ] AI surfaces use `ai`/lavender only; notification rose only on unread-count badges.

**Shape & elevation**
- [ ] 6px radius via tokens (`rounded-card`/`rounded`); no stray `rounded-lg`/`rounded-2xl`. `rounded-full` only on avatars/switches/notification badges.
- [ ] Cards: `bg-white rounded-card shadow-card border border-border`.

**Components**
- [ ] Statuses render via `StatusBadge` (mapped by meaning), not ad-hoc colored pills.
- [ ] KPIs use `KpiStrip`/`KpiTile` (+ `TrendDelta`), not bespoke tiles.
- [ ] Tabs use the underline `Tabs` component (active = ocean underline), not segmented pills.
- [ ] Dropdowns go through `SelectField` with an `options` array - not hand-composed
      `<Select><SelectContent>` over mapped data, and never a raw `<select>` (§4.2).
- [ ] No `searchable` override without a reason in the PR description. The count decides;
      overrides accumulating means the number is wrong, not that the site is special (§4.2).
- [ ] Entity-filter pills (pill trigger + "All X" reset + mapped entity rows with
      edit/delete + "+ Add new" footer) are built on `SearchablePanel`, never
      hand-composed on `Popover` (§4.2).
- [ ] Tables: uppercase muted hairline header, 14px rows, right-aligned money.

**Content & format**
- [ ] Money: full comma-grouped numbers (`formatCurrency`), no k/M abbreviation.
- [ ] Dates: `MMM D, YYYY`.
- [ ] Nav copy: "Customers" (not "Clients"); route unchanged.
- [ ] Icons: lucide-react line icons (green core / indigo AI / ink actions), no emoji/unicode placeholders.

**Charts**
- [ ] Charts composed from `@/components/charts` primitives; no inline Recharts palette.
- [ ] Series colors from `chartPalette`; severity scales from `severityRamp`.

**Validation**
- [ ] `npx tsc --noEmit` clean; the token guard and `*.reskin.test.ts` green.

---

## 8. Destructive action confirmation (SRVW-248)

Every irreversible action - delete, void, refund, cancel, purge, remove - must confirm before
it fires. The mechanism already exists: `useConfirm()` (`src/hooks/useConfirm.tsx`) plus
`ConfirmDialog` (`src/components/ui/confirm-dialog.tsx`); shared prompt copy lives in
`src/lib/confirmPrompts.ts` so the wording cannot drift across surfaces. This section is the
inventory the issue asked for, plus the checklist that keeps a new destructive action from
shipping unguarded.

### 8.1 Inventory

**Guarded via `useConfirm()`/`ConfirmDialog` (or a dedicated confirmation modal):**

| Action | Where |
|---|---|
| Line item delete (Job/Estimate/Invoice) | `LineItemRow.tsx` trash icon, and `AddLineDialog.tsx`'s edit-form footer Delete button (Estimate is the only surface that reaches the delete mutation through both paths) - both use `deleteLineItemPrompt` |
| Subtask delete | `pages/v2/tasks/components/taskDetailDrawer.tsx` - `deleteSubtaskPrompt` |
| Attachment delete | `AttachmentsPanel.tsx` - `deleteAttachmentPrompt`, five surfaces |
| Tax rate delete | `TaxRatesPage.tsx` |
| Workflow delete | `WorkflowsHome.tsx` |
| Customer purge | `CustomerDetailPage.tsx` - typed confirmation (name must be typed, not just clicked) |
| Void invoice | `VoidInvoiceDialog` |
| Void payment | `VoidPaymentDialog` - dedicated modal, requires a reason category + reason text before the danger submit button enables |
| Cancel job | `CancelJobDialog` |
| Cancel/lost lead, cancel walkthrough | `leadDialogs.tsx` |
| Bulk delete / bulk recall estimates | `EstimatesPage.tsx` - states the count |
| Vendor delete, service location delete, lead delete | respective detail pages |
| Staff removal | `StaffSection.tsx` |
| Logistic order delete | `LODetailSheet.tsx` - **known gap:** title is "Delete this logistic order?" with no LO number, so it does not name the specific object (criterion 3) |

**Reversible - fires immediately, Undo toast instead of a dialog (by design, not an oversight):**

| Action | Where | Note |
|---|---|---|
| Scope-of-work block delete (Job/Estimate/Invoice) | `ScopeOfWorkCard.tsx`'s `handleDelete` | Deletes, then an Undo toast re-creates the block server-side via `onAdd`. **Known gap:** this is a re-create, not a true restore - the recreated block gets a new id, lands at the end of the list (original ordering is lost), and any scope photos keyed to the old `scope.id` do not come back. |

**Unreachable - no delete control exists, so nothing to guard:**

| Action | Where |
|---|---|
| Task delete | `deleteTaskApi`/`DELETE /api/tasks/:id` exist server-side, but neither task drawer renders a delete control - documented deliberately in `taskDetailDrawer.tsx`'s file header. |

### 8.2 Checklist for a new destructive action

- [ ] Is this action truly irreversible? If yes, wrap the mutation call in `useConfirm()` -
      `if (!(await confirm({...}))) return;` - before it fires. If the action is genuinely
      reversible, skip the dialog: fire immediately and show a toast with Undo instead (see
      `ScopeOfWorkCard.tsx`'s `handleDelete` for the pattern). A dialog on top of a working Undo
      is noise, not safety.
- [ ] Add a prompt to `confirmPrompts.ts` (reuse an existing one if the shape matches) rather
      than inlining a one-off `{ title, description }` object at the call site - that is how the
      wording drifts.
- [ ] The dialog names the specific object ("Delete brand Carrier?", "Remove '5hp compressor'?"),
      never a bare "Are you sure?".
- [ ] The dialog states the consequence and whether it can be undone.
- [ ] The confirm button carries `tone="danger"` and is labeled with the verb (Delete/Void/
      Refund/Remove), not "OK" or "Confirm".
- [ ] Bulk actions state the count ("Delete 12 items?").
- [ ] Check EVERY reachable call site for the mutation, not just the obvious one. A shared row
      component and a shared dialog can both reach the same delete endpoint - Estimate's line
      item delete had exactly this shape: the row's trash icon was guarded, but the same mutation
      was also reachable from the edit dialog's own footer Delete button, which was not.
- [ ] Add the new action to the inventory table in 8.1 above (guarded / reversible / unreachable).

**Why there is no automated guard test for this.** `no-browser-dialogs.guard.test.ts` only
matches call syntax like `window.confirm(` - it cannot express "this destructive mutation call
has no confirm step before it," since that requires tracing a click handler to a mutation call
across component boundaries, which a static text-matching guard cannot do reliably. The checklist
above is the honest, cheap substitute until a more precise guard is worth building.
