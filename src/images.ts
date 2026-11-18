import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment';
import { createUserMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm';

/**
 * Pictures in her world. The bytes live once, in the host's attachment store: content-addressed, immutable, never
 * deleted. What her memory carries of a picture is one line that names that stored object completely, so the line is
 * both what she reads and what brings the picture back; nothing else is indexed or kept.
 */
const MEDIA_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
/** The store's ids are opaque; today they are `sha256:<hex>`. Anything that could break out of the line is refused. */
const ID = /^[A-Za-z0-9:_.-]{8,200}$/;
/** How the archive has always written an image block (`visibleText`); read back, never rewritten. */
const ARCHIVED = /\{"type":"image","attachment":(\{[^{}]*\})\}/g;
const PLACEHOLDER = /\[图片 ([A-Za-z0-9:_.-]{8,200}) (image\/[a-z]+) (\d{1,6})×(\d{1,6}) (\d{1,10})字节(?: ([^[\]\n]{1,120}))?\]/;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

function checkedRef(value: unknown): ImageAttachmentRef | undefined {
  const ref = value as Partial<ImageAttachmentRef> | null;
  if (!ref || typeof ref.attachmentId !== 'string' || !ID.test(ref.attachmentId) || !MEDIA_TYPES.includes(ref.mediaType as ImageMediaType)
    || !count(ref.width) || !count(ref.height) || !count(ref.bytes)) return undefined;
  const name = typeof ref.name === 'string' ? ref.name.replace(/[[\]\r\n]/g, ' ').trim().slice(0, 120) : '';
  return { attachmentId: ref.attachmentId, mediaType: ref.mediaType!, width: ref.width, height: ref.height, bytes: ref.bytes, ...(name ? { name } : {}) };
}

/** The one line a picture is in her memory: everything the store needs to hand the same picture back. */
export function imagePlaceholder(ref: ImageAttachmentRef): string {
  const checked = checkedRef(ref);
  if (!checked) throw new Error('图片引用不完整');
  return `[图片 ${checked.attachmentId} ${checked.mediaType} ${checked.width}×${checked.height} ${checked.bytes}字节${checked.name ? ` ${checked.name}` : ''}]`;
}
/** The stored picture a placeholder names, or undefined when the text is not one copied whole. */
export function placeholderImage(text: string): ImageAttachmentRef | undefined {
  const found = PLACEHOLDER.exec(text);
  return found ? checkedRef({ attachmentId: found[1], mediaType: found[2], width: Number(found[3]), height: Number(found[4]), bytes: Number(found[5]), ...(found[6] ? { name: found[6] } : {}) }) : undefined;
}
/** Archived text for her to read: each image block becomes its placeholder; anything that is not a whole one stays as written. */
export function shortenArchivedImages(content: string): string {
  return content.replace(ARCHIVED, (whole, attachment: string) => {
    let ref: ImageAttachmentRef | undefined;
    try { ref = checkedRef(JSON.parse(attachment)); } catch { return whole; }
    return ref ? imagePlaceholder(ref) : whole;
  });
}

/** A picture handed to her in the next message, as tool results carry text only. */

/** The stored picture a placeholder names, read back and verified; a picture the store no longer has is said, not shown wrong. */
export async function storedImage(store: AttachmentStore | undefined, placeholder: string, signal?: AbortSignal): Promise<ImageAttachmentRef> {
  const ref = placeholderImage(placeholder);
  if (!ref) throw new Error('image 要原样填记忆里那一整段 [图片 sha256:… ]，从 [ 到 ]');
  if (!store) throw new Error('宿主图片存储不可用');
  try { return (await store.readImage(ref, signal)).ref; }
  catch (error) { signal?.throwIfAborted(); throw new Error(`这张图片在本地找不到了，或者和记下的不一样：${error instanceof Error ? error.message : String(error)}`); }
}

/** Pictures kept but not put in front of her: one line each, to open with memory_image when she wants to. */
export function keptLines(lead: string, refs: readonly ImageAttachmentRef[]): ContentBlock[] {
  return refs.length ? [{ type: 'text', text: `${lead}\n${refs.map(imagePlaceholder).join('\n')}\n想看哪张，把那一整段 [图片 …] 交给 memory_image。` }] : [];
}

/** The four types the store keeps, told from the bytes themselves: never from a file name or what a server claims. */
export function sniffMediaType(bytes: Uint8Array): ImageMediaType | undefined {
  const starts = (...head: number[]) => head.every((byte, at) => bytes[at] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return undefined;
}

/** A picture as it comes in, from any channel, her screen or a file; its type is read from the bytes when not given. */
export interface IncomingImage { data: Uint8Array; mediaType?: ImageMediaType; name?: string }
/**
 * The one way a picture enters her world: into the host's store, all of the batch or none of it, in order. Without a
 * store, or with bytes that are no picture, it throws; a caller that goes on without the picture says so itself.
 */
export async function keepImages(store: AttachmentStore | undefined, images: readonly IncomingImage[]): Promise<readonly ImageAttachmentRef[]> {
  if (!store) throw new Error('宿主图片存储不可用');
  const inputs = images.map(({ data, mediaType, name }) => {
    const type = mediaType ?? sniffMediaType(data);
    if (!type) throw new Error('只认 png、jpg、webp、gif 图片');
    return { data, mediaType: type, ...(name ? { name } : {}) };
  });
  const refs = await store.saveImages(inputs);
  if (refs.length !== inputs.length) throw new Error('图片没能存下来');
  return refs;
}
/** A kept picture put in front of her, with the words that say where it is from. */
export const shownImage = (caption: string, attachment: ImageAttachmentRef): ContentBlock[] => [{ type: 'text', text: caption }, { type: 'image', attachment }];
/** Pictures and their words handed to her in the next message, as tool results carry text only. */
export const imagesMessage = (content: ContentBlock[]): UserMessage => createUserMessage({ source: { kind: 'dsh-world-channel-context', form: 'recall' }, content });
