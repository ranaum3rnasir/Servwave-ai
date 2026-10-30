import { useNavigate } from 'react-router-dom';

import { Button } from '@/ui-kit/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/ui-kit/components/ui/dialog';

import { PHONE_TAP_AREA } from '../phoneTap';

/**
 * "Update bank account" for a failed payout (payments go-live P7). Bank details are never typed on the Payments page:
 * this explains why and sends the person to the Payout account page. Nothing is marked resolved by the click; the
 * server resolves the item when a later payout is paid. The payout drawer (P8) reuses this dialog.
 */
export function UpdateBankAccountDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent intent="choice" className={PHONE_TAP_AREA}>
        <DialogHeader>
          <DialogTitle>Update bank account</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm">Bank details are changed on the Payout account page, where they are entered securely.</p>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" className="max-sm:min-h-11" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            type="button"
            className="max-sm:min-h-11"
            onClick={() => {
              onOpenChange(false);
              navigate('/settings/servwave-payments#payout-account');
            }}
          >
            Open payout account
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
