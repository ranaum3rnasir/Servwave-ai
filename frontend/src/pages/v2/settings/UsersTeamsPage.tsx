import { useEffect, useId, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  useUsers,
  useInviteUser,
  useSendInvite,
  useUpdateUser,
  useDeactivateUser,
  useReassignOpenRecords,
  useErasePersonalData,
  useMoveMailbox,
  useDeleteUser,
  useRevokeLogin,
  useSendPasswordReset,
  useMakeOwner,
  type UserRole,
  type UserRow,
  type InviteUserPayload,
  type UpdateUserPayload,
} from '@/lib/api/users';
import {
  useDepartments, useCreateDepartment, useUpdateDepartment, useDeleteDepartment,
  type Department,
} from '@/lib/api/departments';
import { useRoles, resolveRoleAssignment, type RoleSummary } from '@/lib/api/roles';
import { useAuthStore } from '@/stores/auth.store';
import { useIsAdmin } from '@/lib/useIsAdmin';
import { changeCountLabel } from '@/lib/permissionChangeCount';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useFeature } from '@/lib/entitlements';
import { extractApiError, formatPhone } from '@/lib/utils';
import { isUsableUserPhone, userPhoneForSubmit, USER_PHONE_INVALID_MESSAGE } from '@/lib/user-phone';

import { Badge } from '@/ui-kit/components/ui/badge';
import { DisabledReasonShell } from '@/ui-kit/components/ui/disabledReason';
import { Button } from '@/ui-kit/components/ui/button';
import { Card } from '@/ui-kit/components/ui/card';
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { Input } from '@/ui-kit/components/ui/input';
import { PhoneInput } from '@/ui-kit/components/form/phoneInput';
import { Label } from '@/ui-kit/components/ui/label';
import { Switch } from '@/ui-kit/components/ui/switch';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/ui-kit/components/ui/table';

import { TabStrip, TabPanel } from '../_shared/tabs';
import { useSettingsBar } from './settingsBar';
import { FlushCard } from './components/section';
import { PersonRolePicker } from './components/personRolePicker';
import { MailboxCell } from './components/mailboxCell';
import { MailboxAddressDialog } from './components/mailboxAddressDialog';
import { PersonSettingsSection } from './components/personSettingsSection';
import { DeactivateUserDialog, type ReassignChoice } from './components/deactivateUserDialog';
import { MoveMailboxDialog } from './components/moveMailboxDialog';
import { SelectField } from '@/ui-kit/components/form/selectField';
import { canAutoFocus } from '@/ui-kit/lib/autoFocus';
import { useMediaQuery } from '@/ui-kit/hooks/useMediaQuery';

// The names a screen says before the roles list has loaded: the raw role code is never shown.
const BUILT_IN_NAMES: Record<UserRole, string> = { ADMIN: 'Admin', SALES: 'Sales', DISPATCHER: 'Dispatcher', TECHNICIAN: 'Technician' };
const CREATE_TEAM = '__create__';

/** Spec C - a user with no number on file cannot be reached by a text step.
 *  The column predates normalization and holds the odd empty string, so this
 *  trims rather than testing truthiness. */
const hasPhone = (u: Pick<UserRow, 'phone'>) => Boolean(u.phone?.trim());

/** What a role change replaces, in the words the confirmation uses. Moving to Admin is full access and no switches. */
function roleChangeMessage(person: UserRow, fromName: string, to: RoleSummary): string {
  const name = `${person.first_name} ${person.last_name}`;
  const changes = person.change_count ?? 0;
  if (to.fullAccess) {
    return changes > 0
      ? `${name} has ${changeCountLabel(changes)} from ${fromName}. Giving them the ${to.label} role gives them full access and no switches.`
      : `Give ${name} the ${to.label} role? They will have full access and no switches.`;
  }
  return changes > 0
    ? `${name} has ${changeCountLabel(changes)} from ${fromName}. Giving them the ${to.label} role replaces all their switches with the values of that role.`
    : `Give ${name} the ${to.label} role? Their switches will be set to the values of that role.`;
}

/**
 * Settings > Users & Teams. The module's largest surface: a users table with
 * inline role/team edits, a Teams tab and six local dialogs. A person's
 * switches live on their own Permissions page, reached from the row.
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
/** Why the actions that would remove the company's Owner are off (AL-16): the server answers the same words. */
const OWNER_CANT_BE_REMOVED = "The Owner can't be removed.";
/** Why the Admin controls are off for anyone but the Owner (ticket 26): the server answers the same words. */
const ONLY_THE_OWNER_CHANGES_ADMINS = 'Only the Owner can change Admins.';

/**
 * A control kept off for a reason, saying why on hover and on tap. `render` receives the id of the reason, for the control's
 * aria-describedby. With no reason the control renders as it is.
 */
function Locked({ reason, render }: { reason: string | undefined; render: (describedBy?: string) => ReactNode }) {
  const id = useId();
  if (!reason) return <>{render()}</>;
  return (
    <DisabledReasonShell reason={reason} descriptionId={id}>
      {render(id)}
    </DisabledReasonShell>
  );
}

export default function UsersTeamsPage() {
  const { data: users = [] } = useUsers();
  const { data: departments = [] } = useDepartments();
  const myId = useAuthStore((s) => s.user?.id);
  const inviteUser = useInviteUser();
  const sendInvite = useSendInvite();
  const updateUser = useUpdateUser();
  const deactivate = useDeactivateUser();
  const reassignOpen = useReassignOpenRecords();
  const erasePersonal = useErasePersonalData();
  const [eraseFor, setEraseFor] = useState<UserRow | null>(null);
  const isAdmin = useIsAdmin();
  // The company's Owner, from the sign-in payload (AL-16). No Owner, no one marked.
  const ownerId = useAuthStore((s) => s.user?.org_owner_user_id ?? null);
  const isOwner = (u: UserRow) => ownerId !== null && u.id === ownerId;
  // Only the Owner makes an Admin or acts on another Admin's account (ticket 26). The server is the lock; the screen follows it.
  const viewerIsOwner = ownerId !== null && myId === ownerId;
  const adminLock = (u: UserRow) => (!viewerIsOwner && u.is_admin === true && u.id !== myId ? ONLY_THE_OWNER_CHANGES_ADMINS : undefined);
  /** The Owner's own removal is refused for everyone (409); every other action on an Admin is the Owner's (403). */
  const removalLock = (u: UserRow) => (isOwner(u) ? OWNER_CANT_BE_REMOVED : adminLock(u));
  const moveMailbox = useMoveMailbox();
  const deleteUser = useDeleteUser();
  const revokeLogin = useRevokeLogin();
  const sendPasswordReset = useSendPasswordReset();
  const makeOwner = useMakeOwner();
  const createDept = useCreateDepartment();
  const updateDept = useUpdateDepartment();
  const deleteDept = useDeleteDepartment();
  const { registerSaver } = useSettingsBar();
  const [activeTab, setActiveTab] = useState('users');
  const navigate = useNavigate();
  // Below md the users table (eight columns of live controls) becomes a card list.
  const isPhone = useMediaQuery('(max-width: 767.98px)');

  // RBAC: gate every mutation control on the CASL ability so a read-only viewer
  // (e.g. a DISPATCHER, who has `read User`/`read Department` but no create/update/
  // delete) sees a read-only table instead of the admin editor. The backend already
  // 403s every write; this aligns the FE so it never offers an action that would fail.
  // ADMIN = `manage all` -> every flag below is true, so admin behaviour is unchanged.
  const ability = useAppAbility();
  const canUpdateUser = ability.can('update', 'User');
  const canDeleteUser = ability.can('delete', 'User');
  const canManageRoles = ability.can('manage_roles', 'Role');
  // The roles route answers only an Admin, so no one else asks it: they read each
  // person's role name from the users list.
  const { data: rolesData } = useRoles(canManageRoles);
  // Every active role, built-in and custom. A screen that has not heard from the roles route yet shows the role as text.
  const roles: RoleSummary[] = Array.isArray(rolesData) ? rolesData : [];
  // Every invite sets the new person's role, which is a Manage roles and permissions write, so the Invite button, the
  // invite card and each row's Send invite show only with Invite users AND Manage roles and permissions: no control
  // the person could not finish. Create users and Edit users offer no invite.
  const canInvite = ability.can('invite', 'User') && canManageRoles;
  // The Email column and its actions are part of the Email plan feature (the server omits the addresses without it).
  const hasEmail = useFeature('email');
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
  // `role` is the key of the picked role: a built-in role's name or a custom role's key.
  const [invite, setInvite] = useState<null | { first_name: string; last_name: string; email: string; role: string; phone: string; phone_ext: string; department_id: string | null }>(null);
  // #607 - server-side invite failure (e.g. email already tied to an account),
  // shown inline under the email field so the admin can correct it in place.
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [newDept, setNewDept] = useState('');
  // Revoke-login (offered for users who have_login, or whose revoke could not finish) confirms first.
  const [revokeFor, setRevokeFor] = useState<UserRow | null>(null);
  // "Send password reset" (password reset spec §7) confirms first: who, and the address it goes to.
  const [resetFor, setResetFor] = useState<UserRow | null>(null);
  // Make Owner (ticket 27, D1) confirms first; then the dialog says to check email, since nothing changes until the Owner opens
  // the link the server mails them. `ownerError` is the server's refusal, shown in the dialog that asked.
  const [ownerFor, setOwnerFor] = useState<UserRow | null>(null);
  const [ownerSent, setOwnerSent] = useState(false);
  const [ownerError, setOwnerError] = useState<string | null>(null);
  // Create-team-from-the-Users-table flow: holds the user id to assign once created.
  const [createTeamFor, setCreateTeamFor] = useState<string | null>(null);
  const [createTeamName, setCreateTeamName] = useState('');
  // Deleting a team un-teams everyone in it -> confirm first.
  const [teamToDelete, setTeamToDelete] = useState<Department | null>(null);
  // Renaming a team: holds the target + its in-progress name.
  const [teamToRename, setTeamToRename] = useState<Department | null>(null);
  const [renameTeamName, setRenameTeamName] = useState('');
  const [userToDelete, setUserToDelete] = useState<UserRow | null>(null);
  // The server's plain refusal of a permanent delete (the person has history), shown in the dialog that asked.
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Edit contact details (name/phone/ext); role + team stay inline in the table.
  // `opened_with` is the phone pair the dialog was seeded with, so the save can
  // tell an untouched legacy number from one the admin actually edited.
  const [editUser, setEditUser] = useState<null | { id: string; first_name: string; last_name: string; phone: string; phone_ext: string; opened_with: { phone: string; phone_ext: string } }>(null);
  // Deactivation now also revokes login (deletes the Supabase account) -> confirm first.
  const [deactivateFor, setDeactivateFor] = useState<UserRow | null>(null);
  // The deactivated person whose mailbox is being handed on later.
  const [moveFor, setMoveFor] = useState<UserRow | null>(null);
  // Every role change asks first: who, and the role they were picked onto.
  const [roleChange, setRoleChange] = useState<null | { user: UserRow; to: RoleSummary }>(null);
  // Set or change a person's mailbox address: who, and which of the two (a person with no address gets "set").
  const [mailboxFor, setMailboxFor] = useState<null | { user: UserRow; mode: 'set' | 'change' }>(null);

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
      ...resolveRoleAssignment(roles, invite.role) as Pick<InviteUserPayload, 'role' | 'custom_role_id'>,
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
    try {
      await revokeLogin.mutateAsync(revokeFor.id);
    } catch {
      // The hook's toast shows the server's error; the dialog closes either way and the row shows what the server holds.
    }
    setRevokeFor(null);
  };

  // The server emails the person a reset link; the hook shows the toast either way, so the dialog just closes.
  const confirmSendPasswordReset = () => {
    if (!resetFor) return;
    sendPasswordReset.mutate(resetFor.id, { onSettled: () => setResetFor(null) });
  };

  const openMakeOwner = (u: UserRow) => {
    setOwnerSent(false);
    setOwnerError(null);
    setOwnerFor(u);
  };
  const confirmMakeOwner = async () => {
    if (!ownerFor) return;
    setOwnerError(null);
    try {
      await makeOwner.mutateAsync(ownerFor.id);
      setOwnerSent(true);
    } catch (err) {
      setOwnerError(extractApiError(err, "We couldn't start the hand-over. Try again."));
    }
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

  // The key of the role a person holds (a custom role's key, else the built-in role's name) and the name they see for it.
  const roleKeyOf = (u: UserRow) => u.custom_role?.key ?? u.role;
  const roleNameOf = (u: UserRow) =>
    roles.find((r) => r.role === roleKeyOf(u))?.label ?? u.role_label ?? u.custom_role?.label ?? BUILT_IN_NAMES[u.role];

  const pickRole = (u: UserRow, roleKey: string) => {
    const to = roles.find((r) => r.role === roleKey);
    if (to && roleKey !== roleKeyOf(u)) setRoleChange({ user: u, to });
  };

  // The server fills the person's switches from the new role; a refusal (the last active admin, say) reaches the person
  // through the update hook's own message, and the picker stays on the old role because it reads the saved one.
  const confirmRoleChange = async () => {
    if (!roleChange) return;
    const { role, custom_role_id } = resolveRoleAssignment(roles, roleChange.to.role);
    try {
      await updateUser.mutateAsync({ id: roleChange.user.id, payload: { role: role as UserRole, custom_role_id } });
    } catch {
      // Reported by the hook.
    }
    setRoleChange(null);
  };

  const confirmMove = async (handoverTo: string) => {
    if (!moveFor) return;
    try {
      await moveMailbox.mutateAsync({ id: moveFor.id, handoverTo });
      setMoveFor(null);
    } catch {
      // Reported by the hook; the dialog stays open so the pick can be changed.
    }
  };

  // Deactivation also revokes login - confirm first, then deactivate.
  const confirmDeactivate = async (handoverTo: string | undefined, reassign?: ReassignChoice) => {
    if (!deactivateFor) return;
    // Moving their open records to someone is the Admin's optional first step; deactivating changes no record by itself.
    if (reassign) {
      try {
        await reassignOpen.mutateAsync({ id: deactivateFor.id, ...reassign });
      } catch {
        // Reported by the hook; the person is not deactivated until the records they were asked to move have moved.
        return;
      }
    }
    await deactivate.mutateAsync({ id: deactivateFor.id, handoverTo });
    setDeactivateFor(null);
  };

  const closeDeleteUser = () => {
    setUserToDelete(null);
    setDeleteError(null);
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

  // One set of cells per user, laid out as a table row from md and as a card below it
  // (mobile slice 29). Only one layout is ever mounted (useMediaQuery, not CSS), so every
  // control keeps exactly one accessible name in the DOM.
  const userCells = (u: UserRow, wrapMailbox = false) => ({
    name: (
      <>
        <span className="font-medium">
          {u.first_name} {u.last_name}
        </span>
        {isOwner(u) && (
          <Badge variant="softBlue" size="sm" className="ml-2">
            Owner
          </Badge>
        )}
        {u.erased_at ? (
          <Badge variant="softNeutral" size="sm" className="ml-2">
            Erased
          </Badge>
        ) : !u.has_login && (
          <Badge variant="softNeutral" size="sm" className="ml-2">
            No login
          </Badge>
        )}
      </>
    ),
    email: <span className="text-muted-foreground">{u.email}</span>,
    // The address customers write to, never the sign-in email above (PRD 10).
    mailbox: (
      <MailboxCell
        user={u}
        wrap={wrapMailbox}
        onEdit={canUpdateUser ? (mode) => setMailboxFor({ user: u, mode }) : undefined}
        editOffReason={adminLock(u)}
      />
    ),
    phone: (
      <>
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
      </>
    ),
    role: (
      <>
        {/* The picker is for an Admin, who also edits users (the server asks for both),
            and never on the viewer's own row. Anyone else reads the role as text. */}
        {canUpdateUser && canManageRoles && u.id !== myId && roles.length > 0 ? (
          <div className="space-y-1">
            {/* The Owner's role is never changed here: the Owner is an Admin by the flag (AL-03), whatever role they sit on. */}
            <Locked
              reason={isOwner(u) && u.is_admin === true ? OWNER_CANT_BE_REMOVED : adminLock(u)}
              render={(reason) => (
                <PersonRolePicker
                  aria-label={`Role for ${u.first_name} ${u.last_name}`}
                  aria-describedby={reason}
                  disabled={reason !== undefined}
                  adminRolesOff={!viewerIsOwner}
                  className="h-8 text-xs"
                  roles={roles}
                  value={roleKeyOf(u)}
                  onValueChange={(v) => pickRole(u, v)}
                />
              )}
            />
            {(u.change_count ?? 0) > 0 && <p className="text-muted-foreground text-xs">· {changeCountLabel(u.change_count!)}</p>}
            {/* Admin is a flag on the person (P15), whatever their role. */}
            <label className="flex items-center gap-2 text-xs">
              <Locked
                reason={isOwner(u) ? OWNER_CANT_BE_REMOVED : viewerIsOwner ? undefined : ONLY_THE_OWNER_CHANGES_ADMINS}
                render={(reason) => (
                  <Switch
                    aria-label={`Admin: ${u.first_name} ${u.last_name}`}
                    aria-describedby={reason}
                    disabled={reason !== undefined}
                    checked={u.is_admin === true}
                    onCheckedChange={(on) => updateUser.mutate({ id: u.id, payload: { is_admin: on } })}
                  />
                )}
              />
              Admin
            </label>
          </div>
        ) : (
          <span className="text-muted-foreground text-xs">
            {roleNameOf(u)}
            {(u.change_count ?? 0) > 0 && ` · ${changeCountLabel(u.change_count!)}`}
            {u.is_admin === true && ' · Admin'}
          </span>
        )}
      </>
    ),
    team: (
      <>
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
      </>
    ),
    status: (
      <>
        <Badge variant={u.is_active ? 'softGreen' : 'softNeutral'} size="pill">
          {u.is_active ? 'Active' : 'Inactive'}
        </Badge>
      </>
    ),
    actions: (
      <>
        {canUpdateUser && (
          <Button
            variant="ghost"
            size="sm"
            disabled={adminLock(u) !== undefined}
            disabledReason={adminLock(u)}
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
        {/* The person's Permissions page is the Admin's (AL-18), and an Admin row
            never offers it: an admin shows one Full access box and has no switches to change. That is the server's
            Admin box, not the base role: a role copied from Admin has switches. */}
        {canManageRoles && !u.admin_box && (
          <Button variant="ghost" size="sm" onClick={() => navigate(`/settings/users/${u.id}/permissions`)}>
            Permissions
          </Button>
        )}
        {canInvite && u.is_active && !u.has_login && (
          <Button
            variant="ghost"
            size="sm"
            disabled={sendInvite.isPending || adminLock(u) !== undefined}
            disabledReason={adminLock(u)}
            onClick={() => void sendInvite.mutateAsync(u.id)}
          >
            Send invite
          </Button>
        )}
        {u.is_active ? (
          <>
            {/* Also while a revoke could not finish, so its "Please try again" can be done. */}
            {canUpdateUser && (u.has_login || u.revoke_pending) && (
              <Button
                variant="ghost"
                size="sm"
                disabled={revokeLogin.isPending || removalLock(u) !== undefined}
                disabledReason={removalLock(u)}
                onClick={() => setRevokeFor(u)}
              >
                Revoke login
              </Button>
            )}
            {/* Edit users, and only a person who can sign in: the server answers 400 for anyone else (spec §7). */}
            {canUpdateUser && u.has_login && (
              <Button
                variant="ghost"
                size="sm"
                disabled={sendPasswordReset.isPending || adminLock(u) !== undefined}
                disabledReason={adminLock(u)}
                onClick={() => setResetFor(u)}
              >
                Send password reset
              </Button>
            )}
            {/* Make Owner (ticket 27): only the Owner sees it, and only on a row the server marks as able to become the Owner
                (an active Admin who has signed in). */}
            {viewerIsOwner && u.owner_eligible === true && u.id !== myId && (
              <Button variant="ghost" size="sm" disabled={makeOwner.isPending} onClick={() => openMakeOwner(u)}>
                Make Owner
              </Button>
            )}
            {/* Nobody deactivates their own account: the server refuses it, so the row does not offer it. */}
            {canUpdateUser && u.id !== myId && (
              <Button
                variant="ghost"
                size="sm"
                disabled={removalLock(u) !== undefined}
                disabledReason={removalLock(u)}
                onClick={() => setDeactivateFor(u)}
              >
                Deactivate
              </Button>
            )}
          </>
        ) : (
          <>
            {canUpdateUser && hasEmail && u.mailbox_handover && (
              <Button variant="ghost" size="sm" disabled={adminLock(u) !== undefined} disabledReason={adminLock(u)} onClick={() => setMoveFor(u)}>
                Move mailbox
              </Button>
            )}
            {/* A person whose personal data was erased stays on their records as a former user: no reactivating, no deleting. */}
            {canUpdateUser && !u.erased_at && (
              <Button
                variant="ghost"
                size="sm"
                disabled={updateUser.isPending || adminLock(u) !== undefined}
                disabledReason={adminLock(u)}
                onClick={() => void updateUser.mutateAsync({ id: u.id, payload: { is_active: true } })}
              >
                Reactivate
              </Button>
            )}
            {canUpdateUser && isAdmin && !u.erased_at && (
              <Button variant="ghost" size="sm" disabled={adminLock(u) !== undefined} disabledReason={adminLock(u)} onClick={() => setEraseFor(u)}>
                Erase personal data
              </Button>
            )}
            {canDeleteUser && !u.erased_at && (
              <Button variant="ghost" size="sm" disabled={adminLock(u) !== undefined} disabledReason={adminLock(u)} onClick={() => setUserToDelete(u)}>
                Delete
              </Button>
            )}
          </>
        )}
      </>
    ),
  });

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
          {/* Wraps (mobile slice 29) so Invite User drops under the filters rather than past
              the right edge on a phone or beside the Settings shell on an iPad. */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1">
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
            {canInvite && (
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

          {canInvite && invite && (
            <Card>
              <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
                <Input kind="given-name" personalAutofill={false} placeholder="First name *" value={invite.first_name} onChange={(e) => setInvite({ ...invite, first_name: e.target.value })} />
                <Input kind="family-name" personalAutofill={false} placeholder="Last name *" value={invite.last_name} onChange={(e) => setInvite({ ...invite, last_name: e.target.value })} />
                <div>
                  <Input
                    kind="email"
                    personalAutofill={false}
                    placeholder="Email *"
                    value={invite.email}
                    onChange={(e) => { setInvite({ ...invite, email: e.target.value }); setInviteError(null); }}
                  />
                  {inviteError && <p className="text-destructive mt-1 text-xs">{inviteError}</p>}
                </div>
                <div>
                  <PhoneInput personalAutofill={false} placeholder="Phone" value={invite.phone} onValueChange={(phone) => setInvite({ ...invite, phone })} />
                  {!isUsableUserPhone(invite.phone) && (
                    <p className="text-destructive mt-1 text-xs">{USER_PHONE_INVALID_MESSAGE}</p>
                  )}
                </div>
                <Input kind="phone-extension" personalAutofill={false} placeholder="Extension" value={invite.phone_ext} onChange={(e) => setInvite({ ...invite, phone_ext: e.target.value })} />
                <PersonRolePicker
                  aria-label="Role"
                  adminRolesOff={!viewerIsOwner}
                  roles={roles}
                  value={invite.role}
                  onValueChange={(v) => setInvite({ ...invite, role: v })}
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

          {hasEmail && (
            <p className="text-muted-foreground text-xs">
              Email is the address customers write to. Sign-in email is the one a person logs in with; changing an address here never changes it.
            </p>
          )}

          {isPhone ? (
            <ul aria-label="Users" className="space-y-3">
              {filtered.map((u) => {
                const c = userCells(u, true);
                return (
                  <li key={u.id}>
                    <Card>
                      <div className="space-y-3 p-4">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0 space-y-0.5 text-sm">
                            <div>{c.name}</div>
                            {/* The address and its marks wrap under the name. */}
                            {hasEmail && (
                              <div data-mailbox-line className="space-y-0.5">
                                <p className="text-muted-foreground text-xs">Email (customers write here)</p>
                                {c.mailbox}
                              </div>
                            )}
                            <p className="text-muted-foreground text-xs">Sign-in email</p>
                            <div className="break-all">{c.email}</div>
                            <div>{c.phone}</div>
                          </div>
                          {c.status}
                        </div>
                        <div className="space-y-3">
                          <div className="space-y-1">
                            <p className="text-muted-foreground text-xs">Role</p>
                            {c.role}
                          </div>
                          <div className="space-y-1">
                            <p className="text-muted-foreground text-xs">Team</p>
                            {c.team}
                          </div>
                        </div>
                        <div className="border-border -mx-1 flex flex-wrap items-center gap-1 border-t pt-2">
                          {c.actions}
                        </div>
                      </div>
                    </Card>
                  </li>
                );
              })}
            </ul>
          ) : (
          <FlushCard>
            <Table scrollBox="settings-users">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  {hasEmail && <TableHead>Email</TableHead>}
                  <TableHead>Sign-in email</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Team</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-72" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((u) => {
                  const c = userCells(u);
                  return (
                    <TableRow key={u.id}>
                      <TableCell>{c.name}</TableCell>
                      {hasEmail && <TableCell>{c.mailbox}</TableCell>}
                      <TableCell>{c.email}</TableCell>
                      <TableCell>{c.phone}</TableCell>
                      <TableCell>{c.role}</TableCell>
                      <TableCell>{c.team}</TableCell>
                      <TableCell>{c.status}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">{c.actions}</div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </FlushCard>
          )}
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
                            <span className="text-muted-foreground text-xs">- {roleNameOf(m)}</span>
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
        <DialogContent intent="form">
          <DialogHeader>
            <DialogTitle>Create a new team</DialogTitle>
            <DialogDescription>The selected user will be added to this team.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Input
              autoFocus={canAutoFocus()}
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
        <DialogContent intent="form">
          <DialogHeader>
            <DialogTitle>Rename team</DialogTitle>
            <DialogDescription>Members and assignments are unaffected.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Input
              autoFocus={canAutoFocus()}
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

      {/* Erase personal data: the person stays on their records as a former user */}
      <Dialog open={eraseFor !== null} onOpenChange={(o) => !o && setEraseFor(null)}>
        <DialogContent intent="choice">
          <DialogHeader>
            <DialogTitle>Erase {eraseFor?.first_name} {eraseFor?.last_name}&rsquo;s personal data?</DialogTitle>
            <DialogDescription>
              Their name, email, phone and photo are removed for good and can&rsquo;t be undone. Their records stay and show
              them as Former user. They can&rsquo;t be reactivated.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEraseFor(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={erasePersonal.isPending}
              onClick={() => {
                if (!eraseFor) return;
                erasePersonal.mutate(eraseFor.id, { onSettled: () => setEraseFor(null) });
              }}
            >
              Erase personal data
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Permanent-delete confirmation */}
      <Dialog open={userToDelete !== null} onOpenChange={(o) => !o && closeDeleteUser()}>
        <DialogContent intent="choice">
          <DialogHeader>
            <DialogTitle>
              Permanently delete {userToDelete?.first_name} {userToDelete?.last_name}?
            </DialogTitle>
            <DialogDescription>
              This removes their account and login for good and can&rsquo;t be undone. If they have
              estimates, payments, or other history, deletion is blocked - keep them deactivated instead.
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <p role="alert" className="text-destructive text-sm">
              {deleteError}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={closeDeleteUser}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteUser.isPending}
              onClick={() => {
                if (!userToDelete) return;
                setDeleteError(null);
                deleteUser.mutate(userToDelete.id, {
                  onSuccess: closeDeleteUser,
                  onError: (err) => setDeleteError(extractApiError(err, 'Could not delete user')),
                });
              }}
            >
              Delete user
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke-login confirmation */}
      <Dialog open={revokeFor !== null} onOpenChange={(o) => !o && setRevokeFor(null)}>
        <DialogContent intent="choice">
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

      {/* Send-password-reset confirmation. The person sets their own password from the email. */}
      <Dialog open={resetFor !== null} onOpenChange={(o) => !o && !sendPasswordReset.isPending && setResetFor(null)}>
        <DialogContent intent="choice">
          <DialogHeader>
            <DialogTitle>Send password reset</DialogTitle>
            <DialogDescription>
              Send a password reset link to {resetFor?.first_name} {resetFor?.last_name} at {resetFor?.email}? Their
              current password keeps working until they set a new one.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setResetFor(null)} disabled={sendPasswordReset.isPending}>
              Cancel
            </Button>
            <Button onClick={confirmSendPasswordReset} disabled={sendPasswordReset.isPending}>
              Send link
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={ownerFor !== null} onOpenChange={(o) => !o && !makeOwner.isPending && setOwnerFor(null)}>
        <DialogContent intent="choice">
          {ownerSent ? (
            <>
              <DialogHeader>
                <DialogTitle>Check your email</DialogTitle>
                <DialogDescription>
                  We sent you a link to approve {ownerFor?.first_name} {ownerFor?.last_name} as the new Owner. Nothing changes until
                  you open it. The link works once and expires in 7 days.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button onClick={() => setOwnerFor(null)}>Done</Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Make Owner</DialogTitle>
                <DialogDescription>
                  Make {ownerFor?.first_name} {ownerFor?.last_name} the Owner? We&rsquo;ll email you a link to approve it, and
                  nothing changes until you open it. You stay an Admin.
                </DialogDescription>
              </DialogHeader>
              {ownerError && (
                <DialogBody>
                  <p role="alert" className="text-destructive text-sm">{ownerError}</p>
                </DialogBody>
              )}
              <DialogFooter>
                <Button variant="ghost" onClick={() => setOwnerFor(null)} disabled={makeOwner.isPending}>
                  Cancel
                </Button>
                <Button onClick={() => void confirmMakeOwner()} disabled={makeOwner.isPending}>
                  Email me the link
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Edit-user-details dialog (name + phone; role/team/email are edited elsewhere) */}
      <Dialog open={editUser !== null} onOpenChange={(o) => !o && setEditUser(null)}>
        <DialogContent intent="form">
          <DialogHeader>
            <DialogTitle>Edit details</DialogTitle>
            <DialogDescription>
              Update name, phone and settings. Role and team are changed from the table; email can&rsquo;t be changed here.
            </DialogDescription>
          </DialogHeader>
          {editUser && (
            <DialogBody>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Input kind="given-name" personalAutofill={false} placeholder="First name *" value={editUser.first_name} onChange={(e) => setEditUser({ ...editUser, first_name: e.target.value })} />
                <Input kind="family-name" personalAutofill={false} placeholder="Last name *" value={editUser.last_name} onChange={(e) => setEditUser({ ...editUser, last_name: e.target.value })} />
                <div>
                  <PhoneInput personalAutofill={false} placeholder="Phone" value={editUser.phone} onValueChange={(phone) => setEditUser({ ...editUser, phone })} />
                  {editPhoneRejected && (
                    <p className="text-destructive mt-1 text-xs">{USER_PHONE_INVALID_MESSAGE}</p>
                  )}
                </div>
                <Input kind="phone-extension" personalAutofill={false} placeholder="Extension" value={editUser.phone_ext} onChange={(e) => setEditUser({ ...editUser, phone_ext: e.target.value })} />
              </div>
              {/* The person's settings (P1): what they are offered. Read and written through the person's switches, so only an Admin sees them. */}
              {canManageRoles && <PersonSettingsSection userId={editUser.id} />}
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

      {/* Set or change a mailbox address: only the name part is typed; the company part and domain are fixed. */}
      {mailboxFor?.user.mailbox?.address_suffix && (
        <MailboxAddressDialog
          open
          onOpenChange={(o) => !o && setMailboxFor(null)}
          person={{ id: mailboxFor.user.id, name: `${mailboxFor.user.first_name} ${mailboxFor.user.last_name}` }}
          mode={mailboxFor.mode}
          currentAddress={mailboxFor.user.mailbox.address}
          suffix={mailboxFor.user.mailbox.address_suffix}
        />
      )}

      {/* Role-change confirmation - asked every time, whether or not the person has changes of their own */}
      <Dialog open={roleChange !== null} onOpenChange={(o) => !o && setRoleChange(null)}>
        <DialogContent intent="choice">
          <DialogHeader>
            <DialogTitle>Change role for {roleChange?.user.first_name} {roleChange?.user.last_name}?</DialogTitle>
            <DialogDescription>
              {roleChange && roleChangeMessage(roleChange.user, roleNameOf(roleChange.user), roleChange.to)}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRoleChange(null)}>
              Cancel
            </Button>
            <Button onClick={() => void confirmRoleChange()} disabled={updateUser.isPending}>
              Change role
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Deactivate confirmation - deactivation also revokes login, and hands the person's mailbox to the main mailbox or a colleague */}
      <DeactivateUserDialog
        person={deactivateFor}
        people={users}
        showMailboxChoice={hasEmail}
        pending={deactivate.isPending}
        onCancel={() => setDeactivateFor(null)}
        onConfirm={(handoverTo, reassign) => void confirmDeactivate(handoverTo, reassign)}
      />

      {/* Hand a leaver's mailbox on later - to another person or to the main mailbox */}
      <MoveMailboxDialog
        person={moveFor}
        people={users}
        pending={moveMailbox.isPending}
        onCancel={() => setMoveFor(null)}
        onConfirm={(handoverTo) => void confirmMove(handoverTo)}
      />

      {/* Delete-team confirmation */}
      <Dialog open={teamToDelete !== null} onOpenChange={(o) => !o && setTeamToDelete(null)}>
        <DialogContent intent="choice">
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
