import { toast } from '@/ui-kit/components/ui/sonner';
import { extractApiError } from '@/lib/utils';

const SAVED_ID = 'lists-saved';

/**
 * Every Lists change saves on its own and says so (spec 6.7): "Saved · detail" with Undo, for 7 seconds. The fixed id
 * makes a new Saved toast replace the previous one. Pressing Undo dismisses it, runs the inverse and says "Change
 * undone"; if the inverse fails (the old name is now taken, say) the server's own message shows in an error toast.
 * Deletes pass no `undo` and get no button.
 */
export function notifySaved(detail: string, undo?: () => Promise<unknown>): void {
  toast(
    <span>
      Saved<span className="font-normal opacity-80"> · {detail}</span>
    </span>,
    {
      id: SAVED_ID,
      duration: 7000,
      // Said outright even with no Undo: the toaster merges these options onto the toast with the same id it replaces,
      // so leaving `action` out would keep the PREVIOUS change's Undo button on a delete (and pressing it would undo that change).
      action: undo
        ? {
            label: 'Undo',
            onClick: () => {
              toast.dismiss(SAVED_ID);
              undo().then(
                () => toast('Change undone'),
                (err: unknown) => toast.error(extractApiError(err, 'Please try again.')),
              );
            },
          }
        : undefined,
    },
  );
}
