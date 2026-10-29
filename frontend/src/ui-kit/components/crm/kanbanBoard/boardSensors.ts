import {
  KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";

/**
 * How long a finger rests on a card before it is picked up, and how far it may drift meanwhile.
 * A finger that moves further than the tolerance first is a swipe: the sensor lets go and the
 * browser scrolls the lane. (Mobile slice 32, TOUCH-08 / TOUCH-09.)
 */
export const BOARD_LONG_PRESS_MS = 250;
export const BOARD_LONG_PRESS_TOLERANCE_PX = 5;

/**
 * The sensors every kanban board shares: one per input, each with its own rule.
 *
 * - Mouse: an 8 px drag, so a click on a card still opens it rather than registering as a drag.
 *   This is the board's desktop behaviour from before, unchanged.
 * - Touch: a long-press. A PointerSensor with a distance rule treats a finger like a mouse, so a
 *   swipe that starts on a card picks it up instead of scrolling, and the cards needed
 *   `touch-action: none` to stop the browser panning, which stopped the lane scrolling at all.
 *   With the touch sensor the cards keep normal touch-action: a swipe scrolls, a press-and-hold
 *   drags.
 * - Keyboard: Space to lift, arrows to move, Space to drop.
 *
 * MouseSensor and TouchSensor rather than PointerSensor: a PointerSensor also answers touch
 * pointers, which would bring the swipe-picks-the-card-up behaviour straight back.
 */
export function useBoardSensors() {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: BOARD_LONG_PRESS_MS, tolerance: BOARD_LONG_PRESS_TOLERANCE_PX },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
}
