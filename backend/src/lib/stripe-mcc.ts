/**
 * Maps an org's trade (organizations.industry — a JSON array; first entry wins)
 * to a Stripe MCC. The contractor can change it on Stripe's surface during
 * onboarding. Defaults to 1799 (special-trade contractors).
 */
const MCC_BY_KEYWORD: Array<{ match: RegExp; mcc: string }> = [
  { match: /hvac|heating|cooling|air|plumb|septic|sewer|drain/i, mcc: '1711' }, // heating/plumbing/AC
  { match: /electric/i, mcc: '1731' },                                          // electrical contractors
];

export function mccForIndustry(industry: string[] | null | undefined): string {
  const first = Array.isArray(industry) && industry.length > 0 ? industry[0] : '';
  for (const { match, mcc } of MCC_BY_KEYWORD) {
    if (match.test(first)) return mcc;
  }
  return '1799'; // special-trade contractors (default)
}
