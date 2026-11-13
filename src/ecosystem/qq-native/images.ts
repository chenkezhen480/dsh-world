import type { Context } from '@deepseek-ai/cordis';
import type { AttachmentStore, ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SpeakerIdentity } from '../shared/identity.ts';

export const MAX_BATCH_IMAGES = 4;
const DOWNLOAD_TIMEOUT_MS = 10_000;
const QQ_IMAGE_ORIGIN = 'https://multimedia.nt.qq.com.cn';

export interface QqImage {
  file: unknown;
  identity: SpeakerIdentity;
}

async function downloadImage(link: string, limits: ImageAttachmentLimits) {
  // shortcut: only the verified SnowLuma CDN is supported, add hosts when their gateway responses are verified.
  const url = new URL(link);
  if (url.protocol !== 'https:' || url.origin !== QQ_IMAGE_ORIGIN || url.username || url.password) throw new Error('QQ 图片链接不受支持');
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

export async function admitQqImages(ctx: Context, images: readonly QqImage[], getImage?: (file: string) => Promise<string>): Promise<ContentBlock[]> {
  if (!images.length) return [];
  const unavailable: ContentBlock = { type: 'text', text: '本次有 QQ 图片未能读取，请勿假装看过。' };
  const store = ctx.get('attachments') as AttachmentStore | undefined;
  if (!store || !getImage) return [unavailable];

  const limits = store.imageLimits;
  const selected = images.slice(0, Math.min(MAX_BATCH_IMAGES, limits.maxImagesPerMessage));
  const downloads = await Promise.allSettled(selected.map(async ({ file }) => {
    if (typeof file !== 'string' || !/^[a-z0-9_-][a-z0-9_.-]{0,255}$/i.test(file)) throw new Error('QQ 图片标识无效');
    return downloadImage(await getImage(file), limits);
  }));
  const content: ContentBlock[] = [];
  let remainingBytes = limits.maxMessageImageBytes;
  let saved = 0;
  for (const [index, result] of downloads.entries()) {
    if (result.status === 'rejected' || result.value.data.byteLength > remainingBytes) continue;
    try {
      const [attachment] = await store.saveImages([result.value]);
      if (!attachment) continue;
      const { platformMessageId, speakerId, speakerName } = selected[index]!.identity;
      content.push(
        { type: 'text', text: `下面是本次收到的第 ${index + 1} 张 QQ 图片，来源：${JSON.stringify({ messageId: platformMessageId, speakerId, speakerName })}。` },
        { type: 'image', attachment },
      );
      remainingBytes -= result.value.data.byteLength;
      saved++;
    } catch { /* 一张无法保存时仍交付同批的其他图片和文字。 */ }
  }
  if (saved < images.length) content.push(unavailable);
  return content;
}
