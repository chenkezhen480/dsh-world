import { DatabaseSync } from 'node:sqlite';
import type { Context } from '@deepseek-ai/cordis';
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { conversationRecordId } from '../../archive.ts';
import { chatLabel, speakerIdentity } from '../shared/identity.ts';
import { deliveryNotice, replyMessages, wechatSendTool, wechatTextOutput } from './messages.ts';
import type { PreparedReply, WechatReceipt } from './archive.ts';

interface Target { id: string; name: string }
interface Job { id: string; accountId: string; chatId: string; messages: ReturnType<typeof replyMessages> }
interface Row { id: string; sessionId: string; messageId: string; status: string; body: string; confirmed: number; error: string | null }

/** The existing adapter owns all sending; a claim survives disconnects until its receipt is recorded. */
export function createWechatSending(deps: { ctx: Context; file: string; worldId: string; hasSticker?(id: string): Promise<boolean>; record?(reply: PreparedReply): Promise<string>; receipt?(receipt: WechatReceipt): Promise<void> }) {
  const db = new DatabaseSync(deps.file);
  db.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS binding (accountId TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, messageId TEXT NOT NULL,
      status TEXT NOT NULL, body TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0, error TEXT);
    CREATE INDEX IF NOT EXISTS queueOrder ON jobs(status);`);
  let accountId: string | undefined;
  let chats: Target[] = [];
  let stopped = false;
  const pending = new Set<Promise<void>>();
  const rowOf = (id: string) => db.prepare('SELECT * FROM jobs WHERE id=? LIMIT 1').get(id) as unknown as Row | undefined;
  /**
   * A batch that did not go out, or may have gone out only in part, is told once to the session that sent it, at its
   * next step (it is not woken for it), so she need not check every receipt. A session that is gone keeps it in the archive.
   */
  function tell(id: string, outcome: Parameters<typeof deliveryNotice>[2]): void {
    const row = rowOf(id);
    const agent = row && deps.ctx.agents.get(SessionId(row.sessionId));
    if (!row || !agent) return;
    const job: Job = JSON.parse(row.body);
    const chat = chatLabel('wechat', job.chatId.endsWith('@chatroom') ? 'group' : 'private', chats.find(chat => chat.id === job.chatId)?.name ?? job.chatId);
    try { agent.inject(createUserMessage({ source: { kind: 'dsh-world-wechat-delivery' }, content: [{ type: 'text', text: deliveryNotice(chat, job.messages, outcome) }] })); }
    catch (error) { deps.ctx.logger.warn('dsh-world: WeChat delivery notice not delivered:', error); }
  }
  /** Fails a batch that never reached the adapter; only the first failure is told. */
  function fail(id: string, error: string, onlyStaged: boolean): void {
    const { changes } = db.prepare(`UPDATE jobs SET status='failed',error=? WHERE id=?${onlyStaged ? " AND status='staged'" : ''}`).run(error, id);
    if (changes) tell(id, { status: 'failed', error });
  }
  function transaction<T>(run: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try { const result = run(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  async function release(sessionId: string, event: SessionEvent, turn: number): Promise<void> {
    if (event.type !== 'user/message' || event.data.source.kind !== 'dsh-world-wechat-outgoing') return;
    const id = conversationRecordId(deps.worldId, sessionId, event.data.id);
    const row = rowOf(id);
    if (!row || row.status !== 'staged') return;
    const source = event.data.source;
    const job: Job = JSON.parse(row.body);
    const identity = speakerIdentity(source.identity);
    const messages = replyMessages(source.messages);
    if (job.accountId !== identity.accountId || job.chatId !== identity.conversationId || JSON.stringify(job.messages) !== JSON.stringify(messages)) throw new Error('微信发送正文与持久化队列不一致');
    const recorded = await deps.record?.({ sessionId, messageId: event.data.id, seq: event.seq, turn, time: event.time, identity, messages });
    if (recorded && recorded !== id) throw new Error('微信发送记录 ID 不一致');
    db.prepare("UPDATE jobs SET status='queued' WHERE id=? AND status='staged'").run(id);
  }
  async function ready(session: Session, event: SessionEvent): Promise<void> {
    await deps.ctx.sessions.flush(session);
    const turn = session.snapshotEvents().findLast(item => item.type === 'turn/start' && item.seq < event.seq);
    if (turn?.type !== 'turn/start') throw new Error('微信发送记录缺少来源轮次');
    await release(session.id, event, turn.data.turn);
  }
  const dispose = deps.ctx.on('session/event', (session, event) => {
    if (stopped || event.type !== 'user/message' || event.data.source.kind !== 'dsh-world-wechat-outgoing') return;
    const job = Promise.resolve().then(() => ready(session, event)).catch(error => {
      fail(conversationRecordId(deps.worldId, session.id, event.data.id), String(error), true);
      deps.ctx.logger.error(error);
    }).finally(() => pending.delete(job));
    pending.add(job);
  });
  async function settle() { while (pending.size) await Promise.all(pending); }
  async function recover(): Promise<void> {
    await settle();
    let after = '';
    while (true) {
      const rows = db.prepare("SELECT * FROM jobs WHERE status='staged' AND id>? ORDER BY id LIMIT 50").all(after) as unknown as Row[];
      if (!rows.length) return;
      for (const row of rows) {
        after = row.id;
        const live = deps.ctx.sessions.get(SessionId(row.sessionId));
        if (deps.ctx.agents.get(SessionId(row.sessionId))?.status === 'running') continue;
        if (live) await deps.ctx.sessions.flush(live);
        const handle = await deps.ctx.sessionPersistence.open(SessionId(row.sessionId), 'read');
        try {
          let next = 0, found = false, turn = 0;
          for (;;) {
            const { events } = await handle.read(next, 128);
            if (!events.length) break;
            for (const event of events) {
              if (event.type === 'turn/start') turn = event.data.turn;
              if (event.type === 'user/message' && event.data.id === row.messageId && event.data.source.kind === 'dsh-world-wechat-outgoing') {
                await release(row.sessionId, event, turn);
                found = true; break;
              }
            }
            if (found) break;
            next = events.at(-1)!.seq + 1;
          }
          if (!found) fail(row.id, '发送内容尚未写入会话，未发送', false);
        } finally { await handle.close(); }
      }
    }
  }
  function target(chatId: string) {
    if (stopped || !accountId) throw new Error('微信适配器尚未连接');
    const chat = chats.find(chat => chat.id === chatId);
    if (!chat) throw new Error('只能使用 wechat_chats 列出的已配置聊天');
    return speakerIdentity({ channel: 'wechat', accountId, speakerId: `wechat:${accountId}`, conversationId: chat.id, conversationName: chat.name, conversationType: chat.id.endsWith('@chatroom') ? 'group' : 'private' });
  }
  const tools = [defineTool({
    name: 'wechat_chats', description: '分页查看已绑定微信账号允许发送的私聊和群，返回准确 chatId。群聊可先用 wechat_history 读消息，再用 wechat_send 发言；不能访问列表外聊天。',
    parameters: { limit: { type: 'integer' }, offset: { type: 'integer' } }, output: wechatTextOutput,
    execute: async ({ limit = 20, offset = 0 }) => {
      if (stopped || !accountId) throw new Error('微信适配器尚未连接');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('分页参数无效');
      return JSON.stringify({ accountId, chats: chats.slice(offset, offset + limit).map(chat => ({ chatId: chat.id, name: chat.name, type: chat.id.endsWith('@chatroom') ? 'group' : 'private' })), hasMore: offset + limit < chats.length });
    },
  }), wechatSendTool(async (chatId, messages, context) => {
    const identity = target(chatId);
    for (const message of messages) if ('stickerId' in message && deps.hasSticker && !await deps.hasSticker(message.stickerId)) throw new Error(`表情库里没有 ${message.stickerId}，先用 sticker_search 查到准确的 id`);
    const boundAccount = identity.accountId;
    const agent = context.agent;
    if (!agent) throw new Error('微信发送需要来源会话');
    context.signal.throwIfAborted();
    const message = createUserMessage({ source: { kind: 'dsh-world-wechat-outgoing', form: 'recall', identity, messages }, content: [{ type: 'text', text: `（已排队发往${chatLabel('wechat', identity.conversationType, identity.conversationName ?? chatId)}，共 ${messages.length} 条，正文就是上面 wechat_send 里的；发送确认前不要重发）` }] });
    const id = conversationRecordId(deps.worldId, agent.id, message.id);
    transaction(() => db.prepare("INSERT INTO jobs(id,sessionId,messageId,status,body) VALUES (?,?,?,'staged',?)").run(id, agent.id, message.id, JSON.stringify({ id, accountId: boundAccount, chatId, messages } satisfies Job)));
    context.deferContext(message);
    return JSON.stringify({ id, status: 'queued', total: messages.length, note: '已排队，由适配器发送；没发出或结果不明会另有消息告诉我，不用查回执，也不要重复调用。' });
  }), defineTool({
    name: 'wechat_delivery', description: '按 wechat_send 返回的 ID 查询排队或发送结果，平时不用查：没发出或结果不明会另有消息告诉我。sent 只代表微信服务器已确认发送，不代表对方已读；uncertain 不得自动重发。',
    parameters: { id: { type: 'string', required: true } }, output: wechatTextOutput,
    execute: async ({ id }) => {
      if (stopped) throw new Error('微信模块已停止');
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('无效的发送 ID');
      const row = rowOf(id);
      if (!row) throw new Error('没有这条微信发送记录');
      const job: Job = JSON.parse(row.body);
      return JSON.stringify({ id, chatId: job.chatId, status: row.status, confirmed: row.confirmed, total: job.messages.length, ...(row.error ? { error: row.error } : {}) });
    },
  })];
  return {
    tools,
    target,
    /** Bound account, chats the adapter reported, and jobs waiting to go out or needing a human check. */
    status() {
      const count = (...states: string[]) => (db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status IN (${states.map(() => '?').join(',')})`).get(...states) as { n: number }).n;
      return { accountId: accountId ?? null, chats: chats.length, pending: count('staged', 'queued', 'claimed'), uncertain: count('uncertain') };
    },
    async poll(value: unknown): Promise<Job | undefined> {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的适配器绑定');
      const input = value as { accountId?: unknown; chats?: unknown };
      speakerIdentity({ channel: 'wechat', accountId: input.accountId, speakerId: `wechat:${input.accountId}`, conversationId: 'binding' });
      if (!Array.isArray(input.chats) || !input.chats.length || input.chats.length > 1000) throw new Error('无效的目标列表');
      const targets = input.chats.map((value: unknown) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的聊天');
        const chat = value as Target;
        speakerIdentity({ channel: 'wechat', accountId: input.accountId, speakerId: `wechat:${input.accountId}`, conversationId: chat.id, conversationName: chat.name });
        if (typeof chat.name !== 'string' || !chat.name.trim()) throw new Error('聊天缺少名称');
        return { id: chat.id, name: chat.name };
      });
      if (new Set(targets.map(chat => chat.id)).size !== targets.length) throw new Error('聊天 ID 不能重复');
      transaction(() => {
        const previous = db.prepare('SELECT accountId FROM binding LIMIT 1').get()?.accountId;
        if (previous && previous !== input.accountId) throw new Error('微信发送队列已绑定其他账号，拒绝切换');
        db.prepare('INSERT OR IGNORE INTO binding VALUES (?)').run(input.accountId as string);
      });
      accountId = input.accountId as string; chats = targets;
      await recover();
      return transaction(() => {
        const row = db.prepare("SELECT * FROM jobs WHERE status IN ('claimed','queued') ORDER BY CASE status WHEN 'claimed' THEN 0 ELSE 1 END,rowid LIMIT 1").get() as unknown as Row | undefined;
        if (!row) return;
        const job: Job = JSON.parse(row.body);
        if (job.accountId !== accountId || !chats.some(chat => chat.id === job.chatId)) throw new Error('待发送任务的账号或聊天已不在配置中，需人工核对');
        db.prepare("UPDATE jobs SET status='claimed' WHERE id=?").run(job.id);
        return job;
      });
    },
    async receipt(receipt: WechatReceipt) {
      const row = rowOf(receipt.id);
      if (!row && !deps.receipt) throw new Error('回执存储不可用');
      if (row) {
        const job: Job = JSON.parse(row.body);
        if (!['claimed', 'sent', 'uncertain', 'failed'].includes(row.status) || receipt.confirmed < row.confirmed || receipt.confirmed > job.messages.length || (receipt.status === 'sent') !== (receipt.confirmed === job.messages.length) || (receipt.status === 'failed' && receipt.confirmed !== 0) || (row.status === 'sent' && receipt.status !== 'sent')) throw new Error('无效或过时的微信回执');
      }
      await deps.receipt?.(receipt);
      if (!row) return;
      transaction(() => db.prepare('UPDATE jobs SET status=?,confirmed=? WHERE id=?').run(receipt.status, receipt.confirmed, receipt.id));
      if (row.status !== receipt.status && receipt.status !== 'sent') tell(receipt.id, receipt.status === 'failed' ? { status: 'failed' } : { status: 'uncertain', confirmed: receipt.confirmed });
    },
    async stop() { if (stopped) return; stopped = true; dispose(); await settle(); db.close(); },
  };
}
