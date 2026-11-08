/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { FORM_CATALOG } from '@/components/workflows/step-forms.fixture';
import type { DraftStep } from '@/components/workflows/useWorkflowDraft';
import type { WorkflowCatalog } from '@/lib/api/workflows';

import StepConfigDrawer from '../components/stepConfigDrawer';

/**
 * The routed v2 twin of components/workflows/StepConfigDrawer.test.tsx. The
 * in-app step is retired: its authoring form is gone, so opening a legacy step
 * must show a read-only notice rather than a silently empty audience picker.
 */

/** FORM_CATALOG omits `anchors`, which the wait form reads. */
const CATALOG = { ...FORM_CATALOG, anchors: {} } as unknown as WorkflowCatalog;

function openStep(step: DraftStep) {
  renderWithProviders(
    <StepConfigDrawer
      open
      onOpenChange={vi.fn()}
      mode="step"
      step={step}
      triggerType="JOB_SCHEDULED"
      triggerConfig={null}
      stepCount={1}
      catalog={CATALOG}
      onUpdateStepConfig={vi.fn()}
      onSetTrigger={vi.fn()}
      onRemoveStep={vi.fn()}
    />,
  );
}

describe('stepConfigDrawer (v2) - a legacy in-app step', () => {
  it('shows a read-only retired notice instead of an audience picker', () => {
    openStep({ uid: 's1', step_type: 'NOTIFY_TEAM', config: { recipient: 'all_admins', body: 'New job' } });

    expect(
      screen.getByText(/in-app notifications now come from the bell/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/remove it to publish this automation/i)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByLabelText('Message')).toBeNull();
  });

  it('still opens the wait form for a surviving step type', () => {
    openStep({ uid: 's2', step_type: 'WAIT', config: { minutes: 60 } });

    expect(screen.queryByText(/in-app notifications now come from the bell/i)).toBeNull();
  });
});
