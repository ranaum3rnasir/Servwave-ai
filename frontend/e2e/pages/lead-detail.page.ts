import { type Page, type Locator, expect } from '@playwright/test';
import { BasePage } from './base.page';

export class LeadDetailPage extends BasePage {
  readonly heroCard: Locator;
  readonly actionsMenuButton: Locator;
  readonly editButton: Locator;
  readonly assignButton: Locator;
  readonly markLostButton: Locator;

  constructor(page: Page) {
    super(page);
    this.heroCard = page.locator('.rounded-xl.bg-white').first();
    this.actionsMenuButton = page.getByRole('button', { name: /Lead actions/i });
    this.editButton = page.getByRole('menuitem', { name: 'Edit' });
    this.assignButton = page.getByRole('menuitem', { name: 'Assign' });
    this.markLostButton = page.getByRole('menuitem', { name: 'Mark Lost' });
  }

  /** Navigate to a specific lead detail page */
  async goto(leadId: string) {
    await this.page.goto(`/leads/${leadId}`);
    await this.page.waitForLoadState('networkidle');
  }

  /** Get the lead title text */
  async getTitle(): Promise<string> {
    const heading = this.page.getByRole('main').getByRole('heading', { level: 1 });
    return heading.innerText();
  }

  /** Get current status text from the badge */
  async getStatus(): Promise<string> {
    // The StatusBadge is inside the StatusDropdown button
    const statusBtn = this.heroCard.locator('button').filter({ has: this.page.locator('.inline-flex.items-center.rounded-full') }).first();
    const badge = statusBtn.locator('.inline-flex.items-center.rounded-full');
    return badge.innerText();
  }

  /** Change the lead status via the custom dropdown */
  async changeStatus(statusLabel: string) {
    // Click the status dropdown button (contains StatusBadge + ChevronDown)
    const statusBtn = this.heroCard.locator('button').filter({
      has: this.page.locator('svg.h-3.w-3'),
    }).first();
    await statusBtn.click();

    // Click the status option in the dropdown
    const option = this.page.locator('button', { hasText: statusLabel });
    await option.click();

    // Wait for API to complete
    await this.page.waitForTimeout(1000);
  }

  /** Click a tab by name */
  async clickTab(name: string) {
    await this.page.getByRole('tab', { name }).click();
  }

  /** Open the "..." Lead actions menu */
  async openActionsMenu() {
    await this.actionsMenuButton.click();
  }

  /** Click Edit menu item (navigates to edit page) */
  async clickEdit() {
    await this.openActionsMenu();
    await this.editButton.click();
    await this.page.waitForURL(/\/leads\/.*\/edit/);
  }

  /** Click Assign menu item (opens the assign popover) */
  async clickAssign() {
    await this.openActionsMenu();
    await this.assignButton.click();
  }

  /** Click Mark Lost menu item (opens dialog) */
  async clickMarkLost() {
    await this.openActionsMenu();
    await this.markLostButton.click();
  }

  // ─── Tag Operations ────────────────────────────────────

  /** Add an existing tag from the suggestion dropdown */
  async addTag(name: string) {
    // Click the "+ Tag" button
    await this.page.locator('button', { hasText: 'Tag' }).last().click();

    // Wait for the search input
    const searchInput = this.page.getByPlaceholder('Type to search...');
    await expect(searchInput).toBeVisible();

    // Click the suggestion matching the name
    await this.page.locator('button', { hasText: name }).click();

    // Wait for mutation to settle
    await this.page.waitForTimeout(1000);
  }

  /** Create a new tag by typing a name that doesn't exist */
  async createTag(name: string) {
    // Click the "+ Tag" button
    await this.page.locator('button', { hasText: 'Tag' }).last().click();

    const searchInput = this.page.getByPlaceholder('Type to search...');
    await searchInput.fill(name);

    // Click "Create" option
    await this.page.locator('button', { hasText: `Create "${name}"` }).click();

    await this.page.waitForTimeout(1000);
  }

  /** Remove a tag by clicking the X on its pill */
  async removeTag(name: string) {
    const tagPill = this.page.locator('span', { hasText: name }).filter({
      has: this.page.locator('button'),
    });
    await tagPill.locator('button').click();
    await this.page.waitForTimeout(1000);
  }

  /** Get all visible tag names */
  async getTags(): Promise<string[]> {
    const tagPills = this.page.locator('.inline-flex.items-center.rounded-full.text-white');
    const count = await tagPills.count();
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
      const text = await tagPills.nth(i).innerText();
      // Remove the X icon text - just get the tag name
      names.push(text.trim().replace(/\s*$/, ''));
    }
    return names;
  }

  // ─── Notes Tab ─────────────────────────────────────────

  /** Add a note in the Notes tab */
  async addNote(text: string) {
    await this.clickTab('Notes');
    await this.page.waitForTimeout(500);

    const textarea = this.page.getByPlaceholder('Add a note...');
    await this.fillInput(textarea, text);

    await this.page.getByRole('button', { name: 'Add Note' }).click();
    await this.page.waitForTimeout(1000);
  }

  /** Get all note texts in the Notes tab */
  async getNotes(): Promise<string[]> {
    const noteCards = this.page.locator('.rounded-lg.border.border-border.p-3');
    const count = await noteCards.count();
    const notes: string[] = [];
    for (let i = 0; i < count; i++) {
      const text = await noteCards.nth(i).locator('p').first().innerText();
      notes.push(text);
    }
    return notes;
  }

  // ─── Walkthrough Tab ───────────────────────────────────

  /** Fill walkthrough data and save */
  async fillWalkthrough(data: { scheduledDate?: string; notes?: string }) {
    await this.clickTab('Walkthrough');
    await this.page.waitForTimeout(500);

    if (data.scheduledDate) {
      // datetime-local inputs need fill() — pressSequentially doesn't work for them
      const scheduledInput = this.page.locator('input[type="datetime-local"]').first();
      await scheduledInput.fill(data.scheduledDate);
    }

    if (data.notes) {
      // Walkthrough textarea uses React state (not react-hook-form),
      // but still use fillInput for consistent key event triggering
      const textarea = this.page.getByPlaceholder('Notes from the walkthrough...');
      await textarea.click();
      await textarea.pressSequentially(data.notes, { delay: 5 });
    }

    // Wait for Save button to appear (shows when wtDirty = true)
    const saveBtn = this.page.getByRole('button', { name: 'Save Walkthrough' });
    await saveBtn.waitFor({ state: 'visible', timeout: 5000 });
    await saveBtn.click();
    await this.page.waitForTimeout(1500);
  }

  /** Get assigned user name from Details tab */
  async getAssignedUser(): Promise<string> {
    await this.clickTab('Details');
    await this.page.waitForTimeout(500);
    const assignedSection = this.page.locator('text=Assigned to:').locator('..');
    const text = await assignedSection.innerText();
    return text.replace('Assigned to:', '').trim();
  }
}
