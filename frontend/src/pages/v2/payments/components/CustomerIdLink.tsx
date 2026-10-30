import { useMySwitches } from '@/lib/api/mySwitches';
import { NewTabLink } from '@/components/ui/new-tab-link';

/**
 * A customer's ID (C-1042) as it shows on the Payments page. A person who may open customers (View customers) gets a
 * link that opens the customer in a new tab; everyone else reads plain text. The switch is only a drawing aid: the
 * customer page itself decides access on the server.
 */
export function CustomerIdLink({ customer }: { customer: { id: string; customer_number: string } | null | undefined }) {
  const canOpen = useMySwitches()?.values.view_customers === true;
  if (!customer?.customer_number) return null;
  if (!canOpen) return <span className="tabular-nums">{customer.customer_number}</span>;
  return (
    <NewTabLink variant="customer-id" href={`/customers/${customer.id}`}>
      {customer.customer_number}
    </NewTabLink>
  );
}

/** A table's Customer cell: the name, and under it (12.5px) the customer ID. Both tables use it. */
export function CustomerCell({ customer }: { customer: { id: string; name: string; customer_number: string } }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span>{customer.name}</span>
      {customer.customer_number && (
        <span className="text-text-secondary text-[12.5px]">
          <CustomerIdLink customer={customer} />
        </span>
      )}
    </div>
  );
}
