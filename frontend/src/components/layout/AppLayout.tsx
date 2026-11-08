import { useState, useEffect } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import Sidebar from './Sidebar';
import Header from './Header';
import { ServWaveMark } from '@/components/brand/ServWaveMark';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { AiCenterModal } from '@/components/ai-center/AiCenterModal';
import CopilotProvider from '@/components/copilot/CopilotProvider';
import { useOrganization } from '@/lib/api/organization';
import { setOrgFormattingPrefs } from '@/lib/org-format';
import { SpiderNotificationPopup } from '@/components/notifications/SpiderNotificationPopup';
import { BrowserAutomationIndicator } from '@/components/notifications/BrowserAutomationIndicator';
import { useIsDemoOrg } from '@/lib/useIsDemoOrg';
import { useSpiderWatcherStore } from '@/stores/spiderWatcherStore';

export default function AppLayout() {
  const isDemoOrg = useIsDemoOrg();
  const isSpiderActive = useSpiderWatcherStore((s) => s.isActive);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const requestLeave = useSettingsGuard((s) => s.requestLeave);

  // Hydrate org-aware currency/date formatting once the organization loads, so
  // the central formatters (formatCurrency / the formatExact* pair) honor the org's
  // configured currency + date_format across the app. (#126)
  const { data: organization } = useOrganization();
  useEffect(() => {
    if (organization) {
      setOrgFormattingPrefs({
        currency: organization.currency,
        dateFormat: organization.date_format,
      });
    }
  }, [organization?.currency, organization?.date_format]);

  // Auto-close mobile sidebar on navigation
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  return (
    <TooltipProvider>
      <div className="flex h-[100dvh] flex-col overflow-hidden">
        {/* Static top bar — brand zone + header. Never collapses. */}
        <header className="flex h-header shrink-0 items-center border-b border-border bg-surface-light">
          {/* Brand zone: hamburger toggle + ServWave wordmark (always visible).
              Deep-Ocean block flows into the sidebar below. */}
          <div className="flex h-full items-center gap-3 bg-ocean-900 px-4 text-on-fill md:w-sidebar md:shrink-0">
            {/* Desktop: collapse/expand the nav panel below */}
            <Button
              type="button"
              variant="onDark"
              size="icon"
              onClick={() => setCollapsed((c) => !c)}
              title={collapsed ? 'Expand menu' : 'Collapse menu'}
              aria-label={collapsed ? 'Expand menu' : 'Collapse menu'}
              className="hidden h-9 w-9 md:flex"
            >
              <Menu className="h-5 w-5" />
            </Button>
            {/* Mobile: open the drawer */}
            <Button
              type="button"
              variant="onDark"
              size="icon"
              onClick={() => setMobileOpen(true)}
              title="Open menu"
              aria-label="Open menu"
              className="flex h-9 w-9 md:hidden"
            >
              <Menu className="h-5 w-5" />
            </Button>
            {/* Wordmark (acts as home link) */}
            <Link
              to="/"
              aria-label="ServWave dashboard"
              onClick={(e) => {
                if (useSettingsGuard.getState().isDirty) {
                  e.preventDefault();
                  requestLeave(() => navigate('/'));
                }
              }}
              className="flex items-center gap-2 rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-on-fill/60"
            >
              <ServWaveMark className="h-6 w-auto text-on-fill" />
              <span className="hidden whitespace-nowrap text-lg font-bold tracking-tight text-on-fill sm:inline">
                Serv<span className="text-on-fill">Wave</span>
              </span>
            </Link>
          </div>

          {/* Header content (search, notifications, user avatar, AI trigger) */}
          <div className="min-w-0 flex-1">
            <Header />
          </div>
        </header>

        {/* Below top bar: sidebar + page content side by side */}
        <div className="flex min-h-0 flex-1">
          {/* Desktop sidebar */}
          <div className="hidden md:flex">
            <Sidebar collapsed={collapsed} />
          </div>

          {/* Mobile sidebar (drawer) */}
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetContent side="left" className="w-sidebar p-0">
              <VisuallyHidden>
                <SheetTitle>Navigation</SheetTitle>
              </VisuallyHidden>
              <Sidebar collapsed={false} />
            </SheetContent>
          </Sheet>

          {/* Main area */}
          <main className="flex-1 overflow-y-auto overflow-x-hidden bg-background-light p-4">
            <Outlet />
          </main>
        </div>
      </div>

      {/* Spider UI components */}
      {isSpiderActive && <BrowserAutomationIndicator />}
      <SpiderNotificationPopup />

      {/* Global AI Agentic Farm modal — opened from the sidebar */}
      <AiCenterModal />

      {/* Servy — the docked AI copilot (opened from the header pill / ⌘K) */}
      <CopilotProvider />
    </TooltipProvider>
  );
}
