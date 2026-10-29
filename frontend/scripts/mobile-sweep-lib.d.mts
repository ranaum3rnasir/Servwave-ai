export interface Budget { lcpMs: number; cls: number }
export interface Metrics { lcpMs: number; cls: number; fcpMs: number | null; tbtMs: number | null; bytes: number | null; performanceScore: number | null }
export interface MedianMetrics extends Metrics { runs: number }
export interface LighthousePage { id: string; label?: string; mode: 'enforce' | 'report'; owner?: string; budget?: Partial<Budget>; ceiling?: Partial<Budget> }
export interface LighthouseResult { id: string; label?: string; mode: string; owner?: string; measured: MedianMetrics | null; verdict: { status: 'pass' | 'fail' | 'report'; failures: string[] } }
export interface FlatRow { file: string; title: string; project: string; status: 'pass' | 'fail' | 'flaky' | 'skipped' | 'known' | 'known-failing'; error: string; knownFailingId?: string }
export interface KnownFailingEntry { id: string; file: string; title?: string; projects?: string[]; errorIncludes?: string; reason: string; owner: string }
export interface SweepMeta { startedAt: string; finishedAt: string; commit: string; stagingSha: string; branch: string; dirty: boolean; partial?: boolean; command: string; exitCode: number; signal?: string | null; leftoverOrg?: string | null; node?: string }
export interface SweepDevice { id: string; matrix?: string; viewport?: string; engine?: string }
export interface SweepReport {
  version: 1;
  overall: 'pass' | 'fail';
  problems: string[];
  meta: SweepMeta;
  build: { ok: boolean } | null;
  devices: Array<SweepDevice & { ran: boolean; tests: number; pass: number; fail: number; knownFailing: number; flaky: number; skipped: number; known: number }>;
  notRunDevices: string[];
  routes: { expected: number; ran: number; missing: string[]; gap: Array<{ state: string; device: string }> };
  matrix: { states: Array<{ id: string; cells: Record<string, string> }>; devices: string[] };
  knownBroken: string[];
  failures: Array<{ project: string; file: string; title: string; error: string }>;
  knownFailing: Array<{ id: string; project: string; file: string; title: string; error: string; owner: string; reason: string }>;
  staleKnownFailing: string[];
  selftestFailures: Array<{ project: string; title: string; error: string }>;
  specs: Array<{ file: string; pass: number; fail: number; knownFailing: number; flaky: number; skipped: number }>;
  lighthouse: LighthouseResult[];
  records: { reportPairs: number } | null;
}
export declare const DEFAULT_BUDGET: Budget;
export declare const REQUIRED_DEVICE_IDS: string[];
export declare const REQUIRED_LIGHTHOUSE_IDS: string[];
export declare function extractMetrics(lhr: unknown): Metrics | null;
export declare function medianMetrics(runs: Array<Metrics | null>): MedianMetrics | null;
export declare function evaluateBudget(measured: { lcpMs: number; cls: number } | null | undefined, budget?: Budget): { ok: boolean; failures: string[] };
export declare function lighthouseVerdict(page: LighthousePage, measured: { lcpMs: number; cls: number } | null | undefined, budget?: Budget): { status: 'pass' | 'fail' | 'report'; failures: string[] };
export declare function flattenPlaywright(json: unknown): FlatRow[];
export declare function stateIdOf(title: string): string;
export declare function routeMatrix(rows: FlatRow[]): { states: Array<{ id: string; cells: Record<string, string> }>; devices: string[] };
export declare function buildSweepReport(i: {
  meta: SweepMeta;
  playwright: unknown;
  knownFailing?: KnownFailingEntry[];
  devices: SweepDevice[];
  expectedStates: string[];
  lighthouse?: LighthouseResult[];
  records?: { reportPairs: number } | null;
  build?: { ok: boolean } | null;
}): SweepReport;
export declare function renderSweepMarkdown(r: SweepReport): string;
export declare function checkSweepReport(report: unknown, opts?: { sha?: string; now?: number; maxAgeHours?: number; reportContainsSha?: boolean }): { ok: boolean; problems: string[] };
export declare function applyKnownFailing(rows: FlatRow[], entries?: KnownFailingEntry[]): { rows: FlatRow[]; matched: Record<string, number>; stale: string[] };
export declare function teardownWithRetries(d: {
  deleteRates: () => Promise<{ ok: boolean; deleted?: number; reason?: string }>;
  teardownOrg: () => Promise<{ ok: boolean; status: number; body: string }>;
  log?: (msg: string) => void;
  attempts?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ ok: boolean; attempts: number; status?: number; body?: string }>;
export interface PurgeBlocker { label: string; listPath: string; deletePath: (id: string) => string; ids: (body: any) => string[] }
export declare const PURGE_BLOCKERS: PurgeBlocker[];
export declare function clearPurgeBlockers(
  api: { get: (path: string) => Promise<any>; delete: (path: string) => Promise<any> },
  blockers?: PurgeBlocker[],
): Promise<{ ok: boolean; deleted: number; reason?: string }>;
