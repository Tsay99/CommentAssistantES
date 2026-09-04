export const MAX_MANUAL_REPLY_LENGTH=2000;
export class ManualReplies {
 constructor({store,archive,runner,api,config}){Object.assign(this,{store,archive,runner,api,config});}
 attempt(id){return this.store.db.prepare('SELECT * FROM manual_replies WHERE request_id=?').get(id);}
 result(row){return {status:row.status,requestId:row.request_id,replyId:row.reply_id||null,message:row.reason};}
 validate({id,text,requestId,confirm}){
  if(confirm!==true)throw Error('Подтвердите публикацию ответа');
  if(!/^\d{5,30}$/.test(String(id)))throw Error('Неизвестный комментарий');
  if(typeof text!=='string'||!text.trim())throw Error('Напишите текст ответа');
  text=text.trim();
  if(text.length>MAX_MANUAL_REPLY_LENGTH)throw Error('Ответ должен быть не длиннее 2000 символов');
  if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))throw Error('Удалите непечатаемые символы из ответа');
  if(typeof requestId!=='string'||!/^[a-zA-Z0-9_-]{16,100}$/.test(requestId))throw Error('Обновите страницу перед отправкой');
  return {id:String(id),text,requestId};
 }
 async send(input){
  const {id,text,requestId}=this.validate(input);
  const previous=this.attempt(requestId);
  if(previous){
   if(previous.comment_id!==id||previous.text!==text)throw Error('Этот запрос уже относится к другому ответу');
   return this.result(previous);
  }
  const c=this.store.db.prepare("SELECT * FROM library_comments WHERE id=? AND parent_id='' AND id NOT IN (SELECT id FROM library_forgotten)").get(id);
  if(!c)throw Error('Комментарий не найден в загруженном архиве');
  if(c.own||this.runner.own({from:{id:c.author_id,username:c.username}},this.config()))throw Error('Ответ на собственный комментарий исключён');
  const ambiguous=this.store.db.prepare("SELECT * FROM manual_replies WHERE comment_id=? AND status IN ('checking','sending','uncertain') LIMIT 1").get(id);
  if(ambiguous)throw Error('Предыдущая отправка ещё не подтверждена. Проверьте её статус и ветку в Instagram перед повтором.');
  const duplicate=this.store.db.prepare("SELECT * FROM manual_replies WHERE comment_id=? AND text=? AND status='sent' LIMIT 1").get(id,text);
  if(duplicate)return this.result(duplicate);
  const automated=this.store.comment(id);
  if(['sending','uncertain'].includes(automated?.status))throw Error('Предыдущая отправка ещё не подтверждена. Проверьте Instagram.');
  if(this.runner.sending)throw Error('Уже выполняется отправка. Дождитесь её завершения.');
  if(!this.config().connected)throw Error('Сначала подключите Instagram');
  if(this.config().mode==='paused')throw Error('Сервис на паузе. Для ручного ответа выберите режим «Предпросмотр» в настройках.');
  if(!this.runner.canSend(this.config()))throw Error('Достигнут предел отправки или ещё не прошла минута после предыдущего ответа. Текст сохранён в поле.');
  this.runner.sending=true;
  let claimed=false,remoteAccepted=false;
  const change=(status,reason,replyId='')=>this.store.db.prepare('UPDATE manual_replies SET status=?,reason=?,reply_id=?,updated_at=? WHERE request_id=?').run(status,reason,replyId,Date.now(),requestId);
  try{
  this.store.db.prepare("INSERT INTO manual_replies(request_id,comment_id,media_id,text,status,created_at,updated_at,reason) VALUES(?,?,?,?,'checking',?,?,'Проверяем комментарий')").run(requestId,id,c.media_id,text,Date.now(),Date.now());
   const api=this.api();
   const current=await api.comment(id);
   if(String(current.id)!==id||current.parent_id)throw Error('Комментарий изменился или недоступен. Обновите публикацию.');
   const mediaId=String(current.media?.id??current.media??c.media_id);
   if(mediaId!==c.media_id)throw Error('Не совпала публикация комментария. Обновите архив.');
   if(this.runner.own(current,this.config()))throw Error('Ответ на собственный комментарий исключён');
   if(!current.from?.id&&!current.from?.username&&!c.author_id&&!c.username)throw Error('Instagram не вернул автора комментария. Обновите публикацию.');
   if(this.runner.stopping||!this.runner.canSend(this.config()))throw Error('Отправка приостановлена. Текст сохранён в поле.');
   this.archive.transaction(()=>{
    // Persist the intent before POST; a crash must never lead to a repeated publication.
    change('sending','Ожидаем подтверждение Instagram');
    if(!this.store.comment(id))this.store.add({...c,status:'review',reason:'Ручной ответ из архива'});
    this.store.change(id,{status:'sending',response:text,response_id:'manual:'+requestId,reason:'Публикуем ваш ответ'});
    this.store.reserve({...c,id:'manual:'+requestId},{id:'manual:'+requestId,text});
   });
   claimed=true;
   const published=await api.reply(id,text);
   if(!published.id)throw Object.assign(Error('Instagram не вернул подтверждение. Проверьте ветку вручную; повторная отправка заблокирована.'),{kind:'uncertain'});
   remoteAccepted=true;
   this.archive.transaction(()=>{
    change('sent','Ваш ответ опубликован в Instagram',String(published.id));
    this.store.change(id,{status:'sent',reply_id:String(published.id),reason:'Ваш ответ опубликован из панели'});
    this.archive.record({id:String(published.id),text,timestamp:new Date().toISOString(),from:{id:this.config().accountId,username:this.config().username}},c.media_id,id);
   });
   this.store.event('Опубликован ручной ответ '+published.id);
   return this.result(this.attempt(requestId));
  }catch(e){
   const definitive=['api','auth','local_rate','rate'].includes(e.kind);
   const uncertain=claimed&&(remoteAccepted||!definitive);
   const status=uncertain?'uncertain':'failed';
   const reason=uncertain?'Отправка не подтверждена. Проверьте Instagram; повторная отправка заблокирована.':e.message;
   change(status,reason);
   if(claimed)this.store.change(id,{status,reason});
   if(e.kind==='auth')this.runner.onChange({pause:true});
   return this.result(this.attempt(requestId));
  }finally{this.runner.sending=false;}
 }
 forget(username){
  const records=this.store.db.prepare('SELECT request_id FROM manual_replies WHERE comment_id IN (SELECT id FROM library_comments WHERE lower(username)=?)').all(username);
  for(const r of records){this.store.db.prepare("UPDATE manual_replies SET text='' WHERE request_id=?").run(r.request_id);this.store.db.prepare('DELETE FROM usage WHERE comment_id=?').run('manual:'+r.request_id);}
 }
}

