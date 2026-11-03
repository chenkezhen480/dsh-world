import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { SessionId } from '@deepseek-ai/dsh-session';
import { AttachmentId, type SaveImageAttachment } from '@deepseek-ai/dsh-attachment';
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { createWechatHome } from '../src/ecosystem/wechat/home.ts';
import { admitContextImages } from '../src/ecosystem/wechat/images.ts';
import { conversationKey } from '../src/ecosystem/shared/identity.ts';
import { extractConversationRecords } from '../src/archive.ts';
import { hostFixture, textResponse } from './hostFixture.ts';
import { createWechatModule } from '../src/ecosystem/wechat/index.ts';
import { createWechatReading } from '../src/ecosystem/wechat/reading.ts';
import { createArchiveStore } from '../src/store.ts';
import { createWorldRuntime } from '../src/runtime.ts';

const identity = { channel: 'wechat', accountId: 'bot', conversationType: 'private' as const, conversationId: 'owner', speakerId: 'wechat:owner' };
const reference = { id: '9007199254740993', speakerId: 'wechat:bot', speakerName: '她', type: 'text' as const, text: '原来的话' };

test('new words and marked quoted text share one user archive record and the following turn works', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, request => { requests.push(request); return textResponse('看到了'); });
  const config = { root, worldId: 'quoted-memory', agentPreset: 'test', timeZone: 'UTC' };
  const store = createArchiveStore(config);
  const world = createWorldRuntime(ctx, config, store);
  await world.start(); cleanup.push(() => world.stop().finally(() => store.close()));
  const agent = (await ctx.agents.create({ sessionId: SessionId('quote'), meta: { agentPreset: 'test' }, agentOptions: { provider: 'test', model: 'test' } })).agent;
  const channel = createWechatHome({ ctx, home: async () => agent }); cleanup.push(channel.stop);
  await channel.ask('继续讨论这个问题', identity, undefined, undefined, reference);
  await channel.ask('后续普通消息', identity);
  assert.equal(requests.length, 2);
  const context = requests[0].messages.find(message => message.source?.kind === 'dsh-world-channel-context');
  assert.equal(JSON.stringify(requests[0].messages).match(/原来的话/g)?.length, 1, 'quoted words appear once in the actual request');
  assert.match(JSON.stringify(context), /9007199254740993/);
  const log = await ctx.sessionPersistence.open(agent.id, 'read');
  try {
    const { events } = await log.read(0, 128);
    const records = events.flatMap(event => extractConversationRecords(event, { worldId: 'test', header: log.header, inheritedEventCount: 0, turn: 1 }));
    const users = records.filter(record => record.role === 'user');
    assert.equal(users.length, 2);
    assert.match(users[0].content, /^继续讨论这个问题\n\n【引用/);
    assert.match(users[0].content, /wechat:bot/);
    assert.match(users[0].content, /> 原来的话/);
    assert.equal(users[1].content, '后续普通消息');
  } finally { await log.close(); }
  await world.flush();
  const later = (await ctx.agents.create({ sessionId: SessionId('quoted-memory-reload'), meta: { agentPreset: 'test' }, agentOptions: { provider: 'test', model: 'test' } })).agent;
  later.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '换个会话继续' }] }));
  await later.whenIdle();
  const memory = requests.at(-1)!.messages.find(message => message.source?.kind === 'dsh-world-history');
  assert.ok(memory);
  assert.match(JSON.stringify(memory), /原来的话/);
  assert.match(JSON.stringify(memory), /【引用/);
  assert.equal(memory.content.some(block => block.type === 'image'), false);
});

test('a private quote of her own sticker admits the image without relaxing current-sender media checks', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, request => { requests.push(request); return textResponse('看到了'); });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a15kAAAAASUVORK5CYII=', 'base64');
  const digest = createHash('sha256').update(png).digest('hex');
  const incoming = join(root, 'incoming');
  const directory = join(incoming, createHash('sha256').update(conversationKey(identity)).digest('hex'));
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, digest + '.png'), png);
  ctx.provide('attachments', { imageLimits: { maxImageBytes: 1024 }, saveImages: async (inputs: readonly SaveImageAttachment[]) => {
    assert.deepEqual(inputs[0].data, png);
    return [{ attachmentId: AttachmentId(digest), mediaType: 'image/png', bytes: png.length, width: 1, height: 1 }];
  } } as never);
  const agent = (await ctx.agents.create({ sessionId: SessionId('quoted-image'), meta: { agentPreset: 'test' }, agentOptions: { provider: 'test', model: 'test' } })).agent;
  const channel = createWechatHome({ ctx, home: async () => agent, images: (source, context, quoted) => admitContextImages(ctx, incoming, source, context, quoted) }); cleanup.push(channel.stop);
  await channel.ask('', identity, undefined, undefined, { ...reference, type: 'sticker', text: '【引用表情包】', image: { file: digest + '.png', quality: 'original', firstFrame: true } });
  assert.ok(requests[0].messages.some(message => message.content.some(block => block.type === 'image')));
  assert.match(JSON.stringify(requests[0].messages), /仅查看首帧/);
  const log = await ctx.sessionPersistence.open(agent.id, 'read');
  try {
    const { events } = await log.read(0, 128);
    const records = events.flatMap(event => extractConversationRecords(event, { worldId: 'test', header: log.header, inheritedEventCount: 0, turn: 1 }));
    const users = records.filter(record => record.role === 'user');
    assert.equal(users.length, 1, 'a quote without new words is still one real user action');
    assert.match(users[0].content, /引用表情包/);
    assert.match(users[0].content, /仅查看首帧/);
    assert.doesNotMatch(JSON.stringify(records), new RegExp(`${digest}|attachmentId|\\.png`));
  } finally { await log.close(); }
  await assert.rejects(admitContextImages(ctx, incoming, identity, [{ id: 'm.db:1', occurredAt: '2026-10-28T00:00:00Z', identity: { ...identity, speakerId: 'wechat:bot' }, text: '图片', image: { file: digest + '.png', quality: 'original' } }]));
});

test('the HTTP boundary accepts quote-only input and rejects invalid IDs, authors and image metadata', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, request => { requests.push(request); return textResponse('看到了'); });
  const agent = (await ctx.agents.create({ sessionId: SessionId('quote-api'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const file = join(root, 'wechat.json');
  const module = createWechatModule({ ctx, file, home: async () => agent, origin: () => 'http://127.0.0.1:1', allowedHosts: [] });
  module.start(); cleanup.push(() => module.stop());
  const server = createServer((req, res) => { void module.route.handler(req, res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const connection = JSON.parse(await readFile(file, 'utf8')); assert.equal(connection.references, true);
  const post = (reference: unknown) => fetch(`http://127.0.0.1:${address.port}${connection.path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-world-token': connection.token }, body: JSON.stringify({ identity, text: '', reference }) });
  for (const invalid of [null, { ...reference, id: 123 }, { ...reference, id: '18446744073709551616' }, { ...reference, speakerId: 'qq:bot' }, { ...reference, type: 'image', image: { file: '../other.png', quality: 'original' } }]) {
    const response = await post(invalid); assert.equal(response.status, 400); await response.arrayBuffer();
  }
  const response = await post(reference); assert.equal(response.status, 200); await response.arrayBuffer();
  assert.equal(requests.length, 1);
  assert.match(JSON.stringify(requests[0].messages), /原来的话/);
  const group = { ...identity, conversationType: 'group', conversationId: 'family@chatroom', speakerName: '甲'.repeat(256), conversationName: '群'.repeat(256) };
  const context = [1, 2].map(id => ({ id: `m.db:${id}`, occurredAt: '2026-10-28T00:00:00Z', identity: group, text: '🙂'.repeat(1500) }));
  const body = JSON.stringify({ identity: group, text: '🙂'.repeat(2000), reference: { ...reference, text: '🙂'.repeat(2000) }, context });
  assert.ok(Buffer.byteLength(JSON.stringify(context)) < 16 * 1024);
  assert.ok(Buffer.byteLength(body) > 32 * 1024);
  const large = await fetch(`http://127.0.0.1:${address.port}${connection.path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-world-token': connection.token }, body });
  assert.equal(large.status, 200); await large.arrayBuffer();
});

test('history preserves reference metadata and large string IDs through its existing validation', async () => {
  const group = { ...identity, conversationType: 'group' as const, conversationId: 'family@chatroom' };
  const reading = createWechatReading({ target: () => group });
  try {
    const pending = reading.tool.execute({ chatId: group.conversationId }, { signal: new AbortController().signal } as never);
    const request = reading.poll()!;
    reading.accept({ id: request.id, accountId: group.accountId, chatId: group.conversationId, messages: [{ id: 'm.db:1', occurredAt: '2026-10-28T00:00:00Z', identity: group, text: '新留言', reference }] });
    const result = JSON.parse(await pending as string);
    assert.deepEqual(result.messages[0].reference, reference);
  } finally { reading.stop(); }
});
