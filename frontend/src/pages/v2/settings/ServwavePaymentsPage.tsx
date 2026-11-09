import { useEffect, useRef, type ReactNode } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';

import NotAuthorizedPage from '@/components/NotAuthorizedPage';
import { PaymentsStatusBody } from '@/components/payments/PaymentsStatusCard';
import { NewTabLink } from '@/components/ui/new-tab-link';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useOrganization, useRefreshStripeStatus, useStripeStatus } from '@/lib/api/shared/organization';
import { useFeature } from '@/lib/entitlements';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';

import { InfoPopover } from '../_shared/infoPopover';
import { Section } from './components/section';
import { PayoutCardBody } from './servwavePayments/PayoutCard';
import { scrollToPayout } from './servwavePayments/scrollToPayout';
import { usePaymentDefaults } from './servwavePayments/usePaymentDefaults';

const STATUS_HELP = 'Whether ServWave Payments is on for your account, and what is needed next.';
const PAYOUT_HELP =
  'Where your customer payments are paid out to. Your bank and identity details are entered in a secure form and never pass through ServWave.';

/**
 * The plan card. It replaces card 1's status when the plan has no online payments. With no payout account it keeps
 * the title "ServWave Payments"; beside an existing account it reads "Your plan" and says the account can still be
 * kept up to date. The upgrade path is a message to ServWave support.
 */
function PlanCardBody({ besideAccount }: { besideAccount: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
      <div className="flex min-w-60 flex-1 flex-col gap-1">
        <p className="text-sm">Online payments aren’t included in your plan.</p>
        {besideAccount && (
          <p className="text-[12.5px] text-text-secondary">
            Customers can’t pay online right now. You can still keep your payout account up to date.
          </p>
        )}
      </div>
      <NewTabLink variant="button" href="mailto:support@servwave.com?subject=ServWave plan upgrade" className="max-sm:min-h-11 max-sm:w-full">
        Contact us to upgrade
      </NewTabLink>
    </div>
  );
}

function PageFrame({ top, canManage, lower }: { top?: ReactNode; canManage: boolean; lower?: ReactNode }) {
  const { data: status, isLoading } = useStripeStatus();
  const { data: org } = useOrganization();
  const inPlan = useFeature('online_payments');

  // Back from the secure setup (the return address carries ?onboarding=return): re-read the account status once,
  // so the cards show what the account can do now, not what was stored.
  const [searchParams, setSearchParams] = useSearchParams();
  const { mutate: refreshStripeStatus } = useRefreshStripeStatus();
  const returnHandled = useRef(false);
  useEffect(() => {
    if (returnHandled.current || searchParams.get('onboarding') !== 'return') return;
    returnHandled.current = true;
    refreshStripeStatus();
    const next = new URLSearchParams(searchParams);
    next.delete('onboarding');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, refreshStripeStatus]);

  // Arriving at #payout-account (the address the old payout page redirects to) scrolls to the card once it exists.
  const { hash } = useLocation();
  const hashHandled = useRef(false);
  const cardReady = Boolean(status);
  useEffect(() => {
    if (hashHandled.current || hash !== '#payout-account' || !cardReady) return;
    hashHandled.current = true;
    scrollToPayout();
  }, [hash, cardReady]);

  const hasAccount = Boolean(status?.connected);
  const goToPayout = canManage ? scrollToPayout : undefined;
  // No plan and no account: the account cannot be opened, so there is nothing to set up here.
  const showPayoutCard = inPlan || hasAccount;

  return (
    <div className="flex flex-col gap-4">
      {top}
      <div id="sec-status">
        <Section
          title={!inPlan && hasAccount ? 'Your plan' : 'ServWave Payments'}
          info={<InfoPopover label="ServWave Payments">{STATUS_HELP}</InfoPopover>}
        >
          {isLoading || !status ? (
            <Skeleton className="h-16 w-full" />
          ) : inPlan ? (
            <PaymentsStatusBody status={status} acceptedMethods={org?.accepted_payment_methods} onGoToPayout={goToPayout} />
          ) : (
            <PlanCardBody besideAccount={hasAccount} />
          )}
        </Section>
      </div>
      {showPayoutCard && (
        <div id="sec-payout">
          <Section
            title="Payout account & verification"
            info={<InfoPopover label="Payout account & verification">{PAYOUT_HELP}</InfoPopover>}
          >
            {isLoading || !status ? <Skeleton className="h-40 w-full" /> : <PayoutCardBody status={status} canManage={canManage} />}
          </Section>
        </div>
      )}
      {lower}
    </div>
  );
}

/** Cards 3 to 7 and their form: mounted only for someone who may change company settings. */
function EditablePage({ canManage }: { canManage: boolean }) {
  const { summary, cards } = usePaymentDefaults();
  return <PageFrame top={summary} canManage={canManage} lower={cards} />;
}

/**
 * Settings > ServWave Payments: seven stacked cards. Cards 1 and 2 (status, payout account) are for whoever may
 * change company settings or manage the payout account; their buttons only for the payout switch. Cards 3 to 7
 * (methods, deposit, tips, bank-transfer instructions, payment terms) are for company settings only, and are what
 * the shell's Save bar saves.
 */
export default function ServwavePaymentsPage() {
  const ability = useAppAbility();
  const canEdit = ability.can('update', 'Organization');
  const canManage = ability.can('manage_payout_account', 'Organization');
  if (!canEdit && !canManage) return <NotAuthorizedPage />;
  return canEdit ? <EditablePage canManage={canManage} /> : <PageFrame canManage={canManage} />;
}
