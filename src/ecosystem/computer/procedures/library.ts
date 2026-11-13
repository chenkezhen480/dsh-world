// src/ecosystem/computer/procedures/library.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { errorText, type Faults } from '../../../faults.ts';
import { durableWrite } from '../../../life/lifeStore.ts';
import { parseProcedure, ProcedureError, type Procedure } from './format.ts';
import type { KeptVersion } from './run.ts';

export interface StoredProcedure { procedure: Procedure; file: string }
export interface RunNote { at: string; ok: boolean; detail?: string }
export type ProcedureLibrary = ReturnType<typeof createProcedureLibrary>;

const TOOL_FILE = /^[a-z][a-z0-9_]{1,40}\.json$/;

/**
 * Her tools, one file each in `<world>/procedures/`. They are hers: the plugin writes a file only when she saves, and
 * keeps the version it replaces as `<name>.v<n>.json`. She may also edit them by hand; the revision follows the files.
 */
export function createProcedureLibrary(dir: string, deps: { faults?: Faults } = {}) {
  const runs = new Map<string, RunNote>();
  const faulted = new Set<string>();
  let cache: { revision: string; list: StoredProcedure[] } | undefined;
  const files = () => existsSync(dir) ? readdirSync(dir).filter(file => TOOL_FILE.test(file)).sort() : [];
  /** The `<name>.v<n>.json` numbers on disk, highest first. */
  const keptNumbers = (name: string) => {
    const pattern = new RegExp(`^${name}\\.v(\\d+)\\.json$`);
    return existsSync(dir) ? readdirSync(dir).map(file => Number(pattern.exec(file)?.[1] ?? 0)).filter(Boolean).sort((a, b) => b - a) : [];
  };
  const revision = () => files().flatMap(file => {
    try { const { mtimeMs, size } = statSync(join(dir, file)); return [`${file}:${mtimeMs}:${size}`]; } catch { return []; } // deleted between listing and stat
  }).join('|');
  function list(): StoredProcedure[] {
    const current = revision();
    if (cache?.revision === current) return cache.list;
    const out: StoredProcedure[] = [], seen = new Set<string>();
    for (const file of files()) {
      const key = `procedure:${file}`;
      seen.add(key);
      try {
        const procedure = parseProcedure(JSON.parse(readFileSync(join(dir, file), 'utf8')));
        if (`${procedure.name}.json` !== file) throw new ProcedureError(`文件名应该是 ${procedure.name}.json`);
        out.push({ procedure, file: join(dir, file) });
        deps.faults?.clear(key); faulted.delete(key);
      } catch (error) { deps.faults?.set(key, `她的工具 ${file} 没能载入：${errorText(error)}`); faulted.add(key); }
    }
    for (const key of [...faulted]) if (!seen.has(key)) { deps.faults?.clear(key); faulted.delete(key); }
    cache = { revision: current, list: out };
    return out;
  }
  return {
    dir,
    list,
    revision,
    get: (name: string) => list().find(entry => entry.procedure.name === name)?.procedure,
    /**
     * The versions her tool replaced, newest first, for when the newest fails. One that no longer parses or repeats a
     * newer one is left out: they are fallbacks, and the files stay hers either way.
     */
    kept(name: string): KeptVersion[] {
      const current = list().find(entry => entry.procedure.name === name)?.procedure;
      const seen = new Set(current ? [JSON.stringify(current)] : []);
      return keptNumbers(name).flatMap(version => {
        try {
          const procedure = parseProcedure(JSON.parse(readFileSync(join(dir, `${name}.v${version}.json`), 'utf8')));
          const key = JSON.stringify(procedure);
          if (seen.has(key)) return [];
          seen.add(key);
          return [{ procedure, version }];
        } catch { return []; }
      });
    },
    /** Checks and writes one tool; what it replaces stays as the next `.v<n>.json`. Returns the new version number. */
    save(json: string): { procedure: Procedure; version: number } {
      let value: unknown;
      try { value = JSON.parse(json); } catch (error) { throw new ProcedureError(`JSON 格式不对：${errorText(error)}`); }
      const procedure = parseProcedure(value);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${procedure.name}.json`);
      // Numbering continues after the highest kept version, so a gap or a deleted file never makes a save overwrite one.
      const highest = keptNumbers(procedure.name)[0] ?? 0;
      const replaced = existsSync(file);
      if (replaced) durableWrite(join(dir, `${procedure.name}.v${highest + 1}.json`), readFileSync(file, 'utf8'));
      durableWrite(file, JSON.stringify(procedure, null, 2) + '\n');
      cache = undefined;
      return { procedure, version: highest + (replaced ? 2 : 1) };
    },
    /** For when the module stops: its load faults would otherwise outlive the tools they describe. */
    clearFaults(): void { for (const key of faulted) deps.faults?.clear(key); faulted.clear(); cache = undefined; },
    note(name: string, ok: boolean, detail?: string): void { runs.set(name, { at: new Date().toISOString(), ok, ...(detail === undefined ? {} : { detail }) }); },
    lastRun: (name: string) => runs.get(name),
  };
}
