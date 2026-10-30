import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

import { useUsers } from '@/lib/api/users';
import {
  basedOnValues,
  changedSwitches,
  differingSwitches,
  emailPageClosed,
  sameValue,
  usePersonSwitches,
  useResetPersonSwitches,
  useSavePersonSwitches,
  useAcceptedPaymentMethods,
  useSwitchCatalog,
  type SwitchSet,
} from '@/lib/api/permissionSwitches';
import { changeCountLabel } from '@/lib/permissionChangeCount';
import { useFeature } from '@/lib/entitlements';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import SwitchSetEditor from '@/components/permissions/SwitchSetEditor';

import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { TabsContent } from '@/components/ui/tabs';
import { TabStrip } from '@/components/patterns/TabStrip';

import { useSettingsBar } from './settingsBar';
import { Section } from './components/section';
import { SaveAsRoleDialog } from './components/saveAsRoleDialog';
import { PersonChangeLog } from './components/changeLog';
import { CantReadMark } from './components/mailboxCell';
import { ADDRESS_NEEDED_MARK, showsCantRead } from './components/mailboxMarks';
import { MailboxAddressDialog } from './components/mailboxAddressDialog';

/**
 * Settings > Users & Teams > a person's Permissions.
 *
 * The same switch-set editor as the Roles page, at this person's own values, reached from the Permissions action on
 * their row. The header names the person, the role their switches were filled from and how many of them differ from
 * it; a switch that differs is highlighted with a reset to the role's value, and "Reset all" brings every one back. A
 * save sends only the switches that changed, and Save as role makes a role of the person's switches. An Admin person has no switches (one Full access box), and the
 * viewer's own page is read-only: the server refuses a write to one's own set, and the page never offers it.
 */
export default function PersonPermissionsPage() {
  const { userId = '' } = useParams();
  // Keyed by person, so moving from one person's page to another's starts with no edits.
  return <PersonPermissions key={userId} userId={userId} />;
}

function PersonPermissions({ userId }: { userId: string }) {
  const navigate = useNavigate();
  const requestLeave = useSettingsGuard((s) => s.requestLeave);
  const { registerSaver } = useSettingsBar();
  const { data: users = [] } = useUsers();
  const { data: catalog, isError: catalogUnavailable } = useSwitchCatalog();
  const acceptedMethods = useAcceptedPaymentMethods();
  const { data: loaded, isError: personUnavailable } = usePersonSwitches(userId);
  const savePerson = useSavePersonSwitches();
  const resetPerson = useResetPersonSwitches();
  // Edits made and not saved yet: only the switches that differ from what is saved.
  const [edits, setEdits] = useState<SwitchSet>({});
  const [savingAsRole, setSavingAsRole] = useState(false);
  const [settingAddress, setSettingAddress] = useState(false);
  const hasEmail = useFeature('email');
  const canUpdateUser = useAppAbility().can('update', 'User');
  // The editor, or the person's change log. The log is read only while its tab is open.
  const [tab, setTab] = useState('permissions');

  const person = users.find((u) => u.id === userId);
  const name = person ? `${person.first_name} ${person.last_name}` : 'This person';
  const editable = !!loaded?.editable;
  const values = loaded ? { ...loaded.values, ...edits } : undefined;
  const isDirty = editable && Object.keys(edits).length > 0;
  // The based-on role's current value for every switch, and which of them this person holds differently right now
  // (saved values with the edits not yet saved), so the count and the highlights follow what the page shows.
  const roleValues = loaded && !loaded.admin_box ? basedOnValues(loaded) : undefined;
  const differing = catalog && values && roleValues ? differingSwitches(catalog, values, roleValues) : [];
  const basedOnLabel = loaded?.based_on?.label;
  // The mailbox marks (PRD 10): "Address needed" with "Set address", and "Can't read" read from the switches as they
  // stand on the page, edits included, so the mark follows the switch before saving. An Admin has no switches to close.
  const mailbox = person?.mailbox;
  const needsAddress = hasEmail && mailbox?.status === 'address_needed';
  const cantRead =
    hasEmail && !!values && !loaded?.admin_box &&
    showsCantRead({ email_page_closed: emailPageClosed(values), mailbox: person?.mailbox, is_active: person?.is_active ?? true });

  // A switch changed on the page and not saved yet goes back by dropping the edit; one the server holds differently
  // goes back through the server's reset, which stores the role's value and logs it.
  const resetSwitch = (key: string) => {
    if (!loaded || !roleValues) return;
    const dropEdit = () => setEdits(({ [key]: _dropped, ...rest }) => rest);
    if (sameValue(loaded.values[key], roleValues[key])) dropEdit();
    else resetPerson.mutate({ userId, switchKeys: [key] }, { onSuccess: dropEdit });
  };
  const resetAll = () => {
    if (!loaded) return;
    if (loaded.difference_count === 0) setEdits({});
    else resetPerson.mutate({ userId, switchKeys: 'all' }, { onSuccess: () => setEdits({}) });
  };

  useEffect(() => {
    registerSaver({
      save: async () => {
        if (!loaded || !editable || !isDirty) return;
        await savePerson.mutateAsync({ userId, values: edits });
        setEdits({});
      },
      discard: () => setEdits({}),
      isDirty,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty, editable, edits, userId, loaded]);

  return (
    <div className="min-w-0 space-y-4">
      <div data-person-header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          {/* role/aria-level rather than an <h3>: the raw-tag ratchet sits at its floor for h1-h6. */}
          <p role="heading" aria-level={2} className="text-base font-semibold">
            {name}
          </p>
          {(needsAddress || cantRead) && (
            <div data-person-mailbox className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
              {needsAddress && (
                <>
                  <Badge variant="softAmber" size="sm">
                    {ADDRESS_NEEDED_MARK}
                  </Badge>
                  {canUpdateUser && mailbox?.address_suffix && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => setSettingAddress(true)}>
                      Set address
                    </Button>
                  )}
                </>
              )}
              {cantRead && <CantReadMark />}
            </div>
          )}
          {loaded && !loaded.admin_box && loaded.based_on && (
            <p className="text-muted-foreground mt-1 flex flex-wrap gap-x-3 text-xs">
              <span>Based on {loaded.based_on.label}</span>
              <span>{changeCountLabel(differing.length)}</span>
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {editable && basedOnLabel && differing.length > 0 && (
            <Button variant="outline" size="sm" disabled={resetPerson.isPending} onClick={resetAll}>
              Reset all to {basedOnLabel}
            </Button>
          )}
          {/* A role is made from the values the server holds, so unsaved edits have to be saved or dropped first. */}
          {editable && loaded && (
            <Button
              variant="outline"
              size="sm"
              disabled={isDirty}
              disabledReason={isDirty ? 'Save your changes first' : undefined}
              onClick={() => setSavingAsRole(true)}
            >
              Save as role
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => requestLeave(() => navigate('/settings/users'))}>
            <ArrowLeft className="h-4 w-4" />
            Users &amp; Teams
          </Button>
        </div>
      </div>
      {person && mailbox?.address_suffix && (
        <MailboxAddressDialog
          open={settingAddress}
          onOpenChange={setSettingAddress}
          person={{ id: person.id, name }}
          mode="set"
          currentAddress={null}
          suffix={mailbox.address_suffix}
        />
      )}
      <SaveAsRoleDialog open={savingAsRole} onOpenChange={setSavingAsRole} userId={userId} personName={name} />
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
          {loaded?.admin_box ? (
            <Section title="Full access" description="Administrators can do everything in ServWave. Their access cannot be changed here." />
          ) : catalogUnavailable || personUnavailable ? (
            <p className="text-muted-foreground text-sm">This person&rsquo;s permissions can&rsquo;t be shown right now.</p>
          ) : !catalog || !loaded || !values ? (
            <p className="text-muted-foreground text-sm">Loading...</p>
          ) : (
            <>
              {!editable && <p className="text-muted-foreground text-xs">People can&rsquo;t change their own access.</p>}
              <SwitchSetEditor
                acceptedMethods={acceptedMethods}
                catalog={catalog}
                values={values}
                editable={editable}
                onChange={(next) => setEdits(changedSwitches(loaded.values, next))}
                basedOn={
                  basedOnLabel && roleValues
                    ? { label: basedOnLabel, values: roleValues, onReset: resetSwitch, busy: resetPerson.isPending }
                    : undefined
                }
              />
            </>
          )}
        </TabsContent>
        <TabsContent value="change-log" className="pt-2">
          <PersonChangeLog userId={userId} />
        </TabsContent>
      </TabStrip>
    </div>
  );
}
