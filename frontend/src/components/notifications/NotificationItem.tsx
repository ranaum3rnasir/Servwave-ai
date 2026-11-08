import React, { useState } from 'react';
import {
  Briefcase,
  Wrench,
  DollarSign,
  Package,
  Phone,
  Clock,
  Shield,
  UserPlus,
  ListChecks,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { NotificationView } from '@/lib/api/notifications';
import { useMarkRead, useMarkActed } from '@/lib/api/notifications';
import { useToast } from '@/components/ui/use-toast';
import { ACTION_HANDLERS } from './inlineActions';

// ---------------------------------------------------------------------------
// Category → color map
// ---------------------------------------------------------------------------

/**
 * Category tile fills, as complete `rgb()` strings.
 *
 * Two things to keep in mind before editing this map:
 *  1. Tokens are stored as SPACE-SEPARATED RGB CHANNELS (`--primary: 12 45 58`),
 *     so a bare `var(--primary)` is NOT a valid color. It has to be wrapped:
 *     `rgb(var(--primary))`.
 *  2. These feed an inline `backgroundColor`, so the var is resolved by the
 *     browser at paint time. That is deliberate: it keeps the tile following the
 *     `.dark` overrides in tokens.css live, which a render-time JS read of
 *     `token()` would not do.
 *
 * This map used to name `--color-primary` / `--color-sage-700`, which have never
 * existed - every lookup failed and silently painted the hardcoded fallback hex.
 * The real semantic tokens are `--primary` and `--success`.
 */
const CATEGORY_COLORS: Record<string, string> = {
  DISPATCH: 'rgb(var(--primary))',
  JOB: 'rgb(var(--primary))',
  LEAD: 'rgb(var(--primary))',
  SECURITY: 'rgb(var(--primary))',
  BILLING: 'rgb(var(--success))',
  ESTIMATE: 'rgb(var(--success))',
  // Inventory and Team were two hand-picked ambers with no token behind them;
  // both collapse onto the one amber the status scale defines.
  INVENTORY: 'rgb(var(--warning-strong))',
  TEAM: 'rgb(var(--warning-strong))',
  COMMUNICATION: 'rgb(var(--primary))',
  // Informational like the other primaries; the checklist icon is what tells
  // a task apart from a dispatch at a glance.
  TASK: 'rgb(var(--primary))',
};

function categoryColor(category: string): string {
  return CATEGORY_COLORS[category.toUpperCase()] ?? 'rgb(var(--primary))';
}

// ---------------------------------------------------------------------------
// Category → lucide icon
// ---------------------------------------------------------------------------

function CategoryIcon({ category }: { category: string }) {
  const color = categoryColor(category);
  const cls = 'h-4 w-4 text-on-fill';
  const cat = category.toUpperCase();

  let Icon: React.ElementType;
  if (cat === 'JOB' || cat === 'DISPATCH') {
    Icon = cat === 'JOB' ? Wrench : Briefcase;
  } else if (cat === 'BILLING' || cat === 'ESTIMATE') {
    Icon = DollarSign;
  } else if (cat === 'INVENTORY') {
    Icon = Package;
  } else if (cat === 'COMMUNICATION') {
    Icon = Phone;
  } else if (cat === 'TEAM') {
    Icon = Clock;
  } else if (cat === 'SECURITY') {
    Icon = Shield;
  } else if (cat === 'LEAD') {
    Icon = UserPlus;
  } else if (cat === 'TASK') {
    Icon = ListChecks;
  } else {
    Icon = Briefcase;
  }

  return (
    <span
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
      style={{ backgroundColor: color }}
    >
      <Icon className={cls} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Relative timestamp helper
// ---------------------------------------------------------------------------

export function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d`;
}

// ---------------------------------------------------------------------------
// Deep-link helper
// ---------------------------------------------------------------------------

export function notificationDeepLink(item: NotificationView): string {
  const { object_type, object_id } = item;
  const type = object_type?.toUpperCase() ?? '';

  switch (type) {
    case 'JOB':
      return `/jobs/${object_id}`;
    case 'JOB_STAGE':
      // Staging notifications carry a JobStage id (NOT a Job id) — linking to
      // /jobs/:id 404'd. Land on the staging view instead (P5 §4).
      return '/inventory/staging';
    case 'ESTIMATE':
      return `/estimates/${object_id}`;
    case 'LEAD':
      return `/leads/${object_id}`;
    case 'INVOICE':
      return `/invoices/${object_id}`;
    case 'PURCHASE_ORDER':
      // The PO page is its own route — don't lump it into /inventory (P5 §4).
      return '/inventory/purchase-orders';
    case 'TASK':
      // Every task.* verb carries a Task id, but Tasks is ONE route with no
      // `:id` child — the six views are component-local tabs and the detail is a
      // store-driven drawer, never a URL (tasks.paths.ts). `/tasks/:id` would
      // fall into the catch-all redirect, so the id rides as a query param the
      // hub consumes once and strips. `task.deleted` points at a row that is
      // gone by design; the hub degrades to the plain hub and says so.
      return object_id ? `/tasks?task=${object_id}` : '/tasks';
    case 'INVENTORY_ITEM':
    case 'STOCK_APPROVAL':
      return '/inventory';
    case 'CALL':
      return '/communication/phone';
    case 'MESSAGE_THREAD':
      // The Text inbox deep-links to an exact thread via ?threadId= (see
      // SmsInboxView's deep-link effect); unknown ids fall back gracefully
      // to the page-level view.
      return object_id ? `/communication/text?threadId=${object_id}` : '/communication/text';
    case 'USER':
    case 'TIME_ENTRY':
      return '/settings';
    default:
      return '/';
  }
}

// ---------------------------------------------------------------------------
// Inline action buttons
// ---------------------------------------------------------------------------

interface ActionButtonsProps {
  item: NotificationView;
  /** Called when an action completes successfully (or navigates). */
  onActed: () => void;
}

function ActionButtons({ item, onActed }: ActionButtonsProps) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const markActed = useMarkActed();

  const [pendingAction, setPendingAction] = useState<string | null>(null);

  async function runAction(actionKey: string) {
    const handler = ACTION_HANDLERS[actionKey];
    if (!handler) return;

    setPendingAction(actionKey);
    try {
      const result = await handler(item, navigate);
      if (result && result.skipActed) {
        // Navigate-only; the notification is NOT done yet — it clears later when the
        // backend resolves it (job actually created). Leave the row pinned: do NOT
        // stamp acted, and do NOT call onActed() (onActed = setActedOptimistic, which
        // would flash the row to "Done"). The finally{} block still clears the spinner.
        return;
      }
      // Entity call succeeded — stamp acted
      await markActed.mutateAsync(item.id);
      onActed();
      toast({ title: 'Done', description: item.title, duration: 3000 });
    } catch {
      toast({
        title: 'Action failed',
        description: 'Could not complete the action. Please try again.',
        variant: 'destructive',
        duration: 4000,
      });
      // Do NOT stamp acted — leave the row actionable
    } finally {
      setPendingAction(null);
    }
  }

  const type = (item.action_type ?? '').toUpperCase();
  const isBusy = pendingAction !== null || markActed.isPending;

  if (type === 'APPROVE_OT' || type === 'APPROVE_STOCK') {
    const approveKey = type === 'APPROVE_OT' ? 'APPROVE_OT' : 'APPROVE_STOCK';
    const denyKey = type === 'APPROVE_OT' ? 'DENY_OT' : 'DENY_STOCK';

    return (
      <div className="mt-1.5 flex gap-2">
        {/* Approve/Deny pair: no solid/success tone is minted on Button, and
            converting only Deny would misalign the pair's geometry - same
            reasoning as the Approve/Reject pairs deferred elsewhere. Deferred. */}
        <button
          className="flex items-center gap-1 rounded bg-success px-2.5 py-1 text-xs font-medium text-on-fill disabled:opacity-60"
          disabled={isBusy}
          onClick={(e) => {
            e.stopPropagation();
            runAction(approveKey);
          }}
        >
          {pendingAction === approveKey && (
            <Loader2 className="h-3 w-3 animate-spin" />
          )}
          Approve
        </button>
        <button
          className="flex items-center gap-1 rounded border border-border px-2.5 py-1 text-xs font-medium text-text-secondary disabled:opacity-60"
          disabled={isBusy}
          onClick={(e) => {
            e.stopPropagation();
            runAction(denyKey);
          }}
        >
          {pendingAction === denyKey && (
            <Loader2 className="h-3 w-3 animate-spin" />
          )}
          Deny
        </button>
      </div>
    );
  }

  const actionKey =
    type === 'SCHEDULE_JOB'
      ? 'SCHEDULE_JOB'
      : type === 'SEND_REMINDER'
        ? 'SEND_REMINDER'
        : 'VIEW';

  const label =
    type === 'SCHEDULE_JOB'
      ? 'Schedule job'
      : type === 'SEND_REMINDER'
        ? 'Send reminder'
        : 'View';

  return (
    <div className="mt-1.5">
      {/* No solid/success tone is minted on Button - same gap as the Approve/Deny
          pair above. Deferred. */}
      <button
        className="flex items-center gap-1 rounded bg-success px-2.5 py-1 text-xs font-medium text-on-fill disabled:opacity-60"
        disabled={isBusy}
        onClick={(e) => {
          e.stopPropagation();
          runAction(actionKey);
        }}
      >
        {pendingAction === actionKey && (
          <Loader2 className="h-3 w-3 animate-spin" />
        )}
        {label}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NotificationItem
// ---------------------------------------------------------------------------

interface NotificationItemProps {
  item: NotificationView;
}

export function NotificationItem({ item }: NotificationItemProps) {
  const navigate = useNavigate();
  const markRead = useMarkRead();

  /**
   * Optimistic acted state — set locally after a successful inline action so
   * the row flips to "✓ Done" immediately without waiting for a server
   * round-trip + cache invalidation render cycle.
   */
  const [actedOptimistic, setActedOptimistic] = useState(false);

  const isUnread = item.read_at == null;
  const isActed = actedOptimistic || item.acted_at != null;
  const deepLink = notificationDeepLink(item);

  function handleRowClick() {
    // Mark read (fire-and-forget — don't block navigation)
    if (item.read_at == null) {
      markRead.mutate(item.id);
    }
    navigate(deepLink);
  }

  return (
    <div
      role="button"
      tabIndex={0}
      className="flex cursor-pointer gap-3 px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      onClick={handleRowClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') handleRowClick();
      }}
    >
      {/* Category icon */}
      <CategoryIcon category={item.category} />

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          {/* Title — bold when unread */}
          <p
            className={
              isUnread && !isActed
                ? 'text-sm font-semibold text-text-primary'
                : 'text-sm font-normal text-text-secondary'
            }
          >
            {item.title}
          </p>

          {/* Timestamp + unread dot */}
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="text-xs text-text-soft">{timeAgo(item.created_at)}</span>
            {isUnread && !isActed && (
              <span className="h-2 w-2 shrink-0 rounded-full bg-notify" aria-hidden="true" />
            )}
          </div>
        </div>

        {/* Optional body subline */}
        {item.body != null && item.body.length > 0 && (
          <p className="mt-0.5 text-xs text-text-secondary line-clamp-2">{item.body}</p>
        )}

        {/* Acted "✓ Done" chip — shown when acted optimistically or from server */}
        {isActed && item.needs_action && (
          <div className="mt-1.5 flex items-center gap-1 text-xs text-text-soft">
            <CheckCircle2 className="h-3.5 w-3.5 text-sage-500" aria-hidden="true" />
            <span>Done</span>
          </div>
        )}

        {/* Action buttons — only when actionable (not yet acted) */}
        {item.needs_action && !isActed && item.action_type && (
          <ActionButtons
            item={item}
            onActed={() => setActedOptimistic(true)}
          />
        )}
      </div>
    </div>
  );
}
