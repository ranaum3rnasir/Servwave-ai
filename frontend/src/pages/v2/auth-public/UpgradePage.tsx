import { useSearchParams, useNavigate } from 'react-router-dom';
import { Lock, ArrowLeft } from 'lucide-react';

import { ActionLink } from '@/components/ui/action-link';
import { useOrgPlan, catalogEntry, PLAN_LABELS } from '@/lib/entitlements';

import { Button } from '@/ui-kit/components/ui/button';
import { Card, CardContent } from '@/ui-kit/components/ui/card';

/**
 * /v2/upgrade - the CRM-kit rebuild of `pages/UpgradePage.tsx`.
 *
 * Reachable by EVERY authenticated role, technicians included: the 402
 * interceptor is global, so a technician who trips one must be able to land
 * here. That is why the route carries a bare `ProtectedRoute` with no
 * `allowedRoles`, exactly as App.tsx declares it.
 *
 * The plan/feature resolution is imported from `lib/entitlements`, not
 * re-derived: `useOrgPlan`, `catalogEntry` and `PLAN_LABELS` are the same three
 * calls the legacy page makes, in the same order, including the `||` (not `??`)
 * that keeps an empty `required_plan` param from winning over the catalog.
 */
export default function UpgradePage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const currentPlan = useOrgPlan();

  const feature = params.get('feature') ?? '';
  const entry = catalogEntry(feature);
  const featureLabel = entry?.label ?? '';

  // `||` not `??`: params.get() returns null for a missing key but '' for an
  // empty one, and ?? would let '' through. Falls back to the catalog so the
  // route-guard path (which may omit the param) still names a plan.
  const requiredPlan = params.get('required_plan') || entry?.minPlan || '';
  const requiredLabel = PLAN_LABELS[requiredPlan] ?? requiredPlan;
  const currentLabel = PLAN_LABELS[currentPlan] ?? currentPlan;

  // Both unknown (bad deep link) - degrade to generic copy, never render
  // "requires " with a dangling clause.
  const heading =
    featureLabel && requiredLabel
      ? `${featureLabel} requires ${requiredLabel}`
      : 'This feature is not on your plan';

  return (
    <div className="flex min-h-full items-center justify-center p-8">
      <Card className="w-full max-w-md">
        <CardContent className="p-8 text-center">
          <div className="bg-brand-subtle text-brand mx-auto mb-4 flex size-12 items-center justify-center rounded-full">
            <Lock className="size-6" />
          </div>
          <p role="heading" aria-level={1} className="text-brand mb-2 text-xl font-bold">
            {heading}
          </p>
          <p className="text-muted-foreground mb-6 text-sm">
            Your organization is on the <strong>{currentLabel}</strong> plan.
            {requiredLabel && featureLabel ? (
              <>
                {' '}
                Upgrade to <strong>{requiredLabel}</strong> to unlock {featureLabel}.
              </>
            ) : (
              <> Contact us to see what your plan can include.</>
            )}
          </p>
          <div className="flex flex-col gap-2">
            {/* ActionLink rather than a raw <a> (the raw-`<a>` ratchet is at
                its floor and the kit ships no link primitive), and rather than
                `<Button asChild>` (the kit's Button always renders two
                children, so Radix Slot throws on asChild - see the ledger). */}
            <ActionLink
              variant="outline"
              className="w-full justify-center"
              href="mailto:support@servwave.com?subject=ServWave plan upgrade"
            >
              Contact us to upgrade
            </ActionLink>
            {/* navigate('/') not navigate(-1): the page that issued the 402
                would re-fire it, and the interceptor's hard reload would
                ping-pong. */}
            <Button variant="ghost" className="w-full" onClick={() => navigate('/')}>
              <ArrowLeft />
              Back to dashboard
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
