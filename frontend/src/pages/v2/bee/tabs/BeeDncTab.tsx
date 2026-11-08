import React from 'react';
import { toast } from 'sonner';
import { useBeeStore } from '@/stores/beeStore';
import { type BeeDncItem } from '@/lib/api/bee';
import { ShieldAlert, Plus, Trash2, Search, Loader2 } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui-kit/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Heading } from '@/ui-kit/components/ui/heading';
import { formatPhone, formatPhoneInput, formatSnakeCase } from '@/lib/utils';

export const BeeDncTab: React.FC = () => {
  const { dncList, loadDnc, addDnc, deleteDnc } = useBeeStore();
  const [isOpen, setIsOpen] = React.useState(false);
  const [phoneNumber, setPhoneNumber] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  React.useEffect(() => {
    loadDnc();
  }, [loadDnc]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phoneNumber.trim()) return;
    setIsSubmitting(true);
    try {
      await addDnc(phoneNumber, reason);
      toast.success(`${formatPhone(phoneNumber)} added to DNC registry`);
      setIsOpen(false);
      setPhoneNumber('');
      setReason('');
    } catch (err: any) {
      toast.error(err.response?.data?.error || err.message || 'Failed to add number to DNC registry');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (item: BeeDncItem) => {
    setDeletingId(item.id);
    try {
      await deleteDnc(item.id);
      toast.success(`${formatPhone(item.phone_number)} removed from DNC registry`);
    } catch (err: any) {
      toast.error(err.response?.data?.error || err.message || 'Failed to remove from DNC registry');
    } finally {
      setDeletingId(null);
    }
  };

  const filtered = dncList.filter((item) => {
    const q = search.toLowerCase().trim();
    const phone = item.phone_number.toLowerCase();
    const phoneFormatted = formatPhone(item.phone_number).toLowerCase();
    const phoneDigits = item.phone_number.replace(/\D/g, '');
    const qDigits = q.replace(/\D/g, '');

    const phoneMatch =
      phone.includes(q) ||
      phoneFormatted.includes(q) ||
      (qDigits.length >= 3 && phoneDigits.includes(qDigits));

    return phoneMatch || (item.reason && item.reason.toLowerCase().includes(q));
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <Heading level={3} scale="sm" className="font-bold flex items-center gap-2 text-text-primary">
            <ShieldAlert className="h-4 w-4 text-danger-strong" />
            Do Not Call (DNC) Registry ({dncList.length})
          </Heading>
          <p className="text-xs text-text-secondary mt-0.5">
            Strict compliance list. Any phone number listed here is blocked from outbound calls across all Bee personas.
          </p>
        </div>

        <Button
          size="sm"
          variant="solid"
          tone="danger"
          onClick={() => setIsOpen(true)}
          className="h-8 gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" />
          Add Number to DNC
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-text-secondary" />
          <Input
            placeholder="Search DNC numbers or reasons..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
      </div>

      <div className="border border-border/80 rounded-2xl overflow-hidden bg-surface-light shadow-sm">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Phone Number</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Date Added</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((item) => (
              <TableRow key={item.id}>
                <TableCell><span className="font-mono font-bold text-text-primary text-xs">{formatPhone(item.phone_number)}</span></TableCell>
                <TableCell><span className="text-text-secondary text-xs">{formatSnakeCase(item.reason || 'Requested opt-out')}</span></TableCell>
                <TableCell><span className="text-text-secondary text-xs">{formatSnakeCase(item.source)}</span></TableCell>
                <TableCell>
                  <span className="text-text-secondary text-xs">
                    {new Date(item.created_at).toLocaleDateString([], {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </span>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end">
                    <Button
                      size="icon"
                      variant="ghost"
                      tone="danger"
                      className="h-7 w-7 text-text-muted hover:text-danger hover:bg-danger/10"
                      disabled={deletingId === item.id}
                      onClick={() => handleDelete(item)}
                      title="Remove from DNC registry"
                    >
                      {deletingId === item.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-danger" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}

            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={5}>
                  <div className="text-center py-8 text-text-secondary text-xs">
                    No numbers found in the DNC registry.
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Add Number Dialog */}
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Phone Number to DNC</DialogTitle>
            <DialogDescription>
              Number will be permanently blocked from any Bee outbound calls.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleAdd} className="space-y-3 pt-2">
            <div className="space-y-1">
              <Label>Phone Number</Label>
              <Input
                placeholder="(555) 000-0000"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(formatPhoneInput(e.target.value))}
                required
                className="h-8"
              />
            </div>

            <div className="space-y-1">
              <Label>Reason (Optional)</Label>
              <Input
                placeholder="e.g. Customer requested DNC during call"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="h-8"
              />
            </div>

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setIsOpen(false)} disabled={isSubmitting}>
                Cancel
              </Button>
              <Button type="submit" size="sm" variant="solid" tone="danger" disabled={isSubmitting}>
                {isSubmitting && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                Add to DNC
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
};
