// tests/images.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { AttachmentId, type AttachmentStore, type ImageAttachmentRef, type SaveImageAttachment } from '@deepseek-ai/dsh-attachment';
import { imagePlaceholder, keptLines, placeholderImage, shortenArchivedImages, storedImage } from '../src/images.ts';
import { visibleText } from '../src/archive.ts';
import { memoryTools } from '../src/memoryTools.ts';
import { admitQqImages } from '../src/ecosystem/qq-native/images.ts';
import { speakerIdentity } from '../src/ecosystem/shared/identity.ts';
import type { MemoryService } from '../src/memory.ts';

const id = (n: number) => AttachmentId(`sha256:${String(n).padStart(64, '0')}`);
const REF: ImageAttachmentRef = { attachmentId: id(7), mediaType: 'image/jpeg', width: 180, height: 176, bytes: 10022, name: '猫.webp' };
const LINE = `[图片 sha256:${'0'.repeat(63)}7 image/jpeg 180×176 10022字节 猫.webp]`;

test('a picture in her memory is one line that names the stored object whole, and reads back to the same reference', () => {
  assert.equal(imagePlaceholder(REF), LINE);
  assert.deepEqual(placeholderImage(`前面的话 ${LINE} 后面的话`), REF);
  const { name: _name, ...bare } = REF;
  assert.deepEqual(placeholderImage(imagePlaceholder(bare)), bare);
  assert.equal(imagePlaceholder({ ...REF, name: '带[括号]\n的名字' }), LINE.replace('猫.webp', '带 括号  的名字'), 'a name cannot close the line early');
  for (const broken of ['[图片]', LINE.replace('10022字节', '字节'), LINE.replace('image/jpeg', 'text/html'), LINE.replace('180×176', '0×176'), LINE.slice(0, -1), '[图片 a b image/png 1×1 1字节]'])
    assert.equal(placeholderImage(broken), undefined, broken);
  assert.throws(() => imagePlaceholder({ ...REF, width: 0 }), /图片引用不完整/);
});

test('archived text is read with its image blocks shortened; what is stored is not what changes', () => {
  const archived = visibleText([{ type: 'text', text: '看这个' }, { type: 'image', attachment: REF }, { type: 'text', text: '好看吗' }] as never);
  assert.match(archived, /^看这个\n\{"type":"image","attachment":\{/);
  assert.equal(shortenArchivedImages(archived), `看这个\n${LINE}\n好看吗`);
  assert.equal(shortenArchivedImages(`${archived}\n${archived}`).split(LINE).length - 1, 2);
  const half = archived.slice(0, archived.indexOf('"width"'));
  assert.equal(shortenArchivedImages(half), half, 'a block cut by a page boundary stays as written');
  const odd = '{"type":"image","attachment":{"attachmentId":"x y","mediaType":"image/png","width":1,"height":1,"bytes":1}}';
  assert.equal(shortenArchivedImages(odd), odd);
});

const fakeStore = (has: (ref: ImageAttachmentRef) => boolean) => ({ readImage: async (ref: ImageAttachmentRef) => { if (!has(ref)) throw new Error('object missing'); return { ref, data: new Uint8Array(ref.bytes) }; } }) as unknown as AttachmentStore;

test('the line brings the picture back from the local store, verified; a missing one is said', async () => {
  assert.deepEqual(await storedImage(fakeStore(() => true), LINE), REF);
  await assert.rejects(storedImage(fakeStore(() => false), LINE), /这张图片在本地找不到了，或者和记下的不一样：object missing/);
  await assert.rejects(storedImage(fakeStore(() => true), '那张猫的图'), /image 要原样填记忆里那一整段/);
  await assert.rejects(storedImage(undefined, LINE), /宿主图片存储不可用/);
});

test('memory tools show her the short line, and memory_image hands the picture over in the next message', async () => {
  const archived = visibleText([{ type: 'image', attachment: REF }] as never);
  const service = {
    find: async () => ({ items: [{ ref: 'c:1', time: '2026-11-17T00:00:00Z', kind: 'conversation', current: true, excerpt: `看 ${archived}` }], coverage: { state: 'ready' } }),
    read: async () => ({ ref: 'c:1', kind: 'conversation', title: '', time: '2026-11-17T00:00:00Z', content: archived, offset: 0, totalChars: archived.length }),
    wiki: { catalog: async () => ({}), gaps: async () => undefined },
  } as unknown as MemoryService;
  let inside = true;
  const tools = memoryTools(service, () => inside, undefined, () => fakeStore(() => true));
  const run = (name: string, input: object, context: object = {}) => tools.find(tool => tool.name === name)!.execute(input as never, context as never) as Promise<string>;
  assert.equal(JSON.parse(await run('memory_find', {})).items[0].text, `看 ${LINE}`);
  assert.equal(JSON.parse(await run('memory_read', { ref: 'c:1' })).content, LINE);
  const deferred: { content: { type: string; text?: string; attachment?: unknown }[] }[] = [];
  const context = { signal: new AbortController().signal, deferContext: (message: never) => { deferred.push(message); } };
  assert.equal(await run('memory_image', { image: LINE }, context), '图片已附在下一条消息里。');
  assert.deepEqual(deferred[0]!.content, [{ type: 'text', text: '这是记忆里的那张图片。' }, { type: 'image', attachment: REF }]);
  inside = false;
  await assert.rejects(run('memory_image', { image: LINE }, context));
  assert.equal(deferred.length, 1, 'a session that left her world gets nothing');
});

test('every QQ picture sent to her is kept; the first four are shown and the rest are named for later', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(Buffer.from('GIF89a'), { headers: { 'content-type': 'image/gif' } }));
  const saved: SaveImageAttachment[] = [];
  const store = {
    imageLimits: { maxImageBytes: 1024, maxImagesPerMessage: 4, maxMessageImageBytes: 4096, mediaTypes: ['image/png', 'image/gif'] },
    saveImages: async (inputs: readonly SaveImageAttachment[]) => { saved.push(...inputs); return inputs.map(() => ({ attachmentId: id(saved.length), mediaType: 'image/gif', bytes: 6, width: 1, height: 1 })); },
  };
  const identity = speakerIdentity({ channel: 'qq', accountId: '1', conversationType: 'private', conversationId: '42', speakerId: 'qq:42' });
  const images = Array.from({ length: 14 }, (_, n) => ({ file: undefined, url: `https://gxh.vip.qq.com/${n}.gif`, identity }));
  const content = await admitQqImages({ get: (name: string) => name === 'attachments' ? store : undefined } as never, images);
  assert.equal(saved.length, 12, 'twelve of a batch are fetched');
  assert.equal(content.filter(block => block.type === 'image').length, 4);
  const texts = content.flatMap(block => block.type === 'text' ? [block.text] : []);
  const kept = texts.find(text => text.startsWith('这次还有 8 张 QQ 图片存下了，没有直接附上：'))!;
  assert.equal(kept.split('\n').filter(line => placeholderImage(line)).length, 8);
  assert.match(kept, /想看哪张，把那一整段 \[图片 …\] 交给 memory_image。$/);
  assert.ok(texts.some(text => text.includes('未能读取')), 'the two beyond twelve are said to be missing');
  assert.deepEqual(keptLines('x', []), []);
});
