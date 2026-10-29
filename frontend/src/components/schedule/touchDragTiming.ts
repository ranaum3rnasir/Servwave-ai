/**
 * How a finger picks a scheduler card up (mobile slice 58, TOUCH-09).
 *
 * A finger that rests on a card for this long picks it up; a finger that moves before then is a
 * swipe and the browser scrolls. The tolerance is how far the finger may drift while resting
 * (a finger is never perfectly still). The task board's sensor uses the same two numbers
 * (`ui-kit/components/crm/kanbanBoard/boardSensors.ts`).
 *
 * One home for them, so the calendar adapter, the dispatch-board adapter and the library's own
 * long-press timer (`longPressThreshold` on the calendar) agree.
 */
export const TOUCH_DRAG_HOLD_MS = 250;
export const TOUCH_DRAG_TOLERANCE_PX = 8;
