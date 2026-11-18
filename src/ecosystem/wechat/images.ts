import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { AttachmentStore, SaveImageAttachment } from '@deepseek-ai/dsh-attachment';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { keepImages, shownImage } from '../../images.ts';
import { channelContext, channelMedia, channelReference, type ChannelContextMessage, type ChannelImage, type ChannelReference } from '../shared/context.ts';
import { conversationKey, type SpeakerIdentity } from '../shared/identity.ts';

export async function admitContextImages(ctx: Context, incomingDir: string, identity: SpeakerIdentity, context: ChannelContextMessage[], suppliedReference?: ChannelReference): Promise<ContentBlock[]> {
  const messages = identity.conversationType === 'private' ? channelMedia(context, identity) : channelContext(context, identity);
  const images: { image: ChannelImage; source: Record<string, unknown> }[] = messages.filter(message => message.image).map(message => ({ image: message.image!, source: { id: message.id, identity: message.identity, occurredAt: message.occurredAt } }));
  const reference = channelReference(suppliedReference, identity);
  const references = [...messages.flatMap(message => message.reference ? [message.reference] : []), ...(reference ? [reference] : [])];
  for (const quoted of references) if (quoted.image) images.push({ image: quoted.image, source: { quoted: true, id: quoted.id, speakerId: quoted.speakerId, speakerName: quoted.speakerName, type: quoted.type } });
  if (!images.length) return [];
  const attachments = ctx.get('attachments') as AttachmentStore | undefined;
  if (!attachments) throw new Error('Host image attachment storage is unavailable');
  const root = await realpath(incomingDir);
  const key = createHash('sha256').update(conversationKey(identity)).digest('hex');
  const directory = await realpath(join(root, key));
  if (relative(root, directory) !== key) throw new Error('Image directory escapes its conversation');
  const inputs: SaveImageAttachment[] = [];
  for (const [index, message] of images.entries()) {
    const file = message.image.file;
    const path = await realpath(join(directory, file));
    if (relative(directory, path) !== file) throw new Error('Image file escapes its conversation');
    const handle = await open(path, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > attachments.imageLimits.maxImageBytes) throw new Error('Image exceeds attachment limits');
      const data = await handle.readFile();
      if (createHash('sha256').update(data).digest('hex') + '.png' !== file) throw new Error('Image digest changed');
      inputs.push({ data, mediaType: 'image/png', name: `微信图片-${index + 1}-${message.image.quality}.png` });
    } finally { await handle.close(); }
  }
  const refs = await keepImages(attachments, inputs);
  return refs.flatMap((attachment, index) => shownImage(`下面这张微信图片的来源：${JSON.stringify({ ...images[index].source, quality: images[index].image.quality })}。thumbnail 为缩略图，cached 为微信本机缓存版本，original 为原图档。${images[index].image.firstFrame ? '动图仅查看首帧，尚未查看完整动画。' : ''}`, attachment));
}
