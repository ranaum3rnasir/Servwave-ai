# Leads Module — Playwright E2E Testing Plan

## Context
Unit tests (151 backend + 38 frontend) are passing but don't prove that data actually persists through the full stack. The user wants E2E tests to verify that every button works, saves persist, and CRUD operations complete against the real Supabase database. This plan adds Playwright E2E tests for the Leads module.

## Prerequisites
- Backend running on `localhost:3000` with real Supabase connection
- Frontend running on `localhost:5173` with Vite proxy to backend
- Seed user exists: `admin@alphacrm.com` / `Admin123!@#` (from `backend/src/seed.ts`)
- At least one customer in the database (for lead creation)

## Phase 1: Install & Configure Playwright

### 1a. Install Playwright
```bash
npm install --workspace=frontend -D @playwright/test
npx --workspace=frontend playwright install chromium
```

### 1b. Create `frontend/e2e/playwright.config.ts`
- Single project: Chromium only (speed over coverage for Phase 0)
- `baseURL: 'http://localhost:5173'`
- `webServer`: start both backend (port 3000) and frontend (port 5173)
- `storageState` for auth reuse (login once per suite)
- `workers: 1`, `fullyParallel: false` (shared DB, sequential execution)
- `retries: 1` (handle occasional network flakiness)
- `timeout: 30000` per test
- Output: `e2e/test-results/` for traces/screenshots

### 1c. Create `frontend/e2e/global-setup.ts`
- Launch browser, navigate to `/login`
- Fill email + password for `admin@alphacrm.com`
- Click Sign In, wait for redirect to dashboard
- Save `storageState` to `frontend/e2e/.auth/admin.json`
- This runs once before all tests

### 1d. Create `frontend/e2e/.gitignore`
- Ignore `.auth/`, `test-results/`

## Phase 2: Page Object Models

### 2a. `frontend/e2e/pages/base.page.ts`
- Constructor takes `page: Page`
- Helper: `waitForApi(urlPattern)` — wait for network response
- Helper: `getToast()` — locate success/error toast messages

### 2b. `frontend/e2e/pages/leads-list.page.ts`
- `goto()` — navigate to `/leads`
- `getKpiValue(label)` — read KPI strip value by label
- `clickNewLead()` — click "New Lead" button
- `searchLeads(term)` — type in search input
- `getTableRows()` — return all table row locators
- `clickRow(name)` — click row containing customer name
- `getRowByText(text)` — find a specific row

### 2c. `frontend/e2e/pages/lead-form.page.ts`
- `selectExistingCustomer(name)` — pick from customer dropdown
- `fillServiceRequest(text)` — fill service_request field
- `selectSource(source)` — pick lead source
- `fillEstimatedValue(value)` — fill est_value
- `submit()` — click submit button
- `waitForRedirect()` — wait for navigation to detail page

### 2d. `frontend/e2e/pages/lead-detail.page.ts`
- `getTitle()` — read lead title text
- `getStatus()` — read current status badge text
- `changeStatus(newStatus)` — click status dropdown, select status
- `clickTab(name)` — switch between Details/Estimates/Walkthrough/Notes
- `clickEdit()` / `clickAssign()` / `clickMarkLost()` — action buttons
- `addTag(name)` — click Tag button, search, click suggestion
- `createTag(name)` — click Tag button, type, click "Create"
- `removeTag(name)` — click X on tag pill
- `getTags()` — return array of tag names
- `addNote(text)` — type in note textarea, click Add
- `getNotes()` — return array of note texts
- `fillWalkthrough(data)` — fill walkthrough date/notes fields, click Save
- `getAssignedUser()` — read assigned user name

## Phase 3: Test Data Helper

### `frontend/e2e/helpers/test-data.ts`
- `createTestLead(page)` — creates a lead via the UI (New Lead flow), returns the lead name
- Uses unique timestamp suffix: `E2E Lead ${Date.now()}` to avoid collisions
- Requires at least one customer in the DB

## Phase 4: E2E Test Specs (~15 tests)

### 4a. `frontend/e2e/specs/leads-list.spec.ts` (3 tests)
1. **Page loads with KPI strip** — navigate to /leads, verify KPI labels visible
2. **Search filters results** — type in search box, verify table updates
3. **Click row navigates to detail** — click a lead row, verify URL changes to `/leads/:id`

### 4b. `frontend/e2e/specs/leads-create.spec.ts` (2 tests)
1. **Create lead with existing customer** — New Lead → select customer → fill fields → submit → verify redirect to detail page with correct data
2. **Created lead appears in list** — go back to /leads, verify the new lead is in the table

### 4c. `frontend/e2e/specs/leads-detail.spec.ts` (2 tests)
1. **Detail page loads all sections** — navigate to lead detail, verify hero, KPI strip, 4 tabs
2. **Tab switching works** — click each tab, verify content changes (Details → Estimates → Walkthrough → Notes)

### 4d. `frontend/e2e/specs/leads-edit.spec.ts` (2 tests)
1. **Edit lead fields** — click Edit → modify service_request → save → verify change persists on page reload
2. **Walkthrough save persists** — go to Walkthrough tab → fill date/notes → Save → reload → verify data still there

### 4e. `frontend/e2e/specs/leads-actions.spec.ts` (6 tests)
1. **Change status** — click status dropdown → select "CONTACTED" → verify badge updates, reload to confirm persistence
2. **Add existing tag** — click Tag → select from suggestions → verify tag pill appears, reload to confirm
3. **Create new tag** — click Tag → type unique name → click Create → verify pill appears
4. **Remove tag** — click X on tag pill → verify removed, reload to confirm
5. **Add note** — go to Notes tab → type note → click Add → verify note appears in list, reload to confirm
6. **Assign lead** — click Assign → select user → confirm → verify assigned user shows on page

## Phase 5: Scripts & Verification

### 5a. Add npm scripts
- `frontend/package.json`: `"test:e2e": "playwright test --config=e2e/playwright.config.ts"`
- Root `package.json`: `"test:e2e": "npm run test:e2e --workspace=frontend"`

### 5b. Verification
1. Start backend: `npm run dev:backend`
2. Start frontend: `npm run dev:frontend`
3. Run seed if needed: `npx ts-node backend/src/seed.ts`
4. Run E2E: `npm run test:e2e --workspace=frontend`
5. All ~15 tests should pass

## Files to Create

| File | Purpose |
|------|---------|
| `frontend/e2e/playwright.config.ts` | Playwright configuration |
| `frontend/e2e/global-setup.ts` | Auth setup (login + save storageState) |
| `frontend/e2e/.gitignore` | Ignore auth state + test results |
| `frontend/e2e/pages/base.page.ts` | Base POM with shared helpers |
| `frontend/e2e/pages/leads-list.page.ts` | Leads list page POM |
| `frontend/e2e/pages/lead-form.page.ts` | Lead creation form POM |
| `frontend/e2e/pages/lead-detail.page.ts` | Lead detail page POM |
| `frontend/e2e/helpers/test-data.ts` | Test data creation helper |
| `frontend/e2e/specs/leads-list.spec.ts` | 3 list page tests |
| `frontend/e2e/specs/leads-create.spec.ts` | 2 creation tests |
| `frontend/e2e/specs/leads-detail.spec.ts` | 2 detail page tests |
| `frontend/e2e/specs/leads-edit.spec.ts` | 2 edit/save tests |
| `frontend/e2e/specs/leads-actions.spec.ts` | 6 action tests |
| `frontend/package.json` | Add test:e2e script + playwright dep |

## Key Design Decisions
- **Chromium only** — sufficient for Phase 0, faster execution
- **Sequential tests** — shared Supabase DB means no parallel safety
- **UI-based auth** — Supabase sets localStorage tokens that are hard to replicate via API
- **No cleanup** — test data accumulates (acceptable for dev DB, uses unique timestamps)
- **Page Object Model** — maintainable, reusable across test files
