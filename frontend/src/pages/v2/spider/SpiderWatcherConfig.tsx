import { useState, type ReactNode } from 'react';
import {
  Bell,
  Mail,
  MessageSquare,
  Clock,
  ChevronDown,
  Plus,
  Minus,
  Square,
  UserCheck,
} from 'lucide-react';
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
import { cn } from '@/lib/utils';
import { fieldKindProps } from '@/ui-kit/lib/fieldKind';
import {
  type TimeUnit,
  type SpiderNotificationsConfig,
  type LeadStageConfig,
  type SpiderAssignmentsConfig,
  type SystemRoleItem,
  type AssignmentUserItem,
  DEFAULT_SYSTEM_ROLES,
  DEFAULT_ASSIGNMENT_USERS,
  getDefaultFallbackDuration,
} from '@/lib/spider/watcher';

/*
 * Spider's Configuration tab body, copied from the contractor's sandbox build
 * (`frontend/src/components/ai-center/SpiderConfigPanel.tsx` at 3bb6606, `SpiderWatcherConfig`) as
 * it is (Ran, 15 Oct). The page (SpiderPage) owns the draft and the server; this only draws it.
 *
 * Changes to his code:
 *   - The unit select's item values are the stored units (Minute / Hour / Day), so the trigger shows
 *     the unit and minutes are minutes; his values ("minutes") matched no stored unit.
 *   - `isActive` / `activatedAt` come from the server only (his fell back to a browser store).
 *   - Our design system's rules, with no visible change on a desktop: the Notifications
 *     checkboxes are named; the stage number field is a count field (a text field with a number
 *     keyboard, digits only) and the search field a search field; both are 16px on a phone
 *     (iOS zooms smaller ones) and keep a focus ring; the lead number's type size sits on the text
 *     inside its button.
 *   - A click on a Notifications row's checkbox itself no longer toggles twice (the box, then the
 *     row): the row skips it, as his Assignment rows already did.
 */

export interface SpiderWatcherConfigProps {
  notifications: SpiderNotificationsConfig;
  setNotifications: React.Dispatch<React.SetStateAction<SpiderNotificationsConfig>>;
  assignments: SpiderAssignmentsConfig;
  setAssignments: React.Dispatch<React.SetStateAction<SpiderAssignmentsConfig>>;
  leadStages: LeadStageConfig[];
  updateLeadStage: (id: string, updates: Partial<LeadStageConfig>) => void;
  availableRoles: SystemRoleItem[];
  availableUsers: AssignmentUserItem[];
  /** "Select Contacts for Alert" (#3436): the page's server-paged lead picker. */
  leadPicker: ReactNode;
}

/** Dedicated UI for Spider (AI Lead Manager) Watcher configuration */
export function SpiderWatcherConfig({
  notifications,
  setNotifications,
  assignments,
  setAssignments,
  leadStages,
  updateLeadStage,
  availableRoles,
  availableUsers,
  leadPicker,
}: SpiderWatcherConfigProps) {
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
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('button[role="checkbox"]')) return;
                setNotifications((prev) => ({ ...prev, email: !prev.email }));
              }}
            >
              <Checkbox
                checked={notifications.email}
                onCheckedChange={(checked) =>
                  setNotifications((prev) => ({ ...prev, email: !!checked }))
                }
                aria-label="Email"
              />
              <div className="flex items-center gap-2 text-xs font-semibold text-text-primary">
                <Mail className="h-3.5 w-3.5 text-text-soft" />
                <span>Email</span>
              </div>
            </div>

            <div
              className="flex items-center gap-3 rounded-lg p-2 transition-colors hover:bg-background-light cursor-pointer"
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('button[role="checkbox"]')) return;
                setNotifications((prev) => ({ ...prev, sms: !prev.sms }));
              }}
            >
              <Checkbox
                checked={notifications.sms}
                onCheckedChange={(checked) =>
                  setNotifications((prev) => ({ ...prev, sms: !!checked }))
                }
                aria-label="SMS"
              />
              <div className="flex items-center gap-2 text-xs font-semibold text-text-primary">
                <MessageSquare className="h-3.5 w-3.5 text-text-soft" />
                <span>SMS</span>
              </div>
            </div>

            <div
              className="flex items-center gap-3 rounded-lg p-2 transition-colors hover:bg-background-light cursor-pointer"
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('button[role="checkbox"]')) return;
                setNotifications((prev) => ({ ...prev, inApp: !prev.inApp }));
              }}
            >
              <Checkbox
                checked={notifications.inApp}
                onCheckedChange={(checked) =>
                  setNotifications((prev) => ({ ...prev, inApp: !!checked }))
                }
                aria-label="In-app Message"
              />
              <div className="flex items-center gap-2 text-xs font-semibold text-text-primary">
                <Bell className="h-3.5 w-3.5 text-ai-600" />
                <span>In-app Message</span>
              </div>
            </div>

            <div
              className="flex items-center gap-3 rounded-lg p-2 transition-colors hover:bg-background-light cursor-pointer"
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('button[role="checkbox"]')) return;
                setNotifications((prev) => ({ ...prev, redFrame: !prev.redFrame }));
              }}
            >
              <Checkbox
                checked={notifications.redFrame}
                onCheckedChange={(checked) =>
                  setNotifications((prev) => ({ ...prev, redFrame: !!checked }))
                }
                aria-label="Red Frame"
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
                      {...fieldKindProps('count')}
                      disabled={!isEnabled}
                      placeholder={isEnabled ? '0' : 'None'}
                      value={stage.duration !== undefined && stage.duration !== null ? stage.duration : ''}
                      onChange={(e) => {
                        const digits = e.target.value.replace(/\D/g, '');
                        const val = digits === '' ? undefined : Math.max(1, Number(digits));
                        updateLeadStage(stage.id, {
                          duration: val,
                          enabled: val !== undefined,
                        });
                      }}
                      className={cn(
                        'w-12 h-7 rounded-md border border-border bg-surface-light px-1 text-xs mobile:!text-base font-bold text-center outline-none focus-visible:ring-2 focus-visible:ring-ai-500 transition-all',
                        isEnabled
                          ? 'text-text-primary'
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
                      <SelectItem value="Minute">minutes</SelectItem>
                      <SelectItem value="Hour">hours</SelectItem>
                      <SelectItem value="Day">days</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Bottom Section — Select Contacts for Alert (#3436) */}
      {leadPicker}
    </div>
  );
}
