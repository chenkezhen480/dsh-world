import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { createPhotoStore } from '../src/life/photos.ts';

const bytes = new Uint8Array([1, 2, 3, 4]);
const ref: ImageAttachmentRef = { attachmentId: AttachmentId('image-1'), mediaType: 'image/png', bytes: bytes.length, width: 2, height: 2, name: '当前图.png' };

test('photo store copies an explicitly kept image, round-trips metadata, deduplicates, and forgets it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-photos-'));
  try {
    const store = createPhotoStore(root, { readImage: async (input: ImageAttachmentRef) => ({ ref: input, data: bytes }) } as never, () => new Date('2026-10-28T00:00:00.000Z'));
    const saved = await store.keep(ref, '窗边', ['家', '家', ' 早晨 ']);
    assert.equal(saved.description, '窗边');
    assert.deepEqual(saved.tags, ['家', '早晨']);
    assert.equal(saved.attachmentId, 'image-1');
    assert.deepEqual(store.list(), [saved]);
    assert.deepEqual(await store.keep(ref, '另一个描述', ['另一个']), saved, 'same attachment is saved only once');
    const files = readdirSync(join(root, 'photos'));
    assert.equal(files.filter(file => file.endsWith('.png')).length, 1);
    assert.deepEqual(readFileSync(join(root, 'photos', files.find(file => file.endsWith('.png'))!)), Buffer.from(bytes));
    store.forget(saved.id);
    assert.deepEqual(store.list(), []);
    assert.equal(JSON.parse(readFileSync(join(root, 'photos', 'index.json'), 'utf8')).photos.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('photo store rejects missing attachment storage, invalid ids, and oversized reads', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-photos-invalid-'));
  try {
    const unavailable = createPhotoStore(root, undefined);
    await assert.rejects(unavailable.keep(ref), /unavailable/);
    writeFileSync(join(root, 'photos', 'index.json'), JSON.stringify({ version: 1, photos: [{ id: '../bad', savedAt: new Date().toISOString(), file: '../bad.png', attachment: ref, description: '', tags: [] }] }));
    const reopened = createPhotoStore(root, { readImage: async (input: ImageAttachmentRef) => ({ ref: input, data: new Uint8Array(21 * 1024 * 1024) }) } as never);
    assert.deepEqual(reopened.list(), [], 'unsafe persisted entries are ignored');
    await assert.rejects(reopened.keep(ref), /大小校验失败/);
    assert.throws(() => reopened.forget('missing'), /找不到/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
