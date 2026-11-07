import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { bounds } from './time.mjs';
const parse = value => value ? JSON.parse(value) : null;
export class Store {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, directory TEXT, title TEXT, raw TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (session_id TEXT, id TEXT, created_at INTEGER, role TEXT, payload TEXT NOT NULL, PRIMARY KEY(session_id,id));
      CREATE INDEX IF NOT EXISTS messages_time ON messages(created_at);
      CREATE TABLE IF NOT EXISTS reviews (day TEXT PRIMARY KEY, complete INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, day TEXT NOT NULL, active INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_day ON events(day);
      CREATE TABLE IF NOT EXISTS reflections (event_id TEXT PRIMARY KEY, note TEXT, category TEXT, follow INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS weeks (start TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, kind TEXT, scope TEXT, status TEXT, stage TEXT, started_at INTEGER, finished_at INTEGER, error TEXT);
      CREATE TABLE IF NOT EXISTS locks (name TEXT PRIMARY KEY, owner TEXT, expires_at INTEGER);
      CREATE TABLE IF NOT EXISTS excluded (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, session_id TEXT, payload TEXT NOT NULL);
    `);
  }
  close() { this.db.close(); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  upsertSession(session, messages) {
    this.transaction(() => {
      this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET directory=excluded.directory,title=excluded.title,raw=excluded.raw').run(session.id, session.directory || '', session.title || session.id, JSON.stringify(session));
      const stmt = this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?) ON CONFLICT(session_id,id) DO UPDATE SET created_at=excluded.created_at,role=excluded.role,payload=excluded.payload');
      for (const m of messages) stmt.run(session.id, m.id, m.createdAt, m.role, JSON.stringify(m));
    });
  }
  sessions() { return this.db.prepare('SELECT raw FROM sessions ORDER BY id').all().map(r => parse(r.raw)); }
  messages(sessionId) { return this.db.prepare('SELECT payload FROM messages WHERE session_id=? ORDER BY created_at,id').all(sessionId).map(r => parse(r.payload)); }
  dayMessages(day) { const { start, end } = bounds(day); return this.db.prepare('SELECT payload FROM messages WHERE created_at>=? AND created_at<? ORDER BY created_at,id').all(start, end).map(r => parse(r.payload)); }
  message(sessionId, id) { return parse(this.db.prepare('SELECT payload FROM messages WHERE session_id=? AND id=?').get(sessionId, id)?.payload); }
  snapshot(sessionId) { const payload=JSON.stringify(this.messages(sessionId));const id=createHash('sha256').update(sessionId+'\0'+payload).digest('hex');this.db.prepare('INSERT OR IGNORE INTO snapshots VALUES(?,?,?)').run(id,sessionId,payload);return id; }
  snapshotMessages(id) { return parse(this.db.prepare('SELECT payload FROM snapshots WHERE id=?').get(id)?.payload); }
  exclude(id) { this.db.prepare('INSERT OR IGNORE INTO excluded VALUES(?)').run(id); }
  isExcluded(id) { return Boolean(this.db.prepare('SELECT id FROM excluded WHERE id=?').get(id)); }
  review(day) {
    const row = this.db.prepare('SELECT payload FROM reviews WHERE day=?').get(day);
    if (!row) return null;
    const all = this.db.prepare('SELECT e.*,r.note,r.category,r.follow,r.updated_at FROM events e LEFT JOIN reflections r ON e.id=r.event_id WHERE e.day=? ORDER BY e.rowid').all(day);
    const map = row => ({ ...parse(row.payload), reflection: { note: row.note || '', category: row.category || '', follow: Boolean(row.follow), updatedAt: row.updated_at || null } });
    return { ...parse(row.payload), events: all.filter(e => e.active).map(map), retiredEvents: all.filter(e => !e.active && (e.note || e.category || e.follow)).map(map) };
  }
  saveReview(review, events, afterWrite = () => {}) {
    this.transaction(() => {
      this.db.prepare('UPDATE events SET active=0 WHERE day=?').run(review.day);
      const stmt = this.db.prepare('INSERT INTO events VALUES(?,?,1,?) ON CONFLICT(id) DO UPDATE SET active=1,payload=excluded.payload');
      events.forEach(event => stmt.run(event.id, review.day, JSON.stringify(event)));
      this.db.prepare('INSERT INTO reviews VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET complete=excluded.complete,payload=excluded.payload').run(review.day, Number(review.complete), JSON.stringify(review));
      afterWrite();
    });
  }
  listReviews() { return this.db.prepare('SELECT payload FROM reviews ORDER BY day DESC').all().map(r => parse(r.payload)); }
  event(id) { return parse(this.db.prepare('SELECT payload FROM events WHERE id=?').get(id)?.payload); }
  reflect(id, input) {
    if (!this.event(id)) throw new Error('事件不存在');
    if (typeof input.note !== 'string' || input.note.length > 20000 || typeof input.category !== 'string' || input.category.length > 80 || typeof input.follow !== 'boolean') throw new Error('批注格式无效');
    this.db.prepare('INSERT INTO reflections VALUES(?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET note=excluded.note,category=excluded.category,follow=excluded.follow,updated_at=excluded.updated_at').run(id, input.note, input.category, Number(input.follow), Date.now());
  }
  saveWeek(week) { this.db.prepare('INSERT INTO weeks VALUES(?,?) ON CONFLICT(start) DO UPDATE SET payload=excluded.payload').run(week.start, JSON.stringify(week)); }
  weeks() { return this.db.prepare('SELECT payload FROM weeks ORDER BY start DESC').all().map(r => parse(r.payload)); }
  runs() { return this.db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 50').all(); }
  newRun(kind, scope) { const id = randomUUID(); this.db.prepare('INSERT INTO runs VALUES(?,?,?,\'running\',\'准备中\',?,NULL,NULL)').run(id, kind, scope, Date.now()); return id; }
  stage(id, stage) { this.db.prepare('UPDATE runs SET stage=? WHERE id=?').run(stage, id); }
  finish(id, error) { this.db.prepare('UPDATE runs SET status=?,stage=?,finished_at=?,error=? WHERE id=?').run(error ? 'failed' : 'succeeded', error ? '失败' : '完成', Date.now(), error?.message?.slice(0,2000) || null, id); }
  lock() {
    const owner = randomUUID();
    const got = this.db.prepare('INSERT INTO locks VALUES(\'review\',?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE locks.expires_at<?').run(owner, Date.now()+120000, Date.now());
    if (!got.changes) throw new Error('已有复盘任务正在执行，请等待完成');
    this.db.prepare("UPDATE runs SET status='failed',stage='中断',finished_at=?,error='上次进程中断，未标记成功，可重新执行' WHERE status='running'").run(Date.now());
    const timer = setInterval(() => this.db.prepare('UPDATE locks SET expires_at=? WHERE owner=?').run(Date.now()+120000, owner), 20000);
    timer.unref();
    return () => { clearInterval(timer); this.db.prepare('DELETE FROM locks WHERE owner=?').run(owner); };
  }
}
