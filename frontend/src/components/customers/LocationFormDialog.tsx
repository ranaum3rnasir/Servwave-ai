import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { extractApiError } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { FormField } from '@/components/patterns/FormField';
import { AddressAutocomplete } from '@/components/crm/address-autocomplete';

const locationSchema = z.object({
  address_line1: z.string().min(1, 'Address is required').max(200),
  address_line2: z.string().max(200).optional(),
  city: z.string().min(1, 'City is required').max(100),
  state: z.string().min(2, 'State is required').max(2),
  zip: z.string().min(5, 'ZIP is required').max(10),
  is_primary: z.boolean().optional(),
});

type LocationFormData = z.infer<typeof locationSchema>;

interface Location {
  id: string;
  address_line1: string;
  address_line2?: string | null;
  city: string;
  state: string;
  zip: string;
  is_primary: boolean;
}

interface LocationFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  location?: Location | null;
}

export function LocationFormDialog({ open, onOpenChange, customerId, location }: LocationFormDialogProps) {
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Location' : 'Add Location'}</DialogTitle>
        </DialogHeader>

        <form onSubmit={form.handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
          <FormField
            label="Address"
            htmlFor="address_line1"
            required
            error={form.formState.errors.address_line1?.message}
          >
            <AddressAutocomplete
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
          </FormField>

          <FormField label="Unit / Suite" htmlFor="address_line2">
            <Input {...form.register('address_line2')} />
          </FormField>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormField label="City" htmlFor="city" required error={form.formState.errors.city?.message}>
              <Input {...form.register('city')} />
            </FormField>
            <FormField label="State" htmlFor="state" required error={form.formState.errors.state?.message}>
              <Input maxLength={2} {...form.register('state')} />
            </FormField>
          </div>

          <FormField label="ZIP Code" htmlFor="zip" required error={form.formState.errors.zip?.message}>
            <Input {...form.register('zip')} />
          </FormField>

          {/* Not a FormField: the label sits BESIDE the control on one justified
              row, and FormField's Stack is a label-above-control column. Fitting
              it would mean adding an orientation prop to the shared pattern. */}
          <div className="flex items-center justify-between">
            <Label htmlFor="is_primary">Primary Location</Label>
            <Switch
              id="is_primary"
              checked={form.watch('is_primary') || false}
              onCheckedChange={(checked) => form.setValue('is_primary', checked)}
            />
          </div>

          {mutation.error && (
            <p className="text-sm text-danger">
              {extractApiError(mutation.error, 'Something went wrong')}
            </p>
          )}

          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving...' : isEdit ? 'Save Changes' : 'Add Location'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
