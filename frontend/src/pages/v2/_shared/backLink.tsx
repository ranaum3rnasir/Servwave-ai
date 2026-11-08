import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

import { Button } from '@/ui-kit/components/ui/button';

interface BackLinkProps {
  /** Where "back" goes. Omit to pop one entry off the history stack instead. */
  to?: string;
  onClick?: () => void;
  /** Defaults to a bare "Back"; name the destination when the page has one. */
  children?: React.ReactNode;
}

/**
 * The one "back" control every v2 page uses, so all of them are the same
 * control in the same place.
 *
 * It renders into `PageHeader`'s `back` slot - top left, above the title -
 * rather than into `actions`. Before this existed the form pages put Back in
 * the ACTIONS column: it came out looking like a page action, sat at the far
 * right edge opposite the direction it moves you, and on the edit pages it
 * landed next to Save, which is a bad neighbour for a control that discards
 * where you are. The reports shell had already settled on the top-left form;
 * this is that shape, named once.
 *
 * `variant="link"` not `ghost`: a back link is navigation, and the kit paints
 * navigation as text. A filled or bordered cell up here competes with the page
 * title sitting directly beneath it.
 */
export function BackLink({ to, onClick, children = 'Back' }: BackLinkProps) {
  if (to) {
    return (
      <Button asChild variant="link" size="sm">
        <Link to={to}>
          <ArrowLeft />
          {children}
        </Link>
      </Button>
    );
  }
  return (
    <Button variant="link" size="sm" onClick={onClick}>
      <ArrowLeft />
      {children}
    </Button>
  );
}
