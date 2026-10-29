import { Link } from 'react-router-dom';
import { ShieldOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';

/**
 * One page for every route a user can reach by URL but not by permission. ~30 routes have no
 * sub-gate (they are sidebar-hidden and API-403'd), so before this a deep-link or a back-button
 * press landed on a page that rendered and then failed piecemeal.
 */
export default function NotAuthorizedPage() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-ic bg-primary-subtle">
        <ShieldOff className="h-6 w-6 text-primary" />
      </div>
      <div>
        <Heading level={1} scale="lg">You don&rsquo;t have access to this page</Heading>
        <p className="mt-1 text-sm text-text-secondary">
          If you think you should, ask an administrator to update your permissions.
        </p>
      </div>
      <Button asChild>
        <Link to="/">Go back</Link>
      </Button>
    </div>
  );
}
