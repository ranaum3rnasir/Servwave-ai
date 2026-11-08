/**
 * ConfirmDialog `tone` - W2/8 rename-schedule gap fix.
 *
 * Program plan section 2a.11 schedules `variant='destructive'` ->
 * `tone="danger"` for this component (3 of 7 real call sites:
 * components/crm/IconRail.tsx:146, pages/PublicEstimatePage.tsx:779,
 * pages/JobDetailPage.tsx:1776). This file pins that `tone` and the
 * deprecated `variant` alias resolve to byte-identical rendered output, so
 * none of those 3 call sites - left untouched, out of scope for this
 * session - regress.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Trash2 } from 'lucide-react';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';

/** The icon-badge div is the sole `.rounded-full` element the dialog renders. */
function iconBadge(): HTMLElement {
  const el = document.body.querySelector('.rounded-full');
  if (!el) throw new Error('icon badge not found');
  return el as HTMLElement;
}

/** Confirm button's own accessible name, distinct from Cancel. */
const confirmButton = () => screen.getByRole('button', { name: 'Delete' });

describe('ConfirmDialog - tone / deprecated variant alias', () => {
  it('tone omitted (and variant omitted) renders the brand icon badge + Confirm button', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete this contact?"
        icon={Trash2}
        confirmLabel="Delete"
        onConfirm={() => {}}
      />
    );
    expect(iconBadge().className).toContain('bg-primary-subtle');
    expect(confirmButton().className).toContain('bg-primary');
    expect(confirmButton().className).not.toContain('bg-danger');
  });

  it('tone="danger" tints the icon badge and Confirm button danger', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete this job?"
        icon={Trash2}
        tone="danger"
        confirmLabel="Delete"
        onConfirm={() => {}}
      />
    );
    expect(iconBadge().className).toContain('bg-danger/10');
    expect(confirmButton().className).toContain('bg-danger');
  });

  it('the deprecated variant="destructive" alias renders byte-identical to tone="danger"', () => {
    const { unmount: unmountTone } = render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete this job?"
        icon={Trash2}
        tone="danger"
        confirmLabel="Delete"
        onConfirm={() => {}}
      />
    );
    const toneBadgeClass = iconBadge().className;
    const toneButtonClass = confirmButton().className;
    unmountTone();

    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete this job?"
        icon={Trash2}
        variant="destructive"
        confirmLabel="Delete"
        onConfirm={() => {}}
      />
    );
    expect(iconBadge().className).toBe(toneBadgeClass);
    expect(confirmButton().className).toBe(toneButtonClass);
  });

  it('tone wins when both tone and the deprecated variant are passed', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Discard unsaved note?"
        icon={Trash2}
        variant="destructive"
        tone="brand"
        confirmLabel="Delete"
        onConfirm={() => {}}
      />
    );
    expect(iconBadge().className).toContain('bg-primary-subtle');
    expect(confirmButton().className).not.toContain('bg-danger');
  });
});
