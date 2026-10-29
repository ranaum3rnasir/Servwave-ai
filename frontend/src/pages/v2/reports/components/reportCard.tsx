import { Link } from 'react-router-dom';

import { Card } from '@/ui-kit/components/ui/card';
import { Badge } from '@/ui-kit/components/ui/badge';
import { cn } from '@/ui-kit/lib/utils';
import type { ReportDef } from '@/lib/reports/report-catalog';

import { v2Path } from '../../uiV2';

/**
 * One tile in the Reports landing grid.
 *
 * WHAT WAS WRONG. The tile filled its Card with a `-m-6 p-6` link - a negative
 * margin that pulled the link back out over the Card's own padding so the whole
 * surface would be clickable. The side effect was that the tile had no height
 * of its own beyond one line of text: a 40px strip stretched across a third of
 * the viewport, so a grid of them read as a bare list with hairlines, and the
 * Card underneath was invisible. Wide and flat is the worst proportion for a
 * grid item, because the eye has to travel the full width to pair a label with
 * the icon that belongs to it.
 *
 * WHAT IT IS NOW. A SHORT card, laid out as a row: the glyph on the left and
 * the name beside it, not under it. The stacked version - glyph on its own
 * line, label pinned to the bottom of a 7rem box - spent most of its height on
 * empty space between the two, and the catalog runs to about thirty reports, so
 * three-quarters of the list sat below the fold. Reading across a row is also
 * the shorter eye movement: label and glyph pair on one line instead of the eye
 * dropping the height of the tile to connect them.
 *
 * The category moves under the name at reduced weight, and the code badge stays
 * on the right of the row where it lines up down the column.
 *
 * The whole card is still one link and one tab stop - the icon is `aria-hidden`
 * decoration and the accessible name is the label alone. Hover moves colour and
 * shadow only, never a transform: a tile that scales on hover nudges the tiles
 * around it and makes a grid feel loose.
 *
 * `deferred` reports still render muted, still carry the badge, and still
 * route - that is the catalog's contract, not styling.
 */
export function ReportCard({ report }: { report: ReportDef }) {
  const Icon = report.icon;
  return (
    <Card className="overflow-hidden">
      <Link
        to={v2Path(`/reports/${report.slug}`)}
        className={cn(
          'group flex h-full items-center gap-3 rounded-lg p-3',
          'transition-[background-color,box-shadow] duration-200',
          'hover:bg-muted/60 hover:shadow-md',
          'focus-visible:ring-brand focus-visible:ring-2 focus-visible:outline-none',
          report.deferred && 'opacity-60',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'bg-brand-subtle text-brand grid size-8 shrink-0 place-items-center rounded-lg',
            'transition-colors duration-200 group-hover:bg-brand group-hover:text-on-fill',
            '[&_svg]:size-4',
          )}
        >
          <Icon />
        </span>

        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13.5px] leading-snug font-semibold">{report.label}</span>
          <span className="text-muted-foreground truncate text-[11.5px]">{report.group}</span>
        </span>

        <span className="flex shrink-0 items-center gap-1.5">
          {report.code && (
            <Badge variant="softNeutral" size="sm" className="tabular-nums">{report.code}</Badge>
          )}
          {report.deferred && <Badge variant="softNeutral" size="pill">Deferred</Badge>}
        </span>
      </Link>
    </Card>
  );
}
