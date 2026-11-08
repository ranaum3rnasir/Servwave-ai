/**
 * The D23 opt-out and its composer, as ONE component with ONE host left: the board's unschedule
 * confirm.
 *
 * It used to sit on the job page's visit dialog and the board's reschedule confirm as well.
 * Customer notifications for a booked or moved trip now come only from the org's automations
 * (scheduling-notifications slice 01), so those dialogs carry no composer and send no notify
 * keys. Removing a trip from the board has no automation behind it, which is why this survives
 * there. The compose STATE is owned by the host (it has to ride the mutation); this renders it
 * and nothing else.
 *
 * Default ON, per D23 ("offers an opt-out, defaulted on") and user story 42 ("defaults to
 * sending"). The API contract is unchanged - omitting the notify object still preserves the
 * automation path for dialog-less callers.
 */
import { Mail } from 'lucide-react';

import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { Textarea } from '@/ui-kit/components/ui/textarea';
import { EmailChipInput } from '@/ui-kit/components/ui/emailChipInput';

import { notifyBlocked, type NotifyCompose } from '@/lib/notifyCompose';

export interface NotifyComposeFieldsProps {
  notify: NotifyCompose;
  onChange: (next: NotifyCompose) => void;
  /** The customer's display name, when there is one. */
  customerName?: string | null;
  /** The address this would go to today. Shown so what the dialog SAYS is what it sends. */
  customerEmail?: string | null;
  /** Unique per host, so two composers on one screen do not collide on element ids. */
  idPrefix?: string;
  /** Explains what the server appends below the message - reads differently per host. */
  detailsNote?: string;
}

export function NotifyComposeFields({
  notify,
  onChange,
  customerName,
  customerEmail,
  idPrefix = 'notify',
  detailsNote = 'The date, time, crew and address are added below your message automatically, so they always match the visit.',
}: NotifyComposeFieldsProps) {
  function patch(next: Partial<NotifyCompose>) {
    onChange({ ...notify, ...next });
  }

  const toId = `${idPrefix}-to`;
  const ccId = `${idPrefix}-cc`;
  const messageId = `${idPrefix}-message`;
  const blocked = notifyBlocked(notify);

  return (
    <div className="border-border mt-4 rounded-lg border">
      <div className="flex items-start justify-between gap-3 p-4">
        <label className="flex cursor-pointer items-start gap-3">
          <Checkbox
            checked={notify.enabled}
            onCheckedChange={(next) => patch({ enabled: next === true })}
            className="mt-0.5"
            aria-label="Notify the customer"
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-foreground text-sm font-medium">
              Notify the customer{customerName ? ` (${customerName})` : ''}
            </span>
            {/* Naming the address is half of D23: a label-only opt-out re-lands the reported bug. */}
            <span className="text-muted-foreground text-xs">
              {customerEmail ? `Email ${customerEmail}` : 'No email address on file - type one below to send'}
            </span>
          </span>
        </label>
        {/* Decorative only, per founder feedback: the mail icon used to sit inline in the
            checkbox label and read oddly next to the box. It now just marks this as the
            "sends an email" section, so it is muted and hidden from assistive tech. */}
        <Mail className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden="true" />
      </div>

      {notify.enabled && (
        <div className="border-border space-y-4 border-t p-4">
          <div className="space-y-1.5">
            <Label htmlFor={toId}>To</Label>
            <Input
              id={toId}
              type="email"
              value={notify.to}
              onChange={(e) => patch({ to: e.target.value })}
            />
            {blocked && <p className="text-destructive text-xs">Enter a valid email address</p>}
          </div>

          <EmailChipInput
            id={ccId}
            label={
              <>
                CC{' '}
                <span className="text-muted-foreground text-xs font-normal">
                  (optional, not saved to customer)
                </span>
              </>
            }
            emails={notify.cc}
            onChange={(cc) => patch({ cc })}
            reserved={[notify.to]}
          />

          <div className="space-y-1.5">
            <Label htmlFor={messageId}>Message</Label>
            <Textarea
              id={messageId}
              rows={4}
              value={notify.message}
              onChange={(e) => patch({ message: e.target.value })}
            />
            <p className="text-muted-foreground text-xs">{detailsNote}</p>
          </div>
        </div>
      )}
    </div>
  );
}

export default NotifyComposeFields;
