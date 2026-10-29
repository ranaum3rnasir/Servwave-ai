export declare const PUBLIC_BUDGET_BYTES: number;
export declare const PUBLIC_MAX_FILES: number;
export declare const STAFF_BUDGET_BYTES: number;
export declare const STAFF_CEILING_BYTES: number;
export declare const COPILOT_SOURCE: RegExp;
export declare const PUBLIC_PATHS: string[];
export declare function hasSourceMaps(distDir: string): boolean;
export declare function stripCopilot(code: string, mapText: string): string;
export declare function checkFontLoading(opts: { distDir: string; htmlFiles: string[] }): string[];
export declare const VENDOR_NAME_IN_URL: RegExp;
export declare function htmlForPath(
  vercelConfig: { rewrites?: { source: string; destination: string }[] },
  urlPath: string,
): string | null;
export declare function hostBanner(file: string): string;
export declare function measureInitialJs(
  distDir: string,
  htmlFile: string,
): {
  files: { file: string; gzip: number; copilotGzip: number; stamped: boolean }[];
  gzipTotal: number;
  copilotGzip: number;
  gzipExcludingCopilot: number;
  html: string;
  swRegistration: string[];
  vendorNamed: string[];
};
export declare function checkPublicBundle(opts: {
  distDir: string;
  vercelConfig: { rewrites?: { source: string; destination: string }[] };
  paths?: string[];
  budgetBytes?: number;
  maxPublicFiles?: number;
  staffCeilingBytes?: number;
  staffTargetBytes?: number;
  enforceStaffBudget?: boolean;
}): {
  ok: boolean;
  problems: string[];
  notes: string[];
  reports: { html: string; served: string[]; gzipTotal: number; copilotGzip: number; gzipExcludingCopilot: number; staff?: boolean; ceilingBytes?: number; targetBytes?: number; files: { file: string; gzip: number; copilotGzip: number; stamped: boolean }[]; swRegistration: string[]; vendorNamed: string[] }[];
};
