import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type CompactionSwap =
  | { status: 'swapped'; backup: string; preset?: string }
  | { status: 'already' }
  | { status: 'unchanged'; reason: string };

const STOCK = '@deepseek-ai/dsh-compaction-basic';
const OURS = 'dsh-world/compaction';
const stock = /^(\s*name:\s*)(['"]?)@deepseek-ai\/dsh-compaction-basic\2([ \t]*(?:#.*)?\r?)$/gm;
const ours = /^\s*name:\s*['"]?dsh-world\/compaction['"]?\s*$/m;

function backupBeside(file: string): string {
  const backup = `${file}.dsh-world.${randomBytes(16).toString('hex')}.bak`;
  copyFileSync(file, backup);
  return backup;
}

/**
 * Replaces the profile's stock compaction row with `dsh-world/compaction`, the same edit as
 * `scripts/enable-tool-free-compaction.ps1`: a bundle patch cannot do it, because the stock row is written out in the
 * profile's own `cordis.patch.yml`, which sits above every plugin's patch. It changes the file only when exactly one
 * stock row is there, keeps a backup beside it and swaps atomically; DSH has to be restarted to load the new backend.
 */
export function swapStockCompaction(profileDir: string): CompactionSwap {
  const file = join(profileDir, 'cordis.patch.yml');
  if (!existsSync(file)) return { status: 'unchanged', reason: 'profile 里没有 cordis.patch.yml' };
  const text = readFileSync(file, 'utf8');
  if (ours.test(text)) return { status: 'already' };
  const rows = [...text.matchAll(stock)];
  if (rows.length !== 1) return { status: 'unchanged', reason: rows.length ? `找到 ${rows.length} 条原版压缩配置，无法确定改哪一条` : '没有找到原版压缩那一行（可能已换成别的压缩，或写法不同）' };
  const backup = backupBeside(file);
  const temporary = `${file}.${randomBytes(16).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, text.replace(stock, "$1'dsh-world/compaction'$3"), 'utf8');
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return { status: 'swapped', backup };
}

interface Row { name?: unknown; group?: unknown; config?: unknown }
/** The compaction rows in a preset's plugin list, including those nested in groups (where DSH's Web host isolates it). */
function compactionRows(rows: unknown, found: Row[] = []): Row[] {
  if (!Array.isArray(rows)) return found;
  for (const row of rows as Row[]) {
    if (row?.name === STOCK || row?.name === OURS) found.push(row);
    if (row?.group) compactionRows(row.config, found);
  }
  return found;
}
/** The preset's config with its one stock compaction row renamed to ours; the input is not changed. */
export function swapPresetConfig(config: unknown): { status: 'swapped'; config: unknown } | Exclude<CompactionSwap, { status: 'swapped' }> {
  const next = structuredClone(config) as { plugins?: unknown };
  const rows = compactionRows(next?.plugins);
  if (rows.some(row => row.name === OURS)) return { status: 'already' };
  if (rows.length !== 1) return { status: 'unchanged', reason: rows.length ? `预设里有 ${rows.length} 条原版压缩配置，无法确定改哪一条` : '预设里没有原版压缩那一行' };
  rows[0].name = OURS;
  return { status: 'swapped', config: next };
}

/** DSH's own editor for profile rows: the one its settings pages save through, which also reloads the row. */
export interface ConfigEditor {
  entries(): ConfigEntry[];
  edit(entry: ConfigEntry, change: (raw: unknown, inherited: unknown) => unknown): Promise<void>;
}
interface ConfigEntry { options: { id?: string; name?: string; config?: unknown } }
/**
 * DSH's Web host composes the stock compaction inside each preset, so the profile has no row to rename. The host's
 * preset editor writes the whole preset into the profile when a partner edits it; this does the same for her preset
 * with only the compaction row changed. That copy no longer follows later DSH updates to the preset.
 */
export async function swapPresetCompaction(editor: ConfigEditor, presetId: string, profileDir: string): Promise<CompactionSwap> {
  const entry = editor.entries().find(row => row.options.name === '@deepseek-ai/dsh-agent-preset' && (row.options.config as { id?: unknown } | undefined)?.id === presetId);
  if (!entry) return { status: 'unchanged', reason: `没有找到预设 ${presetId}` };
  const first = swapPresetConfig(entry.options.config);
  if (first.status !== 'swapped') return first;
  const file = join(profileDir, 'cordis.patch.yml');
  const backup = existsSync(file) ? backupBeside(file) : undefined;
  await editor.edit(entry, raw => {
    const result = swapPresetConfig(raw);
    if (result.status !== 'swapped') throw new Error(`预设 ${presetId} 在写入前变了：${result.status === 'unchanged' ? result.reason : '已经换过'}`);
    return result.config;
  });
  return { status: 'swapped', backup: backup ?? '（原来没有 cordis.patch.yml）', preset: presetId };
}

/**
 * Once per world, when the plugin first runs in a profile: make the profile use the tool-free compaction. The attempt is
 * remembered only when it succeeded or was already done, so a partner who later puts the stock one back is left alone,
 * while a profile this could not read is looked at again next start.
 */
export async function swapCompactionOnce(deps: { enabled: boolean; profileDir: string | undefined; done(): boolean; markDone(): void; report(message: string): void; swap?: (profileDir: string) => CompactionSwap | Promise<CompactionSwap> }): Promise<void> {
  if (!deps.enabled || deps.done() || !deps.profileDir) return;
  let result: CompactionSwap;
  try { result = await (deps.swap ?? swapStockCompaction)(deps.profileDir); }
  catch (error) { deps.report(`没能把压缩换成 dsh-world 的“只留对话”压缩：${error instanceof Error ? error.message : String(error)}`); return; }
  if (result.status === 'unchanged') { deps.report(`没有换成 dsh-world 的“只留对话”压缩（${result.reason}）：自动压缩仍由预设自带的压缩负责，dsh-world 的 75% 触发线不生效；控制台的“应用并压缩”和回顾后压缩照常可用。`); return; }
  deps.markDone();
  if (result.status !== 'swapped') return;
  const copied = result.preset ? `预设 ${result.preset} 已整份写进 profile，之后 DSH 升级对这个预设的改动不会自动进来；` : '';
  deps.report(`已把 profile 的压缩换成 dsh-world 的“只留对话”压缩，重启 DSH 后生效（原文件备份在 ${result.backup}）。${copied}不想换：恢复备份，并在 dsh-world 配置里写 replaceCompaction: false。`);
}
