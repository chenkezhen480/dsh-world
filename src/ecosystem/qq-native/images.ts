import type { Context } from '@deepseek-ai/cordis';
import type { AttachmentStore, ImageAttachmentLimits, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { keepImages, keptLines, shownImage } from '../../images.ts';
import type { SpeakerIdentity } from '../shared/identity.ts';

/** Pictures of one batch put in front of her at once. */
export const MAX_BATCH_IMAGES = 4;
/** Pictures of one batch that are fetched and kept: QQ's links expire, so one not fetched on arrival is gone. */
export const MAX_KEPT_IMAGES = 12;
const DOWNLOAD_TIMEOUT_MS = 10_000;
// QQ's own image hosts: the CDN behind get_image (multimedia.nt.qq.com.cn) and the sticker shop (gxh.vip.qq.com) (#44).
const QQ_IMAGE_DOMAINS = ['qq.com', 'qq.com.cn'];

/** One image segment as QQ sent it: the id get_image takes, and the link some images (shop stickers, animated ones) carry instead. */
export interface QqImageSegment { file: unknown; url: unknown }
export interface QqImage extends QqImageSegment { identity: SpeakerIdentity }

const onQqHost = (url: URL) => QQ_IMAGE_DOMAINS.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`));

async function downloadImage(link: string, limits: ImageAttachmentLimits) {
  const url = new URL(link);
  if (url.protocol !== 'https:' || url.port || !onQqHost(url) || url.username || url.password) throw new Error('QQ 图片链接不受支持');
  const controller = new AbortController();
  try {
    const response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]),
    });
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    const mediaType = limits.mediaTypes.find(type => type === contentType);
    if (!response.ok || !response.body || !mediaType) throw new Error('QQ 图片响应无效');
    if (Number(response.headers.get('content-length')) > limits.maxImageBytes) throw new Error('QQ 图片超过大小限制');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > limits.maxImageBytes) throw new Error('QQ 图片超过大小限制');
      chunks.push(chunk);
    }
    return { data: Buffer.concat(chunks, bytes), mediaType };
  } finally { controller.abort(); }
}

// get_image first, as verified for ordinary pictures; the segment's own link when get_image has no usable answer.
async function fetchQqImage({ file, url }: QqImageSegment, limits: ImageAttachmentLimits, getImage?: (file: string) => Promise<string>) {
  const viaFile = typeof file === 'string' && /^[a-z0-9_-][a-z0-9_.-]{0,255}$/i.test(file) && getImage
    ? getImage(file).then(link => downloadImage(link, limits)) : Promise.reject(new Error('QQ 图片标识无效'));
  return viaFile.catch(error => {
    if (typeof url !== 'string' || !url) throw error;
    return downloadImage(url, limits);
  });
}

export async function admitQqImages(ctx: Context, images: readonly QqImage[], getImage?: (file: string) => Promise<string>): Promise<ContentBlock[]> {
  if (!images.length) return [];
  const unavailable: ContentBlock = { type: 'text', text: '本次有 QQ 图片未能读取，请勿假装看过。' };
  const store = ctx.get('attachments') as AttachmentStore | undefined;
  if (!store) return [unavailable];

  const limits = store.imageLimits;
  const selected = images.slice(0, MAX_KEPT_IMAGES), shownMax = Math.min(MAX_BATCH_IMAGES, limits.maxImagesPerMessage);
  const downloads = await Promise.allSettled(selected.map(image => fetchQqImage(image, limits, getImage)));
  const content: ContentBlock[] = [];
  const kept: ImageAttachmentRef[] = [];
  let remainingBytes = limits.maxMessageImageBytes;
  let saved = 0, shown = 0;
  for (const [index, result] of downloads.entries()) {
    if (result.status === 'rejected') continue;
    try {
      const [attachment] = await keepImages(store, [result.value]);
      if (!attachment) continue;
      saved++;
      // Every picture sent to her is kept; only as many as one message may carry are put in front of her now.
      if (shown >= shownMax || result.value.data.byteLength > remainingBytes) { kept.push(attachment); continue; }
      const { platformMessageId, speakerId, speakerName } = selected[index]!.identity;
      content.push(...shownImage(`下面是本次收到的第 ${index + 1} 张 QQ 图片，来源：${JSON.stringify({ messageId: platformMessageId, speakerId, speakerName })}。`, attachment));
      remainingBytes -= result.value.data.byteLength;
      shown++;
    } catch { /* 一张无法保存时仍交付同批的其他图片和文字。 */ }
  }
  content.push(...keptLines(`这次还有 ${kept.length} 张 QQ 图片存下了，没有直接附上：`, kept));
  if (saved < images.length) content.push(unavailable);
  return content;
}
