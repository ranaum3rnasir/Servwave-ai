# Agent Screenshot Workflow — Test-Capture-Analyze Loop

## The Rule

Every agent that tests the scheduler UI follows this loop for EVERY action:

```
1. PERFORM action (navigate, click, drag, hover, switch view)
2. CAPTURE screenshot (save to scheduler-audit folder)
3. READ the screenshot (use Read tool on the PNG file)
4. ANALYZE what you see — does the UI match expectations?
5. REPORT findings (PASS with evidence, or FINDING with evidence)
6. PROCEED to next action
```

**No action is considered tested unless a screenshot was taken AND analyzed.**

---

## For Agent Prompts

When spawning an Eyes or Robot agent, include this instruction block:

```
## Screenshot-Verify-Proceed Protocol

For EVERY test step:
1. Use Playwright to perform the action and take a screenshot:
   await page.screenshot({ path: 'e2e/screenshots/scheduler-audit/{test-id}_{step}.png', fullPage: false });

2. After the Playwright run completes, READ the screenshot file:
   Read file: frontend/e2e/screenshots/scheduler-audit/{test-id}_{step}.png

3. LOOK at the screenshot carefully and describe what you see:
   - What UI elements are visible?
   - Is the text readable? Any truncation?
   - Are colors correct? Is contrast sufficient?
   - Is the layout aligned? Any overlap?
   - Does this match what Google Calendar would show in the same scenario?

4. Report your finding for this step:
   - PASS: "Screenshot shows [description]. This matches expected behavior because [reason]."
   - FINDING: "Screenshot shows [problem]. Expected [X] but see [Y]. Severity: P1/P2."

5. Attach the screenshot path as evidence in your report.

NEVER say "looks correct" without having READ the actual screenshot file.
NEVER skip the screenshot step because "the code analysis says it should work."
```

---

## Screenshot Naming Convention

```
{test-id}_{step-number}_{description}.png
```

Examples:
- `F-01_01_before_drag.png`
- `F-01_02_mid_drag.png`
- `F-01_03_after_drop.png`
- `F-07_01_sidebar_card_visible.png`
- `F-07_02_drag_into_calendar.png`
- `F-07_03_assign_dialog_opened.png`

For multi-step scenarios (like DnD), take a screenshot at EACH stage:
- Before the action (initial state)
- During the action (mid-drag if applicable)
- After the action (result state)

---

## What to Look For in Each Screenshot

### Layout / View Screenshots
- [ ] Sidebar visible and properly separated from calendar?
- [ ] Calendar fills remaining space?
- [ ] Header toolbar elements all visible and not overlapping?
- [ ] Events rendered in correct time slots?
- [ ] View toggle shows correct active state?
- [ ] Date label shows correct date range?

### Event Block Screenshots
- [ ] Job number fully readable (not truncated)?
- [ ] Customer name visible (or properly truncated with ellipsis)?
- [ ] Time label visible on the event?
- [ ] Status color correct (blue=scheduled, green=in-progress, gray=completed, amber=walkthrough)?
- [ ] Urgent badge visible if applicable?
- [ ] Conflict indicator visible if applicable (and NOT the aggressive hatch pattern)?

### Sidebar Screenshots
- [ ] Section headers with counts visible?
- [ ] Cards compact but readable?
- [ ] No horizontal overflow?
- [ ] Collapse/expand chevrons correct?
- [ ] Draggable cards have cursor-grab?

### DnD Screenshots (3-stage capture)
- [ ] Before: Event/card at original position
- [ ] During: Ghost/preview visible following cursor, source dimmed, target highlighted
- [ ] After: Event at new position, sidebar updated if applicable

### Popup/Menu Screenshots
- [ ] Popup positioned near the interaction point?
- [ ] Not clipped by viewport edges?
- [ ] Content readable (job details, action items)?
- [ ] Correct action buttons/menu items visible?

---

## How the Fixer Uses Screenshots

When the Fixer pushes a fix, they should:
1. Ask the Robot to re-run the relevant visual audit screenshots
2. The Eyes agent reads the new screenshots and compares against the finding
3. Verification is based on visual evidence, not code reading

---

## Folder Structure

```
frontend/e2e/screenshots/scheduler-audit/
├── layout_*.png              ← Visual audit baseline (from sched-visual-audit.spec.ts)
├── sidebar_*.png             ← Sidebar states
├── event_*.png               ← Event details
├── dnd_*.png                 ← DnD states
├── planmode_*.png            ← Plan Mode
├── feature_*.png             ← Feature states
├── responsive_*.png          ← Viewport tests
├── F-01_*.png                ← Per-test-ID screenshots (from agent testing)
├── F-07_*.png
├── H-05_*.png
└── ...
```

The visual audit spec captures the baselines. Individual test runs by agents add per-step screenshots with test IDs as prefixes.
