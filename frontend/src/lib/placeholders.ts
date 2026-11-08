export function isPlaceholderEmail(value: string | null | undefined): boolean {
  if (!value) return false;
  return value.includes('@placeholder.local') || value.startsWith('bg-import-');
}

export function isPlaceholderPhone(value: string | null | undefined): boolean {
  if (!value) return false;
  return value.startsWith('bg-import-phone:') || value === '(000) 000-0000';
}
