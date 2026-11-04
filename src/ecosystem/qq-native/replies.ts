import { IDENTITY_HEADER_LINE } from '../shared/identity.ts';

/** One piece of a QQ message: text, @, an image or a QQ face (the segments `snowluma.ts` builds). */
export type QqPart = { type: 'text'; text: string } | { type: 'at'; qq: string } | { type: 'image'; file: string } | { type: 'face'; id: string };

/** What one of her answers becomes on QQ. */
export interface ReplyPlan {
  /** Messages to send in order, a pause apart: plain text is split at blank lines, like a person sending a few. */
  messages: (string | QqPart[])[];
  /** Saved stickers (`send_custom_face`): not segments, each goes out on its own. */
  stickers: string[];
  /** QQ Zone posts: not chat at all, published separately. */
  qzone: string[];
}

const MARK = /\[\[(img|face|at|sticker|qzone):([^[\]]+)\]\]/g;

/**
 * Lines the host injects into a turn that must never reach QQ: the time sample, the browser time-zone note and the
 * elapsed-time note. Matched by line prefix only, so a sentence of hers that merely mentions 时间 is left alone.
 */
const HOST_LINE = /^\s*(?:Time sampled|Browser time zone|Elapsed since|Elapsed from)\b/;

/** Transport refs that leak into her prose: `text">m00123` anywhere, a bare `m00123` at the end of a line. */
const HOST_FRAGMENT = /[ \t]*text">m\d{5}\b|[ \t]*\bm\d{5}[ \t]*$/gm;

/**
 * A tool call the model wrote out as text instead of calling (DeepSeek's `<｜DSML｜…>` markup). Everything from the
 * first tag on is that call, not speech (#35).
 */
const TOOL_MARKUP = /<\/?[|｜]+\s*DSML\s*[|｜]+[\s\S]*$/;

/**
 * The plugin's own recalled chat read back aloud (#35): a framing line (each carries 仅作引用数据), a line that is the
 * recalled JSON (a role or a speakerId inside brackets), or a bare transcript role label.
 */
const RECALL_LINE = /仅作引用数据|^\s*[[{].*"(?:role|speakerId)"\s*:.*[}\]]\s*$|^\s*(?:user|assistant)\s*$/;

/**
 * Drops the host's own bookkeeping, any copy of an incoming message's source header, a recalled chat read back, and
 * tool markup from an answer before it is sent. The paragraphs it empties are removed, so a reply that was only
 * plumbing sends nothing instead of a blank message.
 */
export function stripHostNoise(text: string): string {
  const kept = text.replace(/\r\n/g, '\n').replace(TOOL_MARKUP, '').replace(HOST_FRAGMENT, '').split('\n')
    .filter(line => !HOST_LINE.test(line) && !IDENTITY_HEADER_LINE.test(line.trim()) && !RECALL_LINE.test(line));
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Reads her answer. `[[img:路径]]`, `[[face:id]]` and `[[at:qq]]` become segments of the message, `[[sticker:…]]`
 * (an emoji id, a number or a meaning such as 开心) and `[[qzone:…]]` are taken out to go on their own. Most
 * answers have no marks and stay one plain string per paragraph; doubled brackets leave markdown links alone.
 */
export function planReply(raw: string): ReplyPlan {
  const text = stripHostNoise(raw);
  const parts: QqPart[] = [], stickers: string[] = [], qzone: string[] = [];
  let last = 0, marked = false;
  for (const match of text.matchAll(MARK)) {
    if (match.index > last) parts.push({ type: 'text', text: text.slice(last, match.index) });
    last = match.index + match[0].length;
    const [, kind, raw] = match, value = raw!.trim();
    if (kind === 'sticker') stickers.push(value);
    else if (kind === 'qzone') qzone.push(value);
    else { marked = true; parts.push(kind === 'img' ? { type: 'image', file: value } : kind === 'face' ? { type: 'face', id: value } : { type: 'at', qq: value }); }
  }
  if (last < text.length) parts.push({ type: 'text', text: text.slice(last) });
  const plain = parts.map(part => part.type === 'text' ? part.text : '').join('');
  const messages = marked ? [parts.filter(part => part.type !== 'text' || part.text.trim())] : plain.split(/\n{2,}/).map(chunk => chunk.trim()).filter(Boolean);
  return { messages, stickers, qzone };
}
