import { quickCreateItemShows, quickCreateItems } from '@/components/layout/nav-config';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useMySwitches } from '@/lib/api/mySwitches';

/**
 * What the Texts inbox ("Unknown number") and the dialer ("No match for <number>") offer for a number that belongs to
 * no customer (Roles & Permissions S02.27). Create customer is not offered to anyone; the number becomes a lead or a
 * job, under the same pairs as Create New's New Lead and New Job: Create + the record type's View. Each target is the form's
 * path with the caller's number in `?phone=`, which the form puts in its new-customer part. A person holding neither
 * pair gets no target, so the panel shows the number and nothing to press.
 */
export interface UnknownNumberCreate {
  /** Where "Create lead" goes, or null when the person may not offer it. */
  leadHref: string | null;
  /** Where "Create job" goes, or null when the person may not offer it. */
  jobHref: string | null;
}

export function useUnknownNumberCreate(e164: string): UnknownNumberCreate {
  const ability = useAppAbility();
  const switches = useMySwitches();
  const phone = encodeURIComponent(e164);
  // The target and the pair are the Create New item's own, so the two can never drift apart.
  const offered = (subject: 'Lead' | 'Job'): string | null => {
    const item = quickCreateItems.find((it) => it.subject === subject);
    if (!item || !quickCreateItemShows(item, (action, on) => ability.can(action, on), switches?.values)) return null;
    return `${item.href}?phone=${phone}`;
  };
  return { leadHref: offered('Lead'), jobHref: offered('Job') };
}
