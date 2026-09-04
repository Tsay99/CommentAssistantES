import {DatabaseSync} from 'node:sqlite';
export class Store {
 constructor(path){
  this.db=new DatabaseSync(path);
  this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  this.db.exec("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY,media_id TEXT,author_id TEXT,username TEXT,text TEXT,timestamp TEXT,category TEXT,response_id TEXT,response TEXT,status TEXT,reason TEXT,created_at INTEGER,reply_id TEXT); CREATE TABLE IF NOT EXISTS usage(comment_id TEXT PRIMARY KEY,response_id TEXT,media_id TEXT,author_id TEXT,used_at INTEGER); CREATE TABLE IF NOT EXISTS calls(at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS calls_at ON calls(at); CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,at INTEGER,level TEXT,message TEXT);");
  this.db.exec("CREATE TABLE IF NOT EXISTS webhook_inbox(id TEXT PRIMARY KEY,media_id TEXT NOT NULL,received_at INTEGER NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,reason TEXT NOT NULL DEFAULT ''); CREATE INDEX IF NOT EXISTS inbox_status ON webhook_inbox(status,next_attempt);");
  this.db.exec("CREATE TABLE IF NOT EXISTS manual_replies(request_id TEXT PRIMARY KEY,comment_id TEXT NOT NULL,media_id TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL,reply_id TEXT NOT NULL DEFAULT '',reason TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS manual_reply_comment ON manual_replies(comment_id,status);");
  this.db.prepare("UPDATE manual_replies SET status='uncertain',reason='Сервис перезапустился во время отправки. Проверьте Instagram; повтор заблокирован.' WHERE status='sending'").run();
  this.db.prepare("UPDATE manual_replies SET status='failed',reason='Проверка прервалась до отправки. Можно повторить.' WHERE status='checking'").run();
  if(!this.db.prepare('PRAGMA table_info(usage)').all().some(c=>c.name==='response_text'))this.db.exec("ALTER TABLE usage ADD COLUMN response_text TEXT NOT NULL DEFAULT ''");
  this.db.prepare("UPDATE comments SET status='uncertain',reason='Сервис перезапустился во время отправки. Проверьте Instagram перед любым повтором.' WHERE status='sending'").run();
 }
 get(key,fallback=null){const v=this.db.prepare("SELECT value FROM settings WHERE key=?").get(key);return v?JSON.parse(v.value):fallback}
 set(key,value){this.db.prepare("INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key,JSON.stringify(value))}
 comment(id){return this.db.prepare("SELECT * FROM comments WHERE id=?").get(id)}
 add(c){
  return this.db.prepare("INSERT OR IGNORE INTO comments(id,media_id,author_id,username,text,timestamp,category,response_id,response,status,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(c.id,c.media_id,c.author_id??'',c.username??'',c.text,c.timestamp,c.category??'',c.response_id??'',c.response??'',c.status,c.reason??'',Date.now()).changes>0;
 }
 change(id,fields){
  const keys=Object.keys(fields);
  if(keys.some(k=>!['category','response_id','response','status','reason','reply_id'].includes(k)))throw Error('Недопустимое поле');
  this.db.prepare('UPDATE comments SET '+keys.map(k=>k+'=?').join(',')+' WHERE id=?').run(...keys.map(k=>fields[k]),id);
 }
 claim(id){return this.db.prepare("UPDATE comments SET status='sending' WHERE id=? AND status IN ('queued','review','preview')").run(id).changes===1}
 reserve(c,response){
  this.db.prepare('INSERT INTO usage(comment_id,response_id,media_id,author_id,used_at,response_text) VALUES(?,?,?,?,?,?) ON CONFLICT(comment_id) DO UPDATE SET response_id=excluded.response_id,used_at=excluded.used_at,response_text=excluded.response_text').run(c.id,response.id,c.media_id,c.author_id,Date.now(),response.text);
 }
 history(){return this.db.prepare('SELECT * FROM usage ORDER BY used_at DESC').all()}
 recent(limit=150){return this.db.prepare('SELECT * FROM comments ORDER BY created_at DESC,id DESC LIMIT ?').all(limit)}
 queue(){return this.db.prepare("SELECT * FROM comments WHERE status='queued' ORDER BY created_at,id").all()}
 counts(){return this.db.prepare('SELECT status,count(*) as count FROM comments GROUP BY status').all()}
 event(message,level='info'){this.db.prepare('INSERT INTO events(at,level,message) VALUES(?,?,?)').run(Date.now(),level,message)}
 events(){return this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 30').all()}
 callCount(){return this.db.prepare('SELECT count(*) n FROM calls WHERE at>?').get(Date.now()-3600000).n}
 chargeCall(limit){if(this.callCount()>=limit)throw Object.assign(Error('Достигнут локальный лимит обращений. Продолжим позже.'),{kind:'local_rate'});this.db.prepare('INSERT INTO calls VALUES(?)').run(Date.now());this.db.prepare('DELETE FROM calls WHERE at<?').run(Date.now()-86400000)}
 sentSince(ms){return this.db.prepare("SELECT count(*) n FROM usage WHERE used_at>?").get(Date.now()-ms).n}
 lastSent(){return this.db.prepare('SELECT max(used_at) t FROM usage').get().t??0}
 inbox(){return this.db.prepare("SELECT * FROM webhook_inbox WHERE status='pending' AND next_attempt<=? ORDER BY received_at,id LIMIT 10").all(Date.now())}
 close(){this.db.close()}
}
