// SRVW-114 slice 1 — ExtraInfoPanel: generic "Extra Info" card for an entity's
// custom-field values. Only TEXT is exercised (this slice's only shipped type).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { ExtraInfoPanel } from '@/components/custom-fields/ExtraInfoPanel';
import type { CustomFieldDefinition } from '@/lib/api/customFieldDefinitions';

const mockApi = vi.mocked(api);

const JOB_ID = 'j0000000-0000-0000-0000-000000000001';

const CREW_SIZE_DEF: CustomFieldDefinition = {
  id: 'd0000000-0000-0000-0000-000000000001',
  key: 'crew_size',
  label: 'Crew Size',
  type: 'TEXT',
  entity_types: ['JOB'],
  options: [],
  required: false,
  sort_order: 0,
  archived_at: null,
};

const GATE_CODE_DEF: CustomFieldDefinition = {
  id: 'd0000000-0000-0000-0000-000000000002',
  key: 'gate_code',
  label: 'Gate Code',
  type: 'TEXT',
  entity_types: ['JOB'],
  options: [],
  required: false,
  sort_order: 1,
  archived_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ExtraInfoPanel', () => {
  it('renders one input per active definition, pre-filled from the values prop', async () => {
    mockApi.get.mockResolvedValue({
      data: { custom_field_definitions: [CREW_SIZE_DEF, GATE_CODE_DEF] },
    });

    renderWithProviders(
      <ExtraInfoPanel
        entityType="JOB"
        entityId={JOB_ID}
        values={{ [CREW_SIZE_DEF.id]: '3', [GATE_CODE_DEF.id]: '4471' }}
        onSave={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(await screen.findByText('Extra Info')).toBeInTheDocument();
    expect(screen.getByLabelText('Crew Size')).toHaveValue('3');
    expect(screen.getByLabelText('Gate Code')).toHaveValue('4471');
  });

  it('calls onSave with the edited value when Save is clicked', async () => {
    const user = userEvent.setup();
    mockApi.get.mockResolvedValue({
      data: { custom_field_definitions: [CREW_SIZE_DEF] },
    });
    const onSave = vi.fn().mockResolvedValue(undefined);

    renderWithProviders(
      <ExtraInfoPanel
        entityType="JOB"
        entityId={JOB_ID}
        values={{ [CREW_SIZE_DEF.id]: '3' }}
        onSave={onSave}
      />,
    );

    const input = await screen.findByLabelText('Crew Size');
    await user.clear(input);
    await user.type(input, '5');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({ [CREW_SIZE_DEF.id]: '5' });
    });
  });

  it('renders nothing when there are zero active definitions', async () => {
    mockApi.get.mockResolvedValue({ data: { custom_field_definitions: [] } });

    const { container } = renderWithProviders(
      <ExtraInfoPanel entityType="JOB" entityId={JOB_ID} values={{}} onSave={vi.fn()} />,
    );

    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('Extra Info')).not.toBeInTheDocument();
  });
});
