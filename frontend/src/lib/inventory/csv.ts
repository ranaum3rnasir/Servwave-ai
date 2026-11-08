// toCSV/downloadCSV now live in the app-wide writer. Re-exported so the eight
// existing call sites (5 list pages, InventoryPage, CommunicationTrackingReport,
// and the inventory unit test) keep working unchanged.
export { toCSV, downloadCSV } from '@/lib/csv';

export type ParsedCSV = {
  headers: string[];
  rows: Record<string, string>[];
};

// Robust enough small-CSV parser: handles quoted fields, escaped quotes, and CRLF.
export function parseCSV(text: string): ParsedCSV {
  // Strip BOM if present
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const records: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      cur.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      // skip — handled with \n
      i++;
      continue;
    }
    if (c === "\n") {
      cur.push(field);
      records.push(cur);
      cur = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // Flush final field/record
  if (field.length > 0 || cur.length > 0) {
    cur.push(field);
    records.push(cur);
  }
  // Drop trailing fully-empty rows
  while (
    records.length > 0 &&
    records[records.length - 1]!.every((v) => v.trim() === "")
  ) {
    records.pop();
  }

  if (records.length === 0) return { headers: [], rows: [] };
  const headers = records[0]!.map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (let r = 1; r < records.length; r++) {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = (records[r]![idx] ?? "").trim();
    });
    rows.push(obj);
  }
  return { headers, rows };
}

// Smart column mapping: try to map source headers to target field names by
// fuzzy match. Returns map of targetField -> sourceHeader (or null if unmapped).
const FIELD_ALIASES: Record<string, string[]> = {
  sku: ["sku", "part number", "part #", "partnumber", "part_no", "item code", "code"],
  name: ["name", "item name", "description", "item description", "title"],
  category: ["category", "cat", "group", "class"],
  trade: ["trade", "discipline", "service line"],
  kind: ["kind", "type", "item type"],
  uom: ["uom", "unit", "unit of measure", "u/m"],
  unitCost: ["unit cost", "cost", "vendor cost", "wholesale", "buy price"],
  sellPrice: ["sell price", "price", "list price", "retail", "msrp"],
  vendor: ["vendor", "supplier", "manufacturer", "mfr", "brand"],
  mpn: ["mpn", "manufacturer part", "mfr part", "mfg part"],
  upc: ["upc", "ean", "gtin", "barcode"],
  serialized: ["serialized", "serial tracked", "track serial"],
  hazmat: ["hazmat", "hazardous"],
};

export function autoMapColumns(
  csvHeaders: string[],
): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  const normalize = (s: string) => s.toLowerCase().trim().replace(/[_\-\s]+/g, " ");
  const normalizedHeaders = csvHeaders.map((h) => ({
    raw: h,
    norm: normalize(h),
  }));
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    let match: string | null = null;
    for (const alias of aliases) {
      const a = normalize(alias);
      const found = normalizedHeaders.find((h) => h.norm === a);
      if (found) {
        match = found.raw;
        break;
      }
    }
    // Fallback: partial match
    if (!match) {
      for (const alias of aliases) {
        const a = normalize(alias);
        const found = normalizedHeaders.find(
          (h) => h.norm.includes(a) || a.includes(h.norm),
        );
        if (found) {
          match = found.raw;
          break;
        }
      }
    }
    result[field] = match;
  }
  return result;
}
