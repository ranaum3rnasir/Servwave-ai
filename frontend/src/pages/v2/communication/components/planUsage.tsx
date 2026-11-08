import { useState } from 'react';
import {
  AlertTriangle, ChevronDown, Mail, MessageSquare, PhoneCall, Send,
} from 'lucide-react';

import { useCommUsage } from '@/lib/api/communication';
import { SALES_CONTACT_EMAIL, useSendSalesRequest, salesRequestErrorMessage } from '@/lib/api/support';

import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui-kit/components/ui/popover';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';
import { Textarea } from '@/ui-kit/components/ui/textarea';
import { cn } from '@/ui-kit/lib/utils';

/**
 * The Phone header's plan-usage box and its upgrade panel.
 *
 * Lifted out of the page for the same reason it is a separate section in the
 * legacy file - it is ~270 lines of its own state - and carried across
 * verbatim: the same thresholds, the same copy, the same toasts, and the same
 * fact that NOTHING here persists. `applyUpgrade` re-bases local state and
 * toasts; there is no mutation behind it, and inventing one would be a
 * behaviour change.
 *
 * The meter bar stays a plain element rather than the kit `Progress`. Its fill
 * colour is the whole signal - green under 75%, amber at 75, red at 90 - and
 * `Progress` paints one brand colour with no way in. Substituting it would
 * silently drop the warning.
 *
 * Rendered for every org. It was demo-only while the usage numbers were
 * prototype seeds; they are now the org's own real calls and messages, so the
 * gate would have hidden a true meter from exactly the orgs it is for.
 *
 * Loading holds the control's own space; an error still renders nothing. The
 * original rule - no placeholder may read as a genuine 0% - is what the
 * skeleton respects rather than breaks: it shows no bar, no number and no
 * percentage. What it stops is the control contributing zero width until the
 * request lands and then appearing at full size, which shoved the Dialer button
 * sideways on every cold load and read as the meter being slow. An error keeps
 * returning null because there is no figure coming and nothing to hold space
 * for.
 */

/** Bar colour by how close to the plan limit you are. */
function usageTone(pct: number): { bar: string; text: string } {
  if (pct >= 90) return { bar: 'bg-status-red', text: 'text-status-red-emphasis' };
  if (pct >= 75) return { bar: 'bg-status-amber', text: 'text-status-amber-emphasis' };
  return { bar: 'bg-status-green', text: 'text-status-green-emphasis' };
}

function PlanUsageMeter({
  icon: Icon, label, used, limit, unit, className,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  used: number;
  /** null = the org is uncapped; there is nothing to be a percentage of. */
  limit: number | null;
  unit: string;
  className?: string;
}) {
  const pct = limit == null ? null : Math.min(100, Math.round((used / limit) * 100));
  const tone = usageTone(pct ?? 0);
  return (
    <div className={cn('min-w-[160px]', className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide">
          <Icon className="size-3" />
          {label}
        </span>
        {pct == null ? (
          <span className="text-muted-foreground text-[11px] font-semibold">No limit</span>
        ) : (
          <span className={cn('text-[11px] font-bold', tone.text)}>{pct}%</span>
        )}
      </div>
      {pct != null && (
        <div className="bg-muted mt-1 h-1.5 w-full overflow-hidden rounded-full">
          <div className={cn('h-full rounded-full transition-all', tone.bar)} style={{ width: `${pct}%` }} />
        </div>
      )}
      <p className="text-muted-foreground mt-0.5 text-[10px]">
        {limit == null
          ? `${used.toLocaleString()} ${unit} this cycle`
          : `${used.toLocaleString()} / ${limit.toLocaleString()} ${unit}`}
      </p>
    </div>
  );
}

// Display label only - the server owns the real recipient. See lib/api/support.ts.
const SALES_EMAIL = SALES_CONTACT_EMAIL;

/**
 * The control's footprint while the figures are in flight.
 *
 * Built from the trigger's own `Button` and the meter's own element structure
 * rather than from a measured height, so the placeholder and the loaded control
 * are laid out by the same rules and cannot drift apart when either is
 * restyled. The two text rows carry an explicit line box because their content
 * is a `Skeleton` block rather than text, and a block has no line-height of its
 * own to inherit from the button.
 */
function PlanUsageSkeleton() {
  // The two text rows carry an explicit line box because their content is a
  // Skeleton block, and a block brings no line-height of its own. The heights
  // are the loaded meter's own measured rows - 16.5px is the `text-[11px]`
  // percentage's line box, 15px the `text-[10px]` caption's - which is what
  // makes the placeholder and the real control the same 57.5px tall.
  const column = (
    <div className="min-w-[160px]">
      {/* "CALLING" + "66%" */}
      <div className="flex h-[16.5px] items-center justify-between gap-2">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-7" />
      </div>
      {/* the bar, at the height the real one occupies */}
      <Skeleton className="mt-1 h-1.5 w-full rounded-full" />
      {/* "66 / 100 min" */}
      <div className="mt-0.5 flex h-[15px] items-center">
        <Skeleton className="h-3 w-24" />
      </div>
    </div>
  );

  return (
    // Inert rather than `disabled`: a disabled Button paints the muted
    // background, so the frame would change colour the moment the figures
    // arrive - trading the old sideways jump for a flash. tabIndex -1 plus
    // aria-hidden keep it out of the tab order and off the screen reader, which
    // is the same silence the previous render-nothing branch gave.
    <div className="relative hidden lg:block" aria-hidden>
      <Button
        variant="outline"
        tabIndex={-1}
        className="pointer-events-none h-auto items-center gap-4 px-3 py-1.5"
      >
        {column}
        <span className="bg-border h-9 w-px" />
        {column}
        <ChevronDown className="shrink-0" />
      </Button>
    </div>
  );
}

export function PlanUsage({
  onToast, branch,
}: {
  onToast: (m: string) => void;
  branch: string;
}) {
  const [open, setOpen] = useState(false);
  const [salesOpen, setSalesOpen] = useState(false);
  const { data: usage, isError } = useCommUsage();

  // No meter beats a wrong meter. A failed request has no figure coming, so it
  // renders nothing at all; one still in flight holds its place. The error
  // branch is tested FIRST because `usage` is undefined in both cases, and the
  // other order would leave a failed request pulsing forever.
  if (isError) return null;
  if (!usage) return <PlanUsageSkeleton />;

  // An uncapped org has no limit to approach, so it never carries a status -
  // dividing by a null limit would yield Infinity and pin "limit reached" onto
  // exactly the orgs that are exempt from limits.
  const pctOf = (used: number, limit: number | null) =>
    limit == null ? null : Math.min(100, Math.round((used / limit) * 100));
  const pcts = [
    pctOf(usage.calling.used, usage.calling.limit),
    pctOf(usage.texting.used, usage.texting.limit),
  ].filter((p): p is number => p != null);

  const worst = pcts.length ? Math.max(...pcts) : 0;
  const status: 'reached' | 'near' | 'ok' = worst >= 100 ? 'reached' : worst >= 75 ? 'near' : 'ok';

  return (
    <div className="relative hidden lg:block">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            aria-expanded={open}
            aria-label="Phone plan usage and upgrade options"
            className="h-auto items-center gap-4 px-3 py-1.5"
          >
            <PlanUsageMeter
              icon={PhoneCall}
              label="Calling"
              used={usage.calling.used}
              limit={usage.calling.limit}
              unit={usage.calling.unit}
            />
            <span className="bg-border h-9 w-px" />
            <PlanUsageMeter
              icon={MessageSquare}
              label="Texting"
              used={usage.texting.used}
              limit={usage.texting.limit}
              unit={usage.texting.unit}
            />
            <ChevronDown className={cn('shrink-0 transition', open && 'rotate-180')} />
          </Button>
        </PopoverTrigger>

        <PopoverContent align="end" className="w-[340px] overflow-hidden p-0">
          <div className="flex items-start justify-between gap-2 border-b px-4 py-3">
            <div>
              <p className="text-sm font-bold">Phone plan usage</p>
              <p className="text-muted-foreground text-[12px]">
                {usage.uncapped ? 'Unlimited plan' : 'Included with your plan'} · {usage.cycleLabel}
              </p>
            </div>
            {status === 'reached' && (
              <Badge variant="softRed" size="pill">
                Limit reached
              </Badge>
            )}
            {status === 'near' && (
              <Badge variant="softAmber" size="pill">
                Approaching limit
              </Badge>
            )}
          </div>

          <div className="space-y-4 px-4 py-4">
            {status !== 'ok' && (
              <div
                className={cn(
                  'flex items-start gap-2 rounded-lg px-3 py-2.5 text-[12px] leading-snug',
                  status === 'reached'
                    ? 'bg-status-red-subtle text-status-red-emphasis'
                    : 'bg-status-amber-subtle text-status-amber-emphasis',
                )}
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>
                  {status === 'reached'
                    ? "You've used everything included this cycle. Your allowance resets at the start of next month - talk to us if you need more."
                    : "You're close to your included allowance for this cycle."}
                </span>
              </div>
            )}

            <div className="space-y-3">
              <PlanUsageMeter
                icon={PhoneCall}
                label="Calling"
                used={usage.calling.used}
                limit={usage.calling.limit}
                unit={usage.calling.unit}
                className="w-full"
              />
              <PlanUsageMeter
                icon={MessageSquare}
                label="Texting"
                used={usage.texting.used}
                limit={usage.texting.limit}
                unit={usage.texting.unit}
                className="w-full"
              />
            </div>

            {/* Only the uncapped note remains. The capped blurb that used to sit
                here explained the metering rules and had gone stale - it told
                the owner that "calls that never connect don't count", which
                stopped being true in #1555 when the allowance moved onto CTM's
                connected clock. A rang-and-hung-up call is billed by CTM and
                now counts here too. */}
            {usage.uncapped && (
              <p className="text-muted-foreground text-[11px] leading-snug">
                This account has no calling or texting limit. The figures above are what you have
                actually used this cycle.
              </p>
            )}

            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                setOpen(false);
                setSalesOpen(true);
              }}
            >
              <Mail />
              Reach sales
            </Button>
            <p className="text-muted-foreground text-center text-[11px]">Sales: {SALES_EMAIL}</p>
          </div>
        </PopoverContent>
      </Popover>

      {salesOpen && (
        <ReachSalesDialog
          branch={branch}
          onClose={() => setSalesOpen(false)}
          onToast={onToast}
        />
      )}
    </div>
  );
}

/** "Reach sales" composer - a subject, five preset topics, and the question the
 *  owner writes before sending.
 *
 *  It asks for nothing else. The To and From rows are gone: both were addresses
 *  the sender could neither usefully change nor needed to see. The server owns
 *  both ends - it delivers to the ServWave inbox and sets reply-to from the
 *  signed-in account - so showing them invited edits that were ignored.
 *
 *  The send is real: it POSTs to /api/support/sales-request. It used to toast a
 *  success and drop the message on the floor. The dialog stays open on failure
 *  so the text the owner just wrote is not lost. */
import { ReachSalesDialog } from '@/components/support/ReachSalesDialog';
