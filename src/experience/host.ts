import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createUserMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import { conversationKey, speakerIdentity } from '../ecosystem/shared/identity.ts';
import { durableWrite } from '../life/lifeStore.ts';
import { experience, newState } from './experience.mjs';
import { connectModel } from './model.mjs';

const words = (blocks: readonly ContentBlock[]) => blocks.flatMap(b => b.type === 'text' ? [b.text] : []).join('\n');

export function createExperience(worldId: string, worldDir: string,
  identity: () => { name: string; persona: string; self: string },
  idleMessage: (session: Session) => string | undefined, model = connectModel) {
  let writes = Promise.resolve();
  return async (session: Session, messages: readonly UserMessage[], signal: AbortSignal, admitted: () => boolean) => {
    const user = messages.findLast(m => m.source.kind === 'user');
    const wakeId = !user && messages.some(m => m.source.kind === 'dsh-world-life') && idleMessage(session);
    const message = user ?? messages.find(m => m.source.kind === 'dsh-world-life' && m.id === wakeId);
    if (!message) return;
    const speaker = 'identity' in message.source ? speakerIdentity(message.source.identity) : undefined;
    if (speaker?.conversationType === 'group') return;
    const text = words(message.content);
    if (!text.trim()) return;
    // Channel conversations have their own private notes. A fresh local DSH chat shares the world's notes.
    const key = speaker ? '-' + createHash('sha256').update(conversationKey(speaker)).digest('hex') : '';
    const file = join(worldDir, 'experience' + key + '.json');
    const updated = writes.then(async () => {
      signal.throwIfAborted();
      if (!admitted()) return;
      const before = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : newState();
      const minute = Date.now() / 60000;
      if (!user && !before.concerns?.some((item: { revisitAt: number | null }) => item.revisitAt != null && item.revisitAt <= minute)) return;
      const history = session.surface.nodes.flatMap(seq => {
        const e = session.eventAt(seq);
        if (e?.type === 'user/message' && e.data.source.kind === 'user') return [{ role: 'user', content: words(e.data.content) }];
        if (e?.type !== 'assistant/message') return [];
        const content = words(e.data.message.content);
        return content ? [{ role: 'assistant', content }] : [];
      });
      const host = identity(), complete = model();
      const row = await experience((messages: unknown[], options: object = {}) => complete(messages, options, signal),
        before, history, { host, minute, kind: user ? 'chat' : 'wake', text });
      signal.throwIfAborted();
      if (!admitted()) return;
      const saved = JSON.stringify(row.state);
      if (saved !== JSON.stringify(before)) durableWrite(file, saved, undefined, 0o600);
      const body = row.context || (row.kind === 'direct' || row.kind === 'standalone' ? '眼前是一个独立话题，我只想接住这一句。' : '');
      if (body) return { before: message.id, note: createUserMessage({
        source: { kind: 'dsh-world-mood', form: 'snapshot', worldId },
        content: [{ type: 'text', text: `【房间私记 · ${host.name} 自述】\n${body}\n【私记结束】` }],
      }) };
    });
    writes = updated.then(() => {}, () => {});
    return updated;
  };
}
