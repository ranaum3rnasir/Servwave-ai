import { Layers } from 'lucide-react';

import { VendorCategoryManager } from '@/components/inventory/VendorCategoryManager';
import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogIcon, DialogTitle,
} from '@/ui-kit/components/ui/dialog';

/**
 * The Vendors screen's host for the vendor category manager - the same
 * component the vendor form's picker opens inline from "Manage categories…".
 * Opened by the screen's three "Add category" entries (header button, empty
 * By Category tab, category filter), so it lands focused on the new-name box.
 */
export function VendorCategoryDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogIcon tone="brand"><Layers /></DialogIcon>
          <DialogTitle>Vendor categories</DialogTitle>
          <DialogDescription>
            Group vendors by what you buy from them. Every vendor form and filter uses this list.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="text-xs">
          <VendorCategoryManager autoFocusAdd />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
