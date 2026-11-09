import { vi } from 'vitest';

/**
 * The hook stubs of the routed inventory page, for `vi.mock` factories in a test of `src/pages/v2/inventory/InventoryPage.tsx`
 * (#3259). A test that gives the page its records by stubbing the data hooks (rather than by the fake server of
 * `inventoryPage.tsx`) takes them from here and states only its own data. Kept apart from the page harness because a `vi.mock`
 * factory cannot import a module that itself imports the mocked module: this one imports only the test tool.
 *
 *   vi.mock('@/lib/api/inventory', async (importOriginal) =>
 *     (await import('@/__tests__/harness/inventoryApiStub')).inventoryApi(await importOriginal(), { reads: { useInventoryItems: ITEMS } }));
 */
export const EMPTY: never[] = [];

/** A query hook that has loaded `data`. */
export const stable =
  <T,>(data: T) =>
  () => ({ data, isLoading: false, isError: false });

/** A mutation hook whose calls are spies. */
export const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });

/** The query hooks every inventory test stubs; each answers an empty list unless the test gives it data. */
const STANDARD_READS = [
  'useInventoryItems', 'useLocations', 'useVendors', 'useCategories', 'useBranches', 'useBrands', 'useJobStages', 'useMovements',
] as const;

export interface InventoryApiStub {
  /** Query hooks by name, with the data each has loaded; the standard eight answer `[]` when left out. */
  reads?: Record<string, unknown>;
  /** Mutation hooks (spies) by name. */
  mutations?: readonly string[];
  /** Standard query hooks left REAL (they are the seam under test), by name. */
  real?: readonly string[];
  /** Hooks a test shapes itself (a mutation with its own spy, a hook that reads its argument), by name. */
  custom?: Record<string, unknown>;
}

/** The module `@/lib/api/inventory` with the data hooks stubbed; everything else is the real module. */
export function inventoryApi<M extends object>(actual: M, opts: InventoryApiStub = {}) {
  const standard = STANDARD_READS.filter((k) => !opts.real?.includes(k));
  const reads: Record<string, unknown> = { ...Object.fromEntries(standard.map((k) => [k, EMPTY])), ...opts.reads };
  return {
    ...actual,
    ...Object.fromEntries(Object.entries(reads).map(([name, data]) => [name, stable(data)])),
    ...Object.fromEntries((opts.mutations ?? []).map((name) => [name, mutation])),
    ...opts.custom,
  };
}

/** The module `@/lib/api/shared/organization` with the organization read answering `data`. */
export function organizationApi<M extends object>(actual: M, data: unknown) {
  return { ...actual, useOrganization: () => ({ data, isLoading: false, isError: false }) };
}

/**
 * The kit's sonner module with `toast` a spy: the routed page reports through the toaster App.tsx mounts at the root and
 * `renderWithProviders` does not, so the copy stays asserted by spying on the call.
 */
export function sonnerSpy<M extends object>(actual: M) {
  return { ...actual, toast: vi.fn() };
}
