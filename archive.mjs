import {norm} from './engine.mjs';

export class Archive {
 constructor({store,config,api,isBusy=()=>false}){
  Object.assign(this,{store,config,api,isBusy});this.busy=false;this.stopping=false;
  store.db.function('archive_lower',{deterministic:true},value=>String(value??'').toLowerCase());
  store.db.exec("CREATE TABLE IF NOT EXISTS library_media(id TEXT PRIMARY KEY,caption TEXT NOT NULL DEFAULT '',permalink TEXT NOT NULL DEFAULT '',timestamp TEXT NOT NULL DEFAULT '',comments_count INTEGER,checked_at INTEGER); CREATE TABLE IF NOT EXISTS library_comments(id TEXT PRIMARY KEY,media_id TEXT NOT NULL,parent_id TEXT NOT NULL DEFAULT '',text TEXT NOT NULL DEFAULT '',timestamp TEXT NOT NULL DEFAULT '',author_id TEXT NOT NULL DEFAULT '',username TEXT NOT NULL DEFAULT '',own INTEGER NOT NULL DEFAULT 0,replies_complete INTEGER NOT NULL DEFAULT 0,checked_at INTEGER,author_checked INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS library_comment_media ON library_comments(media_id,parent_id,timestamp); CREATE INDEX IF NOT EXISTS library_comment_parent ON library_comments(parent_id); CREATE TABLE IF NOT EXISTS library_jobs(kind TEXT NOT NULL,id TEXT NOT NULL,media_id TEXT NOT NULL,after_cursor TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'pending',PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS library_cursors(task TEXT NOT NULL,cursor TEXT NOT NULL,PRIMARY KEY(task,cursor)); CREATE TABLE IF NOT EXISTS library_forgotten(id TEXT PRIMARY KEY);");
 }
 state(){const j=this.store.get('archiveJob',{status:'idle'});const {mediaAfter,...visible}=j;return {...visible,busy:this.busy,mediaCount:this.store.db.prepare('SELECT count(*) n FROM library_media').get().n,commentCount:this.store.db.prepare("SELECT count(*) n FROM library_comments WHERE parent_id='' AND id NOT IN (SELECT id FROM library_forgotten)").get().n,replyCount:this.store.db.prepare("SELECT count(*) n FROM library_comments WHERE parent_id<>'' AND id NOT IN (SELECT id FROM library_forgotten)").get().n,mediaDone:this.store.db.prepare("SELECT count(*) n FROM library_jobs WHERE kind='comments' AND status='done'").get().n,mediaTotal:this.store.db.prepare("SELECT count(*) n FROM library_jobs WHERE kind='comments'").get().n};}
 active(){return ['running','waiting'].includes(this.store.get('archiveJob',{}).status);}
 save(j){this.store.set('archiveJob',j);}
 own(c){const cfg=this.config();return [cfg.accountId,cfg.scopedId].includes(String(c.from?.id??c.author_id))||!!(c.from?.username??c.username)&&norm(c.from?.username??c.username)===norm(cfg.username);}
 media(m){this.store.db.prepare("INSERT INTO library_media(id,caption,permalink,timestamp,comments_count) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET caption=excluded.caption,permalink=excluded.permalink,timestamp=CASE WHEN excluded.timestamp<>'' THEN excluded.timestamp ELSE library_media.timestamp END,comments_count=COALESCE(excluded.comments_count,library_media.comments_count)").run(String(m.id),m.caption??'',m.permalink??'',m.timestamp??'',m.comments_count??null);}
 record(c,mediaId,parentId=''){
  if(!c?.id||this.store.db.prepare('SELECT 1 FROM library_forgotten WHERE id=?').get(String(c.id)))return;
  const from=c.from??{},author=String(from.id??''),username=from.username??c.username??'',known=!!(author||username);
  this.store.db.prepare("INSERT INTO library_comments(id,media_id,parent_id,text,timestamp,author_id,username,own,checked_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET media_id=excluded.media_id,parent_id=CASE WHEN excluded.parent_id<>'' THEN excluded.parent_id ELSE library_comments.parent_id END,text=excluded.text,timestamp=CASE WHEN excluded.timestamp<>'' THEN excluded.timestamp ELSE library_comments.timestamp END,author_id=CASE WHEN excluded.author_id<>'' THEN excluded.author_id ELSE library_comments.author_id END,username=CASE WHEN excluded.username<>'' THEN excluded.username ELSE library_comments.username END,own=CASE WHEN excluded.author_id<>'' OR excluded.username<>'' THEN excluded.own ELSE library_comments.own END,checked_at=excluded.checked_at")
   .run(String(c.id),String(mediaId),String(c.parent_id??parentId??''),c.text??'',c.timestamp??'',author,username,known&&this.own(c)?1:0,Date.now());
 }
 observe(c,m){this.media(m);this.record(c,m.id);}
 transaction(fn){this.store.db.exec('BEGIN IMMEDIATE');try{fn();this.store.db.exec('COMMIT')}catch(e){this.store.db.exec('ROLLBACK');throw e;}}
 start(mediaId=''){
  if(!this.config().connected)throw Error('Сначала подключите Instagram');
  if(this.busy||this.active())return this.state();
  const previous=this.store.get('archiveJob',{});
  if(!mediaId&&['paused','error'].includes(previous.status)){
   this.save({...previous,status:'running',nextAt:0,error:''});return this.state();
  }
  if(mediaId&&!this.store.db.prepare('SELECT id FROM library_media WHERE id=?').get(mediaId))throw Error('Публикация ещё не загружена');
  this.transaction(()=>{
   this.store.db.exec('DELETE FROM library_jobs; DELETE FROM library_cursors;');
   this.store.db.prepare('UPDATE library_comments SET author_checked=0 WHERE (?=\'\' OR media_id=?)').run(mediaId,mediaId);
   if(mediaId)this.store.db.prepare("INSERT INTO library_jobs(kind,id,media_id) VALUES('comments',?,?)").run(mediaId,mediaId);
   this.save({status:'running',phase:mediaId?'comments':'catalog',mediaAfter:'',scope:mediaId,startedAt:Date.now(),nextAt:0,error:'',requests:0});
  });
  this.store.event(mediaId?'Обновляем комментарии выбранной публикации.':'Начата загрузка всех доступных публикаций и комментариев. Ничего не публикуется.');
  return this.state();
 }
 pause(){const j=this.store.get('archiveJob',{});if(this.active())this.save({...j,status:'paused',error:''});return this.state();}
 startTimer(){this.timer=setInterval(()=>void this.tick(),1500);this.timer.unref();}
 stop(){this.stopping=true;clearInterval(this.timer);}
 cursor(r,old,task){
  if(!r.paging?.next)return '';
  const next=r.paging?.cursors?.after;
  if(!next||next===old||this.store.db.prepare('SELECT 1 FROM library_cursors WHERE task=? AND cursor=?').get(task,String(next)))throw Error('Instagram повторил страницу. Загрузка остановлена, чтобы не пропустить комментарии.');
  this.store.db.prepare('INSERT INTO library_cursors VALUES(?,?)').run(task,String(next));return String(next);
 }
 async tick(){
  const j=this.store.get('archiveJob',{});
  if(this.stopping||this.busy||this.isBusy()||!['running','waiting'].includes(j.status)||j.nextAt>Date.now())return;
  this.busy=true;
  try{
   if(!this.config().connected)throw Object.assign(Error('Подключите Instagram заново'),{kind:'auth'});
   if(this.store.callCount()>=Math.max(1,(this.config().maxApiCallsHour??160)-10))throw Object.assign(Error('Загрузка ждёт освобождения лимита. Оставлен резерв запросов для ручных ответов.'),{kind:'local_rate'});
   const next=await this.step(j);
   // A pause clicked during the request must survive completion of that page.
   if(this.store.get('archiveJob',{}).status==='paused')next.status='paused';
   this.save({...next,error:'',nextAt:0,requests:(j.requests??0)+1});
  }catch(e){
   const paused=this.store.get('archiveJob',{}).status==='paused';
   const retry=['local_rate','rate','network'].includes(e.kind)||this.store.get('cooldown',0)>Date.now();
   const earliest=this.store.db.prepare('SELECT min(at) t FROM calls WHERE at>?').get(Date.now()-3600000).t;
   const nextAt=e.kind==='network'?Date.now()+60000:Math.max(Date.now()+30000,this.store.get('cooldown',0),earliest?earliest+3602000:Date.now()+60000);
   this.save({...j,status:paused?'paused':retry?'waiting':'error',error:e.message,nextAt:retry?nextAt:0});
   this.store.event('Загрузка архива: '+e.message,retry?'info':'error');
  }finally{this.busy=false;}
 }
 async step(j){
  const api=this.api();
  if(j.phase==='catalog'){
   const r=await api.mediaPage(this.config().accountId,j.mediaAfter);
   let after;
   this.transaction(()=>{
    for(const m of r.data??[]){this.media(m);this.store.db.prepare("INSERT OR IGNORE INTO library_jobs(kind,id,media_id) VALUES('comments',?,?)").run(m.id,m.id);}
    after=this.cursor(r,j.mediaAfter,'catalog');
    this.save({...j,status:this.store.get('archiveJob',{}).status==='paused'?'paused':j.status,mediaAfter:after,phase:after?'catalog':'comments'});
   });
   return {...j,mediaAfter:after,phase:after?'catalog':'comments',status:'running'};
  }
  if(j.phase==='comments'){
   const task=this.store.db.prepare("SELECT j.* FROM library_jobs j JOIN library_media m ON m.id=j.media_id WHERE j.kind='comments' AND j.status='pending' ORDER BY m.timestamp DESC,m.id DESC LIMIT 1").get();
   if(!task)return {...j,phase:'replies',status:'running'};
   const r=await api.archiveComments(task.id,task.after_cursor);
   this.transaction(()=>{
    for(const c of r.data??[]){
     this.record(c,task.media_id);
     if(!c.parent_id){
      const forgotten=this.store.db.prepare('SELECT 1 FROM library_forgotten WHERE id=?').get(c.id);
      // The expanded edge omits empty reply lists. Rows in this endpoint also include replies with parent_id.
      for(const reply of c.replies?.data??[])if(!forgotten)this.record(reply,task.media_id,c.id);
      const more=c.replies?.paging?.next;
      this.store.db.prepare('UPDATE library_comments SET replies_complete=? WHERE id=?').run(more?0:1,c.id);
      if(more){
       const after=c.replies.paging.cursors?.after;if(!after)throw Error('Instagram не вернул курсор ответов');
       this.store.db.prepare("INSERT INTO library_jobs(kind,id,media_id,after_cursor) VALUES('replies',?,?,?) ON CONFLICT(kind,id) DO UPDATE SET after_cursor=excluded.after_cursor,status='pending'").run(c.id,task.media_id,after);
      }
     }
    }
    const after=this.cursor(r,task.after_cursor,'comments:'+task.id);
    this.store.db.prepare("UPDATE library_jobs SET after_cursor=?,status=? WHERE kind='comments' AND id=?").run(after,after?'pending':'done',task.id);
    if(!after)this.store.db.prepare('UPDATE library_media SET checked_at=? WHERE id=?').run(Date.now(),task.id);
   });
   return {...j,status:'running'};
  }
  if(j.phase==='replies'){
   const task=this.store.db.prepare("SELECT * FROM library_jobs WHERE kind='replies' AND status='pending' LIMIT 1").get();
   if(!task)return {...j,phase:'authors',status:'running'};
   const r=await api.replies(task.id,task.after_cursor);
   this.transaction(()=>{
    for(const c of r.data??[])this.record(c,task.media_id,task.id);
    const after=this.cursor(r,task.after_cursor,'replies:'+task.id);
    this.store.db.prepare("UPDATE library_jobs SET after_cursor=?,status=? WHERE kind='replies' AND id=?").run(after,after?'pending':'done',task.id);
    if(!after)this.store.db.prepare('UPDATE library_comments SET replies_complete=1 WHERE id=?').run(task.id);
   });
   return {...j,status:'running'};
  }
  const missing=this.store.db.prepare("SELECT c.* FROM library_comments c JOIN library_jobs j ON j.kind='comments' AND j.media_id=c.media_id WHERE c.parent_id<>'' AND c.author_id='' AND c.username='' AND c.author_checked=0 AND c.id NOT IN (SELECT id FROM library_forgotten) LIMIT 1").get();
  if(missing){
   try{const c=await api.comment(missing.id);if(String(c.id)!==missing.id)throw Error('Не совпал ID ответа');this.record(c,missing.media_id,missing.parent_id);}
   catch(e){if(e.kind!=='api')throw e;}
   this.store.db.prepare('UPDATE library_comments SET author_checked=? WHERE id=?').run(Date.now(),missing.id);
   return {...j,status:'running'};
  }
  this.store.db.prepare("DELETE FROM library_comments WHERE checked_at<? AND media_id IN (SELECT media_id FROM library_jobs WHERE kind='comments' AND status='done') AND id NOT IN (SELECT id FROM library_forgotten)").run(j.startedAt);
  this.store.event('Загрузка архива завершена. Комментарии доступны в фильтрах.');
  return {...j,status:'done',finishedAt:Date.now()};
 }
 query({mediaId='',reply='',q='',sort='newest',page=1}={}){
  if(mediaId&&!/^\d{5,30}$/.test(mediaId))throw Error('Некорректная публикация');
  if(!['','answered','unanswered','unknown','own'].includes(reply))throw Error('Некорректный фильтр');
  page=Math.max(1,Math.floor(Number(page)||1));q=String(q).trim().slice(0,200);
  const base="SELECT c.*,m.caption,m.permalink,m.timestamp media_timestamp,a.status automation_status,a.response,a.reason, CASE WHEN c.own=1 THEN 'own' WHEN a.status='sent' OR EXISTS(SELECT 1 FROM manual_replies mr WHERE mr.comment_id=c.id AND mr.status='sent') OR EXISTS(SELECT 1 FROM library_comments r WHERE r.parent_id=c.id AND r.own=1) THEN 'answered' WHEN c.replies_complete=0 OR EXISTS(SELECT 1 FROM library_comments r WHERE r.parent_id=c.id AND r.author_id='' AND r.username='') THEN 'unknown' ELSE 'unanswered' END reply_state FROM library_comments c LEFT JOIN library_media m ON m.id=c.media_id LEFT JOIN comments a ON a.id=c.id WHERE c.parent_id='' AND c.id NOT IN (SELECT id FROM library_forgotten)";
  const args=[],filters=[];
  if(mediaId){filters.push('media_id=?');args.push(mediaId);}
  if(q){filters.push("(instr(archive_lower(text),archive_lower(?))>0 OR instr(archive_lower(username),archive_lower(?))>0)");args.push(q,q);}
  const scope='SELECT * FROM ('+base+')'+(filters.length?' WHERE '+filters.join(' AND '):'');
  const counts=this.store.db.prepare('SELECT reply_state,count(*) count FROM ('+scope+') GROUP BY reply_state').all(...args);
  const filtered=scope+(reply?(filters.length?' AND ':' WHERE ')+'reply_state=?':'');
  const filterArgs=reply?[...args,reply]:args;
  const total=this.store.db.prepare('SELECT count(*) n FROM ('+filtered+')').get(...filterArgs).n;
  const pages=Math.max(1,Math.ceil(total/50));page=Math.min(page,pages);
  const order={newest:'timestamp DESC,id DESC',oldest:'timestamp ASC,id ASC',publication:'media_timestamp DESC,media_id DESC,timestamp DESC,id DESC'}[sort]??'timestamp DESC,id DESC';
  const items=this.store.db.prepare('SELECT * FROM ('+filtered+') ORDER BY '+order+' LIMIT 50 OFFSET ?').all(...filterArgs,(page-1)*50);
  for(const c of items){
   c.replies=this.store.db.prepare("SELECT id,text,timestamp,username,own FROM library_comments WHERE parent_id=? AND id NOT IN (SELECT id FROM library_forgotten) ORDER BY timestamp,id").all(c.id);
   c.manualAttempts=this.store.db.prepare('SELECT request_id,status,reason,reply_id,text,created_at FROM manual_replies WHERE comment_id=? ORDER BY created_at DESC LIMIT 5').all(c.id);
  }
  return {items,total,page,pages,counts,media:this.store.db.prepare("SELECT m.*, (SELECT count(*) FROM library_comments c WHERE c.media_id=m.id AND c.parent_id='' AND c.id NOT IN (SELECT id FROM library_forgotten)) loaded_comments FROM library_media m ORDER BY timestamp DESC,id DESC").all(),sync:this.state()};
 }
 forget(username){
  const rows=this.store.db.prepare('SELECT id FROM library_comments WHERE lower(username)=?').all(username);
  for(const c of rows){this.store.db.prepare('INSERT OR IGNORE INTO library_forgotten VALUES(?)').run(c.id);this.store.db.prepare("UPDATE library_comments SET text='',username='',author_id='' WHERE id=?").run(c.id);}
  return rows.length;
 }
}

