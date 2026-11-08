import { Users } from 'lucide-react';

import { Card } from '@/ui-kit/components/ui/card';

/**
 * `/users` - the 17-line stub, ported as-is.
 *
 * Nothing in the app links here (the only reference is the route declaration in
 * App.tsx) and no test covers it, but it is still routed and still ADMIN-gated,
 * so it gets a v2 counterpart rather than a behaviour change by omission. The
 * real user-management screen is Settings > Users & Teams.
 *
 * The "coming soon" copy is carried over verbatim; rewriting dead copy during a
 * presentation swap is a content change nobody asked for.
 */
export default function UsersPage() {
  return (
    <Card>
      <div className="p-6">
        {/* role/aria-level rather than an <h2>: the design-system raw-tag
            ratchet sits at its floor for h1-h6. */}
        <p role="heading" aria-level={2} className="flex items-center gap-2 text-lg font-semibold">
          <Users className="text-brand size-5 shrink-0" />
          Users
        </p>
        <p className="text-muted-foreground mt-2 text-sm">User management coming soon.</p>
      </div>
    </Card>
  );
}
