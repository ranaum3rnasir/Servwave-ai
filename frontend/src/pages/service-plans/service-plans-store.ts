// In-memory mock store for Service Plans (mock-first; resets on reload). Seeds
// from the deterministic generators and mutates via the pure lifecycle helpers.
import { create } from 'zustand';
import {
  buildPlans, buildVisits, buildVisitsForPlan,
  applyApprove, applyMarkBilled, applyRenew, applyCancel,
  type ServicePlan, type PlanVisit,
} from './service-plans-data';

let nextPlanId = 1000;
let nextVisitId = 100000;

interface ServicePlansState {
  plans: ServicePlan[];
  visits: PlanVisit[];
  approve: (id: number) => void;
  markBilled: (id: number) => void;
  renew: (id: number) => void;
  cancel: (id: number) => void;
  upsertPlan: (plan: ServicePlan) => void;
  completeVisit: (visitId: number) => void;
}

const seedPlans = buildPlans();
const seedVisits = buildVisits(seedPlans);

const mapPlan = (plans: ServicePlan[], id: number, fn: (p: ServicePlan) => ServicePlan) =>
  plans.map((p) => (p.id === id ? fn(p) : p));

export const useServicePlansStore = create<ServicePlansState>((set) => ({
  plans: seedPlans,
  visits: seedVisits,
  approve: (id) => set((s) => ({ plans: mapPlan(s.plans, id, applyApprove) })),
  markBilled: (id) => set((s) => ({ plans: mapPlan(s.plans, id, (p) => applyMarkBilled(p)) })),
  cancel: (id) => set((s) => ({
    plans: mapPlan(s.plans, id, applyCancel),
    visits: s.visits.filter((v) => !(v.planId === id && v.scheduledDate >= new Date())),
  })),
  renew: (id) => set((s) => {
    const plans = mapPlan(s.plans, id, applyRenew);
    const renewed = plans.find((p) => p.id === id)!;
    const fresh = buildVisitsForPlan(renewed, nextVisitId);
    nextVisitId += fresh.length;
    return { plans, visits: [...s.visits, ...fresh] };
  }),
  upsertPlan: (plan) => set((s) => {
    const exists = s.plans.some((p) => p.id === plan.id);
    const id = exists ? plan.id : (plan.id || nextPlanId++);
    const saved = { ...plan, id, planNumber: plan.planNumber || `SP${String(id).padStart(5, '0')}` };
    const otherVisits = s.visits.filter((v) => v.planId !== id);
    const fresh = saved.status === 'Pending approval' ? [] : buildVisitsForPlan(saved, nextVisitId);
    nextVisitId += fresh.length;
    return {
      plans: exists ? mapPlan(s.plans, id, () => saved) : [saved, ...s.plans],
      visits: [...otherVisits, ...fresh],
    };
  }),
  completeVisit: (visitId) => set((s) => ({
    visits: s.visits.map((v) => (v.id === visitId ? { ...v, status: 'Completed' as const, completedAt: new Date(), jobId: v.jobId ?? 699000 + v.id } : v)),
  })),
}));
