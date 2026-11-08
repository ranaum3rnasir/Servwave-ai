/**
 * One-click attach / reassign menu — lists a customer's OPEN jobs as
 * "number · location" plus an explicit detach reset. Lifted originally from
 * CallsView's call-drawer CallJobMenu (slice E3) so the entity-tab comm rows
 * (Job / Customer / Lead pages) share the exact hub behavior; the id only
 * travels in the reassign payload, never the UI.
 *
 * Two later widenings, both from the same live-QA report ("why can't I attach a
 * call to a job/lead?"):
 *
 *  - LEADS are targets too. A job and its originating lead are two ends of one
 *    thing, and the server stamps the pair whichever end is picked, so this
 *    offers both and reports which kind was chosen. Callers that cannot attach a
 *    lead (SMS and email have no lead endpoint) pass no leads and the group
 *    simply does not render.
 *  - SEARCH, always. Every open of this menu can reach every job and lead in the
 *    org. It began as an unknown-caller fallback and was wrong that way round:
 *    the rows WITH a customer were the ones stuck, listing only that customer's
 *    work with no way to reach anything else or to correct a mis-attach. A
 *    customer now only seeds the default list. See useAttachTargets.
 */
import type { ReactNode } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import type { CustomerJobNav, CustomerLeadNav } from '@/lib/api/communication';

/** What the caller attached to — `null` means detach. */
export type AttachPick = { kind: 'job' | 'lead'; id: string; label: string };

export function CommJobMenu({
  jobs,
  leads = [],
  onPick,
  customerTarget,
  onPickCustomer,
  search = '',
  onSearchChange,
  querying = false,
  needsMoreInput = false,
  loading = false,
  allowDetach = true,
  children,
}: {
  jobs: CustomerJobNav[];
  leads?: CustomerLeadNav[];
  onPick: (pick: AttachPick | null) => void;
  /**
   * THE CUSTOMER ARM (#2021) - OPT-IN, and offered only to a caller that passes both of these.
   *
   * Deliberately a separate prop pair rather than a third `kind` on AttachPick. The other two
   * callers of this menu (CommRowJobControl, CallsView) re-point PLATFORM records, which carry a
   * customer natively - "attach to customer" is not a thing they can do. Widening the union would
   * have handed both of them a case they can never receive but whose `else` branch would silently
   * accept, which is how a shared control grows a wrong behaviour at a call site nobody edited.
   */
  customerTarget?: { id: string; label: string };
  onPickCustomer?: (pick: { kind: 'customer'; id: string; label: string }) => void;
  search?: string;
  onSearchChange?: (v: string) => void;
  querying?: boolean;
  needsMoreInput?: boolean;
  loading?: boolean;
  /** Offer "No job or lead". FALSE for a caller whose entity requires exactly one anchor - a
   *  manually logged communication (2026-08-27) must always name a lead or a job, so detaching
   *  is not a state it can be in and must not be offered. Default true: a call, text or email
   *  genuinely can sit unattached. */
  allowDetach?: boolean;
  children: ReactNode;
}) {
  // The customer arm counts: a menu offering it is not empty, even where this customer has no
  // open job and no open lead - which is exactly the record the customer anchor exists for.
  const offersCustomer = Boolean(customerTarget && onPickCustomer);
  const empty = jobs.length === 0 && leads.length === 0 && !offersCustomer;

  // One hint line covers every empty shape, so the menu never sits blank: still
  // fetching, nothing typed yet, a search that missed, or a customer whose own
  // list is empty — and that last one must still invite a search, since the
  // whole org is reachable from here.
  const emptyHint = loading
    ? 'Searching...'
    : needsMoreInput
      ? 'Type to search jobs and leads'
      : querying
        ? 'No matching jobs or leads'
        : 'No open jobs or leads - type to search';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        {/* Deliberately NOT a DropdownMenuItem: menu items capture arrow keys
            and typeahead, which would make the field unusable. */}
        <div className="px-2 py-1.5" onKeyDown={(e) => e.stopPropagation()}>
          <Input
            size="xs"
            autoFocus
            value={search}
            onChange={(e) => onSearchChange?.(e.target.value)}
            placeholder="Search jobs and leads"
            aria-label="Search jobs and leads"
          />
        </div>

        {empty ? (
          <DropdownMenuItem disabled tone="muted" className="text-[12px]">
            {emptyHint}
          </DropdownMenuItem>
        ) : (
          <>
            {jobs.length > 0 && (
              <>
                <DropdownMenuLabel>Jobs</DropdownMenuLabel>
                {jobs.map((j) => (
                  <DropdownMenuItem
                    key={j.id}
                    onClick={() => onPick({ kind: 'job', id: j.id, label: j.number })}
                    className="cursor-pointer"
                  >
                    <span className="truncate text-[12px]">
                      <span className="font-semibold text-primary">{j.number}</span>
                      {j.location ? <span className="text-text-secondary"> · {j.location}</span> : null}
                    </span>
                  </DropdownMenuItem>
                ))}
              </>
            )}

            {leads.length > 0 && (
              <>
                {jobs.length > 0 && <DropdownMenuSeparator />}
                <DropdownMenuLabel>Leads</DropdownMenuLabel>
                {leads.map((l) => (
                  <DropdownMenuItem
                    key={l.id}
                    onClick={() => onPick({ kind: 'lead', id: l.id, label: l.number })}
                    className="cursor-pointer"
                  >
                    <span className="truncate text-[12px]">
                      <span className="font-semibold text-primary">{l.number}</span>
                      {l.detail ? <span className="text-text-secondary"> · {l.detail}</span> : null}
                    </span>
                  </DropdownMenuItem>
                ))}
              </>
            )}

            {offersCustomer && (
              <>
                {(jobs.length > 0 || leads.length > 0) && <DropdownMenuSeparator />}
                <DropdownMenuLabel>Customer</DropdownMenuLabel>
                <DropdownMenuItem
                  onClick={() =>
                    onPickCustomer!({
                      kind: 'customer',
                      id: customerTarget!.id,
                      label: customerTarget!.label,
                    })
                  }
                  className="cursor-pointer"
                >
                  <span className="truncate text-[12px]">
                    <span className="font-semibold text-primary">{customerTarget!.label}</span>
                  </span>
                </DropdownMenuItem>
              </>
            )}
          </>
        )}

        {allowDetach && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onPick(null)} className="cursor-pointer">
              <span className="text-[12px] text-text-secondary">No job or lead</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
