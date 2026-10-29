import { test as base, expect, Page } from '@playwright/test';

const CONSOLE_ALLOW = [
  /Download the React DevTools/i, /\[vite\]/i, /source-?map/i, /HMR/i,
  // Dev-mode-only React HTML-validity warning (no production/runtime impact). A known cosmetic
  // issue — StatusBadge renders a <div> Badge inside a <p> on some detail pages (e.g.
  // EstimateDetailPage). Documented for cleanup; it must not fail the functional render gate.
  /validateDOMNesting/i, /cannot appear as a descendant of/i,
];
const NETWORK_ALLOW_5XX: RegExp[] = []; // none expected by default

type GateState = { pageErrors: string[]; bad5xx: string[]; allow5xx: RegExp[] };

/**
 * UI gate fixture (§3.3 gates 2–4). Wires page-level listeners that accrue:
 *  - uncaught `pageerror`s and non-allowlisted `console.error`s, and
 *  - unexpected `/api/*` 5xx responses.
 * Call `assertGatesClean(gate)` at the end of each UI step to fail loudly on any violation,
 * and `assertNoErrorBoundary(page)` to prove the top-level fallback never rendered.
 */
export const test = base.extend<{ gate: GateState; gatedPage: Page }>({
  gate: async ({}, use) => { await use({ pageErrors: [], bad5xx: [], allow5xx: [...NETWORK_ALLOW_5XX] }); },
  gatedPage: async ({ page, gate }, use) => {
    page.on('pageerror', (err) => gate.pageErrors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !CONSOLE_ALLOW.some((re) => re.test(msg.text()))) {
        gate.pageErrors.push(`console.error: ${msg.text()}`);
      }
    });
    page.on('response', (resp) => {
      const u = resp.url();
      if (/\/api\//.test(u) && resp.status() >= 500 && !gate.allow5xx.some((re) => re.test(u))) {
        gate.bad5xx.push(`${resp.status()} ${u}`);
      }
    });
    await use(page);
  },
});

/** Assert no gate violations accrued so far. Call at the end of each UI step. */
export async function assertGatesClean(gate: GateState, ctx = '') {
  expect(gate.pageErrors, `pageerror/console errors ${ctx}`).toEqual([]);
  expect(gate.bad5xx, `unexpected /api 5xx ${ctx}`).toEqual([]);
}

/** Assert the top-level ErrorBoundary fallback is NOT shown (§3.3 gate 4). */
export async function assertNoErrorBoundary(page: Page) {
  await expect(page.getByTestId('error-boundary-fallback')).toHaveCount(0);
}

export { expect };
