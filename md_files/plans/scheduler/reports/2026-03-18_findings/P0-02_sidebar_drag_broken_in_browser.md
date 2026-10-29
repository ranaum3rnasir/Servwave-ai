# P0-02 — Sidebar Drag to Calendar Does Not Work in Live Browser

**Category:** F — DnD Drop Targets
**Severity:** P0 (Broken — core workflow)
**View(s) Affected:** Week, Day (Standard view)
**Viewport(s):** All
**Status:** FIXED (during Day 1, before QA-only mode)

## Steps to Reproduce
1. Navigate to /schedule
2. Drag an unassigned job card from the sidebar onto the calendar time grid
3. Release the mouse

## Expected Behavior
AssignDialog should open with the drop slot time pre-filled. The job gets assigned to a technician at the dropped time.

## Actual Behavior (Before Fix)
Nothing happened. No dialog, no event placed, no error. The card returned to the sidebar.

## Root Cause
`dragFromOutsideItem` callback (SchedulePage.tsx line 1631) had two bugs:
1. Returned `{ id: '', title: 'Drop to schedule' }` with NO `start`/`end` dates. react-big-calendar needs these to calculate the drop preview and position.
2. Never returned `null` when no drag was in progress. The library uses this to detect external drags — always-truthy meant it always thought an external drag was happening.

## Why Playwright Tests Passed (False Positive)
Playwright's `page.mouse.down()/move()/up()` fires mouse events, NOT HTML5 `dragstart`/`dragover`/`drop` events. The sidebar cards use native HTML5 `draggable` attribute. In a real browser, HTML5 DnD suppresses mouse events. Playwright bypassed this entirely and triggered react-big-calendar's internal mouse-based path instead.

## Evidence
- User report: Ran confirmed sidebar drag doesn't work in Chrome
- Code analysis: `dragFromOutsideItem` returns object without `start`/`end`
- Playwright test D-10 showed AssignDialog opening — false positive via different code path

## Fix Applied
```js
dragFromOutsideItem={() => {
  const id = draggingJobIdRef.current;
  if (!id) return null;
  return { id, title: 'Drop to schedule', start: base, end: new Date(base.getTime() + 2*60*60*1000) };
}}
```

## Lesson Learned
Playwright mouse simulation does NOT test HTML5 native drag. Any test involving `draggable` attribute + `onDragStart` + `dataTransfer` requires either:
1. Actual HTML5 drag event dispatch (`page.dispatchEvent`)
2. Manual browser testing
3. A specialized Playwright helper that fires `dragstart`/`dragover`/`drop` events
