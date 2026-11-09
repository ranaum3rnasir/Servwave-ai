import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { SwitchValue, SwitchSet, RoleSwitchSet } from '@/lib/api/shared/switchTypes';
import { allPersonSwitchesKey, resetChangeLogs } from '@/lib/api/shared/queryKeys';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';

/**
 * Roles & Permissions: the switch catalog, and a role's set of switch values.
 *
 * Both screens that draw a switch set (the Roles page and a person's Permissions page) read the catalog from the
 * server and draw only from it. Nothing here lists a switch, a label or a help text.
 */

/** A list switch's "everything the company accepts" value, as the server stores it. */
export const ALL_ACCEPTED = 'all_accepted';

export type BuiltInRoleKey = 'ADMIN' | 'SALES' | 'DISPATCHER' | 'TECHNICIAN';

export interface CatalogSwitch {
  key: string;
  module: string;
  label: string;
  helpText: string;
  kind: 'toggle' | 'choice' | 'list';
  choices?: string[];
  listOptions?: string[];
  keptValueHelp?: Record<string, { label: string; meaning: string }>;
  requires: string[];
  requiresAny?: string[];
  presets: Record<BuiltInRoleKey, SwitchValue>;
  /** A per-person setting (P1): edited on the person's profile, not on the Permissions screens. */
  setting?: boolean;
}

export interface LayoutExtra {
  key: string;
  parent: string | null;
}

export interface LayoutModule {
  module: string;
  label: string;
  lines: string[];
  scope: string | null;
  /** The line a row with no scope of its own carries: its records are reached through the leads and jobs the person can open. */
  scopeNote: string | null;
  extras: LayoutExtra[];
}

export interface LayoutGroup {
  label: string;
  modules: LayoutModule[];
}

export interface CatalogLayout {
  /** The one Money row: See prices, with See costs and See company figures nested under it. */
  money: LayoutExtra[];
  groups: LayoutGroup[];
  /** The keys of the per-person settings, in catalog order: edited on the person's profile, never drawn by the switch editor. */
  settings?: string[];
}

export interface SwitchCatalog {
  switches: CatalogSwitch[];
  layout: CatalogLayout;
}


/** The role a person's set is based on: the one their switches were filled from. */
export interface BasedOnRole {
  key: string;
  label: string;
  type: 'built_in' | 'custom';
}

/** A person's switch values, as `GET /api/users/:id/permissions` answers a read and `PUT` answers a write. */
export interface PersonSwitchSet {
  user_id: string;
  /** The built-in Admin role: one Full access box, no switches. */
  admin_box: boolean;
  /** False for an admin person and for the viewer's own page: nobody changes their own access. */
  editable: boolean;
  based_on: BasedOnRole | null;
  values: SwitchSet;
  differences: { switch_key: string; value: SwitchValue; role_value: SwitchValue }[];
  difference_count: number;
}

export function useSwitchCatalog() {
  return useQuery<SwitchCatalog>({
    queryKey: ['permission-switches', 'catalog'],
    queryFn: () => api.get('/api/permission-switches/catalog').then((r) => r.data),
    // The catalog is code: it changes with a deploy, never while someone is on the page.
    staleTime: Infinity,
  });
}

export function useRoleSwitches(role: string) {
  return useQuery<RoleSwitchSet>({
    queryKey: ['roles', role, 'switches'],
    queryFn: () => api.get(`/api/roles/${role}/permissions`).then((r) => r.data),
    enabled: !!role,
  });
}

/**
 * What to tell a person when the server refuses to store a set: its own sentence for each switch that breaks a rule
 * ("Show Phone needs Access Communication on."), or the one sentence it answers with. Anything else (a failure
 * with no answer of its own) gets the fallback, never the transport's error text.
 */
export function refusalMessage(err: unknown, fallback: string): string {
  const data = (err as { response?: { status?: number; data?: { error?: unknown; violations?: unknown } } })?.response;
  const violations = Array.isArray(data?.data?.violations) ? data.data.violations : [];
  const sentences = violations.map((v: { message?: unknown }) => v?.message).filter((m): m is string => typeof m === 'string' && m !== '');
  if (sentences.length > 0) return sentences.join(' ');
  const clientError = typeof data?.status === 'number' && data.status >= 400 && data.status < 500;
  if (clientError && typeof data?.data?.error === 'string' && data.data.error) return data.data.error;
  return fallback;
}


export function useSaveRoleSwitches() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ role, values }: { role: string; values: SwitchSet }) =>
      api.put(`/api/roles/${role}/permissions`, { values }).then((r) => r.data as RoleSwitchSet),
    onSuccess: (saved, v) => {
      // The write answers with the role's whole set: show it now, and refresh the list's counts.
      qc.setQueryData(['roles', v.role, 'switches'], saved);
      resetChangeLogs(qc);
      void qc.invalidateQueries({ queryKey: ['roles'], exact: true });
      // Everyone based on this role has had their set read before the edit: read it again.
      void qc.invalidateQueries({ queryKey: allPersonSwitchesKey });
      // The Users & Teams role column counts each person's changes from their role, and those are measured against this set.
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) =>
      toast({
        title: 'Save failed',
        description: refusalMessage(err, 'Could not save role permissions. Try again in a moment.'),
        variant: 'destructive',
      }),
  });
}

export const personSwitchesKey = (userId: string) => [...allPersonSwitchesKey, userId] as const;

export function usePersonSwitches(userId: string) {
  return useQuery<PersonSwitchSet>({
    queryKey: personSwitchesKey(userId),
    queryFn: () => api.get(`/api/users/${userId}/permissions`).then((r) => r.data),
    enabled: !!userId,
  });
}

export function useSavePersonSwitches() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, values }: { userId: string; values: SwitchSet }) =>
      api.put(`/api/users/${userId}/permissions`, { values }).then((r) => r.data as PersonSwitchSet),
    // The write answers with the person's whole set: show it now.
    onSuccess: (saved, v) => {
      qc.setQueryData(personSwitchesKey(v.userId), saved);
      resetChangeLogs(qc);
      // The Users & Teams role column counts this person's changes.
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) =>
      toast({
        title: 'Save failed',
        description: refusalMessage(err, 'Could not save permissions. Try again in a moment.'),
        variant: 'destructive',
      }),
  });
}

/** Put some of a person's switches (`all` for every one) back to the value of the role they are based on. */
export function useResetPersonSwitches() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, switchKeys }: { userId: string; switchKeys: string[] | 'all' }) =>
      api
        .post(`/api/users/${userId}/permissions/reset`, switchKeys === 'all' ? { all: true } : { switch_keys: switchKeys })
        .then((r) => r.data as PersonSwitchSet),
    // The reset answers with the person's whole set: show it now, and refresh the change counts of the people list.
    onSuccess: (saved, v) => {
      qc.setQueryData(personSwitchesKey(v.userId), saved);
      resetChangeLogs(qc);
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) =>
      toast({
        title: 'Reset failed',
        description: refusalMessage(err, 'Could not reset permissions. Try again in a moment.'),
        variant: 'destructive',
      }),
  });
}

/** What `POST /api/users/:id/permissions/save-as-role` answers: the new role, then the person's set on it. */
export type SavedAsRole = PersonSwitchSet & { role: { role: string; label: string } };

/**
 * Make a role from a person's current switches and move them onto it. A refusal (a name that is a built-in role's or
 * another role's) is shown by the caller, next to the name that caused it.
 */
export function useSavePersonAsRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, label }: { userId: string; label: string }) =>
      api.post(`/api/users/${userId}/permissions/save-as-role`, { label }).then((r) => r.data as SavedAsRole),
    onSuccess: ({ role: _role, ...saved }, v) => {
      // The person's whole set, now based on the new role with no changes.
      qc.setQueryData(personSwitchesKey(v.userId), saved);
      resetChangeLogs(qc);
      // The Roles list gains the role, and the Users & Teams role column names the person under it.
      void qc.invalidateQueries({ queryKey: ['roles'], exact: true });
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
  });
}

/** The based-on role's current value for every switch the person's read carries: their value, else the role's. */
export function basedOnValues(person: PersonSwitchSet): SwitchSet {
  const role = { ...person.values };
  for (const d of person.differences) role[d.switch_key] = d.role_value;
  return role;
}

/** The switches whose value in `values` differs from the role's, in catalog order. A switch neither side holds does not differ. */
export function differingSwitches(catalog: SwitchCatalog, values: SwitchSet, roleValues: SwitchSet): string[] {
  return catalog.switches.filter((sw) => !sameValue(values[sw.key], roleValues[sw.key])).map((sw) => sw.key);
}

/** The switches whose value differs between two sets: what a save has to send. */
export function changedSwitches(saved: SwitchSet, draft: SwitchSet): SwitchSet {
  const changed: SwitchSet = {};
  for (const [key, value] of Object.entries(draft)) {
    if (!sameValue(saved[key], value)) changed[key] = value;
  }
  return changed;
}

/**
 * What a switch is waiting on: the switches of its `requires` that are off, and its `requiresAny` pair when none of
 * them is on. Null when every requirement is met. The server's validator reads the same two fields.
 */
export interface UnmetRequirement {
  /** Switches that must all be on, and are not. */
  all: string[];
  /** Switches of which at least one must be on, when none is. */
  any: string[];
}

export function unmetRequirement(sw: CatalogSwitch, values: SwitchSet): UnmetRequirement | null {
  const all = sw.requires.filter((key) => values[key] !== true);
  const any = sw.requiresAny && !sw.requiresAny.some((key) => values[key] === true) ? sw.requiresAny : [];
  return all.length || any.length ? { all, any } : null;
}

/**
 * True when View is off on every module: a person holding the set could open no record, which is almost never what was
 * meant. The server answers the same question for a saved set (`all_views_off`); this reads a set still being edited.
 */
export function allViewsOff(catalog: SwitchCatalog, values: SwitchSet): boolean {
  return catalog.switches.filter((sw) => sw.key.startsWith('view_')).every((sw) => values[sw.key] !== true);
}

/**
 * True when the set turns Access Communication or Show Email off: whoever holds it cannot open the Email page, so their
 * mailbox still receives mail that nobody can read (PRD 10, "Can't read"). The server answers the same question for a
 * saved set on the Users page; this reads a set still being edited, so the note follows the switch before saving. No
 * built-in preset has either off.
 */
export function emailPageClosed(values: SwitchSet): boolean {
  return values.access_communication !== true || values.show_email !== true;
}

/** The mark on a person whose Email page is closed to them. */
export const CANT_READ_PERSON_MARK = "Can't read: Email page is off for this person";

/** The same note on a role whose switches close the Email page to everyone given it. */
export const CANT_READ_ROLE_NOTE =
  "Can't read: Email page is off for people on this role. Their mailbox still receives mail, but they can't open it. You can still save it.";

/**
 * A set after one switch changed: every switch that was on and now waits on a switch that went off is turned off too,
 * and so on down the chain. Nothing is switched on, so turning a requirement back on leaves its dependents off.
 */
export function clearDependents(catalog: SwitchCatalog, values: SwitchSet): SwitchSet {
  const next = { ...values };
  let changed = true;
  while (changed) {
    changed = false;
    for (const sw of catalog.switches) {
      if (sw.kind === 'toggle' && next[sw.key] === true && unmetRequirement(sw, next)) {
        next[sw.key] = false;
        changed = true;
      }
    }
  }
  return next;
}

export function sameValue(a: SwitchValue | undefined, b: SwitchValue | undefined): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
}
