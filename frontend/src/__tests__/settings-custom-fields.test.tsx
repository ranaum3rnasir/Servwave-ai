import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import CustomFieldsPage from '@/pages/settings/CustomFieldsPage';

const mockApi = vi.mocked(api);

// This page saves per-row (like LocationsPage), not via the shared settings
// bar, so the bar itself is irrelevant here - stub it out.
vi.mock('@/pages/settings/SettingsLayout', () => ({
  useSettingsBar: () => ({
    registerSaver: () => {},
  }),
}));

const DEFINITION_FIXTURE = {
  id: 'cf0000000-0000-0000-0000-000000000001',
  key: 'roof_type',
  label: 'Roof Type',
  type: 'TEXT' as const,
  entity_types: ['JOB'] as const,
  options: [],
  required: false,
  sort_order: 0,
  archived_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: { custom_field_definitions: [] } });
});

describe('CustomFieldsPage — list', () => {
  it('renders a list of definitions returned by GET', async () => {
    mockApi.get.mockResolvedValue({ data: { custom_field_definitions: [DEFINITION_FIXTURE] } });
    renderWithProviders(<CustomFieldsPage />);

    expect(await screen.findByText('Roof Type')).toBeInTheDocument();
    expect(screen.getByText('roof_type')).toBeInTheDocument();
    expect(screen.getByText('Job')).toBeInTheDocument();
  });

  it('shows the empty state when there are no definitions', async () => {
    renderWithProviders(<CustomFieldsPage />);
    expect(await screen.findByText('No custom fields defined yet.')).toBeInTheDocument();
  });
});

describe('CustomFieldsPage — create', () => {
  it('posts the derived payload and refetches the list on success', async () => {
    const user = userEvent.setup();
    mockApi.get.mockResolvedValueOnce({ data: { custom_field_definitions: [] } });
    mockApi.post.mockResolvedValue({ data: { ...DEFINITION_FIXTURE, id: 'cf-new', label: 'Roof Type', key: 'roof_type' } });

    renderWithProviders(<CustomFieldsPage />);
    await screen.findByText('No custom fields defined yet.');

    await user.click(screen.getByRole('button', { name: '+ New Field' }));
    await user.type(screen.getByRole('textbox'), 'Roof Type!!');
    await user.click(screen.getByRole('checkbox', { name: 'Jobs' }));

    // The list refetches after create - the next GET resolves with the new row,
    // proving the form was wired to invalidate rather than silently no-op.
    mockApi.get.mockResolvedValueOnce({
      data: { custom_field_definitions: [{ ...DEFINITION_FIXTURE, id: 'cf-new' }] },
    });

    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(mockApi.post).toHaveBeenCalledTimes(1);
    const [url, payload] = mockApi.post.mock.calls[0];
    expect(url).toBe('/api/custom-field-definitions');
    expect(payload).toEqual({
      key: 'roof_type',
      label: 'Roof Type!!',
      type: 'TEXT',
      entity_types: ['JOB'],
    });

    expect(await screen.findByText('Roof Type')).toBeInTheDocument();
    // Create form closes on success.
    expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument();
  });

  // SRVW-114 slice 3 - the defect this closes: the form used to offer all four entity types
  // while only Job rendered anywhere, so ticking Price Book Items saved a field that surfaced
  // nowhere, with no error and no empty state. An option only exists once its surface does.
  it('offers only the entity types that actually render a field', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CustomFieldsPage />);
    await screen.findByText('No custom fields defined yet.');

    await user.click(screen.getByRole('button', { name: '+ New Field' }));

    expect(screen.getByRole('checkbox', { name: 'Leads' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Jobs' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Customers' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Price Book Items' })).not.toBeInTheDocument();
  });

  it('surfaces an API error on create instead of silently swallowing it', async () => {
    const user = userEvent.setup();
    mockApi.post.mockRejectedValue({
      response: { data: { error: 'Key already exists' } },
    });

    renderWithProviders(<CustomFieldsPage />);
    await screen.findByText('No custom fields defined yet.');

    await user.click(screen.getByRole('button', { name: '+ New Field' }));
    await user.type(screen.getByRole('textbox'), 'Roof Type');
    await user.click(screen.getByRole('checkbox', { name: 'Jobs' }));
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('Key already exists')).toBeInTheDocument();
    // The form must stay open so the admin can fix and retry.
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
  });
});

// SRVW-114 slice 3 - there is no delete path by design (archive-only, slice 6), so editing is
// the only way to correct a definition that was scoped to the wrong entity.
describe('CustomFieldsPage - edit', () => {
  it('prefills from the row and PATCHes only the label and entity scope', async () => {
    const user = userEvent.setup();
    mockApi.get.mockResolvedValue({ data: { custom_field_definitions: [DEFINITION_FIXTURE] } });
    mockApi.patch.mockResolvedValue({ data: { custom_field_definition: DEFINITION_FIXTURE } });

    renderWithProviders(<CustomFieldsPage />);
    await screen.findByText('Roof Type');

    await user.click(screen.getByRole('button', { name: 'Edit Roof Type' }));

    // Prefilled from the stored row, not blank.
    expect(screen.getByRole('textbox')).toHaveValue('Roof Type');
    expect(screen.getByRole('checkbox', { name: 'Jobs' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Leads' })).not.toBeChecked();

    await user.click(screen.getByRole('checkbox', { name: 'Leads' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(mockApi.patch).toHaveBeenCalledTimes(1);
    const [url, payload] = mockApi.patch.mock.calls[0];
    expect(url).toBe(`/api/custom-field-definitions/${DEFINITION_FIXTURE.id}`);
    expect(payload).toEqual({ label: 'Roof Type', entity_types: ['JOB', 'LEAD'] });
    // `key` and `type` are fixed at creation - a relabel must never rename or reinterpret
    // a field that already holds values.
    expect(payload).not.toHaveProperty('key');
    expect(payload).not.toHaveProperty('type');
  });

  it('never posts when editing - a wrong verb here would create a duplicate key, not an edit', async () => {
    const user = userEvent.setup();
    mockApi.get.mockResolvedValue({ data: { custom_field_definitions: [DEFINITION_FIXTURE] } });
    mockApi.patch.mockResolvedValue({ data: { custom_field_definition: DEFINITION_FIXTURE } });

    renderWithProviders(<CustomFieldsPage />);
    await screen.findByText('Roof Type');

    await user.click(screen.getByRole('button', { name: 'Edit Roof Type' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(mockApi.post).not.toHaveBeenCalled();
  });
});
