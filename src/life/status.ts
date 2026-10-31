import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { durableWrite } from './lifeStore.ts';

/** What she says about herself right now; the console shows it as a card, nothing else reads it. */
export interface HerStatus { at: string; mood?: string; energy?: number; chips?: string[]; note?: string }
export interface StatusPatch { mood?: string; energy?: number; chips?: readonly string[]; note?: string }

const MOOD_MAX = 12;
const NOTE_MAX = 60;
const CHIP_MAX = 12;
const CHIPS_MAX = 4;

const short = (value: string) => value.trim().replace(/\s+/g, ' ');

/**
 * Her own status card: a mood, how much she has left, a few short lines of her own choosing (rice,
 * weather, a sore tail — whatever), and one sentence she wants it to carry. She writes it with
 * `set_status`; the console only reads it.
 *
 * Nothing here decides anything, so a broken or missing file is simply an empty card.
 */
export function createStatusBoard(options: { worldDir: string; now?: () => Date }) {
  const file = join(options.worldDir, 'status.json');
  const now = options.now ?? (() => new Date());

  function chipsOf(value: unknown, limit?: number): string[] {
    if (!Array.isArray(value)) return [];
    const chips = value
      .filter((chip): chip is string => typeof chip === 'string')
      .map(chip => short(chip))
      .filter(chip => chip.length > 0);
    return limit === undefined ? chips : chips.slice(0, limit);
  }

  function read(): HerStatus | undefined {
    if (!existsSync(file)) return undefined;
    try {
      const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<HerStatus>;
      if (!value || typeof value !== 'object' || typeof value.at !== 'string') return undefined;
      const chips = chipsOf(value.chips, CHIPS_MAX);
      return {
        at: value.at,
        ...(typeof value.mood === 'string' && value.mood ? { mood: value.mood } : {}),
        ...(typeof value.energy === 'number' ? { energy: value.energy } : {}),
        ...(chips.length ? { chips } : {}),
        ...(typeof value.note === 'string' && value.note ? { note: value.note } : {}),
      };
    } catch { return undefined; }
  }

  function positive(value: unknown, name: string, max: number): number | undefined {
    if (value === undefined || value === null) return undefined;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > max) throw new Error(`${name}要写 0 到 ${max} 之间的数。`);
    return Math.round(number * 10) / 10;
  }

  /** Only what she gives this time changes; everything else stays as it was. */
  function write(patch: StatusPatch): string {
    const current = read();
    const next: HerStatus = { ...current, at: now().toISOString() };
    let touched = false;
    if (patch.mood !== undefined) {
      const mood = short(String(patch.mood));
      if ([...mood].length > MOOD_MAX) throw new Error(`心情最多 ${MOOD_MAX} 个字，短一点更像状态卡。`);
      touched = true;
      if (mood) next.mood = mood; else delete next.mood;
    }
    if (patch.note !== undefined) {
      const note = short(String(patch.note));
      if ([...note].length > NOTE_MAX) throw new Error(`那句话最多 ${NOTE_MAX} 个字，长了就写进日记吧。`);
      touched = true;
      if (note) next.note = note; else delete next.note;
    }
    const energy = positive(patch.energy, '精力', 100);
    if (energy !== undefined) { next.energy = energy; touched = true; }
    if (patch.chips !== undefined) {
      const chips = chipsOf(Array.isArray(patch.chips) ? patch.chips : [patch.chips]);
      if (chips.length > CHIPS_MAX) throw new Error(`小标签最多 ${CHIPS_MAX} 个，再多卡片就挤了。`);
      for (const chip of chips) if ([...chip].length > CHIP_MAX) throw new Error(`每个小标签最多 ${CHIP_MAX} 个字，短一点更好看。`);
      touched = true;
      if (chips.length) next.chips = chips; else delete next.chips;
    }
    if (!touched) throw new Error('至少写一样：mood（心情）、energy（精力 0–100）、chips（几个小标签）、note（一句话）。');
    durableWrite(file, `${JSON.stringify(next, null, 2)}\n`);
    return `状态卡已更新：${describe(next)}。`;
  }

  return { file, read, write };
}
export type StatusBoard = ReturnType<typeof createStatusBoard>;

/** One line for her tool result and nowhere else; the console words it its own way. */
export function describe(status: HerStatus): string {
  const parts: string[] = [];
  if (status.mood) parts.push(status.mood);
  if (status.energy !== undefined) parts.push(`精力 ${status.energy}`);
  if (status.chips?.length) parts.push(status.chips.join('、'));
  if (status.note) parts.push(`「${status.note}」`);
  return parts.join(' · ');
}