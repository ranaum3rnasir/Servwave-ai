import { HelpIcon } from '@/components/permissions/HelpIcon';
import { choiceLabel, valueText } from '@/components/permissions/switchValueText';
import { usePersonSwitches, useSavePersonSwitches, useSwitchCatalog, type CatalogSwitch } from '@/lib/api/permissionSwitches';
import { type SwitchValue } from '@/lib/api/shared/switchTypes';
import { Button } from '@/ui-kit/components/ui/button';
import { Switch } from '@/ui-kit/components/ui/switch';

/**
 * A person's settings (Roles & Permissions P1, A1): what they are offered, not what they may do. Who they can be put on
 * a record as, which new records alert them, which stock view opens, whether their stock is limited to their own van,
 * and which Phone tabs they see. They keep the storage and the behaviour they always had (the role they are based on
 * holds the default, a change here is their own value, saved at once through the person's switches), but they are not
 * drawn on the Permissions pages.
 *
 * The catalog says which keys are settings and how each is labelled; the groups below only order them. An Admin person has
 * none (one Full access box), and a person's own settings are read-only to them: the server refuses a write to one's own set.
 */
const GROUPS: { label: string; keys: string[] }[] = [
  { label: 'Can be put on a record as', keys: ['can_own_leads', 'can_be_dispatcher', 'can_be_on_crew'] },
  { label: 'Alert me about every', keys: ['alert_every_lead', 'alert_every_job', 'alert_every_estimate', 'alert_every_invoice'] },
  { label: 'Stock', keys: ['inventory_view', 'restrict_stock_to_own_van'] },
  {
    label: 'Phone tabs',
    keys: ['phone_numbers_tab', 'call_flows_tab', 'call_masking_tab', 'call_groups_tab', 'training_tab', 'blocked_callers_tab'],
  },
];

export function PersonSettingsSection({ userId }: { userId: string }) {
  const { data: catalog } = useSwitchCatalog();
  const { data: person } = usePersonSwitches(userId);
  const save = useSavePersonSwitches();
  if (!catalog || !person || person.admin_box) return null;

  const byKey = new Map(catalog.switches.map((s) => [s.key, s]));
  const listed = new Set(catalog.layout.settings ?? []);
  const groups = GROUPS.map((g) => ({ label: g.label, settings: g.keys.filter((k) => listed.has(k)).map((k) => byKey.get(k)!).filter(Boolean) }))
    .filter((g) => g.settings.length > 0);
  if (groups.length === 0) return null;
  const editable = person.editable && !save.isPending;
  const set = (key: string, value: SwitchValue) => save.mutate({ userId, values: { [key]: value } });

  return (
    <section aria-label="Settings" className="flex flex-col gap-3 border-t pt-4">
      <p role="heading" aria-level={3} className="text-sm font-semibold">
        Settings
      </p>
      {groups.map((group) => (
        <div key={group.label} role="group" aria-label={group.label} className="flex flex-col gap-1">
          <p className="text-muted-foreground text-xs font-semibold">{group.label}</p>
          {group.settings.map((sw) => (
            <SettingLine key={sw.key} sw={sw} value={person.values[sw.key]} editable={editable} onChange={(v) => set(sw.key, v)} />
          ))}
        </div>
      ))}
    </section>
  );
}

function SettingLine({
  sw, value, editable, onChange,
}: { sw: CatalogSwitch; value: SwitchValue | undefined; editable: boolean; onChange: (value: SwitchValue) => void }) {
  return (
    <div data-setting-line className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1">
      <div className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 text-sm">{sw.label}</span>
        <HelpIcon label={sw.label} text={sw.helpText} />
      </div>
      {!editable ? (
        <span className="text-muted-foreground text-sm">{valueText(sw, value)}</span>
      ) : sw.kind === 'toggle' ? (
        <Switch aria-label={sw.label} checked={value === true} onCheckedChange={(on) => onChange(on)} />
      ) : (
        <div role="radiogroup" aria-label={sw.label} className="flex flex-wrap gap-1">
          {(sw.choices ?? []).map((choice) => (
            <Button
              key={choice}
              type="button"
              role="radio"
              aria-checked={value === choice}
              size="sm"
              variant={value === choice ? 'secondary' : 'outline'}
              onClick={() => onChange(choice)}
            >
              {choiceLabel(choice)}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
