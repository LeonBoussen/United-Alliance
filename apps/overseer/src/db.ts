// Embedded storage: Node's built-in SQLite, one file in the data directory. Documents are
// stored as JSON per collection; the event log is its own table. The schema in
// docs/DATA_MODEL.md is the target for the Postgres version.
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { SystemEvent } from "@alliance/protocol";

export class Db {
  private db: DatabaseSync;
  private putStmt: StatementSync;
  private delStmt: StatementSync;
  private allStmt: StatementSync;
  private getStmt: StatementSync;
  private eventStmt: StatementSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS docs (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (collection, id)
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        data TEXT NOT NULL
      );
    `);
    this.putStmt = this.db.prepare("INSERT INTO docs (collection, id, data) VALUES (?, ?, ?) ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data");
    this.delStmt = this.db.prepare("DELETE FROM docs WHERE collection = ? AND id = ?");
    this.allStmt = this.db.prepare("SELECT data FROM docs WHERE collection = ?");
    this.getStmt = this.db.prepare("SELECT data FROM docs WHERE collection = ? AND id = ?");
    this.eventStmt = this.db.prepare("INSERT OR IGNORE INTO events (seq, ts, data) VALUES (?, ?, ?)");
  }

  put(collection: string, id: string, doc: unknown): void {
    this.putStmt.run(collection, id, JSON.stringify(doc));
  }

  delete(collection: string, id: string): void {
    this.delStmt.run(collection, id);
  }

  get<T>(collection: string, id: string): T | undefined {
    const row = this.getStmt.get(collection, id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }

  all<T>(collection: string): T[] {
    return (this.allStmt.all(collection) as { data: string }[]).map((r) => JSON.parse(r.data) as T);
  }

  appendEvent(e: SystemEvent): void {
    this.eventStmt.run(e.seq, e.ts, JSON.stringify(e));
  }

  recentEvents(limit: number): SystemEvent[] {
    const rows = this.db.prepare("SELECT data FROM events ORDER BY seq DESC LIMIT ?").all(limit) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as SystemEvent).reverse();
  }

  maxEventSeq(): number {
    const row = this.db.prepare("SELECT MAX(seq) AS seq FROM events").get() as { seq: number | null };
    return row.seq ?? 0;
  }

  /** Keep the event log bounded: drop debug events after 7 days, everything after 180. */
  pruneEvents(): void {
    const day = 24 * 60 * 60 * 1000;
    this.db.prepare("DELETE FROM events WHERE ts < ?").run(new Date(Date.now() - 180 * day).toISOString());
    this.db.prepare("DELETE FROM events WHERE ts < ? AND json_extract(data, '$.level') = 'debug'").run(new Date(Date.now() - 7 * day).toISOString());
  }

  /** Delete every document and event (before the files themselves are removed). */
  wipe(): void {
    this.db.exec("DELETE FROM docs; DELETE FROM events; PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
  }

  close(): void {
    this.db.close();
  }
}
