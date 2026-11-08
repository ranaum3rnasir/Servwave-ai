import { useEffect, useId, useState } from 'react';

import {
  useUsers,
  useInviteUser,
  useSendInvite,
  useUpdateUser,
  useDeactivateUser,
  useDeleteUser,
  useRevokeLogin,
  type UserRole,
  type UserRow,
  type InviteUserPayload,
  type UpdateUserPayload,
} from '@/lib/api/users';
import {
  useDepartments, useCreateDepartment, useUpdateDepartment, useDeleteDepartment,
  type Department,
} from '@/lib/api/departments';
import { useUpdateUserTimeclockSettings } from '@/lib/api/timeclock';
import { useAppAbility } from '@/contexts/AbilityContext';
import { extractApiError, formatPhone, formatPhoneInput } from '@/lib/utils';
import { isUsableUserPhone, userPhoneForSubmit, USER_PHONE_INVALID_MESSAGE } from '@/lib/user-phone';

import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Card } from '@/ui-kit/components/ui/card';
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { Switch } from '@/ui-kit/components/ui/switch';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/ui-kit/components/ui/table';

import { TabStrip, TabPanel } from '../_shared/tabs';
import { useSettingsBar } from './settingsBar';
import { FlushCard } from './components/section';
import { SelectField } from '@/ui-kit/components/form/selectField';
import UserPermissionsDialog from './components/userPermissionsDialog';

const ROLES: UserRole[] = ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'];
const CREATE_TEAM = '__create__';

/** Spec C - a user with no number on file cannot be reached by a text step.
 *  The column predates normalization and holds the odd empty string, so this
 *  trims rather than testing truthiness. */
const hasPhone = (u: Pick<UserRow, 'phone'>) => Boolean(u.phone?.trim());

/**
 * Settings > Users & Teams. The module's largest surface: a users table with
 * inline role/team/timeclock edits, a Teams tab, six local dialogs and the
 * imported per-user permissions dialog.
 *
 * The kit `DataTable` is deliberately NOT used here. The users table is not a
 * sorted/selectable/column-configurable list - it is a form laid out as rows,
 * where most cells are live controls that PATCH on change. Wiring it through a
 * table engine buys nothing and would fight the controlled-props gap the kit's
 * DataTable currently has (see the ledger).
 *
 * Every mutation control is gated on the same CASL ability the API enforces, so
 * a read-only viewer sees a read-only table rather than an action that 403s.
 */
export default function UsersTeamsPage() {
  const { data: users = [] } = useUsers();
  const { data: departments = [] } = useDepartments();
  const inviteUser = useInviteUser();
  const sendInvite = useSendInvite();
  const updateUser = useUpdateUser();
  const deactivate = useDeactivateUser();
  const deleteUser = useDeleteUser();
  const revokeLogin = useRevokeLogin();
  const createDept = useCreateDepartment();
  const updateDept = useUpdateDepartment();
  const deleteDept = useDeleteDepartment();
  const updateTimeclock = useUpdateUserTimeclockSettings();
  const { registerSaver } = useSettingsBar();
  const [activeTab, setActiveTab] = useState('users');

  // RBAC: gate every mutation control on the CASL ability so a read-only viewer
  // (e.g. a DISPATCHER, who has `read User`/`read Department` but no create/update/
  // delete) sees a read-only table instead of the admin editor. The backend already
  // 403s every write; this aligns the FE so it never offers an action that would fail.
  // ADMIN = `manage all` -> every flag below is true, so admin behaviour is unchanged.
  const ability = useAppAbility();
  const canCreateUser = ability.can('create', 'User');
  const canUpdateUser = ability.can('update', 'User');
  const canDeleteUser = ability.can('delete', 'User');
  const canUpdateTimeclock = ability.can('update', 'Timeclock');
  const canCreateTeam = ability.can('create', 'Department');
  const canUpdateTeam = ability.can('update', 'Department');
  const canDeleteTeam = ability.can('delete', 'Department');

  // Every mutation on this page is immediate, so the shared Save bar is inert
  // here BY DESIGN - registering a no-op saver is what keeps it disabled.
  useEffect(() => {
    registerSaver({ save: () => {}, discard: () => {}, isDirty: false });
  }, [registerSaver]);

  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  // Spec C - "who still owes me a number". Deliberately NOT a fourth status pill:
  // a fourth value would make missing-phone mutually exclusive with active, so the
  // chase list would fill up with deactivated leavers - who can never be a text
  // recipient anyway, since the audience resolver only returns is_active users.
  // As an orthogonal switch it composes: Active + Missing phone is the useful view.
  const [missingPhoneOnly, setMissingPhoneOnly] = useState(false);
  const missingPhoneId = useId();
  const [invite, setInvite] = useState<null | { first_name: string; last_name: string; email: string; role: UserRole; phone: string; phone_ext: string; department_id: string | null }>(null);
  // #607 - server-side invite failure (e.g. email already tied to an account),
  // shown inline under the email field so the admin can correct it in place.
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [newDept, setNewDept] = useState('');
  // Revoke-login (only offered for users who currently have_login) confirms first.
  const [revokeFor, setRevokeFor] = useState<UserRow | null>(null);
  // Create-team-from-the-Users-table flow: holds the user id to assign once created.
  const [createTeamFor, setCreateTeamFor] = useState<string | null>(null);
  const [createTeamName, setCreateTeamName] = useState('');
  // Deleting a team un-teams everyone in it -> confirm first.
  const [teamToDelete, setTeamToDelete] = useState<Department | null>(null);
  // Renaming a team: holds the target + its in-progress name.
  const [teamToRename, setTeamToRename] = useState<Department | null>(null);
  const [renameTeamName, setRenameTeamName] = useState('');
  const [userToDelete, setUserToDelete] = useState<UserRow | null>(null);
  // Edit contact details (name/phone/ext); role + team stay inline in the table.
  // `opened_with` is the phone pair the dialog was seeded with, so the save can
  // tell an untouched legacy number from one the admin actually edited.
  const [editUser, setEditUser] = useState<null | { id: string; first_name: string; last_name: string; phone: string; phone_ext: string; opened_with: { phone: string; phone_ext: string } }>(null);
  // Per-user permission overrides (RBAC Phase 2) - opens a tri-state dialog (admins excluded).
  const [permsUser, setPermsUser] = useState<null | { id: string; name: string }>(null);
  // Deactivation now also revokes login (deletes the Supabase account) -> confirm first.
  const [deactivateFor, setDeactivateFor] = useState<UserRow | null>(null);

  const filtered = users.filter((u) => {
    const matchesStatus =
      statusFilter === 'all' ? true : statusFilter === 'active' ? u.is_active : !u.is_active;
    return matchesStatus && (!missingPhoneOnly || !hasPhone(u));
  });

  const submitInvite = async () => {
    if (!invite) return;
    // Backend invite endpoint accepts optional phone/phone_ext.
    const payload: InviteUserPayload = {
      first_name: invite.first_name,
      last_name: invite.last_name,
      email: invite.email,
      role: invite.role,
      // E.164, not the masked display form the box shows - see lib/user-phone.ts.
      phone: userPhoneForSubmit(invite.phone),
      phone_ext: invite.phone_ext.trim() || null,
      department_id: invite.department_id,
    };
    try {
      await inviteUser.mutateAsync(payload);
      setInviteError(null);
      setInvite(null);
    } catch (err) {
      // Keep the card open with the specific server message (#607) inline.
      setInviteError(extractApiError(err, 'Could not invite user'));
    }
  };

  // Per-row login control: only shown for users who have_login. Revoke confirms first.
  const confirmRevokeLogin = async () => {
    if (!revokeFor) return;
    await revokeLogin.mutateAsync(revokeFor.id);
    setRevokeFor(null);
  };

  // Save edited contact details via the existing update endpoint (name/phone/ext only).
  //
  // DIRTY-ONLY on the phone pair, mirroring MyProfilePage's `dirtyValues`. This
  // dialog used to send `phone` on every save, seeded from whatever was stored -
  // and the column predates normalization, so it holds numbers the API now
  // refuses. Unconditional resend would 400 the whole PATCH and leave an admin
  // unable to fix a user's NAME until they also fixed a number they never
  // touched. Sending only what was actually edited keeps those rows editable
  // without weakening the rule the server enforces.
  const submitEditUser = async () => {
    if (!editUser) return;
    const payload: UpdateUserPayload = {
      first_name: editUser.first_name.trim(),
      last_name: editUser.last_name.trim(),
    };
    if (editUser.phone !== editUser.opened_with.phone) {
      payload.phone = userPhoneForSubmit(editUser.phone);
    }
    if (editUser.phone_ext !== editUser.opened_with.phone_ext) {
      payload.phone_ext = editUser.phone_ext.trim() || null;
    }
    await updateUser.mutateAsync({ id: editUser.id, payload });
    setEditUser(null);
  };

  // The gate applies to what the admin TYPED, not to what was already stored:
  // complaining about an untouched legacy number would re-create the lockout in
  // the disabled state instead of in the 400.
  const editPhoneRejected =
    editUser !== null &&
    editUser.phone !== editUser.opened_with.phone &&
    !isUsableUserPhone(editUser.phone);

  // Deactivation also revokes login - confirm first, then deactivate.
  const confirmDeactivate = async () => {
    if (!deactivateFor) return;
    await deactivate.mutateAsync(deactivateFor.id);
    setDeactivateFor(null);
  };

  // Team dropdown in the Users table: pick a team, clear it, or create a new one.
  const onTeamChange = (userId: string, value: string) => {
    if (value === CREATE_TEAM) {
      setCreateTeamName('');
      setCreateTeamFor(userId);
      return;
    }
    void updateUser.mutateAsync({ id: userId, payload: { department_id: value || null } });
  };

  const submitCreateTeam = async () => {
    const name = createTeamName.trim();
    if (!name) return;
    const res = await createDept.mutateAsync(name);
    const newId = (res as { department?: { id: string } } | undefined)?.department?.id;
    if (createTeamFor && newId) {
      await updateUser.mutateAsync({ id: createTeamFor, payload: { department_id: newId } });
    }
    setCreateTeamFor(null);
    setCreateTeamName('');
  };

  const confirmDeleteTeam = async () => {
    if (!teamToDelete) return;
    await deleteDept.mutateAsync(teamToDelete.id);
    setTeamToDelete(null);
  };

  const openRenameTeam = (dept: Department) => {
    setRenameTeamName(dept.name);
    setTeamToRename(dept);
  };

  const submitRenameTeam = async () => {
    if (!teamToRename) return;
    const name = renameTeamName.trim();
    if (!name || name === teamToRename.name) {
      setTeamToRename(null);
      return;
    }
    await updateDept.mutateAsync({ id: teamToRename.id, name });
    setTeamToRename(null);
  };

  return (
    <>
      <TabStrip
        value={activeTab}
        onValueChange={setActiveTab}
        tabs={[
          { value: 'users', label: 'Users' },
          { value: 'teams', label: 'Teams' },
        ]}
      />

      {/* USERS */}
      <TabPanel value="users" activeValue={activeTab}>
        <div className="space-y-4 pt-4">
          <div className="flex items-center justify-between">
            <div className="flex gap-1">
              {(['all', 'active', 'inactive'] as const).map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={statusFilter === s ? 'default' : 'secondary'}
                  aria-pressed={statusFilter === s}
                  onClick={() => setStatusFilter(s)}
                  className="h-7 rounded-full px-3 text-xs capitalize"
                >
                  {s}
                </Button>
              ))}
              {/* Switch and Label as SIBLINGS bound by id, the shape the rest of
                  the app uses (see InventoryPage's "Show archived"). Nesting the
                  switch inside the label puts a control in the middle of the very
                  text a user clicks, so a hit on the words cannot be told apart
                  from a hit on the ~36px track - and it parks the switch where
                  Label's `peer-disabled:` variants can never see it, since those
                  only match a PRECEDING sibling. */}
              <span className="ml-3 flex items-center gap-2">
                <Switch
                  id={missingPhoneId}
                  checked={missingPhoneOnly}
                  onCheckedChange={setMissingPhoneOnly}
                  aria-label="Missing phone"
                />
                <Label htmlFor={missingPhoneId} className="text-muted-foreground text-xs font-normal">
                  Missing phone
                </Label>
              </span>
            </div>
            {canCreateUser && (
              <Button
                size="sm"
                onClick={() => {
                  setInviteError(null);
                  setInvite({ first_name: '', last_name: '', email: '', role: 'TECHNICIAN', phone: '', phone_ext: '', department_id: null });
                }}
              >
                + Invite User
              </Button>
            )}
          </div>

          {canCreateUser && invite && (
            <Card>
              <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
                <Input placeholder="First name *" value={invite.first_name} onChange={(e) => setInvite({ ...invite, first_name: e.target.value })} />
                <Input placeholder="Last name *" value={invite.last_name} onChange={(e) => setInvite({ ...invite, last_name: e.target.value })} />
                <div>
                  <Input
                    placeholder="Email *"
                    value={invite.email}
                    onChange={(e) => { setInvite({ ...invite, email: e.target.value }); setInviteError(null); }}
                  />
                  {inviteError && <p className="text-destructive mt-1 text-xs">{inviteError}</p>}
                </div>
                <div>
                  <Input placeholder="Phone" value={invite.phone} onChange={(e) => setInvite({ ...invite, phone: formatPhoneInput(e.target.value) })} />
                  {!isUsableUserPhone(invite.phone) && (
                    <p className="text-destructive mt-1 text-xs">{USER_PHONE_INVALID_MESSAGE}</p>
                  )}
                </div>
                <Input placeholder="Extension" value={invite.phone_ext} onChange={(e) => setInvite({ ...invite, phone_ext: e.target.value })} />
                <SelectField
                  aria-label="Role"
                  value={invite.role}
                  onValueChange={(v) => setInvite({ ...invite, role: v as UserRole })}
                  options={ROLES.map((r) => ({ value: r, label: r }))}
                />
                {/* #109 - optional Department; backend supports department_id on create */}
                <SelectField
                  aria-label="Team"
                  value={invite.department_id ?? 'NONE'}
                  onValueChange={(v) => setInvite({ ...invite, department_id: v === 'NONE' ? null : v })}
                  options={[
                    { value: 'NONE', label: 'No team' },
                    ...departments.map((d) => ({ value: d.id, label: d.name })),
                  ]}
                />
                <div className="col-span-full flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => { setInvite(null); setInviteError(null); }}>
                    Cancel
                  </Button>
                  <Button
                    onClick={() => void submitInvite()}
                    disabled={
                      !invite.first_name.trim() ||
                      !invite.last_name.trim() ||
                      !/.+@.+\..+/.test(invite.email) ||
                      !isUsableUserPhone(invite.phone) ||
                      inviteUser.isPending
                    }
                  >
                    Send invite
                  </Button>
                </div>
              </div>
            </Card>
          )}

          <FlushCard>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Team</TableHead>
                  <TableHead>Time clock</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-72" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell>
                      <span className="font-medium">
                        {u.first_name} {u.last_name}
                      </span>
                      {!u.has_login && (
                        <Badge variant="softNeutral" size="sm" className="ml-2">
                          No login
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell><span className="text-muted-foreground">{u.email}</span></TableCell>
                    <TableCell>
                      {hasPhone(u) ? (
                        <span className="text-muted-foreground">
                          {formatPhone(u.phone ?? '')}{u.phone_ext ? ` x${u.phone_ext}` : ''}
                        </span>
                      ) : (
                        // A dash reads as "nothing to say here". This person cannot be
                        // texted, which is worth saying - in the same idiom as "No login".
                        <Badge variant="softNeutral" size="sm">
                          No phone
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {canUpdateUser ? (
                        <SelectField
                          aria-label={`Role for ${u.first_name} ${u.last_name}`}
                          className="h-8 text-xs"
                          value={u.role}
                          onValueChange={(v) => void updateUser.mutateAsync({ id: u.id, payload: { role: v as UserRole } })}
                          options={ROLES.map((r) => ({ value: r, label: r }))}
                        />
                      ) : (
                        <span className="text-muted-foreground text-xs">{u.role}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {canUpdateUser ? (
                        <SelectField
                          aria-label={`Team for ${u.first_name} ${u.last_name}`}
                          className="h-8 text-xs"
                          value={u.department_id ?? 'NONE'}
                          onValueChange={(v) => onTeamChange(u.id, v === 'NONE' ? '' : v)}
                          options={[
                            { value: 'NONE', label: '- No team -' },
                            ...departments.map((d) => ({ value: d.id, label: d.name })),
                            { value: CREATE_TEAM, label: '+ Create new team...' },
                          ]}
                        />
                      ) : (
                        <span className="text-muted-foreground text-xs">
                          {departments.find((d) => d.id === u.department_id)?.name ?? '-'}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {canUpdateTimeclock ? (
                        <div className="flex flex-col gap-1.5">
                          <Label className="text-muted-foreground flex items-center gap-2 text-xs font-normal">
                            <Switch
                              checked={u.enforce_clock_in_location}
                              onCheckedChange={(checked) =>
                                void updateTimeclock.mutateAsync({ id: u.id, enforce_clock_in_location: checked })
                              }
                              aria-label="Enforce clock-in location"
                            />
                            Enforce location
                          </Label>
                          <Label className="text-muted-foreground flex items-center gap-2 text-xs font-normal">
                            <Switch
                              checked={u.can_approve_clock_overrides}
                              onCheckedChange={(checked) =>
                                void updateTimeclock.mutateAsync({ id: u.id, can_approve_clock_overrides: checked })
                              }
                              aria-label="Can approve clock overrides"
                            />
                            Can approve overrides
                          </Label>
                        </div>
                      ) : (
                        <div className="text-muted-foreground flex flex-col gap-1.5 text-xs">
                          <span>Location: {u.enforce_clock_in_location ? 'Enforced' : 'Off'}</span>
                          <span>Overrides: {u.can_approve_clock_overrides ? 'Allowed' : 'No'}</span>
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={u.is_active ? 'softGreen' : 'softNeutral'} size="pill">
                        {u.is_active ? 'Active' : 'Inactive'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        {canUpdateUser && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setEditUser({
                                id: u.id,
                                first_name: u.first_name,
                                last_name: u.last_name,
                                phone: formatPhone(u.phone ?? ''),
                                phone_ext: u.phone_ext ?? '',
                                opened_with: { phone: formatPhone(u.phone ?? ''), phone_ext: u.phone_ext ?? '' },
                              })
                            }
                          >
                            Edit
                          </Button>
                        )}
                        {/* Admin exclusion, first of two: an ADMIN row never offers
                            the per-user override dialog (the backend 400s the PUT). */}
                        {canUpdateUser && u.role !== 'ADMIN' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setPermsUser({ id: u.id, name: `${u.first_name} ${u.last_name}` })}
                          >
                            Permissions
                          </Button>
                        )}
                        {canUpdateUser && u.is_active && !u.has_login && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={sendInvite.isPending}
                            onClick={() => void sendInvite.mutateAsync(u.id)}
                          >
                            Send invite
                          </Button>
                        )}
                        {u.is_active ? (
                          <>
                            {canUpdateUser && u.has_login && (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={revokeLogin.isPending}
                                onClick={() => setRevokeFor(u)}
                              >
                                Revoke login
                              </Button>
                            )}
                            {canUpdateUser && (
                              <Button variant="ghost" size="sm" onClick={() => setDeactivateFor(u)}>
                                Deactivate
                              </Button>
                            )}
                          </>
                        ) : (
                          <>
                            {canUpdateUser && (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={updateUser.isPending}
                                onClick={() => void updateUser.mutateAsync({ id: u.id, payload: { is_active: true } })}
                              >
                                Reactivate
                              </Button>
                            )}
                            {canDeleteUser && (
                              <Button variant="ghost" size="sm" onClick={() => setUserToDelete(u)}>
                                Delete
                              </Button>
                            )}
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </FlushCard>
        </div>
      </TabPanel>

      {/* TEAMS */}
      <TabPanel value="teams" activeValue={activeTab}>
        <div className="space-y-4 pt-4">
          {canCreateTeam && (
            <div className="flex items-center gap-2">
              <Input
                placeholder="New team name"
                value={newDept}
                onChange={(e) => setNewDept(e.target.value)}
                className="max-w-xs"
              />
              <Button
                size="sm"
                disabled={!newDept.trim() || createDept.isPending}
                onClick={async () => {
                  if (newDept.trim()) {
                    await createDept.mutateAsync(newDept.trim());
                    setNewDept('');
                  }
                }}
              >
                + Add Team
              </Button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            {departments.map((dept) => {
              const members = users.filter((u) => u.department_id === dept.id);
              const candidates = users.filter((u) => u.department_id !== dept.id && u.is_active);
              return (
                <Card key={dept.id}>
                  <div className="space-y-3 p-4">
                    <div className="flex items-center justify-between">
                      {/* role/aria-level rather than an <h4>: the raw-tag ratchet
                          sits at its floor for h1-h6. */}
                      <p role="heading" aria-level={4} className="text-sm font-semibold">
                        {dept.name}
                      </p>
                      <div className="flex items-center gap-1">
                        {canUpdateTeam && (
                          <Button variant="ghost" size="sm" onClick={() => openRenameTeam(dept)}>
                            Rename
                          </Button>
                        )}
                        {canDeleteTeam && (
                          <Button variant="ghost" size="sm" onClick={() => setTeamToDelete(dept)}>
                            Delete
                          </Button>
                        )}
                      </div>
                    </div>
                    <ul className="space-y-1">
                      {members.length === 0 && (
                        <li className="text-muted-foreground text-xs">No members</li>
                      )}
                      {members.map((m) => (
                        <li key={m.id} className="flex items-center justify-between text-sm">
                          <span>
                            {m.first_name} {m.last_name}{' '}
                            <span className="text-muted-foreground text-xs">- {m.role}</span>
                          </span>
                          {canUpdateUser && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2 text-xs"
                              onClick={() => void updateUser.mutateAsync({ id: m.id, payload: { department_id: null } })}
                            >
                              Remove
                            </Button>
                          )}
                        </li>
                      ))}
                    </ul>
                    {canUpdateTeam && (
                      <div className="space-y-1">
                        <Label className="text-muted-foreground text-xs font-normal">
                          Team head <span className="font-normal">(display-only)</span>
                        </Label>
                        <SelectField
                          aria-label={`Team head for ${dept.name}`}
                          className="h-8 w-full text-xs"
                          value={dept.head_id ?? 'NONE'}
                          onValueChange={(v) =>
                            void updateDept.mutateAsync({ id: dept.id, name: dept.name, head_id: v === 'NONE' ? null : v })
                          }
                          options={[
                            { value: 'NONE', label: 'No head' },
                            ...members.map((m) => ({ value: m.id, label: `${m.first_name} ${m.last_name}` })),
                          ]}
                        />
                      </div>
                    )}
                    {canUpdateUser && (
                      <SelectField
                        aria-label={`Add member to ${dept.name}`}
                        className="h-8 w-full text-xs"
                        value=""
                        onValueChange={(v) => v && void updateUser.mutateAsync({ id: v, payload: { department_id: dept.id } })}
                        placeholder="+ Add member..."
                        options={candidates.map((u) => ({ value: u.id, label: `${u.first_name} ${u.last_name}` }))}
                      />
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      </TabPanel>

      {/* Create-team modal (triggered from the Users-table team dropdown) */}
      <Dialog open={createTeamFor !== null} onOpenChange={(o) => !o && setCreateTeamFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create a new team</DialogTitle>
            <DialogDescription>The selected user will be added to this team.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Input
              autoFocus
              placeholder="Team name"
              value={createTeamName}
              onChange={(e) => setCreateTeamName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitCreateTeam();
              }}
            />
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateTeamFor(null)}>
              Cancel
            </Button>
            <Button onClick={() => void submitCreateTeam()} disabled={!createTeamName.trim() || createDept.isPending}>
              Create &amp; assign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename-team dialog */}
      <Dialog open={teamToRename !== null} onOpenChange={(o) => !o && setTeamToRename(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename team</DialogTitle>
            <DialogDescription>Members and assignments are unaffected.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Input
              autoFocus
              placeholder="Team name"
              value={renameTeamName}
              onChange={(e) => setRenameTeamName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitRenameTeam();
              }}
            />
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTeamToRename(null)}>
              Cancel
            </Button>
            <Button onClick={() => void submitRenameTeam()} disabled={!renameTeamName.trim() || updateDept.isPending}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Permanent-delete confirmation */}
      <Dialog open={userToDelete !== null} onOpenChange={(o) => !o && setUserToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Permanently delete {userToDelete?.first_name} {userToDelete?.last_name}?
            </DialogTitle>
            <DialogDescription>
              This removes their account and login for good and can&rsquo;t be undone. If they have
              estimates, payments, or other history, deletion is blocked - keep them deactivated instead.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setUserToDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteUser.isPending}
              onClick={() => {
                if (!userToDelete) return;
                deleteUser.mutate(userToDelete.id, { onSuccess: () => setUserToDelete(null) });
              }}
            >
              Delete user
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke-login confirmation */}
      <Dialog open={revokeFor !== null} onOpenChange={(o) => !o && setRevokeFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke login for {revokeFor?.first_name} {revokeFor?.last_name}?</DialogTitle>
            <DialogDescription>
              They will no longer be able to sign in. Their account and history are kept, and they
              remain assignable while active. You can re-invite them later to restore access.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRevokeFor(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmRevokeLogin()} disabled={revokeLogin.isPending}>
              Revoke login
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit-user-details dialog (name + phone; role/team/email are edited elsewhere) */}
      <Dialog open={editUser !== null} onOpenChange={(o) => !o && setEditUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit details</DialogTitle>
            <DialogDescription>
              Update name and phone. Role and team are changed from the table; email can&rsquo;t be changed here.
            </DialogDescription>
          </DialogHeader>
          {editUser && (
            <DialogBody>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Input placeholder="First name *" value={editUser.first_name} onChange={(e) => setEditUser({ ...editUser, first_name: e.target.value })} />
                <Input placeholder="Last name *" value={editUser.last_name} onChange={(e) => setEditUser({ ...editUser, last_name: e.target.value })} />
                <div>
                  <Input placeholder="Phone" value={editUser.phone} onChange={(e) => setEditUser({ ...editUser, phone: formatPhoneInput(e.target.value) })} />
                  {editPhoneRejected && (
                    <p className="text-destructive mt-1 text-xs">{USER_PHONE_INVALID_MESSAGE}</p>
                  )}
                </div>
                <Input placeholder="Extension" value={editUser.phone_ext} onChange={(e) => setEditUser({ ...editUser, phone_ext: e.target.value })} />
              </div>
            </DialogBody>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditUser(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => void submitEditUser()}
              disabled={!editUser?.first_name.trim() || !editUser?.last_name.trim() || editPhoneRejected || updateUser.isPending}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Per-user permission overrides (RBAC Phase 2) */}
      <UserPermissionsDialog
        userId={permsUser?.id ?? null}
        userName={permsUser?.name ?? ''}
        onClose={() => setPermsUser(null)}
      />

      {/* Deactivate confirmation - deactivation also revokes login */}
      <Dialog open={deactivateFor !== null} onOpenChange={(o) => !o && setDeactivateFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deactivate {deactivateFor?.first_name} {deactivateFor?.last_name}?</DialogTitle>
            <DialogDescription>
              They&rsquo;ll be signed out and their login removed - reactivating later won&rsquo;t restore it, you&rsquo;ll need to
              re-invite them. Their account and history are kept, and they&rsquo;re removed from new assignments.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeactivateFor(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmDeactivate()} disabled={deactivate.isPending}>
              Deactivate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete-team confirmation */}
      <Dialog open={teamToDelete !== null} onOpenChange={(o) => !o && setTeamToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete &ldquo;{teamToDelete?.name}&rdquo;?</DialogTitle>
            <DialogDescription>
              Members of this team will keep their accounts but will no longer belong to any team. This can&rsquo;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTeamToDelete(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmDeleteTeam()} disabled={deleteDept.isPending}>
              Delete team
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
