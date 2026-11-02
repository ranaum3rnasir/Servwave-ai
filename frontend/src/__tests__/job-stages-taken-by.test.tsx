// Roles & Permissions S07.7 - "Taken by..." on the job page's staging section. A person attached to the job records a
// colleague's pickup with Record pickup for someone else alone (the `record_pickup_for_other` ability; no Edit stock, no
// Pick up staged items). Drives the section the job page mounts (components/jobs/JobStagesSection).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility, type AbilityRule } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import type { JobStage } from '@/lib/api/inventory';
import { JobStagesSection } from '@/components/jobs/JobStagesSection';

const mockApi = vi.mocked(api);

// Edit stock needs View stock.
const VIEW_STOCK: AbilityRule = { action: 'read', subject: 'Inventory' };
const EDIT_STOCK: AbilityRule = { action: 'update', subject: 'Inventory' };
const PICK_UP_STAGED: AbilityRule = { action: 'pick_up_staged', subject: 'Inventory' };
const RECORD_FOR_OTHER: AbilityRule = { action: 'record_pickup_for_other', subject: 'Inventory' };

const STAGE_ID = '11111111-2222-4333-8444-555555555555';

function makeStage(over: Partial<JobStage> = {}): JobStage {
  return {
    id: STAGE_ID,
    jobNumber: 'J-1900',
    customer: 'Acme Corp',
    site: '1 Main St',
    trade: 'security',
    status: 'ready_for_pickup',
    items: [
      { id: 'li-1', itemSku: 'CAM-01', itemName: 'Dome Camera', uom: 'EA', qtyOrdered: 2, qtyReceived: 2, vendor: 'N', poNumber: 'P00001', serialized: false },
    ],
    createdAt: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

let stages: JobStage[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  stages = [makeStage()];
  mockApi.get.mockImplementation(((url: string) => {
    if (url === '/api/inventory/job-stages') return Promise.resolve({ data: { jobStages: stages } });
    if (url === `/api/inventory/job-stages/${STAGE_ID}/pickup-people`) {
      return Promise.resolve({ data: { people: [{ id: 'u-tom', name: 'Tom Hill', assigned: true }, { id: 'u-lee', name: 'Lee Park', assigned: false }] } });
    }
    return Promise.resolve({ data: {} });
  }) as typeof mockApi.get);
});

const renderSection = (rules: AbilityRule[]) =>
  renderWithProviders(<JobStagesSection jobId="job-1" />, { ability: buildAbility(rules) });

describe('job page staging section - "Taken by..."', () => {
  it('shows it with Record pickup for someone else alone, and not without the switch', async () => {
    const { unmount } = renderSection([RECORD_FOR_OTHER]);
    expect(await screen.findByRole('button', { name: 'Taken by...' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Taken by me' })).toBeNull();
    unmount();

    renderSection([VIEW_STOCK, EDIT_STOCK, PICK_UP_STAGED]);
    await screen.findByText('Dome Camera');
    expect(screen.queryByRole('button', { name: 'Taken by...' })).toBeNull();
  });

  it('records the chosen person on the server, then reads "Taken by <name>, recorded by <name>" from the refreshed stages', async () => {
    const taken = makeStage({ status: 'delivered', takenAt: '2026-10-09T14:05:00Z', takenById: 'u-tom', takenByName: 'Tom Hill', recordedById: 'u-me', recordedByName: 'Rae Roe' });
    mockApi.post.mockImplementation((() => {
      stages = [taken];
      return Promise.resolve({ data: { jobStage: taken } });
    }) as typeof mockApi.post);
    renderSection([RECORD_FOR_OTHER]);

    await userEvent.click(await screen.findByRole('button', { name: 'Taken by...' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(await within(dialog).findByRole('combobox'));
    await userEvent.click(screen.getByRole('option', { name: /Tom Hill/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record pickup' }));

    expect(mockApi.post).toHaveBeenCalledWith(`/api/inventory/job-stages/${STAGE_ID}/taken-by`, { takenById: 'u-tom' });
    expect(await screen.findByText(/^Taken by Tom Hill, recorded by Rae Roe · /)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Taken by...' })).toBeNull();
  });
});
