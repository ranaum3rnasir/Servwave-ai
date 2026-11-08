import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface SectionCardProps {
  /** Card title shown in the header band. */
  title: ReactNode;
  /** Rendered before the title in the band (e.g. an AI sparkle badge). */
  icon?: ReactNode;
  /** Inline, immediately after the title (counts like "(2)", "(Internal)"). */
  titleSuffix?: ReactNode;
  /** Right-aligned header slot (pills, action buttons, a collapse chevron). */
  meta?: ReactNode;
  /** 'ai' uses the lavender wash + tinted band reserved for AI surfaces. */
  tone?: 'default' | 'ai';
  className?: string;
  headerClassName?: string;
  titleClassName?: string;
  bodyClassName?: string;
  /** Omit to render just the header band (e.g. a collapsed AI card). */
  children?: ReactNode;
}

/**
 * Standard Job Command Center card: a tinted, bordered header band over a white
 * body. The band gives every card title a clear "header" read instead of text
 * floating above content. `overflow-hidden` keeps the band inside the 18px
 * rounded corners. Use `tone="ai"` for AI-themed cards (lavender band).
 */
export function SectionCard({
  title,
  icon,
  titleSuffix,
  meta,
  tone = 'default',
  className,
  headerClassName,
  titleClassName,
  bodyClassName,
  children,
}: SectionCardProps) {
  const isAi = tone === 'ai';
  return (
    <div
      className={cn(
        'overflow-hidden rounded-card shadow-card',
        isAi
          ? 'border border-ai-600/20 bg-gradient-to-b from-surface-light to-ai-600/[0.035]'
          : 'border border-border bg-surface-light',
        className,
      )}
    >
      <div
        className={cn(
          'flex items-center gap-2 border-b px-5 py-3',
          // Header band reads the --card-header token (tokens.css) — a faint tint
          // distinct from both the white body and the grey canvas, NOT the page
          // canvas. Retune the band for every card in tokens.css; for a minimal
          // white header on one card pass headerClassName="bg-surface-light". AI keeps its wash.
          isAi ? 'border-ai-600/15 bg-ai-50' : 'border-border bg-card-header',
          headerClassName,
        )}
      >
        {/* Accent bar — echoes the sidebar selection treatment, gives the header identity. */}
        <span
          aria-hidden="true"
          className={cn('h-4 w-1 shrink-0 rounded-full', isAi ? 'bg-ai-600' : 'bg-primary')}
        />
        {icon}
        {/* single-site odd tone value (text-ai-600) with no clean Heading tone match, plus a
            caller-forwarded titleClassName override - left raw */}
        <h3 className={cn('text-sm font-semibold', isAi ? 'text-ai-600' : 'text-text-primary', titleClassName)}>
          {title}
          {titleSuffix}
        </h3>
        {meta && <div className="ml-auto flex items-center gap-2">{meta}</div>}
      </div>
      {children != null && <div className={cn('p-5', bodyClassName)}>{children}</div>}
    </div>
  );
}

/**
 * In-card sub-section header: an uppercase label bound to a trailing hairline
 * rule so it reads unmistakably as "a new section starts here" (vs. an orphaned
 * label floating between groups). Optional `action` sits after the rule.
 */
export function SectionLabel({
  children,
  action,
  className,
}: {
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-3 flex items-center gap-3', className)}>
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-widest text-text-secondary">
        {children}
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      {action}
    </div>
  );
}
