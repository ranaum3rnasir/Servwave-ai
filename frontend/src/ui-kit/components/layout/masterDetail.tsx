"use client";

import * as React from "react";
import { ArrowLeft } from "lucide-react";

import { cn } from "@/ui-kit/lib/utils";
import { Button } from "@/ui-kit/components/ui/button";
import { useMediaQuery } from "@/ui-kit/hooks/useMediaQuery";

export interface MasterDetailProps {
  list: React.ReactNode;
  detail?: React.ReactNode;
  /** Shown in the detail pane when nothing is selected. */
  placeholder?: React.ReactNode;
  hasSelection?: boolean;
  onBack?: () => void;
  backLabel?: string;
  className?: string;
  detailWidth?: string;
}

/**
 * List on the left, record on the right - the core CRM screen.
 *
 * Narrow viewports can't show both, so it becomes a stack: the list until
 * something is selected, then the detail with a back control. Shrinking both
 * panes instead gives two unusable columns.
 *
 * Each pane scrolls independently, so reading a long record never scrolls the
 * list out from under you.
 */
function MasterDetail({
  list, detail, placeholder, hasSelection = false, onBack,
  backLabel = "Back to list", className, detailWidth = "24rem",
}: MasterDetailProps) {
  const isNarrow = useMediaQuery("(max-width: 1024px)");

  if (isNarrow) {
    return (
      <div data-slot="master-detail" className={cn("flex min-h-0 flex-col", className)}>
        {hasSelection ? (
          <>
            {onBack && (
              <Button variant="ghost" size="sm" onClick={onBack} className="mb-3 -ms-2 self-start">
                <ArrowLeft />{backLabel}
              </Button>
            )}
            {detail}
          </>
        ) : (
          list
        )}
      </div>
    );
  }

  return (
    <div data-slot="master-detail" className={cn("flex min-h-0 gap-4", className)}>
      <div data-slot="master-detail-list" className="min-w-0 flex-1 overflow-y-auto">
        {list}
      </div>
      <aside
        data-slot="master-detail-detail"
        className="shrink-0 overflow-y-auto"
        style={{ width: detailWidth }}
      >
        {hasSelection ? detail : placeholder}
      </aside>
    </div>
  );
}

export { MasterDetail };
