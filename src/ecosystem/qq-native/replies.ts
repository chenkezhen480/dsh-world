import { IDENTITY_HEADER_LINE } from '../shared/identity.ts';

/** One piece of a QQ message: text, @, an image, a QQ face, a voice clip or a video (the segments `snowluma.ts` builds). A `file` part is not a segment: it is uploaded on its own. */
export type QqPart = { type: 'text'; text: string } | { type: 'at'; qq: string } | { type: 'image'; file: string } | { type: 'face'; id: string } | { type: 'record'; file: string } | { type: 'video'; file: string } | { type: 'file'; path: string };

/** What one of her answers becomes on QQ. */
export interface ReplyPlan {
  /** Messages to send in order, a pause apart: plain text is split at blank lines, like a person sending a few. */
  messages: (string | QqPart[])[];
  /** Saved stickers (`send_custom_face`): not segments, each goes out on its own. */
  stickers: string[];
  /** QQ Zone posts: not chat at all, published separately. */
  qzone: string[];
}

const MARK = /\[\[(img|face|at|sticker|qzone|voice|video|file):([^[\]]+)\]\]/g;

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
 * The plugin's own recalled chat read back aloud (#35): a framing line (each carries 仅作引用数据) or a line that is
 * the recalled JSON (a role or a speakerId inside brackets).
 */
const RECALL_LINE = /仅作引用数据|^\s*[[{].*"(?:role|speakerId)"\s*:.*[}\]]\s*$/;

/**
 * A bare transcript role label. Stripped only when it stands inside a block of recall lines: standing alone, `user` or
 * `assistant` may be something she actually wrote, and dropping a line she meant to say is worse than letting a stray
 * label through (#35 的边界).
 */
const ROLE_LABEL = /^\s*(?:user|assistant)\s*$/;

/**
 * Drops the host's own bookkeeping, any copy of an incoming message's source header, a recalled chat read back, and
 * tool markup from an answer before it is sent. The paragraphs it empties are removed, so a reply that was only
 * plumbing sends nothing instead of a blank message.
 */
export function stripHostNoise(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').replace(TOOL_MARKUP, '').replace(HOST_FRAGMENT, '').split('\n');
  const effects = lines.map(line => RECALL_LINE.test(line));
  // 复述出来的那份记录带着来源头（【消息来源 {…}】），它跟记录是一块儿的，算进同一段。
  const recall = lines.map((line, index) => effects[index] || IDENTITY_HEADER_LINE.test(line.trim()));
  const nearRecall = (index: number): boolean => {
    for (let back = index - 1; back >= 0; back--) {
      if (!lines[back]!.trim()) break;
      if (recall[back]) return true;
    }
    for (let ahead = index + 1; ahead < lines.length; ahead++) {
      if (!lines[ahead]!.trim()) break;
      if (recall[ahead]) return true;
    }
    return false;
  };
  const kept = lines.filter((line, index) => {
    if (HOST_LINE.test(line) || IDENTITY_HEADER_LINE.test(line.trim()) || recall[index]) return false;
    // 孤零零一行 user / assistant 可能是她自己写的，只有紧挨着复述记录时才当成记录里的角色标签。
    return !ROLE_LABEL.test(line) || !nearRecall(index);
  });
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 读她的回答。`[[img:路径]]`、`[[face:id]]`、`[[at:qq]]`、`[[voice:路径]]`、`[[video:路径]]`、`[[file:路径]]`
 * 成为这条消息的段，`[[sticker:…]]`（收藏表情的 emoji_id、序号或一个意思如「开心」）与 `[[qzone:…]]`
 * 单独发。多数回答没有标记，按空行切成几条纯文本；双中括号不会误伤 markdown 链接。
 */
export function planReply(raw: string): ReplyPlan {
  const text = stripHostNoise(raw);
  const parts: QqPart[] = [], stickers: string[] = [], qzone: string[] = [];
  let last = 0, marked = false;
  for (const match of text.matchAll(MARK)) {
    if (match.index > last) parts.push({ type: 'text', text: text.slice(last, match.index) });
    last = match.index + match[0].length;
    const [, kind, raw = ''] = match, value = raw.trim();
    if (kind === 'sticker') stickers.push(value);
    else if (kind === 'qzone') qzone.push(value);
    else {
      marked = true;
      parts.push(kind === 'img' ? { type: 'image', file: value }
        : kind === 'face' ? { type: 'face', id: value }
          : kind === 'voice' ? { type: 'record', file: value }
            : kind === 'video' ? { type: 'video', file: value }
              : kind === 'file' ? { type: 'file', path: value }
                : { type: 'at', qq: value });
    }
  }
  if (last < text.length) parts.push({ type: 'text', text: text.slice(last) });
  const plain = parts.map(part => part.type === 'text' ? part.text : '').join('');
  const messages = marked ? [parts.filter(part => part.type !== 'text' || part.text.trim())] : plain.split(/\n{2,}/).map(chunk => chunk.trim()).filter(Boolean);
  return { messages, stickers, qzone };
}
