import type { Complete } from './model.mjs';

interface State {
  concerns: { text: string; cues: string[]; source?: string; revisitAt: number | null }[];
  energy: string;
  energyAt: number | null;
}
export function newState(): State;
export function experience(complete: Complete, state: State, history: { role: string; content: string }[], event: {
  host: { name: string; persona: string; self: string }; minute: number; kind: 'chat' | 'wake'; text: string;
}): Promise<{ state: State; kind: string; context?: string }>;
