import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';

import { DisputeDrawer } from '../components/DisputeDrawer';
import { DISPUTE_ID } from './disputeFixtures';

export const CAN_UPLOAD = buildAbility([{ action: 'create', subject: 'Attachment' }]);

/** Renders the drawer for the fixture dispute and opens step 2. */
export async function openForm({ ability = CAN_UPLOAD, onClose = vi.fn() }: { ability?: ReturnType<typeof buildAbility>; onClose?: () => void } = {}) {
  const u = userEvent.setup();
  const view = renderWithProviders(<DisputeDrawer disputeId={DISPUTE_ID} onClose={onClose} />, { ability });
  await u.click(await screen.findByRole('button', { name: 'Add evidence' }));
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByRole('group', { name: 'Receipt' });
  return { u, dialog, onClose, ...view };
}

export const row = (dialog: HTMLElement, label: string) => within(dialog).getByRole('group', { name: label });
