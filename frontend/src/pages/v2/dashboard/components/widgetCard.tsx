import type { ReactNode } from 'react';

import { Card, CardAction, CardHeader, CardTitle } from '@/ui-kit/components/ui/card';
import { Spinner } from '@/ui-kit/components/ui/spinner';

export interface WidgetCardProps {
  title?: string;
  icon?: ReactNode;
  /** Header right slot - a text link, a count chip, a static caption. */
  right?: ReactNode;
  children: ReactNode;
  /**
   * First fetch only (see WidgetRenderCtx.isLoading). Shows a centered Spinner
   * in place of `children` - for the widgets whose empty state would otherwise
   * assert something false before data arrives ("All clear", "Nothing
   * scheduled"). Per the kit Spinner's own guidance, a short local wait gets a
   * spinner, not a Skeleton shaped like a list that hasn't rendered yet.
   */
  loading?: boolean;
}

/**
 * The shell every non-KPI widget sits in, on the kit's Card.
 *
 * Same four-slot API as `pages/dashboard/widgets/_shared` `WidgetCard`, so a
 * widget body ports by changing one import. The legacy version hand-built the
 * surface (`bg-surface-light rounded-xl border border-border`) and its header
 * rule; both now come from `Card` / `CardHeader`, and the header's right slot
 * is `CardAction`, which is what that grid column exists for.
 *
 * `h-full` is here rather than on each caller because the widget grid sets row
 * heights from the tallest cell in the row and a short card in a tall row would
 * otherwise float. `overflow-hidden` keeps a full-bleed list (rows that run to
 * the card edge, as Needs Attention and Coming Up do) inside the radius.
 *
 * The heading is `CardTitle`. It used to render a div, which the ledger
 * recorded as the one accessibility difference from the legacy shell; it now
 * renders a real `<h3>` and takes a `level` if a page needs a different one.
 */
export function WidgetCard({ title, icon, right, children, loading }: WidgetCardProps) {
  return (
    <Card className="h-full overflow-hidden">
      {title && (
        <CardHeader className="border-b">
          <CardTitle className="flex min-w-0 items-center gap-2">
            {icon}
            <span className="truncate">{title}</span>
          </CardTitle>
          {right && <CardAction>{right}</CardAction>}
        </CardHeader>
      )}
      {loading ? (
        <div className="flex flex-1 items-center justify-center py-10">
          <Spinner size="lg" />
        </div>
      ) : (
        children
      )}
    </Card>
  );
}
