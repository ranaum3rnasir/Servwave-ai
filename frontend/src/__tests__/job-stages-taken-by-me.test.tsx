// Roles & Permissions S07.6 - "Taken by me" on the job page's staging section. A person attached to the job takes a
// stage with Pick up staged items alone (the `pick_up_staged` ability; no Edit stock); a taken stage reads "Taken by
// <name>" and the time. Drives the section the job page mounts (components/jobs/JobStagesSection).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility, type AbilityRule } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import type { JobStage } from '@/lib/api/inventory';
import { JobStagesSection } from '@/components/jobs/JobStagesSection';

const mockApi = vi.mocked(api);

const EDIT_STOCK: AbilityRule = { action: 'update', subject: 'Inventory' };
// Edit stock needs View stock.
const VIEW_STOCK: AbilityRule = { action: 'read', subject: 'Inventory' };
const PICK_UP_STAGED: AbilityRule = { action: 'pick_up_staged', subject: 'Inventory' };

function makeStage(over: Partial<JobStage> = {}): JobStage {
  return {
    id: '11111111-2222-4333-8444-555555555555',
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
  mockApi.get.mockImplementation(((url: string) =>
    url === '/api/inventory/job-stages' ? Promise.resolve({ data: { jobStages: stages } }) : Promise.resolve({ data: {} })) as typeof mockApi.get);
});

const renderSection = (rules: AbilityRule[]) =>
  renderWithProviders(<JobStagesSection jobId="job-1" />, { ability: buildAbility(rules) });

describe('job page staging section - "Taken by me"', () => {
  it('shows it with Pick up staged items and no Edit stock, and not without the switch', async () => {
    const { unmount } = renderSection([PICK_UP_STAGED]);
    expect(await screen.findByRole('button', { name: 'Taken by me' })).toBeInTheDocument();
    unmount();

    renderSection([EDIT_STOCK, VIEW_STOCK]);
    await screen.findByText('Dome Camera');
    expect(screen.queryByRole('button', { name: /^Taken by/ })).toBeNull();
  });

  it('saves on the server, then reads "Taken by <name>" and the time from the refreshed stages', async () => {
    const taken = makeStage({ status: 'delivered', takenAt: '2026-10-09T14:05:00Z', takenById: 'u-1', takenByName: 'Tom Hill', recordedById: 'u-1', recordedByName: 'Tom Hill' });
    mockApi.post.mockImplementation((() => {
      stages = [taken];
      return Promise.resolve({ data: { jobStage: taken } });
    }) as typeof mockApi.post);
    renderSection([PICK_UP_STAGED]);

    await userEvent.click(await screen.findByRole('button', { name: 'Taken by me' }));

    expect(mockApi.post).toHaveBeenCalledWith('/api/inventory/job-stages/11111111-2222-4333-8444-555555555555/taken-by-me');
    expect(await screen.findByText(/^Taken by Tom Hill · /)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Taken by me' })).toBeNull();
  });

  it('shows a taken stage to a person with no pickup switch', async () => {
    stages = [makeStage({ status: 'delivered', takenAt: '2026-10-09T14:05:00Z', takenById: 'u-1', takenByName: 'Tom Hill', recordedById: 'u-2', recordedByName: 'Lee Park' })];
    renderSection([]);

    expect(await screen.findByText(/^Taken by Tom Hill, recorded by Lee Park · /)).toBeInTheDocument();
  });
});
