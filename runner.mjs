import {classify,pickResponse,norm} from './engine.mjs';
export class Runner {
 constructor({store,config,bank,api,onChange=()=>{},observe=()=>{},pollBlocked=()=>false}){Object.assign(this,{store,config,bank,api,onChange,observe,pollBlocked});this.busy=false;this.sending=false;this.timer=null;this.stopping=false}
 cfg(){return this.config()}
 own(c,cfg){return [cfg.accountId,cfg.scopedId].includes(String(c.from?.id)) || norm(c.from?.username??c.username)===norm(cfg.username)}
 start(){this.timer=setInterval(()=>this.tick().catch(e=>this.store.event(e.message,'error')),15000);this.timer.unref()}
 stop(){this.stopping=true;clearInterval(this.timer)}
 async tick(force=false){
  if(this.busy||this.stopping)return;
  const cfg=this.cfg();
  if(cfg.mode==='paused'||!cfg.connected||!cfg.since)return;
  if(cfg.transport!=='webhook'&&cfg.mode!=='live'&&this.pollBlocked())return;
  if(cfg.transport!=='webhook'&&!force&&Date.now()-(this.store.get('lastPoll',0))<cfg.pollSeconds*1000)return;
  this.busy=true;
  try{
   const api=this.api();
   if(cfg.longLived && Date.now()-this.store.get('tokenCheckedAt',Date.now())>7*86400000){
    const r=await api.refresh();
    if(r.access_token)this.onChange({refreshToken:r.access_token,expiresIn:r.expires_in});
    this.store.set('tokenCheckedAt',Date.now());
   }
   if(cfg.transport==='webhook'){
    await this.drainWebhooks(api);
    await this.drainReplies();
    return;
   }
   let media=this.store.get('media',[]);
   if(!media.length||Date.now()-this.store.get('mediaAt',0)>1800000){
    media=await api.media(cfg.accountId,cfg.maxMedia);
    if(cfg.allowMediaIds.length)media=media.filter(m=>cfg.allowMediaIds.includes(m.id));
    this.store.set('media',media);this.store.set('mediaAt',Date.now());
   }
   let cursor=this.store.get('mediaCursor',0);
   for(let j=0;j<Math.min(5,media.length);j++){
    if(this.stopping||this.cfg().mode==='paused')break;
    const m=media[cursor%media.length]; cursor++;
    try{await this.scan(api,m,cfg)}catch(e){
     this.store.event(e.message,'error');
     if(['auth','rate','local_rate','network'].includes(e.kind))throw e;
    }
   }
   this.store.set('mediaCursor',cursor);
   if(this.cfg().mode==='live'){
    for(const c of this.store.queue()){
     if(!this.canSend(this.cfg()))break;
     await this.send(c.id,false);
    }
   }
   this.store.set('lastPoll',Date.now());
   this.store.set('lastSuccess',Date.now());
  }catch(e){
   this.store.event(e.message,'error');
   this.store.set('lastPoll',Date.now());
   if(e.kind==='auth')this.onChange({pause:true});
  }finally{this.busy=false}
 }
 async scan(api,media,cfg){
  let after=this.store.get('page:'+media.id,'');
  for(let page=0;page<cfg.maxCommentsPages;page++){
   const r=await api.comments(media.id,after);
   const rows=r.data??[];
   let hitOld=false;
   for(const c of rows){
    this.observe(c,media);
    if(c.parent_id)continue;
    const date=Date.parse(c.timestamp);
    if(!Number.isFinite(date))continue;
    if(date<Date.parse(cfg.since)){hitOld=true;continue}
    this.ingest(c,media,cfg);
   }
   const next=r.paging?.next?r.paging?.cursors?.after:'';
   if(!next||next===after||hitOld){this.store.set('page:'+media.id,'');return}
   after=next;this.store.set('page:'+media.id,after);
  }
  this.store.event('Много новых комментариев: следующая страница будет прочитана в следующий проход.');
 }
 ingest(c,media,cfg){
    this.observe(c,media);
    if(c.parent_id)return;
    if(this.store.comment(c.id))return;
    let decision=classify(c.text,this.bank(),{caption:media.caption??'',own:this.own(c,cfg)});
    if(!c.from?.id && !c.from?.username)decision={...decision,action:'skip',reason:'Instagram не вернул автора — автоматический ответ исключён'};
    if(!cfg.enabledCategories.includes(decision.category) && decision.action==='auto')decision={...decision,action:'skip',reason:'Категория выключена'};
    const reply=decision.category?pickResponse(decision.category,this.bank(),this.store.history(),{...cfg,mediaId:media.id,authorId:c.from?.id}):null;
    let status=decision.action==='skip'?'skipped':decision.action==='review'?'review':cfg.mode==='live'?'queued':'preview';
    if(!reply&&decision.action!=='skip'){status='review';decision.reason='Свежие варианты этой категории закончились'}
    this.store.add({id:c.id,media_id:media.id,author_id:String(c.from?.id??''),username:c.from?.username??'',text:c.text,timestamp:c.timestamp,category:decision.category,response_id:reply?.id,response:reply?.text,status,reason:decision.reason});
 }

 async drainReplies(){
  if(this.cfg().mode==='live')for(const c of this.store.queue()){
   if(!this.canSend(this.cfg()))break;
   await this.send(c.id,false);
  }
 }
 async drainWebhooks(api){
  for(const event of this.store.inbox()){
   if(this.stopping||this.cfg().mode==='paused'||this.cfg().transport!=='webhook')break;
   const finish=(status,reason='')=>this.store.db.prepare('UPDATE webhook_inbox SET status=?,reason=? WHERE id=?').run(status,reason,event.id);
   if(this.store.comment(event.id)){finish('done');continue}
   try{
    const cfg=this.cfg();
    if(event.received_at<Date.parse(cfg.since)){finish('ignored','До начала обработки');continue}
    const c=await api.comment(event.id);
    if(String(c.id)!==event.id)throw Error('Instagram вернул другой ID комментария');
    const date=Date.parse(c.timestamp);
    if(!Number.isFinite(date)||date<Date.parse(this.cfg().since)){finish('ignored','Старый комментарий или нет времени');continue}
    if(c.parent_id||this.own(c,cfg)){finish('ignored','Ответ в ветке или собственный комментарий');continue}
    const mediaId=String(c.media?.id??c.media??event.media_id);
    if(!/^\d{5,30}$/.test(mediaId))throw Error('Не определена публикация комментария');
    if(cfg.allowMediaIds.length&&!cfg.allowMediaIds.includes(mediaId)){finish('ignored','Публикация выключена');continue}
    let cached=this.store.get('webhookMedia:'+mediaId);
    if(!cached||Date.now()-cached.at>1800000){
     const media=await api.mediaInfo(mediaId);
     cached={at:Date.now(),media};this.store.set('webhookMedia:'+mediaId,cached);
    }
    const current=this.cfg();
    if(this.stopping||current.mode==='paused'||current.transport!=='webhook')break;
    const ingestCfg={...current,mode:event.mode==='live'&&current.mode==='live'&&date>=Date.parse(current.since)?'live':'preview'};
    this.ingest(c,{...cached.media,id:mediaId},ingestCfg);
    finish('done');this.store.set('lastSuccess',Date.now());
   }catch(e){
    const attempts=event.attempts+1;
    const delay=['rate','local_rate'].includes(e.kind)?3600000:Math.min(3600000,30000*2**Math.min(attempts,7));
    this.store.db.prepare('UPDATE webhook_inbox SET attempts=?,next_attempt=?,status=?,reason=? WHERE id=?').run(attempts,Date.now()+delay,attempts>=12?'error':'pending',e.message,event.id);
    this.store.event('Webhook: '+e.message,'error');
    if(['auth','rate','local_rate','network'].includes(e.kind))throw e;
   }
  }
 }
 canSend(cfg){
  return cfg.connected && cfg.mode!=='paused' && this.store.sentSince(3600000)<cfg.maxRepliesHour &&
   this.store.sentSince(86400000)<cfg.maxRepliesDay && Date.now()-this.store.lastSent()>=cfg.replyGapSeconds*1000;
 }
 async send(id,manual=false){
  if(this.sending)throw Error('Уже выполняется отправка');
  this.sending=true;
  let claimed=false;
  try{
   let cfg=this.cfg();const c=this.store.comment(id);
   if(!c||!['queued','preview','review'].includes(c.status))throw Error('Этот комментарий уже обработан');
   if(!manual&&cfg.mode!=='live')return;
   if(!this.canSend(cfg))throw Error('Отправка приостановлена либо достигнут локальный лимит');
   if(!c.author_id && !c.username)throw Error('Не подтверждён автор комментария');
   if([cfg.accountId,cfg.scopedId].includes(c.author_id)||norm(c.username)===norm(cfg.username))throw Error('Ответ самому себе исключён');
   const reply=pickResponse(c.category,this.bank(),this.store.history(),{...cfg,mediaId:c.media_id,authorId:c.author_id});
   if(!reply){this.store.change(id,{status:'review',reason:'Варианты закончились. Повторная фраза не отправлена.'});return}
   const api=this.api();
   // Проверяем уже существующие ответы, включая отправленные вручную.
   let after='',checked=false;
   for(let i=0;i<10;i++){
    const r=await api.replies(id,after);
    if((r.data??[]).some(x=>this.own(x,cfg))){
     this.store.change(id,{status:'skipped',reason:'Под комментарием уже есть ответ вашего аккаунта'});return;
    }
    if((r.data??[]).some(x=>!x.from?.id&&!x.from?.username)){
     this.store.change(id,{status:'review',reason:'Не удалось проверить авторов существующих ответов'});return;
    }
    const next=r.paging?.next?r.paging?.cursors?.after:'';
    if(!next){checked=true;break}
    if(next===after)break;after=next;
   }
   if(!checked){this.store.change(id,{status:'review',reason:'Слишком длинная ветка для автоматической проверки'});return}
   cfg=this.cfg();
   if(this.stopping||!this.canSend(cfg)||(!manual&&cfg.mode!=='live'))return;
   if(!this.store.claim(id))return;
   claimed=true;
   this.store.change(id,{response_id:reply.id,response:reply.text});
   // Резервируем ДО POST. При потере ответа Meta автоматический повтор запрещён.
   this.store.reserve(c,reply);
   const result=await api.reply(id,reply.text);
   if(!result.id)throw Object.assign(Error('Instagram не вернул ID ответа'),{kind:'uncertain'});
   this.store.change(id,{status:'sent',reply_id:result.id,reason:'Ответ опубликован'});
   this.store.event('Опубликован ответ '+result.id);
  }catch(e){
   if(claimed)this.store.change(id,{status:e.kind==='uncertain'?'uncertain':'failed',reason:e.message});
   if(e.kind==='auth')this.onChange({pause:true});
   throw e;
  }finally{this.sending=false}
 }
}
