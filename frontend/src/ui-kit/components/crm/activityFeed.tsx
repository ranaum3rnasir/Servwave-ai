import * as React from "react";

import { cn } from "@/ui-kit/lib/utils";
import { Avatar } from "@/ui-kit/components/ui/avatar";

export interface ActivityEntry {
  id: string;
  actor: string;
  /** Past tense, no trailing period - it completes "Sarah Chen …". */
  action: React.ReactNode;
  timestamp: string;
  /** A note body, rendered as a quoted block under the line. */
  body?: string;
}

/**
 * Who did what, when.
 *
 * Each line reads as a sentence - "Sarah Chen marked the job as In progress" -
 * so it stays scannable without a legend. Notes get a quoted block underneath,
 * which keeps a long comment from breaking the rhythm of the list.
 */
function ActivityFeed({ entries, className, ...props }: React.ComponentProps<"ol"> & {
  entries: ActivityEntry[];
}) {
  return (
    <ol data-slot="activity-feed" className={cn("m-0 list-none p-0", className)} {...props}>
      {entries.map((entry) => (
        <li key={entry.id} className="flex gap-2.5 border-t py-3 first:border-t-0 first:pt-0">
          <Avatar name={entry.actor} size="xs" className="mt-0.5" />
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] leading-relaxed">
              <span className="font-bold">{entry.actor}</span> {entry.action}
            </div>
            {entry.body && (
              <p className="bg-muted text-muted-foreground mt-1.5 rounded-md px-2.5 py-2 text-[12.5px] leading-relaxed">
                {entry.body}
              </p>
            )}
            <time className="text-subtle-foreground mt-0.5 block text-[11.5px]">{entry.timestamp}</time>
          </div>
        </li>
      ))}
    </ol>
  );
}

export { ActivityFeed };
