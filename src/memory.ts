import { createAuthorFiles, type AuthorDoc, type MemorySources } from './memoryFiles.ts';
import {
  MAX_QUERY_CHARS, MEMORY_KINDS, MemoryError, chatRef, decodeRef, excerptOf, sha,
  type FindParams, type MemoryItem, type MemoryKind, type MemoryStatus, type MemoryStore, type ReadResult,
} from './memoryStore.ts';
import { errorText } from './faults.ts';
import { nearTitles, pageNamed, pageRelations, wikiCatalog, wikiGaps, type PageRelations } from './wiki.ts';

export { MEMORY_KINDS, MemoryError } from './memoryStore.ts';
export { readStable } from './memoryFiles.ts';
export type { MemoryErrorCode, MemoryItem, MemoryKind, MemoryStatus } from './memoryStore.ts';
export type { MemorySources } from './memoryFiles.ts';

export interface MemoryPage { items: MemoryItem[]; nextCursor?: string; coverage: MemoryStatus; search: { method: 'browse' | 'scan'; elapsedMs: number } }
export interface MemoryContent {
  ref: string; sourceId: string; kind: MemoryKind; version: string; title: string; time: string; timeBasis: ReadResult['timeBasis']; current: boolean;
  content: string; offset: number; nextOffset?: number; totalChars: number; turnId?: string; origin?: ReadResult['origin'];
  /** A wiki page's links each way and what they miss. */
  related?: PageRelations;
}
export interface MemoryService {
  find(input: Record<string, unknown>): Promise<MemoryPage>;
  read(input: Record<string, unknown>): Promise<MemoryContent>;
  status(): MemoryStatus;
  /** Her wiki as a whole: the catalog a session starts with, and the gaps her evening review is told about. */
  wiki: {
    dir?: string;
    /** `failure`: some of the wiki could not be read; what could still is in `text`. */
    catalog(): Promise<{ text?: string; failure?: string }>;
    gaps(): Promise<string | undefined>;
    /** One page by its name, with its relations; a name that fits none is refused with the names close to it. */
    open(input: Record<string, unknown>): Promise<MemoryContent>;
  };
}
export interface MemoryDeps {
  store: MemoryStore;
  timeZone: string;
  sources: MemorySources;
  /** Whether the caller may see this chat session; may throw while the host cannot say yet, which counts as no. */
  visible(sessionId: string): boolean;
  now?: () => Date;
}
export const DEFAULT_FIND_LIMIT = 20, MAX_FIND_LIMIT = 100, DEFAULT_READ_LIMIT = 4000, MAX_READ_LIMIT = 16000;

const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
function text(input: Record<string, unknown>, key: string, max: number): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max) throw new MemoryError('invalidQuery', `${key} 必须是不超过 ${max} 个字符的字符串`);
  return value;
}
function time(input: Record<string, unknown>, key: 'from' | 'to', timeZone: string): number | undefined {
  const value = text(input, key, 40);
  if (value === undefined) return undefined;
  const ms = iso.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw new MemoryError('invalidQuery', `${key} 需要带时区的 ISO 时间（如 2026-10-30T00:00:00+08:00）；日期请按 ${timeZone} 换算成当天零点`);
  return ms;
}
function whole(input: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = input[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new MemoryError('invalidQuery', `${key} 必须是 ${min} 到 ${max} 的整数`);
  return value;
}
/** desc and asc are the words she reaches for out of habit; refused, they cost her a step for nothing. */
const ORDERS = new Map<unknown, 'newest' | 'oldest'>([[undefined, 'newest'], [null, 'newest'], ['newest', 'newest'], ['oldest', 'oldest'], ['desc', 'newest'], ['asc', 'oldest']]);
/** Newest or oldest first, from what a lookup was given. */
export function findOrder(value: unknown): 'newest' | 'oldest' {
  const order = ORDERS.get(value);
  if (!order) throw new MemoryError('invalidQuery', 'order 只能是 newest 或 oldest');
  return order;
}
/** The one place a query is checked, for the tools and the console alike. */
export function normalizeFind(input: Record<string, unknown>, timeZone: string): FindParams {
  const query = text(input, 'query', MAX_QUERY_CHARS * 4);
  if (query !== undefined && (Array.from(query).length > MAX_QUERY_CHARS || query.includes('\0'))) throw new MemoryError('invalidQuery', `query 不能超过 ${MAX_QUERY_CHARS} 个字符，也不能含空字符`);
  const kindsInput = input.kinds;
  if (kindsInput !== undefined && kindsInput !== null && (!Array.isArray(kindsInput) || kindsInput.some(kind => !(MEMORY_KINDS as readonly unknown[]).includes(kind)))) throw new MemoryError('invalidQuery', `kinds 只能是 ${MEMORY_KINDS.join('、')}`);
  const order = findOrder(input.order);
  const fromMs = time(input, 'from', timeZone), toMs = time(input, 'to', timeZone);
  if (fromMs !== undefined && toMs !== undefined && fromMs >= toMs) throw new MemoryError('invalidQuery', 'from 必须早于 to（区间左闭右开）');
  const kinds = kindsInput?.length ? [...new Set(kindsInput as MemoryKind[])] : undefined;
  const sourceId = text(input, 'sourceId', 300), turnId = text(input, 'turnId', 300), linkedTo = text(input, 'linkedTo', 2000), cursor = text(input, 'cursor', 4000);
  return {
    order, limit: whole(input, 'limit', DEFAULT_FIND_LIMIT, 1, MAX_FIND_LIMIT),
    ...(query === undefined ? {} : { query }), ...(kinds ? { kinds } : {}), ...(fromMs === undefined ? {} : { fromMs }), ...(toMs === undefined ? {} : { toMs }),
    ...(sourceId ? { sourceId } : {}), ...(turnId ? { turnId } : {}), ...(linkedTo ? { linkedTo } : {}), ...(cursor ? { cursor } : {}),
  };
}
export function normalizeRead(input: Record<string, unknown>): { ref: string; offset: number; limit: number } {
  const ref = text(input, 'ref', 2000);
  if (!ref) throw new MemoryError('invalidQuery', 'ref 必须是 memory_find 给出的引用');
  return { ref, offset: whole(input, 'offset', 0, 0, Number.MAX_SAFE_INTEGER), limit: whole(input, 'limit', DEFAULT_READ_LIMIT, 1, MAX_READ_LIMIT) };
}
export function normalizeOpen(input: Record<string, unknown>): { title: string; offset: number; limit: number } {
  const title = text(input, 'title', 200);
  if (!title?.trim()) throw new MemoryError('invalidQuery', 'title 写认识页的页名，就是目录里 [[ ]] 中间的字');
  return { title, offset: whole(input, 'offset', 0, 0, Number.MAX_SAFE_INTEGER), limit: whole(input, 'limit', DEFAULT_READ_LIMIT, 1, MAX_READ_LIMIT) };
}

/** A hit of either source, before it becomes an item: what the filters and the ordering need. */
interface Candidate { item: MemoryItem; content: string; timeMs: number }
const chatKind = (params: FindParams) => !params.kinds || params.kinds.includes('conversation');
const asksForChat = (params: FindParams) => chatKind(params) && (!params.sourceId || params.sourceId.startsWith('chat:'));
/** The filters every candidate passes the same way, whichever source it came from. */
function accepts(candidate: Candidate, params: FindParams): boolean {
  const { item } = candidate;
  return (!params.kinds || params.kinds.includes(item.kind)) && (!params.sourceId || item.sourceId === params.sourceId)
    && (params.fromMs === undefined || candidate.timeMs >= params.fromMs) && (params.toMs === undefined || candidate.timeMs < params.toMs)
    && (!params.query || candidate.content.includes(params.query));
}
function authorItem(doc: AuthorDoc, query: string | undefined): MemoryItem {
  return { ref: doc.ref, sourceId: doc.sourceId, kind: doc.kind, title: doc.title, time: doc.time, timeBasis: doc.timeBasis, current: true, excerpt: excerptOf(doc.content, query) };
}
/** A wiki page is also found by its title, its file name, which the page itself need not repeat. */
const authorCandidate = (doc: AuthorDoc, query: string | undefined): Candidate => ({ item: authorItem(doc, query), content: doc.kind === 'wiki' ? `${doc.title}\n${doc.content}` : doc.content, timeMs: doc.timeMs });

/** The state a page cursor was taken in: it applies only while nothing it depends on has changed. */
interface CursorState { hash: string; upTo: number; revisions: number; files: string; offset: number }

/**
 * The one entry to long-term memory: tools and console call the same `find` and `read`. Nothing is indexed: chat is
 * scanned in the archive and her files are read when asked, so there is no queue to wait for and no index to rebuild.
 */
export function createMemory(deps: MemoryDeps): MemoryService {
  const { store, timeZone } = deps;
  const authors = createAuthorFiles(deps.sources, timeZone);
  const now = deps.now ?? (() => new Date());
  let checkedAt = now().toISOString();
  const scopeFailures = new Map<string, string>();
  const canSee = (sessionId: string): boolean => {
    try { const yes = deps.visible(sessionId); scopeFailures.delete('scope'); return yes; }
    catch (error) { scopeFailures.set('scope', `暂时说不清哪些会话在范围内：${errorText(error)}`); return false; }
  };
  const sessionsInScope = () => store.sessionIds().filter(canSee);
  const docs = async () => { const all = await authors.docs(); checkedAt = now().toISOString(); return all; };

  function status(): MemoryStatus {
    const failures = [...authors.failures(), ...[...scopeFailures].map(([sourceId, message]) => ({ sourceId, message }))];
    return { state: failures.length ? 'partial' : 'ready', failures, checkedAt };
  }
  function readCursor(cursor: string, hash: string, files: string): CursorState {
    let parsed: Partial<CursorState>;
    try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorState>; } catch { throw new MemoryError('invalidCursor', '翻页游标无效'); }
    if (typeof parsed.hash !== 'string' || !Number.isSafeInteger(parsed.upTo) || !Number.isSafeInteger(parsed.revisions) || typeof parsed.files !== 'string' || !Number.isSafeInteger(parsed.offset) || parsed.offset! < 0) throw new MemoryError('invalidCursor', '翻页游标无效');
    if (parsed.hash !== hash || parsed.revisions !== store.snapshot().revisions || parsed.files !== files) throw new MemoryError('cursorExpired', '查询条件、访问范围或资料已经变化，请重新查询（cursorExpired）');
    return parsed as CursorState;
  }
  const cursorOf = (state: CursorState) => Buffer.from(JSON.stringify(state)).toString('base64url');

  /**
   * What a ref points at now: her file as it is, or a chat line she may see; `unseen` for a line out of her sight,
   * which is not hers to judge; nothing when it no longer finds the text it cited.
   */
  function resolve(ref: string, all: readonly AuthorDoc[]): { file: AuthorDoc } | { record: NonNullable<ReturnType<MemoryStore['byRecordId']>> } | 'unseen' | undefined {
    let decoded: ReturnType<typeof decodeRef>;
    try { decoded = decodeRef(ref); } catch { return undefined; }
    if (decoded.kind === 'a') { const file = all.find(doc => doc.ref === ref); return file ? { file } : undefined; }
    const record = store.byRecordId(decoded.recordId);
    if (!record) return undefined;
    if (!canSee(record.sourceSessionId)) return 'unseen';
    return chatRef(record.recordId, record.content) === ref ? { record } : undefined;
  }
  /** What a link-following query looks at: the files that cite the ref and what the ref's own file cites, never a line she may not see. */
  function linked(ref: string, all: readonly AuthorDoc[], query: string | undefined): Candidate[] {
    const found = new Map<string, Candidate>();
    for (const doc of all) if (doc.links.includes(ref)) found.set(doc.ref, authorCandidate(doc, query));
    for (const target of all.find(doc => doc.ref === ref)?.links ?? []) {
      const now = resolve(target, all);
      if (typeof now !== 'object') continue;
      if ('file' in now) found.set(now.file.ref, authorCandidate(now.file, query));
      else found.set(target, { item: store.item(now.record, query), content: now.record.content, timeMs: Date.parse(now.record.occurredAt) });
    }
    return [...found.values()];
  }

  const wikiPages = (all: readonly AuthorDoc[]) => all.filter(doc => doc.kind === 'wiki');
  /** Her `引用：` refs that no longer find the text they cited. */
  const staleRefs = (doc: AuthorDoc, all: readonly AuthorDoc[]) => doc.links.filter(ref => resolve(ref, all) === undefined);
  function relationsOf(doc: AuthorDoc, all: readonly AuthorDoc[]): PageRelations {
    const stale = staleRefs(doc, all);
    return { ...pageRelations(doc, wikiPages(all)), ...(stale.length ? { staleRefs: stale.slice(0, 5) } : {}) };
  }
  /** A wiki page comes back with its relations; any other item as it is. */
  function withRelations(item: MemoryItem, all: readonly AuthorDoc[]): MemoryItem {
    const doc = item.kind === 'wiki' ? all.find(each => each.sourceId === item.sourceId) : undefined;
    return doc ? { ...item, related: relationsOf(doc, all) } : item;
  }
  const wikiFailure = () => authors.failures().filter(({ sourceId }) => sourceId === 'dir:wiki' || sourceId.startsWith('wiki:')).map(({ message }) => message).join('；') || undefined;
  const wiki: MemoryService['wiki'] = {
    ...(deps.sources.wikiDir ? { dir: deps.sources.wikiDir } : {}),
    async catalog() {
      if (!deps.sources.wikiDir) return {};
      const text = wikiCatalog(wikiPages(await docs()), deps.sources.wikiDir), failure = wikiFailure();
      return { ...(text ? { text } : {}), ...(failure ? { failure } : {}) };
    },
    async gaps() {
      if (!deps.sources.wikiDir) return undefined;
      const all = await docs();
      return wikiGaps(wikiPages(all), page => staleRefs(page, all));
    },
    async open(input) {
      const { title, offset, limit } = normalizeOpen(input);
      if (!deps.sources.wikiDir) throw new MemoryError('notFound', '这个世界没有认识页');
      const all = await docs(), pages = wikiPages(all), page = pageNamed(pages, title);
      if (!page) {
        const near = nearTitles(pages, title);
        throw new MemoryError('notFound', near.length ? `没有叫「${title}」的认识页；有的页：${near.join('、')}` : '还没有写过认识页');
      }
      return contentPage(fileFound(page), offset, limit, relationsOf(page, all));
    },
  };

  async function find(input: Record<string, unknown>): Promise<MemoryPage> {
    const started = performance.now();
    const params = normalizeFind(input, timeZone);
    const all = await docs();
    const sessions = sessionsInScope();
    if (params.linkedTo) {
      const session = store.refSession(params.linkedTo);
      if (session !== undefined && !canSee(session)) throw new MemoryError('outOfScope', 'linkedTo 指向的聊天不在当前可读范围内');
    }
    const hash = sha(JSON.stringify([params.query ?? null, params.kinds ?? null, params.fromMs ?? null, params.toMs ?? null, params.sourceId ?? null, params.turnId ?? null, params.linkedTo ?? null, params.order, [...sessions].sort()]));
    const files = sha(all.map(doc => doc.sourceId + doc.ref).sort().join('\n'));
    const resumed = params.cursor ? readCursor(params.cursor, hash, files) : undefined;
    const upTo = resumed?.upTo ?? store.snapshot().head, offset = resumed?.offset ?? 0;
    const want = offset + params.limit + 1;
    let candidates: Candidate[];
    if (params.linkedTo) candidates = linked(params.linkedTo, all, params.query).filter(candidate => accepts(candidate, params));
    else {
      const chat = asksForChat(params) ? store.find(params, sessions, upTo, want).map((record): Candidate => ({ item: store.item(record, params.query), content: record.content, timeMs: Date.parse(record.occurredAt) })) : [];
      const written = params.turnId ? [] : all.map(doc => authorCandidate(doc, params.query)).filter(candidate => accepts(candidate, params));
      candidates = [...chat, ...written];
    }
    // A turn is read in the order it was said; everything else by time, ties keeping the order the sources gave.
    if (!params.turnId) { const way = params.order === 'newest' ? -1 : 1; candidates = candidates.map((candidate, index) => ({ candidate, index })).sort((a, b) => way * (a.candidate.timeMs - b.candidate.timeMs) || a.index - b.index).map(entry => entry.candidate); }
    const page = candidates.slice(offset, offset + params.limit);
    // Membership is asked again on what is about to be returned: a session that left the scope meanwhile is refused, not trimmed.
    for (const { item } of page) if (item.kind === 'conversation' && item.origin?.sessionId && !canSee(item.origin.sessionId)) throw new MemoryError('scopeChanged', '查询期间可读范围变了，请重新查询');
    const more = candidates.length > offset + params.limit;
    return {
      items: page.map(candidate => withRelations(candidate.item, all)),
      ...(more ? { nextCursor: cursorOf({ hash, upTo, revisions: store.snapshot().revisions, files, offset: offset + params.limit }) } : {}),
      coverage: status(), search: { method: params.query ? 'scan' : 'browse', elapsedMs: Math.round((performance.now() - started) * 10) / 10 },
    };
  }

  async function read(input: Record<string, unknown>): Promise<MemoryContent> {
    const { ref, offset, limit } = normalizeRead(input);
    const decoded = decodeRef(ref);
    let found: ReadResult, related: PageRelations | undefined;
    if (decoded.kind === 'c') {
      found = store.read(ref, canSee);
      if (found.origin?.sessionId && !canSee(found.origin.sessionId)) throw new MemoryError('scopeChanged', '读取期间可读范围变了，请重新读取');
    } else {
      const all = await docs(), doc = all.find(candidate => candidate.sourceId === decoded.sourceId);
      if (!doc) throw new MemoryError('notFound', '这条引用对应的文件不存在');
      if (doc.ref !== ref) throw new MemoryError('sourceChanged', '这个文件在引用之后被改过，旧版正文没有保留（sourceChanged）');
      found = fileFound(doc);
      if (doc.kind === 'wiki') related = relationsOf(doc, all);
    }
    return contentPage(found, offset, limit, related);
  }
  return { find, read, status, wiki };
}

function fileFound(doc: AuthorDoc): ReadResult {
  return { ref: doc.ref, sourceId: doc.sourceId, kind: doc.kind, version: decodeRef(doc.ref).hash, title: doc.title, time: doc.time, timeBasis: doc.timeBasis, current: true, content: doc.content };
}
/** One stretch of a text she reads, `offset` to `offset + limit` characters, saying where the rest begins. */
function contentPage(found: ReadResult, offset: number, limit: number, related?: PageRelations): MemoryContent {
  const chars = Array.from(found.content);
  const end = Math.min(chars.length, offset + limit);
  return {
    ref: found.ref, sourceId: found.sourceId, kind: found.kind, version: found.version, title: found.title, time: found.time, timeBasis: found.timeBasis, current: found.current,
    content: chars.slice(offset, end).join(''), offset, ...(end < chars.length ? { nextOffset: end } : {}), totalChars: chars.length,
    ...(found.turnId ? { turnId: found.turnId } : {}), ...(found.origin ? { origin: found.origin } : {}), ...(related ? { related } : {}),
  };
}
