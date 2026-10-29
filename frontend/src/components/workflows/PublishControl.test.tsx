import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import PublishControl, { blockedReason, type PublishControlProps } from './PublishControl';
import type { ValidationIssue } from '@/lib/api/workflows';

function props(overrides: Partial<PublishControlProps> = {}): PublishControlProps {
  return {
    status: 'DRAFT',
    hasUnpublishedChanges: false,
    dirty: false,
    issues: [],
    isEnabled: false,
    onPublish: vi.fn(),
    onToggleEnabled: vi.fn(),
    ...overrides,
  };
}

const TWO_ISSUES: ValidationIssue[] = [
  { step_index: 0, path: 'duration_minutes', message: 'Set a wait time' },
  { step_index: 1, path: 'body', message: 'Add a message' },
];

describe('blockedReason', () => {
  it('counts distinct steps that need setup', () => {
    expect(blockedReason(TWO_ISSUES)).toBe('Fix 2 steps that need setup');
    expect(blockedReason([{ step_index: 0, path: 'x', message: 'y' }])).toBe('Fix 1 step that needs setup');
  });
  it('falls back to a workflow-level message when no steps are flagged', () => {
    expect(blockedReason([{ step_index: -1, path: 'steps', message: 'Add at least one step' }])).toBe(
      'Add at least one step',
    );
  });
});

describe('PublishControl — the 4 states', () => {
  it('state 1 — DRAFT + issues: Publish is disabled and explains why', () => {
    renderWithProviders(<PublishControl {...props({ status: 'DRAFT', issues: TWO_ISSUES })} />);
    const publish = screen.getByRole('button', { name: /publish/i });
    expect(publish).toBeDisabled();
    expect(screen.getByLabelText('Fix 2 steps that need setup')).toBeInTheDocument();
  });

  it('state 2 — DRAFT + valid: Publish is enabled and calls the mutation', () => {
    const onPublish = vi.fn();
    renderWithProviders(<PublishControl {...props({ status: 'DRAFT', issues: [], onPublish })} />);
    const publish = screen.getByRole('button', { name: /publish/i });
    expect(publish).toBeEnabled();
    fireEvent.click(publish);
    expect(onPublish).toHaveBeenCalledTimes(1);
  });

  it('state 3 — PUBLISHED + up to date: shows the Live pill + an enabled Switch, no Publish button', () => {
    const onToggleEnabled = vi.fn();
    renderWithProviders(
      <PublishControl
        {...props({ status: 'PUBLISHED', isEnabled: true, hasUnpublishedChanges: false, dirty: false, onToggleEnabled })}
      />,
    );
    expect(screen.getByText('Live · up to date')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /publish/i })).toBeNull();
    const toggle = screen.getByRole('switch');
    expect(toggle).toBeEnabled();
    fireEvent.click(toggle);
    expect(onToggleEnabled).toHaveBeenCalledWith(false);
  });

  it('state 4 — PUBLISHED + pending edits: shows "Publish changes" + the editing-draft pill', () => {
    const onPublish = vi.fn();
    renderWithProviders(
      <PublishControl
        {...props({ status: 'PUBLISHED', isEnabled: true, hasUnpublishedChanges: true, issues: [], onPublish })}
      />,
    );
    expect(screen.getByText('Live · editing draft')).toBeInTheDocument();
    const publish = screen.getByRole('button', { name: /publish changes/i });
    expect(publish).toBeEnabled();
    fireEvent.click(publish);
    expect(onPublish).toHaveBeenCalledTimes(1);
  });
});
