import { useState } from 'react';
import { UserCheck } from 'lucide-react';

import {
  linkInboundErrorMessage, useCustomerMatches, usePickEmailCustomer,
} from '@/lib/api/communication';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { SearchInput } from '@/ui-kit/components/form/searchInput';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@/ui-kit/components/ui/dialog';
import { DialogList } from '@/ui-kit/components/ui/dialogList';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';

/**
 * "Matches several customers" (PRD 10, S10.20).
 *
 * A message from an address that several customers have is linked to none of them. The reading pane says so, and a person with the
 * attach switch picks the one it belongs to; picking links the message and the replies in its conversation to that customer, and
 * its Communication tab lists them. The server offers only the customers that have the sender's address and that the person can
 * open, a page at a time, so the list is a search, never a wall: an address can be shared by a whole franchise.
 */

/** The notice above a conversation that holds such a message, with the picker for those who may use it. */
export function CustomerMatchesNotice({
  emailId, canPick, onToast,
}: {
  /** The received message that matches several customers. */
  emailId: string;
  /** Holds the attach switch: the picker is theirs to open (the server asks for it again). */
  canPick: boolean;
  onToast: (message: string) => void;
}) {
  const [choosing, setChoosing] = useState(false);
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <Badge variant="softAmber" size="sm">Matches several customers</Badge>
      {canPick && (
        <Button variant="outline" size="sm" onClick={() => setChoosing(true)}>
          <UserCheck /> Choose customer
        </Button>
      )}
      {choosing && <ChooseCustomerDialog emailId={emailId} onClose={() => setChoosing(false)} onToast={onToast} />}
    </div>
  );
}

function ChooseCustomerDialog({
  emailId, onClose, onToast,
}: {
  emailId: string; onClose: () => void; onToast: (message: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [settled, setSettled] = useState('');
  const matches = useCustomerMatches(emailId, settled.trim());
  const pick = usePickEmailCustomer();
  const customers = matches.data?.customers ?? [];
  const total = matches.data?.total ?? 0;

  function choose(customerId: string, name: string) {
    pick.mutate(
      { emailId, customerId },
      {
        onSuccess: () => {
          onClose();
          onToast(`Linked to ${name}`);
        },
        onError: (err) => onToast(linkInboundErrorMessage(err)),
      },
    );
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent intent="form" aria-describedby={undefined} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Choose customer</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <SearchInput
            value={search}
            onValueChange={setSearch}
            onDebouncedChange={setSettled}
            delay={250}
            placeholder="Search customers"
            aria-label="Search customers"
          />
          {matches.isPending ? (
            <div role="status" aria-label="Loading" className="mt-2 space-y-2">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-9 w-full" />)}
            </div>
          ) : matches.isError ? (
            <EmptyState title="Could not load the customers." />
          ) : customers.length === 0 ? (
            <EmptyState title="No customer matches." />
          ) : (
            <DialogList as="ul" cap="max-h-72 overflow-y-auto overscroll-contain" aria-label="Customers" className="mt-2 space-y-0.5">
              {customers.map((c) => (
                <li key={c.id}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto w-full justify-start gap-2.5 py-1.5 text-left"
                    disabled={pick.isPending}
                    onClick={() => choose(c.id, c.name)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="text-foreground block truncate text-[13px] font-medium">{c.name}</span>
                      <span className="block truncate text-[11.5px] font-normal">{c.number}</span>
                    </span>
                  </Button>
                </li>
              ))}
            </DialogList>
          )}
          {total > customers.length && (
            <p className="text-muted-foreground mt-2 text-xs">Showing {customers.length} of {total}. Search to narrow them.</p>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
