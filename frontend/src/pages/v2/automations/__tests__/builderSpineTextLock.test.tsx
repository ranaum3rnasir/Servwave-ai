/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import type { WorkflowDraftState } from '@/components/workflows/useWorkflowDraft';
import type { AutomationTriggerType, WorkflowCatalog } from '@/lib/api/workflows';

import BuilderSpine from '../components/builderSpine';

/**
 * The step picker's lock, at the surface that computes it.
 *
 * Spec B locked SEND_TEXT on a task workflow because a text could only reach the customer and
 * a task has none - the step was offered only to be refused at save. Spec C slice 1 widened
 * the channel to every audience an email reaches, and workflowValidation.ts's own note hands
 * this off explicitly: "The frontend still locks the step for task triggers (featureFlags.ts);
 * that lock is the builder slice's to lift."
 *
 * What must NOT change is the per-ORG lock, which is a different fact: an org that has not
 * connected texting still sees the step greyed, badged and tooltipped exactly as before.
 */

function catalogFor(entity: string, sms_available: boolean): WorkflowCatalog {
  return {
    triggers: { TASK_ASSIGNED: { entity }, JOB_SCHEDULED: { entity: 'job' } },
    capabilities: { sms_available },
  } as unknown as WorkflowCatalog;
}

function draftFor(trigger_type: AutomationTriggerType): WorkflowDraftState {
  return {
    name: 'Untitled automation',
    trigger_type,
    trigger_config: null,
    triggerConfigured: false,
    steps: [],
    selectedUid: null,
    dirty: false,
    revision: 0,
    lastSavedAt: null,
    server: { id: undefined, status: 'DRAFT', is_enabled: false, has_unpublished_changes: false, issues: [] },
  } as unknown as WorkflowDraftState;
}

function renderSpine(catalog: WorkflowCatalog, trigger: AutomationTriggerType = 'TASK_ASSIGNED') {
  const onAddStep = vi.fn();
  renderWithProviders(
    <BuilderSpine
      draft={draftFor(trigger)}
      catalog={catalog}
      issuesByStepIndex={new Map()}
      onSelectTrigger={vi.fn()}
      onSelectStep={vi.fn()}
      onAddStep={onAddStep}
      onMoveStep={vi.fn()}
      onRemoveStep={vi.fn()}
    />,
  );
  return { onAddStep };
}

async function openPicker() {
  await userEvent.click(screen.getByRole('button', { name: 'Add your first step' }));
  return screen.findByRole('menu', { name: 'Add a step' });
}

describe('builderSpine - a task workflow can now text its people', () => {
  it('offers the text step on a task trigger when the org can text', async () => {
    const { onAddStep } = renderSpine(catalogFor('task', true));
    const menu = await openPicker();

    const row = within(menu).getByText('Send text').closest('[role="menuitem"]');
    expect(row).not.toBeNull();
    expect(row).not.toHaveAttribute('aria-disabled');
    expect(within(menu).queryByText('Not for tasks')).toBeNull();

    await userEvent.click(within(menu).getByText('Send text'));
    expect(onAddStep).toHaveBeenCalledWith('SEND_TEXT', 0);
  });
});

describe('builderSpine - the not-connected lock is unchanged', () => {
  it.each(['task', 'job'] as const)('still locks the text step on a %s trigger when the org cannot text', async (entity) => {
    const trigger = entity === 'task' ? 'TASK_ASSIGNED' : 'JOB_SCHEDULED';
    const { onAddStep } = renderSpine(catalogFor(entity, false), trigger as AutomationTriggerType);
    const menu = await openPicker();

    const row = within(menu).getByText('Send text').closest('[role="menuitem"]') as HTMLElement;
    expect(row).toHaveAttribute('aria-disabled', 'true');
    expect(within(row).getByText('Not connected')).toBeInTheDocument();

    await userEvent.click(row);
    expect(onAddStep).not.toHaveBeenCalled();
  });
});
