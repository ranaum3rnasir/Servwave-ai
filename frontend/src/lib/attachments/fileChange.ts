/**
 * What the server says one file allows the person (Roles & Permissions S04.24): the list route sends it on every row,
 * decided from their Attachments switches, the own-upload rule and the completed-job lock. The page draws a rename or
 * delete control from it and never re-derives the rule.
 */
export interface FileChangeAnswer {
  can_delete?: boolean;
  can_rename?: boolean;
  /** Controls the person's switches allow and only the lock withholds: drawn disabled with the reason. */
  locked_actions?: Array<'delete' | 'rename'>;
}

export type FileControl = 'enabled' | 'locked' | 'hidden';

/**
 * How a control is drawn for this file. `ifUnanswered` is the old browser-side rule, used only when a row carries no
 * answer at all (a list that predates the per-file answer): the server still refuses what it must.
 */
export function fileControl(row: FileChangeAnswer, action: 'delete' | 'rename', ifUnanswered: boolean): FileControl {
  const allowed = action === 'delete' ? row.can_delete : row.can_rename;
  if (allowed === true) return 'enabled';
  if (row.locked_actions?.includes(action)) return 'locked';
  if (allowed === undefined) return ifUnanswered ? 'enabled' : 'hidden';
  return 'hidden';
}
