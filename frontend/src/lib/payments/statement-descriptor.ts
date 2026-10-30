/**
 * Payments go-live slice 36: the text on a customer's card statement. The card networks' rules: 5 to 22
 * characters, Latin characters only, at least one letter, and none of < > \ / ' " *. This mirrors the server's
 * check (which is the one that decides); it exists to say why before the owner presses Save.
 * Returns null when the value is acceptable, otherwise the sentence to show.
 */
export function statementDescriptorProblem(value: string): string | null {
  const v = value.trim();
  if (v.length < 5 || v.length > 22) return 'Use 5 to 22 characters.';
  if (/[<>\\/'"*]/.test(v)) return 'It cannot contain < > \\ / \' " or *.';
  if (/[^\x20-\x7E]/.test(v)) return 'Use letters without accents, numbers and spaces.';
  if (!/[A-Za-z]/.test(v)) return 'It needs at least one letter.';
  return null;
}
