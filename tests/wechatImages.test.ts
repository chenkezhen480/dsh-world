import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { AttachmentId, type SaveImageAttachment } from '@deepseek-ai/dsh-attachment';
import { SessionId } from '@deepseek-ai/dsh-session';
import { admitContextImages } from '../src/ecosystem/wechat/images.ts';
import { createWechatHome } from '../src/ecosystem/wechat/home.ts';
import { createWechatModule } from '../src/ecosystem/wechat/index.ts';
import { channelContext } from '../src/ecosystem/shared/context.ts';
import { conversationKey } from '../src/ecosystem/shared/identity.ts';
import { extractConversationRecords } from '../src/archive.ts';
import { createPhotoStore } from '../src/life/photos.ts';
import { photoTools } from '../src/life/photoTools.ts';
import { hostFixture, textResponse } from './hostFixture.ts';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';

const identity = { channel: 'wechat', accountId: 'bot', conversationType: 'group' as const, conversationId: 'group@chatroom', speakerId: 'wechat:owner' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a15kAAAAASUVORK5CYII=', 'base64');
const digest = createHash('sha256').update(png).digest('hex');
const image = { file: digest + '.png', quality: 'cached' as const };
const previous = { id: 'm.db:4', occurredAt: '2026-10-25T00:00:00Z', identity, text: '【图片】', image };

test('group images are committed before their session event and never become shared memory records', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, request => { requests.push(request); return textResponse('看到了'); });
  const incoming = join(root, 'incoming');
  const directory = join(incoming, createHash('sha256').update(conversationKey(identity)).digest('hex'));
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, image.file), png);
  const saved = join(root, 'saved.png');
  ctx.provide('attachments', {
    imageLimits: { maxImageBytes: 1024 },
    saveImages: async (inputs: readonly SaveImageAttachment[]) => {
      assert.equal(inputs.length, 1); assert.deepEqual(inputs[0].data, png);
      await writeFile(saved, inputs[0].data);
      return [{ attachmentId: AttachmentId(digest), mediaType: 'image/png', bytes: png.length, width: 1, height: 1 }];
    },
  } as never);
  const agent = (await ctx.agents.create({ sessionId: SessionId('group'), meta: { agentPreset: 'test' }, agentOptions: { provider: 'test', model: 'test' } })).agent;
  const channel = createWechatHome({ ctx, home: async () => agent, images: (source, context) => admitContextImages(ctx, incoming, source, context) }); cleanup.push(channel.stop);
  await channel.ask('这是什么图片', identity, [previous]);
  assert.deepEqual(await readFile(saved), png);
  const context = requests[0].messages.find(message => message.source?.kind === 'dsh-world-channel-context')!;
  assert.ok(context.content.some(block => block.type === 'image' && block.attachment.attachmentId === digest));
  const log = await ctx.sessionPersistence.open(agent.id, 'read');
  try {
    const { events } = await log.read(0, 128);
    const pictureEvent = events.find(event => event.type === 'user/message' && event.data.source.kind === 'dsh-world-channel-context')!;
    assert.match(JSON.stringify(pictureEvent), new RegExp(digest));
    assert.deepEqual(extractConversationRecords(pictureEvent, { worldId: 'test', header: log.header, inheritedEventCount: 0, turn: 1 }), []);
    const actualUser = events.find(event => event.type === 'user/message' && event.data.source.kind === 'user')!;
    assert.doesNotMatch(JSON.stringify(actualUser), new RegExp(digest));
  } finally { await log.close(); }
});

test('image admission refuses traversal, another group and changed bytes before committing attachments', async t => {
  const { ctx, root } = await hostFixture(t, () => textResponse('unused'));
  let saves = 0;
  ctx.provide('attachments', { imageLimits: { maxImageBytes: 1024 }, saveImages: async () => { saves++; return []; } } as never);
  assert.throws(() => channelContext([{ ...previous, image: { ...image, file: '../private.png' } }], identity));
  const directory = join(root, createHash('sha256').update(conversationKey(identity)).digest('hex'));
  await mkdir(directory); await writeFile(join(directory, image.file), Buffer.from('different bytes'));
  await assert.rejects(admitContextImages(ctx, root, identity, [previous]), /digest/);
  await assert.rejects(admitContextImages(ctx, root, { ...identity, conversationId: 'other@chatroom' }, [previous]));
  assert.equal(saves, 0);
});

for (const caption of ['', '这张图里有什么']) test(`private images reach the model and only real caption text is archived: ${caption || 'image only'}`, async t => {
  const requests: GenerateOptions[] = [];
  let savePhoto: (() => Promise<unknown>) | undefined;
  const { ctx, root, cleanup } = await hostFixture(t, request => { requests.push(request); return (async function* () {
    if (requests.length === 1) await savePhoto!();
    else await assert.rejects(savePhoto!(), /最新用户消息/);
    yield* textResponse('看到了');
  })(); });
  const privateIdentity = { ...identity, conversationType: 'private' as const, conversationId: 'owner' };
  const media = [{ ...previous, identity: privateIdentity }];
  const incoming = join(root, 'incoming');
  const directory = join(incoming, createHash('sha256').update(conversationKey(privateIdentity)).digest('hex'));
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, image.file), png);
  let saved = false;
  ctx.provide('attachments', {
    imageLimits: { maxImageBytes: 1024 },
    saveImages: async (inputs: readonly SaveImageAttachment[]) => {
      assert.deepEqual(inputs[0].data, png); saved = true;
      return [{ attachmentId: AttachmentId(digest), mediaType: 'image/png', bytes: png.length, width: 1, height: 1 }];
    },
    readImage: async () => ({ ref: { attachmentId: AttachmentId(digest), mediaType: 'image/png', bytes: png.length, width: 1, height: 1 }, data: png }),
  } as never);
  const agent = (await ctx.agents.create({ sessionId: SessionId('private'), meta: { agentPreset: 'test' }, agentOptions: { provider: 'test', model: 'test' } })).agent;
  const album = createPhotoStore(root); cleanup.push(() => album.close());
  const collect = photoTools({ agent, store: () => album, attachments: () => ctx.get('attachments'), inside: () => true }).find(tool => tool.name === 'keep_photo')!;
  savePhoto = () => collect.execute({}, { signal: new AbortController().signal } as never);
  const channel = createWechatHome({ ctx, home: async () => agent, images: (source, context) => admitContextImages(ctx, incoming, source, context) }); cleanup.push(channel.stop);
  await channel.ask(caption, privateIdentity, undefined, media);
  assert.equal(saved, true, 'the image must be saved before the model request');
  assert.equal(album.list().total, 1, 'the current WeChat image can be explicitly collected during this turn');
  assert.ok(requests[0].messages.some(message => message.content.some(block => block.type === 'image')));
  const log = await ctx.sessionPersistence.open(agent.id, 'read');
  try {
    const { events } = await log.read(0, 128);
    assert.ok(events.some(event => event.type === 'user/message' && JSON.stringify(event).includes(digest)));
    const records = events.flatMap(event => extractConversationRecords(event, { worldId: 'test', header: log.header, inheritedEventCount: 0, turn: 1 }));
    assert.deepEqual(records.filter(record => record.role === 'user').map(record => record.content), caption ? [caption] : []);
    assert.doesNotMatch(JSON.stringify(records), new RegExp(digest));
  } finally { await log.close(); }
  await assert.rejects(admitContextImages(ctx, incoming, privateIdentity, [{ ...media[0], identity: { ...privateIdentity, speakerId: 'wechat:other' } }]));
  if (!caption) {
    await channel.ask('刚才这张图再说明一下', privateIdentity);
    assert.ok(requests.at(-1)!.messages.some(message => message.content.some(block => block.type === 'image')), 'a later caption keeps the already admitted image context');
  }
});

test('the current protocol accepts an image-only private request and rejects another conversation or sender', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, root, cleanup } = await hostFixture(t, request => { requests.push(request); return textResponse('看到了'); });
  const privateIdentity = { ...identity, conversationType: 'private' as const, conversationId: 'owner' };
  const incoming = join(root, 'incoming');
  const directory = join(incoming, createHash('sha256').update(conversationKey(privateIdentity)).digest('hex'));
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, image.file), png);
  ctx.provide('attachments', { imageLimits: { maxImageBytes: 1024 }, saveImages: async () => [{ attachmentId: AttachmentId(digest), mediaType: 'image/png', bytes: png.length, width: 1, height: 1 }] } as never);
  const agent = (await ctx.agents.create({ sessionId: SessionId('private-api'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const file = join(root, 'wechat.json');
  const module = createWechatModule({ ctx, file, home: async () => agent, origin: () => 'http://127.0.0.1:1', allowedHosts: [], incomingDir: incoming });
  module.start(); cleanup.push(() => module.stop());
  const server = createServer((req, res) => { void module.route.handler(req, res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const { token, path, protocol } = JSON.parse(await readFile(file, 'utf8')); assert.equal(protocol, 4);
  const post = (media: unknown, text = '') => fetch(`http://127.0.0.1:${address.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-world-token': token }, body: JSON.stringify({ identity: privateIdentity, text, media }) });
  assert.equal((await post([])).status, 400);
  assert.equal((await post([{ ...previous, identity }])).status, 400);
  assert.equal((await post([{ ...previous, identity: { ...privateIdentity, speakerId: 'wechat:other' } }])).status, 400);
  const response = await post([{ ...previous, identity: privateIdentity }]);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).text, '看到了');
  assert.equal(requests.length, 1);
  assert.ok(requests[0].messages.some(message => message.content.some(block => block.type === 'image')));
});
