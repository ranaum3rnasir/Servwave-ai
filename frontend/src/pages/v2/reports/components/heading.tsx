import type { ReactNode } from 'react';

import { cn } from '@/ui-kit/lib/utils';

/**
 * A section title inside a report page.
 *
 * SUPERSEDED: the kit now ships `ui-kit/components/ui/heading`, with the same
 * `level` + `scale` axes and the same rungs. This stays until the reports
 * pages are ported to it, which is a call-site sweep, not a kit change.
 *
 * The kit shipped no Heading. `layout/pageHeader` titles a PAGE and nothing else,
 * and the design-system raw-tag ratchet for `<h1>`-`<h6>` is at its floor, so a
 * v2 page may not open a real heading tag either. Every rebuilt module so far
 * has landed on the same answer - `role="heading"` with an explicit
 * `aria-level` on a div - and this is Reports' copy of it. See the gap ledger;
 * "Heading" is the second-most-requested BUILD item in the roll-up.
 *
 * `level` is the aria level, `scale` the type size, exactly the two axes the
 * legacy `components/ui/heading` exposed, so a call site ports by changing one
 * import.
 */
export interface ReportHeadingProps {
  level?: 1 | 2 | 3 | 4;
  scale?: 'sm' | 'base' | 'lg' | 'xl' | '2xl';
  className?: string;
  children: ReactNode;
}

const SCALE: Record<NonNullable<ReportHeadingProps['scale']>, string> = {
  sm: 'text-[13px] font-semibold tracking-[-0.01em]',
  base: 'text-[14.5px] font-semibold tracking-[-0.015em]',
  lg: 'text-[16px] font-bold tracking-[-0.02em]',
  xl: 'text-[19px] font-bold tracking-[-0.026em]',
  '2xl': 'text-[23px] font-bold tracking-[-0.032em]',
};

export function ReportHeading({ level = 2, scale = 'base', className, children }: ReportHeadingProps) {
  return (
    <div role="heading" aria-level={level} className={cn(SCALE[scale], className)}>
      {children}
    </div>
  );
}
