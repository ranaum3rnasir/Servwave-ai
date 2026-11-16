import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBeeStore } from '@/stores/beeStore';
import { BeeHomeTab } from './tabs/BeeHomeTab';
import { BeeCallLogTab } from './tabs/BeeCallLogTab';
import { BeeQueueTab } from './tabs/BeeQueueTab';
import { BeeSkippedArchivedTab } from './tabs/BeeSkippedArchivedTab';
import { BeeAgentsTab } from './tabs/BeeAgentsTab';
import { BeeWarrantyPlansTab } from './tabs/BeeWarrantyPlansTab';
import { BeeDncTab } from './tabs/BeeDncTab';
import { BeeSetupTab } from './tabs/BeeSetupTab';
import { BeeCallDrawer } from './components/BeeCallDrawer';
import {
  LayoutDashboard,
  PhoneCall,
  ListOrdered,
  Archive,
  Bot,
  ShieldCheck,
  PhoneOff,
  SlidersHorizontal,
  ChevronRight,
  ChevronDown,
  AlertCircle,
  AlertTriangle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

export const BeeAgentView: React.FC = () => {
  const navigate = useNavigate();
  const {
    activeTab,
    setActiveTab,
    loadMetrics,
    metrics,
    settings,
    loadSettings,
    toggleMasterStatus,
    setupDone,
    isLoading,
    error,
  } = useBeeStore();

  const [isStatusPopoverOpen, setIsStatusPopoverOpen] = useState(false);
  const [isDeactivateModalOpen, setIsDeactivateModalOpen] = useState(false);
  const [isDeactivating, setIsDeactivating] = useState(false);

  const handleConfirmDeactivate = async () => {
    try {
      setIsDeactivating(true);
      await toggleMasterStatus(false);
      setIsDeactivateModalOpen(false);
      setActiveTab('setup');
    } finally {
      setIsDeactivating(false);
    }
  };

  React.useEffect(() => {
    loadMetrics();
    loadSettings();

    const intervalId = setInterval(() => {
      loadMetrics();
    }, 10000);

    const handleSync = () => {
      if (document.visibilityState === 'visible') {
        loadMetrics();
      }
    };
    window.addEventListener('focus', handleSync);
    document.addEventListener('visibilitychange', handleSync);

    return () => {
      clearInterval(intervalId);
      window.removeEventListener('focus', handleSync);
      document.removeEventListener('visibilitychange', handleSync);
    };
  }, [loadMetrics, loadSettings]);

  const totalSteps = 7;
  const currentDoneList =
    settings?.setup_config?.setupDone && Array.isArray(settings.setup_config.setupDone)
      ? settings.setup_config.setupDone.slice(0, totalSteps)
      : (setupDone || [1, 1, 1, 1, 1, 0, 0]).slice(0, totalSteps);
  const doneCount = currentDoneList.filter((d: number) => d === 1).length;
  const isAllDone = doneCount >= totalSteps;
  const isLive = Boolean(metrics?.isActive ?? settings?.is_active);

  const tabs = [
    { value: 'home', label: 'Home', icon: LayoutDashboard },
    { value: 'calls', label: 'Call Log', icon: PhoneCall },
    { value: 'queue', label: 'Queue', icon: ListOrdered },
    { value: 'skipped_archived', label: 'Skipped & Archived', icon: Archive },
    { value: 'agents', label: 'Agents', icon: Bot },
    { value: 'plans', label: 'Warranty Plans', icon: ShieldCheck },
    { value: 'dnc', label: 'Do Not Call', icon: PhoneOff },
    { value: 'setup', label: 'Setup', icon: SlidersHorizontal },
  ];

  return (
    <div className="w-full space-y-3.5 -mt-2">
      {/* Breadcrumbs matching Mockup */}
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <button
          type="button"
          onClick={() => navigate('/ai-farm')}
          className="hover:text-foreground font-medium transition-colors cursor-pointer"
        >
          AI Agentic Farm
        </button>
        <ChevronRight className="h-3 w-3 text-muted-foreground/50 shrink-0" />
        <span className="font-semibold text-foreground">Warranty Agent</span>
      </div>

      {/* Title Bar matching Mockup design */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 py-1">
        <div className="flex items-center gap-3.5 min-w-0">
          <div className="h-12 w-12 rounded-2xl bg-surface-light border border-border/80 shadow-xs flex items-center justify-center shrink-0 p-1.5 overflow-hidden">
            <img
              src="/ai-center/agents/bee.png"
              alt="Bee Agent"
              className="h-9 w-9 object-contain"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
                if (e.currentTarget.parentElement) {
                  e.currentTarget.parentElement.innerHTML =
                    '<span class="text-2xl select-none">🐝</span>';
                }
              }}
            />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight text-foreground leading-tight">
              Warranty Agent
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5 truncate sm:whitespace-normal">
              Bee calls customers before their warranty ends, offers an extension and finds new work - then hands the office a lead.
            </p>
          </div>
        </div>

        {/* Right Status & Actions (Spider-style Active / Deactivated mechanism) */}
        <div className="shrink-0 flex items-center self-start sm:self-auto">
          {error ? (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-danger-surface text-danger-text border border-danger-border select-none">
              <span className="w-2 h-2 rounded-full bg-danger" />
              Unavailable
            </span>
          ) : isLoading && !metrics && !settings ? (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-muted/60 text-muted-foreground border border-border select-none">
              <span className="w-2 h-2 rounded-full bg-muted-foreground/60 animate-pulse" />
              Loading...
            </span>
          ) : isLive ? (
            <Popover open={isStatusPopoverOpen} onOpenChange={setIsStatusPopoverOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label="Bee Status"
                  className="h-9 w-36 transition-all px-3 flex items-center justify-between cursor-pointer select-none"
                >
                  <div className="flex items-center gap-2 truncate">
                    <span className="h-2 w-2 min-w-[8px] min-h-[8px] rounded-full shrink-0 bg-success" />
                    <span className="font-bold truncate text-success-text">
                      Active
                    </span>
                  </div>
                  <ChevronDown className="h-4 w-4 opacity-75 shrink-0 text-success-text" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                sideOffset={6}
                pad={1}
                className="z-[160] w-36 overflow-hidden p-1"
              >
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setIsStatusPopoverOpen(false);
                    setIsDeactivateModalOpen(true);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setIsStatusPopoverOpen(false);
                      setIsDeactivateModalOpen(true);
                    }
                  }}
                  className="w-full flex items-center justify-start gap-2 px-3 py-2 text-xs font-semibold text-danger-text hover:bg-danger-surface hover:text-danger-strong rounded-lg transition-colors cursor-pointer select-none"
                >
                  <span className="h-2 w-2 min-w-[8px] min-h-[8px] rounded-full bg-danger shrink-0" />
                  <span>Deactivate</span>
                </div>
              </PopoverContent>
            </Popover>
          ) : (
            <div
              aria-label="Bee Status"
              className="h-9 w-36 border font-bold text-xs rounded-xl transition-all shadow-xs px-3 flex items-center gap-2 bg-danger-surface border-danger-border text-danger-text select-none"
            >
              <span className="h-2 w-2 min-w-[8px] min-h-[8px] rounded-full shrink-0 bg-danger" />
              <span className="font-bold truncate text-danger-text">
                Deactivated
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Navigation Tabs with Mockup icons and yellow setup steps count */}
      <div className="border-b border-border/80 px-1 overflow-x-auto overflow-y-hidden scrollbar-none [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
        <div role="tablist" className="flex items-center gap-5 sm:gap-6 whitespace-nowrap">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.value;
            const Icon = tab.icon;

            return (
              <button
                key={tab.value}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActiveTab(tab.value as any)}
                className={cn(
                  '-mb-px flex items-center gap-2 pb-2.5 pt-1.5 px-1 text-sm font-semibold transition-colors border-b-2 cursor-pointer select-none',
                  isActive
                    ? 'border-foreground text-foreground font-bold'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                <Icon
                  className={cn(
                    'h-4 w-4 shrink-0',
                    isActive ? 'text-foreground' : 'text-muted-foreground'
                  )}
                />
                <span>{tab.label}</span>
                {tab.value === 'setup' && (
                  <span
                    className={cn(
                      'ml-1 px-1.5 py-0.5 rounded-full text-[11px] font-bold transition-colors select-none',
                      isAllDone
                        ? 'bg-primary/10 text-primary border border-primary/20 dark:bg-primary/20'
                        : 'bg-[#fef3c7] text-[#b45309] border border-[#fde68a] dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-900'
                    )}
                  >
                    {doneCount}/{totalSteps}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Error banner if any */}
      {error && (
        <div className="p-3 bg-danger-surface border border-danger-border text-danger-text text-xs rounded-xl flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Tab Panels */}
      <div className="pt-2">
        {activeTab === 'home' && <BeeHomeTab />}
        {activeTab === 'calls' && <BeeCallLogTab />}
        {activeTab === 'queue' && <BeeQueueTab />}
        {activeTab === 'skipped_archived' && <BeeSkippedArchivedTab />}
        {activeTab === 'agents' && <BeeAgentsTab />}
        {activeTab === 'plans' && <BeeWarrantyPlansTab />}
        {activeTab === 'dnc' && <BeeDncTab />}
        {activeTab === 'setup' && <BeeSetupTab />}
      </div>

      {/* Call Detail Right-Side Drawer */}
      <BeeCallDrawer />

      {/* Deactivate Confirmation Dialog with Disclaimer */}
      <Dialog open={isDeactivateModalOpen} onOpenChange={setIsDeactivateModalOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-bold text-destructive flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Deactivate Bee Warranty Agent
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Please review what will happen when Bee is deactivated.
            </DialogDescription>
          </DialogHeader>

          <div className="p-3.5 rounded-xl border border-amber-300/80 bg-amber-50/70 dark:bg-amber-950/20 dark:border-amber-800 text-amber-950 dark:text-amber-200 space-y-2 text-xs">
            <div className="font-semibold text-xs flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />
              Deactivation Disclaimer
            </div>
            <ul className="list-disc pl-4 space-y-1 text-[11px] leading-relaxed">
              <li>All scheduled outbound warranty calls will be paused immediately.</li>
              <li>All previous configuration settings and setup progress will be reset to their defaults.</li>
              <li>To activate Bee again, an administrator must review and complete all 8 setup steps and activate from the <b>Test &amp; go live</b> tab.</li>
            </ul>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsDeactivateModalOpen(false)}
              disabled={isDeactivating}
            >
              Cancel
            </Button>
            <Button
              variant="solid"
              tone="danger"
              size="sm"
              onClick={handleConfirmDeactivate}
              disabled={isDeactivating}
              className="gap-1.5"
            >
              {isDeactivating ? 'Deactivating...' : 'Deactivate Bee'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default BeeAgentView;
