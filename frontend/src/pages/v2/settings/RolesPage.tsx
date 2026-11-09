import { useEffect, useState } from 'react';

import { useRoles, type RoleSummary } from '@/lib/api/roles';
import { allViewsOff, CANT_READ_ROLE_NOTE, changedSwitches, emailPageClosed, useRoleSwitches, useSaveRoleSwitches, useSwitchCatalog } from '@/lib/api/permissionSwitches';
import { useAcceptedPaymentMethods } from '@/lib/api/recordablePaymentMethods';
import { type SwitchSet } from '@/lib/api/shared/switchTypes';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { useFeature } from '@/lib/entitlements';
import SwitchSetEditor from '@/components/permissions/SwitchSetEditor';

import { useSettingsBar } from './settingsBar';
import { RoleList } from './components/roleList';
import { NewRoleDialog } from './components/newRoleDialog';
import { RoleActions } from './components/roleActions';
import { ResetRoleAction } from './components/resetRoleAction';
import { resetTarget } from './components/resetTarget';
import { RoleChangeLog } from './components/changeLog';
import { Alert } from '@/components/ui/alert';
import { TabsContent } from '@/components/ui/tabs';
import { TabStrip } from '@/components/patterns/TabStrip';

/** The line under a custom role's name that says where it started: the role it was copied from, or a blank draft. */
function madeFromText(set: { type: string; made_from_role_key: string | null; made_from_blank: boolean } | undefined, roles: RoleSummary[]): string | null {
  if (!set || set.type !== 'custom') return null;
  const source = set.made_from_role_key ? roles.find((r) => r.role === set.made_from_role_key) : undefined;
  if (source) return `Made from ${source.label}`;
  return set.made_from_blank ? 'Made from a blank start' : null;
}

/**
 * Settings > Roles & Permissions.
 *
 * A role is a named set of switch values. The page lists the company's roles and, for the one picked, draws the whole
 * switch catalog through the shared switch-set editor, reading and saving the role's set through the Roles API. What
 * a role holds is what everyone on it has, except where a person holds their own value for a switch: an edit here reaches
 * every other person on the role at once, and a save says how many people that was.
 */
/** What a save did: "Reaches 4 people; 1 keeps their own value." */
export function saveSummary(reaches: number, keepOwn: number): string {
  const people = `${reaches} ${reaches === 1 ? 'person' : 'people'}`;
  return `Reaches ${people}; ${keepOwn} ${keepOwn === 1 ? 'keeps' : 'keep'} their own value.`;
}

export default function RolesPage() {
  // Admin is a flag on the person (P15), not a role, so the built-in Administrator entry is not a role to pick or edit here.
  // It stays a starting point for a new role (a copy of full access that can then be narrowed).
  const { data: allRoles = [] } = useRoles();
  const roles = allRoles.filter((r) => !r.fullAccess);
  const [selected, setSelected] = useState<string>('');
  // Edits made to the picked role and not saved yet: only the switches that differ from what is saved.
  const [edits, setEdits] = useState<SwitchSet>({});
  const [creating, setCreating] = useState(false);
  // The editor, or the role's change log. The log is read only while its tab is open.
  const [tab, setTab] = useState('permissions');
  const { registerSaver } = useSettingsBar();
  const requestLeave = useSettingsGuard((s) => s.requestLeave);

  const current = roles.find((r) => r.role === selected);
  const { data: catalog, isError: catalogUnavailable } = useSwitchCatalog();
  const acceptedMethods = useAcceptedPaymentMethods();
  const { data: loaded, isError: roleUnavailable } = useRoleSwitches(selected);
  const saveRole = useSaveRoleSwitches();
  // What the last save did to the people on the role, shown until the role is left or edited again.
  const [lastSave, setLastSave] = useState<{ role: string; reaches: number; keepOwn: number } | null>(null);

  useEffect(() => {
    const first = roles[0];
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate default-selection idiom: picks the first fetched role once, guarded by `!selected`
    if (!selected && first) setSelected(first.role);
  }, [roles, selected]);

  const editable = !!loaded?.editable;
  const values = loaded ? { ...loaded.values, ...edits } : undefined;
  const isDirty = editable && Object.keys(edits).length > 0;

  useEffect(() => {
    registerSaver({
      save: async () => {
        if (!loaded || !editable || !isDirty) return;
        const saved = await saveRole.mutateAsync({ role: selected, values: edits });
        setLastSave({ role: selected, reaches: saved.reaches ?? 0, keepOwn: saved.keep_own ?? 0 });
        setEdits({});
      },
      discard: () => setEdits({}),
      isDirty,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty, editable, edits, selected, loaded]);

  const pickRole = (role: string) =>
    requestLeave(() => {
      setSelected(role);
      setEdits({});
    });

  // The archived role is gone from the list: leave it, and drop edits that were never saved. The page falls back to the first role.
  const onArchived = () => {
    setSelected('');
    setEdits({});
  };

  // Read from the set as it stands on screen, edits included, so the warning follows the last View being turned off.
  // A role that closes the Email page to its people gets a note, never a block: the mailbox still receives, and the role
  // still saves. Read from the same values, so it appears and goes as the switch is flipped.
  const hasEmail = useFeature('email');
  const cantReadEmail = hasEmail && !!values && emailPageClosed(values);
  const opensNothing = !!catalog && !!values && allViewsOff(catalog, values);
  // The whole list, not the picker's: Administrator is not a role to pick here, but it is still a starting point to name.
  const madeFrom = madeFromText(loaded, allRoles);

  return (
    // One column below xl, where the roles are a single picker above the detail; from xl the list is the side column.
    // Either way the list never grows with the number of roles - see RoleList.
    <div className="flex flex-col gap-4 xl:flex-row xl:gap-6">
      {/* Switching role goes through `requestLeave` - an INTRA-page change a router blocker could never see, which is
          exactly why the unsaved-changes guard lives in a zustand store rather than the router. */}
      <RoleList roles={roles} selected={selected} onPick={pickRole} onNew={() => setCreating(true)} />
      {/* The new role opens selected; picking it goes through the same unsaved-changes guard as any other pick. */}
      <NewRoleDialog open={creating} onOpenChange={setCreating} roles={allRoles} onCreated={(role) => { setCreating(false); pickRole(role); }} />

      <div className="min-w-0 flex-1">
        {!current ? (
          <p className="text-muted-foreground text-sm">Select a role.</p>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
              <div className="min-w-0">
                {/* role/aria-level rather than an <h3>: the raw-tag ratchet sits at its floor for h1-h6. */}
                <p role="heading" aria-level={3} className="text-base font-semibold">
                  {current.label}
                </p>
                {current.type === 'custom' && current.description && <p className="text-muted-foreground mt-1 text-sm">{current.description}</p>}
                {madeFrom && <p className="text-muted-foreground mt-1 text-xs">{madeFrom}</p>}
                <p className="text-muted-foreground mt-1 text-xs">
                  Changes reach everyone on this role, except people who hold their own value for a switch.
                </p>
                {lastSave && lastSave.role === selected && !isDirty && (
                  <p role="status" className="text-muted-foreground mt-1 text-xs">
                    {saveSummary(lastSave.reaches, lastSave.keepOwn)}
                  </p>
                )}
              </div>
              {/* These act on the role picked, so they are in reach at every width, whatever the list looks like. Built-in
                  roles are permanent: only a custom role is drawn with Rename and Archive. Reset is for any role with
                  switches (not Administrator), once its set has loaded and so what it resets to is known. */}
              <div className="flex shrink-0 flex-wrap gap-2">
                {editable && loaded && (
                  <ResetRoleAction role={current} target={resetTarget(loaded, roles)} hasUnsavedEdits={isDirty} onReset={() => setEdits({})} />
                )}
                {current.type === 'custom' && <RoleActions role={current} onArchived={onArchived} />}
              </div>
            </div>
            <TabStrip
              tabs={[
                { value: 'permissions', label: 'Permissions' },
                { value: 'change-log', label: 'Change log' },
              ]}
              active={tab}
              onChange={setTab}
            >
              {/* Kept mounted while the log is open, so the editor's folded groups and unsaved edits are as they were left, but
                  hidden: a forceMount panel is otherwise drawn above the log, which then sits thousands of pixels down. */}
              <TabsContent value="permissions" forceMount hidden={tab !== 'permissions'} className="space-y-4 pt-2">
                {opensNothing && (
                  <Alert tone="warning" role="status">
                    This role can&rsquo;t open any records. Only its dashboard and its Access pages will show. You can still save it.
                  </Alert>
                )}
                {cantReadEmail && (
                  <Alert tone="warning" role="status">
                    {CANT_READ_ROLE_NOTE}
                  </Alert>
                )}
                {catalogUnavailable || roleUnavailable ? (
                  <p className="text-muted-foreground text-sm">This role&rsquo;s permissions can&rsquo;t be shown right now.</p>
                ) : !catalog || !values ? (
                  <p className="text-muted-foreground text-sm">Loading...</p>
                ) : (
                  <SwitchSetEditor
                    acceptedMethods={acceptedMethods}
                    catalog={catalog}
                    values={values}
                    editable={editable}
                    onChange={(next) => setEdits(changedSwitches(loaded!.values, next))}
                  />
                )}
              </TabsContent>
              <TabsContent value="change-log" className="pt-2">
                <RoleChangeLog role={selected} />
              </TabsContent>
            </TabStrip>
          </div>
        )}
      </div>
    </div>
  );
}
