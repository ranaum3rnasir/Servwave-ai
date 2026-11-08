import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { extractApiError } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AddressAutocomplete } from '@/components/crm/address-autocomplete';
import { MapPin, Plus, AlertTriangle, Loader2 } from 'lucide-react';

// ─── Types ──────────────────────────────────────────

interface ServiceLocation {
  id: string;
  address_line1: string;
  address_line2?: string | null;
  city: string;
  state: string;
  zip: string;
  is_primary?: boolean;
  label?: string | null;
}

interface TaxWarning {
  tax_warning: true;
  old_state: string | null;
  new_state: string;
}

interface EditJobLocationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  customerId: string;
  currentLocation: ServiceLocation | null;
}

// New-address form (only used when adding a brand-new location for this customer).
const addressSchema = z.object({
  address_line1: z.string().min(1, 'Address is required').max(200),
  address_line2: z.string().max(200).optional(),
  city: z.string().min(1, 'City is required').max(100),
  state: z.string().min(2, 'State is required').max(2),
  zip: z.string().min(5, 'ZIP is required').max(10),
});

type AddressFormData = z.infer<typeof addressSchema>;

// ─── Component ──────────────────────────────────────

export function EditJobLocationDialog({
  open,
  onOpenChange,
  jobId,
  customerId,
  currentLocation,
}: EditJobLocationDialogProps) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'pick' | 'new'>('pick');
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(
    currentLocation?.id ?? null,
  );
  const [taxWarning, setTaxWarning] = useState<TaxWarning | null>(null);

  const form = useForm<AddressFormData>({
    resolver: zodResolver(addressSchema),
    defaultValues: { address_line1: '', address_line2: '', city: '', state: '', zip: '' },
  });

  // The job GET does not include the customer's other locations — fetch them.
  const { data: customerDetail, isLoading: locationsLoading } = useQuery({
    queryKey: ['customer', customerId],
    queryFn: async () => {
      const { data } = await api.get(`/api/customers/${customerId}`);
      return data.customer;
    },
    enabled: open && Boolean(customerId),
  });

  const locations: ServiceLocation[] = customerDetail?.service_locations ?? [];

  const mutation = useMutation({
    mutationFn: async () => {
      const body =
        mode === 'new'
          ? { address: form.getValues() }
          : { service_location_id: selectedLocationId };
      const { data } = await api.patch(`/api/jobs/${jobId}`, body);
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['job', jobId] });
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      // Informational only — the location change already succeeded. Surface the
      // warning and keep the dialog open so the user can read it before closing.
      if (data?.tax_warning) {
        setTaxWarning(data.tax_warning as TaxWarning);
      } else {
        onOpenChange(false);
      }
    },
  });

  // Reset transient state on the OPEN TRANSITION only — not on every render where `open`
  // happens to be true.
  //
  // `currentLocation` is `job.service_location`, and a successful save invalidates
  // ['job', jobId]. The refetch returns the newly-anchored job, so this prop's object
  // identity changes WHILE THE DIALOG IS STILL OPEN. Re-running the reset then would clear
  // `taxWarning` — and since every cross-state move changes the anchor by definition, the
  // server's tax warning would be unreadable in production, exactly when it matters most.
  // The warning is the dispatcher's to dismiss (Done / close), never a refetch's to erase.
  //
  // `mutation.reset()` goes with it: without it a failed save's message is still on screen
  // the next time the dialog is opened, describing an attempt the user has already abandoned.
  const wasOpen = useRef(false);
  const resetMutation = mutation.reset;
  useEffect(() => {
    if (open && !wasOpen.current) {
      setMode('pick');
      setSelectedLocationId(currentLocation?.id ?? null);
      setTaxWarning(null);
      resetMutation();
      form.reset();
    }
    wasOpen.current = open;
  }, [open, currentLocation, form, resetMutation]);

  const handleSubmit = () => {
    if (mode === 'new') {
      form.handleSubmit(() => mutation.mutate())();
    } else {
      mutation.mutate();
    }
  };

  const canSubmit =
    mode === 'new'
      ? true // RHF validation gates the actual mutate()
      : Boolean(selectedLocationId) && selectedLocationId !== currentLocation?.id;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Change Service Location</DialogTitle>
          <DialogDescription>
            Pick another address on this customer or add a new one.
          </DialogDescription>
        </DialogHeader>

        {/* Tax warning (post-save, informational) */}
        {taxWarning && (
          <div className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-surface p-3 text-sm text-warning-text">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-warning-text" />
            <p>
              Service location moved
              {taxWarning.old_state ? ` from ${taxWarning.old_state}` : ''} to {taxWarning.new_state}.
              Tax rate may differ — review the invoice.
            </p>
          </div>
        )}

        {!taxWarning && mode === 'pick' && (
          <div className="space-y-3">
            {locationsLoading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-text-secondary" />
              </div>
            ) : locations.length === 0 ? (
              <p className="text-sm text-text-secondary">
                This customer has no saved locations. Add a new address below.
              </p>
            ) : (
              <div className="divide-y divide-border rounded-lg border border-border">
                {locations.map((loc) => {
                  const isSelected = selectedLocationId === loc.id;
                  return (
                    // Left raw: a list-row selection target with heterogeneous content
                    // (icon + address + conditional checkmark), not Button-shaped.
                    <button
                      key={loc.id}
                      type="button"
                      onClick={() => setSelectedLocationId(loc.id)}
                      className={`w-full flex items-center gap-2 px-3 py-2.5 text-left transition-colors first:rounded-t-lg last:rounded-b-lg ${
                        isSelected ? 'bg-primary/5' : 'hover:bg-background-light'
                      }`}
                    >
                      <MapPin className="h-3.5 w-3.5 text-text-secondary shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {loc.address_line1}, {loc.city}, {loc.state} {loc.zip}
                        </p>
                        {loc.id === currentLocation?.id && (
                          <p className="text-[10px] text-text-secondary">Current</p>
                        )}
                      </div>
                      {isSelected && (
                        <span className="text-primary text-sm shrink-0">&#10003;</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            <Button
              type="button"
              variant="link"
              size={null}
              onClick={() => setMode('new')}
              className="inline-flex items-center gap-1.5"
            >
              <Plus className="h-4 w-4" />
              Add new address
            </Button>
          </div>
        )}

        {!taxWarning && mode === 'new' && (
          <div className="space-y-4">
            <div>
              <Label htmlFor="address_line1">Address *</Label>
              <AddressAutocomplete
                id="address_line1"
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
              {form.formState.errors.address_line1 && (
                <p className="mt-1 text-xs text-danger">{form.formState.errors.address_line1.message}</p>
              )}
            </div>

            <div>
              <Label htmlFor="address_line2">Unit / Suite</Label>
              <Input id="address_line2" {...form.register('address_line2')} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label htmlFor="city">City *</Label>
                <Input id="city" {...form.register('city')} />
                {form.formState.errors.city && (
                  <p className="mt-1 text-xs text-danger">{form.formState.errors.city.message}</p>
                )}
              </div>
              <div>
                <Label htmlFor="state">State *</Label>
                <Input id="state" maxLength={2} {...form.register('state')} />
                {form.formState.errors.state && (
                  <p className="mt-1 text-xs text-danger">{form.formState.errors.state.message}</p>
                )}
              </div>
            </div>

            <div>
              <Label htmlFor="zip">ZIP Code *</Label>
              <Input id="zip" {...form.register('zip')} />
              {form.formState.errors.zip && (
                <p className="mt-1 text-xs text-danger">{form.formState.errors.zip.message}</p>
              )}
            </div>

            <Button type="button" variant="link" size={null} onClick={() => setMode('pick')}>
              Pick an existing address instead
            </Button>
          </div>
        )}

        {mutation.error && (
          <p className="text-sm text-danger">
            {extractApiError(mutation.error, 'Failed to update service location')}
          </p>
        )}

        <div className="flex justify-end gap-3">
          {taxWarning ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={handleSubmit} disabled={mutation.isPending || !canSubmit}>
                {mutation.isPending ? 'Saving...' : 'Save Location'}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
