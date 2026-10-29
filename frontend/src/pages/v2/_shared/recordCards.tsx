import { useId, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { cn } from '@/ui-kit/lib/utils';

/**
 * A record list's phone layout: one card per row.
 *
 * Mobile slice 68 (rubric CMP-01). The detail pages' tab tables (a customer's leads, jobs and
 * invoices, a lead's estimates) are six or seven columns wide; below lg (see `useRecordCards`) they become these cards.
 * The card is the same shape the DataTable's phone cards use (list cards, slice 39): ONE named
 * control covers it, so a screen reader reaches the row as a single link or button and a tap
 * anywhere opens the record, and the other columns sit under it as labelled lines.
 *
 * The caller chooses the layout with `useRecordCards()` and mounts either this or its table, never
 * both: a CSS-hidden twin would double the content for a screen reader and for jsdom tests.
 */
export interface RecordCardItem {
  key: string;
  /** What a sighted reader reads first; also the open control's accessible name. */
  title: ReactNode;
  /** A short line above the title: a record number, a type badge. */
  eyebrow?: ReactNode;
  /** Top right of the card: usually the record's status chip. */
  aside?: ReactNode;
  /** The row's other columns, in the table's order. */
  fields: { label: string; value: ReactNode }[];
  /** Opens the record (a button). Omit both this and `to` for a row with no page of its own. */
  onOpen?: () => void;
  /** Opens the record (a link, for rows the table already linked). */
  to?: string;
  /**
   * The row's own buttons (the call log's Call Back and Dismiss), under the fields. They sit above
   * the stretched open control, so a tap on one never opens the record. Give them 44 px targets.
   */
  actions?: ReactNode;
}

const OPEN_CLASS =
  'focus-visible:ring-ring absolute inset-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset';

export function RecordCards({ items, label }: {
  items: RecordCardItem[];
  /** Names the list for a screen reader, e.g. "Estimates". */
  label: string;
}) {
  const base = useId();
  return (
    <ul aria-label={label} data-slot="record-cards">
      {items.map((item) => {
        const titleId = `${base}-${item.key}`;
        return (
          <li
            key={item.key}
            data-slot="record-card"
            // `relative` anchors the stretched open control; the card itself has no click handler.
            className="relative border-b px-4 py-3 last:border-b-0"
          >
            {item.to ? (
              <Link to={item.to} aria-labelledby={titleId} data-slot="record-card-open" className={OPEN_CLASS} />
            ) : item.onOpen ? (
              // eslint-disable-next-line no-restricted-syntax -- an unstyled, stretched hit area (the kit Button would paint it); the DataTable's phone cards do the same.
              <button
                type="button"
                aria-labelledby={titleId}
                data-slot="record-card-open"
                onClick={item.onOpen}
                className={OPEN_CLASS}
              />
            ) : null}

            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                {item.eyebrow && (
                  <div className="text-muted-foreground mb-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] font-semibold">
                    {item.eyebrow}
                  </div>
                )}
                <div id={titleId} className="break-words text-[14px] font-semibold leading-snug">
                  {item.title}
                </div>
              </div>
              {item.aside && <div className="relative z-10 shrink-0">{item.aside}</div>}
            </div>

            <dl
              className={cn(
                'mt-2 space-y-1.5',
                // The card's own controls (a chip menu, a link inside a value) keep their taps.
                '[&_a]:relative [&_a]:z-10 [&_button]:relative [&_button]:z-10',
              )}
            >
              {item.fields.map((field) => (
                <div key={field.label} className="flex items-start justify-between gap-3">
                  <dt className="text-muted-foreground shrink-0 text-[11.5px] font-semibold">{field.label}</dt>
                  <dd className="min-w-0 flex-1 break-words text-right text-[13px]">{field.value}</dd>
                </div>
              ))}
            </dl>

            {item.actions && <div className="relative z-10 mt-2 flex flex-wrap items-center gap-2">{item.actions}</div>}
          </li>
        );
      })}
    </ul>
  );
}
