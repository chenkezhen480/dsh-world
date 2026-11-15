import { ago, type ElsewhereNews } from '../../elsewhere.ts';

interface Group { chatId: string; name: string; count: number; lastSpeaker: string; lastAt: number; lastSelf: boolean }
const clean = (value: string) => [...value.replace(/[\r\n\u0000-\u001f「」]/g, ' ')].slice(0, 40).join('');
// The adapter permits a 60-second poll; leave one poll and a control-request margin before expiry.
const PRESENCE_TTL_MS = 2 * 60_000 + 5_000;
/** Ephemeral host view of the adapter's durable, account-bound counters. */
export function createWechatPresence() {
  let groups: Group[] = [], observedAt = 0;
  /** What the adapter last reported, while it is recent enough to stand for now; stale data cannot assert a quiet group. */
  const current = (now: Date) => {
    const age = now.getTime() - observedAt;
    return age < -60_000 || age > PRESENCE_TTL_MS ? [] : groups;
  };
  const speaker = (row: Group) => row.lastSelf ? '我自己' : row.lastSpeaker;
  return {
    clear() { groups = []; observedAt = 0; },
    accept(value: unknown): void {
      const input = value as { chats: { id: string; name: string }[]; presence?: { observedAt?: unknown; groups?: unknown } };
      if (!input.presence) { groups = []; observedAt = 0; return; }
      const report = input.presence;
      const at = typeof report.observedAt === 'string' ? Date.parse(report.observedAt) : NaN;
      if (!Number.isFinite(at) || !Array.isArray(report.groups) || report.groups.length > input.chats.length) throw new Error('微信群动态格式无效');
      const next = report.groups.map((value: unknown) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('微信群动态格式无效');
        const row = value as Record<string, unknown>;
        const chat = input.chats.find(chat => chat.id === row.chatId && chat.id.endsWith('@chatroom'));
        const lastAt = typeof row.lastAt === 'string' ? Date.parse(row.lastAt) : NaN;
        if (!chat || !Number.isSafeInteger(row.count) || (row.count as number) < 0 || (row.count as number) > 100
          || typeof row.lastSpeaker !== 'string' || !row.lastSpeaker || [...row.lastSpeaker].length > 80 || typeof row.lastSelf !== 'boolean'
          || !Number.isFinite(lastAt) || lastAt > at + 60_000) throw new Error('微信群动态不属于已配置群聊或内容无效');
        return { chatId: chat.id, name: clean(chat.name), count: row.count as number, lastSpeaker: clean(row.lastSpeaker), lastAt, lastSelf: row.lastSelf };
      });
      if (new Set(next.map(row => row.chatId)).size !== next.length) throw new Error('微信群动态重复');
      groups = next; observedAt = at;
    },
    /** Groups with messages she has not read: news from elsewhere, told once per change. */
    unread(now: Date): ElsewhereNews[] {
      return current(now).filter(row => row.count > 0).sort((a, b) => b.lastAt - a.lastAt).map(row => ({
        key: `wechat:${row.chatId}`, mark: `${row.count}:${row.lastAt}`,
        text: `微信群「${row.name}」${row.count > 99 ? '99+' : row.count} 条我还没看到，最后是${speaker(row)}（${ago(now.getTime() - row.lastAt)}）`,
      }));
    },
    /** How long the groups with nothing unread have been quiet, for her alarm: whether to speak up there is hers. */
    quiet(now: Date): string | undefined {
      const rows = current(now).filter(row => !row.count);
      if (!rows.length) return;
      const entries = [...rows].sort((a, b) => b.lastAt - a.lastAt).slice(0, 8).map(row => {
        const elapsed = ago(now.getTime() - row.lastAt);
        return `「${row.name}」${elapsed.endsWith('前') ? elapsed.slice(0, -1) + '没人说话' : '刚刚有发言'}，最后是${speaker(row)}`;
      });
      if (rows.length > entries.length) entries.push(`另有 ${rows.length - entries.length} 个群`);
      return '微信：' + entries.join('；');
    },
  };
}
