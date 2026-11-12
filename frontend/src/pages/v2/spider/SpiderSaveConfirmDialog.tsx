import { useState, useMemo, type ReactNode } from 'react';
import {
  Bell,
  Mail,
  MessageSquare,
  Clock,
  Users,
  ChevronDown,
  AlertTriangle,
  CheckCircle2,
  UserCheck,
  Shield,
  Layers,
  Save,
} from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { toast } from '@/ui-kit/components/ui/sonner';
import { cn } from '@/lib/utils';
import { AI_AGENTS } from '@/lib/ai-center/agents';
import {
  type SpiderNotificationsConfig,
  type LeadStageConfig,
  type SpiderAssignmentsConfig,
  type SystemRoleItem,
  type AssignmentUserItem,
} from '@/lib/spider/watcher';

/*
 * The review shown when Save is clicked on Spider's Configuration tab, copied from the contractor's
 * sandbox build (`frontend/src/components/ai-center/SpiderConfigPanel.tsx` at 3bb6606,
 * `SpiderSaveConfirmDialog`) as it is (Ran, 15 Oct), less his old activation note and its button label
 * (Ran, 10 Nov). Save while Spider is Active opens it with a Save button, and confirming saves
 * the settings only. Activate opens it too (#3432), with the "When you activate"
 * box at the top and the button reading Activate; the page then activates.
 *
 * Changes to his code:
 *   - The Spider image is ours (the agent's own still).
 *   - Our design system's rules, with no visible change on a desktop: the dialog states its intent
 *     (full screen on a phone, his own header/body/footer), the 90vh cap is the dialog's own
 *     dynamic-viewport cap, the leads list is capped through DialogList (one scroller on a phone),
 *     a popover's cap sits on the popover itself, and a button's or avatar's type size sits on the
 *     text inside it.
 *   - Monitored Pipeline Targets (#3436): every open lead is watched, new ones included, except the
 *     excluded ones, so the part always reads as auto-enrolled, with the number of open leads that will
 *     be watched as a chip (mockup M1's "2,287 leads"). The page no longer downloads every lead, so
 *     his list of selected leads is gone.
 */

const SPIDER_IMAGE = AI_AGENTS.find((a) => a.id === 'spider')?.image;

export interface SpiderSaveConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notifications: SpiderNotificationsConfig;
  assignments: SpiderAssignmentsConfig;
  leadStages: LeadStageConfig[];
  /** The open leads Spider will watch once this is saved (the server's count, with the changes not saved yet). */
  watchedLeads?: number;
  availableRoles: SystemRoleItem[];
  availableUsers: AssignmentUserItem[];
  onConfirm: () => void;
  /**
   * Set when Activate opened the review (#3432): the "When you activate" box, shown at the top, and the
   * button reads Activate. Unset, this is the review Save opens while Spider is Active: the same title
   * and four parts, no box, and the button reads Save (Ran, 10 Nov).
   */
  activation?: ReactNode;
  /** The confirm button waits (e.g. until the activation numbers are read). */
  confirmDisabled?: boolean;
}

/**
 * Confirmation & Review Dialog shown when user clicks Save on the Spider Agent configuration.
 */
export function SpiderSaveConfirmDialog({
  open,
  onOpenChange,
  notifications,
  assignments,
  leadStages,
  watchedLeads,
  availableRoles,
  availableUsers,
  onConfirm,
  activation,
  confirmDisabled = false,
}: SpiderSaveConfirmDialogProps) {

  // Resolve assigned role details
  const selectedRoleDetails = useMemo(() => {
    if (!assignments.adminRoles || assignments.adminRoles.length === 0) return [];
    return assignments.adminRoles.map((roleKey) => {
      const found = availableRoles.find((r) => r.id === roleKey);
      return (
        found || {
          id: roleKey,
          label: roleKey,
          description: 'Administrative role configured for alert routing',
        }
      );
    });
  }, [assignments.adminRoles, availableRoles]);

  // Resolve assigned user details
  const selectedUserDetails = useMemo(() => {
    if (!assignments.users || assignments.users.length === 0) return [];
    return assignments.users.map((userId) => {
      const found = availableUsers.find((u) => u.id === userId);
      return (
        found || {
          id: userId,
          name: userId,
          email: '',
          role: 'Member',
          roleLabel: 'Member',
        }
      );
    });
  }, [assignments.users, availableUsers]);

  // Resolve assigned role names
  const roleNames = useMemo(() => {
    return selectedRoleDetails.map((r) => r.label);
  }, [selectedRoleDetails]);

  // Resolve assigned user names
  const specificUserNames = useMemo(() => {
    return selectedUserDetails.map((u) => u.name);
  }, [selectedUserDetails]);

  const [showValidationFeedback, setShowValidationFeedback] = useState(false);

  // 4 Required Validation Checks before activation
  const validationErrors = useMemo(() => {
    const list: { section: string; message: string; prompt: string }[] = [];

    // 1. Notification Channels: At least one channel must be selected.
    const hasNotification = !!(notifications.email || notifications.sms || notifications.inApp || notifications.redFrame);
    if (!hasNotification) {
      list.push({
        section: 'Notification Channels',
        message: 'No notification channel selected.',
        prompt: 'Please select at least one Notification Channel (Email, SMS, In-App, or Red Frame).',
      });
    }

    // 2. Assignment: At least one recipient/role must be assigned.
    const hasRoles = Array.isArray(assignments.adminRoles) && assignments.adminRoles.length > 0;
    const hasUsers = Array.isArray(assignments.users) && assignments.users.length > 0;
    const hasOwner = !!assignments.owner;
    if (!hasRoles && !hasUsers && !hasOwner) {
      list.push({
        section: 'Assignment',
        message: 'No alert recipient or role assigned.',
        prompt: 'Please assign at least one recipient (Admin Roles, Lead Owner, or Specific Users).',
      });
    }

    // 3. Stage Thresholds: At least one threshold must be set.
    const hasActiveThreshold = leadStages.some(
      (s) => s.enabled !== false && s.duration !== undefined && s.duration !== null && !isNaN(s.duration) && Number(s.duration) > 0
    );
    if (!hasActiveThreshold) {
      list.push({
        section: 'Stage Thresholds',
        message: 'No stage threshold configured.',
        prompt: 'Please set at least one stage duration threshold greater than 0.',
      });
    }

    return list;
  }, [notifications, assignments, leadStages]);

  const handleActivate = (e: React.MouseEvent) => {
    if (validationErrors.length > 0) {
      e.preventDefault();
      setShowValidationFeedback(true);
      // Save while Active is no activation (Ran, 10 Nov): its own words; Activate's are unchanged.
      toast.error(activation ? 'Cannot Activate Spider Agent' : 'Cannot Save Spider Settings', {
        description: validationErrors.map((v) => `${v.section}: ${v.prompt}`).join(' | '),
      });
      return;
    }
    onConfirm();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        intent="content"
        layout="own"
        overlayClassName="bg-ocean-900/40"
        className="flex w-[95vw] max-w-2xl flex-col gap-0 overflow-hidden p-0"
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-border bg-surface-light px-6 py-4">
          <div className="flex items-center gap-3">
            <Avatar ring="ai" className="h-10 w-10 shrink-0">
              <AvatarImage src={SPIDER_IMAGE} alt="Spider Agent" className="object-cover" />
              <AvatarFallback tone="subtle">
                <span className="text-sm font-bold">S</span>
              </AvatarFallback>
            </Avatar>
            <div>
              <DialogTitle asChild>
                <Heading level={2} scale="base" weight="bold">
                  Confirm Spider Agent Configuration
                </Heading>
              </DialogTitle>
              <p className="text-xs text-text-secondary">
                Review your campaign channels, recipients, stage thresholds, and monitored leads before saving.
              </p>
            </div>
          </div>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* Activate: the "When you activate" box at the top (#3432). Save while Active: no box (Ran, 10 Nov). */}
          {activation}

          {/* Missing Validation Error Callout */}
          {showValidationFeedback && validationErrors.length > 0 && (
            <div className="rounded-xl border border-danger/30 bg-danger/10 p-3.5 text-xs text-danger space-y-1.5 animate-in fade-in-0 duration-150">
              <p className="font-bold flex items-center gap-1.5">
                <AlertTriangle className="h-4 w-4" />
                {activation ? 'Required Items Missing Before Activation' : 'Required Items Missing Before Saving'} ({validationErrors.length})
              </p>
              <p className="text-[11px] opacity-90">
                At least one item must be selected from every required section before {activation ? 'activating' : 'saving'}:
              </p>
              <ul className="list-disc pl-4 space-y-0.5 text-[11px]">
                {validationErrors.map((err, idx) => (
                  <li key={idx}>{err.prompt}</li>
                ))}
              </ul>
            </div>
          )}

          {/* 1. Monitored Pipeline Targets */}
          <div className="rounded-xl border border-border bg-surface-light p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-[1_1_16rem]">
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <Users className="h-4 w-4 text-ai-600 shrink-0" />
                  <span className="text-xs font-bold text-text-primary uppercase tracking-wider">
                    Monitored Pipeline Targets
                  </span>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-ai-50 border border-ai-200 text-ai-600">
                    Auto-Enrolled
                  </span>
                </div>
                <p className="text-xs text-text-secondary">
                  All incoming and active pipeline leads are automatically enrolled in multi-stage tracking.
                </p>
              </div>

              {watchedLeads !== undefined && (
                <span
                  data-spider-review-watched
                  className="shrink-0 rounded-full border border-ai-200 bg-ai-50 px-3 py-1 text-xs font-bold text-ai-strong"
                >
                  {watchedLeads.toLocaleString()} {watchedLeads === 1 ? 'lead' : 'leads'}
                </span>
              )}
            </div>
          </div>

          {/* 2. Notification Channels */}
          <div className="rounded-xl border border-border bg-surface-light p-4 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <Bell className="h-4 w-4 text-ai-600 shrink-0" />
              <span className="text-xs font-bold text-text-primary uppercase tracking-wider">
                Active Notification Channels
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              {([
                { key: 'email', label: 'Email', icon: Mail, enabled: notifications.email },
                { key: 'sms', label: 'SMS', icon: MessageSquare, enabled: notifications.sms },
                { key: 'inApp', label: 'In-App', icon: Bell, enabled: notifications.inApp },
                { key: 'redFrame', label: 'Red Frame', icon: Layers, enabled: notifications.redFrame },
              ] as const).map(({ key, label, icon: Icon, enabled }) => (
                <div
                  key={key}
                  className={cn(
                    "flex items-center gap-2 px-3 py-2.5 rounded-lg text-xs font-semibold border transition-all",
                    enabled
                      ? "bg-success-surface border-success-border text-success-text shadow-xs"
                      : "bg-surface-light border-border/70 text-text-secondary"
                  )}
                >
                  <Icon className={cn("h-4 w-4 shrink-0", enabled ? "text-success-text" : "text-text-secondary")} />
                  <span className="truncate">{label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* 3. Assigned Alert Recipients */}
          <div className="rounded-xl border border-border bg-surface-light p-4 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <UserCheck className="h-4 w-4 text-ai-600 shrink-0" />
              <span className="text-xs font-bold text-text-primary uppercase tracking-wider">
                Assigned Alert Recipients
              </span>
            </div>
            <div className="space-y-2.5 text-xs">
              {/* Admin Roles Row & Popover */}
              <div className="p-3.5 px-4 rounded-xl border border-border/70 bg-background-light/40 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Shield className="h-5 w-5 text-ai-600 shrink-0" />
                  <span className="font-semibold text-text-primary text-sm">Admin Roles</span>
                </div>
                {roleNames.length > 0 ? (
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-auto gap-1.5 px-3 py-1 cursor-pointer active:scale-95 transition-all select-none shrink-0"
                      >
                        <span className="text-xs font-bold">{roleNames.length} Role{roleNames.length === 1 ? '' : 's'} Selected</span>
                        <ChevronDown className="h-3.5 w-3.5 transition-transform duration-200" />
                      </Button>
                    </PopoverTrigger>
                    {/* The list's cap sits on the popover itself (a popover, not a list in the dialog's flow). */}
                    <PopoverContent className="z-[130] w-56 p-1 max-h-56 overflow-y-auto animate-in fade-in-0 zoom-in-95 duration-150" align="end" sideOffset={6}>
                      <div className="space-y-0.5">
                        {roleNames.map((roleName, idx) => (
                          <div
                            key={idx}
                            className="flex items-center px-3 py-2 rounded-lg hover:bg-background-light text-xs font-semibold text-text-primary transition-colors select-none"
                          >
                            <span className="truncate">{roleName}</span>
                          </div>
                        ))}
                      </div>
                    </PopoverContent>
                  </Popover>
                ) : (
                  <span className="px-3 py-1 rounded-full font-bold text-xs bg-surface-light border border-border/70 text-text-secondary shrink-0">
                    None
                  </span>
                )}
              </div>

              {/* Lead Owner Row */}
              <div className="p-3.5 px-4 rounded-xl border border-border/70 bg-background-light/40 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <UserCheck className="h-5 w-5 text-ai-600 shrink-0" />
                  <span className="font-semibold text-text-primary text-sm">Lead Owner</span>
                </div>
                <span className={cn(
                  "font-bold text-xs px-3 py-1 rounded-full border shrink-0",
                  assignments.owner
                    ? "bg-success-surface border-success-border text-success-text"
                    : "bg-surface-light border-border/70 text-text-secondary"
                )}>
                  {assignments.owner ? 'Enabled' : 'Disabled'}
                </span>
              </div>

              {/* Specific Users Row & Popover */}
              <div className="p-3.5 px-4 rounded-xl border border-border/70 bg-background-light/40 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Users className="h-5 w-5 text-ai-600 shrink-0" />
                  <span className="font-semibold text-text-primary text-sm">Specific Users</span>
                </div>
                {specificUserNames.length > 0 ? (
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-auto gap-1.5 px-3 py-1 cursor-pointer active:scale-95 transition-all select-none shrink-0"
                      >
                        <span className="text-xs font-bold">{specificUserNames.length} Users Selected</span>
                        <ChevronDown className="h-3.5 w-3.5 transition-transform duration-200" />
                      </Button>
                    </PopoverTrigger>
                    {/* The list's cap sits on the popover itself (a popover, not a list in the dialog's flow). */}
                    <PopoverContent className="z-[130] w-56 p-1 max-h-56 overflow-y-auto animate-in fade-in-0 zoom-in-95 duration-150" align="end" sideOffset={6}>
                      <div className="space-y-0.5">
                        {specificUserNames.map((userName, idx) => (
                          <div
                            key={idx}
                            className="flex items-center px-3 py-2 rounded-lg hover:bg-background-light text-xs font-semibold text-text-primary transition-colors select-none"
                          >
                            <span className="truncate">{userName}</span>
                          </div>
                        ))}
                      </div>
                    </PopoverContent>
                  </Popover>
                ) : (
                  <span className="px-3 py-1 rounded-full font-bold text-xs bg-surface-light border border-border/70 text-text-secondary shrink-0">
                    None
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* 4. Stage Thresholds */}
          <div className="rounded-xl border border-border bg-surface-light p-4 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <Clock className="h-4 w-4 text-ai-600 shrink-0" />
              <span className="text-xs font-bold text-text-primary uppercase tracking-wider">
                Pipeline Stage Thresholds
              </span>
            </div>
            <div className="space-y-2.5 text-xs">
              {leadStages.map((stage) => {
                const hasValue =
                  stage.duration !== undefined &&
                  stage.duration !== null &&
                  !isNaN(stage.duration) &&
                  stage.enabled !== false &&
                  Number(stage.duration) > 0;
                return (
                  <div
                    key={stage.id}
                    className="p-3.5 px-4 rounded-xl border border-border/70 bg-background-light/40 flex items-center justify-between"
                  >
                    <span className="font-semibold text-text-primary text-sm">{stage.label}</span>
                    <span
                      className={cn(
                        'px-3 py-1 rounded-full font-bold text-xs border shrink-0',
                        hasValue
                          ? 'bg-ai-50 border-ai-200 text-ai-600'
                          : 'bg-surface-light border-border/70 text-text-secondary'
                      )}
                    >
                      {hasValue ? `${stage.duration} ${stage.unit}${stage.duration! > 1 ? 's' : ''}` : 'Disabled'}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="border-t border-border bg-surface-light px-6 py-4 flex items-center justify-end gap-3">
          <Button
            type="button"
            variant="solid"
            tone="ai"
            onClick={handleActivate}
            disabled={confirmDisabled}
            className="gap-1.5 font-semibold px-6"
          >
            {/* Activate opens it with the box; Save (while Active) without, and the button says Save (Ran, 10 Nov). */}
            {activation ? <CheckCircle2 className="h-4 w-4" /> : <Save className="h-4 w-4" />}
            {activation ? 'Activate' : 'Save'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
