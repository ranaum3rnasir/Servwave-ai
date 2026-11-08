import type { ReactNode } from 'react';

import { Card, CardContent } from '@/ui-kit/components/ui/card';

/**
 * The elevated card Login and AcceptInvite both sit in.
 *
 * The kit's Card owns its own surface, radius and elevation, so the legacy
 * `shadow-xl ring-1 ring-border` is NOT restated here - Card's `shadow-sm` is
 * the kit's answer to the same question, and an appearance override at this
 * call site is exactly what the layering guard exists to stop. Padding rides
 * on CardContent, which is not a ratcheted primitive, so the legacy 32px
 * inset survives intact.
 */
export function AuthCard({ children }: { children: ReactNode }) {
  return (
    <Card>
      <CardContent className="p-8">{children}</CardContent>
    </Card>
  );
}

/**
 * The single error banner both auth pages render above their form. One string,
 * both phases, exactly as the legacy pages: they never stack two errors.
 *
 * `role="alert"` is added, not carried over - neither legacy page announces
 * the message, so a screen-reader user submitted a form and heard nothing.
 * It is additive and changes no visible behaviour.
 */
export function AuthAlert({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="bg-status-red-subtle text-status-red-emphasis mb-4 rounded-lg px-3 py-2 text-sm"
    >
      {children}
    </div>
  );
}

/** The "or" rule between the password form and the Google button. */
export function AuthDivider() {
  return (
    <div className="my-5 flex items-center gap-3">
      <div className="bg-border h-px flex-1" />
      <span className="text-muted-foreground text-xs">or</span>
      <div className="bg-border h-px flex-1" />
    </div>
  );
}
