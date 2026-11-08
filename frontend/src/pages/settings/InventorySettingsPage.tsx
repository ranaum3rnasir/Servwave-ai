/**
 * Settings → Inventory — org stock policy (Inventory P1 §7). Follows the
 * PaymentsListsPage skeleton: react-hook-form + dirty-only PATCH via the shared
 * SettingsLayout Save bar (useSettingsBar().registerSaver).
 *
 *   • default_inventory_location_id — pre-selected when receiving stock and deducting
 *     job/invoice items (D13).
 *   • block_negative_stock — D7: ON rejects over-draw deductions (409 SHORTAGE);
 *     OFF allows them with a warning and flags the balance for review.
 */
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import {
  useOrganization,
  useUpdateOrganization,
  type OrgFormValues,
} from '@/lib/api/organization';
import { useSettingsBar } from './SettingsLayout';
import { useLocations } from '@/lib/api/inventory';
import { Card } from '@/components/ui/card';
import { Heading } from '@/components/ui/heading';
import { FormField } from '@/components/patterns/FormField';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

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

  useEffect(() => {
    if (org) {
      reset({
        default_inventory_location_id: org.default_inventory_location_id ?? null,
        block_negative_stock: org.block_negative_stock ?? false,
      });
    }
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
      <Card className="space-y-5">
        <div>
          <Heading level={3}>Stock policy</Heading>
          <p className="text-xs text-text-secondary">
            Org-wide defaults for how stock moves when items are received and deducted.
          </p>
        </div>

        {/*
          The render-prop child below, not FormField's cloneElement path: the
          single element here is the radix `Select` ROOT, which renders no DOM of
          its own and would swallow the generated id. The trigger is the labelable
          element, so the call site places the id itself - exactly the case
          FormField's render-prop escape hatch exists for.
        */}
        <FormField
          label="Default inventory location"
          hint="Pre-selected when receiving stock and deducting job/invoice items."
        >
          {(fieldProps) => (
            <Select
              value={defaultLoc ?? 'NONE'}
              onValueChange={(v) =>
                setValue('default_inventory_location_id', v === 'NONE' ? null : v, {
                  shouldDirty: true,
                })
              }
            >
              <SelectTrigger
                {...fieldProps}
                className="w-full max-w-sm"
                aria-label="Default inventory location"
              >
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="NONE">None</SelectItem>
                {locations.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormField>

        <div className="flex items-start justify-between gap-4 border-t border-border pt-4">
          <div>
            <Label htmlFor="block-negative-stock">Block negative stock</Label>
            <p className="text-xs text-text-secondary">
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
      </Card>
    </div>
  );
}
