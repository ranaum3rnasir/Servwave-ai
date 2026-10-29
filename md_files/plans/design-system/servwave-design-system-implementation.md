# ServWave Design System Implementation Plan

**Branch:** `claude/design-system-implementation-wmmpfk` (off `main`)
**Source spec:** `servwavedesignsystemfull.html` (uploaded) — "ServWave Full Design System & Chart Spec v1.0"
**Current system:** "Calm Intelligence 2.0" (Deep Ocean) in `frontend/tailwind.config.js`
**Owner stance:** Implemented under a UI/UX VP standard — single source of truth, change-once-cascade-everywhere, enforced by guardrails.
**Date:** 2026-06-29

---

## 0. Decisions (locked with user)

| # | Decision | Effect |
|---|----------|--------|
| 1 | **Keep Deep Ocean `#0C2D3A` as the interactive primary** (no brand inversion) | Ocean stays chrome/nav/buttons/focus. Green stays business/success. Apply all *other* spec changes. |
| 2 | **Adopt 6px "crisp" radius everywhere** | All cards/buttons/inputs/badges → 6px; icon tiles 5px. |
| 3 | **Full scope incl. custom chart gallery** | Token + components + per-page polish + rebuilt chart language. |
| 4 | **Keep notify rose `#F43F5E` for notification-count badges only** | Stays the documented exception (not a danger red). |
| 5 | **Single-source-of-truth architecture (VP directive)** | Dedicated design-system files; one edit re-themes the whole app; enforced by tests/lint. |

### Reconciliation rule (because we keep ocean primary)
The spec uses **green** for two distinct jobs. We split them at the *semantic-token* layer:
- **Green as data/semantic signal** (positive deltas, success/won/paid, chart lead series, severity ramp start) → `--success` / chart tokens = green `#2F7D5D`.
- **Green as generic UI chrome** (tab active-underline, focus rings, links, selection) → `--primary` = Deep Ocean `#0C2D3A`.

Because these are *tokens*, the rule is enforced in one place, not per-component.

---

## 1. Design System Architecture — the single source of truth

**Principle:** values live in exactly one place and flow outward. Nobody writes a hex or a px in a component, ever.

### 1.1 Three-tier token model
```
Tier 1 — Primitives (raw scale, no meaning)      e.g. --ocean-800: 12 45 58;  --green-700: 47 125 93;  --space-4: 16px
            │  (never referenced directly by components)
            ▼
Tier 2 — Semantic aliases (meaning, theme-aware) e.g. --primary: var(--ocean-800);  --success: var(--green-700);
            │   --canvas, --surface, --border, --danger, --radius-card, --shadow-card …
            ▼
Tier 3 — Consumption layers (read tokens only)
            ├─ Tailwind theme  → colors/radii/shadow map to var(--…)  → utility classes (bg-primary, rounded-card)
            ├─ Components       → use the utility classes / CSS vars (no raw values)
            └─ Charts/JS        → read the SAME tokens via a typed accessor (no inline hex)
```

### 1.2 Dedicated files we will create (the "design system" the VP wants)
| File | Role |
|------|------|
| `frontend/src/design-system/tokens.css` | **THE source of truth.** All primitives + semantic aliases as CSS custom properties on `:root` (and `.dark`). Change here → entire app re-themes. |
| `frontend/src/design-system/tokens.ts` | Typed accessor for JS/charts: `token('--chart-1')` resolves the CSS var at runtime; exports `chartPalette`, `severityRamp`, etc. **One** place charts read color. Includes a static fallback map for jsdom/test env. |
| `frontend/src/design-system/index.ts` | Barrel re-export (tokens + canonical primitives). |
| `frontend/src/components/charts/*` | Reusable ServWave chart primitives (wave-area, capsule-bar, donut, gauge, funnel, sparkline) — every report composes these, none re-styles Recharts inline. |
| `frontend/src/components/ui/TrendDelta.tsx` | The canonical KPI trend-delta line-graph glyph (green up / terracotta down). |
| `frontend/DESIGN_SYSTEM.md` | Human reference: tokens, usage rules, do/don't, component catalog. Replaces the stale `DESIGN.md` (retired indigo/Inter spec). |
| `frontend/src/pages/design-system/DesignSystemPage.tsx` *(route `/design-system`, dev/admin)* | **Living kitchen-sink page** rendering every token swatch + component state. Makes any future change visually verifiable in one screen. *(Recommended; can be gated/removed for prod.)* |

### 1.3 Why CSS variables (not hardcoded hex in tailwind.config.js)
- **Change-once-cascade-everywhere**: re-theme = edit `tokens.css`. No rebuild logic, no repo-wide find/replace.
- **Runtime theming**: dark mode, per-org white-label, future "themes" become possible without touching components.
- **Single source across CSS *and* JS**: Tailwind classes and Recharts both resolve the same `--token`.
- **Opacity preserved**: store colors as **space-separated RGB channels** (`--primary: 12 45 58`) and map in Tailwind as `rgb(var(--primary) / <alpha-value>)`, so existing modifiers (`bg-primary/10`, `ring-primary/15`) keep working. *(This is the one real implementation detail — handled centrally, invisible to components.)*
- **Class names don't change**: `bg-primary`, `rounded-card`, `shadow-card` keep working — only their *definitions* move from hex → `var()`. So components are largely untouched; risk stays low.

### 1.4 Governance / guardrails (so it stays clean)
- Keep existing `*.reskin.test.ts` green; **add a repo guard** (test or ESLint rule) that fails on: raw hex in `.tsx`, raw Tailwind palette classes (`bg-emerald-*`, `text-rose-*`, …), and inline chart hex outside `design-system/`/`charts/`.
- One PR-checklist line (mirroring the spec's cleanup checklist) in `DESIGN_SYSTEM.md`.
- Components consume **semantic** tokens only (`--primary`), never primitives (`--ocean-800`) — enforced by convention + review.

---

## 2. Target token values

From the spec's `:root` (channel format shown where colors take opacity):

```
PRIMITIVES (colors)            SEMANTIC ALIAS            RADIUS              SHADOW
ink        16 32 43           --primary  = ocean-800     --radius-card 6px   --shadow-card
teal/ocean 12 45 58           --canvas   = #EEF1F3       --radius-control 6  0 8px 24px
muted      102 121 133        --surface  = #FFFFFF       --radius-badge 6     rgb(12 45 58 /.06)
line       228 232 236        --success  = green-700     --radius-ic 5px
green-700  47 125 93          --warning  = amber #B45309
amber      180 83 9           --danger   = terracotta #BF5A4C
terracotta 191 90 76          --ai       = indigo #5B6DFF
indigo     91 109 255         --notify   = #F43F5E (badge-count only)
tints: green-bg #EEF8F2 · amber-bg #FBF1E5 · red-bg #F7ECEA · indigo-bg #F3F0FF
chart tints: green-mid #6EA886 · green-light #B9D9C8 · amber-light #E7B666
font: Manrope
```

### Current → target deltas
| Token | Current | Target | Action |
|-------|---------|--------|--------|
| `--primary` (ocean) | `#0C2D3A` | `#0C2D3A` | keep (decision 1) |
| `--canvas` | `#F7F7F2` warm | `#EEF1F3` cool | change |
| `--success` | `#2F9E73` | `#2F7D5D` | align to green |
| `--warning` | `#c68a3c` | `#B45309` | change |
| `--danger` | `#bf5a4c` | `#BF5A4C` | keep (case) |
| `--notify` | `#F43F5E` | `#F43F5E` | keep (decision 4) |
| radius card/btn/input/badge | 18 / 12 / 8 / pill | **6 / 6 / 6 / 6** | change |
| chart palette | scattered inline hex | one `chartPalette` token export | centralize |
| token storage | hardcoded hex in config | **CSS vars in `tokens.css`** | re-architect |

> Technician-mobile `tech-*` tokens stay a **separate namespace** in `tokens.css`, untouched by this pass (own theme). AI-agent animal characters / AI Center = design-target only, out of scope.

---

## 3. Implementation phases

Each phase is independently buildable. P0 builds the architecture; everything after consumes it.

### Phase 0 — Token architecture (foundation, do first)
1. Create `src/design-system/tokens.css`: primitives + semantic aliases (`:root`, `.dark`), channel format for opacity-bearing colors.
2. Rewire `tailwind.config.js`: replace every hardcoded color/radius/shadow with `var(--…)` / `rgb(var(--…) / <alpha-value>)`. **Class names unchanged.**
3. Import `tokens.css` in `src/index.css` (before Tailwind layers). Flip `components.json` `cssVariables: true` for future shadcn scaffolds.
4. Create `src/design-system/tokens.ts` (typed accessor + `chartPalette`/`severityRamp`) and `index.ts`.
5. Apply the spec value deltas (canvas, success, warning, radius 6px, tints).
**Outcome:** whole app already re-themed via tokens; future changes are one file.

### Phase 1 — Shared `ui/` components (consume tokens)
- **badge / status-badge** — pill→6px; 4 semantic colors + tints; map every status by meaning; drop raw `slate-*`/`red-500` for tokens.
- **table** — uppercase muted hairline header, no fill; 14px rows + 1px divider; mono muted ID; right-align money.
- **tabs** — segmented-pill → **underline**; active = ink + 2px **ocean** underline; inactive muted.
- **KpiTile** — restructure to the spec standard (uppercase 11px label → 26/800 value → **`<TrendDelta>` glyph** + caption); build `TrendDelta.tsx`.
- **button/card/input/select/textarea/checkbox/dialog** — inherit 6px via tokens; normalize stray `rounded-*`; confirm `secondary`=teal.

### Phase 2 — Layout & brand (verify; already ~compliant)
- Sidebar accent-bar + ocean gradient ✓; "ServWave" casing ✓; canvas cascades. Verify no green chrome leak.

### Phase 3 — Per-page polish (copy/format/structure)
- `nav-registry.ts`: **"Clients" → "Customers"** (route unchanged).
- **Money**: remove k/M; full comma-grouped numbers everywhere (`compactCurrency` → `formatCurrency`).
- **Dates**: standardize `MMM D, YYYY`.
- Migrate any custom per-page tabs to the underline component.
- Swap emoji/unicode icon placeholders → **lucide-react** line icons, colored by domain (green core / indigo AI / ink actions).

### Phase 4 — Chart language (largest; Recharts 2.15 + custom SVG)
- Build `components/charts/*` primitives reading `chartPalette`/`severityRamp` from `tokens.ts`: wave-fill area line, capsule bars, stacked/horizontal bars, funnel, progress + segmented donuts, gauge arc, status matrix, severity bars, stepper, KPI sparklines, indigo AI-insight chart.
- Replace the inline palette in dashboard widgets + ~16 report files with these primitives. Chart cards: 6px, white, system shadow, no pill selects.
- Severity (AR aging) → green→terracotta ramp.

### Phase 5 — Docs, guardrails, validation
- Write `frontend/DESIGN_SYSTEM.md`; build the `/design-system` kitchen-sink page.
- Add the no-raw-hex / no-raw-palette guard (test or ESLint); keep all reskin tests green.
- `npx tsc --noEmit`, frontend tests, `npm test --workspace=backend`; visual check (dashboard, list, detail, report) via running app.
- Update `CLAUDE.md` Design System section + `memory/project-servwave-design-system.md` (+ vault per rule 10 when available).

---

## 4. Agent execution model (how the VP parcels the work)

I (VP) own the **token contract** (Phase 0) and the **standards**; subagents implement against it so nothing diverges.

1. **Phase 0 is done first, by one agent (or me), and frozen** as the contract. Everything downstream imports from it. No other agent invents tokens.
2. **Parallelizable after P0** (independent file sets, low collision):
   - Agent A: `ui/` components (P1).
   - Agent B: per-page polish (P3) — copy/format/icons.
   - Agent C: chart primitives + report adoption (P4) — biggest, may split per chart-type.
   - Agent D: docs + kitchen-sink page + guardrails (P5).
3. **Shared brief given to every agent:** "Consume semantic tokens/utility classes only. No raw hex, no raw Tailwind palette classes, no inline chart colors. Reconciliation rule: ocean=chrome, green=business/data. Keep `*.reskin.test.ts` green." 
4. **VP review gates:** after P0 (contract sign-off), after P1–P2 (foundation visual review — recommended checkpoint), after P4 (chart parity), final.
5. Worktree isolation for parallel agents to avoid conflicts (per CLAUDE.md rule 9).

---

## 5. Sequencing, commits, risks

**Sequence:** P0 → (P1+P2) checkpoint → P3 → P4 (per primitive) → P5.
**Commits** (no AI attribution, CLAUDE.md rule 8):
- `feat(design-system): token architecture — css-var single source of truth`
- `feat(design-system): align shared ui components to ServWave tokens`
- `feat(design-system): full-number money, Customers rename, underline tabs, line icons`
- `feat(charts): ServWave chart primitives + report adoption`
- `docs(design-system): DESIGN_SYSTEM.md, kitchen-sink page, token guardrails`

**Risks/notes:**
- Opacity modifiers require channel-format vars — handled centrally in P0.
- 6px is sweeping but token-driven; main visual effect is boxier density (accepted).
- Tab pill→underline may shift some layouts; audit each usage.
- Chart phase is large/net-new; if trimmed later, P0–P3 still deliver most of the visible alignment.
- `tech-*` mobile theme and AI-agent characters excluded.

---

## 6. Implementation status (as of 2026-06-29)

- **Phase 0 — Token architecture — DONE.** `frontend/src/design-system/tokens.css` is live as the single source of truth (primitives + semantic aliases, channel-RGB format); `tailwind.config.js` consumes `var(--…)`; `tokens.ts` exports the typed accessor (`token()`, `chartPalette`, `severityRamp`). Value deltas applied: canvas `#EEF1F3`, success `#2F7D5D`, warning `#B45309`, radius **6px crisp everywhere** (icon tiles 5px).
- **Phase A (P1–P2) — DONE.** Shared `ui/` components (badge/status-badge, table, underline tabs, KpiTile + `TrendDelta`, button/card/input) consume semantic tokens at 6px; layout/brand verified (accent-bar sidebar, "ServWave" casing, no green-chrome leak).
- **Phase B (P3–P4) — DONE.** Per-page polish (full comma-grouped money, "Customers" rename, underline tabs, lucide line icons) and the chart language landed: reusable primitives in `frontend/src/components/charts/` (WaveAreaChart, CapsuleBar, StackedBars, HorizontalBars, Donut, GaugeArc, Funnel, SeverityBars, Sparkline, ChartCard) reading `chartPalette`/`severityRamp`; dashboard + report widgets adopt them.
- **Remaining (P5):** `DESIGN_SYSTEM.md` reference, `/design-system` kitchen-sink page, and the no-raw-hex / no-raw-palette guardrail. `CLAUDE.md` Design System section updated to reflect the implemented system.
