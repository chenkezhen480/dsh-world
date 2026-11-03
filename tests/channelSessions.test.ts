import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createChannelSessions } from '../src/ecosystem/shared/sessions.ts';
import { conversationKey, speakerIdentity } from '../src/ecosystem/shared/identity.ts';
import { createArchiveStore } from '../src/store.ts';
import { hostFixture, textResponse } from './hostFixture.ts';
import type { LifeHost } from '../src/life/host.ts';
import { createWorldRuntime } from '../src/runtime.ts';
import { createWechatHome } from '../src/ecosystem/wechat/home.ts';
import { record } from './fixtures.ts';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';

const identity = { channel: 'wechat', accountId: 'bot', conversationType: 'group' as const, conversationId: 'family@chatroom', conversationName: '幸福一家人', speakerId: 'wechat:owner' };

test('message provenance is retained and cannot change the conversation routing identity', () => {
  const supplied = { ...identity, platformMessageId: 'm.db:42', mentionIds: ['wechat:bot'] };
  assert.deepEqual(speakerIdentity(supplied), supplied);
  assert.equal(conversationKey(supplied), conversationKey(identity));
  for (const mentionIds of [['qq:bot'], [42], ['wechat:'], Array(65).fill('wechat:bot')]) assert.throws(() => speakerIdentity({ ...identity, mentionIds }));
  assert.throws(() => speakerIdentity({ ...identity, platformMessageId: '\n' }));
});

test('route keys distinguish platforms, accounts and conversation kinds while ignoring display names', () => {
  assert.equal(conversationKey(identity), conversationKey({ ...identity, conversationName: '改名', speakerId: 'wechat:mom' }));
  assert.notEqual(conversationKey(identity), conversationKey({ ...identity, channel: 'qq', speakerId: 'qq:owner' }));
  assert.notEqual(conversationKey(identity), conversationKey({ ...identity, accountId: 'another' }));
  assert.notEqual(conversationKey(identity), conversationKey({ ...identity, conversationType: 'private' }));
  assert.equal(speakerIdentity(identity).conversationType, 'group');
});

test('each group gets one durable session in the existing workspace without granting extra permissions', async t => {
  const { ctx, root, cleanup } = await hostFixture(t, () => textResponse('ok'));
  const store = createArchiveStore({ root, worldId: 'test', agentPreset: 'test', timeZone: 'UTC' }); cleanup.push(() => store.close());
  let created = 0;
  const archived = new Set<string>();
  const titles: string[] = [];
  const host: LifeHost = {
    workspace: async () => ({ id: 'room', sessionIds: [], attachSession: async () => {} }),
    createSession: async (cwd, preset, workspace) => {
      assert.equal(cwd, root); assert.equal(preset, 'test'); assert.equal(workspace, 'room');
      const id = SessionId('group-' + ++created);
      await ctx.agents.create({ sessionId: id, meta: { agentPreset: preset }, agentOptions: { provider: 'test', model: 'test' } }); return id;
    },
    resolveAgent: async id => ctx.agents.get(SessionId(id)), isArchived: id => archived.has(id),
    rename: async (_id, title) => { titles.push(title); }, origin: () => 'http://127.0.0.1',
  };
  const deps = { ctx, host, store, roomDir: root, roomTitle: '鲸鲸的房间', agentPreset: 'test' };
  const router = createChannelSessions(deps); cleanup.push(router.stop);
  const [a, b] = await Promise.all([router.open(identity), router.open(identity)]);
  assert.equal(a.id, b.id); assert.equal(created, 1);
  const reopened = createChannelSessions(deps); cleanup.push(reopened.stop);
  assert.equal((await reopened.open(identity)).id, a.id);
  assert.equal(created, 1); assert.match(titles[0], /微信.*幸福一家人/);
  archived.add(a.id);
  assert.notEqual((await reopened.open(identity)).id, a.id);
  assert.equal(created, 2);
});

test('groups receive the existing home memory while their own messages stay out of that archive', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, request => { requests.push(request); return textResponse('群内专属答复'); });
  const config = { root, worldId: 'test', agentPreset: 'test', timeZone: 'UTC', archiveScope: 'home' as const };
  const store = createArchiveStore(config); cleanup.push(() => store.close());
  await store.commitRecords([record('seed', { worldId: 'test', sourceSessionId: 'home', content: '家的已有记忆' })]);
  const isHome = (id: string) => id === 'home';
  const world = createWorldRuntime(ctx, config, store, { prompt: { names: { companion: '鲸鲸', partner: '伙伴' } }, isHome });
  await world.start(); cleanup.push(() => world.stop());
  const agent = (await ctx.agents.create({ sessionId: SessionId('group'), meta: { agentPreset: 'test' }, agentOptions: { provider: 'test', model: 'test' } })).agent;
  const channel = createWechatHome({ ctx, home: async () => agent }); cleanup.push(channel.stop);
  await channel.ask('只属于群的提问', identity);
  await world.flush();
  assert.match(JSON.stringify(requests[0].messages), /家的已有记忆/);
  const archived = (await store.readPage({ limit: 10 })).records;
  assert.equal(archived.length, 1);
  assert.doesNotMatch(JSON.stringify(archived), /群内专属答复|只属于群的提问/);
  assert.match(JSON.stringify(agent.session.deriveMessages()), /群内专属答复/);
});
