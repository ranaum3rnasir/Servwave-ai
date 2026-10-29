import { useSearchParams, useNavigate } from 'react-router-dom';
import { Lock, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { useOrgPlan, catalogEntry, PLAN_LABELS } from '@/lib/entitlements';

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

  // Both unknown (bad deep link) — degrade to generic copy, never render
  // "requires " with a dangling clause.
  const heading =
    featureLabel && requiredLabel
      ? `${featureLabel} requires ${requiredLabel}`
      : 'This feature is not on your plan';

  return (
    <div className="flex min-h-full items-center justify-center bg-background-light p-8">
      <div className="w-full max-w-md rounded-card border border-border bg-surface-light p-8 text-center shadow-card">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
          <Lock className="h-6 w-6 text-primary" />
        </div>
        <Heading level={1} weight="bold" tone="brand" className="mb-2">{heading}</Heading>
        <p className="mb-6 text-sm text-text-secondary">
          Your organization is on the <strong>{currentLabel}</strong> plan.
          {requiredLabel && featureLabel ? (
            <> Upgrade to <strong>{requiredLabel}</strong> to unlock {featureLabel}.</>
          ) : (
            <> Contact us to see what your plan can include.</>
          )}
        </p>
        <div className="flex flex-col gap-2">
          <Button variant="solid" tone="business" className="w-full" asChild>
            <a href="mailto:support@servwave.com?subject=ServWave plan upgrade">
              Contact us to upgrade
            </a>
          </Button>
          {/* navigate('/') not navigate(-1): the page that issued the 402 would
              re-fire it, and the interceptor's hard reload would ping-pong. */}
          <Button variant="outline" className="w-full" onClick={() => navigate('/')}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to dashboard
          </Button>
        </div>
      </div>
    </div>
  );
}
