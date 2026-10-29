import { Page, Locator } from '@playwright/test';
import { BasePage } from './base.page';

export class SchedulePage extends BasePage {
  // Sidebar
  readonly sidebar: Locator;
  readonly unassignedHeading: Locator;
  readonly emptyState: Locator;
  readonly sidebarHelpText: Locator;

  // Calendar controls
  readonly todayButton: Locator;
  readonly prevButton: Locator;
  readonly nextButton: Locator;
  readonly dayButton: Locator;
  readonly weekButton: Locator;
  readonly monthButton: Locator;
  readonly standardButton: Locator;
  readonly byTechnicianButton: Locator;
  readonly staffFilterSelect: Locator;
  readonly dateLabel: Locator;

  // Calendar area
  readonly calendarCard: Locator;
  readonly loadingSpinner: Locator;

  // Conflict/error UI
  readonly scheduleAnywayButton: Locator;
  readonly conflictCancelButton: Locator;
  readonly errorDismissButton: Locator;

  // Sidebar sections
  readonly walkthroughsSectionHeader: Locator;
  readonly jobsSectionHeader: Locator;

  // View toggles
  readonly memberViewButton: Locator;
  readonly planModeButton: Locator;
  readonly planModeBanner: Locator;
  readonly openToggle: Locator;
  readonly allToggle: Locator;

  // Quick-view popup
  readonly quickViewPopup: Locator;

  constructor(page: Page) {
    super(page);

    // Sidebar — the fixed-width sidebar panel (w-60 with border-r in the actual component)
    this.sidebar = page.locator('.w-60.border-r').first();
    this.unassignedHeading = page.getByText('Unassigned Jobs');
    this.emptyState = page.getByText('All jobs are assigned');
    this.sidebarHelpText = page.getByText('Drag onto the calendar or click to assign');

    // Controls
    this.todayButton = page.getByRole('button', { name: 'Today' });
    this.prevButton = page.getByRole('button').filter({ has: page.locator('.lucide-chevron-left') });
    this.nextButton = page.getByRole('button').filter({ has: page.locator('.lucide-chevron-right') });
    // Day/Week/Month buttons render lowercase text ('day','week','month') with CSS capitalize
    this.dayButton = page.getByRole('button', { name: /^day$/i });
    this.weekButton = page.getByRole('button', { name: /^week$/i });
    this.monthButton = page.getByRole('button', { name: /^month$/i });
    this.standardButton = page.getByRole('button', { name: 'Standard' });
    this.byTechnicianButton = page.getByRole('button', { name: 'By Technician' });
    // Staff filter only appears in grouped view (after clicking By Technician)
    this.staffFilterSelect = page.locator('select').first();
    // Date label is a <span> with min-w-[180px] class
    this.dateLabel = page.locator('span').filter({ hasText: /–|,\s+\d{4}|\w+ \d{4}/ }).first();

    // Calendar
    this.calendarCard = page.locator('.rbc-calendar');
    this.loadingSpinner = page.locator('.animate-spin');

    // Conflict/error actions
    this.scheduleAnywayButton = page.getByRole('button', { name: 'Schedule Anyway' });
    this.conflictCancelButton = page.getByRole('button', { name: 'Cancel' }).last();
    this.errorDismissButton = page.getByRole('button', { name: 'Dismiss' });

    // Sidebar sections
    this.walkthroughsSectionHeader = page.getByText('Walkthroughs').first();
    this.jobsSectionHeader = page.getByText('Unassigned Jobs').or(page.getByText('Jobs')).first();

    // View toggles
    this.memberViewButton = page.getByRole('button', { name: /Member View/ });
    this.planModeButton = page.getByRole('button', { name: /Plan Mode|Planning/i });
    this.planModeBanner = page.getByText(/Plan Mode.*unconfirmed/i).first();
    this.openToggle = page.getByRole('button', { name: 'Open' });
    this.allToggle = page.getByRole('button', { name: 'All' });

    // Quick-view popup
    this.quickViewPopup = page.locator('[class*="fixed"]').filter({ hasText: /View Job|View Walkthrough/ });
  }

  async goto() {
    await this.page.goto('/schedule');
    await this.page.waitForLoadState('networkidle');
  }

  /** Get a job card in the unassigned sidebar by job number */
  getSidebarJobCard(jobNumber: string): Locator {
    return this.sidebar.locator('[class*="cursor"]').filter({ hasText: jobNumber });
  }

  /** Click a job card in the unassigned sidebar */
  async clickSidebarJob(jobNumber: string) {
    await this.getSidebarJobCard(jobNumber).click();
  }

  /** Wait for the loading spinner to disappear */
  async waitForCalendarReady() {
    await this.loadingSpinner.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
    await this.calendarCard.waitFor({ state: 'visible', timeout: 10_000 });
  }

  /** Get all visible calendar events */
  getCalendarEvents(): Locator {
    return this.page.locator('.rbc-event');
  }

  /** Get a specific event by text content */
  getCalendarEvent(text: string): Locator {
    return this.page.locator('.rbc-event').filter({ hasText: text });
  }

  /** Get resource column headers (in grouped-by-tech view) */
  getResourceHeaders(): Locator {
    return this.page.locator('.rbc-resource-cell, .rbc-header');
  }

  /** Count walkthrough cards in the sidebar walkthroughs section */
  async getWalkthroughCardCount(): Promise<number> {
    const section = this.page.locator('text=Walkthroughs').locator('..').locator('..');
    return section.locator('[draggable="true"], [class*="cursor-pointer"]').count();
  }

  /** Activate plan mode */
  async clickPlanMode() {
    await this.planModeButton.click();
    await this.page.waitForTimeout(300);
  }

  /** Switch to member view */
  async switchToMemberView() {
    await this.memberViewButton.click();
    await this.page.waitForTimeout(500);
  }

  // ─── Extended locators for UI/UX audit ───────────────────

  /** Get all rbc-event elements (standard calendar) */
  getAllEvents(): Locator {
    return this.page.locator('.rbc-event');
  }

  /** Get a calendar event by partial text match */
  getEventByText(text: string): Locator {
    return this.page.locator('.rbc-event').filter({ hasText: text });
  }

  /** Get the current time indicator line */
  get currentTimeIndicator(): Locator {
    return this.page.locator('.rbc-current-time-indicator');
  }

  /** Get the resize handles on events */
  getResizeHandles(): Locator {
    return this.page.locator('.rbc-addons-dnd-resize-ns-anchor');
  }

  /** Get the resize handle for a specific event */
  getResizeHandleFor(eventText: string): Locator {
    return this.getEventByText(eventText).locator('.rbc-addons-dnd-resize-ns-anchor');
  }

  /** Get the technician grid view container */
  get techGridView(): Locator {
    return this.page.locator('[class*="overflow-x-auto"]').first();
  }

  /** Get tech column headers in grid view */
  getTechColumnHeaders(): Locator {
    return this.page.locator('[class*="sticky"][class*="top-0"] [class*="flex-col"]');
  }

  /** Get drop zone elements in tech grid */
  getGridDropZones(): Locator {
    return this.page.locator('[data-hour]');
  }

  /** Get sidebar unassigned job cards (draggable) */
  getSidebarDraggableCards(): Locator {
    return this.sidebar.locator('[draggable="true"]');
  }

  /** Get sidebar walkthrough cards */
  getSidebarWalkthroughCards(): Locator {
    // Walkthrough cards are in the section after "Walkthroughs" header
    return this.sidebar.locator('[class*="cursor-pointer"]').filter({ hasNotText: /JOB-/ });
  }

  /** Get all sidebar cards (both walkthroughs and jobs) */
  getAllSidebarCards(): Locator {
    return this.sidebar.locator('[class*="cursor"]').filter({ has: this.page.locator('span, p') });
  }

  /** Get the conflict toast */
  get conflictToast(): Locator {
    return this.page.locator('[class*="fixed"]').filter({ hasText: /conflict/i });
  }

  /** Get ghost events (plan mode) */
  getGhostEvents(): Locator {
    return this.page.locator('[class*="dashed"]');
  }

  /** Get the empty state overlay — actual text: "No jobs scheduled this week" */
  get emptyOverlay(): Locator {
    return this.page.locator('[class*="pointer-events-none"]').filter({ hasText: /No jobs scheduled this week/i });
  }

  /** Switch to Day view */
  async switchToDayView() {
    await this.dayButton.click();
    await this.page.waitForTimeout(300);
  }

  /** Switch to Week view */
  async switchToWeekView() {
    await this.weekButton.click();
    await this.page.waitForTimeout(300);
  }

  /** Switch to Month view */
  async switchToMonthView() {
    await this.monthButton.click();
    await this.page.waitForTimeout(300);
  }

  /** Navigate to today */
  async goToToday() {
    await this.todayButton.click();
    await this.page.waitForTimeout(300);
  }

  /** Navigate to next period */
  async goToNext() {
    await this.nextButton.click();
    await this.page.waitForTimeout(300);
  }

  /** Navigate to previous period */
  async goToPrevious() {
    await this.prevButton.click();
    await this.page.waitForTimeout(300);
  }

  /** Toggle Open/All filter */
  async toggleToAll() {
    await this.allToggle.click();
    await this.page.waitForTimeout(300);
  }

  /** Toggle back to Open */
  async toggleToOpen() {
    await this.openToggle.click();
    await this.page.waitForTimeout(300);
  }

  /**
   * Take a scheduler-specific screenshot to the audit directory.
   * Returns the file path.
   */
  async takeAuditScreenshot(name: string, opts?: { fullPage?: boolean }): Promise<string> {
    const dir = 'e2e/screenshots/scheduler-audit';
    const filePath = `${dir}/${name}`;
    await this.page.screenshot({
      path: filePath,
      fullPage: opts?.fullPage ?? true,
    });
    return filePath;
  }

  /**
   * Get the bounding box of a calendar event for DnD operations.
   */
  async getEventBounds(eventText: string) {
    const event = this.getEventByText(eventText);
    await event.waitFor({ state: 'visible', timeout: 5000 });
    return event.boundingBox();
  }

  /**
   * Perform a drag-and-drop from one element to a target position.
   * Uses Playwright's native mouse operations for realistic DnD.
   */
  async dragEventTo(
    sourceText: string,
    targetX: number,
    targetY: number,
    opts?: { steps?: number }
  ) {
    const source = this.getEventByText(sourceText);
    const box = await source.boundingBox();
    if (!box) throw new Error(`Event "${sourceText}" not found or not visible`);

    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    const steps = opts?.steps ?? 10;

    await this.page.mouse.move(startX, startY);
    await this.page.mouse.down();
    // Move in incremental steps for realistic DnD
    for (let i = 1; i <= steps; i++) {
      const ratio = i / steps;
      await this.page.mouse.move(
        startX + (targetX - startX) * ratio,
        startY + (targetY - startY) * ratio,
      );
    }
    await this.page.mouse.up();
    await this.page.waitForTimeout(300);
  }

  /**
   * Drag a sidebar card to a position on the calendar.
   * Uses native HTML5 drag API simulation.
   */
  async dragSidebarCardToCalendar(
    jobNumber: string,
    targetX: number,
    targetY: number
  ) {
    const card = this.getSidebarJobCard(jobNumber);
    const box = await card.boundingBox();
    if (!box) throw new Error(`Sidebar card "${jobNumber}" not found`);

    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;

    await this.page.mouse.move(startX, startY);
    await this.page.mouse.down();
    // Move slowly to trigger dragstart
    await this.page.mouse.move(startX + 5, startY + 5, { steps: 2 });
    await this.page.waitForTimeout(100);
    await this.page.mouse.move(targetX, targetY, { steps: 15 });
    await this.page.mouse.up();
    await this.page.waitForTimeout(500);
  }

  /**
   * Right-click an event to open context menu.
   */
  async rightClickEvent(eventText: string) {
    const event = this.getEventByText(eventText);
    await event.click({ button: 'right' });
    await this.page.waitForTimeout(300);
  }

  /**
   * Get the vertical scroll position of the calendar time grid.
   */
  async getCalendarScrollTop(): Promise<number> {
    return this.page.evaluate(() => {
      const el = document.querySelector('.rbc-time-content') ||
                 document.querySelector('.rbc-calendar');
      return el?.scrollTop ?? 0;
    });
  }

  /**
   * Check if an element has text overflow (ellipsis).
   */
  async hasTextOverflow(locator: Locator): Promise<boolean> {
    return locator.evaluate((el) => {
      return el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight;
    });
  }

  /**
   * Measure sidebar dimensions.
   */
  async getSidebarDimensions(): Promise<{ width: number; height: number } | null> {
    return this.sidebar.boundingBox().then(box => box ? { width: box.width, height: box.height } : null);
  }

  /**
   * Count events visible in the calendar area.
   */
  async getVisibleEventCount(): Promise<number> {
    return this.getAllEvents().count();
  }
}
