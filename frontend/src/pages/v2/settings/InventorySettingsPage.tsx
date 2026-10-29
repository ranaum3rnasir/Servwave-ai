/**
 * Settings > Inventory - org stock policy (Inventory P1 section 7). Follows the
 * PaymentsListsPage skeleton: react-hook-form + dirty-only PATCH via the shared
 * settings Save bar (useSettingsBar().registerSaver).
 *
 *   - default_inventory_location_id - pre-selected when receiving stock and deducting
 *     job/invoice items (D13).
 *   - block_negative_stock - D7: ON rejects over-draw deductions (409 SHORTAGE);
 *     OFF allows them with a warning and flags the balance for review.
 */
import { useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';

import {
  useOrganization,
  useUpdateOrganization,
  type OrgFormValues,
} from '@/lib/api/organization';
import { useLocations } from '@/lib/api/inventory';

import { Label } from '@/ui-kit/components/ui/label';
import { Switch } from '@/ui-kit/components/ui/switch';

import { useSettingsBar } from './settingsBar';
import { Section } from './components/section';
import { Field } from './components/field';
import { SelectField } from '@/ui-kit/components/form/selectField';

type FormValues = Pick<OrgFormValues, 'default_inventory_location_id' | 'block_negative_stock'>;

function dirtyValues(dirtyFields: Record<string, unknown>, values: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(dirtyFields)) {
    if (dirtyFields[k]) out[k] = values[k];
  }
  return out;
}

export default function InventorySettingsPage() {
  const { data: org } = useOrganization();
  const update = useUpdateOrganization();
  const { registerSaver } = useSettingsBar();
  const { data: locationsData } = useLocations();
  const locations = locationsData ?? [];

  const form = useForm<FormValues>({ defaultValues: {} });
  const { reset, watch, setValue, getValues, formState } = form;

  // Hydrate once per org, and never over an edit in progress - the same guard
  // CompanyProfilePage carries, for the same reason and against the same query.
  // Hydrating on the DATA OBJECT hands the form back to the server mid-edit
  // whenever a refetch lands on a payload another admin has changed, and the
  // `reset()` that does it also takes `isDirty` to false, which SettingsLayout
  // publishes into the settings guard store - so the unsaved-changes prompt
  // stops asking and the loss is silent. Both halves matter: the dirty check is
  // what stops the clobber, keeping `org` as the dependency is what lets a
  // pristine form go on tracking the server (including the refetch after this
  // page's own save), and the id check stops the dirty guard wedging the form
  // onto a stale company if the org under the page ever changes identity.
  const hydratedOrgId = useRef<string | null>(null);

  useEffect(() => {
    const identityChanged = hydratedOrgId.current !== org?.id;
    if (!identityChanged && formState.isDirty) return;
    if (org) {
      hydratedOrgId.current = org.id;
      reset({
        default_inventory_location_id: org.default_inventory_location_id ?? null,
        block_negative_stock: org.block_negative_stock ?? false,
      });
    }
    // `isDirty` is read, not depended on: it is a getter on RHF's formState
    // Proxy, and listing it would re-arm this effect on every dirty flip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org, reset]);

  const isDirty = formState.isDirty;

  useEffect(() => {
    registerSaver({
      save: async () => {
        const values = getValues();
        const payload = dirtyValues(
          formState.dirtyFields as Record<string, unknown>,
          values as Record<string, unknown>,
        );
        if (Object.keys(payload).length) await update.mutateAsync(payload as Partial<OrgFormValues>);
        reset(values);
      },
      discard: () => {
        if (org) reset();
      },
      isDirty,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty]);

  const defaultLoc = watch('default_inventory_location_id') ?? null;
  const blockNegative = watch('block_negative_stock') ?? false;

  return (
    <div className="space-y-6">
      <Section
        title="Stock policy"
        description="Org-wide defaults for how stock moves when items are received and deducted."
      >
        <Field label="Default inventory location">
          <SelectField
            aria-label="Default inventory location"
            className="w-full max-w-sm"
            value={defaultLoc ?? 'NONE'}
            onValueChange={(v) =>
              setValue('default_inventory_location_id', v === 'NONE' ? null : v, {
                shouldDirty: true,
              })
            }
            placeholder="None"
            options={[
              { value: 'NONE', label: 'None' },
              ...locations.map((l) => ({ value: l.id, label: l.name })),
            ]}
          />
        </Field>
        <p className="text-muted-foreground text-xs">
          Pre-selected when receiving stock and deducting job/invoice items.
        </p>

        <div className="border-border flex items-start justify-between gap-4 border-t pt-4">
          <div>
            <Label htmlFor="block-negative-stock">Block negative stock</Label>
            <p className="text-muted-foreground text-xs">
              On: deductions that exceed on-hand are rejected. Off: allowed with a warning, and
              the balance is flagged for review.
            </p>
          </div>
          <Switch
            id="block-negative-stock"
            checked={blockNegative}
            onCheckedChange={(v) => setValue('block_negative_stock', v, { shouldDirty: true })}
            aria-label="Block negative stock"
          />
        </div>
      </Section>
    </div>
  );
}
