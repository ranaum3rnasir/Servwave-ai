/**
 * Where the on-screen keyboard is (mobile slice 54). One pure function, so the rules live in one
 * place and are tested without a browser; `useKeyboardInset` wires it to the real visual viewport.
 *
 * The keyboard is detected from the visual viewport and the layout viewport, never from the width or
 * the user agent. Two browser behaviours:
 *
 *  - OVERLAYS the page (iOS Safari; Chrome Android before it honours the resizes-content viewport
 *    mode): the layout viewport keeps its height and the visual viewport shrinks, so the gap under
 *    the visual viewport is the keyboard. Sticky footers must lift by that gap.
 *  - RESIZES the layout (Chrome Android with `interactive-widget=resizes-content`): the layout
 *    viewport shrinks and the footer is already above the keyboard. The gap is zero, so the inset is
 *    never counted twice. The keyboard is still known to be open, from the shrink plus a focused field.
 */

/** A software keyboard takes at least this much of the viewport; browser chrome never does. */
export const KEYBOARD_MIN_PX = 150;

export interface KeyboardInput {
  /** `window.innerHeight`: the layout viewport. */
  layoutHeight: number;
  /** The tallest layout viewport seen at this width (the keyboard-closed height). */
  baselineHeight: number;
  vvHeight: number;
  vvOffsetTop: number;
  vvScale: number;
  /** An input, textarea or editable element has focus. */
  editableFocused: boolean;
}

export interface KeyboardMetrics {
  /** Pixels of the layout viewport's bottom edge the keyboard covers; zero when the layout resized. */
  inset: number;
  /** The height the user can actually see. */
  visibleHeight: number;
  open: boolean;
}

export function computeKeyboardMetrics(input: KeyboardInput): KeyboardMetrics {
  const visibleHeight = Math.round(input.vvHeight);
  // Pinch zoom shrinks the visual viewport too; that is not a keyboard.
  if (input.vvScale > 1.01) return { inset: 0, visibleHeight, open: false };
  const overlap = input.layoutHeight - input.vvOffsetTop - input.vvHeight;
  const inset = overlap > KEYBOARD_MIN_PX ? Math.round(overlap) : 0;
  const layoutShrank = input.editableFocused && input.baselineHeight - input.layoutHeight > KEYBOARD_MIN_PX;
  return { inset, visibleHeight, open: inset > 0 || layoutShrank };
}

/** True when a field the user types in has focus (the keyboard only opens for one). */
export function isEditableFocused(doc: Document): boolean {
  const el = doc.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  return !['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'image', 'range', 'color'].includes(type);
}

/**
 * Read the current metrics from a window. `baseline` is the caller's memory of the tallest layout
 * viewport at the current width (it resets when the width changes, i.e. on rotation).
 */
export function readKeyboardMetrics(
  win: Window,
  baseline: { width: number; height: number },
): KeyboardMetrics {
  const layoutHeight = win.innerHeight;
  if (baseline.width !== win.innerWidth) {
    baseline.width = win.innerWidth;
    baseline.height = layoutHeight;
  }
  const vv = win.visualViewport;
  // No visual viewport (jsdom, old browsers): nothing to measure, never a keyboard.
  if (!vv) return { inset: 0, visibleHeight: Math.round(layoutHeight), open: false };
  const editableFocused = isEditableFocused(win.document);
  // The layout only counts as "shrunk" against a baseline taken while no field was being typed in,
  // so grow the baseline freely but never let a keyboard-shrunk height become the new normal.
  if (layoutHeight > baseline.height) baseline.height = layoutHeight;
  return computeKeyboardMetrics({
    layoutHeight,
    baselineHeight: baseline.height,
    vvHeight: vv.height,
    vvOffsetTop: vv.offsetTop ?? 0,
    vvScale: vv.scale ?? 1,
    editableFocused,
  });
}
