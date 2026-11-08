// Barrel for the Dashboard mock seed layer. The data seam
// (lib/api/dashboard.ts) imports from this single path; pages/components
// must never import from _mock directly (data-seam discipline).
export * from './types';
export { dashboardSeed } from './seed';
