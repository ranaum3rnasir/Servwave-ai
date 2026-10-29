/**
 * Toast `tone` - W2/8 rename-schedule gap fix.
 *
 * Program plan section 2a.11 schedules `variant="destructive"` -> `tone=
 * "danger"` for this file (marked "primitive-internal" - see toast.tsx's own
 * header note for why the ~100 real `toast({ variant: 'destructive' })`
 * call sites across src/ are unaffected). This file pins that `tone="danger"`
 * resolves to the exact same class string `variant="destructive"` always
 * has, so ToastAction / ToastClose's `group-[.destructive]:` compound
 * selectors - which depend on the literal `destructive` class surviving in
 * the rendered output - keep working under either spelling.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Toast, ToastProvider, ToastTitle, ToastViewport, toastVariants } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

function renderedClass(props: Record<string, unknown> = {}): string {
  cleanup();
  render(
    <ToastProvider>
      <Toast data-testid="toast" {...props}>
        <ToastTitle>Hello</ToastTitle>
      </Toast>
      <ToastViewport />
    </ToastProvider>
  );
  return screen.getByTestId('toast').className;
}

describe('Toast - tone / variant', () => {
  it('propless renders the default cell, unmoved', () => {
    expect(renderedClass()).toBe(cn(toastVariants({ variant: 'default' })));
  });

  it('variant="destructive" still renders the destructive cell, including the literal "destructive" class', () => {
    const cls = renderedClass({ variant: 'destructive' });
    expect(cls).toBe(cn(toastVariants({ variant: 'destructive' })));
    expect(cls.split(/\s+/)).toContain('destructive');
  });

  it('tone="danger" renders byte-identical to variant="destructive"', () => {
    expect(renderedClass({ tone: 'danger' })).toBe(renderedClass({ variant: 'destructive' }));
  });

  it('tone="danger" wins when variant="default" is also passed', () => {
    const cls = renderedClass({ variant: 'default', tone: 'danger' });
    expect(cls).toBe(cn(toastVariants({ variant: 'destructive' })));
  });

  it('tone never reaches the DOM', () => {
    render(
      <ToastProvider>
        <Toast data-testid="toast" tone="danger">
          <ToastTitle>Hello</ToastTitle>
        </Toast>
        <ToastViewport />
      </ToastProvider>
    );
    expect(screen.getByTestId('toast').getAttribute('tone')).toBeNull();
  });
});
