import { useNavigate } from 'react-router-dom';
import { ShieldOff } from 'lucide-react';

import { Button } from '@/ui-kit/components/ui/button';

/**
 * The v2 "you can reach this URL but not this page" surface.
 *
 * NOT WIRED TO `ProtectedRoute`, and that is the one thing to know about this
 * file. `components/ProtectedRoute.tsx` renders
 * `components/NotAuthorizedPage` in place of `<Outlet/>`, so a v2 route that
 * fails its role check still renders the legacy-styled surface inside the v2
 * shell. Pointing the guard here instead would change what every legacy route
 * renders too, so it stays a cutover decision. Until then this is routed at
 * `/v2/not-authorized` so it is reviewable and ready.
 */
export default function NotAuthorizedPage() {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
      <div className="bg-brand-subtle text-brand flex size-12 items-center justify-center rounded-xl">
        <ShieldOff className="size-6" />
      </div>
      <div>
        <p role="heading" aria-level={1} className="text-lg font-semibold">
          You don&rsquo;t have access to this page
        </p>
        <p className="text-muted-foreground mt-1 text-sm">
          If you think you should, ask an administrator to update your permissions.
        </p>
      </div>
      {/* `/`, the app root, which is where the shell's own brand mark points too.
          A click handler rather than `<Button asChild><Link>`: the kit's Button
          always renders TWO children (a loading slot plus the children), so
          Radix Slot throws "Expected a single React element child" the moment
          asChild is used. See the ledger - it is a kit defect, and two
          already-merged customers-module sites hit it too. */}
      <Button onClick={() => navigate('/')}>Go back</Button>
    </div>
  );
}
