import { useEffect, useState } from 'react';
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
} from '@/lib/api/users';
import { useRoles, roleAssignmentOptions, resolveRoleAssignment } from '@/lib/api/roles';
import { useDepartments, useCreateDepartment, useUpdateDepartment, useDeleteDepartment } from '@/lib/api/departments';
import { useUpdateUserTimeclockSettings } from '@/lib/api/timeclock';
import { useSettingsBar } from './SettingsLayout';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { TabsContent } from '@/components/ui/tabs';
import { TabStrip } from '@/components/patterns/TabStrip';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/data/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import type { Department } from '@/lib/api/departments';
import { SelectField } from '@/components/form/SelectField';
import UserPermissionsDialog from '@/components/settings/UserPermissionsDialog';
import { AvatarUploadControl } from '@/components/settings/AvatarUploadControl';
import { useAppAbility } from '@/contexts/AbilityContext';
import { extractApiError, formatPhone, formatPhoneInput } from '@/lib/utils';

const CREATE_TEAM = '__create__';

export default function UsersTeamsPage() {
  const { data: users = [] } = useUsers();
  const { data: departments = [] } = useDepartments();
  const { data: roles = [] } = useRoles();
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
  // ADMIN = `manage all` → every flag below is true, so admin behaviour is unchanged.
  const ability = useAppAbility();
  const canCreateUser = ability.can('create', 'User');
  const canUpdateUser = ability.can('update', 'User');
  const canDeleteUser = ability.can('delete', 'User');
  const canUpdateTimeclock = ability.can('update', 'Timeclock');
  const canCreateTeam = ability.can('create', 'Department');
  const canUpdateTeam = ability.can('update', 'Department');
  const canDeleteTeam = ability.can('delete', 'Department');

  useEffect(() => {
    registerSaver({ save: () => {}, discard: () => {}, isDirty: false });
  }, [registerSaver]);

  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  // `role` here is the PICKER value - a system role name or a custom role's key - resolved to
  // the real {role, custom_role_id} payload via resolveRoleAssignment at submit time.
  const [invite, setInvite] = useState<null | { first_name: string; last_name: string; email: string; role: string; phone: string; department_id: string | null }>(null);
  // #607 — server-side invite failure (e.g. email already tied to an account),
  // shown inline under the email field so the admin can correct it in place.
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [newDept, setNewDept] = useState('');
  // Revoke-login (only offered for users who currently have_login) confirms first.
  const [revokeFor, setRevokeFor] = useState<UserRow | null>(null);
  // Create-team-from-the-Users-table flow: holds the user id to assign once created.
  const [createTeamFor, setCreateTeamFor] = useState<string | null>(null);
  const [createTeamName, setCreateTeamName] = useState('');
  // Deleting a team un-teams everyone in it → confirm first.
  const [teamToDelete, setTeamToDelete] = useState<Department | null>(null);
  // Renaming a team: holds the target + its in-progress name.
  const [teamToRename, setTeamToRename] = useState<Department | null>(null);
  const [renameTeamName, setRenameTeamName] = useState('');
  const [userToDelete, setUserToDelete] = useState<UserRow | null>(null);
  // Edit contact details (name/phone/ext/photo); role + team stay inline in the table.
  const [editUser, setEditUser] = useState<null | { id: string; first_name: string; last_name: string; phone: string; phone_ext: string; avatar_url: string | null }>(null);
  // Per-user permission overrides (RBAC Phase 2) — opens a tri-state dialog (admins excluded).
  const [permsUser, setPermsUser] = useState<null | { id: string; name: string }>(null);
  // Deactivation now also revokes login (deletes the Supabase account) → confirm first.
  const [deactivateFor, setDeactivateFor] = useState<UserRow | null>(null);

  const filtered = users.filter((u) =>
    statusFilter === 'all' ? true : statusFilter === 'active' ? u.is_active : !u.is_active,
  );

  const submitInvite = async () => {
    if (!invite) return;
    const { role, custom_role_id } = resolveRoleAssignment(roles, invite.role);
    // Backend invite endpoint accepts optional phone/phone_ext.
    const payload: InviteUserPayload = {
      first_name: invite.first_name,
      last_name: invite.last_name,
      email: invite.email,
      role: role as UserRole,
      custom_role_id,
      phone: invite.phone.trim() || null,
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
  const submitEditUser = async () => {
    if (!editUser) return;
    await updateUser.mutateAsync({
      id: editUser.id,
      payload: {
        first_name: editUser.first_name.trim(),
        last_name: editUser.last_name.trim(),
        phone: editUser.phone.trim() || null,
        phone_ext: editUser.phone_ext.trim() || null,
      },
    });
    setEditUser(null);
  };

  // Deactivation also revokes login — confirm first, then deactivate.
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
    <TabStrip
      active={activeTab}
      onChange={setActiveTab}
      tabs={[
        { value: 'users', label: 'Users' },
        { value: 'teams', label: 'Teams' },
      ]}
    >
      {/* USERS */}
      <TabsContent value="users" className="space-y-4 pt-4">
        <div className="flex items-center justify-between">
          <div className="flex gap-1">
            {/* Segmented status-filter toggle group, not a Button-shaped control -
                left raw per the program's non-Button-shape carve-out. */}
            {(['all', 'active', 'inactive'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`rounded-full px-3 py-1 text-xs capitalize transition-colors ${
                  statusFilter === s ? 'bg-primary text-on-fill' : 'bg-background-light text-text-secondary'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          {canCreateUser && (
            <Button
              size="sm"
              onClick={() => { setInviteError(null); setInvite({ first_name: '', last_name: '', email: '', role: 'TECHNICIAN', phone: '', department_id: null }); }}
            >
              + Invite User
            </Button>
          )}
        </div>

        {canCreateUser && invite && (
          <Card padding="sm" className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input placeholder="First name *" value={invite.first_name} onChange={(e) => setInvite({ ...invite, first_name: e.target.value })} />
            <Input placeholder="Last name *" value={invite.last_name} onChange={(e) => setInvite({ ...invite, last_name: e.target.value })} />
            <div>
              <Input
                placeholder="Email *"
                value={invite.email}
                onChange={(e) => { setInvite({ ...invite, email: e.target.value }); setInviteError(null); }}
              />
              {inviteError && <p className="mt-1 text-xs text-danger">{inviteError}</p>}
            </div>
            <Input placeholder="Phone" value={invite.phone} onChange={(e) => setInvite({ ...invite, phone: formatPhoneInput(e.target.value) })} />
            <SelectField
              className="h-9"
              value={invite.role}
              onValueChange={(v) => setInvite({ ...invite, role: v })}
              options={roleAssignmentOptions(roles)}
            />
            {/* #109 — optional Department; backend supports department_id on create */}
            <SelectField
              className="h-9"
              value={invite.department_id ?? 'NONE'}
              onValueChange={(v) => setInvite({ ...invite, department_id: v === 'NONE' ? null : v })}
              options={[
                { value: 'NONE', label: 'No team' },
                ...departments.map((d) => ({ value: d.id, label: d.name })),
              ]}
            />
            <div className="col-span-2 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => { setInvite(null); setInviteError(null); }}>
                Cancel
              </Button>
              <Button
                onClick={() => void submitInvite()}
                disabled={
                  !invite.first_name.trim() ||
                  !invite.last_name.trim() ||
                  !/.+@.+\..+/.test(invite.email) ||
                  inviteUser.isPending
                }
              >
                Send invite
              </Button>
            </div>
          </Card>
        )}

        <Card padding="none">
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
                <TableHead className="w-72"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((u) => (
                <TableRow key={u.id}>
                  <TableCell weight="medium">
                    {u.first_name} {u.last_name}
                    {!u.has_login && <Badge variant="secondary" className="ml-2">No login</Badge>}
                  </TableCell>
                  <TableCell tone="muted">{u.email}</TableCell>
                  <TableCell tone="muted">
                    {u.phone ? `${formatPhone(u.phone)}${u.phone_ext ? ` x${u.phone_ext}` : ''}` : '—'}
                  </TableCell>
                  <TableCell>
                    {canUpdateUser ? (
                      <SelectField
                        className="h-8 text-xs"
                        value={u.custom_role?.key ?? u.role}
                        onValueChange={(v) => {
                          const { role, custom_role_id } = resolveRoleAssignment(roles, v);
                          void updateUser.mutateAsync({ id: u.id, payload: { role: role as UserRole, custom_role_id } });
                        }}
                        options={roleAssignmentOptions(roles)}
                      />
                    ) : (
                      <span className="text-xs text-text-secondary">{u.custom_role?.label ?? u.role}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {canUpdateUser ? (
                      <SelectField
                        className="h-8 text-xs"
                        value={u.department_id ?? 'NONE'}
                        onValueChange={(v) => onTeamChange(u.id, v === 'NONE' ? '' : v)}
                        options={[
                          { value: 'NONE', label: '— No team —' },
                          ...departments.map((d) => ({ value: d.id, label: d.name })),
                          { value: CREATE_TEAM, label: '+ Create new team…' },
                        ]}
                      />
                    ) : (
                      <span className="text-xs text-text-secondary">
                        {departments.find((d) => d.id === u.department_id)?.name ?? '—'}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {canUpdateTimeclock ? (
                      <div className="flex flex-col gap-1.5">
                        {/* Toggle row (label wraps its Switch control) - not a FormField-shape
                            site, left raw. */}
                        <label className="flex items-center gap-2 text-xs text-text-secondary">
                          <Switch
                            checked={u.enforce_clock_in_location}
                            onCheckedChange={(checked) =>
                              void updateTimeclock.mutateAsync({ id: u.id, enforce_clock_in_location: checked })
                            }
                            aria-label="Enforce clock-in location"
                          />
                          Enforce location
                        </label>
                        {/* Toggle row (label wraps its Switch control) - not a FormField-shape
                            site, left raw. */}
                        <label className="flex items-center gap-2 text-xs text-text-secondary">
                          <Switch
                            checked={u.can_approve_clock_overrides}
                            onCheckedChange={(checked) =>
                              void updateTimeclock.mutateAsync({ id: u.id, can_approve_clock_overrides: checked })
                            }
                            aria-label="Can approve clock overrides"
                          />
                          Can approve overrides
                        </label>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-1.5 text-xs text-text-secondary">
                        <span>Location: {u.enforce_clock_in_location ? 'Enforced' : 'Off'}</span>
                        <span>Overrides: {u.can_approve_clock_overrides ? 'Allowed' : 'No'}</span>
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={u.is_active ? 'default' : 'secondary'}>{u.is_active ? 'Active' : 'Inactive'}</Badge>
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
                              avatar_url: u.avatar_url,
                            })
                          }
                        >
                          Edit
                        </Button>
                      )}
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
                              variant="ghost" tone="danger"
                              size="sm"
                              disabled={revokeLogin.isPending}
                              onClick={() => setRevokeFor(u)}
                            >
                              Revoke login
                            </Button>
                          )}
                          {canUpdateUser && (
                            <Button variant="ghost" tone="danger" size="sm" onClick={() => setDeactivateFor(u)}>
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
                            <Button variant="ghost" tone="danger" size="sm" onClick={() => setUserToDelete(u)}>
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
        </Card>
      </TabsContent>

      {/* TEAMS */}
      <TabsContent value="teams" className="space-y-4 pt-4">
        {canCreateTeam && (
          <div className="flex items-center gap-2">
            <Input placeholder="New team name" value={newDept} onChange={(e) => setNewDept(e.target.value)} className="max-w-xs" />
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
              <Card padding="sm" key={dept.id} className="space-y-3">
                <div className="flex items-center justify-between">
                  <Heading level={4}>{dept.name}</Heading>
                  <div className="flex items-center gap-1">
                    {canUpdateTeam && (
                      <Button variant="ghost" size="sm" onClick={() => openRenameTeam(dept)}>
                        Rename
                      </Button>
                    )}
                    {canDeleteTeam && (
                      <Button variant="ghost" tone="danger" size="sm" onClick={() => setTeamToDelete(dept)}>
                        Delete
                      </Button>
                    )}
                  </div>
                </div>
                <ul className="space-y-1">
                  {members.length === 0 && <li className="text-xs text-text-secondary">No members</li>}
                  {members.map((m) => (
                    <li key={m.id} className="flex items-center justify-between text-sm">
                      <span>
                        {m.first_name} {m.last_name} <span className="text-xs text-text-secondary">· {m.custom_role?.label ?? m.role}</span>
                      </span>
                      {/* Danger-toned text link with no matching link/danger cell on Button
                          (only link/brand is minted) - left raw per precedent. */}
                      {canUpdateUser && (
                        <button
                          className="text-xs text-danger"
                          onClick={() => void updateUser.mutateAsync({ id: m.id, payload: { department_id: null } })}
                        >
                          Remove
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                {canUpdateTeam && (
                  // Wrapping label around a SelectField - both a wrapping shape and a <select>
                  // family control (out of scope per this batch's convention), left raw.
                  <label className="block text-xs text-text-secondary">
                    Team head <span className="font-normal">(display-only)</span>
                    <SelectField
                      className="mt-1 h-8 w-full text-xs"
                      value={dept.head_id ?? 'NONE'}
                      onValueChange={(v) =>
                        void updateDept.mutateAsync({ id: dept.id, name: dept.name, head_id: v === 'NONE' ? null : v })
                      }
                      options={[
                        { value: 'NONE', label: 'No head' },
                        ...members.map((m) => ({ value: m.id, label: `${m.first_name} ${m.last_name}` })),
                      ]}
                    />
                  </label>
                )}
                {canUpdateUser && (
                  <SelectField
                    className="h-8 w-full text-xs"
                    value=""
                    onValueChange={(v) => v && void updateUser.mutateAsync({ id: v, payload: { department_id: dept.id } })}
                    placeholder="+ Add member…"
                    options={candidates.map((u) => ({ value: u.id, label: `${u.first_name} ${u.last_name}` }))}
                  />
                )}
              </Card>
            );
          })}
        </div>
      </TabsContent>

      {/* Create-team modal (triggered from the Users-table team dropdown) */}
      <Dialog open={createTeamFor !== null} onOpenChange={(o) => !o && setCreateTeamFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create a new team</DialogTitle>
            <DialogDescription>The selected user will be added to this team.</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="Team name"
            value={createTeamName}
            onChange={(e) => setCreateTeamName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitCreateTeam();
            }}
          />
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
          <Input
            autoFocus
            placeholder="Team name"
            value={renameTeamName}
            onChange={(e) => setRenameTeamName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitRenameTeam();
            }}
          />
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
              This removes their account and login for good and can't be undone. If they have
              estimates, payments, or other history, deletion is blocked — keep them deactivated instead.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setUserToDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="solid" tone="danger"
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
            <Button variant="solid" tone="danger" onClick={() => void confirmRevokeLogin()} disabled={revokeLogin.isPending}>
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
              Update name and phone. Role and team are changed from the table; email can’t be changed here.
            </DialogDescription>
          </DialogHeader>
          {editUser && (
            <div className="space-y-4">
              <AvatarUploadControl
                userId={editUser.id}
                avatarUrl={editUser.avatar_url}
                displayName={`${editUser.first_name} ${editUser.last_name}`}
                onChange={(avatar_url) => setEditUser({ ...editUser, avatar_url })}
              />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Input placeholder="First name *" value={editUser.first_name} onChange={(e) => setEditUser({ ...editUser, first_name: e.target.value })} />
                <Input placeholder="Last name *" value={editUser.last_name} onChange={(e) => setEditUser({ ...editUser, last_name: e.target.value })} />
                <Input placeholder="Phone" value={editUser.phone} onChange={(e) => setEditUser({ ...editUser, phone: formatPhoneInput(e.target.value) })} />
                <Input placeholder="Extension" value={editUser.phone_ext} onChange={(e) => setEditUser({ ...editUser, phone_ext: e.target.value })} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditUser(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => void submitEditUser()}
              disabled={!editUser?.first_name.trim() || !editUser?.last_name.trim() || updateUser.isPending}
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

      {/* Deactivate confirmation — deactivation also revokes login */}
      <Dialog open={deactivateFor !== null} onOpenChange={(o) => !o && setDeactivateFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deactivate {deactivateFor?.first_name} {deactivateFor?.last_name}?</DialogTitle>
            <DialogDescription>
              They’ll be signed out and their login removed — reactivating later won’t restore it, you’ll need to
              re-invite them. Their account and history are kept, and they’re removed from new assignments.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeactivateFor(null)}>
              Cancel
            </Button>
            <Button variant="solid" tone="danger" onClick={() => void confirmDeactivate()} disabled={deactivate.isPending}>
              Deactivate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete-team confirmation */}
      <Dialog open={teamToDelete !== null} onOpenChange={(o) => !o && setTeamToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{teamToDelete?.name}”?</DialogTitle>
            <DialogDescription>
              Members of this team will keep their accounts but will no longer belong to any team. This can’t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTeamToDelete(null)}>
              Cancel
            </Button>
            <Button variant="solid" tone="danger" onClick={() => void confirmDeleteTeam()} disabled={deleteDept.isPending}>
              Delete team
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TabStrip>
  );
}
