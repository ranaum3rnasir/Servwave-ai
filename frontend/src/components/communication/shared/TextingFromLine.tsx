import { cn } from '@/lib/utils';
import { fmtPhone } from '@/lib/api/communication-shared';
import { useSendingNumbers, type SmsSendTarget } from '@/lib/api/communication';
import { CustomerPhoneText } from '@/components/contact/ContactText';

/**
 * The one line above every text box (#3023, #3013 row 2): the number the text goes to and ours it leaves from, as the server
 * will send it, in Ran's wordings (2026-11-06):
 *   - our number is the person's own: "Texting (555) 010-5252 from your number, (555) 010-1111";
 *   - any other number of ours (a colleague's line, the main line): "Texting (555) 010-5252 from (555) 010-1111";
 *   - the conversation's number is released or inactive: only "(555) 010-1111 is no longer in use." (the text then leaves
 *     from the main line);
 *   - the conversation's number is still in use but cannot send texts: only "(555) 010-1111 cannot send texts." (the text
 *     then leaves from the main line).
 * `target` is exactly what the text box's send names; null draws nothing (no one to text yet). Nothing is drawn while the
 * numbers are unknown. The other party's number is a customer phone, drawn under the copy rule.
 */
export function TextingFromLine({ target, className }: { target: SmsSendTarget | null; className?: string }) {
  const { data } = useSendingNumbers(target);
  if (!data) return null;
  const style = cn('text-[11px] text-text-secondary', className);
  if (data.noLongerInUse) {
    return (
      <p data-slot="texting-from" className={style}>
        {fmtPhone(data.noLongerInUse)} is no longer in use.
      </p>
    );
  }
  if (data.cannotSendTexts) {
    return (
      <p data-slot="texting-from" className={style}>
        {fmtPhone(data.cannotSendTexts)} cannot send texts.
      </p>
    );
  }
  if (!data.to || !data.from) return null;
  return (
    <p data-slot="texting-from" className={style}>
      Texting <CustomerPhoneText phone={data.to}>{fmtPhone(data.to)}</CustomerPhoneText> from{' '}
      {data.fromIsYours ? 'your number, ' : ''}
      {fmtPhone(data.from)}
    </p>
  );
}
