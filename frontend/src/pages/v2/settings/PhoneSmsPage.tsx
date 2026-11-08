import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useOrganization } from '@/lib/api/organization';
import { isPhoneConnected, isSmsReady } from '@/lib/api/phoneConnected';
import { postPhoneOrgAction } from '@/lib/api/phoneOrgActions';
import { useAppAbility } from '@/contexts/AbilityContext';
import { extractApiError } from '@/lib/utils';

import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Card } from '@/ui-kit/components/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';
import { toast } from '@/ui-kit/components/ui/sonner';

import { Section } from './components/section';

/**
 * Settings > Phone & SMS (master plan 5.6). Connection state is read from the
 * org record; the readiness refresh and disconnect are page-local mutations
 * against /api/organization, admin-only - the same `update Organization`
 * ability that reveals this nav entry.
 *
 * The provider is never named or identified in this page: the phone service is
 * presented as ServWave's own (see the naming boundary in CLAUDE.md). Because
 * the connect step is nothing but a provider account identifier, provisioning
 * is an ops action and an unconfigured org is pointed at support instead of
 * being shown a form. Disconnect and the readiness refresh stay in the product
 * because those are the customer's own decisions.
 *
 * NOTE this tab is NOT `commGated` in the nav (only Caller ID and Email (Gmail)
 * are), and the settings routes carry no RequireFeature at all. That is App.tsx's
 * shape and it is reproduced exactly.
 */
export default function PhoneSmsPage() {
  const { data: org, isLoading, isError } = useOrganization();
  const ability = useAppAbility();
  const canManage = ability.can('update', 'Organization');
  const qc = useQueryClient();

  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const refreshSmsStatus = useMutation({
    mutationFn: () => postPhoneOrgAction<{ sms_ready?: boolean }>('checkTextingApproval'),
    onSuccess: (data: { sms_ready?: boolean }) => {
      qc.invalidateQueries({ queryKey: ['organization'] });
      toast.success(data.sms_ready ? 'Text messaging is active' : 'Registration still pending', {
        description: data.sms_ready
          ? 'Your business is registered - outgoing texts are enabled.'
          : 'Your registration has not been approved yet. Check again later.',
      });
    },
    onError: (err) =>
      toast.error("Couldn't refresh the text messaging status", {
        description: extractApiError(err, 'Status check failed - try again.'),
      }),
  });

  const disconnect = useMutation({
    mutationFn: () => postPhoneOrgAction<{ connected: boolean }>('disconnect'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['organization'] });
      setConfirmDisconnect(false);
      toast.success('Phone service turned off');
    },
    onError: (err) => {
      setConfirmDisconnect(false);
      toast.error("Couldn't turn off the phone service", {
        description: extractApiError(err, 'Disconnect failed - try again.'),
      });
    },
  });

  // Loading skeleton (5.6 - an addition over the Payments page).
  if (isLoading) {
    return (
      <div className="grid items-start gap-6 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <Card key={i}>
            <div className="space-y-3 p-5">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          </Card>
        ))}
      </div>
    );
  }

  // Error row (5.6 - an addition over the Payments page).
  if (isError || !org) {
    return (
      <Section>
        <p className="text-destructive text-sm">
          Couldn&apos;t load the phone &amp; SMS settings - refresh the page to try again.
        </p>
      </Section>
    );
  }

  const phoneActive = isPhoneConnected(org);
  const smsReady = isSmsReady(org);

  return (
    <div className="space-y-6">
      <div className="grid items-start gap-6 lg:grid-cols-2">
        {/* Phone service */}
        <Section
          title="Phone System"
          description="Calls and texts run on your ServWave phone service. Numbers are managed under Communication > Phone > Numbers."
        >
          {phoneActive ? (
            <div className="border-border flex items-center justify-between gap-3 rounded-md border p-3">
              <Badge variant="softGreen" size="pill">Active</Badge>
              {canManage && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setConfirmDisconnect(true)}
                  disabled={disconnect.isPending}
                >
                  Turn off
                </Button>
              )}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              The phone service isn&apos;t set up for this organization yet - contact support to
              enable it.
            </p>
          )}
        </Section>

        {/* Text messaging readiness */}
        <Section
          title="Text Messaging"
          description="Outgoing texts require carrier registration for your business. ServWave handles the registration for you."
        >
          {phoneActive ? (
            <div className="border-border flex items-center justify-between gap-3 rounded-md border p-3">
              <div className="flex min-w-0 items-center gap-2">
                <Badge variant={smsReady ? 'softGreen' : 'softAmber'} size="pill">
                  {smsReady ? 'Active' : 'Pending registration'}
                </Badge>
                {!smsReady && (
                  <span className="text-muted-foreground truncate text-xs">
                    Awaiting carrier approval
                  </span>
                )}
              </div>
              {canManage && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => refreshSmsStatus.mutate()}
                  disabled={refreshSmsStatus.isPending}
                >
                  {refreshSmsStatus.isPending ? 'Refreshing...' : 'Refresh status'}
                </Button>
              )}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm italic">
              Set up the phone service to enable texting.
            </p>
          )}
        </Section>
      </div>

      <Dialog open={confirmDisconnect} onOpenChange={(o) => !o && setConfirmDisconnect(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Turn off the phone service?</DialogTitle>
            <DialogDescription>
              Calls and texts will stop syncing into ServWave. Your numbers and call history are
              kept, and you can turn the service back on at any time.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDisconnect(false)}>
              Keep it on
            </Button>
            <Button
              variant="destructive"
              onClick={() => disconnect.mutate()}
              disabled={disconnect.isPending}
            >
              {disconnect.isPending ? 'Turning off...' : 'Turn off'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
