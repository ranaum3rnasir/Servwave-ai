import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  useRoles,
  useRolePermissions,
  useUpdateRolePermissions,
  useResetRole,
  useCreateRole,
  useRenameRole,
  useArchiveRole,
  type RoleViewModel,
  type RoleSummary,
  type ScopeValue,
} from '@/lib/api/roles';
import { useSettingsBar } from './SettingsLayout';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FormField } from '@/components/patterns/FormField';
import { TabsContent } from '@/components/ui/tabs';
import { TabStrip } from '@/components/patterns/TabStrip';
import { extractApiError } from '@/lib/utils';

// MUST stay in lockstep with backend roleViewModel.MODULES: role.controller.ts derives
// MANAGED_KEYS from that list, and a Save deletes every managed key absent from the VM this
// page posts. A module missing here is therefore not merely unrendered — its CRUD grants get
// wiped on the next Save. See the parity test in backend/src/__tests__/role-view-model.test.ts.
const MODULES: Array<[string, string]> = [
  ['Customer', 'Customers'],
  ['Lead', 'Leads'],
  ['Estimate', 'Estimates'],
  ['Job', 'Jobs'],
  ['Invoice', 'Invoices'],
  ['Inventory', 'Inventory'],
  ['PurchaseOrder', 'Purchase Orders'],
  ['Vendor', 'Vendors'],
  ['ServicePlan', 'Service Plans'],
  ['LogisticOrder', 'Logistic Orders'],
  ['Communication', 'Communication'],
  ['Task', 'Tasks'],
  ['PriceBook', 'Price Book'],
  ['Attachment', 'Attachments'],
  ['User', 'Users'],
  ['Department', 'Departments'],
  ['Location', 'Locations'],
  ['Automation', 'Automations'],
  ['CalendarEntry', 'Events'],
];
const CRUD: Array<['read' | 'create' | 'update' | 'delete', string]> = [
  ['read', 'View'],
  ['create', 'Create'],
  ['update', 'Edit'],
  ['delete', 'Delete'],
];
const SCOPE_REAL = new Set(['Lead', 'Job', 'Estimate', 'Invoice']);
const SCOPES: ScopeValue[] = ['Owned', 'Team', 'Location', 'All'];
// SRVW-139 - the 5 toggle bundles roleViewModel.ts's TOGGLES defines. A plain fixed-key record,
// not an array parsed by a lockstep test like MODULES - there are only 5 of these, ever, and
// they're named, not generated from a growing subject list.
const TOGGLE_ROWS: Array<[keyof RoleViewModel['toggles'], string]> = [
  ['dashboard', 'Dashboard access'],
  ['accountSettings', 'Account settings'],
  ['notifications', 'Notifications'],
  ['modifyDoneJobs', 'Modify done jobs'],
  ['cancelJobs', 'Cancel jobs'],
];
const BASE_ROLES = ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'] as const;

export default function RolesPage() {
  const { data: roles = [] } = useRoles();
  const [selected, setSelected] = useState<string>('');
  const { data: loaded } = useRolePermissions(selected);
  const updatePerms = useUpdateRolePermissions();
  const resetRole = useResetRole();
  const archiveRole = useArchiveRole();
  const { registerSaver } = useSettingsBar();
  const requestLeave = useSettingsGuard((s) => s.requestLeave);

  const [draft, setDraft] = useState<RoleViewModel | null>(null);
  const [activeTab, setActiveTab] = useState('permissions');
  const [createOpen, setCreateOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  useEffect(() => {
    const first = roles[0];
    if (!selected && first) setSelected(first.role);
  }, [roles, selected]);

  useEffect(() => {
    if (loaded) setDraft(structuredClone(loaded));
  }, [loaded]);

  const editable = !!draft?.editable;
  const isDirty = !!draft && !!loaded && JSON.stringify(draft) !== JSON.stringify(loaded);

  useEffect(() => {
    registerSaver({
      save: async () => {
        if (!draft || !editable) return;
        const { editable: _omit, ...vm } = draft;
        void _omit;
        await updatePerms.mutateAsync({ role: draft.role, vm });
      },
      discard: () => loaded && setDraft(structuredClone(loaded)),
      isDirty: isDirty && editable,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty, editable, draft]);

  const setCell = (subject: string, action: 'read' | 'create' | 'update' | 'delete', v: boolean) =>
    setDraft((d) => {
      if (!d) return d;
      const cur = d.matrix[subject] ?? { read: false, create: false, update: false, delete: false };
      return { ...d, matrix: { ...d.matrix, [subject]: { ...cur, [action]: v } } };
    });

  const setSensitive = (key: keyof RoleViewModel['sensitive'], v: boolean) =>
    setDraft((d) => (d ? { ...d, sensitive: { ...d.sensitive, [key]: v } } : d));

  const setScope = (subject: string, v: ScopeValue) =>
    setDraft((d) => (d ? { ...d, scope: { ...d.scope, [subject]: v } } : d));

  const setToggle = (key: keyof RoleViewModel['toggles'], v: boolean) =>
    setDraft((d) => (d ? { ...d, toggles: { ...d.toggles, [key]: v } } : d));

  const selectedRole = roles.find((r) => r.role === selected);
  const isCustom = selectedRole?.type === 'custom';

  const onArchive = async () => {
    setArchiveError(null);
    try {
      await archiveRole.mutateAsync(selected);
      setArchiveOpen(false);
      setSelected('');
    } catch (err) {
      setArchiveError(extractApiError(err, 'Could not archive role'));
    }
  };

  return (
    <div className="flex gap-6">
      {/* Roles list */}
      <div className="w-56 shrink-0 space-y-1">
        {/* Full-width list-row click target (role name + user count), not a
            Button-shaped control - left raw per the program's non-Button-shape carve-out. */}
        {roles.map((r) => (
          <button
            key={r.role}
            onClick={() => requestLeave(() => setSelected(r.role))}
            className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
              selected === r.role ? 'bg-primary-subtle text-primary' : 'text-text-secondary hover:bg-background-light'
            }`}
          >
            <span className="flex items-center gap-2">
              <span className="font-medium">{r.label}</span>
              {r.type === 'custom' && (
                <Badge variant="secondary" tone="info">Custom</Badge>
              )}
            </span>
            <span className="text-xs text-text-secondary">{r.userCount}</span>
          </button>
        ))}
        <Button
          variant="ghost"
          tone="subtle"
          size="sm"
          className="mt-2 w-full justify-start px-3"
          onClick={() => setCreateOpen(true)}
        >
          + New custom role
        </Button>
      </div>

      <CreateRoleDialog
        key={createOpen ? 'create-open' : 'create-closed'}
        open={createOpen}
        onOpenChange={setCreateOpen}
        roles={roles}
        onCreated={(role) => setSelected(role)}
      />
      <RenameRoleDialog
        key={renameOpen ? `rename-open-${selectedRole?.role ?? ''}` : 'rename-closed'}
        open={renameOpen}
        onOpenChange={setRenameOpen}
        role={selectedRole ?? null}
      />
      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={(o) => {
          setArchiveOpen(o);
          if (!o) setArchiveError(null);
        }}
        title={`Archive ${selectedRole?.label ?? 'this role'}?`}
        description={
          archiveError ??
          'Archived roles are removed from the list and can no longer be assigned. This cannot be undone.'
        }
        tone={archiveError ? 'brand' : 'danger'}
        confirmLabel="Archive role"
        onConfirm={() => void onArchive()}
        isLoading={archiveRole.isPending}
      />

      {/* Detail */}
      <div className="min-w-0 flex-1">
        {!draft ? (
          <p className="text-sm text-text-secondary">Select a role.</p>
        ) : (
          <>
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Heading level={3} scale="base">
                  {selectedRole?.label}
                </Heading>
                <Badge variant={isCustom ? 'secondary' : 'outline'} tone={isCustom ? 'info' : undefined}>
                  {isCustom ? 'Custom' : 'System'}
                </Badge>
                {!editable && (
                  <span className="text-xs text-warning">Full access — non-reducible</span>
                )}
              </div>
              <div className="flex gap-2">
                {isCustom && (
                  <>
                    <Button variant="outline" size="sm" onClick={() => setRenameOpen(true)}>
                      Rename
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setArchiveOpen(true)}>
                      Archive
                    </Button>
                  </>
                )}
                {editable && (
                  <Button variant="outline" size="sm" onClick={() => void resetRole.mutateAsync(selected)}>
                    Reset to default
                  </Button>
                )}
              </div>
            </div>

            <TabStrip
              active={activeTab}
              onChange={setActiveTab}
              tabs={[
                { value: 'permissions', label: 'Permissions' },
                { value: 'scope', label: 'Data Scope' },
              ]}
            >
              <TabsContent value="permissions" className="space-y-4 pt-4">
                <Card padding="none">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-text-secondary">
                        <th className="p-3">Module</th>
                        {CRUD.map(([, label]) => (
                          <th key={label} className="p-3 text-center">
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {MODULES.map(([subject, label]) => (
                        <tr key={subject} className="border-b border-border last:border-0">
                          <td className="p-3 font-medium">{label}</td>
                          {CRUD.map(([action]) => (
                            <td key={action} className="p-3 text-center">
                              <div className="flex justify-center">
                                <Switch
                                  checked={!!draft.matrix[subject]?.[action]}
                                  disabled={!editable}
                                  onCheckedChange={(v) => setCell(subject, action, v)}
                                />
                              </div>
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>

                <Card className="space-y-3">
                  <Heading level={4}>Sensitive</Heading>
                  <Row
                    label="See financial data"
                    checked={draft.sensitive.seeFinancials}
                    disabled={!editable}
                    onChange={(v) => setSensitive('seeFinancials', v)}
                  />
                  {/* SRVW-140 - report visibility is a DIFFERENT thing from cost/price
                      visibility, and "See financial data" used to be its only control. */}
                  <Row
                    label="View reports"
                    checked={draft.sensitive.viewReports}
                    disabled={!editable}
                    onChange={(v) => setSensitive('viewReports', v)}
                  />
                  <Row
                    label="Record &amp; refund payments"
                    checked={draft.sensitive.managePayments}
                    disabled={!editable}
                    onChange={(v) => setSensitive('managePayments', v)}
                  />
                  <Row
                    label="Edit record ID numbers - also rewrites derived estimate and logistic-order numbers"
                    checked={draft.sensitive.editRecordIds}
                    disabled={!editable}
                    onChange={(v) => setSensitive('editRecordIds', v)}
                  />
                </Card>

                <Card className="space-y-3">
                  <Heading level={4}>Access</Heading>
                  {TOGGLE_ROWS.map(([key, label]) => (
                    <Row
                      key={key}
                      label={label}
                      checked={draft.toggles[key]}
                      disabled={!editable}
                      onChange={(v) => setToggle(key, v)}
                    />
                  ))}
                </Card>
              </TabsContent>

              <TabsContent value="scope" className="space-y-3 pt-4">
                <Card className="space-y-3">
                  {MODULES.map(([subject, label]) => {
                    const real = SCOPE_REAL.has(subject);
                    const value = draft.scope[subject] ?? 'All';
                    return (
                      <div key={subject} className="flex items-center justify-between">
                        <span className="text-sm font-medium text-text-primary">{label}</span>
                        <div className="flex gap-1">
                          {/* Segmented scope-toggle group, not a Button-shaped control -
                              left raw per the program's non-Button-shape carve-out. */}
                          {SCOPES.map((s) => {
                            const disabled = !editable || (!real && s !== 'All');
                            const active = real ? value === s : s === 'All';
                            return (
                              <button
                                key={s}
                                disabled={disabled}
                                title={!real && s !== 'All' ? 'No record-ownership field — applies at All' : undefined}
                                onClick={() => setScope(subject, s)}
                                className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                                  active
                                    ? 'border-primary bg-primary-subtle text-primary'
                                    : 'border-border text-text-secondary'
                                } ${disabled ? 'cursor-not-allowed opacity-40' : 'hover:bg-background-light'}`}
                              >
                                {s}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                  <p className="pt-2 text-xs text-text-secondary">
                    Customers &amp; Inventory have no record-ownership field, so scope applies at the “All” level.
                  </p>
                </Card>
              </TabsContent>
            </TabStrip>
          </>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-text-primary">{label}</span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

function CreateRoleDialog({
  open,
  onOpenChange,
  roles,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roles: RoleSummary[];
  onCreated: (role: string) => void;
}) {
  const createRole = useCreateRole();
  const [label, setLabel] = useState('');
  const [baseRole, setBaseRole] = useState<(typeof BASE_ROLES)[number]>('TECHNICIAN');
  const [cloneFrom, setCloneFrom] = useState('__none__');
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    setError(null);
    try {
      const created = await createRole.mutateAsync({
        label,
        base_role: baseRole,
        ...(cloneFrom !== '__none__' ? { clone_grants_from: cloneFrom } : {}),
      });
      onOpenChange(false);
      onCreated(created.role);
    } catch (err) {
      setError(extractApiError(err, 'Could not create role'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New custom role</DialogTitle>
          <DialogDescription>
            Starts from a base role&apos;s permissions - customize the matrix after creating.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <FormField label="Name">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Office Manager" />
          </FormField>

          <FormField label="Base role">
            {(fieldProps) => (
              <Select value={baseRole} onValueChange={(v) => setBaseRole(v as (typeof BASE_ROLES)[number])}>
                <SelectTrigger {...fieldProps}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BASE_ROLES.map((r) => (
                    <SelectItem key={r} value={r}>{r}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>

          <FormField label="Copy permissions from (optional)">
            {(fieldProps) => (
              <Select value={cloneFrom} onValueChange={setCloneFrom}>
                <SelectTrigger {...fieldProps}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">{baseRole} defaults</SelectItem>
                  {roles.map((r) => (
                    <SelectItem key={r.role} value={r.role}>{r.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>

          {error && <p className="text-sm text-danger">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void onSubmit()} disabled={!label.trim() || createRole.isPending}>
            {createRole.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create role
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RenameRoleDialog({
  open,
  onOpenChange,
  role,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  role: RoleSummary | null;
}) {
  const renameRole = useRenameRole();
  const [label, setLabel] = useState(role?.label ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    if (!role) return;
    setError(null);
    try {
      await renameRole.mutateAsync({ role: role.role, label, description });
      onOpenChange(false);
    } catch (err) {
      setError(extractApiError(err, 'Could not update role'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Rename role</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <FormField label="Name">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} />
          </FormField>
          <FormField label="Description">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </FormField>
          {error && <p className="text-sm text-danger">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void onSubmit()} disabled={!label.trim() || renameRole.isPending}>
            {renameRole.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
