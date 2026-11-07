import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { bounds } from './time.mjs';
const parse = value => value ? JSON.parse(value) : null;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const proposalContent = ({revision,contentHash,...event}) => event;
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
      CREATE TABLE IF NOT EXISTS event_edits (event_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS event_versions (event_id TEXT, revision INTEGER, payload TEXT NOT NULL, PRIMARY KEY(event_id,revision));
      CREATE TABLE IF NOT EXISTS day_revisions (day TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS week_versions (id TEXT PRIMARY KEY, start TEXT NOT NULL, payload TEXT NOT NULL);
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
  dayRevision(day) { return this.db.prepare('SELECT revision FROM day_revisions WHERE day=?').get(day)?.revision || 0; }
  bumpDay(day) { this.db.prepare('INSERT INTO day_revisions VALUES(?,1) ON CONFLICT(day) DO UPDATE SET revision=revision+1').run(day); }
  reflection(id) {
    const row=this.db.prepare('SELECT * FROM reflections WHERE event_id=?').get(id);
    const edit=parse(this.db.prepare('SELECT payload FROM event_edits WHERE event_id=?').get(id)?.payload)||{};
    return {note:row?.note||'',category:row?.category||'',follow:Boolean(row?.follow),updatedAt:row?.updated_at||null,decision:'unreviewed',overrides:{},version:0,...edit};
  }
  effectiveEvent(event) {
    const reflection=this.reflection(event.id);
    return {...event,...reflection.overrides,category:reflection.category||event.category,proposal:event,reflection,
      needsReview:Boolean((reflection.updatedAt&&!reflection.basedOnRevision)||(reflection.basedOnRevision&&reflection.basedOnRevision!==(event.revision||1)))};
  }
  versioned(event) {
    const old=parse(this.db.prepare('SELECT payload FROM events WHERE id=?').get(event.id)?.payload);
    const content=proposalContent(event),contentHash=hash(content);
    return {...content,contentHash,revision:old?(old.contentHash||hash(proposalContent(old)))===contentHash?(old.revision||1):(old.revision||1)+1:1};
  }
  writeEvent(event) {
    const old=parse(this.db.prepare('SELECT payload FROM events WHERE id=?').get(event.id)?.payload);
    if(old)this.db.prepare('INSERT OR IGNORE INTO event_versions VALUES(?,?,?)').run(old.id,old.revision||1,JSON.stringify(old));
    const next=this.versioned(event);
    this.db.prepare('INSERT INTO events VALUES(?,?,1,?) ON CONFLICT(id) DO UPDATE SET active=1,payload=excluded.payload').run(next.id,next.day,JSON.stringify(next));
    this.db.prepare('INSERT OR IGNORE INTO event_versions VALUES(?,?,?)').run(next.id,next.revision,JSON.stringify(next));
    return next;
  }
  previewEvents(day, events) {
    const manual=this.db.prepare('SELECT payload FROM events WHERE day=? AND active=1').all(day).map(r=>parse(r.payload)).filter(e=>e.origin==='human');
    return [...events.filter(e=>e.origin!=='human').map(e=>this.versioned(e)),...manual].map(e=>this.effectiveEvent(e)).filter(e=>e.reflection.decision!=='reject');
  }
  review(day) {
    const row = this.db.prepare('SELECT payload FROM reviews WHERE day=?').get(day);
    if (!row) return null;
    const all = this.db.prepare('SELECT e.*,r.note,r.category,r.follow,r.updated_at FROM events e LEFT JOIN reflections r ON e.id=r.event_id WHERE e.day=? ORDER BY e.rowid').all(day);
    const report=parse(row.payload),current=all.filter(e=>e.active).map(r=>this.effectiveEvent(parse(r.payload)));
    return {...report,factsRevision:this.dayRevision(day),stale:report.summaryRevision!==undefined&&report.summaryRevision!==this.dayRevision(day),
      events:current.filter(e=>e.reflection.decision!=='reject'),rejectedEvents:current.filter(e=>e.reflection.decision==='reject'),
      retiredEvents:all.filter(e=>!e.active).map(r=>this.effectiveEvent(parse(r.payload))).filter(e=>e.reflection.updatedAt||e.reflection.version)};
  }
  saveReview(review, events, afterWrite = () => {}) {
    this.transaction(() => {
      const signature=()=>JSON.stringify(this.db.prepare('SELECT id,payload FROM events WHERE day=? AND active=1 ORDER BY id').all(review.day));
      const before=signature(),concurrent=review.inputRevision!==undefined&&review.inputRevision!==this.dayRevision(review.day);
      this.db.prepare("UPDATE events SET active=0 WHERE day=? AND COALESCE(json_extract(payload,'$.origin'),'ai')!='human'").run(review.day);
      events.forEach(event => this.writeEvent(event));
      if(before!==signature())this.bumpDay(review.day);
      const {inputRevision,...payload}=review;
      payload.summaryRevision=concurrent?-1:this.dayRevision(review.day);
      this.db.prepare('INSERT INTO reviews VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET complete=excluded.complete,payload=excluded.payload').run(review.day, Number(review.complete), JSON.stringify(payload));
      afterWrite();
    });
  }
  listReviews() { return this.db.prepare('SELECT payload FROM reviews ORDER BY day DESC').all().map(r => {const v=parse(r.payload);return {...v,stale:v.summaryRevision!==undefined&&v.summaryRevision!==this.dayRevision(v.day)};}); }
  event(id) { const event=parse(this.db.prepare('SELECT payload FROM events WHERE id=?').get(id)?.payload);return event?this.effectiveEvent(event):null; }
  reflect(id, input) {
    const event=this.event(id);if (!event) throw new Error('事件不存在');
    if (typeof input.note !== 'string' || input.note.length > 20000 || typeof input.category !== 'string' || input.category.length > 80 || typeof input.follow !== 'boolean') throw new Error('批注格式无效');
    const old=this.reflection(id),decision=input.decision??old.decision,overrides=input.overrides??old.overrides;
    if(!['unreviewed','keep','reject'].includes(decision)||!overrides||typeof overrides!=='object'||Array.isArray(overrides)||Object.entries(overrides).some(([key,value])=>!['title','summary','intent','intervention','outcome'].includes(key)||typeof value!=='string'||value.length>20000))throw new Error('人工修正格式无效');
    if(input.expectedVersion!==undefined&&input.expectedVersion!==old.version)throw new Error('批注已在其他页面更新，请刷新后再保存；当前输入仍保留');
    const basedOnRevision=input.basedOnRevision??event.revision??1;
    if(!Number.isInteger(basedOnRevision)||basedOnRevision<1)throw new Error('事件版本无效');
    this.transaction(()=>{
      this.db.prepare('INSERT INTO reflections VALUES(?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET note=excluded.note,category=excluded.category,follow=excluded.follow,updated_at=excluded.updated_at').run(id, input.note, input.category, Number(input.follow), Date.now());
      this.db.prepare('INSERT INTO event_edits VALUES(?,?) ON CONFLICT(event_id) DO UPDATE SET payload=excluded.payload').run(id,JSON.stringify({decision,overrides,version:old.version+1,basedOnRevision}));
      this.bumpDay(event.day);
    });
    return this.reflection(id);
  }
  addManual(event) {
    this.transaction(()=>{this.writeEvent({...event,origin:'human'});this.bumpDay(event.day);});
    return this.event(event.id);
  }
  saveWeek(week) {
    const saved={...week,id:randomUUID().replaceAll('-','')};
    this.transaction(()=>{
      this.db.prepare('INSERT INTO week_versions VALUES(?,?,?)').run(saved.id,saved.start,JSON.stringify(saved));
      this.db.prepare('INSERT INTO weeks VALUES(?,?) ON CONFLICT(start) DO UPDATE SET payload=excluded.payload').run(saved.start,JSON.stringify(saved));
    });
    return saved;
  }
  week(id) { return parse(this.db.prepare('SELECT payload FROM week_versions WHERE id=?').get(id)?.payload); }
  weekHistory(start) { return this.db.prepare('SELECT payload FROM week_versions WHERE start=? ORDER BY rowid DESC').all(start).map(r=>parse(r.payload)); }
  weekEvent(weekId,eventId) {
    const week=this.week(weekId),event=week?.eventSnapshots?.[eventId];
    if(!event)throw new Error('这份周总结没有保存该事件的依据，请重新生成周总结');
    return event;
  }
  weeks() {
    return this.db.prepare('SELECT payload FROM weeks ORDER BY start DESC').all().map(r=>{
      const w=parse(r.payload),stale=!w.sourceRevisions||Object.entries(w.sourceRevisions).some(([day,revision])=>revision!==this.dayRevision(day));
      return {...w,stale};
    });
  }
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
