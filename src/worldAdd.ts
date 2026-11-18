import { existsSync, readFileSync } from 'node:fs';
import { durableWrite } from './life/lifeStore.ts';
import { validWorldId } from './worldRoutes.ts';

/** The loader id of a world added from the console; the first world keeps whatever id its partner gave it. */
export const worldEntryId = (worldId: string) => `dsh-world-${worldId}`;

const said = (line: string) => line.trim() !== '' && !line.trimStart().startsWith('#');

/**
 * Adds one more world to the profile's patch file, as the row the README has partners write by hand. The host's
 * config editor can only change rows that are already loaded, so the row is appended as text: every line already
 * there, comments included, stays as it is. The host reads the file when it starts, so the world appears after a
 * restart. Refuses, with the reason, anything it cannot add safely.
 */
export function addWorldEntry(patchFile: string, worldId: string, companionName: string): void {
  if (!validWorldId(worldId)) throw new Error('世界的名字只能用字母、数字、- 和 _，以字母或数字开头，最多 64 个字符');
  const before = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : '';
  const lines = before.split(/\r?\n/);
  const rows = lines.filter(said);
  // A new profile's patch is the host's comment and an empty list; the list is what the first row replaces.
  const emptyList = rows.length === 1 && rows[0]!.trim() === '[]';
  // Appending a row is only safe to a block list; any other shape is left for its owner to edit.
  if (rows.length && !emptyList && !rows.some(line => line.startsWith('- '))) throw new Error(`配置文件 ${patchFile} 不是逐条列出的格式，请手动添加（见 README「添加第二个世界」）`);
  const taken = new RegExp(String.raw`^\s*(?:-\s+)?(?:worldId:\s*['"]?${worldId}['"]?|id:\s*['"]?${worldEntryId(worldId)}['"]?)\s*(?:#.*)?$`, 'i');
  if (rows.some(line => taken.test(line))) throw new Error(`配置里已经有 ${worldId} 这个世界了`);
  const row = [
    '# dsh-world：从世界控制台新增的世界。',
    '- insert:',
    `    - id: ${worldEntryId(worldId)}`,
    '      name: dsh-world',
    '      config:',
    `        worldId: ${worldId}`,
    ...(companionName ? [`        companionName: ${JSON.stringify(companionName)}`] : []),
    '',
  ].join('\n');
  const kept = (emptyList ? before.replace(/^[ \t]*\[\][ \t]*\r?\n?/m, '') : before).replace(/\s*$/, '');
  durableWrite(patchFile, kept ? `${kept}\n\n${row}` : row);
}
