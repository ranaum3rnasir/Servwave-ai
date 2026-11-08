import { useState } from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import { GripVertical } from 'lucide-react';

import NotAuthorizedPage from '@/components/NotAuthorizedPage';
import { useAppAbility } from '@/contexts/AbilityContext';

import {
  useLostReasonOptions,
  useCreateLostReasonOption,
  useUpdateLostReasonOption,
  useReorderLostReasonOptions,
  type LostReasonOption,
} from '@/lib/api/lostReasonOptions';

import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Input } from '@/ui-kit/components/ui/input';
import { Switch } from '@/ui-kit/components/ui/switch';
import { cn } from '@/ui-kit/lib/utils';

import { Section } from './components/section';

/** Longest label the server will accept - mirrored so the field stops the keystroke, not the save. */
const LABEL_MAX = 60;

/**
 * The one reason that cannot be switched off (decision D5), mirrored from the server's
 * `UNDEACTIVATABLE_LOST_REASON_CODE`. Mirrored rather than fetched: the row has to render as
 * un-switchable on FIRST paint, and a flag arriving with the list would still leave the toggle
 * live for the instant before it did. The server refuses the write either way, so a drift here
 * costs a toast, never a lost escape hatch.
 */
const UNDEACTIVATABLE_CODE = 'OTHER';

/**
 * Settings > Estimate Decline Reasons.
 *
 * Sits with Job Sub-Statuses and Tax Rates in ADVANCED, because it is the same
 * kind of thing both are: a per-organisation list of words the product then offers
 * somewhere else. It is its own tab rather than a section of Payments & Lists for the same
 * reason those two are - that page's lists are string arrays on the organisation row saved
 * through the settings save bar, and this one is a table with codes, an active flag and an order
 * the admin owns, saved a row at a time.
 *
 * EVERY ROW SAVES IMMEDIATELY, through its own request, so this page does NOT register with the
 * settings save bar. That matches Job Sub-Statuses and differs from Payments & Lists; the two
 * shapes are both already in this shell.
 *
 * BOTH PICKERS READ THIS LIST NOW (slice C). The staff decline dialog resolves it from the same
 * authenticated route this screen uses; the public estimate page, which has no session, resolves
 * it from its own token-scoped route (decision D6). That is why the intro copy below can finally
 * say WHERE these words show up - it promised only a manageable list while the answer was
 * "nowhere", and a settings screen that cannot say what it changes is one an admin has to guess
 * at.
 *
 * THIS PAGE GATES ITSELF, because nothing above it does. `/settings/*` carries no route-level
 * guard - every authenticated user can deep-link to any settings tab - and SettingsLayout filters
 * only the NAV LIST, so hiding the nav row (which its `update Organization` pair already does)
 * stops a non-admin CLICKING here and not a non-admin TYPING the URL. Without the gate below a
 * SALES user who typed `/settings/decline-reasons` got the real list - the GET is the coarser
 * `read Estimate`, deliberately, because slice C needs a rep declining their own estimate to read
 * these words - wrapped in rename fields, toggles, drag handles and an Add button that every one
 * of them 403s. An editable-looking screen where nothing can be edited is worse than no screen.
 *
 * Gated on the pair the four WRITES are gated on, not on `role === 'ADMIN'`: a custom role that
 * has been given `update Organization` manages this list exactly as the built-in admin does, and
 * a role check would lock that role out of a page the API lets it write. The gate is a wrapper
 * rather than a branch inside the body so a refused user fires no request at all.
 */
export default function DeclineReasonsPage() {
  const ability = useAppAbility();
  if (!ability.can('update', 'Organization')) return <NotAuthorizedPage />;
  return <DeclineReasonsSettings />;
}

function DeclineReasonsSettings() {
  const { data } = useLostReasonOptions();
  const reasons = data ?? [];
  const [draft, setDraft] = useState('');
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const createReason = useCreateLostReasonOption();
  const reorderReasons = useReorderLostReasonOptions();

  const add = () => {
    const label = draft.trim();
    if (!label) return;
    createReason.mutate({ label });
    setDraft('');
  };

  // Same id-list reorder as JobSubStatusesPage, keyed by `code` rather than by a row id: an
  // organisation that has never saved has no ids at all (its list is still the built-ins), and
  // the code is unique per organisation anyway.
  const handleDrop = (srcCode: string, targetCode: string) => {
    const from = reasons.findIndex((r) => r.code === srcCode);
    const to = reasons.findIndex((r) => r.code === targetCode);
    if (from === -1 || to === -1 || from === to) return;
    const ordered = arrayMove(reasons.map((r) => r.code), from, to);
    reorderReasons.mutate({ ordered_codes: ordered });
  };

  const activeCount = reasons.filter((r) => r.is_active).length;

  return (
    <div className="space-y-5">
      {/* No page-level heading: the settings bar above already reads "Estimate Decline Reasons",
          and every sibling settings page leads with its intro copy alone. */}
      <p className="text-muted-foreground max-w-prose text-sm">
        Choose the reasons an estimate can be declined for. These are the choices your team picks
        from when they record a loss, and the ones a customer is offered if they decline an
        estimate you sent them. Rename the ones ServWave ships with, add your own, and drag them
        into the order you want them offered in. Switching one off stops it being offered from
        then on and leaves every estimate already declined for it reading exactly as it does
        today.
      </p>

      <Section
        title="Decline reasons"
        description="Drag to reorder. Switch one off to retire it without losing the estimates that used it."
        action={
          reasons.length > 0 ? (
            <span className="text-muted-foreground text-xs tabular-nums">
              {activeCount} of {reasons.length} offered
            </span>
          ) : undefined
        }
      >
        <div className="space-y-1">
          {reasons.map((reason) => (
            <div
              key={reason.code}
              draggable
              onDragStart={(e) => {
                setDragging(reason.code);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', reason.code);
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              onDragOver={(e) => {
                if (dragging && dragging !== reason.code) {
                  e.preventDefault();
                  setOver(reason.code);
                }
              }}
              onDragLeave={() => setOver((c) => (c === reason.code ? null : c))}
              onDrop={(e) => {
                e.preventDefault();
                const src = e.dataTransfer.getData('text/plain') || dragging;
                if (src && src !== reason.code) handleDrop(src, reason.code);
                setDragging(null);
                setOver(null);
              }}
              className={cn(
                'group/row -mx-1.5 flex items-center gap-1.5 rounded-md px-1.5 py-0.5',
                'transition-colors duration-150',
                dragging === reason.code && 'opacity-40',
                over === reason.code ? 'ring-brand/50 bg-selected ring-2' : 'hover:bg-muted/60',
              )}
            >
              {/* Always present, gaining contrast on hover - revealing it from nothing would
                  leave the row with no affordance at rest and shift the input sideways the
                  moment the pointer arrived. */}
              <GripVertical
                aria-hidden
                className={cn(
                  'size-4 shrink-0 cursor-grab transition-colors duration-150 active:cursor-grabbing',
                  'text-border group-hover/row:text-muted-foreground',
                )}
              />
              <ReasonRow reason={reason} />
            </div>
          ))}
        </div>

        <div className="flex gap-2 border-t pt-3">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
            aria-label="New decline reason"
            placeholder="New reason (press Enter or Add)"
            className="flex-1"
            maxLength={LABEL_MAX}
          />
          <Button type="button" size="sm" onClick={add} disabled={!draft.trim()}>
            Add
          </Button>
        </div>
      </Section>
    </div>
  );
}

/** One renameable, switchable row. Local draft so a rename commits on blur/Enter, not per keystroke. */
function ReasonRow({ reason }: { reason: LostReasonOption }) {
  const [label, setLabel] = useState(reason.label);
  const updateReason = useUpdateLostReasonOption();

  const commit = () => {
    const next = label.trim();
    if (!next || next === reason.label) {
      setLabel(reason.label);
      return;
    }
    updateReason.mutate({ code: reason.code, label: next });
  };

  const locked = reason.code === UNDEACTIVATABLE_CODE;

  return (
    <>
      {/* A rename field drawn flat, taking a visible border only on hover/focus - the same
          treatment the job sub-status rows use, and for the same reason: a column of bordered
          inputs is a wall of boxes when the text is the content. */}
      <Input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
        aria-label={`Rename ${reason.label}`}
        className={cn(
          'h-8 flex-1 border-transparent bg-transparent hover:border-border focus:bg-kit-card',
          // A retired reason reads as retired without being hidden - an admin has to be able to
          // find it in order to switch it back on.
          !reason.is_active && 'text-muted-foreground line-through',
        )}
        maxLength={LABEL_MAX}
      />

      {reason.is_builtin && (
        <Badge variant="softNeutral" size="sm" className="shrink-0">
          Built-in
        </Badge>
      )}

      {/* There is no Remove button anywhere on this page, for any row. A declined estimate stores
          the reason's CODE and the conversion report groups on it, so deleting one would turn
          readable history into an orphan string; switching it off retires it and keeps that
          history intact. */}
      <Switch
        checked={reason.is_active}
        disabled={locked}
        onCheckedChange={(next) => updateReason.mutate({ code: reason.code, is_active: next })}
        aria-label={
          locked
            ? `${reason.label} is always offered`
            : `Offer ${reason.label} when an estimate is declined`
        }
        className="ml-1 shrink-0"
      />
    </>
  );
}
