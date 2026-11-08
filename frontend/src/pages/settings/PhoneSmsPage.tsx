import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useOrganization } from '@/lib/api/organization';
import { isPhoneConnected, isSmsReady } from '@/lib/api/phoneConnected';
import { postPhoneOrgAction } from '@/lib/api/phoneOrgActions';
import { useAppAbility } from '@/contexts/AbilityContext';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

/**
 * Settings -> Phone & SMS (master plan §5.6). Mirrors PaymentsListsPage's
 * gating pattern with two additions Payments lacks: a loading skeleton while
 * the org loads and an error row on query failure.
 *
 * The provider is never named or identified here: this page presents the
 * phone service as ServWave's own (see the naming boundary in CLAUDE.md).
 * Provisioning is therefore an ops action, not a self-serve form - an org
 * that isn't set up is pointed at support rather than asked for an account
 * identifier. Disconnect and the readiness refresh stay in the product
 * because they are the customer's own decisions to make.
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
      toast({
        title: data.sms_ready ? 'Text messaging is active' : 'Registration still pending',
        description: data.sms_ready
          ? 'Your business is registered - outgoing texts are enabled.'
          : 'Your registration has not been approved yet. Check again later.',
      });
    },
    onError: (err) =>
      toast({
        variant: 'destructive',
        title: "Couldn't refresh the text messaging status",
        description: extractApiError(err, 'Status check failed - try again.'),
      }),
  });

  const disconnect = useMutation({
    mutationFn: () => postPhoneOrgAction<{ connected: boolean }>('disconnect'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['organization'] });
      setConfirmDisconnect(false);
      toast({ title: 'Phone service turned off' });
    },
    onError: (err) => {
      setConfirmDisconnect(false);
      toast({
        variant: 'destructive',
        title: "Couldn't turn off the phone service",
        description: extractApiError(err, 'Disconnect failed - try again.'),
      });
    },
  });

  // Loading skeleton (§5.6 - an addition over the Payments page).
  if (isLoading) {
    return (
      <div className="grid items-start gap-6 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <Card key={i} className="space-y-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-14 w-full" />
          </Card>
        ))}
      </div>
    );
  }

  // Error row (§5.6 - an addition over the Payments page).
  if (isError || !org) {
    return (
      <Card>
        <p className="text-sm text-danger">
          Couldn&apos;t load the phone &amp; SMS settings - refresh the page to try again.
        </p>
      </Card>
    );
  }

  const phoneActive = isPhoneConnected(org);
  const smsReady = isSmsReady(org);

  return (
    <div className="space-y-6">
      <div className="grid items-start gap-6 lg:grid-cols-2">
        {/* Phone service */}
        <Card className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Phone System</h3>
            <p className="text-xs text-text-secondary">
              Calls and texts run on your ServWave phone service. Numbers are managed under
              Communication &rarr; Phone &rarr; Numbers.
            </p>
          </div>

          {phoneActive ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
              <Badge intent="success">Active</Badge>
              {canManage && (
                <Button
                  variant="solid" tone="danger"
                  size="sm"
                  onClick={() => setConfirmDisconnect(true)}
                  disabled={disconnect.isPending}
                >
                  Turn off
                </Button>
              )}
            </div>
          ) : (
            <p className="text-sm text-text-secondary">
              The phone service isn&apos;t set up for this organization yet - contact support to
              enable it.
            </p>
          )}
        </Card>

        {/* Text messaging readiness */}
        <Card className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Text Messaging</h3>
            <p className="text-xs text-text-secondary">
              Outgoing texts require carrier registration for your business. ServWave handles the
              registration for you.
            </p>
          </div>

          {phoneActive ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
              <div className="flex min-w-0 items-center gap-2">
                <Badge intent={smsReady ? 'success' : 'warning'}>
                  {smsReady ? 'Active' : 'Pending registration'}
                </Badge>
                {!smsReady && (
                  <span className="truncate text-xs text-text-secondary">
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
                  {refreshSmsStatus.isPending ? 'Refreshing…' : 'Refresh status'}
                </Button>
              )}
            </div>
          ) : (
            <p className="text-sm italic text-text-secondary">
              Set up the phone service to enable texting.
            </p>
          )}
        </Card>
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
              variant="solid" tone="danger"
              onClick={() => disconnect.mutate()}
              disabled={disconnect.isPending}
            >
              {disconnect.isPending ? 'Turning off…' : 'Turn off'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
