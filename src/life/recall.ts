import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { formatLocalTime } from '../timeContext.ts';

/**
 * `recall`: finding her way back through what the memory system already keeps — the archive of her
 * conversations, her diary, and the activity log. It is a catalogue, not a second copy: rows point at a
 * file and a line, a source that is gone takes its rows with it, and the whole file may be deleted and
 * rebuilt at any time. What was never written down is not found here, and that is deliberate.
 */
export type RecallKind = 'chat' | 'diary' | 'activity';
export interface RecallHit {
  kind: RecallKind; day: string; occurredAt: string; speaker: string; text: string; source: string; line: number;
}
export interface RecallInput { query: string; from?: string; to?: string; sources?: readonly string[]; limit?: number; offset?: number }
export interface RecallIndexOptions {
  /** Her world; `conversations/` and `activity/` live under it. */
  worldDir: string;
  /** `config.diaryDir` may point outside the world. */
  diaryDir: string;
  timeZone: string;
  selfName: string;
  partnerName: string;
  /** Defaults to `<worldDir>/recall.sqlite`. */
  file?: string;
  now?: () => number;
}

interface SourceRow { path: string; mtimeMs: number; size: number }
interface DocRow { docId: string; day: string; occurredAt: string; kind: RecallKind; role: string; speaker: string; text: string; path: string; line: number }
interface StoredDoc extends DocRow { rank: number }

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.(jsonl|md)$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CJK = /[\u3400-\u9fff]/;
const DAY_MS = 86_400_000;
const SCHEMA_VERSION = 1;
const kinds: readonly RecallKind[] = ['chat', 'diary', 'activity'];

/** One space between CJK characters, so the unicode61 tokenizer keeps each of them as a token of its own; Latin words stay whole. */
export function tokenizeForIndex(text: string): string {
  return text.replace(/([\u3400-\u9fff])/g, ' $1 ');
}
/** A query term as an FTS5 expression: Chinese becomes an ordered run of characters, Latin a word prefix. */
export function matchExpression(query: string): string | undefined {
  const terms = query.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  const parts = terms.flatMap(term => {
    const runs = term.match(/[\u3400-\u9fff]+|[A-Za-z0-9_]+/g) ?? [];
    return runs.map(run => CJK.test(run) ? `"${[...run].join(' ')}"` : `"${run.toLowerCase()}"*`);
  });
  return parts.length ? parts.join(' AND ') : undefined;
}
/** The archive's delivery wrapper is bookkeeping, not words she said; the quote block is a picture she cannot search. */
function cleanChat(content: string): string {
  return content
    .replace(/^微信(?:回复|待发送)给[^：\n]*：\n/, '')
    .replace(/【引用 \{[^\n]*?\}】/g, '【引用】')
    .replace(/!\[([^\]]*)\]\(https?:\/\/(?:127\.0\.0\.1|localhost):\d+([^)\s]*)\)/g, (_all, alt: string, path: string) => `[${path.includes('/api/memes/') ? '表情包' : '图片'}${alt ? `：${alt}` : ''}]`)
    .trim();
}
/** `YYYY-MM-DDTHH:MM:SS` from a diary heading, or midday when the heading has no clock. */
function diaryAt(day: string, title: string): string {
  const clock = /(\d{1,2}):(\d{2})/.exec(title);
  return clock ? `${day}T${clock[1]!.padStart(2, '0')}:${clock[2]}:00` : `${day}T12:00:00`;
}

/**
 * The index over her three memory sources. A call syncs whatever changed since the last one, so a new
 * day's log, a diary entry rewritten at night, or a source that was deleted all show up on the next search.
 */
export function createRecallIndex(options: RecallIndexOptions) {
  const { worldDir, diaryDir, timeZone, selfName, partnerName } = options;
  const now = options.now ?? Date.now;
  const file = options.file ?? join(worldDir, 'recall.sqlite');
  const dirs: Record<RecallKind, string> = { chat: join(worldDir, 'conversations'), diary: diaryDir, activity: join(worldDir, 'activity') };
  let db: DatabaseSync | undefined;
  let closed = false;

  function open(): DatabaseSync {
    if (db) return db;
    mkdirSync(dirname(file), { recursive: true });
    const attempt = (recover: boolean): DatabaseSync => {
      const handle = new DatabaseSync(file);
      try {
        handle.exec('PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL');
        // The index is derived data: a different schema is dropped and rebuilt, never migrated.
        const version = Number((handle.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0);
        if (version !== SCHEMA_VERSION) {
          handle.exec('DROP TABLE IF EXISTS docs_fts; DROP TABLE IF EXISTS docs; DROP TABLE IF EXISTS files;');
          handle.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
        }
        handle.exec(`CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, mtimeMs REAL NOT NULL, size INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS docs (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, docId TEXT NOT NULL UNIQUE, day TEXT NOT NULL, occurredAt TEXT NOT NULL,
            kind TEXT NOT NULL, role TEXT NOT NULL, speaker TEXT NOT NULL, text TEXT NOT NULL, path TEXT NOT NULL, line INTEGER NOT NULL
          );
          CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(text, tokenize='unicode61');
          CREATE INDEX IF NOT EXISTS docsDay ON docs(day);
          CREATE INDEX IF NOT EXISTS docsPath ON docs(path);`);
        return handle;
      } catch (error) {
        try { handle.close(); } catch { /* already unusable */ }
        if (!recover) throw error;
        // A damaged file is thrown away too; nothing here cannot be read again from her memory.
        if (!/malformed|not a database/i.test(String((error as Error).message))) throw error;
        for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
        return attempt(false);
      }
    };
    db = attempt(true);
    return db;
  }

  function transaction<T>(work: (handle: DatabaseSync) => T): T {
    const handle = open();
    handle.exec('BEGIN IMMEDIATE');
    try { const result = work(handle); handle.exec('COMMIT'); return result; }
    catch (error) { handle.exec('ROLLBACK'); throw error; }
  }

  function dropSource(handle: DatabaseSync, path: string): void {
    const ids = handle.prepare('SELECT seq FROM docs WHERE path=?').all(path).map(row => Number((row as { seq: number }).seq));
    if (ids.length) handle.prepare(`DELETE FROM docs_fts WHERE rowid IN (${ids.join(',')})`).run();
    handle.prepare('DELETE FROM docs WHERE path=?').run(path);
  }

  function parseChat(path: string, day: string): DocRow[] {
    const rows: DocRow[] = [];
    readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
      if (!line.trim()) return;
      let record: Record<string, unknown>;
      try { record = JSON.parse(line) as Record<string, unknown>; } catch { return; }
      const text = cleanChat(String(record.content ?? ''));
      if (!text) return;
      const role = String(record.role ?? '');
      const speaker = String(record.speakerName ?? (role === 'user' ? partnerName : selfName));
      rows.push({
        docId: `chat:${String(record.recordId ?? `${day}:${index}`)}`, day,
        occurredAt: typeof record.occurredAt === 'string' ? record.occurredAt : `${day}T00:00:00`,
        kind: 'chat', role, speaker, text, path, line: index + 1,
      });
    });
    return rows;
  }

  function parseDiary(path: string, day: string): DocRow[] {
    const rows: DocRow[] = [];
    const lines = readFileSync(path, 'utf8').split('\n');
    let title = ''; let start = 1; let body: string[] = [];
    const flush = () => {
      const text = body.join('\n').trim();
      if (text) rows.push({ docId: `diary:${day}:${start}`, day, occurredAt: diaryAt(day, title), kind: 'diary', role: 'assistant', speaker: selfName, text, path, line: start });
    };
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (/^##\s+/.test(line)) { flush(); title = line.slice(2).trim(); start = index + 1; body = []; continue; }
      if (!title && /^#\s+/.test(line)) continue;
      body.push(line);
    }
    flush();
    return rows;
  }

  function parseActivity(path: string, day: string): DocRow[] {
    const rows: DocRow[] = [];
    readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
      if (!line.trim()) return;
      let record: Record<string, unknown>;
      try { record = JSON.parse(line) as Record<string, unknown>; } catch { return; }
      const tool = String(record.tool ?? '').trim();
      const summary = String(record.summary ?? '').trim();
      const text = [tool, summary].filter(Boolean).join('：');
      if (!text) return;
      rows.push({ docId: `activity:${day}:${index}`, day, occurredAt: typeof record.time === 'string' ? record.time : `${day}T00:00:00`, kind: 'activity', role: 'assistant', speaker: selfName, text, path, line: index + 1 });
    });
    return rows;
  }

  function rebuild(path: string, kind: RecallKind, day: string, stat: { mtimeMs: number; size: number }): void {
    let rows: DocRow[];
    try { rows = kind === 'chat' ? parseChat(path, day) : kind === 'diary' ? parseDiary(path, day) : parseActivity(path, day); }
    catch { return; }
    transaction(handle => {
      dropSource(handle, path);
      const insertDoc = handle.prepare('INSERT OR REPLACE INTO docs(docId, day, occurredAt, kind, role, speaker, text, path, line) VALUES (?,?,?,?,?,?,?,?,?)');
      const insertFts = handle.prepare('INSERT INTO docs_fts(rowid, text) VALUES (?,?)');
      for (const row of rows) {
        const result = insertDoc.run(row.docId, row.day, row.occurredAt, row.kind, row.role, row.speaker, row.text, row.path, row.line);
        insertFts.run(Number(result.lastInsertRowid), tokenizeForIndex(row.text));
      }
      handle.prepare('INSERT INTO files(path, mtimeMs, size) VALUES (?,?,?) ON CONFLICT(path) DO UPDATE SET mtimeMs=excluded.mtimeMs, size=excluded.size').run(path, stat.mtimeMs, stat.size);
    });
  }

  /** Reads what changed and forgets what is gone; cheap when nothing moved. */
  function sync(): void {
    if (closed) return;
    const handle = open();
    const seen = new Set<string>();
    for (const kind of kinds) {
      const dir = dirs[kind];
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        const match = DAY_FILE.exec(name);
        if (!match || (kind === 'diary' ? match[2] !== 'md' : match[2] !== 'jsonl')) continue;
        const path = join(dir, name); const day = match[1]!;
        seen.add(path);
        let stat: { mtimeMs: number; size: number };
        try { const got = statSync(path); stat = { mtimeMs: got.mtimeMs, size: got.size }; } catch { continue; }
        const known = handle.prepare('SELECT mtimeMs, size FROM files WHERE path=?').get(path) as SourceRow | undefined;
        if (known && Number(known.mtimeMs) === stat.mtimeMs && Number(known.size) === stat.size) continue;
        rebuild(path, kind, day, stat);
      }
    }
    for (const row of handle.prepare('SELECT path FROM files').all() as unknown as SourceRow[]) if (!seen.has(row.path)) {
      if (existsSync(row.path)) continue;
      transaction(inner => { dropSource(inner, row.path); inner.prepare('DELETE FROM files WHERE path=?').run(row.path); });
    }
  }

  function weight(kind: RecallKind, ageDays: number): number {
    // What she wrote down stays sharp; what she merely lived through fades the way it does for anyone.
    if (kind === 'diary') return 1;
    const recency = ageDays <= 3 ? 1 : Math.max(0.3, Math.exp(-(ageDays - 3) / 45));
    return kind === 'chat' ? recency : 0.6 * recency;
  }

  function excerpt(text: string, query: string, width: number): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    if (flat.length <= width) return flat;
    const probe = ((query.match(/[\u3400-\u9fff]+|[A-Za-z0-9_]+/g) ?? []).sort((a, b) => b.length - a.length)[0] ?? '').toLowerCase();
    const at = probe ? flat.toLowerCase().indexOf(probe) : -1;
    const center = at < 0 ? 0 : at;
    const start = Math.max(0, center - Math.floor(width / 3));
    return `${start > 0 ? '…' : ''}${flat.slice(start, start + width)}${start + width < flat.length ? '…' : ''}`;
  }

  function displayTime(occurredAt: string): string {
    const parsed = new Date(occurredAt);
    if (Number.isNaN(parsed.getTime())) return occurredAt.slice(0, 16).replace('T', ' ');
    return formatLocalTime(parsed, timeZone).slice(0, 16).replace('T', ' ');
  }
  // Forward slashes and a world-relative path: this is what `read` is given back, and it should look the same on every host.
  const relative = (path: string) => (path.startsWith(worldDir) ? path.slice(worldDir.length + 1) : path).replace(/\\/g, '/');

  function search(input: RecallInput): string {
    const query = String(input.query ?? '').trim();
    if (!query) throw new Error('要搜什么？给本鱼一个词。');
    const expression = matchExpression(query);
    if (!expression) throw new Error('这个词本鱼没法搜，换一个吧。');
    const limit = Math.min(Math.max(Math.trunc(Number(input.limit ?? 8)) || 8, 1), 30);
    const offset = Math.max(Math.trunc(Number(input.offset ?? 0)) || 0, 0);
    sync();
    const handle = open();
    const where = ['docs_fts MATCH ?']; const params: (string | number)[] = [expression];
    if (input.from) { if (!DAY.test(input.from)) throw new Error('from 要写成 YYYY-MM-DD。'); where.push('d.day >= ?'); params.push(input.from); }
    if (input.to) { if (!DAY.test(input.to)) throw new Error('to 要写成 YYYY-MM-DD。'); where.push('d.day <= ?'); params.push(input.to); }
    const sources = (input.sources ?? []).filter((kind): kind is RecallKind => kinds.includes(kind as RecallKind));
    if (sources.length) { where.push(`d.kind IN (${sources.map(() => '?').join(',')})`); params.push(...sources); }
    const clause = where.join(' AND ');
    const total = Number((handle.prepare(`SELECT count(*) AS n FROM docs_fts JOIN docs d ON d.seq=docs_fts.rowid WHERE ${clause}`).get(...params) as { n: number }).n);
    if (!total) return `没有找到和「${query}」有关的记录${input.from || input.to ? '（在给的时间范围里）' : ''}。没写下来过的事，本鱼翻不出来，别编。`;
    const rows = handle.prepare(`SELECT d.*, bm25(docs_fts) AS rank FROM docs_fts JOIN docs d ON d.seq=docs_fts.rowid WHERE ${clause} ORDER BY rank LIMIT ?`).all(...params, Math.min(400, (offset + limit) * 8)) as unknown as StoredDoc[];
    const stamp = now();
    const scored = rows.map(row => {
      const at = Date.parse(row.occurredAt);
      const ageDays = Number.isNaN(at) ? 999 : Math.max(0, (stamp - at) / DAY_MS);
      const depth = weight(row.kind as RecallKind, ageDays);
      return { row, depth, score: -row.rank * depth };
    }).sort((a, b) => b.score - a.score || b.row.occurredAt.localeCompare(a.row.occurredAt));
    const page = scored.slice(offset, offset + limit);
    if (!page.length) return `「${query}」一共找到 ${total} 条，但第 ${offset + 1} 条往后就没有了。`;
    const labels: Record<RecallKind, string> = { chat: '聊天', diary: '日记', activity: '活动' };
    const lines = page.map((hit, index) => {
      // A memory that has faded is returned faded too: a short trace now, the full line once she opens the source.
      const width = hit.row.kind === 'diary' ? 160 : hit.depth >= 0.8 ? 110 : 70;
      const excerptText = excerpt(hit.row.text, query, width);
      return `${offset + index + 1}. 〔${labels[hit.row.kind as RecallKind]}〕${displayTime(hit.row.occurredAt)} ${hit.row.kind === 'chat' ? `${hit.row.speaker}：` : ''}${excerptText}\n   出处 ${relative(hit.row.path)}:${hit.row.line}`;
    });
    const more = offset + page.length < total ? `\n还有 ${total - offset - page.length} 条，往后翻用 offset=${offset + page.length}。` : '';
    return `找到 ${total} 条（按本鱼记得的深浅排，越近、越写下来的越靠前）：\n${lines.join('\n')}${more}\n要看原话就按出处打开那个文件。`;
  }

  function close(): void {
    if (closed) return;
    closed = true;
    try { db?.close(); } catch { /* already closed */ }
    db = undefined;
  }

  return { search, sync, close };
}
export type RecallIndex = ReturnType<typeof createRecallIndex>;