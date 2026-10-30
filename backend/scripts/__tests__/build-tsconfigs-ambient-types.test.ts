/**
 * `npm run build` type-checks with several `tsc -p <config>` projects. An ambient declaration (src/types/*.d.ts) cannot be
 * reached by import, so every project must name it in its file list: a project that does not fails the BUILD (not
 * `npm run typecheck`) the moment any file it does include imports a module that only an ambient file declares
 * (`parseurl`, TS7016, ticket 34). This reads each project the build script runs, through the TypeScript API, and
 * checks that every ambient file under src/types is in it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const BACKEND = path.resolve(__dirname, '../..');

/** The `-p` configs of the commands in `npm run build`, in order. */
function buildProjects(): string[] {
  const build = (JSON.parse(readFileSync(path.join(BACKEND, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts.build!;
  return [...build.matchAll(/\btsc\s+-p\s+(\S+)/g)].map((m) => m[1]!);
}

/** Every file a tsconfig project covers, as TypeScript resolves its include, exclude and extends. */
function filesOf(configName: string): Set<string> {
  const configPath = path.join(BACKEND, configName);
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  expect(read.error, `${configName} reads`).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, BACKEND, undefined, configPath);
  return new Set(parsed.fileNames.map((f) => path.normalize(f)));
}

const AMBIENT = readdirSync(path.join(BACKEND, 'src/types')).filter((f) => f.endsWith('.d.ts'));

describe('the projects `npm run build` type-checks', () => {
  it('runs more than one project, and reads them from package.json', () => {
    expect(buildProjects()).toEqual(expect.arrayContaining(['tsconfig.build.json', 'tsconfig.scripts.json']));
    expect(AMBIENT).toEqual(expect.arrayContaining(['express.d.ts', 'parseurl.d.ts']));
  });

  it.each(buildProjects())('%s includes every ambient declaration under src/types', (config) => {
    const files = filesOf(config);
    const missing = AMBIENT.filter((f) => !files.has(path.join(BACKEND, 'src/types', f)));
    expect(missing).toEqual([]);
  });
});
