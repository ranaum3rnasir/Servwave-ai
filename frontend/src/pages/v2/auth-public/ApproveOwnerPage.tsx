import { useEffect, useLayoutEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { approveOwner, previewOwnerApproval, type OwnerApproval } from '@/lib/api/ownerApproval';
import { useAuthStore } from '@/stores/auth.store';
import { extractApiError } from '@/lib/utils';

import { Button } from '@/ui-kit/components/ui/button';

import { AuthAlert, AuthCard } from './components/authPanel';
import { BrandLockup } from './components/brandLockup';

/** The same words the server answers every dead link with. */
export const OWNER_LINK_EXPIRED_MESSAGE = 'This approval link has expired or has already been used. Nothing was changed.';
const NO_TOKEN_MESSAGE = 'Open the approval link from your email again.';

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; approval: OwnerApproval }
  | { kind: 'done'; approval: OwnerApproval }
  | { kind: 'dead'; message: string };

/**
 * /approve-owner?token=... - the Owner approves handing the company to another Admin (ticket 27, D1). The link was emailed to
 * the current Owner when they pressed Make Owner; nothing has changed yet.
 *
 * Like the reset page, the token is a live one-time credential, so the page reads it once, strips the query string before the
 * first paint, sends it only in POST bodies, and sets no-referrer while open (error reporting scrubs `token` from URLs).
 *
 * Opening the page changes nothing: it shows who becomes the Owner of which company, and ownership moves on "Approve", once.
 * A dead link (expired, used, replaced) says so plainly.
 */
export default function ApproveOwnerPage() {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [token] = useState(() => searchParams.get('token') ?? '');
  const [phase, setPhase] = useState<Phase>(() => (token ? { kind: 'loading' } : { kind: 'dead', message: NO_TOKEN_MESSAGE }));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const signedIn = useAuthStore((s) => s.isAuthenticated);
  const checkAuth = useAuthStore((s) => s.checkAuth);

  useLayoutEffect(() => {
    if (window.location.search) {
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.hash);
    }
  }, []);
  const hasQuery = location.search !== '';
  useEffect(() => {
    if (hasQuery) navigate({ pathname: location.pathname, hash: location.hash }, { replace: true });
  }, [hasQuery, location.pathname, location.hash, navigate]);

  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);

  useEffect(() => {
    if (!token) return;
    let live = true;
    previewOwnerApproval(token)
      .then((approval) => live && setPhase({ kind: 'ready', approval }))
      .catch((err) => live && setPhase({ kind: 'dead', message: extractApiError(err, OWNER_LINK_EXPIRED_MESSAGE) }));
    return () => {
      live = false;
    };
  }, [token]);

  const onApprove = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const approval = await approveOwner(token);
      setPhase({ kind: 'done', approval });
      // A session open in this browser learns who the Owner is now.
      if (signedIn) void checkAuth?.();
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      const message = extractApiError(err, "We couldn't complete the hand-over. Nothing was changed. Try again.");
      // A dead link, or a person who can no longer become the Owner: nothing more to do on this page.
      if (status === 400 || status === 409) setPhase({ kind: 'dead', message });
      else setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="pad-safe bg-kit-background h-dvh overflow-y-auto overscroll-contain">
      <div className="flex min-h-full items-center justify-center px-6 py-6">
        <div className="w-full max-w-sm">
          <AuthCard>
            <BrandLockup className="mb-6" />
            {phase.kind === 'loading' && <p className="text-muted-foreground text-sm">Checking your link…</p>}

            {phase.kind === 'dead' && (
              <div className="text-center">
                <p role="alert" className="text-destructive mb-4 text-sm">{phase.message}</p>
                <Button type="button" onClick={() => navigate('/', { replace: true })}>
                  Go to ServWave
                </Button>
              </div>
            )}

            {phase.kind === 'ready' && (
              <>
                <p role="heading" aria-level={2} className="mb-2 text-lg font-semibold">
                  Approve the new Owner
                </p>
                <p className="text-muted-foreground mb-4 text-sm">
                  Make {phase.approval.new_owner_name} the Owner of {phase.approval.company_name}? You stay an Admin.
                </p>
                {error && <AuthAlert>{error}</AuthAlert>}
                <Button type="button" className="w-full" disabled={submitting} onClick={() => void onApprove()}>
                  {submitting ? 'Approving…' : 'Approve'}
                </Button>
              </>
            )}

            {phase.kind === 'done' && (
              <div className="text-center">
                <p role="heading" aria-level={2} className="mb-2 text-lg font-semibold">
                  Ownership moved
                </p>
                <p className="text-muted-foreground mb-4 text-sm">
                  {phase.approval.new_owner_name} is now the Owner of {phase.approval.company_name}. You&rsquo;re still an Admin.
                </p>
                <Button type="button" onClick={() => navigate('/', { replace: true })}>
                  Go to ServWave
                </Button>
              </div>
            )}
          </AuthCard>
        </div>
      </div>
    </div>
  );
}
