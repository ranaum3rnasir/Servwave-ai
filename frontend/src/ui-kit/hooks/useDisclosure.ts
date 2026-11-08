import { useCallback, useState } from "react";

export interface UseDisclosureReturn {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  /** Spread onto Dialog/Drawer/Sheet: {...disclosure.props} */
  props: { open: boolean; onOpenChange: (open: boolean) => void };
}

/**
 * Open/close state for dialogs, drawers and popovers.
 *
 *   const dialog = useDisclosure();
 *   <Button onClick={dialog.open}>Delete</Button>
 *   <ConfirmDialog {...dialog.props} />
 *
 * Every callback is stable, so passing them to memoised children won't
 * retrigger renders.
 */
export function useDisclosure(initial = false): UseDisclosureReturn {
  const [isOpen, setIsOpen] = useState(initial);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((v) => !v), []);

  return { isOpen, open, close, toggle, props: { open: isOpen, onOpenChange: setIsOpen } };
}
