import { useEffect, useState } from 'react';

// Every role/permission hook and type is IMPORTED, never re-derived. The view
// model this page posts is mapped straight onto real `role_permissions` rows by
// the backend's `viewModelToGrants`, and `MANAGED_KEYS` deletes every managed
// pair absent from it - so a reshaped payload silently strips grants. See
// backend/src/lib/permissions/roleViewModel.ts.
import {
  useRoles,
  useRolePermissions,
  useUpdateRolePermissions,
  useResetRole,
  type RoleViewModel,
  type ScopeValue,
} from '@/lib/api/roles';
import { useSettingsGuard } from '@/stores/settingsGuard.store';

import { Button } from '@/ui-kit/components/ui/button';
import { Switch } from '@/ui-kit/components/ui/switch';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/ui-kit/components/ui/table';
import { cn } from '@/ui-kit/lib/utils';

import { TabStrip, TabPanel } from '../_shared/tabs';
import { useSettingsBar } from './settingsBar';
import { Section, FlushCard } from './components/section';

// MUST stay in lockstep with backend roleViewModel.MODULES: role.controller.ts derives
// MANAGED_KEYS from that list, and a Save deletes every managed key absent from the VM this
// page posts. A module missing here is therefore not merely unrendered - its CRUD grants get
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
  // Calendar Entries (Slice 01, spec §4) - user-facing "Events". This is the LIVE Roles screen
  // (pages/v2/routes/settings.routes.tsx mounts THIS file at /settings/roles); the copy at
  // pages/settings/RolesPage.tsx is a dead v1 fork reached only by its own tests.
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

// Multi-visit close-out (Q9, 2026-08-23) - the five Job milestone-verb toggles. Each was
// previously visible ONLY on the per-user Permissions page (a different capability surface,
// Users & Teams > Permissions) - this page had no cell for any of them, which is why an admin
// could not see or grant technician `complete Job` from Roles & Permissions at all. Keep in
// lockstep with backend TOGGLES (roleViewModel.ts) and RoleToggles (lib/api/roles.ts).
const JOB_MILESTONE_TOGGLES: Array<[keyof RoleViewModel['toggles'], string]> = [
  ['enRouteJobs', 'Mark on the way'],
  ['arriveJobs', 'Mark jobs on-site'],
  ['startJobs', 'Start jobs'],
  ['completeJobs', 'Complete jobs'],
  ['rescheduleJobs', 'Reschedule jobs'],
];

/**
 * Settings > Roles & Permissions.
 *
 * ROLE DEFAULTS only. The per-user capability grants (`create Job`,
 * `create Invoice`, `record_payment`, `reschedule` and the rest of
 * `USER_CAPABILITIES`) are a different surface entirely - the Permissions
 * button on each row of Users & Teams - and the two are deliberately kept
 * apart, with different vocabulary (binary switches here, a tri-state
 * Inherit/Allow/Deny group there). Nothing here reads or writes a per-user
 * grant.
 */
export default function RolesPage() {
  const { data: roles = [] } = useRoles();
  const [selected, setSelected] = useState<string>('');
  const { data: loaded } = useRolePermissions(selected);
  const updatePerms = useUpdateRolePermissions();
  const resetRole = useResetRole();
  const { registerSaver } = useSettingsBar();
  const requestLeave = useSettingsGuard((s) => s.requestLeave);

  const [draft, setDraft] = useState<RoleViewModel | null>(null);
  const [activeTab, setActiveTab] = useState('permissions');

  useEffect(() => {
    const first = roles[0];
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate default-selection idiom: picks the first fetched role once, guarded by `!selected`
    if (!selected && first) setSelected(first.role);
  }, [roles, selected]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate mirror idiom: the editable draft is re-cloned from server truth whenever it arrives
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

  return (
    <div className="flex gap-6">
      {/* Roles list. Switching role goes through `requestLeave` - an INTRA-page
          change a router blocker could never see, which is exactly why the
          unsaved-changes guard lives in a zustand store rather than the router. */}
      <div className="w-56 shrink-0 space-y-1">
        {roles.map((r) => (
          <Button
            key={r.role}
            variant={selected === r.role ? 'secondary' : 'ghost'}
            size="sm"
            className="w-full justify-between"
            onClick={() => requestLeave(() => setSelected(r.role))}
          >
            <span className="font-medium">{r.label}</span>
            <span className="text-muted-foreground text-xs">{r.userCount}</span>
          </Button>
        ))}
        <p className="text-muted-foreground px-3 pt-3 text-xs">+ New custom role (coming soon)</p>
      </div>

      {/* Detail */}
      <div className="min-w-0 flex-1">
        {!draft ? (
          <p className="text-muted-foreground text-sm">Select a role.</p>
        ) : (
          <>
            <div className="mb-4 flex items-center justify-between">
              <div>
                {/* role/aria-level rather than an <h3>: the raw-tag ratchet sits
                    at its floor for h1-h6. The specs read this by accessible
                    name (`getByRole('heading', { name: 'Sales' })`). */}
                <p role="heading" aria-level={3} className="text-base font-semibold">
                  {roles.find((r) => r.role === selected)?.label}
                </p>
                {!editable && (
                  <span className="text-status-amber-emphasis text-xs">
                    Full access - non-reducible
                  </span>
                )}
              </div>
              {editable && (
                <Button variant="outline" size="sm" onClick={() => void resetRole.mutateAsync(selected)}>
                  Reset to default
                </Button>
              )}
            </div>

            <TabStrip
              value={activeTab}
              onValueChange={setActiveTab}
              tabs={[
                { value: 'permissions', label: 'Permissions' },
                { value: 'scope', label: 'Data Scope' },
              ]}
            />

            <TabPanel value="permissions" activeValue={activeTab}>
              <div className="space-y-4 pt-4">
                <FlushCard>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Module</TableHead>
                        {CRUD.map(([, label]) => (
                          <TableHead key={label} align="center">
                            {label}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {MODULES.map(([subject, label]) => (
                        <TableRow key={subject}>
                          {/* The weight lives on a span, not on TableCell: the
                              component-api ratchet counts an appearance class
                              handed to TableCell and sits at its floor. */}
                          <TableCell><span className="font-medium">{label}</span></TableCell>
                          {CRUD.map(([action]) => (
                            <TableCell key={action}>
                              <div className="flex justify-center">
                                <Switch
                                  checked={!!draft.matrix[subject]?.[action]}
                                  disabled={!editable}
                                  onCheckedChange={(v) => setCell(subject, action, v)}
                                />
                              </div>
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </FlushCard>

                <Section title="Sensitive" level={4}>
                  <SensitiveRow
                    label="See financial data"
                    checked={draft.sensitive.seeFinancials}
                    disabled={!editable}
                    onChange={(v) => setSensitive('seeFinancials', v)}
                  />
                  {/* SRVW-140 - report visibility is a DIFFERENT thing from cost/price
                      visibility, and "See financial data" used to be its only control. */}
                  <SensitiveRow
                    label="View reports"
                    checked={draft.sensitive.viewReports}
                    disabled={!editable}
                    onChange={(v) => setSensitive('viewReports', v)}
                  />
                  <SensitiveRow
                    label="Record & refund payments"
                    checked={draft.sensitive.managePayments}
                    disabled={!editable}
                    onChange={(v) => setSensitive('managePayments', v)}
                  />
                  <SensitiveRow
                    label="Edit record ID numbers - also rewrites derived estimate and logistic-order numbers"
                    checked={draft.sensitive.editRecordIds}
                    disabled={!editable}
                    onChange={(v) => setSensitive('editRecordIds', v)}
                  />
                  {/* Manual Communication Log slice 4 - deliberately HERE and not as a twelfth
                      MODULES row. Communication is already a backend MODULES subject, so a row
                      would put its `create` grant on screen as a tickable cell - and that grant
                      is SHARED_BASELINE: unticking it would take away click-to-call, texts,
                      WhatsApp and email from the role, which is not what an admin adjusting who
                      may write history is asking for. */}
                  <SensitiveRow
                    label="Log past communications - hand-record calls, texts and emails that happened outside ServWave"
                    checked={draft.sensitive.logPastCommunications}
                    disabled={!editable}
                    onChange={(v) => setSensitive('logPastCommunications', v)}
                  />

                  {/* #2046 - the org-wide Communication SECTION gate, deliberately HERE and not a
                      twelfth MODULES row for the same reason as the switch above: the section is
                      the sidebar group, the `/communication/*` pages and the shell shortcuts, a
                      different surface from the per-record Communication tab a role keeps on
                      `read`/`create Communication` alone whether or not this is on. */}
                  <SensitiveRow
                    label="Access the Communication section - the org-wide inbox, call log and phone settings"
                    checked={draft.sensitive.accessCommunicationSection}
                    disabled={!editable}
                    onChange={(v) => setSensitive('accessCommunicationSection', v)}
                  />

                  {/* Scoped assignee pool slice 1 (plan:
                      md_files/plans/permissions/2026-08-31-assignee-pool/). INERT in this PR by
                      design - the grant this writes is read by nothing until slice 2 adds the
                      crew and performer validators. It is here and not as a cell on the Users
                      row because those four cells are about administering staff records, and an
                      admin deciding who may name other people on work is not being asked whether
                      the role may also create and deactivate logins. */}
                  <SensitiveRow
                    label="Assign work to other people - put someone other than themselves on a job crew or walkthrough"
                    checked={draft.sensitive.assignOthers}
                    disabled={!editable}
                    onChange={(v) => setSensitive('assignOthers', v)}
                  />
                </Section>

                <Section title="Job Milestones" level={4}>
                  {JOB_MILESTONE_TOGGLES.map(([key, label]) => (
                    <SensitiveRow
                      key={key}
                      label={label}
                      checked={draft.toggles[key]}
                      disabled={!editable}
                      onChange={(v) => setToggle(key, v)}
                    />
                  ))}
                </Section>
              </div>
            </TabPanel>

            <TabPanel value="scope" activeValue={activeTab}>
              <div className="space-y-3 pt-4">
                <Section>
                  <div className="space-y-3">
                    {MODULES.map(([subject, label]) => {
                      const real = SCOPE_REAL.has(subject);
                      const value = draft.scope[subject] ?? 'All';
                      return (
                        <div key={subject} className="flex items-center justify-between">
                          <span className="text-sm font-medium">{label}</span>
                          <div className="flex gap-1">
                            {SCOPES.map((s) => {
                              const disabled = !editable || (!real && s !== 'All');
                              const active = real ? value === s : s === 'All';
                              return (
                                <Button
                                  key={s}
                                  size="sm"
                                  variant={active ? 'secondary' : 'outline'}
                                  aria-pressed={active}
                                  disabled={disabled}
                                  title={
                                    !real && s !== 'All'
                                      ? 'No record-ownership field - applies at All'
                                      : undefined
                                  }
                                  onClick={() => setScope(subject, s)}
                                  className={cn('h-7 px-2.5 text-xs')}
                                >
                                  {s}
                                </Button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                    <p className="text-muted-foreground pt-2 text-xs">
                      Customers &amp; Inventory have no record-ownership field, so scope applies at
                      the &ldquo;All&rdquo; level.
                    </p>
                  </div>
                </Section>
              </div>
            </TabPanel>
          </>
        )}
      </div>
    </div>
  );
}

function SensitiveRow({
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
      <span className="text-sm">{label}</span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}
