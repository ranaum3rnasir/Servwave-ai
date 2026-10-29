export declare function extractCandidates(): Map<string, string[]>;
export declare function findUnresolved(candidates: Map<string, string[]>): Record<string, string[]>;
export declare function loadBaseline(path?: string): Record<string, string[]>;
export declare function newPairs(
  unresolved: Record<string, string[]>,
  baseline: Record<string, string[]>,
): Record<string, string[]>;
