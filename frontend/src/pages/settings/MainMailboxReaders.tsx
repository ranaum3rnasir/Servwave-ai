import { useState } from 'react';
import { UserPlus, X } from 'lucide-react';
import {
  useLinkReader, useMainMailboxReaders, useReaderCandidates, useUnlinkReader, type ReaderPage,
} from '@/lib/api/emailSender';
import { extractApiError } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth.store';
import { Card } from '@/components/ui/card';
import { Heading } from '@/components/ui/heading';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/use-toast';
import { SearchInput } from '@/ui-kit/components/form/searchInput';
import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { DialogList } from '@/ui-kit/components/ui/dialogList';
import { useDebounce } from '@/ui-kit/hooks/useDebounce';

/**
 * "People who read the main mailbox", on Settings -> Sender Address (PRD 10, S10.8).
 *
 * The company's main mailbox is read by the people linked here, by people on Communication scope All, and, while nobody
 * is linked, by Admins. The Sender Address page is Admin-only (36b), so only an Admin reaches this card. Linking and
 * unlinking people stays the Admin flag's alone (M8, D3: nobody adds themselves to the company mailbox on a lesser right);
 * the server refuses anyone else, and the card still draws the Remove and Add person controls for an Admin only, so it
 * stays right if it is ever mounted elsewhere.
 *
 * A company can have hundreds of people, so the page never ticks them one by one: the linked people are a short list with
 * a Remove each, and "Add person" opens a picker with its own search and its own scroller, both paged by the server.
 */

/** Shown while nobody is linked, word for word. */
const NOBODY_LINKED =
  'Nobody is linked. Admins read the main mailbox until you add someone.';

function Pager({ page, onOffset }: { page: ReaderPage; onOffset: (offset: number) => void }) {
  if (page.total <= page.limit) return null;
  const from = page.total > 0 ? page.offset + 1 : 0;
  const to = page.offset + page.items.length;
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="text-text-secondary">{from}–{to} of {page.total}</span>
      <span className="flex gap-1">
        <Button variant="outline" size="sm" disabled={page.offset === 0} onClick={() => onOffset(Math.max(0, page.offset - page.limit))}>
          Previous
        </Button>
        <Button variant="outline" size="sm" disabled={to >= page.total} onClick={() => onOffset(page.offset + page.limit)}>
          Next
        </Button>
      </span>
    </div>
  );
}

export function MainMailboxReaders() {
  const [offset, setOffset] = useState(0);
  const [adding, setAdding] = useState(false);
  const isAdmin = useAuthStore((s) => s.user?.is_admin === true);
  const { data, isLoading, isError } = useMainMailboxReaders(offset);
  const unlink = useUnlinkReader();

  // Removing the last person of a later page leaves that page empty: step back to the one before it.
  const items = data?.items ?? [];
  if (data && items.length === 0 && data.total > 0 && offset > 0) setOffset(Math.max(0, offset - data.limit));

  function remove(id: string) {
    unlink.mutate(id, {
      onError: (err) => toast({ description: extractApiError(err, 'Could not remove that person. Try again.'), variant: 'destructive' }),
    });
  }

  return (
    <Card className="space-y-3">
      <div className="min-w-0 space-y-1">
        <Heading level={3}>People who read the main mailbox</Heading>
        <p className="text-sm text-text-secondary">
          Replies to emails about a job, lead, estimate or invoice go to that record&apos;s people. Only other mail to the main
          address comes here.
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-40" />
        </div>
      ) : isError || !data ? (
        <p className="text-sm text-text-secondary">Could not load the people who read the main mailbox. Refresh to try again.</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-text-secondary">{NOBODY_LINKED}</p>
      ) : (
        <>
          <ul className="divide-y divide-border rounded-md border border-border" aria-label="People who read the main mailbox">
            {items.map((person) => (
              <li key={person.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
                <span className="min-w-0 break-words text-sm text-text-primary">{person.name}</span>
                {isAdmin && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${person.name}`}
                    disabled={unlink.isPending}
                    onClick={() => remove(person.id)}
                  >
                    <X />
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <Pager page={data} onOffset={setOffset} />
        </>
      )}

      {isAdmin && (
        <div>
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <UserPlus />
            Add person
          </Button>
        </div>
      )}

      {isAdmin && adding && <AddPersonDialog onClose={() => setAdding(false)} />}
    </Card>
  );
}

/** The picker: active people not linked yet, searched by name and paged by the server, in a list of its own. */
function AddPersonDialog({ onClose }: { onClose: () => void }) {
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const settled = useDebounce(search, 250);
  const { data, isPending } = useReaderCandidates(settled, offset);
  const link = useLinkReader();

  function add(id: string) {
    link.mutate(id, {
      onError: (err) => toast({ description: extractApiError(err, 'Could not add that person. Try again.'), variant: 'destructive' }),
    });
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent intent="form" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a person</DialogTitle>
          <DialogDescription>They will read the main mailbox on the Email page.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <SearchInput
            value={search}
            onValueChange={(value) => { setSearch(value); setOffset(0); }}
            placeholder="Search by name"
            aria-label="Search people by name"
          />
          {isPending ? (
            <p className="py-3 text-sm text-text-secondary">Loading…</p>
          ) : !data || data.items.length === 0 ? (
            <p className="py-3 text-sm text-text-secondary">
              {search.trim() ? 'No one matches that name.' : 'Everyone is already linked.'}
            </p>
          ) : (
            <DialogList as="ul" cap="max-h-72 overflow-y-auto overscroll-contain" aria-label="People" className="mt-2 space-y-0.5">
              {data.items.map((person) => (
                <li key={person.id} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 break-words text-sm text-text-primary">{person.name}</span>
                  <Button variant="ghost" size="sm" aria-label={`Add ${person.name}`} disabled={link.isPending} onClick={() => add(person.id)}>
                    Add
                  </Button>
                </li>
              ))}
            </DialogList>
          )}
          {data && <div className="mt-2"><Pager page={data} onOffset={setOffset} /></div>}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
