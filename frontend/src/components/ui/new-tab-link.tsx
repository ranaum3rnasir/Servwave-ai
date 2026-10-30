import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { ExternalLink } from 'lucide-react';

import { cn } from '@/lib/utils';

import { ActionLink } from './action-link';
import { TextLink } from './link';

/* =============================================================================
   NewTabLink - the one link that opens a page in a new browser tab.

   Built once (payments go-live v7, slice V7-01a) because the app had none: no
   "opens in a new tab" pattern, no screen-reader text, no lint rule. Every such
   link in Settings and on the Payments page uses this, so the announcement, the
   icon and the safety attributes can never drift apart.

   WHAT IT ADDS TO A LINK, always:
     - target="_blank" and rel="noopener noreferrer" (the new tab never gets a
       handle on this one);
     - a lucide ExternalLink icon after the content (12px, 80% opacity, 4px left
       margin), hidden from assistive tech;
     - an sr-only " (opens in a new tab)" so a screen reader says what the icon
       shows;
     - title="Opens in a new tab" for the mouse hover;
     - a REAL href, so middle-click and "copy link" work;
     - a click (and an Enter key) that stops at the link, so it never also
       opens the table row or card row it sits in.

   FOUR LOOKS, built from the kit's own link parts (no hand-rolled anchor):
     text         inline text link (TextLink)
     button       outline button look (ActionLink outline, `sm`)
     chip         pill, 32px high, 44px on phones
     customer-id  12.5px, 600, brand colour, tabular figures (TextLink)
   ============================================================================= */

const newTabLinkVariants = cva('', {
  variants: {
    variant: {
      text: '',
      button: '',
      chip: 'inline-flex h-8 items-center rounded-full border border-border bg-surface-light px-3 text-sm font-medium text-text-primary no-underline hover:bg-primary-subtle max-md:h-11',
      'customer-id': 'inline-flex items-center rounded-sm text-[12.5px] font-semibold tabular-nums text-brand-emphasis max-md:min-h-11',
    },
  },
  defaultVariants: {
    variant: 'text',
  },
});

export interface NewTabLinkProps
  extends Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'target' | 'rel'>,
    VariantProps<typeof newTabLinkVariants> {
  href: string;
}

const NewTabLink = React.forwardRef<HTMLAnchorElement, NewTabLinkProps>(
  ({ variant = 'text', className, children, onClick, onKeyDown, title, ...props }, ref) => {
    const shared = {
      ref,
      target: '_blank',
      rel: 'noopener noreferrer',
      title: title ?? 'Opens in a new tab',
      onClick: (e: React.MouseEvent<HTMLAnchorElement>) => {
        e.stopPropagation();
        onClick?.(e);
      },
      onKeyDown: (e: React.KeyboardEvent<HTMLAnchorElement>) => {
        // Enter activates the link, so it must not also open the row. Every other key (arrows, Tab) still bubbles.
        if (e.key === 'Enter') e.stopPropagation();
        onKeyDown?.(e);
      },
      ...props,
    };
    const content = (
      <>
        {children}
        <ExternalLink aria-hidden="true" className="ml-1 inline-block size-3 shrink-0 align-[-0.125em] opacity-80" />
        <span className="sr-only"> (opens in a new tab)</span>
      </>
    );
    const cls = cn(newTabLinkVariants({ variant }), className);
    if (variant === 'button') {
      return (
        <ActionLink variant="outline" {...shared} className={cls}>
          {content}
        </ActionLink>
      );
    }
    if (variant === 'chip') {
      return (
        <ActionLink variant="link" {...shared} className={cls}>
          {content}
        </ActionLink>
      );
    }
    return (
      <TextLink tone="brand" {...shared} className={cls}>
        {content}
      </TextLink>
    );
  },
);
NewTabLink.displayName = 'NewTabLink';

export { NewTabLink };
