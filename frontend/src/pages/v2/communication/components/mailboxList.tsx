import { useState } from 'react';
import { Inbox, Layers, Mail, Users } from 'lucide-react';

import { useMailboxList } from '@/lib/api/communication';
import type { MailboxList as MailboxListAnswer } from '@/lib/api/communication';
import { choiceLabel } from '@/components/permissions/switchValueText';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { SearchInput } from '@/ui-kit/components/form/searchInput';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { DialogList } from '@/ui-kit/components/ui/dialogList';
import { useDebounce } from '@/ui-kit/hooks/useDebounce';
import { cn } from '@/ui-kit/lib/utils';

/**
 * The Email page's mailbox list, at the top of the left rail (PRD 10, S10.7): "My mailbox", each mailbox handed to the
 * person, the main mailbox for a person who reads it (S10.8: the server sends it only to them), and, for a person on
 * Communication scope All, "All mailboxes" and a way to pick one person's
 * mailbox. Each entry carries its unread count, from the server's one filter. The folders below it apply inside the
 * mailbox chosen here.
 *
 * A company can have hundreds of people, so the rail never lists them: the picker is a dialog with its own search and its
 * own paged list, and the person's pick sits in the rail as one more entry for as long as it is chosen.
 */

/** The page address's word for the person's own mailbox, and for every mailbox. Anything else is a mailbox id. */
export const MINE = 'mine';
export const EVERY_MAILBOX = 'all';

const PICKER_PAGE_SIZE = 50;

function CountBadge({ count, active }: { count: number; active: boolean }) {
  if (count <= 0) return null;
  return (
    <Badge variant={active ? 'blue' : 'softNeutral'} size="sm">
      {count}
    </Badge>
  );
}

function MailboxButton({
  label, count, active, icon: Icon, onClick,
}: {
  label: string; count: number; active: boolean; icon: React.ComponentType<{ className?: string }>; onClick: () => void;
}) {
  return (
    <li>
      <Button
        variant={active ? 'secondary' : 'ghost'}
        size="sm"
        aria-pressed={active}
        onClick={onClick}
        // The whole name on hover and focus, and wrapped rather than cut off: names are people's and run long.
        title={label}
        className={cn('h-auto min-h-8 w-full justify-start gap-2.5 py-1', active && 'font-semibold')}
      >
        <Icon />
        <span className="min-w-0 flex-1 whitespace-normal break-words text-left">{label}</span>
        <CountBadge count={count} active={active} />
      </Button>
    </li>
  );
}

export interface MailboxListProps {
  /** The answer for the mailbox the page is showing; undefined until it has loaded. */
  list: MailboxListAnswer | undefined;
  /** What the page shows: "mine", "all" or a mailbox id. */
  selected: string;
  onSelect: (value: string) => void;
}

export function MailboxList({ list, selected, onSelect }: MailboxListProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const mineCount = list?.mine.unread ?? 0;

  // A picked mailbox that is not one of the rail's own entries stays visible as an entry of its own.
  const isListed =
    selected === MINE || selected === EVERY_MAILBOX || selected === list?.main?.id || (list?.held ?? []).some((m) => m.id === selected);
  const pickedPerson = !isListed && list?.selected === selected ? list : undefined;

  return (
    <div className="mb-4">
      <p className="text-muted-foreground mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider">Mailboxes</p>
      {/* A person who took over many leavers' mailboxes holds a long list: it scrolls in a box of its own, so the folders below stay in reach. */}
      <ul className="max-h-60 space-y-0.5 overflow-y-auto overscroll-contain" aria-label="Mailboxes">
        <MailboxButton
          label="My mailbox" count={mineCount} active={selected === MINE} icon={Inbox} onClick={() => onSelect(MINE)}
        />
        {(list?.held ?? []).map((m) => (
          <MailboxButton
            key={m.id} label={`${m.name}'s mailbox`} count={m.unread} active={selected === m.id} icon={Mail}
            onClick={() => onSelect(m.id)}
          />
        ))}
        {list?.main && (
          <MailboxButton
            label="Main mailbox" count={list.main.unread} active={selected === list.main.id} icon={Mail}
            onClick={() => onSelect(list.main!.id)}
          />
        )}
        {list?.scope === 'all' && (
          <MailboxButton
            label="All mailboxes" count={list.total_unread} active={selected === EVERY_MAILBOX} icon={Layers}
            onClick={() => onSelect(EVERY_MAILBOX)}
          />
        )}
        {pickedPerson && (
          <MailboxButton
            label={pickedPerson.selected_label ?? 'Mailbox'}
            count={pickedPerson.selected_unread}
            active icon={Mail} onClick={() => onSelect(selected)}
          />
        )}
        {list?.scope === 'all' && (
          <li>
            <Button variant="ghost" size="sm" className="w-full justify-start gap-2.5" onClick={() => setPickerOpen(true)}>
              <Users />
              <span className="flex-1 text-left">Pick a person…</span>
            </Button>
          </li>
        )}
      </ul>
      {list && (
        <p className="text-muted-foreground mt-1.5 px-1 text-[11px]">
          Communication scope: {choiceLabel(list.scope)}
        </p>
      )}
      {pickerOpen && (
        <PersonPicker
          selected={selected}
          onClose={() => setPickerOpen(false)}
          onPick={(id) => {
            setPickerOpen(false);
            onSelect(id);
          }}
        />
      )}
    </div>
  );
}

/** One person's mailbox, picked from everyone's: searched by name, paged, in a list of its own. */
function PersonPicker({
  selected, onClose, onPick,
}: {
  selected: string; onClose: () => void; onPick: (mailboxId: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const settled = useDebounce(search, 250);
  const { data, isPending } = useMailboxList({ selected, search: settled, offset });
  const people = data?.people;
  const shownFrom = people && people.total > 0 ? people.offset + 1 : 0;
  const shownTo = people ? people.offset + people.items.length : 0;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent intent="form" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Pick a person's mailbox</DialogTitle>
          <DialogDescription>Look at one person's mail without the rest.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <SearchInput
            value={search}
            onValueChange={(value) => { setSearch(value); setOffset(0); }}
            placeholder="Search by name"
            aria-label="Search people by name"
          />
          {isPending ? (
            <p className="text-muted-foreground py-3 text-sm">Loading…</p>
          ) : !people || people.items.length === 0 ? (
            <EmptyState title="No mailbox matches that name." />
          ) : (
            <DialogList
              as="ul"
              cap="max-h-72 overflow-y-auto overscroll-contain"
              aria-label="People"
              className="mt-2 space-y-0.5"
            >
              {people.items.map((p) => (
                <li key={p.id}>
                  <Button
                    variant={p.id === selected ? 'secondary' : 'ghost'}
                    size="sm"
                    className="w-full justify-start gap-2.5"
                    onClick={() => onPick(p.id)}
                  >
                    <Mail />
                    <span className="min-w-0 flex-1 truncate text-left">
                      {p.name}
                      {!p.active && <span className="text-muted-foreground"> (inactive)</span>}
                    </span>
                    <CountBadge count={p.unread} active={p.id === selected} />
                  </Button>
                </li>
              ))}
            </DialogList>
          )}
          {people && people.total > PICKER_PAGE_SIZE && (
            <div className="mt-2 flex items-center justify-between gap-2 text-xs">
              <span className="text-muted-foreground">{shownFrom}–{shownTo} of {people.total}</span>
              <span className="flex gap-1">
                <Button
                  variant="outline" size="sm" disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - people.limit))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline" size="sm" disabled={shownTo >= people.total}
                  onClick={() => setOffset(offset + people.limit)}
                >
                  Next
                </Button>
              </span>
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
