import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { ArchiveCursor, ConversationRecord, DeliveryState, PageQuery, RecordPage, WorldConfig } from './types.ts';
import { formatLocalTime } from './timeContext.ts';
import type { SpeakerIdentity } from './ecosystem/shared/identity.ts';
import { createMemoryStore } from './memoryStore.ts';

export interface ExportProgress { sessionId: string; nextSeq: number; turn: number }
interface StoredRow { sequence: number; day: string; body: string }
const pageSize = 128;

export function createArchiveStore(config: WorldConfig & { root: string }) {
  // The world id becomes a directory name.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(config.worldId)) throw new TypeError('dsh-world: invalid worldId');
  const worldRoot = join(config.root, 'worlds', config.worldId);
  const directory = join(worldRoot, 'conversations');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(worldRoot, 'archive.sqlite'));
  let closed = false;
  db.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS records (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, recordId TEXT NOT NULL UNIQUE,
      day TEXT NOT NULL, occurredAt TEXT NOT NULL, turnId TEXT NOT NULL, sourceSeq INTEGER NOT NULL,
      body TEXT NOT NULL, fileOffset INTEGER, fileBytes INTEGER
    );
    CREATE INDEX IF NOT EXISTS recordOrder ON records(day DESC, occurredAt DESC, recordId DESC);
    CREATE INDEX IF NOT EXISTS turnOrder ON records(turnId, sourceSeq);
    CREATE INDEX IF NOT EXISTS pendingExports ON records(day, sequence) WHERE fileOffset IS NULL;
    CREATE TABLE IF NOT EXISTS days (day TEXT PRIMARY KEY, exportedBytes INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS progress (sessionId TEXT PRIMARY KEY, nextSeq INTEGER NOT NULL, turn INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS channelSessions (conversationKey TEXT PRIMARY KEY, sessionId TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS channelDeliveries (recordId TEXT PRIMARY KEY, body TEXT NOT NULL);`);

  function transaction<T>(work: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  /** Long-term memory reads the records table on this connection; it keeps nothing of its own in the database. */
  const memory = createMemoryStore(db, { timeZone: config.timeZone });
  const decode = (row: StoredRow) => JSON.parse(row.body) as ConversationRecord;
  const dayOf = (record: ConversationRecord) => formatLocalTime(new Date(record.occurredAt), config.timeZone).slice(0, 10);
  /**
   * Appends a day's unexported records to its JSONL file. The database is the canonical copy: anything past the
   * recorded size (a write cut short by a crash) is cut off and written again, and a file that was deleted or
   * shortened is exported again from the start.
   */
  function flushDay(day: string): void {
    transaction(() => {
      const file = join(directory, `${day}.jsonl`);
      const fd = openSync(file, existsSync(file) ? 'r+' : 'wx+', 0o600);
      try {
        let offset = Number(db.prepare('SELECT exportedBytes FROM days WHERE day=?').get(day)?.exportedBytes ?? 0);
        if (fstatSync(fd).size < offset) {
          db.prepare('UPDATE records SET fileOffset=NULL, fileBytes=NULL WHERE day=?').run(day);
          offset = 0;
        }
        ftruncateSync(fd, offset);
        let sequence = 0;
        while (true) {
          const pending = db.prepare('SELECT sequence, body FROM records WHERE day=? AND fileOffset IS NULL AND sequence>? ORDER BY sequence LIMIT ?').all(day, sequence, pageSize) as unknown as StoredRow[];
          if (!pending.length) break;
          for (const row of pending) {
            const bytes = Buffer.from(row.body + '\n');
            let written = 0;
            while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written, offset + written);
            db.prepare('UPDATE records SET fileOffset=?, fileBytes=? WHERE sequence=?').run(offset, bytes.length, row.sequence);
            offset += bytes.length;
            sequence = row.sequence;
          }
        }
        fsyncSync(fd);
        db.prepare('UPDATE days SET exportedBytes=? WHERE day=?').run(offset, day);
      } finally { closeSync(fd); }
    });
  }
  function flushExports(): void {
    let after = '';
    while (true) {
      const rows = db.prepare('SELECT DISTINCT day FROM records WHERE fileOffset IS NULL AND day>? ORDER BY day LIMIT ?').all(after, pageSize);
      if (!rows.length) break;
      for (const row of rows) { after = String(row.day); flushDay(after); }
    }
  }
  async function commitRecords(records: readonly ConversationRecord[], progress?: ExportProgress): Promise<void> {
    try {
      transaction(() => {
        for (const record of records) {
          const day = dayOf(record);
          db.prepare('INSERT OR IGNORE INTO records(recordId, day, occurredAt, turnId, sourceSeq, body) VALUES (?,?,?,?,?,?)').run(record.recordId, day, record.occurredAt, record.turnId, record.sourceSeq, JSON.stringify(record));
          db.prepare('INSERT OR IGNORE INTO days(day) VALUES (?)').run(day);
        }
        if (progress) db.prepare('INSERT INTO progress VALUES (?,?,?) ON CONFLICT(sessionId) DO UPDATE SET nextSeq=excluded.nextSeq, turn=excluded.turn WHERE excluded.nextSeq>=progress.nextSeq').run(progress.sessionId, progress.nextSeq, progress.turn);
      });
      // Records and progress commit together; the JSONL export is retried on the next write or read.
      flushExports();
    } catch (error) { throw new Error(`dsh-world: archive write failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  }
  async function readPage(query: PageQuery): Promise<RecordPage> {
    flushExports();
    const before = query.before;
    const maxSequence = before?.maxSequence ?? Number(db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM records').get()?.n);
    const rows = (before
      ? db.prepare('SELECT * FROM records WHERE sequence<=? AND (day, occurredAt, recordId)<(?,?,?) ORDER BY day DESC, occurredAt DESC, recordId DESC LIMIT ?').all(maxSequence, before.date, before.occurredAt, before.recordId, query.limit + 1)
      : db.prepare('SELECT * FROM records WHERE sequence<=? ORDER BY day DESC, occurredAt DESC, recordId DESC LIMIT ?').all(maxSequence, query.limit + 1)) as unknown as StoredRow[];
    const page = rows.slice(0, query.limit);
    const records = page.map(decode);
    const last = page.at(-1); const lastRecord = records.at(-1);
    const nextCursor: ArchiveCursor | undefined = rows.length > query.limit && last && lastRecord ? { date: last.day, occurredAt: lastRecord.occurredAt, recordId: lastRecord.recordId, maxSequence } : undefined;
    return { records, ...(nextCursor ? { nextCursor } : {}) };
  }
  async function updateRecord(recordId: string, revise: (record: ConversationRecord) => Pick<ConversationRecord, 'content' | 'wechatDelivery'> & Partial<SpeakerIdentity>): Promise<void> {
    transaction(() => {
      const row = db.prepare('SELECT day, body FROM records WHERE recordId=? LIMIT 1').get(recordId) as unknown as StoredRow | undefined;
      if (!row) throw new Error('Archive record not found');
      const record = decode(row);
      const updated = { ...record, ...revise(record) };
      const body = JSON.stringify(updated);
      if (updated.wechatDelivery) db.prepare('UPDATE channelDeliveries SET body=? WHERE recordId=?').run(JSON.stringify(updated.wechatDelivery), recordId);
      if (body === row.body) return;
      db.prepare('UPDATE records SET body=? WHERE recordId=?').run(body, recordId);
      memory.revised();
      // A changed line invalidates later byte offsets; rebuild this day from the canonical database.
      db.prepare('UPDATE records SET fileOffset=NULL, fileBytes=NULL WHERE day=?').run(row.day);
      db.prepare('UPDATE days SET exportedBytes=0 WHERE day=?').run(row.day);
    });
    flushExports();
  }
  async function readTurn(turnId: string, afterSeq = -1, limit = pageSize): Promise<ConversationRecord[]> {
    flushExports();
    return (db.prepare('SELECT * FROM records WHERE turnId=? AND sourceSeq>? ORDER BY sourceSeq LIMIT ?').all(turnId, afterSeq, limit) as unknown as StoredRow[]).map(decode);
  }
  function progress(sessionId: string): ExportProgress {
    const row = db.prepare('SELECT nextSeq, turn FROM progress WHERE sessionId=?').get(sessionId);
    return { sessionId, nextSeq: Number(row?.nextSeq ?? 0), turn: Number(row?.turn ?? 0) };
  }
  /** The host no longer has this session; only the place to resume from goes, never what it archived. */
  function forgetProgress(sessionId: string): void {
    db.prepare('DELETE FROM progress WHERE sessionId=?').run(sessionId);
  }
  function sourcePage(afterId = '', limit = pageSize): string[] {
    return db.prepare('SELECT sessionId FROM progress WHERE sessionId>? ORDER BY sessionId LIMIT ?').all(afterId, limit).map(row => String(row.sessionId));
  }
  function stats(): { records: number; sessions: number } {
    const row = db.prepare("SELECT count(*) AS records, count(DISTINCT json_extract(body, '$.sourceSessionId')) AS sessions FROM records").get() as { records: number; sessions: number } | undefined;
    return { records: Number(row?.records ?? 0), sessions: Number(row?.sessions ?? 0) };
  }
  /** A consistent copy of the whole archive database (originals and index), for forking an experiment branch from one snapshot. */
  function snapshotTo(file: string): void {
    if (existsSync(file)) throw new Error('snapshot target already exists');
    db.prepare('VACUUM INTO ?').run(file);
  }
  function close(): void { if (!closed) { closed = true; db.close(); } }
  function hasRecord(recordId: string): boolean { return !!db.prepare('SELECT 1 FROM records WHERE recordId=? LIMIT 1').get(recordId); }
  function channelSession(key: string): string | undefined {
    return db.prepare('SELECT sessionId FROM channelSessions WHERE conversationKey=? LIMIT 1').get(key)?.sessionId as string | undefined;
  }
  function bindChannelSession(key: string, sessionId: string): void {
    transaction(() => { db.prepare('INSERT INTO channelSessions VALUES (?,?) ON CONFLICT(conversationKey) DO UPDATE SET sessionId=excluded.sessionId').run(key, sessionId); });
  }
  function delivery(recordId: string): DeliveryState | undefined {
    const row = db.prepare('SELECT body FROM channelDeliveries WHERE recordId=? LIMIT 1').get(recordId);
    return row ? JSON.parse(String(row.body)) as DeliveryState : undefined;
  }
  function registerDelivery(recordId: string, total: number): void {
    transaction(() => { db.prepare('INSERT OR IGNORE INTO channelDeliveries VALUES (?,?)').run(recordId, JSON.stringify({ status: 'pending', confirmed: 0, total })); });
  }
  function updateDelivery(recordId: string, revise: (previous: DeliveryState) => DeliveryState): void {
    transaction(() => {
      const previous = delivery(recordId);
      if (!previous) throw new Error('Delivery record not found');
      db.prepare('UPDATE channelDeliveries SET body=? WHERE recordId=?').run(JSON.stringify(revise(previous)), recordId);
    });
  }
  return { commitRecords, hasRecord, updateRecord, readPage, readTurn, progress, forgetProgress, sourcePage, stats, close,
    channelSession, bindChannelSession, delivery, registerDelivery, updateDelivery, memory, snapshotTo };
}
export type ArchiveStore = ReturnType<typeof createArchiveStore>;
