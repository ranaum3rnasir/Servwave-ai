export interface CatalogCopyEntry {
  key: string;
  label: string;
  requires: string[];
  requiresAny: string[];
  grants: Array<{ action: string; subject: string }>;
  presets: Record<'ADMIN' | 'SALES' | 'DISPATCHER' | 'TECHNICIAN', boolean> | null;
}
export declare const CATALOG_SOURCE_PATH: string;
export declare const CATALOG_COPY_PATH: string;
export declare const REGENERATE_COMMAND: string;
export declare function parseCatalog(source: string): CatalogCopyEntry[];
export declare function renderCopy(source: string): string;
