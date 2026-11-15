// src/ecosystem/computer/procedures/library.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { errorText, type Faults } from '../../../faults.ts';
import { durableWrite } from '../../../life/lifeStore.ts';
import { ENTRY_NAME, entryName, GUIDE_NAME, parseProcedure, procedurePath, ProcedureError, UNSORTED, type Procedure } from './format.ts';
import type { KeptVersion } from './run.ts';

export interface StoredProcedure { procedure: Procedure; path: string; file: string }
export interface Category { name: string; guide: string }
export interface RunNote { at: string; ok: boolean; detail?: string }
export type ProcedureLibrary = ReturnType<typeof createProcedureLibrary>;

const OWN_FILE = /^([^.]+)\.json$/;
const MAX_GUIDE = 1000;
const GUIDE_FILE = `${GUIDE_NAME}.md`;
/** A folder counts as a category only if its name could have been saved as one. */
const ENTRY_OK = (name: string) => name !== GUIDE_NAME && ENTRY_NAME.test(name);

/**
 * Her operations, one file each in `<world>/procedures/<category>/`, with her own `目录.md` per category. They are hers:
 * the plugin writes a file only when she saves, and keeps what it replaces as `<name>.v<n>.json` (`目录.v<n>.md`). She may
 * also edit them by hand; the revision follows the files. Files the development build left flat in `procedures/` are
 * read in place as the category 未分类 and never moved.
 */
export function createProcedureLibrary(dir: string, deps: { faults?: Faults } = {}) {
  const runs = new Map<string, RunNote>();
  const faulted = new Set<string>();
  let cache: { revision: string; list: StoredProcedure[] } | undefined;
  const entries = (at: string) => { try { return readdirSync(at, { withFileTypes: true }); } catch { return []; } };
  const folders = () => entries(dir).filter(entry => entry.isDirectory() && ENTRY_OK(entry.name)).map(entry => entry.name).sort();
  /** Every operation file with its category; folders first, then the flat files, so a saved one shadows a flat one. */
  const files = () => [
    ...folders().flatMap(category => entries(join(dir, category)).filter(entry => entry.isFile() && OWN_FILE.test(entry.name)).map(entry => ({ category, base: entry.name, file: join(dir, category, entry.name), label: `${category}/${entry.name}` }))),
    ...entries(dir).filter(entry => entry.isFile() && OWN_FILE.test(entry.name)).map(entry => ({ category: UNSORTED, base: entry.name, file: join(dir, entry.name), label: entry.name })),
  ];
  const revision = () => files().flatMap(({ file }) => {
    try { const { mtimeMs, size } = statSync(file); return [`${file}:${mtimeMs}:${size}`]; } catch { return []; } // deleted between listing and stat
  }).join('|');
  /** The `<name>.v<n>.<ext>` numbers in a folder, highest first. */
  const keptNumbers = (folder: string, name: string, ext: string) => {
    const pattern = new RegExp(`^${name}\\.v(\\d+)\\.${ext}$`, 'u');
    return entries(folder).map(entry => Number(pattern.exec(entry.name)?.[1] ?? 0)).filter(Boolean).sort((a, b) => b - a);
  };
  /** Writes `file`, first keeping what it replaces as the next version in its folder. Returns the new version number. */
  function replace(folder: string, name: string, ext: string, content: string): number {
    mkdirSync(folder, { recursive: true });
    const file = join(folder, `${name}.${ext}`);
    // Numbering continues after the highest kept version, so a gap or a deleted file never makes a save overwrite one.
    const highest = keptNumbers(folder, name, ext)[0] ?? 0;
    const replaced = existsSync(file);
    if (replaced) durableWrite(join(folder, `${name}.v${highest + 1}.${ext}`), readFileSync(file, 'utf8'));
    durableWrite(file, content);
    cache = undefined;
    return highest + (replaced ? 2 : 1);
  }
  function list(): StoredProcedure[] {
    const current = revision();
    if (cache?.revision === current) return cache.list;
    const out: StoredProcedure[] = [], seen = new Set<string>(), paths = new Set<string>();
    for (const { category, base, file, label } of files()) {
      const key = `procedure:${label}`;
      seen.add(key);
      try {
        const procedure = parseProcedure(JSON.parse(readFileSync(file, 'utf8')), category);
        if (`${procedure.name}.json` !== base) throw new ProcedureError(`文件名应该是 ${procedure.name}.json`);
        if (procedure.category !== category) throw new ProcedureError(`分类应该是 ${category}，或者把文件挪进 ${procedure.category} 文件夹`);
        const path = procedurePath(procedure);
        if (!paths.has(path)) { paths.add(path); out.push({ procedure, path, file }); }
        deps.faults?.clear(key); faulted.delete(key);
      } catch (error) { deps.faults?.set(key, `她的操作 ${label} 没能载入：${errorText(error)}`); faulted.add(key); }
    }
    for (const key of [...faulted]) if (!seen.has(key)) { deps.faults?.clear(key); faulted.delete(key); }
    cache = { revision: current, list: out };
    return out;
  }
  const find = (path: string) => list().find(entry => entry.path === path);
  return {
    dir,
    list,
    get: (path: string) => find(path)?.procedure,
    /** Categories with an operation or a note of hers, by name; `guide` is her `目录.md`, or empty. */
    categories(): Category[] {
      const names = new Set([...list().map(entry => entry.procedure.category), ...folders().filter(name => existsSync(join(dir, name, GUIDE_FILE)))]);
      return [...names].sort().map(name => {
        const file = join(dir, name, GUIDE_FILE);
        let guide = '';
        try { guide = existsSync(file) ? readFileSync(file, 'utf8') : ''; } catch { /* unreadable: shown as no note */ }
        return { name, guide };
      });
    },
    /**
     * The versions her operation replaced, newest first, for when the newest fails. One that no longer parses or repeats
     * a newer one is left out: they are fallbacks, and the files stay hers either way.
     */
    kept(path: string): KeptVersion[] {
      const stored = find(path);
      if (!stored) return [];
      const folder = dirname(stored.file), name = stored.procedure.name;
      const seen = new Set([JSON.stringify(stored.procedure)]);
      return keptNumbers(folder, name, 'json').flatMap(version => {
        try {
          const procedure = parseProcedure(JSON.parse(readFileSync(join(folder, `${name}.v${version}.json`), 'utf8')), stored.procedure.category);
          const key = JSON.stringify(procedure);
          if (seen.has(key)) return [];
          seen.add(key);
          return [{ procedure, version }];
        } catch { return []; }
      });
    },
    /** Checks and writes one operation into its category folder; what it replaces stays as the next `.v<n>.json`. */
    save(json: string): { procedure: Procedure; path: string; version: number } {
      let value: unknown;
      try { value = JSON.parse(json); } catch (error) { throw new ProcedureError(`JSON 格式不对：${errorText(error)}`); }
      const procedure = parseProcedure(value);
      const version = replace(join(dir, procedure.category), procedure.name, 'json', JSON.stringify(procedure, null, 2) + '\n');
      return { procedure, path: procedurePath(procedure), version };
    },
    /** Her note for a category, whole; the one it replaces stays as `目录.v<n>.md`. Returns the new version number. */
    saveGuide(category: string, text: string): number {
      entryName(category, 'category');
      if (typeof text !== 'string' || !text.trim() || [...text].length > MAX_GUIDE) throw new ProcedureError(`说明应该是 1 到 ${MAX_GUIDE} 字`);
      return replace(join(dir, category), GUIDE_NAME, 'md', text);
    },
    /** For when the module stops: its load faults would otherwise outlive the operations they describe. */
    clearFaults(): void { for (const key of faulted) deps.faults?.clear(key); faulted.clear(); cache = undefined; },
    note(path: string, ok: boolean, detail?: string): void { runs.set(path, { at: new Date().toISOString(), ok, ...(detail === undefined ? {} : { detail }) }); },
    lastRun: (path: string) => runs.get(path),
  };
}
