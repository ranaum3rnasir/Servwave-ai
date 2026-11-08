import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/patterns/FormField';
import { createOrgTaxRate } from '@/lib/api/org-tax-rates';
import { ConfirmRateChangeDialog } from './ConfirmRateChangeDialog';
import { isImplausibleRateChange } from './implausibleRateChange';
import { extractApiError } from '@/lib/utils';

interface AddTaxRateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Called with the new rate as a FRACTION (0.08375 for 8.375%) once it is saved, so the surface
   * that opened this dialog can apply it to the document the user was editing straight away.
   */
  onCreated?: (rate: number) => void;
}

/**
 * "+ Add tax rate" - creates an org tax rate (POST /api/org-tax-rates) from inside a tax-rate
 * dropdown, rather than making the user leave for Settings first. The rate is saved to the
 * organization's list visible, so it shows up in every tax-rate picker from then on (the
 * state-tax-rates endpoint serves the org's visible rates, giving a rate with no state a
 * synthetic `CUSTOM-<id>` code).
 *
 * Name + rate only: an org rate has no "grouped rate" concept here, and no default/agency fields.
 */
export function AddTaxRateDialog({ open, onOpenChange, onCreated }: AddTaxRateDialogProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [pct, setPct] = useState('');
  const [confirming, setConfirming] = useState(false);

  const reset = () => {
    setName('');
    setPct('');
  };

  const pctNum = Number(pct);
  // Number('') is 0, not NaN — an empty field must not read as a valid 0% rate.
  const canSave =
    name.trim().length > 0 &&
    pct.trim() !== '' &&
    !Number.isNaN(pctNum) &&
    pctNum >= 0 &&
    pctNum <= 100;

  const mutation = useMutation({
    mutationFn: () => createOrgTaxRate({ name: name.trim(), rate: pctNum / 100 }),
    onSuccess: (rate) => {
      // Both lists the new rate belongs to: the Settings page's own list, and the visible-rate
      // list every tax-rate picker reads.
      queryClient.invalidateQueries({ queryKey: ['org-tax-rates'] });
      queryClient.invalidateQueries({ queryKey: ['state-tax-rates'] });
      onCreated?.(Number(rate.rate));
      setConfirming(false);
      reset();
      onOpenChange(false);
    },
  });

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      reset();
      setConfirming(false);
    }
    onOpenChange(next);
  };

  // A rate above any real US combined rate gets a second look before it can reach an invoice.
  const save = () => {
    if (isImplausibleRateChange(pctNum)) {
      setConfirming(true);
      return;
    }
    mutation.mutate();
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-md" data-testid="add-tax-rate-dialog">
          <DialogHeader>
            <DialogTitle>Add new tax rate</DialogTitle>
            <DialogDescription>
              Saved to your organization&apos;s tax rates and available in every tax-rate picker.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <FormField label="Name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Hoboken Combined"
                autoFocus
              />
            </FormField>

            <FormField label="Tax rate %">
              <Input
                type="number"
                value={pct}
                onChange={(e) => setPct(e.target.value)}
                placeholder="0.000"
                min={0}
                max={100}
                step={0.001}
              />
            </FormField>

            {mutation.error && (
              <p className="text-sm text-danger">
                {extractApiError(mutation.error, 'Failed to create tax rate')}
              </p>
            )}

            <div className="flex justify-end gap-3">
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button
                data-testid="add-tax-rate-submit"
                onClick={save}
                disabled={!canSave || mutation.isPending}
              >
                {mutation.isPending ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmRateChangeDialog
        open={confirming}
        name={name.trim()}
        nextPct={pctNum}
        onConfirm={() => mutation.mutate()}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
