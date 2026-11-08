import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import api from '@/lib/axios';
import { extractApiError } from '@/lib/utils';
import { AddressAutocomplete } from '@/components/crm/address-autocomplete';
import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { Switch } from '@/ui-kit/components/ui/switch';

/**
 * v2 service-location dialog, on the kit's Dialog and controls.
 *
 * The SCHEMA, the endpoints, the invalidation and every message are the legacy
 * component's, character for character. `AddressAutocomplete` is reused as-is:
 * it wraps Google Places v1 (3-character minimum, 300 ms debounce,
 * VITE_GOOGLE_MAPS_API_KEY) and the kit ships nothing that does that - see the
 * ledger.
 *
 * The one carried-over quirk worth naming: Cancel closes WITHOUT resetting the
 * form, so a half-typed address survives a reopen on the same location. That is
 * the legacy behaviour and changing it here would be a behaviour change.
 */
const locationSchema = z.object({
  address_line1: z.string().min(1, 'Address is required').max(200),
  address_line2: z.string().max(200).optional(),
  city: z.string().min(1, 'City is required').max(100),
  state: z.string().min(2, 'State is required').max(2),
  zip: z.string().min(5, 'ZIP is required').max(10),
  is_primary: z.boolean().optional(),
});

type LocationFormData = z.infer<typeof locationSchema>;

export interface DialogLocation {
  id: string;
  address_line1: string;
  address_line2?: string | null;
  city: string;
  state: string;
  zip: string;
  is_primary: boolean;
}

export interface LocationFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  location?: DialogLocation | null;
}

/** One field row: label above control, message below. */
function Field({
  label, htmlFor, required, error, children,
}: {
  label: string;
  htmlFor: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>
        {label}
        {required && <span className="text-destructive ms-0.5" aria-hidden>*</span>}
      </Label>
      {children}
      {error && <p className="text-destructive text-[12px] font-medium">{error}</p>}
    </div>
  );
}

function LocationFormDialog({
  open, onOpenChange, customerId, location,
}: LocationFormDialogProps) {
  const queryClient = useQueryClient();
  const isEdit = Boolean(location);

  const form = useForm<LocationFormData>({
    resolver: zodResolver(locationSchema),
    defaultValues: {
      address_line1: '',
      address_line2: '',
      city: '',
      state: '',
      zip: '',
      is_primary: false,
    },
  });

  useEffect(() => {
    if (location) {
      form.reset({
        address_line1: location.address_line1,
        address_line2: location.address_line2 || '',
        city: location.city,
        state: location.state,
        zip: location.zip,
        is_primary: location.is_primary,
      });
    } else {
      form.reset();
    }
  }, [location, form]);

  const mutation = useMutation({
    mutationFn: async (data: LocationFormData) => {
      if (isEdit && location) {
        const { data: res } = await api.patch(`/api/customers/${customerId}/locations/${location.id}`, data);
        return res;
      }
      const { data: res } = await api.post(`/api/customers/${customerId}/locations`, data);
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customer', customerId] });
      onOpenChange(false);
      form.reset();
    },
  });

  const errors = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Location' : 'Add Location'}</DialogTitle>
        </DialogHeader>

        <form onSubmit={form.handleSubmit((data) => mutation.mutate(data))}>
          <DialogBody className="flex flex-col gap-4">
            <Field label="Address" htmlFor="v2-location-address" required error={errors.address_line1?.message}>
              <AddressAutocomplete
                id="v2-location-address"
                value={form.watch('address_line1') || ''}
                onChange={(val) => form.setValue('address_line1', val, { shouldValidate: true })}
                onSelect={(place) => {
                  form.setValue('address_line1', place.address_line1, { shouldValidate: true });
                  form.setValue('address_line2', place.address_line2 || '', { shouldValidate: true });
                  form.setValue('city', place.city, { shouldValidate: true });
                  form.setValue('state', place.state, { shouldValidate: true });
                  form.setValue('zip', place.zip, { shouldValidate: true });
                }}
              />
            </Field>

            <Field label="Unit / Suite" htmlFor="v2-location-line2">
              <Input id="v2-location-line2" {...form.register('address_line2')} />
            </Field>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="City" htmlFor="v2-location-city" required error={errors.city?.message}>
                <Input id="v2-location-city" aria-invalid={!!errors.city} {...form.register('city')} />
              </Field>
              <Field label="State" htmlFor="v2-location-state" required error={errors.state?.message}>
                <Input id="v2-location-state" maxLength={2} aria-invalid={!!errors.state} {...form.register('state')} />
              </Field>
            </div>

            <Field label="ZIP Code" htmlFor="v2-location-zip" required error={errors.zip?.message}>
              <Input id="v2-location-zip" aria-invalid={!!errors.zip} {...form.register('zip')} />
            </Field>

            {/* Label BESIDE the control on one justified row, so this is not a
                Field: the switch reads as a setting, not as a text input. */}
            <div className="flex items-center justify-between">
              <Label htmlFor="v2-location-primary">Primary Location</Label>
              <Switch
                id="v2-location-primary"
                checked={form.watch('is_primary') || false}
                onCheckedChange={(checked) => form.setValue('is_primary', checked)}
              />
            </div>

            {mutation.error && (
              <p className="text-destructive text-sm">
                {extractApiError(mutation.error, 'Something went wrong')}
              </p>
            )}
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving...' : isEdit ? 'Save Changes' : 'Add Location'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export { LocationFormDialog };
