/**
 * "Attach to a lead or job" (#3024; #3013 Q41 and decision 1): the one menu every text and call re-tie opens - each text in
 * the inbox, the inbox's Unrouted "Assign", the text and call rows of the customer, lead and job Communication tabs, and the
 * Calls page drawer. Each caller keeps its own trigger (the inbox text's "Change", the tabs' and the drawer's pill).
 *
 * It lists the leads and jobs of every customer carrying the number that the person can open, grouped by customer, with a
 * search and a scrolling list of its own, and "No lead or job" at the bottom. The server answers what to list and refuses
 * anything else. When no customer carries the number, any lead or job may be picked, as before: the menu then searches every
 * lead and job the person can open. There is no "Move to another customer". The caller shows it only to a person who holds
 * Attach conversations to jobs and leads.
 */
import { useState, type ReactNode } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { useAttachMenuTargets, useJobSearch, useLeadSearch, ATTACH_SEARCH_MIN, type AttachTargetGroup } from '@/lib/api/communication';
import { canAutoFocus } from '@/ui-kit/lib/autoFocus';
import type { AttachPick } from './CommJobMenu';

type Row = { kind: 'job' | 'lead'; id: string; number: string; line: string };

function rowsOf(group: Pick<AttachTargetGroup, 'jobs' | 'leads'>): Row[] {
  return [
    ...group.jobs.map((j) => ({ kind: 'job' as const, id: j.id, number: j.number, line: j.location })),
    ...group.leads.map((l) => ({ kind: 'lead' as const, id: l.id, number: l.number, line: l.detail })),
  ];
}

/** A group's rows the search keeps: a match on the record's number, its line, or the customer's name keeps the row. */
function matching(group: AttachTargetGroup, term: string): Row[] {
  const q = term.trim().toLowerCase();
  const rows = rowsOf(group);
  if (!q || group.customer.name.toLowerCase().includes(q)) return rows;
  return rows.filter((r) => r.number.toLowerCase().includes(q) || r.line.toLowerCase().includes(q));
}

export function AttachMenu({
  target,
  current,
  onPick,
  children,
}: {
  /** The text (`sms`, its message id) or the call being re-tied. */
  target: { kind: 'sms' | 'call'; id: string };
  /** The job and lead it is on now: not offered again. */
  current?: { jobId?: string | null; leadId?: string | null };
  /** A lead or a job, or `null` for "No lead or job". */
  onPick: (pick: AttachPick | null) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const targets = useAttachMenuTargets(target, open);
  const anyRecord = targets.data?.rule === 'any';
  // A number no customer carries: any lead or job, found by search (the two searches are row-scoped on the server).
  const jobHits = useJobSearch(search, open && anyRecord);
  const leadHits = useLeadSearch(search, open && anyRecord);
  const notCurrent = (r: { kind: 'job' | 'lead'; id: string }) =>
    !(r.kind === 'job' ? r.id === current?.jobId : r.id === current?.leadId);

  const groups = anyRecord
    ? []
    : (targets.data?.groups ?? [])
        .map((g) => ({ customer: g.customer, rows: matching(g, search).filter(notCurrent) }))
        .filter((g) => g.rows.length > 0);
  const searched: Row[] = anyRecord && search.trim().length >= ATTACH_SEARCH_MIN
    ? rowsOf({
        jobs: (jobHits.data ?? []).filter((j) => j.open),
        leads: (leadHits.data ?? []).filter((l) => l.open),
      }).filter(notCurrent)
    : [];

  const empty = anyRecord ? searched.length === 0 : groups.length === 0;
  const hint = targets.isLoading || jobHits.isFetching || leadHits.isFetching
    ? 'Searching...'
    : anyRecord
      ? search.trim().length < ATTACH_SEARCH_MIN ? 'Type to search leads and jobs' : 'No matching leads or jobs'
      : search.trim() ? 'No matching leads or jobs' : 'No open leads or jobs';

  const item = (r: Row) => (
    <DropdownMenuItem
      key={`${r.kind}-${r.id}`}
      onClick={() => onPick({ kind: r.kind, id: r.id, label: r.number })}
      className="cursor-pointer"
    >
      <span className="truncate text-[12px]">
        <span className="font-semibold text-primary">{r.number}</span>
        {r.line ? <span className="text-text-secondary"> · {r.line}</span> : null}
      </span>
    </DropdownMenuItem>
  );

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setSearch('');
      }}
    >
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>Attach to a lead or job</DropdownMenuLabel>
        {/* Deliberately NOT a DropdownMenuItem: menu items capture arrow keys and typeahead, which would make the field unusable. */}
        <div className="px-2 py-1.5" onKeyDown={(e) => e.stopPropagation()}>
          <Input
            kind="search"
            size="xs"
            autoFocus={canAutoFocus()}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search leads and jobs"
            aria-label="Search leads and jobs"
          />
        </div>
        {/* The list scrolls on its own, so the search above and "No lead or job" below stay in reach however long it is. */}
        <div role="group" aria-label="Leads and jobs" className="max-h-72 overflow-y-auto overscroll-contain">
          {empty ? (
            <DropdownMenuItem disabled tone="muted" className="text-[12px]">
              {hint}
            </DropdownMenuItem>
          ) : anyRecord ? (
            searched.map(item)
          ) : (
            groups.map((g) => (
              <div key={g.customer.id} role="group" aria-label={g.customer.name}>
                <DropdownMenuLabel>{g.customer.name}</DropdownMenuLabel>
                {g.rows.map(item)}
              </div>
            ))
          )}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onPick(null)} className="cursor-pointer">
          <span className="text-[12px] text-text-secondary">No lead or job</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
