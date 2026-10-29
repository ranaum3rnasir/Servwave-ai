import * as React from "react";

import { cn } from "@/ui-kit/lib/utils";
import { useNestedListClass, useSurroundingPresentation } from "@/ui-kit/hooks/useOverlayPresentation";

type DialogListProps = React.HTMLAttributes<HTMLElement> & {
  /**
   * The cap the list has as a card: `max-h-56 overflow-y-auto`. It is the card's alone. On a phone
   * (full-screen or a sheet) the list drops it and flows in the dialog body, which is the only
   * scroller there (mobile slice 65, SCR-02).
   */
  cap: string;
  /**
   * Classes for a full-screen dialog or a sheet INSTEAD of the cap. Left out, the list just flows
   * in the body. A dialog that lays out its own header, search and results (the body IS the list)
   * gives the list `min-h-0 flex-1 overflow-y-auto` here, so the list is the one scroller.
   */
  sheetClassName?: string;
  /** The element to draw. A list of rows is usually a `ul`. */
  as?: "div" | "ul" | "ol";
};

/**
 * A list inside a dialog body that is capped on a desktop and uncapped on a phone.
 *
 * A component and not only the `useNestedListClass` hook, because the surrounding presentation is
 * published by `DialogContent`: a hook called in the component that RENDERS the dialog sits above
 * that provider and always reads "card". This component sits inside it, wherever it is written.
 */
export function DialogList({ cap, sheetClassName, as: Tag = "div", className, ...props }: DialogListProps) {
  const capClass = useNestedListClass(cap);
  const onPhone = useSurroundingPresentation() !== "card";
  return (
    <Tag
      className={cn(onPhone ? sheetClassName : capClass, className)}
      {...(props as React.HTMLAttributes<HTMLElement>)}
    />
  );
}
