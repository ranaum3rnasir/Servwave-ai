import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import {
  Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow,
} from '@/ui-kit/components/ui/table';

import { fmtPhone } from '@/lib/api/communication';
import {
  canBeDefault,
  textingState,
  type NumberAssignmentRow,
  type TextingState,
} from '@/lib/api/phoneNumbers';

/** Names shown in a row before the rest collapse into "+N". */
const SHOWN_PEOPLE = 3;

const TEXTING_TAG: Record<TextingState, { label: string; variant: 'softGreen' | 'softAmber' | 'softNeutral' }> = {
  texts: { label: 'Calls and texts', variant: 'softGreen' },
  'calls-only': { label: 'Calls only', variant: 'softAmber' },
  paused: { label: 'Paused', variant: 'softNeutral' },
  disconnected: { label: 'Unavailable', variant: 'softNeutral' },
  unavailable: { label: 'Unavailable', variant: 'softNeutral' },
};

function TextingTag({ row }: { row: NumberAssignmentRow }) {
  const tag = TEXTING_TAG[textingState(row)];
  return (
    <Badge variant={tag.variant} size="pill">
      {tag.label}
    </Badge>
  );
}

/** Who can call and text: three people then "+N", the person whose default it
 *  is marked (and listed first), or a note when nobody is assigned. An org
 *  default that is not active is skipped when choosing a caller ID, so it is
 *  not "everyone's" - it says it can't be used, as the page's note does. */
function WhoCanUse({ row }: { row: NumberAssignmentRow }) {
  if (row.assignments.length === 0) {
    // Plain text, not a Badge: a badge never wraps, and this has to fold on a phone.
    if (row.is_org_default && !canBeDefault(row)) {
      return (
        <span className="text-status-amber-emphasis text-[13px]">
          Organization default (can&apos;t be used right now)
        </span>
      );
    }
    return row.is_org_default ? (
      <span className="text-muted-foreground text-[13px]">Everyone (organization default)</span>
    ) : (
      <span className="text-status-amber-emphasis text-[13px]">Nobody assigned</span>
    );
  }
  // People whose default this is come first, so the marker is never hidden
  // behind "+N".
  const ordered = [...row.assignments].sort((a, b) => Number(b.is_default) - Number(a.is_default));
  const shown = ordered.slice(0, SHOWN_PEOPLE);
  const rest = row.assignments.length - shown.length;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((a) => (
        <span
          key={a.user_id}
          data-chip=""
          className="border-border bg-kit-card rounded-md border px-2 py-0.5 text-xs"
        >
          {a.user_name}
          {a.is_default && <span className="text-brand font-semibold"> · Default</span>}
        </span>
      ))}
      {rest > 0 && (
        <span data-chip="" className="border-border bg-kit-card rounded-md border px-2 py-0.5 text-xs">
          +{rest}
        </span>
      )}
    </div>
  );
}

export interface CallerIdTableProps {
  /** The rows to show, already filtered and paged by the caller. */
  rows: NumberAssignmentRow[];
  /** Opens the people panel for a number. */
  onEdit: (row: NumberAssignmentRow) => void;
  /** Hands back each row's Edit button, so focus can return to it when the
   *  panel closes. */
  editButtonRef: (id: string, el: HTMLButtonElement | null) => void;
  /** Shown in one full-width row when `rows` is empty. */
  emptyMessage?: string;
}

/**
 * Settings > Caller ID: one row per number (slice 03). The number is the row
 * header, so a screen reader announces it on every cell of the row. The texting
 * column is dropped below the sm breakpoint and repeated as a tag under the
 * number instead, so the table fits a phone without scrolling sideways.
 *
 * It renders exactly the rows it is given; search, filters and paging live in
 * `CallerIdNumberList` (slice 04).
 */
export function CallerIdTable({ rows, onEdit, editButtonRef, emptyMessage }: CallerIdTableProps) {
  return (
    <Table containerClassName="rounded-lg border">
      <TableCaption className="sr-only">Phone numbers and who can use them</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Number</TableHead>
          <TableHead scope="col" className="whitespace-normal">Who can call and text</TableHead>
          <TableHead scope="col" className="hidden sm:table-cell">Texting</TableHead>
          <TableHead scope="col" className="w-0">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 && emptyMessage && (
          <TableRow>
            <TableCell colSpan={4}>
              <p className="text-muted-foreground py-6 text-center text-sm">{emptyMessage}</p>
            </TableCell>
          </TableRow>
        )}
        {rows.map((row) => {
          const formatted = fmtPhone(row.e164);
          return (
            <TableRow key={row.id}>
              {/* The row header. A raw <th>: the kit's TableHead is styled as a
                  column header, and this one reads as a body cell. */}
              <th scope="row" className="border-b px-3 py-2.5 text-left align-middle font-normal sm:px-4">
                <span className="block font-mono text-[13px] font-semibold whitespace-nowrap tabular-nums">
                  {formatted}
                </span>
                {row.label && (
                  <span className="text-muted-foreground block text-xs">{row.label}</span>
                )}
                <span className="mt-1 block sm:hidden">
                  <TextingTag row={row} />
                </span>
              </th>
              <TableCell>
                <WhoCanUse row={row} />
              </TableCell>
              <TableCell className="hidden sm:table-cell">
                <TextingTag row={row} />
              </TableCell>
              <TableCell padding="none">
                {/* The inset lives here, tighter below sm, so the table fits a
                    phone column. */}
                <div className="flex justify-end px-2 py-2.5 sm:px-4">
                  {/* size="default" is h-10 (40px): row actions are at least 36px tall. */}
                  <Button
                    ref={(el) => editButtonRef(row.id, el)}
                    variant="ghost"
                    aria-label={`Edit people for ${formatted}`}
                    onClick={() => onEdit(row)}
                  >
                    Edit
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
