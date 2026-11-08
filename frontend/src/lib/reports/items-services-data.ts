// Deterministic mock for the Items & Services report. Seeded so every render is
// identical. Shaped to the Phase-2 backend contract (see items-services-logic).
// Replace buildItemsServices() with GET /api/reports/items-and-services later.
import { hashStr, mulberry32, rangeRnd } from './random';
import { aggregateItems, type ItemServiceStat, type Kind, type RawItemTech, type WeekPoint } from './items-services-logic';

interface ItemDef { id: string; name: string; kind: Kind; category: string; expectedMin: number; price: number }

const ITEMS: ItemDef[] = [
  { id: 'i01', name: 'Condenser coil clean', kind: 'SERVICE', category: 'HVAC', expectedMin: 30, price: 180 },
  { id: 'i02', name: 'Capacitor replacement', kind: 'ITEM', category: 'HVAC', expectedMin: 25, price: 220 },
  { id: 'i03', name: 'AC tune-up', kind: 'SERVICE', category: 'HVAC', expectedMin: 45, price: 140 },
  { id: 'i04', name: 'Thermostat install', kind: 'ITEM', category: 'HVAC', expectedMin: 40, price: 260 },
  { id: 'i05', name: 'Blower motor replace', kind: 'ITEM', category: 'HVAC', expectedMin: 60, price: 540 },
  { id: 'i06', name: 'Water heater install', kind: 'ITEM', category: 'Plumbing', expectedMin: 120, price: 1450 },
  { id: 'i07', name: 'Drain snake', kind: 'SERVICE', category: 'Plumbing', expectedMin: 35, price: 190 },
  { id: 'i08', name: 'Faucet replace', kind: 'ITEM', category: 'Plumbing', expectedMin: 30, price: 240 },
  { id: 'i09', name: 'Toilet rebuild', kind: 'SERVICE', category: 'Plumbing', expectedMin: 40, price: 210 },
  { id: 'i10', name: 'Panel upgrade', kind: 'ITEM', category: 'Electrical', expectedMin: 180, price: 1850 },
  { id: 'i11', name: 'GFCI outlet replace', kind: 'ITEM', category: 'Electrical', expectedMin: 20, price: 160 },
  { id: 'i12', name: 'Lighting install', kind: 'SERVICE', category: 'Electrical', expectedMin: 25, price: 130 },
];

const TECHS = [
  { id: 't1', name: 'Devon Clark' },
  { id: 't2', name: 'Priya Nair' },
  { id: 't3', name: 'Sofia Reyes' },
  { id: 't4', name: 'Aisha Khan' },
  { id: 't5', name: 'Tyler Brooks' },
  { id: 't6', name: 'Marcus Bell' },
];

export function buildRawItemsServices(): RawItemTech[] {
  const rng = mulberry32(hashStr('items-and-services'));
  const raw: RawItemTech[] = [];
  for (const item of ITEMS) {
    // Each tech has a per-item skill factor; some don't perform every item.
    for (const tech of TECHS) {
      const timesDone = Math.round(rangeRnd(rng, 0, 34));
      if (timesDone === 0) continue; // tech doesn't do this item
      const skill = rangeRnd(rng, 0.78, 1.42);        // <1 faster, >1 slower
      const actualMin = Math.round(item.expectedMin * skill);
      const weekActualMin = Math.round(actualMin * rangeRnd(rng, 0.9, 1.32));
      const ftfPct = Math.round(rangeRnd(rng, 70, 98));
      const gpPct = Math.round(rangeRnd(rng, 38, 72));
      const revenue = timesDone * item.price;
      const gpDollars = Math.round((revenue * gpPct) / 100);
      raw.push({
        itemId: item.id, itemName: item.name, kind: item.kind, category: item.category,
        expectedMin: item.expectedMin, techId: tech.id, techName: tech.name,
        timesDone, actualMin, weekActualMin, ftfPct, gpPct,
        rating: null, // ratings not captured yet (spec §5)
        revenue, gpDollars,
      });
    }
  }
  return raw;
}

export function buildItemsServices(): ItemServiceStat[] {
  return aggregateItems(buildRawItemsServices());
}

// Company-level avg time-vs-expected per week (calendar-fixed, like other report
// charts). Deterministic; independent of the category filter in Phase 1.
export function buildWeeklyVariance(): WeekPoint[] {
  const rng = mulberry32(hashStr('items-and-services-weekly'));
  return Array.from({ length: 8 }, (_, i) => ({
    week: `W${i + 1}`,
    variancePct: Math.round(rangeRnd(rng, -14, 26)),
  }));
}
