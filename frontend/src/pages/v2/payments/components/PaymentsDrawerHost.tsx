import { useState } from 'react';

import { Sheet, SheetContent } from '@/ui-kit/components/ui/sheet';

import { useDrawerHost } from '../drawerHost';
import { viewKey, type DrawerView } from '../drawerStack';
import { PHONE_TAP_AREA } from '../phoneTap';
import { DisputeView } from './DisputeView';
import { ItemView } from './itemViews';
import { PaymentView } from './PaymentDrawer';
import { PayoutView } from './PayoutDrawer';
import { RespondView } from './RespondView';

function ViewSwitch({ view }: { view: DrawerView }) {
  switch (view.kind) {
    case 'payment': return <PaymentView paymentId={view.id} />;
    case 'payout': return <PayoutView payoutId={view.id} />;
    case 'dispute': return <DisputeView disputeId={view.id} />;
    case 'respond': return <RespondView disputeId={view.id} />;
    default: return <ItemView itemKey={view.id} />;
  }
}

/**
 * The one drawer of the Payments page (V7-07), mounted once in the page because its stack crosses tabs. One Sheet stays
 * mounted while the view inside it swaps: two modal sheets that mount in the same commit trap focus against each other
 * (the hang a reload on a two-deep address used to cause). Only the top view of the stack is rendered.
 */
export function PaymentsDrawerHost() {
  const host = useDrawerHost();
  const top = host.stack.at(-1) ?? null;
  // The last view stays drawn while the sheet slides out, instead of an empty panel.
  const [last, setLast] = useState<DrawerView | null>(null);
  if (top && (!last || viewKey(last) !== viewKey(top))) setLast(top);
  const shown = top ?? last;
  return (
    <Sheet open={Boolean(top)} onOpenChange={host.onOpenChange}>
      <SheetContent
        side="right"
        intent="content"
        showClose={false}
        className={`${PHONE_TAP_AREA} md:w-[min(32.5rem,100vw)]`}
        onCloseAutoFocus={(event) => {
          const target = host.openerRef.current;
          if (target?.isConnected) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        {shown && <ViewSwitch key={viewKey(shown)} view={shown} />}
      </SheetContent>
    </Sheet>
  );
}
