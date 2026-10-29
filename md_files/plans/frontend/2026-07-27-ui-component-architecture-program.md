# UI Component Architecture Program

**Date:** 2026-07-27 (rev 3, post-audit; §1 corrections, §2a settled vocabulary and the Phase 7
decisions added 2026-07-28 by the W1 design phase)
**Status:** phases 7-11 done (11f closed 2026-08-01 via a documented no-build decision, see §11.7);
phase 12's story/alias slice SHIPPED 2026-08-01/02 (12-story, 12-charts, 12a, 12c - see §12.1-§12.4);
12b/12d/12e/12f not started. Verification layer 1 (Playwright visual-regression baseline, plan §4.1,
task #59) investigated 2026-08-01 and deliberately NOT built - Ran's call, given real per-route cost and
staging-DB writes; see §12.3's sibling note and the `project-ui-component-architecture-program` memory
for the CI-runner-OS finding that would need verifying first if this is picked up later.
**Supersedes:** `2026-07-27-phase-7-appearance-layer.md` (Button and Card only; absorbed here)
**Owner decisions, Ran, 2026-07-27:**
- Full scope, no quick wins, phase split delegated to the implementer.
- The designer **writes code**. Storybook is in scope; a Figma token round-trip is not.
- **Dark mode is out of scope entirely** and its dead remnants get deleted (see 7c).

---

## 0. The end goal

> A UI/UX designer can change any visual property of this application by editing one file in
> `frontend/src/`, without reading a page, without grep, and without knowing which feature uses it.

That sentence is the acceptance test for the whole program.

Four corollaries, each mechanically checkable:

1. **Every visual difference is a named option.** If two things look different, that difference is a
   prop value (`size="sm"`, `tone="danger"`, `variant="outline"`), never a class string at a call site.
2. **Every option is visible in isolation.** If a variant exists in code but not in Storybook, the
   designer cannot discover it, so it does not exist.
3. **A call site says where a thing goes, never what it looks like.** Position is the call site's
   business. Appearance is the component's.
4. **Spacing is a scale, not a number.** `<Stack gap="lg">`, never `mt-6`. Added by the rev-2 audit:
   without this, "give this page more breathing room" still sends the designer hunting through pages,
   and the end goal fails on the single most common design request.

### What this is not

Not "zero raw elements." A tab strip, a toolbar icon affordance, an invisible click-catcher can
legitimately be a bare `<button>`. What matters is that when it is bare, it does not restate appearance
a primitive already owns. Same for `<div>`: a flex wrapper is fine, a `<div>` that paints a bordered
rounded surface is a `Card` that has not been written yet.

---

## 1. Measured state (2026-07-27, post-#1017, 408 files scanned)

Method: the phase 6 classifier (`component-api-guard.test.ts` exports `targetFiles`,
`findComponentTags`, `classNameTokens`, `stripComments`), plus an axis lens bucketing each token as
size / type / colour / radius / border / shadow / state / layout. Excludes `pages/design-system/**`,
tests, and `components/ui/**`. Re-run every number before acting on it.

**Corrections applied 2026-07-28 (W1 design phase), each re-derived with the guard exports:**

| Where | Rev 2 said | Actual | Note |
|---|---|---|---|
| scope | also excludes `pages/prototype/**` | **that directory does not exist** | scope is `targetFiles()` minus `pages/design-system/**` = **408 files**, which does reproduce |
| §1b, §1d | Skeleton 108 sites | **109** | |
| §1d | raw `<button>` 840 | **839** | also corrected at step 11c |
| §1i, 7c | 59 `dark:` classes in 12 files | **51 in 11** | 5 of the 56 raw hits are inside comments |
| §1c | Button `h-6 px-2 text-xs` x4 | **x5** | `CustomersPage:565`, `EstimatesPage:546`, `InvoicesPage:532`, `JobsPage:449`, `InvoiceDetailPage:1107` |
| §6 Q2 | ~100 arbitrary bracket font sizes | **1,616 occurrences in 192 files** | 1,568 of them in the 9-13.5px band |
| §6 Q3 | 41 `rounded-full` pill buttons | **43** | rev 2's 41 is the non-circular subset |
| §2a | tone list of 8, no `info` | **9 tones** | `StatusIntent` includes `info`, and `Card.tone` / `Badge.intent` already ship it |

Everything else in §1b to §1h re-measured unchanged, including all 408 files, Button 504, Input 236,
Label 190, Card 97, and every raw-tag row in §1d other than `<button>`.

**One definitional trap, recorded because two agents already fell into it.** §1b's `size` / `type` /
`colour` / `styled` columns come from the axis lens described above, **not** from the guard's own
`classifyToken`. The guard calls `h-*` **layout**; the axis lens calls it `size`. So §1b's "Button
styled 44" and the guard's "Button has 23 call sites passing an appearance token" are both correct and
measure different things. They must not be conflated when a Button ratchet is seeded.

### 1a. The controlling finding

**Button has a complete variant API: 504 call sites, only 44 pass appearance - 91% clean.**
**Input has only `tone`: 236 call sites, 103 pass appearance - 44% dirty.**
**Skeleton has no size API: 109 call sites, 107 pass appearance - 98% dirty.**

Same codebase, same reviewers. The only variable is whether the prop existed. Call sites do not bypass
out of carelessness; they bypass because there was nothing to call. This is why every phase closes the
API *before* converting anything.

### 1b. Primitive call sites, by axis (sites passing >=1 class on that axis)

| Primitive | sites | files | size | type | colour | sigs | singletons | styled |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Button | 504 | 168 | 22 | 13 | 3 | 21 | 12 | 44 |
| Input | 236 | 63 | **54** | **31** | 16 | 22 | 10 | **103** |
| Label | 190 | 53 | 0 | **36** | 0 | 5 | 1 | 36 |
| Skeleton | 109 | 25 | **107** | 0 | 0 | 21 | 6 | **107** |
| Card | 97 | 25 | 0 | 0 | 7 | 3 | 1 | 7 |
| DialogContent | 66 | 60 | 14 | 0 | 1 | 10 | 7 | 16 |
| TabsTrigger | 58 | 17 | **37** | 0 | 0 | 6 | 1 | 37 |
| TabsContent | 53 | 14 | 24 | 0 | 0 | 4 | 0 | 24 |
| SelectTrigger | 46 | 30 | 20 | 15 | 2 | 11 | 7 | 42 |
| Textarea | 43 | 33 | 10 | 6 | 0 | 9 | 3 | 16 |
| PopoverContent | 25 | 23 | 24 | 0 | 1 | 14 | 9 | 33 |
| SheetContent | 17 | 17 | 10 | 0 | 0 | 10 | 7 | 10 |
| TabsList | 17 | 17 | 9 | 0 | 0 | 5 | 4 | 10 |
| Calendar | 14 | 10 | 13 | 0 | 6 | 7 | 4 | 19 |
| Avatar | 9 | 9 | **9** | 0 | 1 | 7 | 5 | 10 |

`size` is the dominant missing axis everywhere except Button, the one primitive that has it.

### 1c. What the call sites are asking for

Signatures with >=3 occurrences. These are prop specifications written in Tailwind by accident.

| Primitive | Demand | Reads as |
|---|---|---|
| Input | `h-8 text-sm` x10, `h-9` x7, `h-11` x5 | `size="sm" \| "md" \| "lg"` |
| Label | `text-xs` x20, `font-semibold text-sm` x13 | `size` + `weight` |
| Skeleton | `h-4` x33, `h-3` x14, `h-8` x8, `h-16` x7 | `variant="text" \| "title" \| "block"` |
| TabsTrigger | `px-5 py-3` x15, `px-4` x8, `px-4 py-3` x6, `px-3 py-2` x4 | `size` on `Tabs`, inherited |
| Button | `h-6 px-2 text-xs` **x5**, `h-11` x3 | `size="3xs"` and `lg` reuse (see §2a.6) |
| DialogContent | `max-h-[90vh]` x5 | `size` + a scroll-body slot |

### 1d. Raw elements bypassing primitives entirely

| Raw tag | sites | files | signatures | singletons | Primitive exists? |
|---|---:|---:|---:|---:|---|
| `<button>` | **839** | 221 | 613 | 491 | yes, Button |
| `<input>` | **253** | 101 | 120 | 87 | yes, Input (236 sites) |
| `<label>` | 157 | 68 | 43 | 27 | yes, Label (190 sites) |
| `<h3>` | 97 | 52 | 18 | 7 | **no** |
| `<h2>` | 66 | 41 | 13 | 4 | **no** |
| `<table>` | 57 | 45 | 10 | 4 | **no** |
| `<a>` | 44 | 19 | 22 | 10 | **no** |
| `<h1>` | 43 | 42 | 10 | 5 | **no** |
| `<textarea>` | 39 | 30 | 24 | 19 | yes, Textarea (43 sites) |
| `<img>` | 38 | 28 | 27 | 23 | **no** |

Raw `<input>` outnumbers the `Input` primitive. 206 headings across 41 signatures, no typography
primitive at all.

### 1e. Hand-rolled surfaces

Definition: a `className` carrying a background **and** a radius **and** (a border or a shadow).
**726 surfaces, 215 files, 328 signatures, 211 singletons.**

| Count | Signature | Should be |
|---:|---|---|
| 23 | `bg-surface-light border border-border px-3 py-2 rounded-md` | `Card size="sm"` |
| 22 | `bg-surface-light border border-border px-3 py-1.5 rounded-md` | `Card size="sm"` |
| 22 | `bg-danger/10 border border-danger/20 px-3 py-2 rounded-md` | **`Alert tone="danger"`** |
| 20 | `bg-surface-light border border-border px-2.5 py-1.5 rounded-md` | `Chip` |
| 17 | `bg-surface-light border border-border p-3 rounded-md` | `Card size="sm"` |
| 15 | `bg-surface-light border border-border p-6 rounded-xl shadow-card` | `Card` (default) |

Corrects the "71 cards" (phase 6) and "150 cards" (superseded phase 7) figures. Both only looked for
card-shaped surfaces; chips and callouts are the same disease needing **different** primitives.

### 1f. Composition layer

| Signal | Count | Of |
|---|---:|---|
| pages with their own `<h1>` | 35 | 112 page files |
| distinct `<h1>` class signatures | **13** | - |
| pages with hand-rolled back nav | 15 | - |
| pages with a `Tabs` strip | 14 | - |
| pages with a search input | 15 | - |

No `PageHeader`, no `Heading`, no page shell. `layout/Header.tsx` is the app nav bar.

### 1g. Structure

| Fact | Value |
|---|---|
| primitives in `components/ui/` | 31 files |
| component `.tsx` under `components/` | 377 |
| page `.tsx` under `pages/` | 123 |
| second component roots | 1: `features/estimate-workspace/components/` (8 files) |
| dead barrels (0 importers) | 4: `components/{crm,data,filters,form}/index.ts` |
| live barrels | 1: `components/charts/index.ts` (21 importers) |

**"Components are scattered" is mostly not a file-location problem.** 377 of 385 component files
already live under `components/`, split by feature, which is correct React practice. The location
problem is 8 files and 4 dead barrels. The real scattering is *appearance*.

### 1h. Prop surface today

| Has a real API | Colour only | Nothing |
|---|---|---|
| button (`variant` x13, `size` x4), empty-state, card (`tone`,`padding`), tabs, modal (`size`), skeleton (`shape`), confirm-dialog, dropdown-menu | input (`tone`), select (`tone`), avatar (`tone`) | badge, breadcrumb, calendar, checkbox, collapse, dialog, label, popover, separator, sheet, switch, textarea, toast, toggle-group, tooltip |

**15 of 31 primitives expose no options at all.**

### 1i. Audit findings (rev 2)

| Finding | Evidence |
|---|---|
| No visual regression testing anywhere | Playwright installed at `frontend/e2e/` with 3 configs, fixtures, page objects; **zero** `toHaveScreenshot` assertions in the repo |
| No Storybook | only a hand-rolled 687-line `DesignSystemPage.tsx`, showing 8 of Button's 13 variants |
| No layout primitives | no `Stack`, `Box`, `Inline`, `Spacer` in `components/ui/` |
| Prop vocabulary is inconsistent | `variant` x5, `tone` x5, `intent` x1, plus `shape`, `padding`, `density`, `size` - three words for semantic colour |
| Button variant names are not designer-legible | `ghostDestructiveReveal`, `ghostMuted`, `business`, `ai`, `onDark` |
| `onDark` is a context, not a variant | every other variant is wrong on a dark surface; this multiplies as variants grow |
| Dark mode is dead code | `darkMode: ['class']` at `tailwind.config.js:3`; **51 `dark:` classes in 11 files** (all in `components/ui/`), **nothing ever applies the class** - no theme provider, no `next-themes`, no `classList.add('dark')` anywhere. **Corrected 2026-07-28 (was "59 in 12 files"):** re-measured with `stripComments` over `components/ui/` - the raw string `dark:` occurs 56 times in 12 files, but 5 of those are inside code comments (`avatar.tsx` has only a comment mention, hence 11 files not 12). Per file: `button.tsx` 12, `select.tsx` 8, `dropdown-menu.tsx` 7, `checkbox.tsx` 6, `dialog.tsx` 5, `sheet.tsx` 4, `card.tsx` 2, `popover.tsx` 2, `tabs.tsx` 2, `tooltip.tsx` 2, `separator.tsx` 1 |
| Dark mode has three more surfaces the rev-2 audit missed | Deleting the 51 classes is not the whole job: `design-system/tokens.css:241` still defines a live `.dark { --background-light: var(--background-dark); --surface-light: var(--surface-dark); }` block, and `components/filters/RangeSlider.css:66` defines `.dark .range-slider__track`. A third is a stale `.dark` explanation comment at `pages/LoginPage.tsx:100`. All are equally dead (nothing applies `.dark`) and all went with the classes in 7c. **Token fallout, corrected 2026-07-28 after deletion:** *five* tokens orphan, not three - `--surface-dark`, `--chrome-dark`, `--on-dark`, `--on-dark-muted`, `--focus-dark`. The earlier claim that `--chrome-dark` and `--on-dark` survive is wrong: `--chrome-dark`'s only non-`dark:` consumer WAS the RangeSlider rule that 7c deletes, and `--on-dark` had none (the copilot surfaces consume the separate `--danger-on-dark` / `--warning-on-dark`, which are different tokens). **Real light-mode consumers, verified post-deletion:** `--background-dark` 2, `--primary-dark` 18, `--secondary-dark` 7, `--danger-on-dark` 3, `--warning-on-dark` 4, `--channel-whatsapp-dark` 2, `--ocean-900` 9, `--amber-900` 3 - none of these may be deleted. The five orphans were kept deliberately; see §7c-evidence |
| `/design-system` is a public route | good: the designer reaches it without an account (`App.tsx:123`) |

---

## 2. Target architecture

```
frontend/
  .storybook/                 designer entry point (phase 12)
  src/
    design-system/
      tokens.css              values           (done, phases 1-4)
      status-registry.ts      meaning          (parallel track)
      __tests__/              the ratchets
    components/
      ui/                     PRIMITIVES  - visual vocabulary, one concept per file
      patterns/               COMPOSITION - PageHeader, shells, FormField, Toolbar   (NEW)
      <feature>/              FEATURE     - composes ui + patterns, owns no appearance
    pages/                    ROUTING + DATA - owns no appearance
```

| Layer | Owns | Never contains |
|---|---|---|
| `tokens.css` | every literal value | - |
| `ui/` | how one element looks, and the spacing scale | domain concepts, data fetching |
| `patterns/` | how recurring layouts assemble | feature copy or logic |
| `<feature>/`, `pages/` | what appears and when | any appearance class |

### 2a. The vocabulary standard (rev 3 - SETTLED, W1 design phase 2026-07-28)

**Status: settled.** Drafted by the W1 design agent, attacked by three judges on distinct lenses
(coverage / no-visual-change / designer-legibility), all three refuting, and synthesised here. Every
number below was re-derived with the guard exports (`targetFiles`, `findComponentTags`,
`classNameTokens`, `classifyToken`, `stripComments`) over the 408 in-scope files, not copied from an
earlier revision. Where rev 2's text is wrong it is corrected in place and the correction is named.
The judges' surviving objections and the ones rejected are in **§2b**.

One vocabulary across all 31 primitives. Applies to every prop added from phase 7 onward.

| Prop | Means | Values |
|---|---|---|
| `variant` | structural appearance | `solid` / `soft` / `outline` / `ghost` / `link` |
| `tone` | semantic colour | `brand` / `neutral` / `subtle` / `danger` / `success` / `warning` / `info` / `ai` / `business` |
| `size` | control height, absolute px ladder | `3xs` / `2xs` / `xs` / `sm` / `md` / `lg` = 24 / 28 / 32 / 36 / 40 / 44 px |
| `pad`, `padX`, `padY`, `gap` | spacing, in 4px-grid steps | `0` / `0.5` / `1` / `1.5` / `2` / `2.5` / `3` / `4` / `5` / `6` / `8` / `12` |
| `iconOnly` | boolean | square at the chosen `size`, no padding |
| `revealOnHover` | boolean, `ghost` only | idle colour is `subtle`, hover colour is `tone` |
| `weight` | font weight | `normal` / `medium` / `semibold` / `bold` (per-primitive values fixed in W2) |

`intent`, `density`, `padding`, `shape` and `reveal` are retired into this vocabulary.

#### 2a.1 The five rules

1. **`variant` = structure. `tone` = colour. `size` = control height. `pad`/`gap` = spacing.** No second
   word for any of them.
2. **`size` is an ABSOLUTE ladder.** `size="sm"` is 36px on every control primitive that has the prop.
   The ladder step is a uniform 4px. A primitive's default is pinned to the rung that equals its
   current rendered geometry: **Button `md`, SelectTrigger `md`, Input `lg`.** No default's geometry
   ever moves. This corrects rev 2's "`md` is always the default" - see §2b, conflict 3, for why the
   alternative (per-primitive rung names, so `md` is always the default word) was rejected, and for
   the 40-vs-44 escalation it makes visible.
3. **`size` never appears on a primitive where it would not mean control height.** Modal's current
   `size` prop is a max-width scale (51 sites) and is renamed **`width`**. Card takes `pad`, not
   `size`. EmptyState takes `padY`, not `size` or `density`. Skeleton keeps its own `shape` axis, not
   folded into `variant` - **corrected in 8f (see the phase 8 table and §2a.11)**: block-vs-circle is
   geometry, not structure or colour, so it stays outside the closed vocabulary, the same way Avatar
   keeps its own `ring` axis. This removes the one place where a single word had two incompatible
   meanings in shipping code.
4. **A rung is (height, horizontal padding, font size) TOGETHER, and only the height is shared across
   primitives.** Padding and font are per-primitive - Button `md` is `h-10 px-4 py-2` while
   SelectTrigger `md` is `h-10 px-3 py-2 text-sm`, verified in `button.tsx:55` and `select.tsx:28`.
   Consequence, and it is the single most important operational finding for W3: **a call site that
   overrode only ONE leg of the triple changes geometry when it adopts a rung.** Proof case,
   `components/workflows/StepConfigDrawer.tsx:134` and `:152`: `<Button className="h-11">` with no
   `size` renders `h-11 px-4 py-2`, but `size="lg"` is `h-11 px-8` - the horizontal padding would
   double. W3's conversion tooling must classify by the full per-primitive rung definition, never by
   the height token alone.
5. **A cell is minted only where measured demand exists.** The whole grid is published so a designer
   can see the shape; unminted cells carry a stated recipe so W2 can add one without re-opening the
   vocabulary.

#### 2a.2 `tone` - nine values

Rev 2 listed eight and omitted `info`. That was wrong: `StatusIntent`
(`design-system/status-registry.ts:16`) is `success | warning | danger | info | neutral | brand`, and
both `Card.tone` and `Badge.intent` already expose `info` to call sites. The settled list is the union
of `StatusIntent` with rev 2's list, with `muted` renamed.

| `tone` | Token family | Note |
|---|---|---|
| `brand` | `primary` / `primary-dark` / `primary-subtle` | the only tone with a real darker hover token rather than an alpha |
| `neutral` | see the wart below | chrome, not status |
| `subtle` | `text-secondary` -> `text-primary` on hover | prominence, not hue. **Renamed from `muted`** |
| `danger` | `danger` / `danger-surface\|border\|text` | |
| `success` | `success` / `success-*` | |
| `warning` | `warning` / `warning-*` | |
| `info` | `info` / `info-*` | |
| `ai` | `ai-600 -> ai-500` gradient / `ai-*` | the only tone whose solid fill is a gradient |
| `business` | `--business` (new alias for `--sage-700`) | |

**`muted` -> `subtle`, on the record.** Two reasons, both mechanical. (1) `--muted` is a **Tier-1
primitive** token name (`tokens.css:23`), and `tokens.css:12` forbids components from consuming
primitives - `tone="muted"` reads as a direct primitive reference and is not one. (2) `muted` and
`neutral` are indistinguishable by name while behaving in opposite ways: `ghost` + `neutral` sets **no
idle colour at all** and inherits (`button.tsx:36`), while `ghost` + `muted` sets a real grey
(`button.tsx:40`). The value named for greyness was the one that was not grey. `subtle` names
prominence without claiming a hue.

**The vocabulary's one genuine wart, stated rather than hidden: `tone="neutral"` resolves to two
different token families depending on `variant`.**
- On a surface-painting variant (`solid`, `soft`): the `neutral-*` family. `--neutral-surface` is
  `--canvas` = `#EEF1F3`, a grey. This is what `Card tone="neutral"` and `Badge intent="neutral"`
  already render (`status-registry.ts`).
- On `outline` / `ghost`: the chrome family. `button.tsx:24`'s `outline` is
  `border border-border bg-surface-light`, and `--surface` is `255 255 255`, **white**.

So `<Card tone="neutral">` is grey and `<Button variant="outline" tone="neutral">` is white. Unifying
either direction restyles 202 outline Button sites or every neutral Card. Neither is a W1 change.
Recorded as a per-variant exception with its site counts, escalated in §2b.

**Non-tones, ruled out explicitly:**
- **`whatsapp` is not a tone.** `tailwind.config.js:163` registers it as a third-party channel brand,
  "deliberately NOT part of the theme", so it can never carry the `-surface`/`-border`/`-text` family
  the recipes need. `pages/communication/WhatsAppPage.tsx` keeps a wrapper.
- **`onDark` is not a tone and not a variant - it is a context.** Scope re-measured: **7 raw
  `<button>`s with a `bg-on-fill*` fill** (`components/layout/Sidebar.tsx:115,122,151,198,385`,
  `components/copilot/CopilotPanel.tsx:85`, `components/inventory/ScanDialog.tsx:166`) **plus 4
  `variant="onDark"` Button sites plus 1 Button hand-rolling it**
  (`pages/SchedulePage.tsx:2490`) **= 12 sites**, roughly 2.5x rev 2's implied "4". `onDark` stays a
  Button variant through W1-W3 and is absorbed by `Surface` in phase 9.

#### 2a.3 `variant` - five structures

Rev 2 listed four. A fifth, `soft`, is required: **47 raw filled `<button>`s carry a tinted or
alpha-modified idle fill with tone-coloured text and no `text-on-fill`** (fill tone: brand 30,
success 7, warning 3, business 3, ai 1, danger 1, other 2). That is not `solid` (wrong text colour,
lighter fill), not `outline` (it has a real idle fill), and not `ghost` (converting deletes the fill).
Verified examples: `components/communication/inbox/AiAssistMenu.tsx:143`
(`border-primary/20 bg-primary/10 text-primary`),
`components/communication/phone/CallMaskingView.tsx:452`,
`components/communication/phone/Softphone.tsx:851`, `components/crm/LineItemsEditor.tsx:391,552`
(`bg-warning-surface text-warning-text` / `bg-info-surface text-info-text`).

Caveat recorded: a material fraction of the 47 are the *selected* arm of a `cn()` toggle ternary
(both arms tokenise into one class list), so a share of them route to `Chip`/`ToggleGroup` in phase 9
rather than to Button. The residue is still a real structure, and no cell in a 4-variant grid renders
it.

| `variant` | Structure | Button call sites today |
|---|---|---:|
| `solid` | opaque fill, `text-on-fill` (exception: `tone="neutral"`) | 217 |
| `soft` | tinted fill, tone-coloured text, optional matching border | 0 (raw demand only) |
| `outline` | 1px border; `neutral` additionally carries `bg-surface-light` | 206 |
| `ghost` | no border, no idle fill | 72 |
| `link` | inline text, `underline-offset-4 hover:underline` | 0 |

#### 2a.4 The 5 x 9 grid

`S` = shipped in W1 with today's exact classes, geometry and colour pinned. `R` = recipe stated, mint
on demand in W2/W3. `-` = deliberately not minted. Numbers are **Button call sites**, which reproduce
exactly (504 total); rev-2-era raw-`<button>` per-cell annotations did **not** reproduce and have been
removed rather than restated.

| | brand | neutral | subtle | danger | success | warning | info | ai | business |
|---|---|---|---|---|---|---|---|---|---|
| **solid** | **S** 114 | **S** 0 | `-` | **S** 31 | **R** | **R** | **R** | **S** 6 | **S** 66 |
| **soft** | **R** | **R** | `-` | **R** | **R** | **R** | **R** | **R** | **R** |
| **outline** | **R** | **S** 202 | `-` | **S** 4 | **R** | **R** | **R** | **R** | **R** |
| **ghost** | **R** | **S** 50 | **S** 8 | **S** 10 | **R** | **R** | **R** | **R** | **R** |
| **link** | **S** 0 | **R** | **R** | `-` | `-` | `-` | `-` | `-` | `-` |

Shipped: **11 cells covering 491 of the 504 Button sites.** The other 13 are 4 `onDark` + 4
`ghostDestructiveReveal` (a modifier, not a cell) + 5 dynamic `variant={...}`.

**Recipes for the unminted cells.** These are stated as the CURRENT token spelling, not an idealised
one. Rev 2 had no recipes; the W1 draft proposed `bg-{T}-strong` / `border-{T}-border text-{T}-text` /
`text-{T}-text`, which **contradicts every shipped cell** and would have restyled 53 sites - verified
against `tokens.css`: `--danger` is `191 90 76` but `--danger-strong` is `187 88 74` and
`--danger-text` is `172 81 68`; there is no `--primary-strong`; there is no `--muted-*` family at all.

| variant | recipe | shipped exceptions |
|---|---|---|
| `solid` | `bg-{T} text-on-fill hover:bg-{T}/90` | `brand` uses `hover:bg-primary-dark`; `ai` is `bg-gradient-to-br from-ai-600 to-ai-500 ... hover:opacity-90`; `neutral` is `bg-border-soft text-text-primary hover:bg-border` (a light fill, so no `text-on-fill`) |
| `soft` | `border border-{T}/20 bg-{T}/10 text-{T} hover:bg-{T}/20` | none shipped yet; W2 must normalise the `-surface`/`-border` spellings against the alpha spellings and state which it picked |
| `outline` | `border border-{T}/40 text-{T} hover:bg-{T}/10 hover:text-{T}` | `neutral` is `border border-border bg-surface-light hover:bg-background-light hover:text-text-primary` - it carries a real white fill and sets NO idle text colour |
| `ghost` | `text-{T} hover:bg-{T}/10 hover:text-{T}` | `neutral` sets **no idle colour at all** and inherits from its parent; `subtle` is `text-text-secondary hover:bg-background-light hover:text-text-primary` |
| `link` | `text-{T} underline-offset-4 hover:underline` | - |

Moving the status cells onto the accessibility-tuned `-strong` / `-text` / `-surface` families is a
**visible** change (it is what those tokens exist for) and is therefore a separate, separately
signed-off decision, not a side effect of a rename. Deferred to the parallel meaning-layer track.

**Not minted, with reasons.** `solid`/`soft`/`outline` x `subtle`: a subtle fill is a contradiction,
and `neutral` already covers quiet chrome. `link` x the five status tones: an underlined status word
is a `Text` decision (phase 9), not a Button variant.

#### 2a.5 Button's 13 names decompose

Classes verbatim from `components/ui/button.tsx` with the `dark:` fragments removed (step 7c deletes
them; every one is inside a `.dark` ancestor that nothing ever applies).

| # | Today | Becomes | Exact classes preserved | Sites |
|---|---|---|---|---:|
| 1 | `default` | `variant="solid" tone="brand"` | `bg-primary text-on-fill hover:bg-primary-dark` | **114** |
| 2 | `business` | `variant="solid" tone="business"` | `bg-business text-on-fill hover:bg-business/90` | **66** |
| 3 | `ai` | `variant="solid" tone="ai"` | `bg-gradient-to-br from-ai-600 to-ai-500 text-on-fill hover:opacity-90` | **6** |
| 4 | `destructive` | `variant="solid" tone="danger"` | `bg-danger text-on-fill hover:bg-danger/90` | **31** |
| 5 | `secondary` | `variant="solid" tone="neutral"` | `bg-border-soft text-text-primary hover:bg-border` | **0** |
| 6 | `outline` | `variant="outline" tone="neutral"` | `border border-border bg-surface-light hover:bg-background-light hover:text-text-primary` | **202** |
| 7 | `destructiveOutline` | `variant="outline" tone="danger"` | `border border-danger/40 text-danger hover:bg-danger/10 hover:text-danger` | **4** |
| 8 | `ghost` | `variant="ghost" tone="neutral"` | `hover:bg-background-light hover:text-text-primary` (**no idle colour**) | **50** |
| 9 | `ghostMuted` | `variant="ghost" tone="subtle"` | `text-text-secondary hover:bg-background-light hover:text-text-primary` | **8** |
| 10 | `ghostDestructive` | `variant="ghost" tone="danger"` | `text-danger hover:bg-danger/10 hover:text-danger` | **10** |
| 11 | `ghostDestructiveReveal` | `variant="ghost" tone="danger" revealOnHover` | `text-text-secondary hover:bg-danger/10 hover:text-danger` | **4** |
| 12 | `link` | `variant="link" tone="brand"` | `text-primary underline-offset-4 hover:underline` | **0** |
| 13 | `onDark` | **a context, not a variant** | `text-on-fill/70 hover:bg-on-fill/10 hover:text-on-fill`, unchanged in phase 7; `<Surface>` absorbs it in phase 9 | **4** |

All 13 old names survive as deprecated aliases through W2/W3 and are removed at 12c, so **none of the
504 sites changes in this session.**

**Three exceptions a naive implementation gets wrong** (each is a shipped literal, not a recipe
output): `ghost` + `neutral` sets no idle colour (50 sites gain `text-text-primary` if implemented
uniformly); `outline` + `neutral` is not transparent, it carries a real white `bg-surface-light` and
no idle text colour (202 sites); `ghostDestructiveReveal` is a modifier, not a 10th tone - its idle is
`subtle`'s and its hover is `danger`'s, which is exactly what `revealOnHover` encodes.

**Two variants are dead.** `secondary` and `link` have **zero** Button call sites in the 408 in-scope
files (`variant="link"` has one occurrence tree-wide, in `pages/design-system/DesignSystemPage.tsx`).
They keep grid cells because both are structures a designer will reach for, but the tracer bullet
cannot validate them; Storybook (8h) is the only thing that will.

**One token addition, colour-neutral.** `button.tsx:15` reads `bg-sage-700` - a **Tier-1 primitive**,
which `tokens.css:12` forbids components from consuming. Mint `--business: var(--sage-700)` plus a
`business` colour key, so the cell reads `bg-business`. Identical RGB, 66 sites, zero rendered change;
`bg-business/90` expands through the same `rgb(var(--token) / <alpha-value>)` mechanism as today's
`bg-sage-700/90` (`tailwind.config.js:15`).

**Recorded finding, must not be discovered later:** `--green-700`, `--sage-700`, `--success` and
`--success-strong` are all the identical RGB triple `47 125 93` (`tokens.css:33,37,138,177`).
**`tone="business"` and `tone="success"` render pixel-identical on a solid fill today.** Both names
are kept - the meanings differ and a designer may want to diverge them - but see the `business`
escalation in §2b.

#### 2a.6 `size` - six rungs, with per-rung site counts

| `size` | px | Button classes | Button sites | raw `<button>` | Input | SelectTrigger |
|---|---:|---|---:|---:|---:|---:|
| `3xs` | 24 | `h-6 px-2 text-xs` | **7** | 34 | 1 | 1 |
| `2xs` | 28 | `h-7 px-3 text-xs` | **9** | 58 | 2 | 2 |
| `xs` | 32 | `h-8 px-3 text-xs` | **1** | 63 | **28** | 3 |
| `sm` | 36 | `h-9 px-3` (unchanged) | **267** | 95 | 10 | 7 |
| **`md`** | **40** | **`h-10 px-4 py-2` (unchanged, the anchor)** | **216** | 40 | 1 | **29 (default)** |
| `lg` | 44 | `h-11 px-8` (unchanged) | **9** | 7 | **187 (default) + 7** | 4 |

Button column: `sm` and `lg` and `md` are prop values (`size="sm"` x267, `size="lg"` x6 plus 3
`className="h-11"`, 216 implicit default); `3xs`/`2xs`/`xs` are today's `className` overrides.
`size="icon"` (15 sites) is `md` geometry and becomes `iconOnly size="md"`. Raw `<button>` column is
rendered height snapped to the nearest 4px over the 318 filled/outline raw buttons whose height
resolves (`h-*` where present, otherwise line-height + `py-*` + border); 92 are `p-*`-square icon
buttons with no font class and do not resolve.

**Why six rungs and not rev 2's four.** A `{xs=32, sm=36, md=40, lg=44}` ladder covers 205 of the 318
resolved raw buttons (64%) and strands 128, including the entire 24px and 28px bands. The six-rung
ladder covers 297 (93%). And the 24px rung is not optional: **both tracer pages carry a Button that
renders at 24px** - `pages/InvoicesPage.tsx:532` (`size="sm" variant="ghostMuted"
className="h-6 px-2 text-xs"`) and `pages/InvoiceDetailPage.tsx:1107` (`size="sm"
variant="ghostDestructive" className="h-6 px-2 text-xs no-underline"`). `cn` is `twMerge(clsx(...))`
(`lib/utils.ts:5`), so those classes genuinely beat `size="sm"`. **Without `3xs`, W1's own exit
criterion 7f is unreachable.** The same signature appears at `pages/CustomersPage.tsx:565`,
`pages/EstimatesPage.tsx:546` and `pages/JobsPage.tsx:449` - 5 sites of one signature.

**`sm` cannot move.** 267 of 504 Button call sites pass `size="sm"`. Moving it 36px -> 32px silently
reshapes 267 rendered sites. There is no additive version of "sm moves".

**Radius is NOT coupled to `size`.** No rung carries a `rounded-*` class; radius stays a per-primitive
base constant. Three independent lines of evidence: (1) within Button today radius already does not
vary with size - `rounded-button` sits on the base cva string and `size.sm`/`size.lg` merely restate
it (`button.tsx:56,57`), no-ops under twMerge that get deleted with zero rendered change; (2) across
the raw population radius does not ramp with height - 347 sites render 6px at every height from 16px
to 64px; (3) the only radius that correlates with anything correlates with *shape* - of the 43
pill-radius sites, most sit at or below 24px with a `px-2.5 py-0.5 text-xs` signature, which is
`Chip`, not a smaller Button.

**`iconOnly` is a boolean orthogonal to `size`, not a size value.** Today `size="icon"` is a *value*
that hardcodes `h-10 w-10`, which is why 7 Button call sites hand-roll a square at a non-`md` rung
(`h-7 w-7` x5, `h-8 w-8` x1, `h-11 w-11` x1). `iconOnly` sets `h-N w-N` and **suppresses padding
entirely** - not just horizontal: `button.tsx:58` `icon: "h-10 w-10"` carries no `py-2`, so the
deprecated alias `size="icon"` must resolve to the literal `h-10 w-10`, never to a delegation that
re-adds `md`'s `py-2`.

#### 2a.7 Every geometry-overriding Button call site

47 Button sites pass a size/type token; 22 of those are `w-full` or `flex-1` alone (layout, not
appearance, no conversion needed). Of the remaining 25, **17 convert geometry-identically and 8 do
not.** Line numbers below are re-derived with a newline-preserving comment strip and hand-verified;
earlier drafts cited line numbers produced off the guard's own `stripComments`, which deletes block
comments **including their newlines** and therefore shifts every line number in a file that has one.

| Converts exactly | Sites |
|---|---|
| `3xs` (`h-6 px-2 text-xs`) | `pages/CustomersPage.tsx:565`, `pages/EstimatesPage.tsx:546`, `pages/InvoicesPage.tsx:532`, `pages/JobsPage.tsx:449`, `pages/InvoiceDetailPage.tsx:1107` - **5** |
| `2xs` (`h-7 px-3 text-xs`; the two `h-7 text-xs` sites already carry `size="sm"`, so `px-3` already renders) | `components/crm/AttachmentSection.tsx:303`, `pages/LeadDetailPage.tsx:1160`, `pages/SchedulePage.tsx:2305` - **3** |
| `iconOnly size="2xs"` (`h-7 w-7`; all already carry `size="icon"`, so padding is already zero) | `pages/CustomerDetailPage.tsx:1350,1361,1373`, `pages/SchedulePage.tsx:2308,2311`, `components/schedule/EventEditor.tsx:229` - **6** |
| `iconOnly size="xs"` (`h-8 w-8`) | `pages/CustomerDetailPage.tsx:970` - **1** |
| `iconOnly size="lg"` (`h-11 w-11`) | `pages/workflows/WorkflowsHome.tsx:322` - **1** |

| Needs per-site review - do NOT convert mechanically | Sites | Why |
|---|---|---|
| `h-11` with no padding override, `size` unset | `components/workflows/StepConfigDrawer.tsx:134,152` - **2** | renders `h-11 px-4 py-2`; `size="lg"` is `h-11 px-8`. **Horizontal padding would double.** A height-only override has no rung |
| `h-6 px-2.5 text-xs` | `pages/SchedulePage.tsx:2476,2490` - **2** | `3xs` is `px-2`; these are 1px wider each side. `:2490` also hand-rolls a dark surface (`bg-on-fill text-warning-text`) and belongs to `Surface` |
| `h-auto ... py-3 w-full` | `pages/PublicEstimatePage.tsx:423`, `pages/PublicInvoicePage.tsx:655` - **2** | auto-height button, no rung covers it. Both public pages, outside the tracer |
| `mt-1 text-xs` (font only, no height) | `pages/PublicEstimatePage.tsx:713` - **1** | a rung would also change the height |
| `font-normal` / `text-sm font-normal` | `components/tasks/LinkedEntitySelect.tsx:205`, `components/crm/CustomerPickerWithCreate.tsx:201` - **2** | the `weight` axis, not `size` |

Two further per-site notes. `components/schedule/EventEditor.tsx:229` also carries
`text-text-soft hover:text-primary` - a fourth idle text colour that is neither `neutral`, `subtle`
nor `brand`; one site, leave the className, do not mint a `soft` tone for it.
`pages/InvoiceDetailPage.tsx:1107` also carries `no-underline`, which the guard classifies as
**`other`** (neither layout nor appearance) so it does not block exit criterion 7f - but it must be
proved a rendered no-op before it is deleted, since it is on one of the two tracer pages.

#### 2a.8 `pad` / `gap` - 4px-grid steps, NOT size words

Rev 2 proposed `none / xs / sm / md / lg / xl` for spacing. **That cannot be adopted, and this is the
largest change rev 3 makes.** Three mechanical reasons:

1. **It collides destructively with two shipped props.** `card.tsx:23-28` binds
   `padding="sm"` = `p-4` = **16px**, `="md"` = `p-6` = **24px**, `="lg"` = `p-8` = **32px**, against
   in-scope call sites `padding="sm"` x39, `="none"` x9, `="lg"` x7. A word-named absolute scale would
   make `sm` mean 6px. Old names survive as deprecated aliases through W2/W3 (§2a.5), so during the
   entire window `<Card padding="sm">` = 16px and `<Card pad="sm">` = 6px would sit on the same
   component. A designer converting those 39 sites types the same word and silently shrinks 39 cards
   by 10px each; `lg` is a 20px error. A remap table does not survive muscle memory.
2. **It cannot express the values that exist.** `empty-state.tsx:5-10` binds `compact` = `py-6` = 24px,
   `default` = `py-12` = **48px**, `roomy` = `py-24` = **96px** (call sites: `compact` x14,
   `flush` x12, `roomy` x2, rest implicit). A six-word ramp topping out at 16px cannot express 48 or
   96, so `density` could not retire. Extending it to `4xl`/`5xl` is exactly the invented ramp the
   scale is supposed to avoid.
3. **Word names strand measured modes.** Over the 408 files: `gap-*` 2,318 occurrences, `space-y-*`
   632, uniform `p-*` 593. The real modes are `gap-2` 728, `gap-1` 441, `gap-3` 433, `gap-1.5` 431,
   `gap-4` 122, `gap-0.5` 61, `gap-2.5` 46, `gap-6` 31, `gap-0` 14; `space-y-4` 165, `-2` 108, `-3`
   106, `-1` 72, `-1.5` 67, `-6` 38, `-0.5` 35, `-5` 19; `p-3` 160, `p-4` 99, `p-6` 63, `p-1` 55,
   `p-5` 52, `p-0` 44, `p-0.5` 34, `p-1.5` 28, `p-2` 25. A six-value word ramp names none of
   `0.5`, `2.5`, `5`, `12`, `24`.

**Settled: `pad` / `padX` / `padY` / `gap` take the Tailwind 4px-grid step directly** -
`0 | 0.5 | 1 | 1.5 | 2 | 2.5 | 3 | 4 | 5 | 6 | 8 | 12`, i.e. `pad={6}` is 24px. This is a *naming of
the measured modes*, not an invented ramp: every value is an existing Tailwind spacing key already
dominant in this tree. Coverage: `gap` 2,285/2,318 (98.6%), `space-y` 610/632 (96.5%), `p` 588/593
(99.2%).

Why numbers and not words: a number cannot be confused with a `size` word, so the Card and EmptyState
collisions vanish rather than being managed; 48px and 96px are expressible with no new rungs; and it
keeps `size` as the only word-scale in the vocabulary, which is what makes rule 3 enforceable.

**Explicit remap for the two shipped props**, published so the conversion is mechanical:

| today | renders | becomes |
|---|---:|---|
| `Card padding="none"` (9 sites) | 0 | `pad={0}` |
| `Card padding="sm"` (39) | 16px | `pad={4}` |
| `Card padding="md"` (default, 42 implicit) | 24px | `pad={6}` (stays the default) |
| `Card padding="lg"` (7) | 32px | `pad={8}` |
| `EmptyState density="flush"` (12) | 0 | `padY={0}` |
| `EmptyState density="compact"` (14) | 24px | `padY={6}` |
| `EmptyState density="default"` (99 implicit) | 48px | `padY={12}` (stays the default) |
| `EmptyState density="roomy"` (2) | 96px | `padY={24}` |

Note `padY={24}` needs 24 on the step list; the list above is the *common* set, and W2 states the
full enum when it writes the prop. The stated tail nobody sweeps up silently: `gap-2.5` x46, `p-5`
x52, `p-2.5` x15, `p-3.5` x7, `gap-x/y-*` x~70. `p-5` (20px, 52 sites, concentrated in
`TabsContent p-5` and the reports pages) is the largest single leftover; W2 decides it when it specs
`TabsContent`/`Card` padding and must state the choice.

#### 2a.9 Font size - register, do not snap

`text-[Npx]` population, re-measured over the 408 files: **1,616 occurrences in 192 files**, of which
**1,568 are in the 9-13.5px band**. Rev 2's "~100" (§6 Q2) is off by 15x and is reproducible only as
the raw-filled-button slice.

| value | occurrences | | value | occurrences |
|---|---:|---|---|---:|
| `text-[11px]` | **567** | | `text-[9px]` | 117 |
| `text-[10px]` | 484 | | half-px (9.5-13.5) | 44 |
| `text-[12px]` | 194 | | `text-[14px]`/`[15px]`+ | 32 |
| `text-[13px]` | 162 | | | |

**Snapping is not geometry-neutral.** Tailwind is 3.4.19; preflight sets `html { line-height: 1.5 }`
and `frontend/src/index.css` does not override it, so `text-[Npx]` renders a `1.5 x N` line box while
the stock rungs ship an explicit line-height (`xs` = 12/**16**, `sm` = 14/**20**). Snapping
`text-[12px]` to `text-xs` shrinks the line box by 2px, and since most raw buttons size themselves
with `py-*` rather than `h-*`, it shrinks the control. `text-[13px]` -> `text-sm` grows the font 1px.
9px, 10px and 11px have no rung below `text-xs` at all. Snapping visually changes ~1,524 occurrences.

**Settled: register five keys under `theme.extend.fontSize` in `tailwind.config.js`** (`fontSize` is
absent from the config today, so this is purely additive and does not disturb the stock scale), each
`['Npx', { lineHeight: '1.5' }]`:

| key | px | replaces | occurrences | status |
|---|---:|---|---:|---|
| `text-2xs` | 11 | `text-[11px]` | 567 | permanent |
| `text-3xs` | 10 | `text-[10px]` | 484 | permanent |
| `text-4xs` | 9 | `text-[9px]` | 117 | permanent |
| `text-xs-tall` | 12 | `text-[12px]` | 194 | **migration-only**, retirement target `text-xs` |
| `text-sm-tight` | 13 | `text-[13px]` | 162 | **migration-only**, retirement target `text-sm` |

`2xs`/`3xs`/`4xs` are a strict monotone ramp below `xs`. 12px and 13px cannot join it without breaking
monotonicity (12px is `xs`'s font-size with different leading; 13px sits between `xs` and `sm`), so
they are named for the **leading** difference, which is the actual difference, and are explicitly
labelled migration vehicles rather than design. The draft's `text-xs-plus` / `text-xs-loose` are
rejected: "plus" means bigger while "2xs -> 4xs" means smaller, so the direction of "more" flipped
mid-vocabulary, and Tailwind already owns `loose` as a line-height word (`leading-loose`). A key named
`text-13` is also rejected - a name that is its own pixel value is the arbitrary-bracket problem with
a hyphen instead of brackets.

**Blast radius: 1,568 occurrences in ~190 files move; 0 pixels change.** The only sites that move
pixels are the 44 half-px values, which snap to the nearest registered integer key for a max 0.5px
shift - those 44 are the only ones needing visual sign-off. Collapsing the 356 `xs-tall`/`sm-tight`
occurrences into `text-xs`/`text-sm` is a **visible** change and is deferred to W4/phase 12 with that
blast radius stated up front. Within W1 the change touches exactly one site:
`pages/InvoiceDetailPage.tsx:1061` (`text-[10px]`).

#### 2a.10 Explicit exclusions - axes the vocabulary deliberately does not have

Named with their counts so nobody rediscovers them as a surprise in phase 11.

| Axis | Population | Ruling |
|---|---:|---|
| `shadow` on a control | **80** raw filled/outline `<button>`s carry a shadow (`shadow-sm` dominant) | **No `shadow` prop on Button.** No Button variant has ever had a shadow; in every site read the shadow belongs to the surface, not the control. These are hand-rolled surfaces - phase 9 `Card`/`Chip`, step 11f |
| `border-dashed` | **10** sites in 8 files (`components/communication/phone/CallFlows.tsx`, `components/estimates/photos/PhotoAttachmentStrip.tsx`, `components/jobs/items/PriceBookPicker.tsx`, `components/jobs/items/ScopeOfWorkCard.tsx`, `components/layout/Sidebar.tsx`, `components/leads/TagInput.tsx`, `components/workflows/AddStepButton.tsx`, `pages/communication/InboxPage.tsx`) | **Not a Button axis.** The recurring shape is an "add another" drop target, its own phase-9 primitive |
| `solid` **with** a same-colour border | **11** sites | **No `bordered` boolean.** 11 sites across 6 files does not earn a prop, and the delta is a 2px size change, not a colour change. Per-site review at 11c |
| `border-transparent` as a hover spacer | 1 (`components/workflows/trigger/SubjectPicker.tsx`) | per-site, leave the className |
| runtime-interpolated colour | 1 (`components/workflows/MergeFieldChips.tsx`) | per-site, no cell |
| `shape="pill"` on Button | 43 pill-radius raw sites; **zero** on either tracer page; ~21 inside Communication/Copilot/AI which the tracer must avoid | **No `shape` prop in phase 7.** Most of the 43 are chips (<=24px, `px-2.5 py-0.5` + a font class + a selected/unselected ternary). A `shape` prop would pull non-Button things onto Button and pre-empt phase 9's `Chip`. Revisit at phase 9; the residual Button-side demand is ~11 sites, which is a wrapper, not a prop |

#### 2a.11 Scope of the rename - which primitives, and when

The vocabulary applies to **all 31 primitives** (that is what "one vocabulary" means), but W1 changes
only Button. Stating the rest so the first designer to see two spellings of one concept knows it is
scheduled, not forgotten:

| Primitive | Ships today | Becomes | Sites | When |
|---|---|---|---:|---|
| `Button` | `variant` x13, `size` x4 | the grid above | 504 | **W1 / 7a** |
| `DropdownMenuItem` | `variant="destructive"` | `tone="danger"` | 14 of 82 | W2 / 8 |
| `ConfirmDialog` | `variant='destructive'` | `tone="danger"` | 3 of 7 | W2 / 8 |
| `Badge` | `variant="destructive"`, `intent` | `tone` | 0 destructive in scope; `intent` -> `tone` | W2 / 8 |
| `Toast` | `variant="destructive"` | `tone="danger"` | primitive-internal | W2 / 8 |
| `Modal` | `size` = max-width | **`width`** | 51 | W2 / 8 |
| `Card` | `padding`, `tone` | `pad`, `tone` (keeps `tone`) | 55 explicit | W2 / 8 |
| `EmptyState` | `density`, `variant` | `padY`, `variant` | 28 explicit | W2 / 8 |
| `Input` | `tone="default"\|"sage"` | `size` + `tone` (`sage` -> `business`) | 236 | W2 / 8a |
| `Label` | `tone="default"\|"strong"` | `tone="subtle"` / `tone="neutral"` + `size` + `weight` | 12 explicit `strong` | W2 / 8b |
| `Textarea` | nothing | **no height rung** - its base is `min-h-[80px]`, not a fixed height (`textarea.tsx:12`). `size` on Textarea means a min-height scale, a separate ladder W2 defines | 43 | W2 / 8a |
| `Skeleton` | `shape` | **stays `shape` - not renamed. DONE 2026-07-29:** block-vs-circle is a geometry choice with no colour or spacing content, so it stays its own axis outside variant/tone/size/gap/pad, same as Avatar's `ring` (see `skeleton.tsx`'s header comment) | 109 | W2 / 8f |

Old names stay as deprecated aliases until 12c.

### 2b. Judge panel - what was grafted, what was rejected, what conflicted

Three judges, distinct lenses, all three refuting. Recorded per the rules of engagement ("record every
judgment call in this file").

**Grafted in (objection correct, verified against source):**

| # | Objection | Verification | Where it landed |
|---|---|---|---|
| G1 | The 4-variant grid strands a `soft`/tonal structure | 47 raw sites, 6+ tones, `AiAssistMenu.tsx:143` et al | §2a.3, new `soft` row |
| G2 | Recipes contradict the shipped cells they claim to derive from | `--danger` 191/90/76 vs `--danger-strong` 187/88/74 vs `--danger-text` 172/81/68; no `--primary-strong`; no `--muted-*` family | §2a.4 recipe table rewritten |
| G3 | Textarea's base is `min-h-[80px]`, not `h-11` | `textarea.tsx:12` | §2a.11, Textarea gets no height rung |
| G4 | A rung cannot be a shared (height, padding, font) triple across primitives | Button `md` `px-4` vs SelectTrigger `md` `px-3` vs Input `px-4 text-base md:text-sm` | §2a.1 rule 4 - only height is shared |
| G5 | `pad` collides destructively with Card's live `padding` | `card.tsx:23-28`, 55 explicit sites | §2a.8 - numeric scale, collision dissolved |
| G6 | The scale cannot express EmptyState's 48px/96px | `empty-state.tsx:5-10` | §2a.8 |
| G7 | `tone="neutral"` is two colour families | `--neutral-surface` = canvas grey vs `button.tsx:24` `bg-surface-light` = white | §2a.2, named as the one wart |
| G8 | `muted` unguessable, collides with the Tier-1 `--muted` token, `Label.tone="strong"` unmapped | `tokens.css:12,23`; `label.tsx:14-16` | §2a.2 rename to `subtle`; §2a.11 Label mapping |
| G9 | `size="icon"` is `h-10 w-10` with NO padding, so `iconOnly size="md"` would add `py-2` | `button.tsx:58` | §2a.6 - `iconOnly` suppresses padding entirely |
| G10 | `destructive` still ships on 4 other primitives; a designer sees two words on day one | `dropdown-menu.tsx:99`, `badge.tsx:16`, `toast.tsx:31`, `confirm-dialog.tsx:25` | §2a.11 scope table |
| G11 | `reveal` is unguessable as a bare boolean | - | renamed `revealOnHover` |
| G12 | `text-xs-plus`/`text-xs-loose` break monotonicity and collide with `leading-loose` | - | §2a.9, renamed and labelled migration-only |
| G13 | `whatsapp` can never satisfy the tone recipe | `tailwind.config.js:163` | §2a.2, ruled a non-tone |
| G14 | Dark-surface scope is ~2.5x what was stated | 7 raw `bg-on-fill` + 5 Button = 12 | §2a.2 |
| G15 | Per-cell raw-`<button>` demand annotations do not reproduce | independently non-reproducible here too | §2a.4, removed rather than restated |
| G16 | `shadow` (80) and `border-dashed` (10) are axes with no word | measured | §2a.10 explicit exclusions with counts |
| G17 | Cited line numbers are shifted by the guard's `stripComments` | guard's strip deletes block comments including newlines | §2a.7 re-derived with a newline-preserving strip and hand-verified |

**Rejected, on the record:**

| # | Objection | Why rejected |
|---|---|---|
| R1 | `business` should become a `cta`/`emphasis` axis, not a tone | The **diagnosis** is accepted and escalated (it is a page-hierarchy rule wearing a colour axis, and it is pixel-identical to `success`). The **action** is rejected for W1: it mints a fifth axis to hold one value, touches 66 shipped call sites in a session whose hard constraint is zero rendered change, and pre-judges an owner question - whether ServWave keeps a distinct "the money action" colour at all. `business` stays a tone through W1-W3; escalated below |
| R2 | Add a `shadow` axis to Button | No Button variant has ever had a shadow. All 80 shadow-carrying raw buttons are hand-rolled surfaces whose shadow belongs to the surface. Adding it would import a surface property into a control primitive. Recorded as an explicit exclusion with the count, which is what the objection asked for as its own fallback |
| R3 | Add a `bordered` boolean to `solid` | 11 sites, 6 files, and in every one read the border is the same colour as the fill, so the delta is a 2px size change. A prop for 11 sites fails the "mint only where measured demand exists" rule the vocabulary is built on. Per-site review at 11c |
| R4 | Name the 13px key `text-13` | A key named after its own pixel value is the arbitrary-bracket problem with a hyphen instead of brackets; the token layer exists so names carry meaning |
| R5 | (draft, not a judge) register 12px and 13px as permanent design keys | Registering a 12px key whose font-size is identical to `text-xs` mints a permanent name for drift. They are registered as **migration-only** with a stated retirement target instead |
| R6 | The shared-ladder idea collapses entirely | The fix is to scope what `size` shares (height) and what it does not (padding, font), not to abandon a shared ladder. §2a.1 rule 4 |

**Where judges conflicted, and the ruling:**

- **Card `padding` -> `pad`.** One judge asked for an explicit old-to-new value map; another said do not
  reuse words the live prop already binds to different pixels. **Ruling: both, but the second is the
  fix.** A remap table does not survive a designer typing `pad="sm"` from muscle memory during the
  alias window when both props are live on one component. The scale is numeric (§2a.8) so the
  collision cannot occur, and the map is published anyway as the migration artefact.
- **Mint `soft` now vs. every addition risks a restyle.** **Ruling: publish the row, do not implement
  it in W1.** Zero `soft` sites are on either tracer page, so W1 would ship an unvalidated cell. The
  recipe is stated so W2 mints it without re-opening the vocabulary.
- **One rule for "the default" vs. rungs demonstrably cannot be shared as triples.** This is the real
  conflict. Two options were live:
  - **(A) rung names are per-primitive rank, so `md` is always the default word.** Rejected. The same
    word would mean different pixels on different primitives, so `<Button size="sm">` (36px) beside
    `<Input size="sm">` (40px) would not line up while the naming actively suggests they should - and
    Input's dominant demand (`h-8`, 28 sites) would be called `2xs`. It makes the vocabulary *look*
    uniform while being non-uniform underneath, which is the exact failure §2a exists to prevent.
  - **(B) rung names are absolute px, so a primitive whose geometry is not 40px has a non-`md`
    default.** **Chosen.** `size="sm"` is 36px everywhere, so cross-primitive alignment is expressible
    and true; if height were also unshared, `size` would share nothing and be a per-primitive enum
    wearing a shared name.
  The cost of (B), stated plainly: **`<Input size="lg">` is Input's normal size**, which reads as
  "bigger than normal" and is not. That is one primitive family, it is visible, and it is the correct
  pressure toward actually fixing the underlying inconsistency rather than hiding it behind a renamed
  default. Rule 3 (`size` never means anything but control height - Modal's `size` becomes `width`)
  removes the other two failure cases the objection raised.

**Escalations for Ran - not agent decisions, and each must be answered before W3 starts:**

1. **6px vs 14px control radius.** `Button` renders **14px** (`--radius-button`, deliberately softer
   per `tokens.css:117`), but **347 of the ~420 appearance-carrying raw `<button>`s render 6px** and
   only 2 render 14px. Phase 11c's raw-to-`Button` conversion would therefore restyle ~347 controls
   from 6px to 14px. That is a visible restyle of most of the app's compact controls. It is not a size
   question and it cannot be hidden inside a conversion PR.
2. **40px vs 44px control height.** Button and Input do not share a default height today. Unifying is
   a visible restyle of 187 Input sites. Deliberately preserved by W1, now visible in the vocabulary
   as `Input`'s default being `lg`.
3. **`business` and `success` are pixel-identical** (`47 125 93`). Either diverge them or collapse
   `business` into a prominence/CTA concept. 66 Button sites.
4. **`tone="neutral"` painting two different families** depending on `variant` (grey on surfaces,
   white on outline/ghost). Unifying costs 202 outline Button sites or every neutral Card.
5. **The guard classifies `h-*` as LAYOUT, not appearance** (`component-api-guard.test.ts:167`), so
   none of the `size` work above can move any ratchet, and §5 rule 1 ("a call site may not pass `h-*`
   on a control") does not match what the guard enforces. Carried from discovery, still open, owner
   decision attached to 7g/W4. Related: under the guard's own `classifyToken`, Button has **23**
   call sites passing an appearance token, not the 44 in §1b - §1b's "styled" column uses a separate
   axis lens (size/type/colour), not the guard's classifier, and the two must not be conflated when
   a Button ratchet is seeded.

**Owner ruling, Ran, 2026-07-30 - all five answered before W3 starts. All five keep today's rendered
pixels; W3 (phases 10-11) proceeds with zero restyle from this list.**

1. **Radius: keep 14px.** Button's `--radius-button` does not move. The 347 raw 6px buttons visibly
   soften to 14px as phase 11c converts them onto `Button` - that softening is the intended, accepted
   effect of adopting the primitive, not a defect to design around.
2. **Height: keep permanently.** Button `md` stays 40px, Input `lg` stays 44px. The asymmetry already
   published in §2a.11 is not revisited in W3 or any later phase absent a fresh escalation.
3. **`business` vs `success`: stay pixel-identical.** No colour divergence, no CTA/emphasis axis split
   (R1's rejected action stays rejected). `tone="business"` keeps rendering `47 125 93`, same as
   `tone="success"`, until a future session reopens it with its own evidence.
4. **`tone="neutral"` two-family wart: kept, not unified.** Grey on `solid`/`soft`, white on
   `outline`/`ghost` stays exactly as documented in §2a.2. No restyle of the 202 outline Button sites
   or any neutral `Card`.
5. **Guard `h-*` classification: left as LAYOUT, deferred to 7g/W4.** W3 does not touch
   `component-api-guard.test.ts`'s classifier. Ratchets on `size`-prop adoption during phases 10-11
   remain unmeasured until that guard fix lands separately.

---

## 3. Phases

**Phase 7 is a tracer bullet, not a foundation.** The rev-1 plan built three complete layers before the
designer saw anything, which risked discovering a bad API decision after weeks of building on it.
Instead, phase 7 takes **one representative page all the way through every layer** and ships it. Every
later phase generalises a validated design rather than betting on an unvalidated one.

### Phase 7 - Tracer bullet: one page, end to end

Pick one list page and one detail page. Build **only** what those two pages need:

| Step | Work |
|---|---|
| 7a | Adopt the §2a vocabulary standard; recompose Button's 13 variants into `variant` x `tone`; keep old names as deprecated aliases |
| 7b | Add `size` to the primitives those two pages use, per §1c demand |
| 7c | **Delete dark mode** - **DONE 2026-07-28, see §7c-evidence**: strip all **51 `dark:` classes across 11 files** (re-measured 2026-07-28, was "59 across 12" - see §1i; every class is inside `components/ui/`, but dark-mode CODE is **not** confined there - see the next clause), plus `darkMode: ['class']` at `tailwind.config.js:3`, plus the **three non-class surfaces outside `components/ui/`**: the `.dark { ... }` block at `design-system/tokens.css:241`, the `.dark .range-slider__track` rule at `components/filters/RangeSlider.css:66`, and a stale `.dark` explanation comment at `pages/LoginPage.tsx:100`. **Token fallout, corrected 2026-07-28:** *five* tokens orphan, not three - `--surface-dark`, `--chrome-dark`, `--on-dark`, `--on-dark-muted`, `--focus-dark` all drop to zero consumers, because `--chrome-dark`'s and `--on-dark`'s only non-`dark:` consumer was the RangeSlider rule this step also deletes. The tokens that genuinely survive with real light-mode consumers are `--background-dark` (2), `--primary-dark` (18), `--secondary-dark` (7), `--danger-on-dark` (3), `--warning-on-dark` (4), `--channel-whatsapp-dark` (2), plus `--ocean-900` (9) and `--amber-900` (3). All five orphans were **KEPT, deliberately**, and the deferral is recorded in `tokens.css` itself - see §7c-evidence. Provably dead, and it doubles the surface of every variant 7a writes. Ran, 2026-07-27: not implementing dark mode in the foreseeable future |
| 7d | Build the minimum new primitives those pages need: `Heading`, `Stack`, `Card pad` |
| 7e | Build `PageHeader` and `ListPageShell` |
| 7f | Convert both pages fully. Zero appearance classes left in either file - **PARTIAL 2026-07-28, see §7f-evidence**: 223 to 139, everything phase 7 itself owns is retired; the remainder needs primitives phases 8-9 build |
| 7g | Stand up visual regression (§4.1) and baseline it on these two pages |

**Exit criteria, restated honestly (2026-07-28):** the exit criterion as written - both pages contain
*zero* appearance classes - is **not met**. It cannot be met without building primitives (`Surface`,
`Chip`, an `Icon` tone axis, a table density axis, `TextLink`) that the plan itself assigns to phases 8
and 9, and building them inside the tracer branch was Ran's explicit call NOT to make (2026-07-28 scope
decision, see §7f-evidence). What *is* true: every appearance token that phase 7's own deliverables
(`Button`, `Text`, `Tabs`) could retire on these two pages, is retired, and every token still standing is
individually attributed to the phase that owns its fix. The designer can restyle most, not all, of both
pages by editing `ui/` alone; the API decisions have survived contact with real pages.

#### §7c-evidence - dark mode deleted, 2026-07-28

**What went.** 51 `dark:` classes on 26 code lines across 11 `components/ui/` files (`button` 12,
`select` 8, `dropdown-menu` 7, `checkbox` 6, `dialog` 5, `sheet` 4, `card`/`popover`/`tabs`/`tooltip` 2
each, `separator` 1; `avatar` had **zero** classes, only a comment), plus 10 now-false explanatory
comments, plus the `.dark { ... }` block at `tokens.css:241`, plus `.dark .range-slider__track` and its
two comment paragraphs in `RangeSlider.css`, plus `darkMode: ['class']` at `tailwind.config.js:3`.
16 files, +50 / -98 lines. Measured with the guard's `stripComments`, not an ad hoc grep.

**Proof of no visual change.** Tailwind was compiled from the same entry, same config invocation, before
and after, and the two outputs compared as *rule sets* rather than by line diff. Result: 1766 -> 1746
top-level rules, **21 removed, 1 added**. Every one of the 21 removed rules carries a `.dark` ancestor
(`:is(.dark *)`, or the `.dark` custom-property block itself), so not one light-mode rule disappeared.
`npx tsc --noEmit` clean; `node scripts/check-unresolved-classes.mjs` clean at baseline 70/70 with no
new pairs; both guard suites 50/50 with **every ratchet still printing `(at floor)`**; full frontend
suite 2779 passed / 7 skipped, unchanged. No guard, ceiling or baseline was touched.

**Judgment call 1 - the five orphaned tokens were KEPT, not deleted.** The step-7c text above originally
said to delete three (`--on-dark-muted`, `--focus-dark`, `--surface-dark`) and keep `--chrome-dark` and
`--on-dark`. Re-measurement refutes the split: `--chrome-dark`'s and `--on-dark`'s only non-`dark:`
consumers were in the same `.dark` code this step deletes, so **all five** orphan together. Deleting
five design tokens is a wider change than "delete dark mode", and the W1 brief named `--surface-dark` as
a keeper, so reversing that unilaterally would be a silent scope change. All five are therefore left
declared-but-unread, at zero runtime cost (an unread custom property emits no rule; the matching
`tailwind.config.js` colour entries only mint a class if a class uses them), with the reason and the
delete-by condition written into `tokens.css` beside them: phase 9's `<Surface tone="dark">` either
adopts them or deletes all five. **Open for Ran: confirm keep-vs-delete.**

**Judgment call 2 - one new compiled rule, inert, flagged not fixed.** Removing `darkMode: ['class']`
reverts Tailwind 3 to its default `media` strategy, so any surviving `dark:`-shaped string in scanned
content now compiles under `@media (prefers-color-scheme: dark)` instead of behind a class that never
existed. Exactly one such string survives - `dark:bg-white` in a **synthetic assertion fixture** at
`design-system/__tests__/tokens-guard.test.ts:554`, which the Tailwind content glob happens to scan.
It produces `@media (prefers-color-scheme:dark){.dark\:bg-white{...}}`, and no element in the app ever
carries that class, so it is inert today. It was **not** patched here: the two candidate fixes are
weakening a guard assertion (forbidden) or excluding tests from the content glob (a build-config change
well outside a deletion PR). The durable fix is a phase-12 guard that fails on any `dark:` token in
`src/`; until then this is a latent trap worth knowing about.

**Left for phase 12, deliberately untouched.** `component-api-guard.test.ts:207`'s `'dark:'` entry in
`APPEARANCE_PREFIXES`, and `tokens-guard.test.ts`'s `isDarkVariant` helper plus the radius detector's
dark exemption, are all now dead logic. They only classify strings handed to them, so they cost nothing
and removing them would edit guards during a deletion PR.

**Still unapplied.** The same corrections are owed to `workflows/2026-07-27-w1-tracer-bullet.md`
(lines 26-27 and exit criterion line 72 still say "59 classes, 12 files"; the true figure is 51 across
11, plus three non-`components/ui/` surfaces). That file does not exist in this worktree - it lives only
as an untracked file in the main checkout - so the correction could not be made here. **Ship agent: make
it, or copy the workflows directory into the worktree first.**

#### Phase 7 decisions (W1 design phase, 2026-07-28)

The four questions §6 asked the implementer, answered with their evidence. All four are now **closed**
and struck from §6. Every number was re-derived with the guard exports over the 408 in-scope files.

**D1 - does `sm` move from `h-9` to `h-8`, or does `xs` absorb the compact demand? (was §6 Q1)**

**Neither. `sm` stays at 36px, and the compact demand needs three new rungs, not one.** Settled ladder:
`3xs` 24 / `2xs` 28 / `xs` 32 / `sm` 36 / `md` 40 / `lg` 44, uniform 4px step. Full spec in §2a.6.

Evidence:
- `sm` cannot move: **267 of 504** Button call sites pass `size="sm"`. Moving it silently reshapes 267
  rendered sites, a direct breach of the hard constraint. There is no additive version of "sm moves".
- `xs` alone cannot absorb it: the compact demand is three clusters, not one. Rendered heights over the
  318 filled/outline raw `<button>`s whose height resolves, snapped to the nearest 4px:
  24px 34, 28px 58, 32px 63, 36px 95, 40px 40, 44px 7. A `{32,36,40,44}` ladder covers 205 (64%) and
  strands 128; the six-rung ladder covers 297 (93%).
- The 24px rung is not optional: **both tracer pages carry a Button that renders at 24px**
  (`pages/InvoicesPage.tsx:532`, `pages/InvoiceDetailPage.tsx:1107`, both
  `className="h-6 px-2 text-xs"` beating `size="sm"` through `twMerge`). Without `3xs`, exit criterion
  7f is unreachable.
- Six rungs forces `2xs`/`3xs` below `xs`. That is the honest reading: the app has six control heights
  spaced 4px apart, and renaming to make four fit would require moving `sm`, `md` or `lg`, all pinned.

Two corrections this forces on rev 2, both recorded in §2a: `size` is an **absolute** ladder, so a
primitive whose current geometry is not 40px gets a non-`md` default (`Input` is `lg`); and a rung is a
per-primitive (height, padding, font) triple of which **only the height is shared**, which is why 8 of
the 25 real geometry-override call sites cannot be converted mechanically (§2a.7).

**D2 - the arbitrary bracket font sizes: snap to the scale, or register tokens? (was §6 Q2)**

**REGISTER.** Five keys under `theme.extend.fontSize`; full spec and naming in §2a.9.

Evidence: the population is **1,616 occurrences in 192 files** (1,568 in the 9-13.5px band), not the
"~100" §6 assumed - that figure is reproducible only as the raw-filled-button slice. Snapping is not
geometry-neutral: Tailwind is **3.4.19**, preflight sets `html { line-height: 1.5 }`
(`node_modules/tailwindcss/src/css/preflight.css:32`) with no override in `frontend/src/index.css`, so
`text-[Npx]` renders a `1.5 x N` line box, while stock `text-xs` is 12px/**16px** and `text-sm` is
14px/**20px** (verified against `tailwindcss/defaultTheme`). Snapping would change ~1,524 occurrences
visually; registering moves 1,568 as a pure rename with **0 pixels changed**. `fontSize` is absent
from `tailwind.config.js` today, so the addition is purely additive. Only the **44** half-px values
move at all (max 0.5px), and they are the only ones needing visual sign-off.

**Site count it moves: 1,568 occurrences in ~190 files. Inside W1, exactly one:**
`pages/InvoiceDetailPage.tsx:1061`.

**D3 - the `rounded-full` pill buttons: a `shape` prop, or leave them as wrappers? (was §6 Q3)**

**Leave them as wrappers. No `shape` prop on Button in phase 7.** Full reasoning in §2a.10.

Evidence: **43** filled/outline raw sites carry a 9999px radius (rev 2's "41" is the non-circular
subset). Most sit at or below 24px rendered height with a `px-2.5`/`px-3` + `py-0.5`/`py-1` + font-class
signature and a selected/unselected ternary - that is `Chip`, not a smaller Button. Adding `shape` in
7a would pull those onto Button and pre-empt the `Chip` primitive phase 9 already schedules. W1 could
not validate it regardless: roughly half the 43 sit inside Communication/Copilot/AI, which the tracer
is required to avoid, and **zero** appear on either tracer page. Revisit at phase 9 once `Chip` exists;
the residual Button-side demand is ~11 sites, which is a wrapper, not a prop.

Related and settled at the same time: **radius is not coupled to `size` either** - no rung carries a
`rounded-*` class (§2a.6). This surfaced escalation 1 in §2b: Button renders 14px while **347** raw
buttons render 6px, so phase 11c's conversion would restyle ~347 compact controls.

**D4 - which two pages are the tracer bullet? (was §6 Q4)**

**`frontend/src/pages/InvoicesPage.tsx` (list) + `frontend/src/pages/InvoiceDetailPage.tsx` (detail).**

Evidence for the pick, verified in both files:
- Outside the Communication module, as §6 required.
- **Zero raw `<button>` tags in either file**, so the pair validates the primitive *API* rather than
  turning into a raw-tag conversion exercise - which is what phase 11c is for.
- Small, enumerable appearance surface: **2** Button geometry overrides (both the `3xs`
  `h-6 px-2 text-xs` signature, `InvoicesPage:532` and `InvoiceDetailPage:1107`), **1** arbitrary
  bracket font size (`InvoiceDetailPage:1061`, `text-[10px]`), **2** radius tokens (`rounded-lg` on two
  hand-rolled banners), **0** shadow tokens.
- Honest limitation, stated rather than hidden: because the pair carries no raw `<button>`, no
  `soft`-variant site and no pill, it **cannot** validate the `soft` row, `Chip`, or `Surface`. Those
  three are published as recipes in §2a and are minted in W2/phase 9, not here.

#### §7f-evidence - both pages converted as far as phase 7's own primitives reach, 2026-07-28

**Scope call, made by Ran, not the implementer.** Reaching literal zero on both pages needs `Surface`,
`Chip`, an `Icon` tone axis, a table density axis and `TextLink` - five primitives the plan assigns to
phases 8 and 9. Building them now, inside the tracer branch, was the other option on the table (widen
phase 7 to absorb that work) and Ran explicitly declined it: ship phase 7 with 7f restated honestly and
the residue itemised by owning phase, rather than pull phases 8-9 forward into an unreviewed branch. That
is the same boundary the branch already crossed once by accident on 2026-07-28 night (see
`feedback-delegated-phase-splitting-is-not-delegated-scope-change` in the project memory) - this time it
is a deliberate, asked-for decision instead of a self-authorised one.

**Baseline, re-measured 2026-07-28 against the tracer commit's tip, with the phase-6 guard exports
(`countAnyTagOverridesInFile`, not an ad hoc grep) - not copied from any earlier estimate:** 223
appearance tokens on the two pages (48 `InvoicesPage.tsx`, 175 `InvoiceDetailPage.tsx`). Both totals
match the earlier planning-phase estimate exactly, which is the same measurement method reproduced
independently.

**What phase 7 itself could still retire, and did - three fixes, each using ONLY a primitive phase 7
already built, on the plan's own admission that it was left undone:**

1. **Button `3xs`** (7b's own rung, built but never applied to its two call sites). Both
   `InvoicesPage.tsx:567` ("Clear all") and `InvoiceDetailPage.tsx:1134` ("Void") were still spelling
   `size="sm" className="h-6 px-2 text-xs"` - the exact gap 7b's own D1 evidence called out as blocking
   this criterion. Collapsed to `size="3xs"`. **-4 tokens.**
2. **Tabs `pad` axis** (7b's own axis; `tabs.tsx`'s own header already named these five sites as
   "THIS SESSION CONVERTS ONLY InvoiceDetailPage" and listed them undone). `TabsList`'s `px-4 pt-2` to
   `padX={4} padTop={2}`; four `TabsContent p-4` to `pad={4}`. **-6 tokens.**
3. **`Text`** (7d's own deliverable - built, documented as retiring exactly this residue, never applied
   to either page). Converted every `span`/`p`/`div` whose entire appearance surface is colour, size,
   weight, alignment or casing - Text's five axes - to `<Text>`, across both pages including the
   `DataTable` column-cell renderers (the file's own "BLOCKED at 7f" comment on those predates `Text`
   and only ever blocked the `TableCell`/`data-table.tsx` half of the gap, not painting inside a
   renderer's own return value, which needs neither file touched). Left as raw className wherever a
   token needs something Text does not own: border/background/radius/container-padding (`Surface`,
   unbuilt), a hover pseudo-class (no such Text axis), or a hand-rolled `<table>` cell / react-router
   `Link` (table density axis and `TextLink`, both unbuilt). 33 call sites across both pages.
   **-74 tokens.**

**Total retired: 84. 223 to 139** (25 `InvoicesPage.tsx`, 114 `InvoiceDetailPage.tsx`).

**What is left, 139 tokens, itemised by the primitive/phase that owns the fix - re-derived with the same
guard exports, not eyeballed:**

| Owner | Count | What it looks like |
|---|---|---|
| Table density axis (phase 8) | 66 | The invoice ledger and "needs invoicing" tables are hand-rolled `<table>`/`<tr>`/`<td>`/`<th>` markup, not the `Table`/`TableCell` primitives - none of their padding/alignment/weight classes have a prop to move to at this density (`components/data/table.tsx`'s own cell is `p-4`, against this markup's `py-2`/`py-2.5` - adopting it today would restyle every cell). |
| `Surface` (phase 9) | 35 | The overdue/voided banners, the payment-row left-border accent, the refund divider rules, the notes-item divider, the tabs loading-skeleton frame - border/background/radius/container-padding, none of it copy. |
| `TextLink` (phase 9) | 19 | Every react-router `Link` styled inline as copy (customer/job/estimate names in the hero, the ledger's estimate-source link) - no inline-link primitive exists; `Button variant="link"` is a 40px control, not text. |
| `Surface`/`Chip` (phase 9) | 8 | The ledger's "INVOICE" source pill and the two banner-adjacent chip-shaped spans - border+radius+padding, not colour-only. |
| No hover/cursor axis on `Text` (by design) | 4 | `cursor-pointer`/`hover:underline` on two now-converted `Text` sites - deliberately not a Text axis (see `text.tsx`'s own header); these stay raw className regardless of which phase ships next. |
| `EmptyState` density ladder (phase 8, follow-on to 6b) | 2 | The two "loading..." messages: `Text` retired their typography, but the 40px (`py-10`)/48px (`py-12`) vertical rung they sit in isn't on `EmptyState`'s 0/6/12/24 ladder yet. |
| `Icon` tone axis (phase 9) | 3 | `<Receipt>`/`<Paperclip>` (lucide icons) carrying `text-text-secondary` - no primitive owns SVG colour; phase 7's own attempt at an `Icon` primitive was built and removed (name collision with the ubiquitous `const Icon = report.icon` pattern, reddened the layering guard repo-wide - see the phase-7 commit body). |

**Verification, every fix, both rounds:** `npx tsc --noEmit` clean. Full `npx vitest run` - **344 files /
3353 passed / 7 skipped**, byte-identical to the pre-fix baseline (no test added, none broken).
`node scripts/check-unresolved-classes.mjs` - clean, no new pairs. **Compiled-CSS diff, the strongest
form: built from the same entry and config invocation before and after via `git stash`, compared as
whole files rather than by rule count - byte-identical, matching MD5, both rounds.** Zero pixels moved,
which is exactly the property `text.tsx`'s own header states its conversion depends on ("wrapping any
existing inline copy in a bare Text cannot move a pixel").

### Phase 8 - Complete the primitive APIs

Generalise 7a-7b across all 31 primitives, using the §1b/§1c demand table.

| Step | Primitive | Add |
|---|---|---|
| 8a | Input, Textarea, Select | `size` (54 + 10 + 20 sites) |
| 8b | Label | `size`, `weight` (36) |
| 8c | Dialog, Sheet, Popover, DropdownMenuContent | `size` (14 + 10 + 24 + 5) |
| 8d | Tabs cluster | `size` on `Tabs`, inherited via context (37 + 24 + 9) |
| 8e | Avatar | `size` (9 of 9 sites) |
| 8f | Skeleton | ~~`variant="text"\|"title"\|"block"\|"avatar"`~~ - **DONE 2026-07-29, shipped differently:** kept `shape: block \| circle` as its own axis outside the vocabulary (not renamed to `variant` - block-vs-circle is geometry, not structure or colour) and added `size: xs\|sm\|md\|lg` height rungs undefaulted (107 of **109**); see `skeleton.tsx` |
| 8g | Calendar, Separator, Checkbox, Switch, Badge | `size` where demand exists |
| 8h | **Stand up Storybook** | a story per primitive with controls for every `variant`/`tone`/`size` |

**8h is deliberately here, not at the end (rev 3).** Storybook only needs the primitive APIs to be
final, which is true the moment 8g lands. Putting it at phase 12 would have withheld the designer's
main entry point until after the entire migration. Landing it here also means every primitive built in
phase 9 ships with its story as it is written, rather than needing a retrofit pass later.

**Hard constraint:** the rendered geometry of every existing default is unchanged. 504 Button, 236
Input and 190 Label sites depend on today's output. New sizes are additive; `md` never moves. Enforced
by the compiled-CSS diff and visual regression.

### Phase 9 - Complete the missing primitives

| New primitive | Replaces | Evidence |
|---|---|---|
| `Stack`, `Inline`, `Box` | ad-hoc `flex gap-*` and `mt-*` at call sites | corollary 4; no layout primitives exist |
| `Heading`, `Text` | 206 raw `<h1>/<h2>/<h3>` | 41 signatures |
| `Alert` | the `bg-danger/10 border border-danger/20` family | 22x one signature |
| `Chip` | small bordered pills | 20x `px-2.5 py-1.5` |
| `DataTable` shell | 57 raw `<table>` | 10 signatures |
| `Link` (via `asChild`/Slot) | 44 raw `<a>` | must render as router Link, `<a>` or `<button>` |
| `Thumbnail` | 38 raw `<img>` | 32 size, 20 radius |
| `Surface` | the `onDark` context | replaces a variant with a context |

One primitive per PR, each with its Storybook story and tests.

### Phase 10 - Complete the composition layer

| Pattern | Collapses |
|---|---|
| `DetailPageShell` | 14 pages with tab strips |
| `Toolbar` / `FilterBar` | 15 pages with search inputs |
| `FormField` (label + control + hint + error) | the Label/Input pairing, 190 + 236 sites |

`FormField` is also the real fix for the 316 unwired labels in the a11y backlog: wiring `htmlFor`/`id`
once in the pattern fixes most of them as a side effect, rather than 316 hand edits.

**DONE 2026-07-30 - all three shipped to `staging`.** PR #1075 `DetailPageShell`, PR #1076 `Toolbar`,
PR #1077 `FormField`. Each is composed only from `ui/` primitives, carries its own test file pinning
byte-exact rendered class strings, and was validated by adoption on exactly ONE uncontested page
(`InvoiceDetailPage`, `pages/inventory/VendorsPage`, `CustomerFormPage` respectively). All three
inherit `DIR_CEILINGS['components/patterns'] = 0` and hold it. Two scope notes recorded at build time:
`DetailPageShell` owns the tab strip only and deliberately NO page header (four distinct header shapes
were measured across the 14 tab pages, so a header slot would either be speculative API or would
silently normalise real page-hierarchy differences); and the pattern was named `Toolbar`, not
`FilterBar`, because `components/filters/FilterBar.tsx` already exists for a different concept (a
facet-popover trigger). Rolling all three out beyond their one validation page each is 11a/11b below.

### Phase 11 - Eliminate bypass, top-down

**CORRECTED 2026-07-30 (second pass). Do not restate raw-tag counts in this document - read them off
the ratchet.** The live numbers are `RAW_TAG_CEILINGS` in
`frontend/src/design-system/__tests__/component-api-guard.test.ts`, and the guard prints every
population and its slack on each run (`npx vitest run src/design-system/__tests__/component-api-guard.test.ts`
-> `ratchet  <button  >  839 / 839  (at floor)`). That is now the single source of truth. A prose copy
in a plan file cannot stay honest and this section already proved it.

**What was wrong.** An earlier revision of this section carried a column headed "Measured 07-30" giving
`button 920 / input 267 / label 167 / textarea 44 / select 14 / heading 261 / a 113 / table 81 / img 56`,
and a preamble asserting those were re-measured against `staging` at `a23ab2083` with roughly +10% drift
in 3 days. **No such measurement was performed.** When the ratchet was actually seeded (PR #1079), all
nine populations were measured twice by independent methods - a boundary-safe regex scan and a
TypeScript-compiler-API walk over real `JsxOpeningElement` / `JsxSelfClosingElement` nodes - which agreed
exactly with each other and disagreed with that column on seven of nine tags. The "07-30" figures were in
fact close to the older rev-2 (07-27) row for `button`/`input`/`label`, which is the tell: the row was
restated, not re-measured. The claimed drift rate was therefore an artefact of a bad number, not a real
signal, and the "populations drift ~10% in 3 days" argument built on it does not hold. The fencing
argument survives on its own merits; the drift evidence does not.

Seeded values at PR #1079, all verified `(at floor)` by the guard's own printout:

| Tag | Seeded | Tag | Seeded |
|---|---:|---|---:|
| `<button>` | 839 | `<a>` | 44 |
| `<input>` | 252 at seed, **248** after the 11a Toolbar batch | `<table>` | 57 |
| `<label>` | 158 | `<img>` | 38 |
| `<textarea>` | 39 | `<select>` | 4 |
| `<h1>`-`<h6>` | 215 | | |

| Step | Work | Scope |
|---|---|---|
| 11a | Remaining pages adopt the phase-10 patterns | see §11.5 - partially shipped |
| 11b | Forms adopt `FormField` | ~110 files, not re-measured |
| 11c | Raw `<button>` -> `Button` | ratchet `button` |
| 11d | Raw `<input>` / `<textarea>` / `<label>` | ratchet `input`, `textarea`, `label` |
| 11e | Raw headings -> `Heading` / `Text` | ratchet `heading` |
| 11f | Surfaces -> `Card` / `Alert` / `Chip` | **evaluated, not built - see §11.7** |
| 11g | Primitive call-site overrides -> props | ratchet `MAX_APPEARANCE_CLASSNAME`/`MAX_SOFT_CLASSNAME` in `layering-guard.test.ts`, closed - hard 27->23, soft 195->155 |

`<a>` (`TextLink` exists), `<table>`, `<img>` and `<select>` are fenced by the ratchet but have no
conversion step of their own yet.

Split **by primitive, not by feature**, so each PR asks one reviewable visual question.

Never-convert list, carried from prior rounds: `asChild` ref-forwarding triggers
(`layout/Sidebar.tsx:115,122` nests `DropdownMenuTrigger asChild` inside `TooltipTrigger asChild`),
invisible click-outside catchers (`fixed inset-0 z-40`), dnd-kit drag handles
(`workflows/StepNode.tsx`).

#### 11.1 Two guard findings that change the prerequisite list (2026-07-30)

1. **The raw-`<button>` lint rule already exists and enforces nothing.** `frontend/eslint.config.js:68`
   carries a `no-restricted-syntax` selector for `JSXOpeningElement[name.name='button']` - but at
   **`'warn'`**, and scoped to `src/components/**` + `src/pages/**` only. Warn never fails CI, and the
   glob misses `src/features/**` (9 sites in `estimate-workspace`). Task "Phase 7 - Guardrails
   (raw-button lint, ...)" is checked off on the strength of this rule; it is advisory only.
2. **`CEILINGS` is the wrong mechanism for a raw-tag ratchet.** `component-api-guard.test.ts:127` is
   `{Card: 2, EmptyState: 5, SectionCard: 0, Badge: 10, TableCell: 3}` - those count APPEARANCE TOKENS
   ON A NAMED PRIMITIVE, not raw tag occurrences. §4.2's "a `CEILINGS` entry per raw tag" needs a
   genuinely new counter keyed by tag name. None exists today.

#### 11.2 Execution sequence (owner-approved 2026-07-30)

**PR 1 - `raw-tag-ratchet`, guard only, zero conversions. SHIPPED as PR #1079 (`accdabdab`).** New
tag-name-keyed counter in `component-api-guard.test.ts`, seeded for **all 9 tags at once** at the
freshly measured values (see the table above, and the guard's own printout for the live figures) so no
population can quietly grow while another is being converted. Each ceiling is proven to go red two ways:
a fixture-driven test that locks the exact count including the multi-line `<button\n  onClick=...>`
shape, plus a second test that runs the real assertion at `ceiling - 1` inside
`expect(() => ...).toThrow()`, so the proof stays permanently green in CI instead of relying on a
one-time manual check. Also flips the eslint rule from `warn` to `error` **scoped to the 5 directories
measured clean today** (`components/__tests__`, `components/brand`, `components/charts`,
`components/payments`, `pages/service-plans`) and widens its glob to include `src/features/**`.

The counting boundary is `<tag(?=[\s/>])`. **The `\s` is load-bearing** - an earlier attempt used
`<button[ >]`, which misses `<button\n  onClick={...}`, the dominant multi-line JSX form, and
undercounted by 8x (107 against a true 839). Any future scan of this tree must include whitespace in the
boundary or it will silently report progress that has not happened.

**PR 2..n - conversions, one PR per module/directory** (roughly 5-15 files each, reviewable as a
coherent unit), each lowering exactly the ceilings it converted. Order: **11a first** - it finishes
what phase 10 started, the three patterns are already proven on one page each, and the diffs are
subtractive - then 11b/11d, 11c, 11e, 11f, 11g. Estimated 35-55 PRs in total across the phase.

**`communication/phone` is fenced now, converted last.** Roughly **233 raw buttons across 28 files,
about 28% of the whole `<button>` population** - materially larger than the 17% an earlier revision of
this section claimed, and enough that 11c's schedule should assume the non-phone remainder is ~600, not
~765. (Measured 2026-07-30 by an independent scan using the guard's own `targetFiles()` selection; it
totals 833 against the guard's 839, a 6-count methodology delta in the comment-stripping, so treat 28%
as accurate to about a point rather than exact.) Its count goes into the ratchet immediately so it
cannot grow, but the conversion waits until every other module is done: the module is entitlement-gated
OFF for every org (so the conversion has no user-visible upside to rush), and it has the largest
live-worktree cluster in the tree (~15 `comm-*`).

#### 11.3 The `<button>` floor will not be zero

Rev 2 measured **613 distinct signatures and 491 singletons** across the raw-`<button>` population, and
sampling on 07-30 confirms it: solid-primary, outline, ghost-icon and text-link shapes all recur, but
the tail is enormous, and a large share of raw `<button>`s are not `Button`-shaped at all (list rows,
segmented toggles, dropdown items, close-X affordances). **If the ratchet's target is 0 it becomes
pressure to jam non-buttons into `Button` to make a number go down.** Each tag instead converges on a
documented irreducible floor with a per-site reason, exactly as `CEILINGS` already documents why
`Badge` is 10 and `TableCell` is 3 rather than 0. 12d ("lower every ratchet to its floor") means that
floor, not zero.

#### 11.4 The visual net covers 2 pages and is not in CI

§4.1 calls visual regression "the primary net for phase 11". The gate was genuinely built in phase 7 -
`frontend/e2e/specs/visual-regression.spec.ts` has real `toHaveScreenshot` assertions with determinism
handled at source (pinned clock, fixed seed literals, an ISO-timestamp response interceptor) and zero
masks. But it asserts exactly **two routes** (`invoices-list`, `invoice-detail`) out of ~112 pages, its
baselines are `*-chromium-darwin.png` (macOS-generated, so a Linux runner produces different pixels),
and **no workflow calls it** - it is reachable only via `npm run test:visual`.

Phase 11 therefore proceeds with a **manual per-PR pixel check** (browser preview, before/after, the
same bar the phase 7 tracer held) rather than an automated gate. Widening the baseline is real work in
its own right - pick a route list, resolve the Linux-vs-macOS baseline question, wire a workflow - and
is recorded here as an available PR 1.5, not a silent assumption.

**Merge-conflict protocol (rev 3, re-measured 2026-07-30).** Rev 2 said "~90 active worktrees". There
are ~110, but only **6 open PRs into `staging`**, and only three touch `frontend/src` at all:

| PR | Branch | Holds |
|---|---|---|
| #1054 | `refactor/ui-kit-00-foundation` | `pages/v2`, `ui-kit/`, `pages/reports`, `components/jobs`, `design-system/tokens*.css`, and the layering/tokens/status-registry guards - **but NOT `component-api-guard.test.ts`**, so PR 1 above is conflict-free |
| #1078 | `serv10x-59-invoice-resend-reminder` | `pages/InvoiceDetailPage.tsx`, `components/crm` |
| #1026 | `fix/itemized-invoice-picker-overflow` | `components/ui/{checkbox,dialog}.tsx`, `components/invoices` |

#1058, #1037 and #1055 change no `frontend/src` file and are not a risk despite their file counts. Rev
2's other named exclusions (`refactor/shared-component-library`, `feat/workflow-builder`,
`pages/tasks/views/*`) have live worktrees but **no open PR**, so they are stale rather than in-flight
- still avoided, but not treated as hard blocks. Re-run this list before every conversion PR; branches
move.

#### 11.5 First 11a wave - what shipped, and the design question it exposed (2026-07-30)

Run as five parallel agents, one per page group, after PR #1079 landed.

| Group | Pattern | PR | Outcome |
|---|---|---|---|
| Inventory toolbar rows (Inventory, PurchaseOrders, PriceBook) | `Toolbar` | #1080 | **merged**, `input` 252 -> 248 |
| ServicePlans, TasksHub | `DetailPageShell` | #1082 | **merged**, no ceiling moved |
| Customer / Job / LeadDetailPage | `DetailPageShell` | #1083 | **merged**, no ceiling moved |
| 4 settings sub-pages | `DetailPageShell` | #1081 | **open, held** - real visual diff found |
| 3 inventory ops pages | `DetailPageShell` | none | **declined before starting** |

**`DetailPageShell` is validated against the one page that is unlike all the others.** Both groups that
refused to merge refused for the same reason, found independently: the component hardcodes
`Card pad={0}` around a padded rail, and almost nothing else in the tree has that shape. Per `tabs.tsx`'s
own measured-demand comment, `InvoiceDetailPage` is the only page in the whole `<Tabs>` inventory that
passes no trigger variant and no padding. Every other tab page uses something else - `underline`,
`underline-fill`, `surface="card"`, its own scroll rail.

The consequence is visible in the component's own API. It now carries **4 core props and 11
configuration props, 8 of them documented "`card={false}` only"**, added in one night by two agents
working in parallel who could not see each other (#1082 landed an API; #1083 reconciled onto it and
added two more). Of the six pages that have adopted it, **exactly one uses the default shape.** The
abstraction that actually survived contact with the tree is "generate a trigger row from an array",
which is real but much smaller than the name, the default, and the prop list imply.

**Do not roll `DetailPageShell` out further until this is settled.** Three options, none yet chosen:
flip the default so `card={false}` is the norm and the Card becomes opt-in; split the component into a
`TabStrip` generator plus a separate carded wrapper; or accept the passthrough surface and document it
as a configuration component rather than a shape-collapsing pattern. #1081 and the 3 inventory ops pages
both unblock from whichever is chosen, so choosing is worth more than either PR.

**Process note: the visual gate in §11.4 did not fire.** Four PRs merged to `staging` with zero
authenticated pixel checks - no agent could reach a logged-in session (sandboxed network, no
credentials, and correctly none tried to route around that). Each said so plainly rather than claiming a
check it had not done, and fell back to byte-exact rendered-class assertions, which is good evidence the
DOM matches intent but cannot judge whether intent was right. #1080 in particular **knowingly shipped
cosmetic deltas** - the shared `Input size="xs"` replaces each page's hand-rolled search box styling
(`rounded-md border border-border bg-surface-light` -> `rounded border-2 border-transparent
bg-text-primary/5`, plus a fixed `h-8`), InventoryPage's search lost its `max-w-md` cap and its icon
shifted `left-3` -> `left-2.5`, and PriceBook's action clusters tightened `gap-3` -> `gap-2`. Those are
real and unreviewed. Either widen the Playwright baseline first (the PR 1.5 in §11.4) or accept that
11a's visual bar was assertion-based, not pixel-based, and record it as such.

**RESOLVED 2026-07-30 on the visual half: Ran reviewed the merged 11a work on `staging` and accepted it,
including #1080's search-box restyle.** The grey-filled borderless `Input` look, the lost `max-w-md` cap
on InventoryPage, the icon and gap shifts, and all five converted tab strips are confirmed correct in the
running app. 11a's visual bar for this wave is therefore assertion-based-plus-one-human-pass, and that is
recorded as sufficient here rather than pretended to be a pixel gate. The §11.4 gap itself is unchanged:
still 2 routes of ~112 in the Playwright baseline, still not in CI.

#### 11.6 `DetailPageShell` is retired in favour of `TabStrip` (owner decision, 2026-07-30)

Ran chose the split. **The abstraction is trigger-row generation, not "the detail page shell."** That is
the only thing genuinely repeated across all six adopters; the Card, the scroll rail and the content tray
are each one page's own structure and belong at the call site where they are readable.

**Target API.** New `frontend/src/components/patterns/TabStrip.tsx`:

| Prop | Purpose |
|---|---|
| `tabs` | `{ value, label: ReactNode, disabled? }[]` - the generated trigger row. `label` stays `ReactNode`, not `string`: real call sites pair the label with a count badge. |
| `active` / `onChange` | controlled value, same as today |
| `children` | the `<TabsContent>` panels, passed through verbatim and never restructured into an array |
| `padX?` / `padTop?` | forwarded to `TabsList`'s own padding contract |
| `listVariant?` / `triggerVariant?` / `triggerClassName?` | forwarded to the `Tabs` primitives, defaulting to those primitives' own defaults |

**Deleted, and NOT replaced by anything:** `card`, `tabsSurface`, `listClassName`, `railWrapperClassName`,
`railWrapperTestId`, `contentWrapperClassName`. Each becomes plain JSX at the call site - `<Card pad={0}>`,
a `<div className="overflow-x-auto border-b border-border" data-testid="tasks-tab-rail">`, and so on. That
is a one-line wrapper the reader can see, instead of a prop they have to go read a component to decode.

**Migration.** `DetailPageShell` is deleted, not deprecated in place; its six current call sites move to
`TabStrip` in the same PR so the tree never carries both. Derived from the 11a agents' reports and to be
re-verified against the real files at build time, not trusted from this table: `InvoiceDetailPage` keeps a
`<Card pad={0}>` wrapper and `padX={4} padTop={2}`; `ServicePlansPage` needs no wrapper at all;
`TasksHubPage` needs its own scroll-rail div plus `triggerVariant="underline"`; `CustomerDetailPage`,
`JobDetailPage` and `LeadDetailPage` each keep their existing page-level card, with `JobDetailPage`
additionally re-expressing its `<Tabs surface="card">` and tinted content tray as its own markup. The bar
stays zero unexplained visual diff, with byte-exact rendered-class assertions per call site.

**Then, and only then, the seven blocked pages.** PR #1081's four settings sub-pages and the three
inventory ops pages were both blocked on exactly the mismatch this split removes. Neither should adopt
anything until `TabStrip` exists; #1081 should be re-derived onto it rather than rebased.

**The rule this establishes, carried into phase 12f.** A composition pattern earns its keep by collapsing
a shape, not by accepting configuration for every shape it meets. If adopting a pattern on a new page
requires a new prop on that pattern, that is evidence the page does not share the shape - leave the page
alone and record the deferral. `DetailPageShell` reached 11 configuration props, 8 of them conditional on
a single boolean, with one of six adopters using the default; that is bypass wearing a pattern's clothes,
and the guards cannot see it because every value arrives as an identifier rather than a literal.

**Sequencing note.** This migration must NOT run concurrently with the 11b/11d forms wave. Three of the
six call sites are entity detail pages that also carry forms, and two waves editing the same page files in
parallel is what produced the accretion above. Run it after that wave lands.

#### 11.7 11f evaluated and deliberately not built; Phase 11 closed (owner decision, 2026-08-01)

**Independent re-measurement** (fresh checkout of `origin/staging`, a from-scratch reimplementation of
§1e's own definition - background **and** radius **and** (border or shadow), idle classes only): **739
surface-shaped classNames**, matching the §1e figure of 726 within the tolerance already documented
there (two independent classifiers, small definitional drift). Breakdown:

| Slice | Count | Note |
|---|---:|---|
| Sitting on `<button>`/`<input>`/`<textarea>`/`<a>`/`<select>` | 196 | already owned by 11c/11d's own ratchets - retires for free as those finish, not 11f's job |
| Fenced (`components/communication`, `pages/communication`, `pages/phone`) | 69 | same fence as every other 11-step |
| Excluded (`pages/design-system` demo) | 15 | |
| **11f-unique, convertible today** (`div`/`span`/`section`/`li`/`p`) | **424** | the real remaining population |

Of the 424: 46% share a signature seen 3+ times (real dedup value), 34% are one-off signatures (bespoke,
near-zero leverage), and half sit in two directories - `components/inventory` (152) and `pages/reports`
(54). Separately, of the full 739, **97 carry a filled/brand/custom background** that no shipped
Card/Alert/Chip variant absorbs regardless of tooling - a full 11f was never going to reach zero either.

**Decision: skip both the conversions and the composite-shape detector/guard.**

1. Phase 11 was never a to-zero phase in practice. `button` closed at 664/839, `input` at 123/252,
   `label` at 124/158, `heading` at 67/215 - every other sub-phase closed as "ratchet locked lower,"
   not "population zero." 11f converting nothing is consistent with that bar, not an exception carved
   out for it.
2. No evidence of active growth: 739 measured now vs. 726 measured 2026-07-27, effectively flat across
   several days of heavy unrelated work elsewhere in the tree.
3. The guard-only-first pattern used for the other nine tags (PR #1079) existed specifically to stop a
   population growing **while an immediately-following conversion wave landed**. With that conversion
   wave not happening, the rationale doesn't transfer - a guard with no conversion behind it just freezes
   an already-known-incomplete number, at the cost of new detector logic (its own false-positive surface:
   what counts as a card vs. a chip vs. a callout is a design judgment, not a grep).
4. Ran's explicit instruction this round: keep scope small, the program has already run longer than
   planned. Building new composite-shape tooling is a bigger commitment than the population it would
   protect.

**Recorded, not silently dropped.** The 424-site population, its breakdown, and the two directories that
dominate it live in this section so a future round can pick either the guard or the conversions back up
without re-deriving the census. If this is revisited, `components/inventory` (152) and `pages/reports`
(54) are the highest-leverage starting slices.

**Phase 11 status: closed.** Every raw-tag ratchet sits at whatever its batches converted (see the
seeded-values table above and each ratchet's own comment history for the running total); 11f closes with
a documented decision rather than a number. W3 (Phase 10 + Phase 11) is done.

### Phase 12 - Storybook, structure, enforcement, docs

| Step | Work |
|---|---|
| 12-story | **DONE** - Storybook now covers the composition layer: 5 pattern stories + the 2 unstoried primitives, `main.ts` globs `components/patterns`, plus a `pattern-story-coverage` guard. See §12.1 |
| 12-charts | **DONE** - Storybook now covers the chart layer: 82 stories across the 10 chart primitives + `ChartCard` + `KpiTile`, `main.ts` globs `components/charts` and `components/data`, plus a `chart-story-coverage` guard. Unblocks 12a. See §12.3 |
| 12a | Retire `DesignSystemPage` - **DONE.** See §12.4 |
| 12b | `git mv` the 8 files out of `features/estimate-workspace/components/` into `components/estimates/`; delete the 4 dead barrels; extend `structure-guard` |
| 12c | Remove the deprecated Button variant aliases from 7a - **DONE.** See §12.2 |
| 12d | Lower every ratchet to its floor |
| 12e | Lint in CI; the remaining unwired labels and 154 `set-state-in-effect` |
| 12f | Write the four rules into `CLAUDE.md` (§5) |

#### 12.1 - Storybook coverage of the composition layer (shipped 2026-08-01)

**What was wrong.** Phase 10 built `components/patterns/` and phase 11.6 replaced `DetailPageShell`
with `TabStrip` - and not one of the five patterns had a Storybook story. Worse, `.storybook/main.ts`
globbed `components/ui/**` only, with an explicit comment that patterns were "intentionally not globbed
here yet", so a pattern story could not have rendered even if someone had written one. The entire layer
a designer is meant to compose pages from was invisible in the tool built for discovering it - corollary
2 failing silently with nothing watching.

**Shipped.** 49 `Patterns/*` stories across all five patterns (FormField 14, PageHeader 11,
ListPageShell 10, TabStrip 7, Toolbar 7), plus the only two `components/ui` primitives that had no story
(`AttachmentLightbox` 7, `VideoPreviewDialog` 4). Verified in a real `storybook build` index, not just by
file existence. New `pattern-story-coverage.test.ts` asserts both halves - every pattern has a co-located
story AND `main.ts` actually globs the directory - and was proved red in both directions.

**Constraint worth knowing before writing another pattern story.** `component-api-guard`'s `targetFiles()`
excludes `components/ui/**` wholesale but does NOT exclude `.stories.tsx` by name, so a story under
`components/patterns` is scanned and counted against `DIR_CEILINGS['components/patterns'] = 0`. The five
pattern stories therefore author zero appearance classes - scaffolding is primitives with props, plus
layout-only classes. This was deliberately NOT solved by carving story files out of the guard: a
composition pattern that cannot be demonstrated without hand-rolled appearance would be evidence the
pattern is incomplete. Measured after the fact: 0 appearance / 36 layout tokens across the five files.

**Two guard traps hit and recorded** (both the same class as
`learning-class-shaped-comment-prose-reddens-unresolved-classes-guard`): (1) `<h1>` written inside
argTypes *description strings* is not stripped by `stripComments` and pushed the heading ratchet 67 -> 72;
(2) an inline SVG fixture broke two guards at once - its `fill` colours are raw 6-digit hex (66 -> 71) and
its hyphenated presentation attributes tokenise as Tailwind classes. Fixed by rewriting the prose and
swapping the SVG for a base64 PNG, never by moving a ceiling.

**12a is blocked, and this is the finding that blocks it.** `DesignSystemPage` (687 lines) is the ONLY
place 10 chart components plus `ChartCard` and `KpiTile` are rendered anywhere - none of them has a
Storybook story. Retiring it today would delete the sole designer-facing documentation of the chart
layer, so 12a's own precondition ("now that Storybook covers every primitive and pattern") is not met.
**Chart stories are the prerequisite for 12a**, and they are not written.

**12c was re-measured and the plan's implied number is wrong.** A naive search finds 221 deprecated
variant call sites, but only **131 in 75 files** are on `<Button>`/`<ButtonLink>` (`ButtonLink` does not
actually exist in this codebase - the real figure is `<Button>` alone). The other 90 sit on `Badge` (6),
`DropdownMenuItem` (16), `ConfirmDialog` (5), `DataTable` (5), `Toast` (4) and `SectionCard` (2), each of
which has its own legitimate `variant="destructive"` / `"secondary"` / `"default"`. A find-and-replace
codemod would corrupt all 90. Any 12c work must be JSX-tag-aware.

#### 12.2 - Remove the deprecated Button variant aliases (shipped 2026-08-01)

**Shipped.** All 9 deprecated aliases (`default`, `business`, `ai`, `destructive`, `secondary`,
`destructiveOutline`, `ghostMuted`, `ghostDestructive`, `ghostDestructiveReveal`) deleted from
`button.tsx`: `LEGACY_VARIANT_CELLS`, the `DeprecatedButtonVariant` type, and the triple-call-signature
`ButtonComponent` overload that carried the `@deprecated` diagnostic are all gone. `Button` is an ordinary
`forwardRef` component again; `button.stories.tsx` no longer needs the `ComponentType` cast that
overloaded signature forced on it. `button.test.tsx` rewritten to match - the alias-equivalence and
TypeScript-language-service deprecation-probe test classes (a ~150-line apparatus) are gone, replaced by
a single `// @ts-expect-error` compile check in the house idiom already used by `chip.test.tsx`. Zero
rendered pixels changed: every surviving cell's class string is byte-for-byte the frozen baseline.

**The regex census undercounted, and TypeScript caught what it missed.** The 131/75 figure from §12.1 was
real but incomplete: a JSX tag-matching regex cannot see into another component's JSX-expression PROP
(`meta={<Button variant="business">...}`, `titleSuffix={<Button variant="ai">...}`) without re-scanning
text it already consumed as part of the OUTER tag's own balanced-brace attribute match - `finditer` never
revisits a consumed span, so a `<Button>` nested inside `meta=`/`titleSuffix=`/similar props on
`SectionCard`, list-page toolbars, etc. is invisible to it. Deleting the alias types from `button.tsx` and
re-running `tsc --noEmit` surfaced **9 more real sites** across 7 files the regex missed entirely
(`PaymentsTab.tsx`, `JobLeadTasksTab.tsx`, `EstimatesPage.tsx` x2, `JobsPage.tsx` x2, `LeadsPage.tsx`, plus
2 assertions in `PageHeader.test.tsx` computing an expected class string via the now-deleted
`ghostMuted` alias). All 9 fixed by hand; a second `tsc --noEmit` pass came back clean. Lesson for any
future codemod in this codebase: a text-pattern census is a good ESTIMATE and a good work-list, but the
TypeScript compiler - not a second regex pass - is the only exhaustive oracle once the old names are
actually deleted from the type, and that final compiler pass is not optional.

**Two call sites computed a variant spanning old and new names**, the exact hazard button.tsx's own header
comment predicted (`settings/UserPermissionsDialog.tsx`, `payments/StripePaymentsStatusCard.tsx`) - both
re-derived to compute `tone` instead of `variant`, closing the escape-hatch signature that used to exist
only for them. Two more computed sites (`LODetailSheet.tsx:457`, `AddLineDialog.tsx:740`) mixed one
deprecated name with one current one in a ternary and needed the same treatment. `ConfirmDialog`'s
internal Confirm button also computed a deprecated name from its own `resolvedTone`; fixed to pass
`tone={resolvedTone}` directly, since `ConfirmDialogTone` (`'brand' | 'danger'`) already matches Button's
own tone vocabulary exactly. **`ConfirmDialog`'s OWN public `variant` prop** (a separate, similarly-shaped
deprecation of ConfirmDialog's own API, pointing at ConfirmDialog's own `tone` prop) was deliberately left
untouched - out of scope for "remove Button's deprecated variant aliases," flagged as a distinct
not-yet-scoped follow-up in that file's own header comment.

**Verification:** `npx tsc --noEmit` clean (zero errors, up from the 9 the first pass surfaced). `eslint`
on every touched file shows zero NEW issues - confirmed by diffing each flagged file against
`origin/staging`, since several touched files carry large pre-existing, unrelated lint debt
(`WorkflowBuilderPage.tsx`'s ref-during-render errors, `WorkflowsHome.tsx`'s hook-in-callback error) that
predates this change and is out of scope for it. Full frontend suite: 394 files / 4348 tests passing.
Every design-system guard ratchet still at floor, `<button>` ratchet unaffected (664/664 - this change
touches `variant` prop values, not raw tag counts). `storybook build` indexes `UI/Button`'s 11 stories
correctly under the simplified, cast-free `Meta<typeof Button>`.

#### 12.3 - Storybook coverage of the chart layer, unblocking 12a (shipped 2026-08-01)

**What was wrong.** `DesignSystemPage` was the only place any of the 10 chart primitives
(`WaveAreaChart`, `CapsuleBar`, `StackedBars`, `HorizontalBars`, `ProgressDonut`, `SegmentedDonut`,
`GaugeArc`, `Funnel`, `SeverityBars`, `Sparkline`), `ChartCard`, or `KpiTile`/`KpiStrip` rendered anywhere
- none had a story, and `.storybook/main.ts` did not even glob `components/charts` or `components/data`,
so a story could not have rendered even if one had been written. This directly blocked 12a: retiring
`DesignSystemPage` before these stories existed would have deleted the sole designer-facing
documentation of the entire chart layer.

**Shipped.** 82 stories across 12 files: the 10 chart primitives (`ProgressDonut`/`SegmentedDonut` each
get their own file, since `Donut.tsx` exports both as named exports with no default either story could
safely claim), `ChartCard`, and `KpiTile` (which also documents `KpiStrip`, its own composition, in one
final story rather than a separate file). `.storybook/main.ts` now globs `components/charts` and
`components/data`. New `chart-story-coverage.test.ts` guard, proved red in both directions (a missing
story, a reverted glob) before landing - see its own header for why it is a separate file from
`pattern-story-coverage.test.ts` rather than a generalisation of it (that guard keys on FILENAME, which
`Donut.tsx`'s one-file-two-components shape breaks; this one keys on the exported COMPONENT NAME
instead, via each story's own `meta.component` declaration, which handles the split naturally).

**Built via a 12-way parallel workflow, then centrally re-verified - and the re-verification caught a
real gap the fan-out missed.** Each of the 12 story files was written by an independent agent, briefed
with the real prop signatures, real sample data (reused verbatim from `DesignSystemPage`'s own gallery,
not invented), and the same hard constraints proven out in §12.1 (no raw hex, no new raw restricted
tags, no class-shaped prose, no hooks in an anonymous `render` arrow). None of the 12 agents were told to
touch `.storybook/main.ts` - discovering it needed a second glob entry was only possible by building the
actual `storybook build` index afterward and finding zero `Charts/*` entries in it despite all 12 files
existing on disk. The lesson from §12.1 held: file existence is not evidence of discoverability:
building and inspecting the real index is. Also found and fixed centrally, none by the agents
themselves: 9 sibling files independently used a Storybook `StoryObj` shape (`render` with no `args`)
that fails to type-check when a component's props are required and `meta` sets no default `args` -
mechanical, same fix each time; one class-shaped-prose hit (`rounded-percentage` in
`ProgressDonut.stories.tsx`, the same trap as §12.1's `<h1>`-in-argTypes and inline-SVG findings).

**A real duplicate-component finding, recorded rather than fixed (out of scope for this pass):**
`DesignSystemPage`'s own "KPI Cards" section does not use the real `KpiTile`/`KpiStrip` primitive at all
- it has a bespoke, locally-defined `KpiCard` component (`spark`/`direction`/`sparkColor` props) that
duplicates `KpiTile`'s job with an incompatible shape. Nothing on `DesignSystemPage` demonstrates the
real primitive; the story file written this pass is the first place it is actually documented.

**Verification:** `npx tsc --noEmit` clean, `eslint` clean on every touched/new file, full frontend
suite 395 files / 4392 tests passing, every design-system guard ratchet still at floor (13 guard files,
297 tests, all green). `storybook build` indexes exactly 82 stories under `Charts/*` + `Data/KpiTile` -
verified by parsing the real build index, not by file existence.

**12a is now unblocked but not executed this round** - retiring `DesignSystemPage` (687 lines, plus the
two throwaway mockup pages it sits alongside) is a distinct, separately-scoped edit (route removal,
`App.tsx` changes, deleting the local `KpiCard` duplicate found above or leaving it as its own follow-up)
and was deliberately left for its own PR rather than folded into this one.

#### 12.4 - Retire DesignSystemPage (shipped 2026-08-01)

**Not a delete-only PR.** Reading the whole 687-line page before touching it found two real, widely-used
primitives it was the ONLY rendered example of, that no prior phase-12 pass had covered: `SectionCard`/
`SectionLabel` (`components/jobs/overview/SectionCard.tsx`, 17 real call sites across estimates, jobs,
crm, communication and reports) and the raw `Table`/`TableHeader`/`TableBody`/`TableRow`/`TableHead`/
`TableCell`/`TableFooter`/`TableCaption` cluster (`components/data/table.tsx`, distinct from `DataTable`
and the primitive it is itself built on, 4+ real page consumers). Both got real stories first - 8 for
SectionCard, 14 for the Table cluster - matching the exact reasoning §12.1/§12.3 already established:
retiring the page's Color Tokens / Typography / Radius & Shadow sections was fine (raw token swatches
with no component to attach a story to, not a coverage gap), but retiring it while these two primitives
still had no other rendered example anywhere would have been the identical mistake 12a itself was
created to fix, just for a smaller population.

**A third glob-discovery gap, same class as the first two.** `SectionCard.tsx` lives in
`components/jobs/overview/`, not any of the four already-globbed roots. `.storybook/main.ts` gained a
fifth enumerated entry for it, plus `orphan-primitive-story-coverage.test.ts` - a narrow guard scoped to
these two named components specifically (not a directory-wide policy, since neither
`components/jobs/overview` nor `components/data` is entirely shared components), proved red in both
directions before landing. This is the SECOND time in the program a story existed on disk and rendered
nowhere because a directory was not yet enumerated in the glob list (see §12.1 for the first, on
`components/patterns`) - flagged in `.storybook/main.ts`'s own header as a real pattern worth a future
consolidation to one recursive glob, deliberately not done in this PR to keep its diff to what retiring
the page actually required.

**Shipped.** `DesignSystemPage.tsx` (687 lines) and its two throwaway siblings, `DashboardMockupPage.tsx`
and `CustomerFormMockupPage.tsx`, deleted along with their three `App.tsx` routes (`/design-system`,
`/design-system/dashboard-mockup`, `/design-system/customer-form-mockup`). No other file imported any of
the three (grepped repo-wide; one unrelated comment in `switch.stories.tsx` records historical
measurement provenance and was left as-is - it describes what a past scan found, not a live reference).

**A real duplicate-component finding from §12.3, closed for free by this deletion, not fixed.**
`DesignSystemPage`'s own bespoke local `KpiCard` (the one that duplicated `KpiTile`'s job with an
incompatible `spark`/`direction`/`sparkColor` shape) was defined and used only inside this file - deleting
the page removes the duplicate along with it, with nothing to migrate.

**Deliberately not fixed here, recorded instead:** the raw token swatches (Color Tokens, Typography,
Radius & Shadow sections) have no replacement - there is no "Tokens" Storybook page, MDX or otherwise.
This was a considered call, not an oversight: a token PALETTE is not a component with props to attach a
`meta.component` to, so it sits outside every guard and every story-coverage pattern this program has
built. A dedicated Storybook docs page for the token layer is a real, distinct future improvement, not
folded into 12a.

**Ratchet slack, not a failure - left for 12d.** Deleting the page removed 10 real `<h1>`-`<h6>` tags, 2
real `TableCell` appearance overrides, and 1 real `<button>` element that existed only inside it, so
three ratchets now report slack (`<h1-h6>` 57/67, `TableCell` 1/3, `<button>` 663/664) rather than sitting
exactly at floor. The guard suite still passes in full (299/299, zero failures) - slack is not a failure,
only something 12d ("lower every ratchet to its floor") can now capture. Not touched in this PR, to keep
its scope to retiring the page.

**Verification:** `npx tsc --noEmit` clean, `eslint` clean on every touched/new file (one real bug caught
and fixed along the way: a literal example glob pattern inside `.storybook/main.ts`'s own header comment
contained a `*/` substring that prematurely closed the block comment, corrupting the whole file into a
syntax error - rewritten to describe the pattern in prose instead of showing it literally). Full frontend
suite 396 files / 4354 tests passing. `storybook build` indexes `Jobs/SectionCard` (8 stories) and
`Data/Table` (14 stories) correctly.

### Parallel track - Meaning layer

Collapse the ~53 status-to-colour maps into one registry, including the known `LeadDetailPage` enum
bug. Independent of phases 7-12 and designer-facing ("what does overdue look like"), so it runs
alongside from the start rather than queueing behind the migration.

---

## 4. Verification

Six layers. Layer 1 is new in rev 2 and closes the audit's largest gap.

**1. Visual regression (NEW).** Playwright is already installed at `frontend/e2e/` with fixtures and
page objects but has zero screenshot assertions. Add `toHaveScreenshot` coverage over a route list plus
a Storybook story matrix once 12a lands. Baseline in phase 7, gate every conversion PR after.

Rationale: the compiled-CSS diff catches a class resolving to *nothing*; it does not catch a class
resolving to something *different*. Phase 11 changes ~2,000 call sites, and without pixels nothing
would notice a button coming out 2px shorter inside one dialog. This is the primary net for phase 11.

**2. Ratchet guards.** A `CEILINGS` entry per primitive and per raw tag (`button:filled`, `input:raw`,
`heading:raw`, `surface:handrolled`), seeded at its measured current value so it starts green, and
lowered only. Every new ratchet must be proven to fail on an injected violation before it is trusted -
a guard that has never gone red is not a guard.

**3. Compiled-CSS diff.** Catches a Tailwind class silently resolving to nothing; Tailwind exits 0 and
emits nothing for an unknown class. Caught the Preflight `border-color` flip in phase 5c that tsc and
2,700 tests all missed. The diff will **not** be empty here: new size classes appear, hand-rolled ones
vanish. The bar is "every line explainable", specifically that nothing existing vanishes while a call
site still depends on it.

**4. Rendered-class assertions, scoped to `components/ui/` only.** Every new prop asserts the exact
class set it produces, including that the default is unchanged. Deliberately **not** used at call
sites: asserting Tailwind strings across 2,000 converted sites would be brittle and would break on any
later token change. At call sites, layers 1 and 2 are the contract.

**5. Storybook completeness test.** Parse every `cva` block under `components/ui/`, collect every
variant key and value, and fail if any value has no story. Enforces corollary 2. It would fail today:
the current gallery shows 8 of Button's 13 variants.

**6. Standard gates.** `npx tsc --noEmit`, `npx vitest run`,
`node scripts/check-unresolved-classes.mjs`. Re-measure the baseline at the branch point; do not trust
a number written here.

### Rules of engagement

- Measure with the guard, never an ad hoc grep. Re-verify every count before acting on it.
- Never raise a ratchet. Never re-baseline to make a check pass.
- No raw hex, no raw Tailwind palette class, no new arbitrary bracket value.
- Never narrow scope silently. If a step is too large, say so and propose the split.
- Record every judgment call in this file. Do not silently drop or silently keep a value.
- Plain hyphens only. No AI attribution in any git artifact.
- Branch off `staging`, PR into `staging`, worktree under `../alpha_crm-worktrees/`.

---

## 5. The rules that land in CLAUDE.md (phase 12f)

Written last, so they describe reality rather than intent. Each maps to a guard.

1. **Appearance is a prop, never a class.** A call site may pass position. It may not pass appearance
   (`bg-*`, `border`, `rounded-*`, `text-<size>`, `shadow-*`, `h-*` on a control). Guard:
   `component-api-guard`.
2. **Spacing comes from the scale.** `<Stack gap={3}>`, never `mt-3`. Guard: `component-api-guard`.
3. **One vocabulary** (§2a): `variant` = structure, `tone` = colour, `size` = control height on an
   absolute px ladder, `pad`/`gap` = 4px-grid steps. `size` never means anything but control height,
   and no default's geometry ever moves. A control primitive without `tone` and `size` is incomplete.
   Guard: a completeness test over `components/ui/`.
4. **Recurring layout becomes a pattern on its second occurrence**, in `components/patterns/`. Guard:
   `structure-guard`.
5. **Every variant has a Storybook story.** Guard: the completeness test (§4.5).

---

## 6. Open questions for the implementer

**Q1 to Q4 are CLOSED** (W1 design phase, 2026-07-28). They are answered with their evidence in
**§3, "Phase 7 decisions"** as D1 to D4, and the resulting vocabulary is §2a. Struck here so nobody
re-opens them:

- ~~**7a:** does `sm` move from `h-9` to `h-8`, or does `xs` absorb the compact demand?~~ -> **D1.**
  Neither: `sm` stays at 36px; the ladder is six rungs, 24/28/32/36/40/44.
- ~~**7a:** the ~100 arbitrary bracket font sizes - snap to the scale, or register tokens?~~ -> **D2.**
  Register. The population is 1,616, not ~100; it moves 1,568 occurrences and 0 pixels.
- ~~**7a:** the 41 `rounded-full` pill buttons - a `shape` prop, or leave them as wrappers?~~ -> **D3.**
  Wrappers. 43, not 41; most are chips, and phase 9's `Chip` owns them.
- ~~**7:** which two pages are the tracer bullet?~~ -> **D4.** `pages/InvoicesPage.tsx` +
  `pages/InvoiceDetailPage.tsx`.

Still open:

1. **9:** does `Text` earn its place, or is `Heading` plus token classes enough? Decide from the
   type-axis cross-tab, not taste.
2. **12a:** Storybook 8 with the Vite builder is the obvious fit; confirm it coexists with the existing
   `vite-plugin-pwa` and Sentry plugin config before committing to it.
3. **7g / W4:** the guard classifies `h-*` as LAYOUT, so no `size` work can move a ratchet and §5 rule 1
   does not match what the guard enforces. Owner decision, carried from discovery. See §2b escalation 5.
4. ~~**Before W3:** the five owner escalations in §2b~~ -> **CLOSED 2026-07-30.** Ruling recorded
   inline in §2b: radius keeps 14px, height stays split (Button 40/Input 44), `business`/`success` stay
   pixel-identical, the `tone="neutral"` wart stays, and the guard's `h-*` classification is deferred to
   7g/W4. Zero restyle from any of the five; W3 is unblocked.
