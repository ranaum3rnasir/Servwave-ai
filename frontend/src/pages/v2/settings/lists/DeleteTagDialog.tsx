import { useState } from 'react';

import { extractApiError } from '@/lib/utils';
import { ConfirmDialog } from '@/ui-kit/components/ui/confirmDialog';

import { pluralise, type ListItem } from './listDefs';
import { notifySaved } from '@/lib/listSavedToast';

/**
 * "Delete…" on a tag (spec 6.5): says how many records lose the tag and that it cannot be undone. A delete gets the
 * Saved toast with no Undo button.
 */
export function DeleteTagDialog({ item, remove, onClose }: { item: ListItem; remove: (id: string) => Promise<void>; onClose: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const confirm = async () => {
    setPending(true);
    setError('');
    try {
      await remove(item.id);
      notifySaved(`Deleted tag “${item.name}”`);
      onClose();
    } catch (err) {
      setError(extractApiError(err, "Couldn’t delete the tag. Please try again."));
    } finally {
      setPending(false);
    }
  };
  return (
    <ConfirmDialog
      open
      onOpenChange={(next) => !next && onClose()}
      destructive
      title={`Delete “${item.name}”?`}
      description={`This removes the tag from ${pluralise(item.usedCount, 'record')} it is assigned to. This can’t be undone.`}
      confirmLabel="Delete tag"
      isPending={pending}
      onConfirm={() => void confirm()}
    >
      {error && (
        <p role="alert" className="text-danger-text text-sm">
          {error}
        </p>
      )}
    </ConfirmDialog>
  );
}
