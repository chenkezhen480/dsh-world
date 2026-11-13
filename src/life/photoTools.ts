import { readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType, StoredImageAttachment } from '@deepseek-ai/dsh-attachment';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { PhotoStore } from './photos.ts';

const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * Every image still in front of her: the images on her session's surface, newest message first and in their own order
 * inside a message, so 0 is the newest. A compacted image has left the surface, and with it this list.
 */
function visibleImages(agent: Agent): ImageAttachmentRef[] {
  const { session } = agent, nodes = session.surface.nodes, found: ImageAttachmentRef[] = [];
  for (let index = nodes.length - 1; index >= 0; index--) {
    const event = session.eventAt(nodes[index]!);
    if (!event) continue;
    let message: ReturnType<typeof session.deriveEventMessage>;
    try { message = session.deriveEventMessage(event); } catch { continue; }
    for (const block of message?.content ?? []) if (block.type === 'image') found.push(block.attachment);
  }
  return found;
}

/** Only the four image types the attachment service keeps; the bytes decide, never the file name. */
function mediaTypeOf(bytes: Uint8Array): ImageMediaType | undefined {
  const starts = (...head: number[]) => head.every((byte, at) => bytes[at] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return undefined;
}
/** A picture on her computer: committed to the host's attachment store like any channel image, then read back verified. */
async function fileImage(attachments: AttachmentStore, path: string, signal: AbortSignal): Promise<StoredImageAttachment> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`没有找到这个图片文件：${path}`);
  if (info.size > MAX_FILE_BYTES) throw new Error('图片文件最多 20MB');
  const data = new Uint8Array(await readFile(path, { signal }));
  const mediaType = mediaTypeOf(data);
  if (!mediaType) throw new Error('只能收藏 png、jpg、webp、gif 图片');
  return attachments.readImage(await attachments.saveImage({ data, mediaType, name: basename(path) }), signal);
}

export function photoTools(deps: { agent: Agent; store(): PhotoStore; attachments(): AttachmentStore | undefined; inside(): boolean }) {
  const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };
  const check = () => { if (!deps.inside()) throw new Error('相册工具只能在当前家会话的世界工作区内使用'); };
  return [
    defineTool({ name: 'keep_photo', description: '想收藏一张值得长期保留的图片时使用，由我自己决定。两种来源：不填 path 时，index 选我眼前的图片，0 是最新的一张，往前数依次加 1，聊天里收到的、引用的、工具读出来的都算；填 path 时，收藏电脑上的一个图片文件（png、jpg、webp、gif，最多 20MB，相对路径从我的房间算起）。照片保存到我的相册，不自动加入之后每轮上下文。description 最多 500 字，tags 最多 8 个、每个 40 字。', parameters: { index: { type: 'integer' }, path: { type: 'string' }, description: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, output,
      execute: async ({ index = 0, path, description = '', tags = [] }, context) => {
        check();
        const attachments = deps.attachments();
        if (!attachments) throw new Error('宿主图片存储不可用');
        let image: StoredImageAttachment;
        if (typeof path === 'string' && path.trim()) image = await fileImage(attachments, resolve(deps.agent.session.header.cwd ?? '', path.trim()), context.signal);
        else {
          const images = visibleImages(deps.agent);
          if (!images.length) throw new Error('我眼前现在没有图片；电脑上的图片可以用 path 指定文件');
          if (!Number.isSafeInteger(index) || index < 0 || index >= images.length) throw new Error(`index 超出范围：我眼前现在一共有 ${images.length} 张图片，0 是最新的一张`);
          image = await attachments.readImage(images[index]!, context.signal);
        }
        context.signal.throwIfAborted(); check();
        return JSON.stringify(deps.store().keep(image, description, tags));
      } }),
    defineTool({ name: 'list_photos', description: '分页查看我收藏的照片描述、标签、日期和尺寸，不读取图片正文。limit 默认 20、最多 100，offset 默认 0；hasMore 表示还有下一页。', parameters: { limit: { type: 'integer' }, offset: { type: 'integer' } }, output,
      execute: async ({ limit = 20, offset = 0 }) => { check(); return JSON.stringify(deps.store().list(limit, offset)); } }),
    defineTool({ name: 'forget_photo', description: '移除一张收藏及其相册内图片副本，id 必须来自 list_photos。不会删除原聊天消息或原始附件。', parameters: { id: { type: 'string', required: true } }, output,
      execute: async ({ id }) => { check(); deps.store().forget(id); return '已移出相册。'; } }),
  ];
}
