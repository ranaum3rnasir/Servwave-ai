import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bell,
  Mail,
  MessageSquare,
  Clock,
  Users,
  Search,
  ChevronDown,
  AlertTriangle,
  CheckCircle2,
  Save,
  Plus,
  Minus,
  Square,
  MapPin,
  UserCheck,
  User,
  Shield,
  ExternalLink,
  Info,
  ArrowLeft,
  SlidersHorizontal,
  Power,
  RefreshCw,
  PhoneCall,
  Calendar,
  FileText,
  Layers,
} from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/ui-kit/components/ui/sonner';
import { cn } from '@/lib/utils';
import api from '@/lib/axios';
import { customerDisplayName } from '@/lib/customer-name';
import { useRoles } from '@/lib/api/roles';
import { useUsers } from '@/lib/api/users';
import { useAiCenterStore } from '@/stores/aiCenterStore';
import { useSpiderServerConfig, SPIDER_CONFIG_QUERY_KEY } from '@/lib/api/spider';
import {
  useSpiderWatcherStore,
  type TimeUnit,
  type WatcherCustomer,
  type WatcherLead,
  type SpiderNotificationsConfig,
  type LeadStageConfig,
  type SpiderAssignmentsConfig,
  type SystemRoleItem,
  type AssignmentUserItem,
  DEFAULT_LEAD_STAGES,
  DEFAULT_SYSTEM_ROLES,
  DEFAULT_ASSIGNMENT_USERS,
  DEFAULT_ASSIGNMENTS_CONFIG,
  normalizeAssignments,
  DEFAULT_WATCHER_CUSTOMERS,
  resolveLeadStageAndElapsedTime,
  formatCurrentStageName,
  formatLastCommunicationTimestamp,
  formatLeadServiceLocation,
  buildWatcherCustomersFromLive,
  getSpiderLeadOwnerName,
  getDefaultFallbackDuration,
  isLeadOverdue,
  isLeadInAllowedAlertStage,
  isLeadWalkthroughCompleted,
  getSpiderStageAction,
} from '@/stores/spiderWatcherStore';
import type { AIAgent } from '@/lib/ai-center/agents';

interface SpiderConfigPanelProps {
  agent: AIAgent;
  onOpenChange: (open: boolean) => void;
  onBook: (agent: AIAgent) => void;
}

const TIME_UNITS: TimeUnit[] = ['Minute', 'Hour', 'Day'];

export interface SpiderWatcherConfigProps {
  notifications: SpiderNotificationsConfig;
  setNotifications: React.Dispatch<React.SetStateAction<SpiderNotificationsConfig>>;
  assignments: SpiderAssignmentsConfig;
  setAssignments: React.Dispatch<React.SetStateAction<SpiderAssignmentsConfig>>;
  leadStages: LeadStageConfig[];
  updateLeadStage: (id: string, updates: Partial<LeadStageConfig>) => void;
  selectedCustomerIds: string[];
  selectedLeadIds: string[];
  toggleCustomerSelection: (customerId: string, allLeadIdsForCustomer: string[]) => void;
  toggleLeadSelection: (
    leadId: string,
    customerId: string,
    allLeadIdsForCustomer: string[]
  ) => void;
  selectAllCustomers: () => void;
  deselectAllCustomers: () => void;
  storeCustomers: WatcherCustomer[];
  availableRoles: SystemRoleItem[];
  availableUsers: AssignmentUserItem[];
  isLoading?: boolean;
  isError?: boolean;
  errorMessage?: string;
  onRetry?: () => void;
  onCloseModal?: () => void;
  isActive?: boolean;
  activatedAt?: string | Date | null;
  autoEnrollNewLeads?: boolean;
  onAutoEnrollChange?: (enabled: boolean) => void;
}

/** Dedicated UI for Spider (AI Lead Manager) Watcher configuration */
export function SpiderWatcherConfig({
  notifications,
  setNotifications,
  assignments,
  setAssignments,
  leadStages,
  updateLeadStage,
  selectedCustomerIds,
  selectedLeadIds,
  toggleCustomerSelection,
  toggleLeadSelection,
  selectAllCustomers,
  deselectAllCustomers,
  storeCustomers,
  availableRoles,
  availableUsers,
  isLoading = false,
  isError = false,
  errorMessage,
  onRetry,
  onCloseModal,
  isActive: propsIsActive,
  activatedAt: propsActivatedAt,
  autoEnrollNewLeads = true,
  onAutoEnrollChange,
}: SpiderWatcherConfigProps) {
  const navigate = useNavigate();
  const setAiCenterOpen = useAiCenterStore((s) => s.setOpen);
  const storeIsActive = useSpiderWatcherStore((s) => s.isActive);
  const storeActivatedAt = useSpiderWatcherStore((s) => s.activatedAt);
  const effectiveIsActive = propsIsActive !== undefined ? propsIsActive : storeIsActive;
  const effectiveActivatedAt = propsActivatedAt !== undefined ? propsActivatedAt : storeActivatedAt;

  const [search, setSearch] = useState('');
  const [expandedCustomerId, setExpandedCustomerId] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState<{ adminRoles: boolean; users: boolean }>({
    adminRoles: false,
    users: false,
  });

  const allRoles = availableRoles && availableRoles.length > 0 ? availableRoles : DEFAULT_SYSTEM_ROLES;
  const allUsers = availableUsers && availableUsers.length > 0 ? availableUsers : DEFAULT_ASSIGNMENT_USERS;

  // Admin role selection helpers
  const allAdminRolesSelected =
    allRoles.length > 0 && allRoles.every((r) => assignments.adminRoles.includes(r.id));
  const someAdminRolesSelected =
    assignments.adminRoles.length > 0 && !allAdminRolesSelected;

  const toggleAllAdminRoles = () => {
    const allRoleIds = allRoles.map((r) => r.id);
    const isAllSelected =
      allRoleIds.length > 0 && allRoleIds.every((id) => assignments.adminRoles.includes(id));
    const newAdminRoles = isAllSelected ? [] : allRoleIds;

    setAssignments((prev) => ({
      ...prev,
      adminRoles: newAdminRoles,
    }));
    if (!isAllSelected) {
      setExpandedSections((prev) => ({ ...prev, adminRoles: true }));
    }
  };

  const toggleAdminRole = (roleId: string) => {
    setAssignments((prev) => {
      const isSelected = prev.adminRoles.includes(roleId);
      const newRoles = isSelected
        ? prev.adminRoles.filter((id) => id !== roleId)
        : [...prev.adminRoles, roleId];

      return {
        ...prev,
        adminRoles: newRoles,
      };
    });
  };

  const toggleOwner = () => {
    setAssignments((prev) => ({
      ...prev,
      owner: !prev.owner,
    }));
  };

  const selectedUserCount = assignments.users.filter((id) =>
    allUsers.some((u) => u.id === id)
  ).length;
  const allUsersSelected =
    allUsers.length > 0 && selectedUserCount === allUsers.length;
  const someUsersSelected =
    selectedUserCount > 0 && selectedUserCount < allUsers.length;

  const toggleAllUsers = () => {
    if (allUsers.length === 0) return;
    const allUserIds = allUsers.map((u) => u.id);
    const allSelected = allUserIds.every((id) => assignments.users.includes(id));
    setAssignments((prev) => ({
      ...prev,
      users: allSelected ? [] : allUserIds,
    }));
    if (!allSelected) {
      setExpandedSections((prev) => ({ ...prev, users: true }));
    }
  };

  const toggleUser = (userId: string) => {
    setAssignments((prev) => {
      const isSelected = prev.users.includes(userId);
      const newUsers = isSelected
        ? prev.users.filter((id) => id !== userId)
        : [...prev.users, userId];
      return {
        ...prev,
        users: newUsers,
      };
    });
  };

  const handleLeadClick = (leadId: string) => {
    if (onCloseModal) {
      onCloseModal();
    }
    setAiCenterOpen(false);
    navigate(`/leads/${leadId}`);
  };

  const customersList: WatcherCustomer[] = useMemo(() => {
    return (storeCustomers || [])
      .map((c) => ({
        ...c,
        leads: (c.leads || [])
          .filter((l) => isLeadInAllowedAlertStage(l))
          .map((l) => {
            const m = resolveLeadStageAndElapsedTime(l);
            const resolvedLocation =
              formatLeadServiceLocation(l, c) !== 'Service location not specified'
                ? formatLeadServiceLocation(l, c)
                : (l.serviceLocation || 'Service location not specified');

            return {
              ...l,
              serviceLocation: resolvedLocation,
              stageId: m.stageId,
              stageLabel: m.stageLabel,
              elapsedValue: m.elapsedValue,
              elapsedUnit: m.elapsedUnit,
              elapsedSeconds: m.elapsedSeconds,
              contactedAt: l.contactedAt || (l as { contacted_at?: string }).contacted_at || m.contactedAt || null,
            };
          })
          .filter((l) => isLeadInAllowedAlertStage(l) && l.stageId !== 'estimate' && l.stageId !== 'closed'),
      }))
      .filter((c) => c.leads && c.leads.length > 0);
  }, [storeCustomers]);

  const filteredCustomers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return customersList;

    return customersList.filter((c) => {
      const matchCustomer =
        c.name.toLowerCase().includes(q) ||
        (c.company && c.company.toLowerCase().includes(q)) ||
        (c.email && c.email.toLowerCase().includes(q));

      const matchLead = c.leads.some((l) => {
        const loc = l.serviceLocation || '';
        return (
          l.leadNumber.toLowerCase().includes(q) ||
          (l.serviceRequest && l.serviceRequest.toLowerCase().includes(q)) ||
          loc.toLowerCase().includes(q)
        );
      });

      return matchCustomer || matchLead;
    });
  }, [customersList, search]);

  const allSelected =
    customersList.length > 0 &&
    customersList.every((c) =>
      c.leads.length > 0 && c.leads.every((l) => selectedLeadIds.includes(l.id))
    );

  return (
    <div className="space-y-4">
      {/* Top Section — Notifications (Left: 4 cols) & Assignment (Right: 8 cols) */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Left Section — Notifications */}
        <div className="flex flex-col rounded-card border border-border bg-surface-light p-4 shadow-card lg:col-span-4">
          <div className="mb-3 border-b border-border/60 pb-2">
            <Heading level={3} scale="sm" weight="bold" className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-ai-600 shrink-0" />
              Notifications
            </Heading>
          </div>
          <div className="space-y-2.5 flex-1">
            <div
              className="flex items-center gap-3 rounded-lg p-2 transition-colors hover:bg-background-light cursor-pointer"
              onClick={() =>
                setNotifications((prev) => ({ ...prev, email: !prev.email }))
              }
            >
              <Checkbox
                checked={notifications.email}
                onCheckedChange={(checked) =>
                  setNotifications((prev) => ({ ...prev, email: !!checked }))
                }
              />
              <div className="flex items-center gap-2 text-xs font-semibold text-text-primary">
                <Mail className="h-3.5 w-3.5 text-text-soft" />
                <span>Email</span>
              </div>
            </div>

            <div
              className="flex items-center gap-3 rounded-lg p-2 transition-colors hover:bg-background-light cursor-pointer"
              onClick={() =>
                setNotifications((prev) => ({ ...prev, sms: !prev.sms }))
              }
            >
              <Checkbox
                checked={notifications.sms}
                onCheckedChange={(checked) =>
                  setNotifications((prev) => ({ ...prev, sms: !!checked }))
                }
              />
              <div className="flex items-center gap-2 text-xs font-semibold text-text-primary">
                <MessageSquare className="h-3.5 w-3.5 text-text-soft" />
                <span>SMS</span>
              </div>
            </div>

            <div
              className="flex items-center gap-3 rounded-lg p-2 transition-colors hover:bg-background-light cursor-pointer"
              onClick={() =>
                setNotifications((prev) => ({ ...prev, inApp: !prev.inApp }))
              }
            >
              <Checkbox
                checked={notifications.inApp}
                onCheckedChange={(checked) =>
                  setNotifications((prev) => ({ ...prev, inApp: !!checked }))
                }
              />
              <div className="flex items-center gap-2 text-xs font-semibold text-text-primary">
                <Bell className="h-3.5 w-3.5 text-ai-600" />
                <span>In-app Message</span>
              </div>
            </div>

            <div
              className="flex items-center gap-3 rounded-lg p-2 transition-colors hover:bg-background-light cursor-pointer"
              onClick={() =>
                setNotifications((prev) => ({ ...prev, redFrame: !prev.redFrame }))
              }
            >
              <Checkbox
                checked={notifications.redFrame}
                onCheckedChange={(checked) =>
                  setNotifications((prev) => ({ ...prev, redFrame: !!checked }))
                }
              />
              <div className="flex items-center gap-2 text-xs font-semibold text-text-primary">
                <Square className="h-3.5 w-3.5 text-danger" />
                <span>Red Frame</span>
              </div>
            </div>
          </div>
        </div>

        {/* Right Section — Assignment (Admin role, Owner, User) */}
        <div className="flex flex-col rounded-card border border-border bg-surface-light p-4 shadow-card lg:col-span-8">
          <div className="mb-3 border-b border-border/60 pb-2 flex items-center justify-between">
            <Heading level={3} scale="sm" weight="bold" className="flex items-center gap-2">
              <UserCheck className="h-4 w-4 text-ai-600 shrink-0" />
              Assignment
            </Heading>
            <span className="text-[11px] text-text-secondary">
              Alerts will notify all active team members matching the selected roles and users.
            </span>
          </div>

          <div className="flex flex-col justify-between flex-1 space-y-2">
            <div className="space-y-2">
              {/* 1. System role Section */}
              <div className="rounded-lg border border-border/60 bg-surface-light transition-colors hover:border-border overflow-hidden">
                <div className="flex items-center justify-between p-2.5 gap-2 select-none">
                  <div
                    className="flex items-center gap-2.5 min-w-0 cursor-pointer flex-1"
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest('button[role="checkbox"]')) return;
                      toggleAllAdminRoles();
                    }}
                  >
                    <Checkbox
                      checked={
                        someAdminRolesSelected ? 'indeterminate' : allAdminRolesSelected
                      }
                      onCheckedChange={toggleAllAdminRoles}
                      aria-label="Select all System roles"
                    />
                    <span className="text-xs font-bold text-text-primary">
                      System role
                    </span>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[10px] font-semibold transition-colors',
                        assignments.adminRoles.length > 0
                          ? 'bg-ai-50 text-ai-600 border border-ai-200'
                          : 'bg-surface-light text-text-soft border border-border'
                      )}
                    >
                      {assignments.adminRoles.length}/{allRoles.length} selected
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpandedSections((prev) => ({
                          ...prev,
                          adminRoles: !prev.adminRoles,
                        }));
                      }}
                      className="h-6 w-6"
                      aria-label="Toggle System role options"
                      aria-expanded={expandedSections.adminRoles}
                    >
                      <ChevronDown
                        className={cn(
                          'h-3.5 w-3.5 transition-transform duration-200',
                          expandedSections.adminRoles ? 'rotate-180' : ''
                        )}
                      />
                    </Button>
                  </div>
                </div>

                {/* Nested Roles List */}
                {expandedSections.adminRoles && (
                  <div className="border-t border-border/40 bg-background-light/50 px-3 py-2 space-y-1.5 animate-in slide-in-from-top-1 duration-150">
                    {allRoles.map((role) => {
                      const isChecked = assignments.adminRoles.includes(role.id);
                      return (
                        <div
                          key={role.id}
                          onClick={(e) => {
                            if ((e.target as HTMLElement).closest('button[role="checkbox"]')) return;
                            toggleAdminRole(role.id);
                          }}
                          className={cn(
                            'flex items-center justify-between gap-2.5 rounded-md p-1.5 pl-6 transition-colors cursor-pointer',
                            isChecked
                              ? 'bg-ai-50/40 hover:bg-ai-50/70'
                              : 'hover:bg-background-light'
                          )}
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <Checkbox
                              checked={isChecked}
                              onCheckedChange={() => toggleAdminRole(role.id)}
                              aria-label={role.label}
                            />
                            <p className="text-xs font-semibold text-text-primary truncate">
                              {role.label}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* 2. User Section */}
              <div className="rounded-lg border border-border/60 bg-surface-light transition-colors hover:border-border overflow-hidden">
                <div className="flex items-center justify-between p-2.5 gap-2 select-none">
                  <div
                    className="flex items-center gap-2.5 min-w-0 cursor-pointer flex-1"
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest('button[role="checkbox"]')) return;
                      toggleAllUsers();
                    }}
                  >
                    <Checkbox
                      checked={
                        someUsersSelected
                          ? 'indeterminate'
                          : allUsersSelected
                      }
                      onCheckedChange={toggleAllUsers}
                      disabled={allUsers.length === 0}
                      aria-label="Select all users"
                    />
                    <span className="text-xs font-bold text-text-primary">
                      User
                    </span>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[10px] font-semibold transition-colors',
                        selectedUserCount > 0
                          ? 'bg-ai-50 text-ai-600 border border-ai-200'
                          : 'bg-surface-light text-text-soft border border-border'
                      )}
                    >
                      {selectedUserCount}/{allUsers.length} selected
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpandedSections((prev) => ({
                          ...prev,
                          users: !prev.users,
                        }));
                      }}
                      className="h-6 w-6"
                      aria-label="Toggle User options"
                      aria-expanded={expandedSections.users}
                    >
                      <ChevronDown
                        className={cn(
                          'h-3.5 w-3.5 transition-transform duration-200',
                          expandedSections.users ? 'rotate-180' : ''
                        )}
                      />
                    </Button>
                  </div>
                </div>

                {/* Nested Users List */}
                {expandedSections.users && (
                  <div className="border-t border-border/40 bg-background-light/50 px-3 py-2 space-y-1.5 animate-in slide-in-from-top-1 duration-150 max-h-56 overflow-y-auto">
                    {allUsers.length === 0 ? (
                      <div className="py-4 text-center text-xs text-text-soft">
                        No team members found.
                      </div>
                    ) : (
                      allUsers.map((user) => {
                        const isChecked = assignments.users.includes(user.id);
                        return (
                          <div
                            key={user.id}
                            onClick={(e) => {
                              if ((e.target as HTMLElement).closest('button[role="checkbox"]')) return;
                              toggleUser(user.id);
                            }}
                            className={cn(
                              'flex items-center justify-between gap-2.5 rounded-md p-1.5 pl-6 transition-colors cursor-pointer',
                              isChecked
                                ? 'bg-ai-50/40 hover:bg-ai-50/70'
                                : 'hover:bg-background-light'
                            )}
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <Checkbox
                                checked={isChecked}
                                onCheckedChange={() => toggleUser(user.id)}
                                aria-label={user.name}
                              />
                              <div className="min-w-0">
                                <p className="text-xs font-semibold text-text-primary truncate">
                                  {user.name}
                                </p>
                                <p className="text-[10px] text-text-secondary truncate">
                                  {user.roleLabel} {user.email ? `· ${user.email}` : ''}
                                </p>
                              </div>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>

              {/* 3. Owner Checkbox */}
              <div
                className="flex items-center justify-between rounded-lg border border-border/60 bg-surface-light p-2.5 transition-colors hover:border-border cursor-pointer select-none"
                onClick={toggleOwner}
              >
                <div className="flex items-center gap-2.5">
                  <div onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={assignments.owner}
                      onCheckedChange={toggleOwner}
                      aria-label="Notify Lead Owner"
                    />
                  </div>
                  <div>
                    <span className="text-xs font-bold text-text-primary">
                      Owner
                    </span>
                    <span className="ml-2 text-[11px] text-text-secondary">
                      (Strictly assign to the specific owner assigned to each lead)
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Middle Section — Stage Thresholds */}
      <div className="rounded-card border border-border bg-surface-light p-4 shadow-card">
        <div className="mb-3 border-b border-border/60 pb-2">
          <Heading level={3} scale="sm" weight="bold" className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-ai-600 shrink-0" />
            Stage Thresholds
          </Heading>
        </div>

        <div className="space-y-3">
          {leadStages.map((stage) => {
            const isEnabled = stage.enabled !== false && stage.duration !== undefined;
            return (
              <div
                key={stage.id}
                className={cn(
                  'flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-lg border transition-all',
                  isEnabled
                    ? 'border-ai-200 bg-ai-50/20'
                    : 'border-border/60 bg-surface-light opacity-75'
                )}
              >
                <div className="min-w-0">
                  <p className="text-xs font-bold text-text-primary">{stage.label}</p>
                  <p className="text-[11px] text-text-secondary">{stage.description}</p>
                </div>

                <div className="flex items-center gap-2.5 shrink-0 self-end sm:self-center">
                  {/* Enable/Disable Toggle */}
                  <div className="flex items-center gap-1.5">
                    <Switch
                      checked={isEnabled}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          const fallbackDuration =
                            stage.duration && stage.duration >= 1
                              ? stage.duration
                              : getDefaultFallbackDuration(stage.id, stage.unit);
                          updateLeadStage(stage.id, {
                            duration: fallbackDuration,
                            enabled: true,
                          });
                        } else {
                          updateLeadStage(stage.id, {
                            duration: undefined,
                            enabled: false,
                          });
                        }
                      }}
                      aria-label={`Enable ${stage.label}`}
                      className="scale-90"
                    />
                  </div>

                  {/* Stepper Controls: Decrement, Input, Increment */}
                  <div className="flex items-center gap-1">
                    {/* Decrement Button */}
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => {
                        if (!isEnabled) return;
                        const currentVal =
                          stage.duration && stage.duration >= 1 ? stage.duration : 1;
                        const nextVal = currentVal - 1;
                        if (nextVal >= 1) {
                          updateLeadStage(stage.id, { duration: nextVal });
                        } else {
                          updateLeadStage(stage.id, { duration: undefined, enabled: false });
                        }
                      }}
                      disabled={!isEnabled}
                      className="h-7 w-7"
                      aria-label={`Decrement time period for ${stage.label}`}
                    >
                      <Minus className="h-3 w-3" />
                    </Button>

                    {/* Numeric Input */}
                    <input
                      type="number"
                      min="1"
                      disabled={!isEnabled}
                      placeholder={isEnabled ? '0' : 'None'}
                      value={stage.duration !== undefined && stage.duration !== null ? stage.duration : ''}
                      onChange={(e) => {
                        const val = e.target.value === '' ? undefined : Math.max(1, Number(e.target.value));
                        updateLeadStage(stage.id, {
                          duration: val,
                          enabled: val !== undefined,
                        });
                      }}
                      className={cn(
                        'w-12 h-7 rounded-md border border-border bg-surface-light px-1 text-xs font-bold text-center outline-none transition-all',
                        isEnabled
                          ? 'text-text-primary focus-visible:ring-2 focus-visible:ring-ai-500'
                          : 'text-text-soft bg-surface-light/40 border-border/40 cursor-not-allowed placeholder:text-text-soft/60 placeholder:text-[10px]'
                      )}
                      aria-label={`Time period for ${stage.label}`}
                    />

                    {/* Increment Button */}
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => {
                        if (!isEnabled) {
                          const fallbackDuration = getDefaultFallbackDuration(stage.id, stage.unit);
                          updateLeadStage(stage.id, {
                            duration: fallbackDuration,
                            enabled: true,
                          });
                          return;
                        }
                        const currentVal =
                          stage.duration && stage.duration >= 1 ? stage.duration : 0;
                        updateLeadStage(stage.id, { duration: currentVal + 1, enabled: true });
                      }}
                      className="h-7 w-7"
                      aria-label={`Increment time period for ${stage.label}`}
                    >
                      <Plus className="h-3 w-3" />
                    </Button>
                  </div>

                  {/* Unit Select */}
                  <Select
                    value={stage.unit}
                    disabled={!isEnabled}
                    onValueChange={(val) =>
                      updateLeadStage(stage.id, { unit: val as TimeUnit })
                    }
                  >
                    <SelectTrigger
                      disabled={!isEnabled}
                      className={cn(
                        'w-24 h-7 px-2 py-0.5 text-xs',
                        !isEnabled && 'opacity-50 cursor-not-allowed'
                      )}
                      aria-label={`Time unit for ${stage.label}`}
                    >
                      <SelectValue placeholder={stage.unit} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="minutes">minutes</SelectItem>
                      <SelectItem value="hours">hours</SelectItem>
                      <SelectItem value="days">days</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Bottom Section — Select Contacts for Alert */}
      <div className="rounded-card border border-border bg-surface-light p-4 shadow-card">
        <div className="mb-3 border-b border-border/60 pb-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <Heading level={3} scale="sm" weight="bold" className="flex items-center gap-2">
              <Users className="h-4 w-4 text-ai-600 shrink-0" />
              Select Contacts for Alert
            </Heading>
          </div>

          {/* Right side: auto-enroll checkbox + select/deselect all */}
          <div className="flex items-center gap-3 shrink-0 flex-wrap justify-end">
            {/* Auto-select new leads checkbox */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => onAutoEnrollChange?.(!autoEnrollNewLeads)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onAutoEnrollChange?.(!autoEnrollNewLeads);
                }
              }}
              className="flex items-center gap-2 cursor-pointer select-none group"
              title={
                autoEnrollNewLeads
                  ? 'New leads created while Spider is active will be automatically selected'
                  : 'New leads will not be auto-selected — click to enable'
              }
            >
              <div onClick={(e) => e.stopPropagation()} className="shrink-0 flex items-center">
                <Checkbox
                  id="spider-auto-enroll-checkbox"
                  checked={autoEnrollNewLeads}
                  onCheckedChange={(checked) => onAutoEnrollChange?.(checked === true)}
                  className="cursor-pointer"
                  aria-label="Auto-select new leads created during active Spider session"
                />
              </div>
              <span className="text-[11px] font-semibold text-ai-600 hover:text-ai-strong transition-colors cursor-pointer">
                Auto-select new leads
              </span>
            </div>

            {/* Divider */}
            <span className="text-border/80 text-xs select-none">|</span>

            {/* Select all / Deselect all */}
            <span
              role="button"
              tabIndex={0}
              onClick={allSelected ? deselectAllCustomers : selectAllCustomers}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  if (allSelected) {
                    deselectAllCustomers();
                  } else {
                    selectAllCustomers();
                  }
                }
              }}
              className="cursor-pointer text-[11px] font-semibold text-ai-600 hover:text-ai-strong transition-colors"
            >
              {allSelected ? 'Deselect all' : 'Select all'}
            </span>
          </div>
        </div>

        {/* Search bar */}
        <div className="relative mb-3">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-soft" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search customers or leads by name, company, lead # or service..."
            className="w-full rounded-md border border-border bg-surface-light py-1.5 pl-9 pr-3 text-xs text-text-primary outline-none placeholder:text-text-soft focus-visible:ring-2 focus-visible:ring-ai-500"
          />
        </div>

        {/* Customers & Multi-Lead Dropdown List */}
        <div className="max-h-72 overflow-y-auto space-y-2 pr-1">
          {isError ? (
            <div className="rounded-xl border border-danger-border bg-danger-surface p-4 text-center text-xs text-danger-text space-y-2">
              <div className="flex items-center justify-center gap-1.5 font-bold">
                <AlertTriangle className="h-4 w-4 text-danger shrink-0" />
                <span>Failed to load contacts and leads</span>
              </div>
              <p className="text-[11px] text-text-secondary">
                {errorMessage || 'A network error occurred while retrieving leads and customer data.'}
              </p>
              {onRetry && (
                <Button type="button" variant="outline" size="sm" onClick={onRetry} className="h-7 px-3 text-xs gap-1.5">
                  <RefreshCw className="h-3 w-3" />
                  <span>Retry</span>
                </Button>
              )}
            </div>
          ) : isLoading && filteredCustomers.length === 0 ? (
            <div className="py-8 flex flex-col items-center justify-center gap-2 text-xs text-text-soft">
              <RefreshCw className="h-4 w-4 animate-spin text-ai-600" />
              <span>Loading contacts and leads from database...</span>
            </div>
          ) : filteredCustomers.length === 0 ? (
            <div className="py-6 text-center text-xs text-text-soft">
              No contacts or leads found matching your search.
            </div>
          ) : (
            filteredCustomers.map((customer) => {
              const allCustomerLeadIds = customer.leads.map((l) => l.id);
              const hasAnyLeadSelected =
                customer.leads.length > 0 &&
                customer.leads.some((l) => selectedLeadIds.includes(l.id));

              const customerCheckedState: boolean =
                hasAnyLeadSelected || selectedCustomerIds.includes(customer.id);
              const isDropdownOpen = expandedCustomerId === customer.id;

              return (
                <div
                  key={customer.id}
                  className="rounded-lg border border-border/70 bg-surface-light transition-all shadow-xs"
                >
                  {/* Customer Row Header */}
                  <div
                    className={cn(
                      'flex items-center gap-3 p-2.5 transition-colors cursor-pointer rounded-lg hover:bg-background-light',
                      isDropdownOpen && 'bg-background-light/70 rounded-b-none border-b border-border/40'
                    )}
                    onClick={() => {
                      setExpandedCustomerId(
                        expandedCustomerId === customer.id ? null : customer.id
                      );
                    }}
                  >
                    {/* Customer Checkbox */}
                    <div
                      className="shrink-0"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Checkbox
                        checked={customerCheckedState}
                        onCheckedChange={() =>
                          toggleCustomerSelection(customer.id, allCustomerLeadIds)
                        }
                        aria-label={`Select customer ${customer.name} for watcher`}
                      />
                    </div>

                    {/* Customer info */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-xs font-bold text-text-primary">
                          {customer.name}
                        </p>
                        {customer.company && customer.company !== customer.name && (
                          <span className="hidden sm:inline-block truncate text-[11px] text-text-soft">
                            · {customer.company}
                          </span>
                        )}
                      </div>
                      {customer.email && (
                        <p className="truncate text-[11px] font-mono text-text-soft">
                          {customer.email}
                        </p>
                      )}
                    </div>

                    {/* Stats & expand */}
                    <div className="flex items-center gap-2 shrink-0">
                      {customer.leads.filter(
                        (l) => selectedLeadIds.includes(l.id) && isLeadOverdue(l, leadStages, effectiveIsActive, effectiveActivatedAt)
                      ).length > 0 && (
                        <span className="flex items-center gap-1 rounded-full bg-danger-surface border border-danger-border px-2 py-0.5 text-[10px] font-bold text-danger-text shadow-xs">
                          <span className="h-1.5 w-1.5 rounded-full bg-danger animate-pulse" />
                          {customer.leads.filter(
                            (l) => selectedLeadIds.includes(l.id) && isLeadOverdue(l, leadStages, effectiveIsActive, effectiveActivatedAt)
                          ).length}{' '}
                          alert
                          {customer.leads.filter(
                            (l) => selectedLeadIds.includes(l.id) && isLeadOverdue(l, leadStages, effectiveIsActive, effectiveActivatedAt)
                          ).length === 1
                            ? ''
                            : 's'}
                        </span>
                      )}

                      <span className="flex items-center gap-1 rounded-full bg-ai-50 border border-ai-200 px-2 py-0.5 text-[10px] font-semibold text-ai-strong">
                        {customer.leads.length} lead{customer.leads.length === 1 ? '' : 's'}
                      </span>

                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Toggle leads for ${customer.name}`}
                        aria-expanded={isDropdownOpen}
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedCustomerId(
                            expandedCustomerId === customer.id ? null : customer.id
                          );
                        }}
                        className="h-6 w-6 p-0"
                      >
                        <ChevronDown
                          className={cn(
                            'h-4 w-4 text-text-soft transition-transform duration-200',
                            isDropdownOpen && 'rotate-180 text-ai-600'
                          )}
                        />
                      </Button>
                    </div>
                  </div>

                  {/* Dropdown displaying leads */}
                  {isDropdownOpen && (
                    <div className="p-2.5 bg-background-light/40 space-y-2 border-t border-border/40">
                      <div className="flex items-center justify-between px-1">
                        <span className="text-[11px] font-bold uppercase tracking-wider text-text-secondary">
                          Leads for {customer.name}
                        </span>
                        <span className="text-[10px] text-text-soft">
                          Select individual leads for Spider alerts
                        </span>
                      </div>

                      {customer.leads.length === 0 ? (
                        <p className="text-xs text-text-soft py-2 px-1">
                          No active leads found for this customer.
                        </p>
                      ) : (
                        <div className="space-y-1.5">
                          {customer.leads.map((lead) => {
                            const isLeadChecked = selectedLeadIds.includes(lead.id);
                            const isOverdue = isLeadOverdue(lead, leadStages, effectiveIsActive, effectiveActivatedAt);
                            const isAlertActive = isLeadChecked && isOverdue;

                            return (
                              <div
                                key={lead.id}
                                className={cn(
                                  'flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-md p-2 border transition-colors',
                                  isAlertActive
                                    ? 'border-danger-border bg-danger-surface/40 hover:bg-danger-surface/60'
                                    : isLeadChecked
                                    ? 'border-ai-200 bg-ai-50/40 hover:bg-ai-50/60'
                                    : 'border-border/60 bg-surface-light/60 opacity-65 hover:opacity-100'
                                )}
                              >
                                <div className="flex items-center gap-2.5 min-w-0">
                                  <div
                                    className="shrink-0"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <Checkbox
                                      checked={isLeadChecked}
                                      onCheckedChange={() =>
                                        toggleLeadSelection(lead.id, customer.id, allCustomerLeadIds)
                                      }
                                      aria-label={`Select lead ${lead.leadNumber} for notifications`}
                                    />
                                  </div>
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <Button
                                        type="button"
                                        variant="link"
                                        size="sm"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleLeadClick(lead.id);
                                        }}
                                        className="h-auto p-0 font-mono text-xs font-bold text-left cursor-pointer"
                                        title={`View Lead Overview for ${lead.leadNumber}`}
                                        aria-label={`Open Lead Overview for ${lead.leadNumber}`}
                                      >
                                        {lead.leadNumber}
                                      </Button>
                                      <span
                                        className={cn(
                                          'text-[10px] font-medium',
                                          isAlertActive ? 'text-danger-text font-bold' : 'text-text-soft'
                                        )}
                                      >
                                        {lead.elapsedValue} {lead.elapsedUnit}
                                        {lead.elapsedValue > 1 ? 's' : ''} in stage
                                      </span>
                                      {formatLastCommunicationTimestamp(lead.contactedAt) && (
                                        <span className="text-[10px] text-text-soft">
                                          · Last Comm: {formatLastCommunicationTimestamp(lead.contactedAt)}
                                        </span>
                                      )}
                                      <span
                                        className={cn(
                                          'rounded px-1.5 py-0.5 text-[10px] font-bold',
                                          isAlertActive
                                            ? 'bg-danger-surface border border-danger-border text-danger-text'
                                            : 'bg-ai-50 border border-ai-200 text-ai-strong'
                                        )}
                                      >
                                        {formatCurrentStageName(lead.stageLabel || lead.stageId)}
                                      </span>
                                      {isAlertActive && (
                                        <span className="rounded-full bg-danger-surface border border-danger-border px-1.5 py-0.5 text-[10px] font-bold text-danger-text inline-flex items-center gap-1 shadow-xs">
                                          <span className="h-1.5 w-1.5 rounded-full bg-danger animate-pulse" />
                                          Alert: Overdue
                                        </span>
                                      )}
                                    </div>
                                    <div
                                      className="truncate text-[11px] text-text-secondary font-medium flex items-center gap-1 mt-0.5 cursor-pointer hover:text-text-primary transition-colors"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleLeadClick(lead.id);
                                      }}
                                      title={lead.serviceLocation || 'No service location specified'}
                                    >
                                      <MapPin className="h-3 w-3 text-text-soft shrink-0" />
                                      <span className="truncate">
                                        {lead.serviceLocation || 'No service location specified'}
                                      </span>
                                    </div>
                                  </div>
                                </div>

                                <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
                                  {(lead.assignedToName || getSpiderLeadOwnerName(lead)) && (
                                    <span className="inline-flex items-center gap-1 rounded bg-surface-light border border-border px-2 py-0.5 text-[10px] font-medium text-text-secondary">
                                      <User className="h-3 w-3 text-text-soft" />
                                      {lead.assignedToName || getSpiderLeadOwnerName(lead)}
                                    </span>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

/** SpiderConfigPanel renders the dedicated modal for Spider AI Agent */
export function SpiderConfigPanel({ agent, onOpenChange, onBook }: SpiderConfigPanelProps) {
  const navigate = useNavigate();
  const setAiCenterOpen = useAiCenterStore((s) => s.setOpen);
  const queryClient = useQueryClient();
  const isSpider = agent?.id === 'spider' || agent?.name.toLowerCase() === 'spider';
  const [spiderViewMode, setSpiderViewMode] = useState<'preview' | 'config'>('preview');
  const [isSaved, setIsSaved] = useState(false);

  const storeIsActive = useSpiderWatcherStore((s) => s.isActive);
  const { data: serverConfig } = useSpiderServerConfig({ enabled: Boolean(agent && isSpider) });
  const isSpiderActive = Boolean(
    agent && isSpider && (serverConfig !== undefined ? serverConfig?.isActive : storeIsActive)
  );

  const { data: apiRoles } = useRoles();
  const { data: apiUsers } = useUsers();

  const availableRoles: SystemRoleItem[] = useMemo(() => {
    if (Array.isArray(apiRoles) && apiRoles.length > 0) {
      return apiRoles.map((r) => ({
        id: r.role,
        label: r.label,
        description:
          r.description ||
          (DEFAULT_SYSTEM_ROLES.find((d) => d.id === r.role)?.description ?? `${r.label} role`),
      }));
    }
    return DEFAULT_SYSTEM_ROLES;
  }, [apiRoles]);

  const availableUsers: AssignmentUserItem[] = useMemo(() => {
    if (Array.isArray(apiUsers) && apiUsers.length > 0) {
      return apiUsers.map((u) => {
        const roleMatch = availableRoles.find((r) => r.id === u.role);
        return {
          id: u.id,
          name: `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email,
          email: u.email,
          role: u.role,
          roleLabel: roleMatch?.label || u.role,
          avatar_url: u.avatar_url,
        };
      });
    }
    return DEFAULT_ASSIGNMENT_USERS;
  }, [apiUsers, availableRoles]);

  const storeNotifications = useSpiderWatcherStore((s) => s.notifications);
  const storeAssignments = useSpiderWatcherStore((s) => s.assignments);
  const storeLeadStages = useSpiderWatcherStore((s) => s.leadStages);
  const storeCustomers = useSpiderWatcherStore((s) => s.customers);
  const storeSelectedCustomerIds = useSpiderWatcherStore((s) => s.selectedCustomerIds);
  const storeSelectedLeadIds = useSpiderWatcherStore((s) => s.selectedLeadIds);
  const setStoreCustomers = useSpiderWatcherStore((s) => s.setCustomers);

  const [draftNotifications, setDraftNotifications] = useState<SpiderNotificationsConfig>(storeNotifications);
  const [draftAssignments, setDraftAssignments] = useState<SpiderAssignmentsConfig>(normalizeAssignments(storeAssignments));
  const [draftLeadStages, setDraftLeadStages] = useState<LeadStageConfig[]>(storeLeadStages);
  const [draftSelectedCustomerIds, setDraftSelectedCustomerIds] = useState<string[]>(
    isSpiderActive ? storeSelectedCustomerIds : []
  );
  const [draftSelectedLeadIds, setDraftSelectedLeadIds] = useState<string[]>(
    isSpiderActive ? storeSelectedLeadIds : []
  );
  const [hasDraftModifiedSelection, setHasDraftModifiedSelection] = useState<boolean>(false);
  const storeAutoEnrollAllLeads = useSpiderWatcherStore((s) => s.autoEnrollAllLeads);
  const [draftAutoEnrollNewLeads, setDraftAutoEnrollNewLeads] = useState<boolean>(storeAutoEnrollAllLeads ?? true);

  // Fetch actual real leads from the Leads API only when Spider modal is active (BUG-7)
  const { data: apiLeads, isLoading: isLeadsLoading, refetch: refetchLeads } = useQuery({
    queryKey: ['spider-watcher-leads-real'],
    enabled: isSpider,
    queryFn: async () => {
      const res = await api.get('/api/leads', { params: { limit: 100 } });
      const raw = res?.data?.leads || res?.data?.data || (Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []));
      return Array.isArray(raw) ? raw : [];
    },
    staleTime: 30_000,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
  });

  const { data: apiCustomers, isLoading: isCustomersLoading, refetch: refetchCustomers } = useQuery({
    queryKey: ['spider-watcher-customers-real'],
    enabled: isSpider,
    queryFn: async () => {
      const res = await api.get('/api/customers', { params: { limit: 100 } });
      const raw = res?.data?.customers || res?.data?.data || (Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []));
      return Array.isArray(raw) ? raw : [];
    },
    staleTime: 30_000,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (
      (Array.isArray(apiLeads) && apiLeads.length > 0) ||
      (Array.isArray(apiCustomers) && apiCustomers.length > 0)
    ) {
      const live = buildWatcherCustomersFromLive(
        apiLeads || [],
        apiCustomers || [],
        useSpiderWatcherStore.getState().activatedAt
      );
      setStoreCustomers(live);
    }
  }, [apiLeads, apiCustomers, setStoreCustomers]);

  useEffect(() => {
    if (agent && isSpider) {
      refetchLeads();
      refetchCustomers();
      const storeState = useSpiderWatcherStore.getState();
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDraftNotifications({ ...storeState.notifications });
      setDraftAssignments(normalizeAssignments(storeState.assignments));
      setDraftLeadStages(storeState.leadStages.map((s) => ({ ...s })));
      if (!isSpiderActive) {
        setDraftSelectedCustomerIds([]);
        setDraftSelectedLeadIds([]);
        setHasDraftModifiedSelection(true);
      } else {
        setDraftSelectedCustomerIds([...storeState.selectedCustomerIds]);
        setDraftSelectedLeadIds([...storeState.selectedLeadIds]);
        setHasDraftModifiedSelection(storeState.hasUserModifiedSelection);
      }
      setDraftAutoEnrollNewLeads(storeState.autoEnrollAllLeads ?? true);
      setIsSaved(false);
      setSpiderViewMode('preview');
    }
  }, [agent, isSpider, isSpiderActive, refetchLeads, refetchCustomers]);

  const updateDraftLeadStage = (id: string, updates: Partial<LeadStageConfig>) => {
    setDraftLeadStages((prev) =>
      prev.map((stage) => (stage.id === id ? { ...stage, ...updates } : stage))
    );
  };

  const toggleCustomerSelection = (customerId: string, leadIdsForCustomer: string[]) => {
    setHasDraftModifiedSelection(true);
    const allLeadsSelected =
      leadIdsForCustomer.length > 0 &&
      leadIdsForCustomer.every((id) => draftSelectedLeadIds.includes(id));
    const isSelected =
      draftSelectedCustomerIds.includes(customerId) &&
      (leadIdsForCustomer.length === 0 || allLeadsSelected);

    let newCustomerIds: string[];
    let newLeadIds: string[];

    if (isSelected) {
      newCustomerIds = draftSelectedCustomerIds.filter((id) => id !== customerId);
      newLeadIds = draftSelectedLeadIds.filter((id) => !leadIdsForCustomer.includes(id));
    } else {
      newCustomerIds = Array.from(new Set([...draftSelectedCustomerIds, customerId]));
      newLeadIds = Array.from(new Set([...draftSelectedLeadIds, ...leadIdsForCustomer]));
    }

    setDraftSelectedCustomerIds(newCustomerIds);
    setDraftSelectedLeadIds(newLeadIds);
  };

  const toggleLeadSelection = (
    leadId: string,
    customerId: string,
    allLeadIdsForCustomer: string[]
  ) => {
    setHasDraftModifiedSelection(true);
    const isLeadSelected = draftSelectedLeadIds.includes(leadId);
    let newLeadIds: string[];

    if (isLeadSelected) {
      newLeadIds = draftSelectedLeadIds.filter((id) => id !== leadId);
    } else {
      newLeadIds = [...draftSelectedLeadIds, leadId];
    }

    const hasAnySelectedLead = allLeadIdsForCustomer.some((id) => newLeadIds.includes(id));
    let newCustomerIds = draftSelectedCustomerIds;

    if (hasAnySelectedLead && !draftSelectedCustomerIds.includes(customerId)) {
      newCustomerIds = [...draftSelectedCustomerIds, customerId];
    } else if (!hasAnySelectedLead && draftSelectedCustomerIds.includes(customerId)) {
      newCustomerIds = draftSelectedCustomerIds.filter((id) => id !== customerId);
    }

    setDraftSelectedLeadIds(newLeadIds);
    setDraftSelectedCustomerIds(newCustomerIds);
  };

  const selectAllCustomers = () => {
    setHasDraftModifiedSelection(true);
    const allowedCustomers = storeCustomers
      .map((c) => ({
        ...c,
        leads: (c.leads || []).filter((l) => isLeadInAllowedAlertStage(l)),
      }))
      .filter((c) => c.leads.length > 0);
    setDraftSelectedCustomerIds(allowedCustomers.map((c) => c.id));
    setDraftSelectedLeadIds(allowedCustomers.flatMap((c) => c.leads.map((l) => l.id)));
  };

  const deselectAllCustomers = () => {
    setHasDraftModifiedSelection(true);
    setDraftSelectedCustomerIds([]);
    setDraftSelectedLeadIds([]);
  };

  const handleActivate = async () => {
    const hasAtLeastOneThreshold = draftLeadStages.some(
      (s) => s.duration !== undefined && s.duration !== null && !isNaN(s.duration) && s.enabled !== false && Number(s.duration) > 0
    );

    if (!hasAtLeastOneThreshold) {
      toast.error('Threshold required', {
        description: 'Please configure at least one stage duration threshold before activating Spider.',
      });
      return;
    }

    const stageThresholdsMap: Record<string, { value?: number; unit: string; enabled: boolean }> = {};
    draftLeadStages.forEach((s) => {
      stageThresholdsMap[s.id] = {
        value: s.duration,
        unit: s.unit || 'minutes',
        enabled: Boolean(s.enabled),
      };
    });

    try {
      const res = await api.put('/api/ai-farm/spider/config', {
        isActive: true,
        autoEnrollAllLeads: draftAutoEnrollNewLeads,
        selectedLeadIds: draftSelectedLeadIds,
        stageThresholds: stageThresholdsMap,
        notifications: draftNotifications,
        assignments: draftAssignments,
      });

      if (res?.data?.config) {
        queryClient.setQueryData(SPIDER_CONFIG_QUERY_KEY, res.data.config);
      }
      await queryClient.invalidateQueries({ queryKey: SPIDER_CONFIG_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: ['spider-alert-db-logs'] });

      const nowIso = new Date().toISOString();
      useSpiderWatcherStore.setState({
        isActive: true,
        activatedAt: nowIso,
        autoEnrollAllLeads: draftAutoEnrollNewLeads,
        notifications: draftNotifications,
        assignments: draftAssignments,
        leadStages: draftLeadStages,
        selectedCustomerIds: draftSelectedCustomerIds,
        selectedLeadIds: draftSelectedLeadIds,
        hasUserModifiedSelection: true,
      });

      toast.success('Spider Agent Activated', {
        description: 'Pipeline watcher is now monitoring overdue leads on the server.',
      });
      onOpenChange(false);
    } catch (err: unknown) {
      console.error('Failed to save Spider config:', err);
      const errorObj = err as { response?: { data?: { error?: string } } };
      toast.error('Failed to save configuration', {
        description: errorObj?.response?.data?.error || 'Could not update Spider configuration on the server.',
      });
    }
  };

  return (
    <Dialog open={!!agent} onOpenChange={onOpenChange}>
      <DialogContent
        overlayClassName="bg-ocean-900/40"
        className="flex max-h-[92vh] w-[96vw] max-w-4xl flex-col gap-0 overflow-hidden p-0"
      >
        <VisuallyHidden>
          <DialogTitle>
            {agent.name} — {agent.role}
          </DialogTitle>
        </VisuallyHidden>

        {/* Header */}
        <div className="flex items-center justify-between border-b border-border bg-surface-light p-6 pr-14">
          <div className="flex items-center gap-4">
            <Avatar ring="ai" className="h-14 w-14 shrink-0">
              {agent.image && (
                <AvatarImage src={agent.image} alt={agent.name} className="object-cover" />
              )}
              <AvatarFallback
                tone="custom"
                style={{ backgroundColor: agent.avatarColor }}
                className="text-lg font-bold"
              >
                {agent.name[0]}
              </AvatarFallback>
            </Avatar>
            <div>
              <div className="flex items-center gap-2">
                <Heading level={2} scale="xl" weight="bold">{agent.name}</Heading>
                <span
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-bold',
                    isSpiderActive
                      ? 'bg-success-surface border-success-border text-success-text'
                      : 'bg-danger-surface border-danger-border text-danger-text'
                  )}
                >
                  <span
                    className={cn(
                      'inline-block h-2 w-2 min-w-[8px] min-h-[8px] rounded-full shrink-0',
                      isSpiderActive ? 'bg-success animate-pulse' : 'bg-danger'
                    )}
                  />
                  {isSpiderActive ? 'Active' : 'Deactivated'}
                </span>
              </div>
              <p className="text-xs font-semibold uppercase tracking-wide text-ai-600">
                {agent.role}
              </p>
            </div>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              onOpenChange(false);
              setAiCenterOpen(false);
              navigate('/spider');
            }}
            className="gap-1.5"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Full Configuration
          </Button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          <SpiderWatcherConfig
            notifications={draftNotifications}
            setNotifications={setDraftNotifications}
            assignments={draftAssignments}
            setAssignments={setDraftAssignments}
            leadStages={draftLeadStages}
            updateLeadStage={updateDraftLeadStage}
            selectedCustomerIds={draftSelectedCustomerIds}
            selectedLeadIds={draftSelectedLeadIds}
            toggleCustomerSelection={toggleCustomerSelection}
            toggleLeadSelection={toggleLeadSelection}
            selectAllCustomers={selectAllCustomers}
            deselectAllCustomers={deselectAllCustomers}
            storeCustomers={storeCustomers}
            availableRoles={availableRoles}
            availableUsers={availableUsers}
            isLoading={isLeadsLoading || isCustomersLoading}
            onCloseModal={() => onOpenChange(false)}
            isActive={isSpiderActive}
            activatedAt={useSpiderWatcherStore.getState().activatedAt}
            autoEnrollNewLeads={draftAutoEnrollNewLeads}
            onAutoEnrollChange={setDraftAutoEnrollNewLeads}
          />
        </div>

        {/* Footer */}
        <div className="border-t border-border bg-surface-light px-6 py-4 flex items-center justify-between gap-3">
          <div className="text-xs text-text-secondary">
            {!isSpiderActive && 'Spider is currently switched off. Configure thresholds and click Activate to begin monitoring.'}
          </div>

          <Button
            type="button"
            variant="solid"
            tone="ai"
            onClick={handleActivate}
            className="gap-1.5 font-semibold px-6"
          >
            <CheckCircle2 className="h-4 w-4" />
            {isSpiderActive ? 'Update Configuration' : 'Activate Spider'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export interface SpiderSaveConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notifications: SpiderNotificationsConfig;
  assignments: SpiderAssignmentsConfig;
  leadStages: LeadStageConfig[];
  selectedLeadIds: string[];
  selectedCustomerIds: string[];
  storeCustomers: WatcherCustomer[];
  availableRoles: SystemRoleItem[];
  availableUsers: AssignmentUserItem[];
  autoEnrollAllLeads?: boolean;
  onConfirm: () => void;
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
  selectedLeadIds,
  selectedCustomerIds,
  storeCustomers,
  availableRoles,
  availableUsers,
  autoEnrollAllLeads = true,
  onConfirm,
}: SpiderSaveConfirmDialogProps) {
  const selectedLeadCount = selectedLeadIds.length;
  const selectedCustomerCount = selectedCustomerIds.length;

  // Build the list of selected leads
  const selectedLeadsList = useMemo(() => {
    const list: Array<{
      customer: Partial<WatcherCustomer>;
      lead: Partial<WatcherLead> & { id: string };
    }> = [];
    if (!selectedLeadIds || selectedLeadIds.length === 0) return list;

    const matchedIds = new Set<string>();
    if (storeCustomers) {
      for (const customer of storeCustomers) {
        if (!customer.leads) continue;
        for (const lead of customer.leads) {
          if (selectedLeadIds.includes(lead.id) && isLeadInAllowedAlertStage(lead)) {
            list.push({ customer, lead });
            matchedIds.add(lead.id);
          }
        }
      }
    }

    // Fallback for any selected leads not found in storeCustomers
    for (const leadId of selectedLeadIds) {
      if (!matchedIds.has(leadId)) {
        list.push({
          customer: { name: 'Customer Account' },
          lead: { id: leadId, leadNumber: leadId, stageLabel: 'Active Lead' },
        });
      }
    }

    return list;
  }, [storeCustomers, selectedLeadIds]);

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

  const [isLeadsExpanded, setIsLeadsExpanded] = useState(false);
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
      toast.error('Cannot Activate Spider Agent', {
        description: validationErrors.map((v) => `${v.section}: ${v.prompt}`).join(' | '),
      });
      return;
    }
    onConfirm();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        overlayClassName="bg-ocean-900/40"
        className="flex max-h-[90vh] w-[95vw] max-w-2xl flex-col gap-0 overflow-hidden p-0"
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-border bg-surface-light px-6 py-4">
          <div className="flex items-center gap-3">
            <Avatar ring="ai" className="h-10 w-10 shrink-0">
              <AvatarImage src="/ai-center/agents/spider.png" alt="Spider Agent" className="object-cover" />
              <AvatarFallback tone="subtle" className="text-sm font-bold">
                S
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
          {/* Disclaimer / Before You Activate */}
          <div className="rounded-xl border border-ai-200 bg-ai-50/60 p-4 flex items-start gap-3 shadow-xs">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-ai-50 border border-ai-200 text-ai-600 mt-0.5">
              <Info className="h-4 w-4" />
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-bold text-text-primary">Before You Activate</p>
              <p className="text-xs text-text-secondary leading-relaxed">
                Please review your selected leads, notification channels, recipients, and alert settings before activating this Spider campaign.
              </p>
              <p className="text-xs text-text-secondary leading-relaxed">
                Once activated, Spider will begin monitoring your selected leads based on the conditions you&apos;ve configured. When a relevant condition is detected, Spider will prepare an alert and send it to the selected recipients through your chosen notification channels.
              </p>
            </div>
          </div>

          {/* Missing Validation Error Callout */}
          {showValidationFeedback && validationErrors.length > 0 && (
            <div className="rounded-xl border border-danger/30 bg-danger/10 p-3.5 text-xs text-danger space-y-1.5 animate-in fade-in-0 duration-150">
              <p className="font-bold flex items-center gap-1.5">
                <AlertTriangle className="h-4 w-4" />
                Required Items Missing Before Activation ({validationErrors.length})
              </p>
              <p className="text-[11px] opacity-90">
                At least one item must be selected from every required section before activating:
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
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <Users className="h-4 w-4 text-ai-600 shrink-0" />
                  <span className="text-xs font-bold text-text-primary uppercase tracking-wider">
                    Monitored Pipeline Targets
                  </span>
                  {autoEnrollAllLeads && (
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-ai-50 border border-ai-200 text-ai-600">
                      Auto-Enrolled
                    </span>
                  )}
                </div>
                <p className="text-xs text-text-secondary">
                  {autoEnrollAllLeads
                    ? 'All incoming and active pipeline leads are automatically enrolled in multi-stage tracking.'
                    : `Monitoring ${selectedLeadCount} lead${selectedLeadCount === 1 ? '' : 's'} across ${selectedCustomerCount} customer account${selectedCustomerCount === 1 ? '' : 's'}.`}
                </p>
              </div>

              {selectedLeadsList.length > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setIsLeadsExpanded((prev) => !prev)}
                  className="h-auto gap-1.5 px-3 py-1 text-xs font-bold cursor-pointer active:scale-95 transition-all select-none shrink-0"
                  title={isLeadsExpanded ? "Click to collapse monitored leads" : "Click to view monitored leads"}
                >
                  <span>{selectedLeadCount} Leads Selected</span>
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 transition-transform duration-200",
                      isLeadsExpanded ? "rotate-180" : ""
                    )}
                  />
                </Button>
              )}
            </div>

            {isLeadsExpanded && selectedLeadsList.length > 0 && (
              <div className="mt-3.5 pt-3.5 border-t border-border/70 space-y-1.5 max-h-72 overflow-y-auto pr-1 animate-in fade-in-0 duration-150">
                {selectedLeadsList.map(({ customer, lead }) => {
                  const stageName = formatCurrentStageName(lead.stageLabel || lead.stageId);
                  const ownerName = lead.assignedToName || getSpiderLeadOwnerName(lead) || 'Unassigned';
                  return (
                    <div
                      key={lead.id}
                      className="flex items-center justify-between gap-2.5 p-2.5 rounded-xl border border-border/60 bg-background-light/40 text-xs"
                    >
                      <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-text-primary truncate max-w-[140px]">{customer.name}</span>
                        <span className="rounded bg-ai-50 border border-ai-200 px-1.5 py-0.5 text-[10px] font-mono font-bold text-ai-600">
                          {lead.leadNumber || lead.id}
                        </span>
                        <span className="rounded bg-surface-light border border-border px-1.5 py-0.5 text-[10px] font-semibold text-text-secondary">
                          {stageName}
                        </span>
                      </div>
                      <span className="shrink-0 inline-flex items-center gap-1 rounded bg-surface-light border border-border px-2 py-0.5 text-[11px] font-medium text-text-secondary">
                        <User className="h-3 w-3 text-text-soft" />
                        {ownerName}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
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
                        className="h-auto gap-1.5 px-3 py-1 text-xs font-bold cursor-pointer active:scale-95 transition-all select-none shrink-0"
                      >
                        <span>{roleNames.length} Role{roleNames.length === 1 ? '' : 's'} Selected</span>
                        <ChevronDown className="h-3.5 w-3.5 transition-transform duration-200" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent
                      align="end"
                      sideOffset={6}
                      className="z-[130] w-56 p-1 overflow-hidden animate-in fade-in-0 zoom-in-95 duration-150"
                    >
                      <div className="space-y-0.5 max-h-56 overflow-y-auto">
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
                        className="h-auto gap-1.5 px-3 py-1 text-xs font-bold cursor-pointer active:scale-95 transition-all select-none shrink-0"
                      >
                        <span>{specificUserNames.length} Users Selected</span>
                        <ChevronDown className="h-3.5 w-3.5 transition-transform duration-200" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent
                      align="end"
                      sideOffset={6}
                      className="z-[130] w-56 p-1 overflow-hidden animate-in fade-in-0 zoom-in-95 duration-150"
                    >
                      <div className="space-y-0.5 max-h-56 overflow-y-auto">
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
            className="gap-1.5 font-semibold px-6"
            title="Activate Spider Agent"
          >
            <CheckCircle2 className="h-4 w-4" />
            Active
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

