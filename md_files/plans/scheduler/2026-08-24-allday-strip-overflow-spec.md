# The all-day strip: rigid header and a three-row cap

**Date:** 2026-08-24
**Status:** Implemented, verified in the browser against the real library
**Glossary:** [CONTEXT.md](../../../CONTEXT.md) — *Board*, *Standard view*
**Sibling spec:** [Calendar Entries on the scheduler](2026-08-24-calendar-entries-spec.md) — **shares this rendering path, see §7**

---

## 1. What this is

In Week and Day view the all-day strip sits directly under the date header. Once a day carries
all-day work, the strip grows and the date numbers disappear behind it — the header row is
crushed and the date circle paints *underneath* the all-day pills.

Two separate defects produce this. Both are in the strip, neither is in `DayHeader`.

Measured live, in the running app's stylesheet against real react-big-calendar
1.20.0, by toggling only the two new rules:

| | before | after |
|---|---|---|
| `.rbc-header` row height | **43.9px** (crushed) | **66.5px** (natural) |
| Date circle overflow past its cell | **+13.6px** | none — clears by 9px |
| Total `.rbc-time-header` height | 144.5px | **144.5px, unchanged** |

The fix costs no vertical space. It only stops one row stealing another's.

## 2. Root cause

**Defect A — the header row has no `flex-shrink: 0`.**

`.rbc-time-header-content` is a column flex container with indefinite height. react-big-calendar's
own stylesheet gives `.rbc-allday-cell` `height: 100%`, which resolves to a large hypothetical
size, and grants `flex-shrink: 0` to *only* one sibling:

```css
/* node_modules/react-big-calendar/lib/css/react-big-calendar.css */
.rbc-time-view .rbc-allday-cell     { box-sizing: content-box; width: 100%; height: 100%; }
.rbc-time-view .rbc-allday-events   { position: relative; z-index: 4; }
.rbc-time-header-content            { flex: 1; display: flex; min-width: 0; flex-direction: column; }
.rbc-time-header-content > .rbc-row.rbc-row-resource { border-bottom: 1px solid #ddd; flex-shrink: 0; }
/*                                    ↑ given to row-resource, never to the day-header row */
```

So the day-header row absorbs the whole shortfall and collapses. The fixed-size `w-8 h-8` date
circle inside it then overflows its own cell, and `.rbc-allday-events { z-index: 4 }` beats the
project's `.rbc-header { z-index: 2 }`, so the pills paint over the digits.

⚠️ **Raising the header's `z-index` is not a fix.** It was tried and measured: zero layout change,
the 18.1px overflow is intact, it only flips paint order so digits sit *on top of* pills. The row
is still crushed.

**Defect B — the strip is bounded in pixels, not in rows.**

```css
/* frontend/src/styles/schedule-dark.css */
.schedule-cal.has-allday-events .rbc-allday-cell {
  max-height: 200px;
  overflow-x: hidden;
  overflow-y: auto;    /* scrolls rather than spilling */
}
```

This started as `overflow: visible`, where content taller than the box spilled over the time grid.
`staging` has since changed it to scroll internally — Google Calendar's model — with the reasoning
recorded in the stylesheet: *"a hidden job is the bug this strip exists to fix"*.

⚠️ **This spec overrides that choice, and the reasoning behind it deserves an answer.** A `+N more`
chip does hide jobs, but it is a *disclosure*, not a clip: the count is visible, the affordance is
explicit, and one interaction reveals the whole day. A scrollbar inside a 200px strip is
discoverable only by scrolling, and it still lets the strip grow far enough to crush the header —
which is defect A, unfixed by scrolling. Outlook and FullCalendar both cap; neither scrolls.

**The scroll is kept as a backstop, not removed.** With the row cap the strip tops out around 77px,
so `max-height: 200px` / `overflow-y: auto` never engages — it stays purely as insurance for
anything the cap does not catch.

## 3. Prior art, and the four invariants

| Product | All-day strip behaviour |
|---|---|
| Google Calendar | auto-expands to a limit, then scrolls internally |
| New Outlook | hard cap at **6 rows**, then a dropdown |
| FullCalendar | `dayMaxEventRows` (default **5**), then a `+N more` popover |

None of them let the strip push the date header. All three bound it in **rows**. The invariants:

1. **The date header never shrinks.** It is chrome, not content.
2. **The strip is bounded in rows, not pixels.**
3. **Overflow is an explicit affordance** — never a silent clip and never a spill.
4. **Rows are interval-packed on a fixed pitch** — an item takes the lowest row where it does not
   overlap, so a multi-day bar keeps one row across every column it spans.

## 4. The design

**Rigid header + a three-row cap + `+N more`.**

- `.rbc-header`'s row gets `flex-shrink: 0`; `.rbc-allday-cell` gets `height: auto`. Together these
  restore the 61px header and end the overflow (invariant 1).
- The strip caps at **three rows** (invariant 2). Pills are 22px, per
  [schedule-dark.css:125](../../../frontend/src/styles/schedule-dark.css:125).
- A day with more than three rows' worth shows two rows of pills and a **`+N more`** chip in the
  third (invariant 3). A day with exactly three shows all three — no chip.
- The row cap becomes what bounds the strip; `staging`'s `max-height` + internal scroll stay
  untouched underneath it as a backstop. The empty-strip collapse (`max-height: 0` when
  `.has-allday-events` is absent) is likewise unchanged.

**`+N` counts do not sum across the week, by design.** A multi-day bar occupies a row in every
column it spans, so it is counted in each of those columns. That is the same rule the pills already
follow; making the counts sum would misreport the rows actually consumed.

## 5. Interaction

`+N more` stands for N things, so it can never resolve to one. It opens a **disambiguation list**,
never a record.

**Layer 1 — the day overflow panel.** Anchored under the chip. It lists **the whole day's**
all-day items, not only the hidden ones (FullCalendar's model). This also dissolves the `+1` edge
case: a `+1 more` chip still opens a two-row panel, which is legible, rather than a one-row panel
that should have been a direct hit.

**Layer 2 — the event editor.** Clicking a row in the panel calls `openEditorFor(event)`, the same
path a pill click already takes ([SchedulePage.tsx:1898](../../../frontend/src/pages/v2/schedule/SchedulePage.tsx:1898)).
Layer 2 replaces Layer 1 — the panel closes as the editor opens.

**Hover previews, click pins.**

| Input | Result |
|---|---|
| Hover chip 350ms | panel opens *transient* |
| Mouse out, 200ms grace | transient panel closes |
| Move onto the panel | stays open (WCAG 2.1 SC 1.4.13 *hoverable*) |
| Click chip | panel **pins** — survives mouse-out |
| Click chip again while pinned | stays pinned (not a toggle) |
| Keyboard focus | opens **pinned** — a keyboard user has no mouse-out |
| `Esc`, or click outside | closes, pinned or not (*dismissible*) |
| Drag in flight | hover suppressed; an open panel closes |

Click pins rather than toggles because the chip is a *disclosure*, not a switch: with hover already
opening the panel, a toggling click means the panel that is open under your cursor closes when you
click it, then reopens when you jiggle the mouse. Pin-on-click has one meaning — "keep this".

## 6. Implementation

react-big-calendar **1.20.0 already ships the row cap.** No hand-rolled strip, no fork.

| Lever | Fact |
|---|---|
| `allDayMaxRows` | `Calendar` prop, defaults to `Infinity` ([Calendar.js:345](../../../node_modules/react-big-calendar/lib/Calendar.js:345)) |
| row maths | `TimeGridHeader` passes `maxRows={allDayMaxRows + 1}`; `DateSlotMetrics` then packs into `eventLevels(segments, maxRows - 1)` levels plus an `extra` bucket |
| ⇒ | **`allDayMaxRows={2}` gives the three-row cap**: 2 full rows + a final `EventEndingRow` that renders an event when only one lands in that slot, and `+N more` when several do |
| packing | `eventLevels` is exactly invariant 4 — lowest non-overlapping row, one row per multi-day bar. Already correct; nothing to write |
| `components.showMore` | overrides the chip and receives `{ localizer, slotDate, slot, count, events, remainingEvents }`, where **`events` is the whole day column** and `remainingEvents` is the hidden set ([EventEndingRow.js:131](../../../node_modules/react-big-calendar/lib/EventEndingRow.js:131)) |
| `minRows` | hardcoded to 2 in `TimeGridHeader`, so an empty strip still reserves two rows. This is why the `max-height: 0` collapse in §4 must stay |

Supplying `components.showMore` bypasses rbc's own `onShowMore` wiring entirely, which is what we
want: the custom chip owns its ref (so it can anchor the panel — rbc's `onShowMore` does *not*
forward the anchor element) and receives the day's events directly.

⚠️ The `Calendar` currently sets `popup` ([SchedulePage.tsx:3050](../../../frontend/src/pages/v2/schedule/SchedulePage.tsx:3050)).
That is rbc's own Month-view overlay. It is untouched here only because a custom `components.showMore`
never calls the handler that opens it — but do not remove the custom chip without also reckoning
with `popup`, or the strip will start opening rbc's unstyled overlay.

**Dismissal reuses the existing listener.** [SchedulePage.tsx:882](../../../frontend/src/pages/v2/schedule/SchedulePage.tsx:882)
already runs one document-level `mousedown` capture handler for the context menus and the slot
popovers. The overflow panel joins that effect. **Do not add a second document listener** — two
capture-phase handlers racing on the same `mousedown` is how the slot popovers previously ate their
own opening click.

Two details classification depends on
([overlayDismiss.ts](../../../frontend/src/pages/v2/schedule/overlayDismiss.ts)):

- The panel carries **`data-schedule-overlay`**. That attribute — not a class-name match — is how a
  surface declares "the press landed on me"; the old `[class*="fixed"]` selector broke silently once
  already.
- A press on the **chip** must not close the panel, because the chip re-pins on the `click` that
  follows that same `mousedown`. Without the exception the panel closes and reopens on every pin.

**Not the create-popover.** `allDaySlotPopover` ([SchedulePage.tsx:558](../../../frontend/src/pages/v2/schedule/SchedulePage.tsx:558))
is the *create* affordance for clicking an empty all-day slot. It is not an event-detail popover
and must not be reused as Layer 2.

## 7. Cross-reference: the Calendar Entries collision

[The Calendar Entries spec](2026-08-24-calendar-entries-spec.md) names this work as a sequencing
risk against itself, at §9.1:

> **Rendering-path collision.** Entries use `start`/`end` + `is_all_day` on the same all-day strip
> and the same react-big-calendar config as the multi-day work happening in a separate session.
> **Sequence them; do not run both at once.**

The overlap is real but narrow, and it runs in one direction only:

| Entries spec | This spec | Interaction |
|---|---|---|
| §3 "all-day ones ride the existing all-day strip (`allDayAccessor`)" | §4 caps that strip at three rows | Entries inherit the cap for free. Nothing to add there — **but entries make overflow far more common**, because "Dave is off Thursday" is exactly the kind of all-day item that stacks |
| §3 "`isAllDayEvent` — new branch reading `raw.is_all_day`" | reads `isAllDayEvent` unchanged ([scheduleModel.ts:165](../../../frontend/src/components/schedule/scheduleModel.ts:165)) | Additive. This spec touches no branch of that function |
| §3 `EVENT_TYPE_META` gains a **muted** scheme | §5 panel rows must carry the type accent | The panel reads whatever `eventStyleGetter` already yields, so a muted entry stays muted in the panel with no extra work |
| §8 "Walkthrough all-day … `isAllDayEvent` fakes it with `duration >= 1440`" | inherits the same fake | Out of scope in both specs. A ≥1440-minute walkthrough will appear in the strip and can be counted into a `+N`, correctly-per-current-behaviour |

**Sequencing: this spec goes first.** It is CSS plus one prop plus one component, changes no model
and no schema, and leaves the strip in the state Entries assumes ("rides the existing all-day
strip"). Landing Entries first would put more items into a strip that still crushes its own header.

## 8. Explicitly out of scope

- **Month view.** It has its own `+N more` via rbc's `popup` overlay. Untouched.
- **An internal scroll inside the strip** (Google's model). A cap plus a panel is a smaller change
  and matches Outlook/FullCalendar; revisit only if three rows proves too tight.
- **Making the cap configurable per org.** Three is a constant.
- **Timed events.** Nothing here touches the time grid.
- **The `popup` prop.** See the warning in §6.
- **Drag-and-drop into or within the strip.** Unchanged behaviour; the panel is read-only plus
  navigation.

## 9. Risks

1. ~~**rbc's live packing is asserted, not yet observed.**~~ Observed: a day with six all-day items
   renders two pills and `+4 more`, a day with exactly three renders all three and no chip, and a
   multi-day bar holds a single row across every column it spans. The strip measures 77px at its
   three-row maximum.
   ⚠️ Still unobserved **against real job data** — the local checkout is behind `origin/staging`
   (the schema still declares `jobs.scheduled_start`, dropped by #1713), so every `/api/jobs` call
   500s locally. Verification used the real library, the real stylesheet and the real components
   with synthetic events. Re-check on staging.
2. **`allDayMaxRows={2}` reads as "two" and means "three".** The `+1` for the ending row is rbc's,
   not ours. It needs a comment at the call site or someone will "fix" it to 3.
3. **Pinned state versus the shared dismiss effect.** The panel must be in the effect's dependency
   list *and* its early-return guard, or it will pin and then never close.
4. **Hover on touch.** A tap fires the hover path and the click path; the click-pins branch must win.

## 10. Suggested vertical slices

1. **The header fix alone** — `flex-shrink: 0` + `height: auto`, retire `max-height: 200px`. This is
   the visible bug; it stands on its own with no interaction work.
2. `allDayMaxRows={2}` + a styled custom `components.showMore` chip that renders the count.
3. The Layer 1 panel: whole-day list, type accents, row → `openEditorFor`.
4. Hover/pin/focus state machine, drag suppression, and joining the shared dismiss effect.
5. Tests: packing and the cap, the chip count, panel contents, and the pin/dismiss transitions.
