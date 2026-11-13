import { existsSync, readFileSync, rmSync } from 'node:fs';
import { durableWrite } from './life/lifeStore.ts';
import { parseSections } from './life/messages.ts';

/** Her persona in layers, each a `## 名字` section of `<world>/persona.md`, filled in the world console. */
export const PERSONA_LAYERS = ['名字', '她是谁', '性格', '说话方式', '愿景', '补充'] as const;
export type PersonaLayer = typeof PERSONA_LAYERS[number];
export type Persona = Record<PersonaLayer, string>;

/** Missing or unreadable means not written yet: every layer empty. */
export function readPersona(file: string): Persona {
  let sections = new Map<string, string>();
  try { if (existsSync(file)) sections = parseSections(readFileSync(file, 'utf8'), PERSONA_LAYERS); } catch { /* treated as not written */ }
  // The name also goes into channel metadata, so a custom heading cannot be part of it.
  const name = sections.get('名字') ?? '';
  const customHeading = name.search(/^## .+/m);
  if (customHeading >= 0) {
    sections.set('名字', name.slice(0, customHeading).trimEnd());
    sections.set('补充', [name.slice(customHeading), sections.get('补充')].filter(Boolean).join('\n\n'));
  }
  return Object.fromEntries(PERSONA_LAYERS.map(layer => [layer, sections.get(layer) ?? ''])) as Persona;
}
/** Only layers with text are kept; a persona with none removes the file. */
export function writePersona(file: string, persona: Partial<Persona>): void {
  const kept = PERSONA_LAYERS.flatMap(layer => { const text = persona[layer]?.trim(); return text ? [`## ${layer}\n${text}`] : []; });
  if (kept.length) durableWrite(file, `${kept.join('\n\n')}\n`); else rmSync(file, { force: true });
}
/** The persona as she reads it at the top of her system prompt, in her own voice; empty when nothing is written. */
export function renderPersona(persona: Persona): string {
  const opening = [persona.名字 ? `我是${persona.名字}。` : '', persona.她是谁].filter(Boolean).join('');
  const layers = (['性格', '说话方式', '愿景'] as const).flatMap(layer => persona[layer] ? [`# ${layer}\n${persona[layer]}`] : []);
  return [opening, ...layers, persona.补充].filter(Boolean).join('\n\n');
}
