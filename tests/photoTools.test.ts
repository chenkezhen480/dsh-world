import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { AttachmentId } from '@deepseek-ai/dsh-attachment';
import { createPhotoStore } from '../src/life/photos.ts';
import { photoTools } from '../src/life/photoTools.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ref = (id: string) => ({ attachmentId: AttachmentId(id), mediaType: 'image/png' as const, bytes: 4, width: 2, height: 2 });
const image = (id: string) => ({ type: 'image', attachment: ref(id) });

/** A session as the host shapes it: events by seq, the surface she can see, and the message each surface event carries. */
function setup(t: { after(fn: () => unknown): void }) {
  const root = mkdtempSync(join(tmpdir(), 'photo-tools-')); const store = createPhotoStore(root); const room = join(root, 'room'); mkdirSync(room);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const events: { type: string; content: unknown[] }[] = [];
  const surface: number[] = [];
  const say = (type: string, ...content: unknown[]) => { events.push({ type, content }); surface.push(events.length - 1); };
  const agent = { session: { header: { cwd: room }, surface: { get nodes() { return surface; } }, eventAt: (seq: number) => events[seq], deriveEventMessage: (event: { content: unknown[] }) => ({ content: event.content }) } } as unknown as Agent;
  let inside = true, leaveOnRead = false; const read: string[] = []; const saved: { name?: string; mediaType: string }[] = [];
  const attachments = {
    readImage: async (r: { attachmentId: string }) => { read.push(r.attachmentId); if (leaveOnRead) inside = false; return { ref: ref(r.attachmentId), data: new Uint8Array([1, 2, 3, 4]) }; },
    saveImage: async (input: { name?: string; mediaType: string }) => { saved.push(input); return ref('from-file'); },
  };
  const tools = photoTools({ agent, store: () => store, inside: () => inside, attachments: () => attachments as never });
  const run = (name: string, args: object = {}) => tools.find(tool => tool.name === name)!.execute(args as never, { signal: new AbortController().signal } as never);
  return { store, room, surface, say, run, read, saved, leave: () => { leaveOnRead = true; }, stay: () => { inside = true; leaveOnRead = false; } };
}

test('any image still in front of her can be kept: 0 is the newest, older ones by counting back, whatever message carried it', async t => {
  const s = setup(t);
  await assert.rejects(s.run('keep_photo'), /眼前现在没有图片/);
  s.say('user/message', image('old-chat'));
  s.say('tool/result', { type: 'text', text: '群图片' }, image('group-1'), image('group-2'));
  s.say('user/message', { type: 'text', text: '看这张' }, image('newest'));
  await s.run('keep_photo', { description: '最新的' });
  await s.run('keep_photo', { index: 1 }); await s.run('keep_photo', { index: 2 }); await s.run('keep_photo', { index: 3 });
  assert.deepEqual(s.read, ['newest', 'group-1', 'group-2', 'old-chat']);
  assert.equal(s.store.list().total, 4);
  await assert.rejects(s.run('keep_photo', { index: 4 }), /一共有 4 张图片，0 是最新的一张/);
  s.surface.splice(0, 1);
  await assert.rejects(s.run('keep_photo', { index: 3 }), /一共有 3 张图片/, 'an image compacted off her surface is no longer hers to pick');
});

test('a picture file on her computer can be kept by path, relative to her room; only real image bytes are taken', async t => {
  const s = setup(t);
  writeFileSync(join(s.room, '截图.png'), PNG);
  writeFileSync(join(s.room, 'notes.png'), '这其实是文字');
  const kept = JSON.parse(await s.run('keep_photo', { path: '截图.png', description: '房间里的截图', tags: ['截图'] }) as string);
  assert.equal(kept.description, '房间里的截图');
  assert.deepEqual(s.saved.map(input => [input.name, input.mediaType]), [['截图.png', 'image/png']]);
  assert.equal(s.store.list().total, 1);
  await assert.rejects(s.run('keep_photo', { path: 'notes.png' }), /只能收藏 png、jpg、webp、gif/);
  await assert.rejects(s.run('keep_photo', { path: 'missing.png' }), /没有找到这个图片文件/);
  assert.equal(s.store.list().total, 1);
});

test('the album is hers only inside her world, checked again after a slow read; list and forget still work', async t => {
  const s = setup(t);
  s.say('user/message', image('one'));
  const saved = JSON.parse(await s.run('keep_photo') as string);
  assert.doesNotMatch(await s.run('list_photos') as string, /base64|"data"/);
  await s.run('forget_photo', { id: saved.id }); assert.equal(s.store.list().total, 0);
  s.leave();
  await assert.rejects(s.run('keep_photo'), /世界工作区/); assert.equal(s.store.list().total, 0);
  s.stay();
});
