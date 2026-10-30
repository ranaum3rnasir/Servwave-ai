import { useEffect } from 'react';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { Button } from '@/ui-kit/components/ui/button';

import { PaymentsDrawerHost } from '../components/PaymentsDrawerHost';
import { PaymentsDrawerProvider, useDrawerHost } from '../drawerHost';
import { DISPUTE_ID } from './disputeFixtures';

export const CAN_UPLOAD = buildAbility([{ action: 'create', subject: 'Attachment' }]);

/** Calls `onClose` when the drawer's stack empties (the host removed `d`), the way the old drawer's prop did. */
function ClosedProbe({ onClose }: { onClose: () => void }) {
  const { stack } = useDrawerHost();
  const empty = stack.length === 0;
  useEffect(() => { if (empty) onClose(); }, [empty, onClose]);
  return null;
}

/** Test-only buttons that close and open the drawer from outside, the way the page does when an action finishes. */
function StageControls() {
  const host = useDrawerHost();
  return (
    <>
      <Button type="button" onClick={host.closeNow}>stage-close</Button>
      <Button type="button" onClick={() => host.open([{ kind: 'dispute', id: DISPUTE_ID }])}>stage-open</Button>
    </>
  );
}

/** The host on the page address for the fixture dispute (or closed when `open` is false). */
export function DisputeStage({ onClose = () => {} }: { onClose?: () => void }) {
  return (
    <PaymentsDrawerProvider>
      <PaymentsDrawerHost />
      <ClosedProbe onClose={onClose} />
      <StageControls />
    </PaymentsDrawerProvider>
  );
}
export const DISPUTE_URL = `/payments?d=dispute:${DISPUTE_ID}`;

/** Renders the drawer for the fixture dispute, reads it, then presses Respond to open the form view. */
export async function openForm({ ability = CAN_UPLOAD, onClose = vi.fn() }: { ability?: ReturnType<typeof buildAbility>; onClose?: () => void } = {}) {
  const u = userEvent.setup();
  const view = renderWithProviders(<DisputeStage onClose={onClose} />, { ability, initialEntries: [DISPUTE_URL] });
  await u.click(await screen.findByRole('button', { name: 'Respond' }));
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByRole('group', { name: 'Receipt' });
  return { u, dialog, onClose, ...view };
}

export const row = (dialog: HTMLElement, label: string) => within(dialog).getByRole('group', { name: label });
