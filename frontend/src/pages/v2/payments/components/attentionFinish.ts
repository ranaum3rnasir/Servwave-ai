import { useQueryClient } from '@tanstack/react-query';

import { paymentsPageKeys } from '@/lib/api/paymentsPage';
import { toast } from '@/ui-kit/components/ui/sonner';

import { useDrawerHost } from '../drawerHost';
import { ATTENTION_CARD_TITLE_ID } from './attentionIds';

/**
 * What every successful action does: close the drawer (by removing `d`), and ask again for everything the page shows
 * (attention list and counts, payments, tiles, drawer detail all share the `payments-page` key).
 */
export function useFinish() {
  const queryClient = useQueryClient();
  const host = useDrawerHost();
  return (message?: string) => {
    if (message) toast.success(message);
    if (host.stack.length) host.closeNow();
    void queryClient.invalidateQueries({ queryKey: paymentsPageKeys.all });
  };
}

/** After a resolve the button that opened the dialog is gone, so focus goes to the card's heading. */
export function focusCardHeading() {
  window.setTimeout(() => document.getElementById(ATTENTION_CARD_TITLE_ID)?.focus(), 0);
}

