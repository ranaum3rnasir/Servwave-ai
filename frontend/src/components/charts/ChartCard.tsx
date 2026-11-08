/* =============================================================================
   ServWave Charts — ChartCard
   Shared wrapper for every chart primitive. White surface, 6px radius,
   system card shadow, optional header (title + subtitle + 6px select control).
   NO pill selects, no raw hex — everything reads from tokens / utility classes.
   ============================================================================= */

import * as React from 'react';
import { SelectField } from '@/components/form/SelectField';
import { Heading } from '@/components/ui/heading';
import { cn } from '@/lib/utils';

/** A single option for the optional header dropdown control. */
export interface ChartCardSelectOption {
  label: string;
  value: string;
}

export interface ChartCardSelectProps {
  /** Controlled value of the select. */
  value: string;
  /** Options rendered in the dropdown. */
  options: ChartCardSelectOption[];
  /** Change handler — receives the raw option value. */
  onChange: (value: string) => void;
  /** Accessible label for the control. */
  'aria-label'?: string;
}

export interface ChartCardProps {
  /** Card heading (omit for a chrome-less chart container). */
  title?: React.ReactNode;
  /** Secondary muted line under the title. */
  subtitle?: React.ReactNode;
  /** Optional right-aligned select control (6px radius, never a pill). */
  select?: ChartCardSelectProps;
  /** Arbitrary right-aligned header content (overrides `select` when both set). */
  action?: React.ReactNode;
  /** Remove the inner padding (charts that need to bleed to the edge). */
  flush?: boolean;
  className?: string;
  /** Body content — typically a chart primitive. */
  children: React.ReactNode;
}

/** Minimal 6px-radius select used in chart headers. */
function ChartCardSelect({ value, options, onChange, ...rest }: ChartCardSelectProps) {
  return (
    <SelectField
      value={value}
      onValueChange={onChange}
      aria-label={rest['aria-label']}
      className={cn(
        'px-2.5 py-1.5',
        'text-xs font-medium text-text-primary',
        'focus:ring-2 focus:ring-primary/30',
      )}
      options={options}
    />
  );
}

export function ChartCard({
  title,
  subtitle,
  select,
  action,
  flush = false,
  className,
  children,
}: ChartCardProps) {
  const hasHeader = title != null || subtitle != null || action != null || select != null;

  return (
    <div
      className={cn(
        'flex flex-col bg-surface-light rounded-card border border-border shadow-card',
        flush ? 'p-0' : 'p-6',
        className,
      )}
    >
      {hasHeader && (
        <div className={cn('flex items-start justify-between gap-4', flush && 'p-6 pb-0')}>
          <div className="min-w-0">
            {title != null && (
              <Heading level={3} weight="bold" className="truncate">{title}</Heading>
            )}
            {subtitle != null && (
              <p className="mt-0.5 text-xs text-text-secondary">{subtitle}</p>
            )}
          </div>
          {action ?? (select ? <ChartCardSelect {...select} /> : null)}
        </div>
      )}
      <div className={cn('min-w-0', hasHeader && !flush && 'mt-4', flush && 'p-6 pt-4')}>
        {children}
      </div>
    </div>
  );
}

export default ChartCard;
