let state=null,csrf='',seen=[],bankDraft=null;
const $=id=>document.getElementById(id);
const labels={sent:'Отправлено',preview:'Предпросмотр',review:'Нужен ваш ответ',skipped:'Пропущено',queued:'В очереди',sending:'Отправляется',uncertain:'Отправка не подтверждена',failed:'Ошибка'};
function el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n}
function notify(text,error=false){$('notice').textContent=text;$('notice').className='notice '+(error?'error':'');clearTimeout(notify.timer);notify.timer=setTimeout(()=>$('notice').classList.add('hidden'),9000)}
async function request(url,data){
 const r=await fetch(url,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(data)});
 const result=await r.json();if(!r.ok)throw Error(result.error||'Не удалось выполнить запрос');return result;
}
async function action(fn){try{await fn()}catch(e){notify(e.message,true)}}
function show(tab){document.querySelectorAll('.page').forEach(p=>p.classList.toggle('hidden',p.id!==tab));document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));window.scrollTo(0,0);if(tab==='history'&&state)action(loadComments)}
document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>show(b.dataset.tab)));
document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>show(b.dataset.go)));
function date(v){return v?new Date(v).toLocaleString('ru-RU'):'ещё не было'}
async function load(initial=false){
 state=await request('/api/state');csrf=state.csrf;
 $('modeBadge').textContent={preview:'Предпросмотр',live:'Автоответы включены',paused:'На паузе'}[state.config.mode];
 $('modeBadge').className='badge '+(state.config.mode==='live'?'live':'');
 $('sentCount').textContent=state.counts.find(x=>x.status==='sent')?.count??0;
 $('reviewCount').textContent=state.counts.filter(x=>['review','uncertain','failed'].includes(x.status)).reduce((a,x)=>a+x.count,0);
 $('connectionText').textContent=state.config.connected?'Подключён @'+state.config.username+'. Отслеживаем комментарии с '+date(state.config.since)+'.':'Подключите маркер доступа, чтобы начать получать комментарии. Предпросмотр примеров уже работает.';
 $('tokenStatus').textContent=state.config.tokenPresent?'Маркер защищён Windows. '+(state.config.tokenExpiresAt?'Действует до '+date(state.config.tokenExpiresAt):'Срок действия ещё не подтверждён Meta.'):'Маркер ещё не сохранён.';
 $('activity').textContent=(state.busy?'Сейчас проверяем комментарии. ':'Последняя успешная проверка: '+date(state.lastSuccess)+'. ')+'Обращений за час: '+state.calls+' из '+state.config.maxApiCallsHour+' (локальный предел). Публикаций в списке: '+state.catalogSize+'.'+(state.cooldown>Date.now()?' Пауза Meta до '+date(state.cooldown)+'.':'');
 $('poll').disabled=state.busy||!state.config.connected||state.config.mode==='paused'||state.config.transport==='webhook';
 $('poll').classList.toggle('hidden',state.config.transport==='webhook');
 $('pollSettings').classList.toggle('hidden',state.config.transport==='webhook');
 $('webhookModeNote').classList.toggle('hidden',state.config.transport!=='webhook');
 if(state.config.transport==='webhook')$('activity').textContent='Получение через Webhooks. Последняя обработка: '+date(state.lastSuccess)+'. Обращений к Instagram за час: '+state.calls+'.';
 renderWebhook(initial);
 renderArchiveProgress();
 if(!$('history').classList.contains('hidden'))await loadComments();
 $('events').replaceChildren(...state.events.slice(0,6).map(e=>el('p',date(e.at)+' · '+e.message,e.level==='error'?'error-text':'')));
 renderComments();
 if(initial){
  bankDraft=structuredClone(state.bank);
  $('categoryFilter').replaceChildren(new Option('Все категории',''),...bankDraft.categories.map(c=>new Option(c.label,c.id)));
  renderBank();
  for(const k of ['mode','pollSeconds','maxMedia','maxRepliesHour','maxRepliesDay','minRepeatHours'])$(k).value=state.config[k];
  $('allowMediaIds').value=state.config.allowMediaIds.join(', ');
  $('longLived').checked=!!state.config.longLived;
  $('enabledCategories').replaceChildren(...state.bank.categories.filter(c=>!c.review).map(c=>{
   const l=el('label',undefined,'check');const input=el('input');input.type='checkbox';input.value=c.id;input.checked=state.config.enabledCategories.includes(c.id);l.append(input,document.createTextNode(c.label));return l;
  }));
 }
}
function renderBank(){
 const filter=$('categoryFilter').value;
 $('bankList').replaceChildren(...bankDraft.categories.filter(c=>!filter||c.id===filter).map(c=>{
  const section=el('article',undefined,'panel bank-group');
  const h=el('h2',c.label+' · '+c.responses.length);section.append(h,el('p',[...c.emoji,...c.keywords].join(' · '),'small'));
  if(c.review)section.append(el('p','Эта категория всегда требует ручного подтверждения.','review-note'));
  for(const r of c.responses){
   const row=el('div',undefined,'bank-row'),label=el('label',r.id.toUpperCase());
   const input=el('textarea');input.rows=2;input.value=r.text;input.maxLength=350;input.setAttribute('aria-label','Ответ '+r.id);
   input.addEventListener('input',()=>{r.text=input.value});
   const enabled=el('input');enabled.type='checkbox';enabled.checked=r.enabled!==false;enabled.setAttribute('aria-label','Использовать '+r.id);
   enabled.addEventListener('change',()=>{r.enabled=enabled.checked});
   row.append(label,input,enabled);section.append(row);
  }return section;
 }));
}
function renderComments(){
 if(!state.comments.length){$('commentsList').replaceChildren(el('div','После начала отслеживания новых комментариев пока нет. Старые комментарии находятся в архиве выше.','panel empty'));return}
 $('commentsList').replaceChildren(...state.comments.map(c=>{
  const card=el('article',undefined,'panel comment'),row=el('div',undefined,'title-row');
  row.append(el('b',c.username?'@'+c.username:'Автор не указан'),el('span',labels[c.status]??c.status,'badge'));
  card.append(row,el('p',c.text||'Текст удалён'),el('p',date(c.timestamp)+' · '+c.id,'small'));
  if(c.response)card.append(el('div','↳ '+c.response,'draft'));
  card.append(el('p',c.reason,'small'));
  if(['preview','review','queued'].includes(c.status)){
   const actions=el('div',undefined,'actions');
   if(c.category&&c.response){
    const send=el('button','Отправить публично');send.addEventListener('click',()=>action(async()=>{
     if(!confirm('Опубликовать один ответ под этим комментарием в Instagram? Перед отправкой будет выбран доступный вариант категории.'))return;
     send.disabled=true;
     try{await request('/api/send',{id:c.id,confirm:true});await load();notify('Проверка и отправка завершены. Смотрите статус комментария.')}finally{send.disabled=false}
    }));actions.append(send);
   }
   const skip=el('button','Пропустить','link-button');skip.addEventListener('click',()=>action(async()=>{await request('/api/skip',{id:c.id});await load()}));actions.append(skip);card.append(actions);
  }return card;
 }));
}
$('categoryFilter').addEventListener('change',renderBank);
$('try').addEventListener('click',()=>action(async()=>{
 const r=await request('/api/preview',{text:$('example').value,caption:$('caption').value,used:seen});
 $('resultCategory').textContent=r.categoryLabel||'Без автоматического ответа';
 $('resultText').textContent=r.reply?.text||(r.note||'Оставим этот комментарий для вас.');
 $('resultReason').textContent=({auto:'Подходит для автоответа. ',review:'Только с вашим подтверждением. ',skip:'Пропускаем. '}[r.action])+r.reason;
 if(r.reply)seen.push(r.reply.id);
}));
document.querySelectorAll('[data-example]').forEach(b=>b.addEventListener('click',()=>{$('example').value=b.dataset.example;$('try').click()}));
$('resetExamples').addEventListener('click',()=>{seen=[];notify('История примеров сброшена. История Instagram не менялась.')});
$('saveBank').addEventListener('click',()=>action(async()=>{await request('/api/bank',{responses:bankDraft.categories.flatMap(c=>c.responses)});await load(true);notify('100 ответов сохранены.')}));
$('connect').addEventListener('click',()=>action(async()=>{
 $('connect').disabled=true;
 try{await request('/api/connect',{token:$('token').value,longLived:$('longLived').checked});$('token').value='';await load(true);notify('Instagram подключён. Публикация выключена: работает предпросмотр.')}
 finally{$('connect').disabled=false}
}));
$('saveSettings').addEventListener('click',()=>action(async()=>{
 const cfg={};
 for(const k of ['mode','pollSeconds','maxMedia','maxRepliesHour','maxRepliesDay','minRepeatHours','allowMediaIds'])cfg[k]=$(k).value;
 cfg.enabledCategories=[...$('enabledCategories').querySelectorAll('input:checked')].map(x=>x.value);
 if(cfg.mode==='live'&&state.config.mode!=='live'){
  if(!confirm('Включить автоматические публичные ответы на НОВЫЕ комментарии @eserv.kz?'))return;
  cfg.confirmLive=true;
 }
 await request('/api/config',cfg);await load(true);notify('Настройки сохранены.');
}));
$('poll').addEventListener('click',()=>action(()=>startArchive()));
$('forget').addEventListener('click',()=>action(async()=>{
 if(!confirm('Удалить сохранённые тексты и сведения указанного автора?'))return;
 const r=await request('/api/forget',{username:$('forgetUsername').value});notify('Удалены данные из записей: '+r.deleted);await load();
}));

function renderWebhook(initial){
 const w=state.webhook;
 $('webhookSecretStatus').textContent=w.secretPresent?'Секрет сохранён и защищён Windows.':'Секрет пока не сохранён.';
 $('verifyToken').value=w.verifyToken;
 if(initial||!$('callbackUrl').value)$('callbackUrl').value=w.callbackUrl;
 const pc=w.permanent;
 $('permanentStatus').textContent=pc.servicePaused||pc.tunnelPaused?'Постоянное подключение на паузе. START.cmd возобновит работу.':({connected:'Cloudflare подключён. Следующий шаг — подтверждение URL в Meta.',connecting:'Подключаемся к Cloudflare…',reconnecting:'Восстанавливаем соединение с Cloudflare…',error:'Не удалось подключиться. Проверьте токен туннеля и интернет.',stopped:'Туннель остановлен. Автозапуск проверяет его раз в минуту.'}[pc.state]??'Постоянный туннель ожидает домен и подключение Cloudflare.');
 $('webhookStatus').textContent=(state.config.transport==='webhook'?'Сейчас: Webhooks. Опрос Instagram выключен. ':'Сейчас: проверка по времени. ')+
  'Подтверждение URL: '+date(w.verifiedAt)+'. Подписка через API: '+date(w.subscribedAt)+'. Последний подписанный запрос: '+date(w.lastDelivery)+'. Комментарий аккаунта: '+date(w.lastComment)+'. '+
  w.inbox.map(x=>({pending:'Ожидают обработки',done:'Обработаны',error:'Ошибки чтения',ignored:'Пропущены'}[x.status]??x.status)+': '+x.count).join(' · ');
 $('subscribeWebhook').disabled=!state.config.connected||!w.secretPresent||!w.verifiedAt||state.busy;
 $('useWebhook').disabled=!w.secretPresent||!w.verifiedAt||!w.subscribedAt||state.config.transport==='webhook';
}
$('saveWebhook').addEventListener('click',()=>action(async()=>{
 await request('/api/webhook/config',{appSecret:$('appSecret').value,callbackUrl:$('callbackUrl').value});
 $('appSecret').value='';await load(true);notify('Настройки Webhook сохранены.');
}));
$('copyVerify').addEventListener('click',()=>action(async()=>{
 await navigator.clipboard.writeText($('verifyToken').value);notify('Маркер подтверждения скопирован.');
}));
$('subscribeWebhook').addEventListener('click',()=>action(async()=>{
 $('subscribeWebhook').disabled=true;
 try{await request('/api/webhook/subscribe',{});await load();notify('Meta подтвердила подключение comments.')}finally{renderWebhook(false)}
}));
for(const [id,transport] of [['useWebhook','webhook'],['usePolling','poll']]){
 $(id).addEventListener('click',()=>action(async()=>{
  await request('/api/webhook/transport',{transport});await load(true);notify('Способ получения изменён. Включён предпросмотр.');
 }));
}


$('savePermanent').addEventListener('click',()=>action(async()=>{
 await request('/api/cloudflare/config',{tunnelToken:$('tunnelToken').value,callbackUrl:$('callbackUrl').value});
 $('tunnelToken').value='';await load(true);notify('Постоянный туннель сохранён. Подключение начнётся в течение минуты.');
}));


let commentPage=1,commentPages=1,archiveRequest=0;

const replyDrafts=new Map();
function renderReplyComposer(c){
 const latest=c.manualAttempts?.[0];
 let d=replyDrafts.get(c.id);
 if(!d){d={text:latest?.status==='failed'?latest.text:'',requestId:null,pending:false,open:false,note:''};replyDrafts.set(c.id,d);}
 const attempt=c.manualAttempts?.find(x=>x.request_id===d.requestId);
 if(attempt?.status==='sent'){d.text='';d.requestId=null;d.open=false;d.note='Ответ опубликован.';}
 if(attempt?.status==='failed'&&!d.pending){d.requestId=null;d.note=attempt.reason;}
 const blocked=c.manualAttempts?.find(x=>['checking','sending','uncertain'].includes(x.status));
 const form=el('details',undefined,'reply-composer');form.dataset.commentId=c.id;form.open=d.open;
 const summary=el('summary',c.reply_state==='answered'?'Добавить свой ответ':'Написать ответ');form.append(summary);
 form.addEventListener('toggle',()=>{d.open=form.open;});
 if(blocked||['sending','uncertain'].includes(c.automation_status)){
  form.append(el('p',blocked?.reason||'Предыдущая отправка ещё не подтверждена. Проверьте ветку в Instagram.','small'));return form;
 }
 const label=el('label','Ваш ответ от @eserv.kz');const input=el('textarea');
 input.id='reply-'+c.id;label.htmlFor=input.id;input.rows=3;input.maxLength=2000;input.value=d.text;input.placeholder='Напишите ответ на этот комментарий…';
 const count=el('span',d.text.length+' / 2000','small');
 const status=el('p',d.note,'small');status.setAttribute('role','status');
 const send=el('button',d.pending?'Отправляем…':'Отправить в Instagram','primary');send.type='button';
 const update=()=>{count.textContent=input.value.length+' / 2000';send.disabled=d.pending||!input.value.trim()||!state.config.connected||state.config.mode==='paused';};
 input.addEventListener('input',()=>{if(input.value!==d.text)d.requestId=null;d.text=input.value;d.note='';status.textContent='';update();});
 input.disabled=d.pending;
 send.addEventListener('click',()=>action(async()=>{
  const text=input.value.trim();if(!text||d.pending)return;
  if(!confirm('Опубликовать ответ от @eserv.kz?\n\nКомментарий '+(c.username?'@'+c.username:'автора')+':\n'+c.text.slice(0,500)+'\n\nВаш ответ:\n'+text))return;
  d.text=text;d.requestId??=crypto.randomUUID();d.pending=true;input.disabled=true;send.textContent='Отправляем…';update();status.textContent='Проверяем комментарий и отправляем ваш текст…';
  try{
   const result=await request('/api/manual-reply',{id:c.id,text,requestId:d.requestId,confirm:true});
   d.note=result.message;
   if(result.status==='sent'){d.text='';d.requestId=null;d.open=false;notify('Ваш ответ опубликован в Instagram.');}
   else if(result.status==='failed'){d.requestId=null;notify(result.message,true);}
   else notify(result.message||'Проверяем результат отправки. Повторно нажимать не нужно.',true);
  }catch(e){
   // Keep the same request ID if the local HTTP response was lost.
   d.note=e.message;notify(e.message,true);
  }finally{
   d.pending=false;input.disabled=false;send.textContent='Отправить в Instagram';update();status.textContent=d.note;
   await load();
  }
 }));
 const actions=el('div',undefined,'actions');actions.append(send,count);
 form.append(label,input,actions,status,el('p','Публичный ответ под этим комментарием. Автоматические ответы от этого не включаются.','small'));
 if(state.config.mode==='paused')form.append(el('p','Сервис на паузе. Выберите «Предпросмотр» в настройках, чтобы отправить ответ вручную.','small'));
 update();return form;
}

const replyLabels={answered:'Уже ответили',unanswered:'Без нашего ответа',unknown:'Ещё не проверено',own:'Наш комментарий'};
function renderArchiveProgress(){
 const a=state.archive,active=['running','waiting'].includes(a.status);
 const stage={catalog:'Читаем список публикаций',comments:'Загружаем комментарии',replies:'Загружаем ответы в ветках',authors:'Проверяем авторов ответов'}[a.phase]??'Загружаем';
 const summary='Публикаций: '+a.mediaCount+'. Комментариев: '+a.commentCount+'. Ответов в ветках: '+a.replyCount+'.';
 const text=a.status==='idle'?'Нажмите «Загрузить все комментарии», чтобы увидеть старые записи.':a.status==='done'?'Загрузка завершена '+date(a.finishedAt)+'.':a.status==='waiting'?'Лимит или временная ошибка Instagram. Продолжим после '+date(a.nextAt)+'.':a.status==='paused'?'Загрузка приостановлена. Уже полученные комментарии сохранены.':a.status==='error'?'Загрузка остановилась: '+a.error:stage+'. Публикаций проверено: '+a.mediaDone+' из '+a.mediaTotal+'.';
 $('archiveProgress').textContent=text+' '+summary;
 $('loadArchive').textContent=active?'Идёт загрузка…':['paused','error'].includes(a.status)?'Продолжить загрузку':a.status==='done'?'Обновить все комментарии':'Загрузить все комментарии';
 $('loadArchive').disabled=active||a.busy||!state.config.connected;
 $('pauseArchive').classList.toggle('hidden',!active);
 $('refreshPublication').disabled=active||a.busy||!$('commentMedia').value||!state.config.connected;
 $('poll').disabled=active||a.busy||!state.config.connected;
 $('poll').textContent=active?'Идёт загрузка комментариев…':'Загрузить комментарии';
}
async function loadComments(){
 const requestId=++archiveRequest;
 const p=new URLSearchParams({mediaId:$('commentMedia').value,reply:$('replyFilter').value,q:$('commentSearch').value,sort:$('commentSort').value,page:String(commentPage)});
 const r=await request('/api/comments?'+p);
 if(requestId!==archiveRequest)return;
 commentPage=r.page;commentPages=r.pages;
 const selected=$('commentMedia').value;
 const mediaSignature=JSON.stringify(r.media.map(m=>[m.id,m.caption,m.loaded_comments]));
 if($('commentMedia').dataset.signature!==mediaSignature){
  $('commentMedia').replaceChildren(new Option('Все публикации',''),...r.media.map(m=>new Option((m.caption?.replace(/\s+/g,' ').slice(0,75)||m.permalink?.split('/').filter(Boolean).at(-1)||m.id)+' · '+m.loaded_comments,m.id)));
  $('commentMedia').value=selected;$('commentMedia').dataset.signature=mediaSignature;
 }
 $('archiveCounts').textContent='Найдено: '+r.total+'. '+r.counts.map(c=>replyLabels[c.reply_state]+': '+c.count).join(' · ');
 $('commentsPage').textContent='Страница '+r.page+' из '+r.pages;
 $('commentsPrev').disabled=r.page<=1;$('commentsNext').disabled=r.page>=r.pages;
 $('refreshPublication').disabled=['running','waiting'].includes(r.sync.status)||r.sync.busy||!selected;
 if(($('archiveList').contains(document.activeElement)&&document.activeElement.matches('.reply-composer textarea'))||[...replyDrafts.values()].some(d=>d.pending))return;
 if(!r.items.length){$('archiveList').replaceChildren(el('div',r.sync.commentCount?'По этим фильтрам комментариев нет.':'Комментарии появятся здесь во время загрузки.','panel empty'));return;}
 $('archiveList').replaceChildren(...r.items.map(c=>{
  const card=el('article',undefined,'panel comment'),top=el('div',undefined,'title-row');
  top.append(el('b',c.username?'@'+c.username:'Автор не указан'),el('span',replyLabels[c.reply_state],'badge reply-'+c.reply_state));card.append(top);
  card.append(el('p',c.text||'Без текста'),el('p',date(c.timestamp),'small'));
  const publication=el('p',undefined,'small publication-link');
  let valid=false;try{const u=new URL(c.permalink);valid=u.protocol==='https:'&&(u.hostname==='www.instagram.com'||u.hostname==='instagram.com');}catch{}
  const label=c.caption?.replace(/\s+/g,' ').slice(0,140)||'Публикация '+c.media_id;
  if(valid){const a=el('a',label+' ↗');a.href=c.permalink;a.target='_blank';a.rel='noreferrer';publication.append(a);}else publication.textContent=label;
  card.append(publication);
  for(const reply of c.replies.filter(x=>x.own)){card.append(el('div','↳ @eserv.kz: '+(reply.text||'Без текста'),'draft'));}
  if(!c.replies.some(x=>x.own)&&c.automation_status==='sent'&&c.response)card.append(el('div','↳ @eserv.kz: '+c.response,'draft'));
  const other=c.replies.filter(x=>!x.own);
  if(other.length){const detail=el('details',undefined,'thread-replies');detail.append(el('summary','Другие ответы в ветке · '+other.length));for(const reply of other)detail.append(el('p',(reply.username?'@'+reply.username:'Автор не указан')+': '+(reply.text||'Без текста'),'small'));card.append(detail);}
  if(c.reply_state==='unknown')card.append(el('p','Проверка ответов ещё не завершена или Instagram не вернул автора.','small'));
  if(!c.own)card.append(renderReplyComposer(c));
  return card;
 }));
}
for(const id of ['commentMedia','replyFilter','commentSort'])$(id).addEventListener('change',()=>{commentPage=1;action(loadComments);});
$('commentSearch').addEventListener('input',()=>{clearTimeout(loadComments.searchTimer);loadComments.searchTimer=setTimeout(()=>{commentPage=1;action(loadComments)},250);});
$('commentsPrev').addEventListener('click',()=>{commentPage=Math.max(1,commentPage-1);action(loadComments);});
$('commentsNext').addEventListener('click',()=>{commentPage=Math.min(commentPages,commentPage+1);action(loadComments);});
async function startArchive(mediaId=''){await request('/api/archive/start',{mediaId});show('history');await load();notify('Загружаем комментарии. Они будут появляться по мере получения.');}
$('loadArchive').addEventListener('click',()=>action(()=>startArchive()));
$('refreshPublication').addEventListener('click',()=>action(()=>startArchive($('commentMedia').value)));
$('pauseArchive').addEventListener('click',()=>action(async()=>{await request('/api/archive/pause',{});await load();}));

 action(()=>load(true));
setInterval(()=>load().catch(()=>{}),6000);
