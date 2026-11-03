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
 * Lines the host injects into a turn that must never reach QQ: the time sample, the browser time-zone note, the
 * elapsed-time note, and the inline source header of an incoming message. They are matched by line prefix only, so
 * a sentence of hers that merely mentions 时间 is left alone.
 */
const HOST_LINE = /^(?:\s*(?:Time sampled|Browser time zone|Elapsed since|Elapsed from)\b|\s*【消息来源\b)/;

/**
 * Fragments of transport plumbing that leak into her prose: a bare `m00123` ref, a `text">m00123` tail, and the
 * closing quote left over from a JSON blob. Removed wherever they appear; they never occur in a normal sentence.
 */
const HOST_FRAGMENT = /(?:^|\s)text">m\d{5}\b|(?:^|\s)m\d{5}\b$/g;

/**
 * Drops the host's own bookkeeping from an answer before it is sent. The paragraphs it empties are removed, so a
 * reply that was only plumbing sends nothing at all instead of a blank message.
 */
export function stripHostNoise(text: string): string {
    const kept = text
        .replace(HOST_FRAGMENT, '')
        .split(/\r?\n/)
        .filter(line => !HOST_LINE.test(line));
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
