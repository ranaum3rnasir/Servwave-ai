import { useEffect, useRef } from 'react';

import { useSwitchCatalog, type CatalogSwitch, type SwitchValue } from '@/lib/api/permissionSwitches';
import { useRoleChangeLog, usePersonChangeLog, type ChangeLogEntry } from '@/lib/api/permissionChangeLog';
import { formatInstant, useScheduleTimezone } from '@/lib/schedule-tz';
import { choiceLabel, valueText } from '@/components/permissions/switchValueText';
import { Button } from '@/ui-kit/components/ui/button';
import { Card } from '@/ui-kit/components/ui/card';
import { Spinner } from '@/ui-kit/components/ui/spinner';

import { LoadError } from '../../_shared/loadError';

/**
 * The Change log tab of the Roles page and of a person's Permissions page.
 *
 * Newest first, each entry saying who changed which switch, from what to what, when and why. The log lives in its own
 * scroller and asks the server for the next page as its end comes into view, so a role edited for months, or a person
 * whose role was assigned many times, costs a page at a time. Switch names and values come from the switch catalog
 * the editor already holds, so a value reads here exactly as the editor words it. The entries of one burst (a role
 * assignment writes one per switch) are listed one by one, in the order the server keeps them in.
 */

/** The entry's reason, in words. The role a "role assigned" entry gave the person is named when the log knows it. */
function reasonText(entry: ChangeLogEntry): string {
  switch (entry.reason) {
    case 'manual':
      return 'Manual edit';
    case 'role assigned':
      return entry.role_label ? `Role assigned: ${entry.role_label}` : 'Role assigned';
    case 'reset':
      return 'Reset';
    case 'save as role':
      return 'Save as role';
    case 'migration':
      return 'Migration';
    default:
      return choiceLabel(entry.reason);
  }
}

/** A value of a switch the catalog no longer holds: its kind is unknown, so only what the value itself says. */
function plainValue(value: SwitchValue | null): string {
  if (value === true) return 'On';
  if (value === false || value === null) return 'Off';
  if (Array.isArray(value)) return value.length > 0 ? value.map(choiceLabel).join(', ') : 'None';
  return choiceLabel(value);
}

/** What the entry is about, as its heading line. */
function titleOf(entry: ChangeLogEntry, sw: CatalogSwitch | undefined, view: 'role' | 'person'): string {
  if (sw) return sw.label;
  if (entry.switch_key) return 'A switch that no longer exists';
  // The one entry a Save as role writes for the event: it has no switch.
  if (entry.reason === 'save as role') {
    if (view === 'role') return 'Role created through Save as role';
    return entry.role_label ? `Saved as the role ${entry.role_label}` : 'Saved as a role';
  }
  return 'Permissions changed';
}

function ChangeLogRow({ entry, sw, view, tz }: { entry: ChangeLogEntry; sw: CatalogSwitch | undefined; view: 'role' | 'person'; tz: string }) {
  const hasValues = !!entry.switch_key;
  const from = sw ? valueText(sw, entry.from ?? undefined) : plainValue(entry.from);
  const to = sw ? valueText(sw, entry.to ?? undefined) : plainValue(entry.to);
  return (
    <li data-change-entry className="flex flex-col gap-0.5 border-t px-4 py-3 first:border-t-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
        <p className="min-w-0 text-sm font-medium">{titleOf(entry, sw, view)}</p>
        {hasValues && (
          <p className="text-sm">
            <span className="text-muted-foreground">{from}</span>
            <span aria-hidden="true" className="text-muted-foreground mx-1.5">
              &rarr;
            </span>
            <span className="sr-only"> to </span>
            <span className="font-medium">{to}</span>
          </p>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        {entry.actor?.name || 'System'} &middot; {reasonText(entry)} &middot;{' '}
        {formatInstant(entry.created_at, tz, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
      </p>
    </li>
  );
}

/** The end of the list: older entries on their way, a way to ask for them, a failure, or the end. */
function LogFooter({
  hasMore, loading, failed, onLoadMore, root,
}: {
  hasMore: boolean;
  loading: boolean;
  failed: boolean;
  onLoadMore: () => void;
  root: React.RefObject<HTMLDivElement | null>;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  // A failed page is not retried by scrolling (it would loop on a dead connection); Retry is a tap.
  const watching = hasMore && !loading && !failed;

  useEffect(() => {
    const el = sentinel.current;
    if (!watching || !el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (seen) => {
        if (seen.some((e) => e.isIntersecting)) onLoadMore();
      },
      // Watched against the log's own scroller, a little early, so the next page is usually there before the end is.
      { root: root.current, rootMargin: '0px 0px 200px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [watching, onLoadMore, root]);

  return (
    <div data-change-log-end className="px-4 py-3 text-center text-xs">
      {failed ? (
        <LoadError title="Couldn't load older changes." onRetry={onLoadMore} retrying={loading} className="py-4" />
      ) : loading ? (
        <p role="status" className="text-muted-foreground flex items-center justify-center gap-2">
          <Spinner size="sm" label={null} />
          Loading older changes
        </p>
      ) : hasMore ? (
        <Button variant="outline" size="sm" onClick={onLoadMore}>
          Load older changes
        </Button>
      ) : (
        <p className="text-muted-foreground">That&rsquo;s every change.</p>
      )}
      {/* The watched edge: after the button, so the reader reaches it by scrolling past the entries. */}
      <div ref={sentinel} aria-hidden className="h-px" />
    </div>
  );
}

interface LogSource {
  entries: ChangeLogEntry[];
  isPending: boolean;
  isError: boolean;
  isFetchNextPageError: boolean;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  fetchNextPage: () => unknown;
  refetch: () => unknown;
}

function ChangeLogList({ log, view }: { log: LogSource; view: 'role' | 'person' }) {
  const tz = useScheduleTimezone();
  const { data: catalog, isError: catalogUnavailable } = useSwitchCatalog();
  const scroller = useRef<HTMLDivElement>(null);
  const { fetchNextPage } = log;
  const loadMore = () => void fetchNextPage();

  if ((log.isError && !log.isFetchNextPageError) || catalogUnavailable) {
    return <LoadError title="Couldn't load the change log." onRetry={() => void log.refetch()} />;
  }
  if (log.isPending || !catalog) return <p className="text-muted-foreground text-sm">Loading...</p>;
  if (log.entries.length === 0) return <p className="text-muted-foreground text-sm">No changes yet.</p>;

  const byKey = new Map(catalog.switches.map((s) => [s.key, s]));
  return (
    // Its own scroller: the log is as long as the role's or person's history, and the page never grows with it.
    <Card>
      <div ref={scroller} data-change-log className="max-h-[min(70vh,48rem)] overflow-y-auto overscroll-contain">
        <ul aria-label="Change log">
          {log.entries.map((entry) => (
            <ChangeLogRow key={entry.id} entry={entry} sw={entry.switch_key ? byKey.get(entry.switch_key) : undefined} view={view} tz={tz} />
          ))}
        </ul>
        <LogFooter
          hasMore={log.hasNextPage}
          loading={log.isFetchingNextPage}
          failed={log.isFetchNextPageError}
          onLoadMore={loadMore}
          root={scroller}
        />
      </div>
    </Card>
  );
}

/** A role's change log. Mounted only when its tab is open, so the log is not read before then. */
export function RoleChangeLog({ role }: { role: string }) {
  return <ChangeLogList log={useRoleChangeLog(role)} view="role" />;
}

/** A person's change log, role assignments and resets included. */
export function PersonChangeLog({ userId }: { userId: string }) {
  return <ChangeLogList log={usePersonChangeLog(userId)} view="person" />;
}
