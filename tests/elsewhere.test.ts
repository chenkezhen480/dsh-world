import assert from 'node:assert/strict';
import test from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage, ToolCallId, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { SessionId, type Session } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { hostFixture, textResponse } from './hostFixture.ts';
import { createElsewhere, ELSEWHERE_HEADER, type ElsewhereNews } from '../src/elsewhere.ts';
import { createWorldRuntime } from '../src/runtime.ts';
import { createArchiveStore } from '../src/store.ts';

const config = { worldId: 'fish', agentPreset: 'companion', timeZone: 'Asia/Seoul' };
const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const kinds = (request: GenerateOptions) => request.messages.map(m => m.source?.kind as string | undefined);
const notices = (request: GenerateOptions) => request.messages.filter(m => m.source?.kind === 'dsh-world-elsewhere').map(m => m.content.flatMap(b => b.type === 'text' ? [b.text] : []).join(''));
const group = (count: number, at = '10:00'): ElsewhereNews => ({ key: 'wechat:family', mark: `${count}:${at}`, text: `微信群「家人」${count} 条我还没看到，最后是爸爸` });
/** Mirrors the host time-context plugin: the outermost pre-step listener appends its snapshot last. */
function hostTime(ctx: Context) {
  ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next();
    return decision.kind === 'reject' ? decision : { ...decision, messages: [...decision.messages, createUserMessage({ source: { kind: 'time-context' } as never, content: [{ type: 'text', text: 'Time sampled by host' }] })] };
  }, { prepend: true });
}

test('news from elsewhere is told once per change, a place she caught up with is news again next time, and a retold session hears what is pending', () => {
  const elsewhere = createElsewhere(), session = {} as Session, other = {} as Session, now = new Date();
  let pending: ElsewhereNews[] = [];
  const unregister = elsewhere.register({ look: '微信群用 wechat_history 看', news: () => pending });
  assert.equal(elsewhere.take(session, now), undefined, 'nothing pending, nothing said');
  pending = [group(3)];
  assert.equal(elsewhere.take(session, now), `${ELSEWHERE_HEADER}\n- 微信群「家人」3 条我还没看到，最后是爸爸\n（微信群用 wechat_history 看）`);
  assert.equal(elsewhere.take(session, now), undefined, 'the same news is not told twice');
  assert.match(elsewhere.take(other, now)!, /3 条/, 'each session is told for itself');
  pending = [group(5, '10:02')];
  assert.match(elsewhere.take(session, now)!, /5 条/, 'more messages are news, with the running count');
  pending = [];
  assert.equal(elsewhere.take(session, now), undefined);
  pending = [group(5, '10:02')];
  assert.match(elsewhere.take(session, now)!, /5 条/, 'after she caught up, the place is forgotten');
  elsewhere.retell(session);
  assert.match(elsewhere.take(session, now)!, /5 条/, 'retold after what she was told left her view');
  unregister();
  elsewhere.retell(session);
  assert.equal(elsewhere.take(session, now), undefined, 'an unregistered source says nothing');
});

test('at a turn start the news comes before the new message, later in the turn at the step end before the time, appended and never outside her world', async t => {
  const requests: GenerateOptions[] = [];
  let pending: ElsewhereNews[] = [group(3)];
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* (request) {
    requests.push(request);
    if (requests.length === 3) {
      const block = { type: 'tool-call' as const, id: ToolCallId('call'), name: 'wait', arguments: '{}' };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: 'wait', argumentsDelta: '{}' };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
    }
    yield* textResponse('嗯');
  });
  hostTime(ctx);
  ctx.tools.register(defineTool({ name: 'wait', description: 'test', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => { pending = [group(4, '10:05')]; return 'ok'; } }));
  const elsewhere = createElsewhere();
  elsewhere.register({ look: '微信群用 wechat_history 看', news: () => pending });
  const store = createArchiveStore({ ...config, root });
  const world = createWorldRuntime(ctx, config, store, { prompt: { names: { companion: '鱼', partner: '我' } }, isHome: id => id === 'home', elsewhere });
  await world.start(); cleanup.push(() => world.stop().finally(() => store.close()));
  const { agent } = await ctx.agents.create({ sessionId: SessionId('home'), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } });
  const say = async (text: string) => { agent.followup(user(text)); await agent.whenIdle(); return requests.at(-1)!; };

  const first = await say('在吗');
  assert.deepEqual(kinds(first).slice(-3), ['dsh-world-elsewhere', 'user', 'time-context'], 'what gathered before the message, right before it');
  assert.match(notices(first)[0]!, /^【别处的动静】[\s\S]*3 条我还没看到[\s\S]*（微信群用 wechat_history 看）$/);

  const second = await say('还在');
  assert.equal(notices(second).length, 1, 'nothing new, nothing told');
  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages, 'appended; the earlier notice stays where it was');

  await say('等一下');
  const later = requests.at(-1)!;
  assert.equal(notices(later).length, 2, 'news arriving mid-turn is told on the next step');
  assert.deepEqual(kinds(later).slice(-2), ['dsh-world-elsewhere', 'time-context'], 'at the step end, ahead of the time');
  assert.match(notices(later)[1]!, /4 条我还没看到/);

  pending = [group(9, '11:00')];
  const outside = await ctx.agents.create({ sessionId: SessionId('work'), meta: { agentPreset: 'coding' }, agentOptions: { provider: 'test', model: 'test' } });
  outside.agent.followup(user('写代码')); await outside.agent.whenIdle();
  assert.deepEqual(notices(requests.at(-1)!), [], 'a session outside her world never hears it');
  assert.equal(errors.length, 0, errors.map(e => String((e as { error: Error }).error)).join('\n'));
});

test('her other sessions are news by count, never words, from the moment a session starts hearing; paging the newest lines of one with memory_find catches it up', async t => {
  const requests: { session: string; request: GenerateOptions }[] = [];
  let calls: { name: string; arguments: string }[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* (request) {
    const session = String((request as { sessionId?: string }).sessionId ?? '');
    requests.push({ session, request });
    const call = session === 'home' ? calls.shift() : undefined;
    if (call) {
      const block = { type: 'tool-call' as const, id: ToolCallId('call-' + requests.length), name: call.name, arguments: call.arguments };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: call.name, argumentsDelta: call.arguments };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
    }
    yield* textResponse('嗯');
  });
  hostTime(ctx);
  const store = createArchiveStore({ ...config, root });
  const { createMemory } = await import('../src/memory.ts');
  const memory = createMemory({ store: store.memory, timeZone: config.timeZone, sources: { diaryDir: root }, visible: () => true });
  const elsewhere = createElsewhere();
  const world = createWorldRuntime(ctx, config, store, { prompt: { names: { companion: '鱼', partner: '我' } }, isHome: id => id === 'home', elsewhere, memory });
  await world.start(); cleanup.push(() => world.stop().finally(() => store.close()));
  const open = async (id: string) => (await ctx.agents.create({ sessionId: SessionId(id), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } })).agent;
  const home = await open('home'), other = await open('other');
  const say = async (agent: typeof home, text: string) => { agent.followup(user(text)); await agent.whenIdle(); await ctx.sessions.flush(agent.session); await world.flush(); };
  const lastHome = () => requests.filter(entry => entry.session === 'home').at(-1)!.request;

  await say(other, '这句是很久以前的');
  await say(home, '早');
  assert.deepEqual(notices(lastHome()), [], 'what was said before this session started hearing is not news');

  await say(other, '秘密的话');
  await say(home, '在吗');
  const told = notices(lastHome());
  assert.equal(told.length, 1);
  assert.match(told[0]!, /另一个窗口（other）有 2 条我在这边没看到，最后是我自己（刚刚）；sourceId：chat:other/);
  assert.doesNotMatch(told[0]!, /秘密的话/, 'never the words');
  assert.match(told[0]!, /别的会话用 memory_find 带上那一行的 sourceId 翻最新的/);

  calls = [{ name: 'memory_find', arguments: JSON.stringify({ sourceId: 'chat:other' }) }];
  await say(home, '看看那边');
  await say(other, '又说了一句');
  calls = [];
  await say(home, '然后呢');
  assert.match(notices(lastHome()).at(-1)!, /有 2 条我在这边没看到/, 'after she paged it, only what came later counts');
  calls = [{ name: 'memory_find', arguments: JSON.stringify({ sourceId: 'chat:other', order: 'desc' }) }];
  await say(home, '再看看');
  await say(other, '第三句');
  calls = [];
  await say(home, '嗯');
  assert.match(notices(lastHome()).at(-1)!, /有 2 条我在这边没看到/, 'newest first written as desc is paging the newest too');

  const asOther = requests.filter(entry => entry.session === 'other').at(-1)!.request;
  assert.ok(notices(asOther).length > 0 && notices(asOther).every(text => /家有 \d+ 条我在这边没看到/.test(text)), 'the other session hears of home the same way');
  assert.equal(errors.length, 0, errors.map(e => String((e as { error: Error }).error)).join('\n'));
});

test('in a group session, her recent chats and news from elsewhere both say private words stay out of the group; home and DSH windows are not told so', async t => {
  const requests: { session: string; request: GenerateOptions }[] = [];
  const { ctx, root, cleanup, errors } = await hostFixture(t, async function* (request) {
    requests.push({ session: String((request as { sessionId?: string }).sessionId ?? ''), request });
    yield* textResponse('嗯');
  });
  const store = createArchiveStore({ ...config, root });
  store.bindChannelSession(JSON.stringify(['wechat', 'bot', 'group', 'family@chatroom']), 'group');
  const elsewhere = createElsewhere();
  const world = createWorldRuntime(ctx, config, store, { prompt: { names: { companion: '鱼', partner: '我' } }, isHome: id => id === 'home', elsewhere });
  await world.start(); cleanup.push(() => world.stop().finally(() => store.close()));
  const open = async (id: string) => (await ctx.agents.create({ sessionId: SessionId(id), meta: { agentPreset: 'companion' }, agentOptions: { provider: 'test', model: 'test' } })).agent;
  const home = await open('home'), group = await open('group');
  const say = async (agent: typeof home, text: string) => { agent.followup(user(text)); await agent.whenIdle(); await ctx.sessions.flush(agent.session); await world.flush(); };
  const last = (id: string) => requests.filter(entry => entry.session === id).at(-1)!.request;
  const recall = (request: GenerateOptions) => request.messages.filter(m => m.source?.kind === 'dsh-world-history').map(m => m.content.flatMap(b => b.type === 'text' ? [b.text] : []).join('')).join('');
  const privacy = /我现在在群里。家里和私聊里的话是我和对方之间的：不把原话和细节带进群里说/;

  await say(home, '只跟你说的事');
  await say(group, '大家好');
  assert.match(recall(last('group')), /只跟你说的事[\s\S]*我现在在群里/, 'her recent chats in a group come with the rule');
  await say(home, '还有一件');
  await say(group, '在吗');
  assert.match(notices(last('group')).at(-1)!, /家有 \d+ 条我在这边没看到[\s\S]*我现在在群里/);
  await say(home, '回来了');
  assert.doesNotMatch(recall(last('home')) + notices(last('home')).join(''), privacy, 'home is not a group');
  assert.ok(notices(last('home')).length > 0);
  assert.equal(errors.length, 0, errors.map(e => String((e as { error: Error }).error)).join('\n'));
});
