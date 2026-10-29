# Per-organization scheduler event colors

Branch: `feat/schedule-event-colors` (continues `refactor/schedule-dense-day`, PR #1780)
Date: 2026-09-13

## Goal
Let each organization choose its own color for each scheduler event type (Job, Walkthrough,
Service Plan, Event) instead of the hard-coded info/warning/ai/event tokens.

## Product decisions (owner, 2026-09-13)
1. **Curated palette + custom hex.** A grid of pre-verified swatches for one-click picking, plus a
   free `#RRGGBB` field. A custom pick that fails the board's AA floor shows a warning but is NOT
   blocked - the org gets the final say.
2. **Status still wins over type.** Custom colors paint scheduled/upcoming cards only. Completed
   stays grey, in-progress stays green, needs-crew/double-booked stay red. Unchanged.

## Design
The board's colors already resolve through design tokens, so the cheapest correct seam is a new
indirection layer rather than a rewrite of every render site.

### Token layer (`frontend/src/design-system/tokens.css`)
Four new vars that alias today's values, so the default board is pixel-identical:
```css
--ev-job:            var(--info);
--ev-walkthrough:    var(--warning);
--ev-service-plan:   var(--ai);
--ev-calendar-entry: var(--event);
```

### Tailwind layer (`frontend/tailwind.config.js`)
Register them the same way `event` is registered today, so static utility classes keep working:
```js
'ev-job': 'rgb(var(--ev-job) / <alpha-value>)',   // + the other three
```
This is what makes the whole thing work: `border-l-ev-job` / `bg-ev-job/10` / `text-ev-job` are
STATIC class names (Tailwind can see them at build time) whose VALUE is resolved at runtime from a
CSS custom property. No dynamic class generation, no safelist, no inline color literals.

### Runtime layer
`scheduleEventColors.ts` turns the org's stored hex map into a style object of CSS custom
properties (`{'--ev-job': '59 130 246'}`), applied once on the schedule page root so it cascades to
every card, pill, bucket and legend swatch underneath. Unset types fall through to the alias above.

### Render sites changed
- `scheduleModel.ts` `EVENT_TYPE_META` - the four accent/soft/text triples.
- `SchedulePage.tsx` `eventStyleGetter` - only the three TYPE branches (calendar-entry, walkthrough,
  default scheduled job). The status and danger branches above them are untouched, per decision 2.
- Drag preview fill (`SchedulePage.tsx`) - detached DOM node appended to body, so it reads the
  resolved value rather than inheriting the cascade.

### Storage
`Organization.schedule_event_colors Json @default("{}")`, following the `brand_color` precedent
(typed column + explicit `organizationScalarSelect` allowlist + strict zod in `patchOrgSchema`),
NOT the dormant `AppSetting` store, which has no frontend client and a `String`-only value.

### Settings UI
A "Schedule Colors" block inside the existing `Localization & Defaults` section of
`pages/v2/settings/CompanyProfilePage.tsx`, next to the Scheduling Defaults block that already
owns the scheduler's other org-level knobs. No new route, no new nav row.

## Slices
1. Backend: migration + select allowlist + zod + tests (TDD, failing test first).
2. Frontend token/tailwind/runtime layer + `EVENT_TYPE_META` + `eventStyleGetter` + drag preview.
3. Settings UI: palette grid, custom hex, live preview, AA warning.
4. Tests: model, resolver, settings page, plus the existing guards kept green.

## Guards this must not trip
- `design-system/__tests__/tokens-guard.test.ts` - no hex literals, no raw palette classes, no
  literal appearance values in inline `style={{}}`. The runtime layer writes CUSTOM PROPERTIES
  (`--ev-job`), which is not one of the scanned appearance properties, and the values come from a
  variable, not a literal.
- `design-system/__tests__/contrast.test.ts` - the AA ratchet reads `--info`/`--warning`/`--ai`/
  `--event` from tokens.css directly, not through class names, so renaming the utility classes in
  `EVENT_TYPE_META` does not touch it. The four base tokens stay exactly as they are.
- `scheduleModel.test.ts` hue-separation + AA assertions - same: they resolve tokens, not classes.

## Amendment (owner, 2026-09-15)
1. **Palette only, from the design system.** Decision 1 above is superseded: there is no custom
   hex and no free picker. The org chooses from SCHEDULE_EVENT_PALETTE (design-system/
   scheduleEventPalette.ts) - twelve tokens the app already ships. Terracotta, notify-rose and the
   neutrals are deliberately not offered.
2. **Stored as token names, not hexes.** `schedule_event_colors` now holds e.g. `{ job: 'sage-700' }`.
   The board re-points its `--ev-*` alias at `var(--sage-700)`, so a retuned token repaints every
   org that chose it. The API validates against the same list (SCHEDULE_EVENT_COLOR_TOKENS);
   scheduleEventPalette.test.ts pins the two copies to each other.
3. **Its own settings page.** Settings > Schedule Colors (`/settings/schedule-colors`, ADVANCED
   group, `update Organization`), not a block on Company Profile.
4. The token-guard exemption for scheduleEventPalette.ts is gone - the file holds no hex.
