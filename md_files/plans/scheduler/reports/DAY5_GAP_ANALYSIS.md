# Day 5 — Gap Analysis: What Was NOT Tested

## Scenarios Not Tested (115/195 = 59%)

### Not tested because DnD is fundamentally broken (blocked):
| Category | Scenarios | Reason |
|----------|-----------|--------|
| E — DnD Visual Feedback | E-01 to E-14 (14) | Testing ghost preview, snap, source indicators on a system where drag doesn't persist is meaningless |
| I — DnD Performance | I-01 to I-08 (8) | Can't measure FPS on broken drag |
| F-04/F-05/F-06 — Grid DnD targets | 3 | Grid DnD confirmed broken by Ran |
| F-08 — Sidebar → Day view | 1 | Same as F-07, different view |
| F-15 — Sidebar → By-Tech Week | 1 | Grid drop zones confirmed blocked |
| F-16 — Cross-week drag | 1 | Low priority given core DnD broken |
| G-02 to G-10 — Resize details | 9 | Resize confirmed broken (snaps back) |
| H-01 — Drag to past | 1 | Drag works but snaps back regardless |
| H-04 — Drag IN_PROGRESS | 1 | Same snap-back issue |
| H-09 — Rapid successive drags | 1 | Can't test race conditions on broken drag |
| H-10 — Undo after drop | 1 | No drop persists to undo |
| H-11 — Drag during refetch | 1 | TanStack Query interaction moot |
| H-12 — Multi-day event drag | 1 | No multi-day events in test data |
| H-19 — Plan Mode full lifecycle | 1 | Plan Mode partially broken (H-13) |

**Subtotal: 44 scenarios blocked by DnD issues**

### Not tested due to seed infrastructure failures:
| Category | Scenarios | Reason |
|----------|-----------|--------|
| H-17 — Plan Mode persistence | 1 | Seed failed, confirmed broken by Ran manually |
| H-18 — Slot boundary precision | 1 | Seed failed |
| L-05b — Context menu "Mark In Progress" | 1 | Seed failed on retry |
| L-05c — Context menu "Reassign" | 1 | Seed failed on retry |
| F-10 — Sidebar → Month view | 1 | Cards consumed by prior test |
| F-11 — Calendar → Sidebar (unassign) | 1 | Seed failed on retry |
| F-12 — Same position no-op | 1 | Event moved by prior test |
| F-13 — Drop outside bounds | 1 | Seed failed on retry |

**Subtotal: 8 scenarios blocked by test infrastructure**

### Not tested due to time/priority (lower priority items deferred):
| Category | Scenarios | Reason |
|----------|-----------|--------|
| A — Text overflow (remaining) | ~6 | A-04, A-05, A-08, A-10, A-11, A-12 — specific truncation scenarios |
| B — Scroll (remaining) | ~5 | B-03, B-06, B-07, B-09, B-10 — scroll edge cases |
| C — Sidebar (remaining) | ~5 | C-03, C-05, C-07, C-08, C-13 — specific sidebar states |
| K — Visual hierarchy (all) | 12 | Color distinction, contrast ratios, legend readability |
| L — Interactions (remaining) | ~6 | L-08 to L-14 — keyboard shortcuts, loading state, conflict toast details |
| M — State edge cases (remaining) | ~8 | M-03 to M-09, M-11 — specific state configurations |
| N — Feature edge cases (remaining) | ~8 | N-08, N-09, N-10, N-11, N-12, N-21, N-22, N-23 |

**Subtotal: ~50 scenarios deferred (lower priority)**

### Already covered by other means:
| Scenario | How Covered |
|----------|-------------|
| D-04/D-05 click vs drag | Accepted as-is (rbc built-in threshold) |
| D-08 Month view drag | Tested with screenshots, accepted |
| N-20 Off-hours dimming | Inconclusive from screenshots, not critical |

---

## What WAS Tested Thoroughly

| Area | Coverage | Confidence |
|------|----------|------------|
| Sidebar layout and cards | Complete | High — 6 closeup screenshots, measurements |
| Sidebar collapse/expand | Complete | High — before/during/after screenshots |
| Staff filter | Complete | High — All/Tech/Sales screenshots |
| Month button in grouped view | Complete | High — PASS verified |
| Slot popover | Complete | High — appears and dismisses |
| Overlay stacking | Complete | High — tooltip→context menu transition |
| Responsive at 3 viewports | Complete | High — 1440, 1366, 1024 screenshots |
| Completed event protection | Complete | High — P0 fixed and verified |
| Sidebar drag to calendar | Complete | High — P0 fixed, verified by Ran |
| Conflict dialog UI | Complete | High — screenshots + manual verification |
| Network failure recovery | Complete | High — error toast + revert verified |
| DnD root cause analysis | Complete | High — exact line numbers, exact fix |

---

## Recommendations for Post-Fix Testing

After the dev team applies the fixes from the final report, these scenarios should be re-tested:

1. **All DnD scenarios (D, E, F, G, H)** — the 44 blocked scenarios become testable once drag persists
2. **E-category visual feedback** — ghost preview, snap, source indicators — these will be meaningful once drag works
3. **I-category performance** — FPS measurement during drag on a working system
4. **K-category visual hierarchy** — especially after the conflict hatch pattern is replaced
5. **Plan Mode full lifecycle (H-19)** — once H-13 ghost creation is fixed
6. **Grid view DnD (D-09, F-04/F-05/F-06, F-09)** — once grid cards are made draggable
