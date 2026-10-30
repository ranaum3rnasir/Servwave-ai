/**
 * What differs between the Lists cards (spec 6.2). The card engine reads only this and a `ListController`, so a card
 * is a row here plus a thin adapter hook (Job types, Lead/Customer sources, Tags, Task categories).
 */
import type { ReactNode } from 'react';

import { extractApiError } from '@/lib/utils';

export type SortKey = 'manual' | 'az' | 'used';

export const SORT_LABELS: Record<SortKey, string> = { manual: 'Default order', az: 'A to Z', used: 'Most used' };

export interface ListDef {
  key: string;
  title: string;
  /** Singular and plural, for counts and buttons. */
  singular: string;
  plural: string;
  help: string;
  /** Job types only: grip, Move up and Move down. */
  reorder: boolean;
  /** Job types and sources are archived, never deleted. */
  archive: boolean;
  /** Sorts the card offers; empty means manual order only and no sort select. */
  sorts: SortKey[];
  defaultSort: SortKey;
  /** The noun after the count in the Used by column: "{n} job(s)". */
  usedWord: string;
  /** Tags and Task categories: a stored colour per row (chip, colour button, swatches in the create form). */
  colour: boolean;
  /** Tags and Task categories: "Delete…" in the More menu, through the controller's `deleteDialog`. */
  deletable: boolean;
  /**
   * The server answers a duplicate name with a plain 409 (Tags, Task categories) rather than the `NAME_EXISTS` code Job
   * types and Sources send, so the same sentence is built from the name that was typed.
   */
  plainDuplicate: boolean;
}

export const JOB_TYPES_DEF: ListDef = {
  key: 'jobtypes',
  title: 'Job types',
  singular: 'job type',
  plural: 'job types',
  help: 'The kinds of work you do, such as Repair or Install. You pick one on every job, and the order here is the order of the job-type menu.',
  reorder: true,
  archive: true,
  sorts: [],
  defaultSort: 'manual',
  usedWord: 'job',
  colour: false,
  deletable: false,
  plainDuplicate: false,
};

export const LEAD_SOURCES_DEF: ListDef = {
  key: 'sources',
  title: 'Lead/Customer sources',
  singular: 'source',
  plural: 'sources',
  help: 'Where a lead or customer first heard about you, such as Google or a referral. Used on every lead and customer, and to see which sources bring in work.',
  reorder: false,
  archive: true,
  sorts: ['manual', 'az', 'used'],
  defaultSort: 'manual',
  usedWord: 'lead',
  colour: false,
  deletable: false,
  plainDuplicate: false,
};

export const TAGS_DEF: ListDef = {
  key: 'tags',
  title: 'Tags',
  singular: 'tag',
  plural: 'tags',
  help: 'Labels you put on customers, jobs and leads to group and filter them.',
  reorder: false,
  archive: false,
  sorts: ['az', 'used'],
  defaultSort: 'az',
  usedWord: 'record',
  colour: true,
  deletable: true,
  plainDuplicate: true,
};

export const TASK_CATEGORIES_DEF: ListDef = {
  key: 'taskcats',
  title: 'Task categories',
  singular: 'task category',
  plural: 'task categories',
  help: 'Labels that say what kind of task something is, such as Call back or Order parts. Shown on every task and used to filter the task list.',
  reorder: false,
  archive: false,
  sorts: ['az', 'used'],
  defaultSort: 'az',
  usedWord: 'task',
  colour: true,
  deletable: true,
  plainDuplicate: true,
};

export const NAME_MAX = 50;

/**
 * What to show under the name input when a write is refused. The duplicate answer is built from the server's own
 * spelling of the existing name (the same sentence the local check prints); anything else, the full-list message
 * included, is the server's text.
 */
export function writeErrorText(def: ListDef, err: unknown, typed?: string): string {
  const res = (err as { response?: { status?: number; data?: { code?: string; name?: string } } })?.response;
  const data = res?.data;
  if (data?.code === 'NAME_EXISTS' && data.name) return `${capitalise(def.singular)} “${data.name}” already exists.`;
  if (def.plainDuplicate && res?.status === 409 && typed) return `${capitalise(def.singular)} “${typed}” already exists.`;
  return extractApiError(err, 'Please try again.');
}

export const pluralise = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** What the card engine draws. An adapter maps its endpoint's rows to this. */
export interface ListItem {
  id: string;
  name: string;
  archived: boolean;
  usedCount: number;
  usedText: string;
  /** Hover text for the used-by figure (Task categories: "{open} open, {done} done"). */
  usedTitle?: string;
  /** The stored `#RRGGBB`, on the lists that have a colour. */
  color?: string;
}

/** What the card engine needs from a list. Every method rejects with the request's error. */
export interface ListController {
  def: ListDef;
  /** Every row, archived included, in the list's own (manual) order. */
  items: ListItem[];
  isLoading: boolean;
  isError: boolean;
  /** Offered on a failed load when given. */
  retry?: () => void;
  /** The pinned "Create" row is drawn only when true. */
  canCreate: boolean;
  /** Rename, recolour, archive and reorder are offered only when true; otherwise the card is read only. */
  canEdit: boolean;
  /** "Delete…" in the More menu (lists with `deletable`). */
  canDelete: boolean;
  /** The colour a new row starts on (lists with a colour). */
  defaultColour: string;
  create(name: string, colour?: string): Promise<ListItem>;
  setColour(id: string, colour: string): Promise<ListItem>;
  /** The confirm dialog "Delete…" opens, drawn by the card while a row is chosen (lists with `deletable`). */
  deleteDialog?(item: ListItem, close: () => void): ReactNode;
  rename(id: string, name: string): Promise<ListItem>;
  archive(id: string): Promise<void>;
  unarchive(id: string): Promise<void>;
  reorder(orderedIds: string[]): Promise<void>;
  /** Hard delete of an unused row; only Undo of a Create calls it. */
  remove(id: string): Promise<void>;
}

/** The text a name check shows under the input, or '' when the name is fine. Case-insensitive, archived rows count. */
export function nameProblem(def: ListDef, items: readonly ListItem[], raw: string, exceptId?: string): string {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name) return 'Enter a name.';
  if (name.length > NAME_MAX) return 'Use 50 characters or fewer.';
  const dup = items.find((i) => i.id !== exceptId && i.name.toLowerCase() === name.toLowerCase());
  return dup ? `${capitalise(def.singular)} “${dup.name}” already exists.` : '';
}

export function cleanName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

export function countText(def: ListDef, items: readonly ListItem[], query: string, showArchived: boolean, shown: number): string {
  const active = items.filter((i) => !i.archived).length;
  if (query.trim()) {
    const total = showArchived ? items.length - active : active;
    return `${shown} of ${total}`;
  }
  return `${active} ${active === 1 ? def.singular : def.plural}`;
}

export function visibleItems(items: readonly ListItem[], query: string, sort: SortKey, showArchived: boolean): ListItem[] {
  const q = query.trim().toLowerCase();
  let list = items.filter((i) => i.archived === showArchived);
  if (q) list = list.filter((i) => i.name.toLowerCase().includes(q));
  if (sort === 'az') list = [...list].sort((a, b) => a.name.localeCompare(b.name));
  else if (sort === 'used') list = [...list].sort((a, b) => b.usedCount - a.usedCount || a.name.localeCompare(b.name));
  return list;
}
