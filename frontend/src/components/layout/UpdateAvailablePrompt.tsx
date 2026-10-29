import { useEffect, useSyncExternalStore } from 'react';

import { isModalOpen, subscribeModalOpen } from '@/lib/platform/modalOpen';
import { updateController } from '@/lib/platform/registerServiceWorker';
import { toast } from '@/ui-kit/components/ui/sonner';

/** One id, so the prompt is updated in place and can never stack. */
export const UPDATE_PROMPT_TOAST_ID = 'app-update-available';

/**
 * "Update available" (mobile slice 67). Shows while a new version of the app is waiting, on the
 * one toaster, and stays until the user acts or closes it.
 *
 * The Update button asks the update controller to apply the new version; the controller never
 * reloads under unsaved work, so a tap made with a form half-filled is remembered and the
 * prompt says so rather than losing the form.
 *
 * It stays down while a modal (a dialog or sheet) is open. On a phone the toast hangs from the
 * top edge, right over the first field of a form; and the modal makes everything behind it
 * inert, so the prompt could be neither tapped nor closed. It appears the moment the modal
 * closes, and the controller still never reloads under unsaved work in the meantime.
 */
export function UpdateAvailablePrompt() {
  const status = useSyncExternalStore(updateController.subscribe, updateController.getStatus, () => 'idle' as const);

  const modalOpen = useSyncExternalStore(subscribeModalOpen, isModalOpen, () => false);

  useEffect(() => {
    if (status === 'idle' || modalOpen) {
      toast.dismiss(UPDATE_PROMPT_TOAST_ID);
      return;
    }
    if (status === 'available') {
      toast('Update available', {
        id: UPDATE_PROMPT_TOAST_ID,
        description: 'A new version of ServWave is ready.',
        duration: Infinity,
        action: {
          label: 'Update',
          onClick: (event) => {
            // Keep the toast: it turns into the "waiting for your changes" note when needed.
            event.preventDefault();
            updateController.requestApply();
          },
        },
      });
      return;
    }
    toast(status === 'applying' ? 'Updating…' : 'Update available', {
      id: UPDATE_PROMPT_TOAST_ID,
      description:
        status === 'applying'
          ? 'ServWave will reload in a moment.'
          : 'Save or discard your changes and the update will install.',
      duration: Infinity,
      action: undefined,
    });
  }, [status, modalOpen]);

  return null;
}
