import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import StopIfForm from './StopIfForm';
import { FORM_CATALOG } from './step-forms.fixture';

describe('StopIfForm — conditions are scoped to the trigger entity', () => {
  it('an invoice trigger offers the condition picker', () => {
    renderWithProviders(
      <StopIfForm config={{}} triggerType="INVOICE_PAID" catalog={FORM_CATALOG} onChange={vi.fn()} />,
    );
    expect(screen.getByText('Stop this automation if…')).toBeInTheDocument();
    expect(screen.queryByText(/Stop conditions aren’t available/)).toBeNull();
  });

  it('a job trigger also offers the picker (entity-scoped, not empty)', () => {
    renderWithProviders(
      <StopIfForm config={{}} triggerType="JOB_SCHEDULED" catalog={FORM_CATALOG} onChange={vi.fn()} />,
    );
    expect(screen.getByText('Stop this automation if…')).toBeInTheDocument();
  });

  it('a lead trigger has no conditions → the empty-state note, no picker', () => {
    renderWithProviders(
      <StopIfForm config={{}} triggerType="LEAD_CREATED" catalog={FORM_CATALOG} onChange={vi.fn()} />,
    );
    expect(screen.getByText(/Stop conditions aren’t available for this trigger/)).toBeInTheDocument();
    expect(screen.queryByText('Stop this automation if…')).toBeNull();
  });
});
