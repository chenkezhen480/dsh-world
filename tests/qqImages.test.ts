import assert from 'node:assert/strict';
import test from 'node:test';
import { AttachmentId, type SaveImageAttachment } from '@deepseek-ai/dsh-attachment';
import { admitQqImages } from '../src/ecosystem/qq-native/images.ts';
import { speakerIdentity } from '../src/ecosystem/shared/identity.ts';

const identity = speakerIdentity({ channel: 'qq', accountId: '1', conversationType: 'private', conversationId: '42', speakerId: 'qq:42' });
const gif = Buffer.from('GIF89a');

function storeCtx() {
  const saved: SaveImageAttachment[] = [];
  const store = {
    imageLimits: { maxImageBytes: 1024, maxImagesPerMessage: 4, maxMessageImageBytes: 4096, mediaTypes: ['image/png', 'image/gif'] },
    saveImages: async (inputs: readonly SaveImageAttachment[]) => {
      saved.push(...inputs);
      return inputs.map((_, i) => ({ attachmentId: AttachmentId(`sha256:${String(saved.length + i).padStart(64, '0')}`), mediaType: 'image/gif', bytes: gif.length, width: 1, height: 1 }));
    },
  };
  return { ctx: { get: (name: string) => name === 'attachments' ? store : undefined } as never, saved };
}

test('a shop sticker or animated image that get_image cannot resolve comes in through its own QQ link (#44)', async t => {
  const fetched: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    fetched.push(url.href);
    return new Response(gif, { headers: { 'content-type': 'image/gif' } });
  });
  const { ctx, saved } = storeCtx();
  const content = await admitQqImages(ctx, [
    { file: 'sticker.gif', url: 'https://gxh.vip.qq.com/club/item/parcel/item/ab/abc/raw300.gif', identity },
    { file: undefined, url: 'https://gxh.vip.qq.com/club/item/parcel/item/cd/cde/raw300.gif', identity },
  ], async () => { throw new Error('SnowLuma 未返回图片直链'); });

  assert.equal(saved.length, 2);
  assert.deepEqual(fetched.sort(), ['https://gxh.vip.qq.com/club/item/parcel/item/ab/abc/raw300.gif','https://gxh.vip.qq.com/club/item/parcel/item/cd/cde/raw300.gif']);
  assert.equal(content.filter(block => block.type === 'image').length, 2);
  assert.ok(!content.some(block => block.type === 'text' && block.text.includes('未能读取')));
});

test('get_image stays first, and links outside QQ hosts are never fetched', async t => {
  const fetched: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    fetched.push(url.href);
    return new Response(gif, { headers: { 'content-type': 'image/gif' } });
  });
  const { ctx, saved } = storeCtx();
  const content = await admitQqImages(ctx, [
    { file: 'a1.png', url: 'https://gxh.vip.qq.com/from-event.gif', identity },
    { file: undefined, url: 'https://qq.com.example.net/x.gif', identity },
    { file: undefined, url: 'https://evilqq.com/x.gif', identity },
    { file: undefined, url: 'https://gxh.vip.qq.com:8443/x.gif', identity },
  ], async file => `https://multimedia.nt.qq.com.cn/download?fileid=${file}`);

  assert.deepEqual(fetched, ['https://multimedia.nt.qq.com.cn/download?fileid=a1.png']);
  assert.equal(saved.length, 1);
  assert.ok(content.some(block => block.type === 'text' && block.text.includes('未能读取')));
});
