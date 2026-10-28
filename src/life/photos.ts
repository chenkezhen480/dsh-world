import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { durableWrite } from './lifeStore.ts';

const MAX_PHOTOS = 100;
const MAX_DESCRIPTION = 500;
const MAX_TAGS = 8;
const MAX_TAG = 40;
const safeId = /^[a-z0-9-]{1,100}$/i;
type PhotoRow = { id: string; savedAt: string; file: string; attachment: ImageAttachmentRef; description: string; tags: string[] };
type PhotoFile = { version: 1; photos: PhotoRow[] };
export type PhotoSummary = Omit<PhotoRow, 'file' | 'attachment'> & { attachmentId: string; mediaType: string; bytes: number; width: number; height: number; name?: string };

function empty(): PhotoFile { return { version: 1, photos: [] }; }
function validRef(value: unknown): value is ImageAttachmentRef {
  if (!value || typeof value !== 'object') return false;
  const ref = value as Partial<ImageAttachmentRef>;
  return typeof ref.attachmentId === 'string' && ref.attachmentId.length <= 200 && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ref.mediaType as string) && typeof ref.bytes === 'number' && ref.bytes >= 1 && Number.isSafeInteger(ref.bytes) && typeof ref.width === 'number' && Number.isSafeInteger(ref.width) && ref.width >= 1 && typeof ref.height === 'number' && Number.isSafeInteger(ref.height) && ref.height >= 1;
}
function validFile(value: unknown): PhotoFile {
  if (!value || typeof value !== 'object') return empty();
  const rows = Array.isArray((value as Partial<PhotoFile>).photos) ? (value as Partial<PhotoFile>).photos! : [];
  return { version: 1, photos: rows.filter((row): row is PhotoRow => Boolean(row && typeof row === 'object' && typeof row.id === 'string' && safeId.test(row.id) && typeof row.savedAt === 'string' && Number.isFinite(Date.parse(row.savedAt)) && typeof row.file === 'string' && new RegExp(`^${row.id}\\.(png|jpg|webp|gif)$`).test(row.file) && validRef(row.attachment) && typeof row.description === 'string' && row.description.length <= MAX_DESCRIPTION && Array.isArray(row.tags) && row.tags.length <= MAX_TAGS && row.tags.every(tag => typeof tag === 'string' && tag.length <= MAX_TAG))).slice(0, MAX_PHOTOS) };
}
function extension(mediaType: string): string { return mediaType === 'image/jpeg' ? 'jpg' : mediaType === 'image/webp' ? 'webp' : mediaType === 'image/gif' ? 'gif' : 'png'; }
function cleanTags(tags: readonly string[]): string[] { return [...new Set(tags.map(tag => tag.trim()).filter(Boolean).map(tag => tag.slice(0, MAX_TAG)))].slice(0, MAX_TAGS); }

export function createPhotoStore(worldDir: string, attachments: AttachmentStore | undefined, clock: () => Date = () => new Date()) {
  const directory = join(worldDir, 'photos');
  const indexFile = join(directory, 'index.json');
  mkdirSync(directory, { recursive: true });
  let state: PhotoFile;
  try { state = existsSync(indexFile) ? validFile(JSON.parse(readFileSync(indexFile, 'utf8'))) : empty(); }
  catch (error) { throw new Error('dsh-world: photos/index.json is unreadable; it was left untouched', { cause: error }); }
  const persist = () => durableWrite(indexFile, JSON.stringify(state, null, 2));
  const summary = (row: PhotoRow): PhotoSummary => ({ id: row.id, savedAt: row.savedAt, attachmentId: row.attachment.attachmentId, mediaType: row.attachment.mediaType, bytes: row.attachment.bytes, width: row.attachment.width, height: row.attachment.height, ...(row.attachment.name ? { name: row.attachment.name } : {}), description: row.description, tags: [...row.tags] });
  return {
    list: (): PhotoSummary[] => state.photos.map(summary),
    async keep(ref: ImageAttachmentRef, description = '', tags: readonly string[] = []): Promise<PhotoSummary> {
      if (!attachments) throw new Error('Host image attachment storage is unavailable');
      const existing = state.photos.find(row => row.attachment.attachmentId === ref.attachmentId);
      if (existing) return summary(existing);
      if (state.photos.length >= MAX_PHOTOS) throw new Error(`照片最多保存 ${MAX_PHOTOS} 张`);
      const stored = await attachments.readImage(ref);
      if (stored.data.byteLength !== ref.bytes || stored.data.byteLength > 20 * 1024 * 1024) throw new Error('图片大小校验失败');
      const id = `photo-${randomUUID()}`;
      const row: PhotoRow = { id, savedAt: clock().toISOString(), file: `${id}.${extension(stored.ref.mediaType)}`, attachment: stored.ref, description: description.trim().slice(0, MAX_DESCRIPTION), tags: cleanTags(tags) };
      const file = join(directory, row.file);
      try { writeFileSync(file, stored.data, { flag: 'wx' }); state.photos.unshift(row); persist(); } catch (error) { rmSync(file, { force: true }); throw error; }
      return summary(row);
    },
    forget(id: string): void {
      const index = state.photos.findIndex(row => row.id === id); if (index < 0) throw new Error('找不到这个 photo id');
      const [row] = state.photos.splice(index, 1); rmSync(join(directory, row!.file), { force: true }); persist();
    },
    path(id: string): string | undefined { const row = state.photos.find(item => item.id === id); return row ? join(directory, row.file) : undefined; },
  };
}
export type PhotoStore = ReturnType<typeof createPhotoStore>;
