import { useCallback, useRef, type Ref, type RefObject } from "react";

/**
 * Where Radix mounts every floating layer: a picker's list, a date or time list, a menu. It is
 * portalled to <body>, in the order the layers opened.
 */
export const FLOATING_LAYER_SELECTOR = "[data-radix-popper-content-wrapper]";

/** A floating layer that is a list the next click would close. Tooltips ride the same wrapper. */
function isList(layer: Element): boolean {
  return !layer.querySelector('[role="tooltip"]');
}

/**
 * Whether a floating list is open ABOVE `surface`: one that opened after it, so it portalled in
 * later. A list the surface was itself opened from (a confirm raised from inside a popover)
 * precedes it in the document and does not count - otherwise that confirm could never be
 * dismissed by clicking outside it.
 */
export function floatingListIsOpenAbove(surface: Element): boolean {
  return Array.from(document.querySelectorAll(FLOATING_LAYER_SELECTOR)).some(
    (layer) =>
      isList(layer) &&
      (surface.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
  );
}

/**
 * "Was a list open above this surface when the pointer went down?" - read at pointerdown, before
 * any layer's own outside-click handling closes the list: by the time the click lands the list is
 * already gone, so a click handler cannot ask. For a click INSIDE the surface; the backdrop case
 * is `useListClosesFirst`, which needs the document-level listener below instead.
 *
 *   const listAtPointerDown = useListOpenAtPointerDown();
 *   <DialogContent onPointerDownCapture={listAtPointerDown.record} onClick={() => {
 *     if (listAtPointerDown.wasOpen.current) return; ...
 */
export function useListOpenAtPointerDown() {
  const wasOpen = useRef(false);
  const record = useCallback((event: { currentTarget: Element }) => {
    wasOpen.current = floatingListIsOpenAbove(event.currentTarget);
  }, []);
  return { wasOpen: wasOpen as Readonly<RefObject<boolean>>, record };
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as RefObject<T | null>).current = value;
}

/**
 * "Clicking elsewhere with a list open just closes the list." For a modal surface (dialog, sheet),
 * the backdrop is "elsewhere": the FIRST backdrop click while a list is open above the surface
 * only closes that list, and the surface - with whatever unsaved form it holds - stays. The next
 * backdrop click, with no list open, closes the surface as before. Escape needs nothing: Radix
 * already hands it to the topmost layer only.
 *
 * Why it is needed at all: a modal Radix Select swallowed that click for us, and a non-modal list
 * (Combobox, the time and date lists) lets it through to the surface's own click-outside close.
 *
 * Mechanism: a document pointerdown CAPTURE listener records whether a list was open above this
 * surface, before any layer's own outside-click handling can close it; the surface's
 * `onPointerDownOutside` then `preventDefault`s. A caller's own handler runs first, always. The
 * listener is registered by the returned `ref`, so only while the content is mounted (open); the
 * caller's own ref is passed in and still receives the element.
 *
 *   const guard = useListClosesFirst(props.onPointerDownOutside, ref);
 *   <DialogPrimitive.Content {...props} {...guard} />
 */
export function useListClosesFirst<
  E extends { preventDefault: () => void },
  T extends Element = HTMLDivElement,
>(onPointerDownOutside?: (event: E) => void, forwardedRef?: Ref<T>) {
  const listWasOpen = useRef(false);
  const stopRecording = useRef<(() => void) | null>(null);

  // A callback ref, so the recorder lives exactly as long as the content element: Radix mounts the
  // content only while the surface is open (Presence), while this hook runs in the wrapper, which
  // renders for every Dialog/Sheet in the tree, open or shut. A shut surface costs nothing.
  const ref = useCallback(
    (surface: T | null) => {
      assignRef(forwardedRef, surface);
      stopRecording.current?.();
      stopRecording.current = null;
      if (!surface) return;
      const record = () => {
        listWasOpen.current = floatingListIsOpenAbove(surface);
      };
      document.addEventListener("pointerdown", record, true);
      stopRecording.current = () => document.removeEventListener("pointerdown", record, true);
    },
    [forwardedRef],
  );

  return {
    ref,
    onPointerDownOutside: (event: E) => {
      onPointerDownOutside?.(event);
      if (listWasOpen.current) event.preventDefault();
    },
  };
}
