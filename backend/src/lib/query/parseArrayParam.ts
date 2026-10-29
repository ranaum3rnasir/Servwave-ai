export function parseArrayParam(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const str = String(value);
  if (!str) return [];
  return str.includes(',') ? str.split(',').map(s => s.trim()).filter(Boolean) : [str];
}
