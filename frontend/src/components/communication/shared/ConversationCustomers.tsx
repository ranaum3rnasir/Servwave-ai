/**
 * #3021 (parent #3013, mockup row 3): the customers a text conversation shows on. A conversation is a pair of numbers, and
 * the server works out, at every read, every customer carrying the other party's number (in the fixed order, #3015). The
 * inbox row is titled with them, "Jordan Lee, Pat Morgan +8"; an open conversation's header reads "On Jordan Lee, Pat Morgan
 * and 8 more customers" with our number below, and "8 more customers" opens the full list, with search and its own scroll.
 */
import { useState } from 'react';
import { SearchablePanel } from '@/components/ui/searchable-panel';
import { CustomerNameText, CustomerPhoneText } from '@/components/contact/ContactText';
import { fmtPhone } from '@/lib/api/communication-shared/phone-customers';
import type { ConversationCustomer, ConversationPair } from '@/lib/api/communication';

/** The inbox row's title: "Jordan Lee", "Jordan Lee, Pat Morgan", or "Jordan Lee, Pat Morgan +8". */
export function conversationCustomersTitle(customers: readonly ConversationCustomer[]): string {
  const named = customers.slice(0, 2).map((c) => c.name).join(', ');
  return customers.length > 2 ? `${named} +${customers.length - 2}` : named;
}

/** What our number is called (#3019): "Main line", or the person's: "Dana Ruiz's number". */
export function ourLineLabel(pair: ConversationPair): string | null {
  if (!pair.ourLine) return null;
  return pair.ourLine.kind === 'main_line' ? 'Main line' : `${pair.ourLine.name}'s number`;
}

/** "8 more customers": opens every customer carrying the number, searchable, in a list that scrolls on its own. */
function MoreCustomers({ customers, more }: { customers: readonly ConversationCustomer[]; more: number }) {
  const [open, setOpen] = useState(false);
  return (
    <SearchablePanel
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button type="button" className="font-semibold text-text-primary hover:underline">
          {`${more} more ${more === 1 ? 'customer' : 'customers'}`}
        </button>
      }
      rows={customers.map((c) => ({
        key: c.id,
        label: c.name,
        render: (
          <div role="listitem" className="truncate px-3 py-1.5 text-[13px] text-text-primary">
            <CustomerNameText customerId={c.id} name={c.name} />
          </div>
        ),
      }))}
      role="list"
      searchPlaceholder="Search customers…"
      searchAriaLabel="Search customers"
      align="start"
      contentClassName="flex w-72 flex-col p-0"
      listClassName="max-h-72 overflow-y-auto overscroll-contain py-1"
    />
  );
}

/** "On Jordan Lee, Pat Morgan and 8 more customers" ("On Jordan Lee and Pat Morgan", "On Jordan Lee" for fewer). */
export function OnCustomersLine({ customers }: { customers: readonly ConversationCustomer[] }) {
  const [first, second] = customers;
  if (!first) return null;
  const name = (c: ConversationCustomer) => <CustomerNameText customerId={c.id} name={c.name} />;
  if (!second) return <>On {name(first)}</>;
  if (customers.length === 2) return <>On {name(first)} and {name(second)}</>;
  return (
    <>
      On {name(first)}, {name(second)} and <MoreCustomers customers={customers} more={customers.length - 2} />
    </>
  );
}

/** The header of an open conversation on a number customers carry: the number, the customers it is on, and our number. */
export function ConversationCustomersHeading({ pair }: { pair: ConversationPair & { customers: readonly ConversationCustomer[] } }) {
  const ours = ourLineLabel(pair);
  const ourNumber = pair.ourNumberE164 ? fmtPhone(pair.ourNumberE164) : null;
  return (
    <div data-testid="sms-conversation-heading" className="min-w-0">
      <p className="truncate text-sm font-semibold text-text-primary">
        <CustomerPhoneText phone={pair.otherPartyE164}>{fmtPhone(pair.otherPartyE164)}</CustomerPhoneText>
      </p>
      <p className="truncate text-[11px] text-text-secondary">
        <OnCustomersLine customers={pair.customers} />
      </p>
      <p className="truncate text-[11px] tabular-nums text-text-secondary">
        {[ourNumber, ours].filter(Boolean).join(' · ')}
      </p>
    </div>
  );
}
