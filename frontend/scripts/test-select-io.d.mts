import type { Change, Decision } from './test-select-lib.mjs';
export declare const LISTS_FILE: string;
export declare function parseNameStatus(text: string): Change[];
export declare function parseListOutput(text: string, repoRoot: string): string[] | null;
export declare function listChanged(opts: { frontend: string; base: string; limitMs?: number }): Promise<string>;
export declare function gatherFacts(opts: { repoRoot: string; frontend: string; env: Record<string, string | undefined>; runList?: typeof listChanged; listLimitMs?: number }): Promise<Record<string, any>>;
export declare function selectForRun(opts: { env?: Record<string, string | undefined>; frontend: string; shard?: boolean; runList?: typeof listChanged; listLimitMs?: number; backstopMarginMs?: number }): Promise<Decision>;
export declare function normalizeMode(raw: unknown): 'off' | 'shadow' | 'on' | 'invalid';
