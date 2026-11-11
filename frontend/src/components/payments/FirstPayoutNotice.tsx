import { CircleCheck, Clock } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import type { StripeStatus } from '@/lib/api/shared/organization';
import { firstPayoutNotice } from '@/lib/payments/first-payout-notice';

/** The first-payout notice of the Payments page and the payout account card: the wait until it arrives, then a confirmation. */
export function FirstPayoutNotice({ status }: { status: StripeStatus | undefined }) {
  const notice = status ? firstPayoutNotice(status) : null;
  if (!notice) return null;
  const Icon = notice.tone === 'success' ? CircleCheck : Clock;
  return (
    <Alert tone={notice.tone} role="status" data-testid="first-payout-notice" className="flex items-start gap-2.5">
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="flex flex-col gap-0.5">
        <b className="text-sm">{notice.title}</b>
        <span className="text-sm">{notice.body}</span>
      </div>
    </Alert>
  );
}
