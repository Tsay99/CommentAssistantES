import http from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync,mkdirSync,renameSync,unlinkSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {Store} from './store.mjs';
import {Vault} from './vault.mjs';
import {validatePermanentSettings} from './cloudflare-settings.mjs';
import {Instagram} from './instagram.mjs';
import {Runner} from './runner.mjs';
import {Archive} from './archive.mjs';
import {ManualReplies} from './manual-replies.mjs';
import {createWebhookServer,WEBHOOK_PATH} from './webhook.mjs';
import {classify,pickResponse,validateBank} from './engine.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const data=process.env.CA_DATA_DIR?path.resolve(process.env.CA_DATA_DIR):path.join(root,'data');mkdirSync(data,{recursive:true});
const port=Number(process.env.PORT||8787);
const host='127.0.0.1:'+port, origin='http://'+host;
const defaults=JSON.parse(readFileSync(path.join(root,'config.example.json'),'utf8'));
const bankPath=path.join(root,'bank.json');
let bank=JSON.parse(readFileSync(bankPath,'utf8'));validateBank(bank);
const store=new Store(path.join(data,'history.sqlite'));
const vault=new Vault(path.join(data,'instagram.dpapi'));
let token='';
try{token=vault.read()}catch{store.event('Маркер недоступен текущему пользователю Windows. Подключите аккаунт заново.','error')}
let config={...defaults,...store.get('config',{})};
if(!token){config.connected=false;config.mode='preview'}
function saveCfg(){store.set('config',config)}
const csrf=randomBytes(32).toString('hex'),session=randomBytes(32).toString('hex');
function api(t=token){return new Instagram({token:t,store,maxCalls:config.maxApiCallsHour})}
let archive;
const runner=new Runner({store,config:()=>config,bank:()=>bank,api,observe:(c,m)=>archive?.observe(c,m),pollBlocked:()=>archive?.active(),onChange:update=>{
 if(update.pause){config.mode='paused';saveCfg()}
 if(update.refreshToken){vault.write(update.refreshToken);token=update.refreshToken;config.tokenExpiresAt=Date.now()+Number(update.expiresIn||0)*1000;saveCfg()}
}});


const cloudflareVault=new Vault(path.join(data,'cloudflare.dpapi'));
function permanentState(){
 let status={state:'needs-token'};
 try{status=JSON.parse(readFileSync(path.join(data,'permanent-status.json'),'utf8'))}catch{}
 if(status.at&&Date.now()-status.at>45000)status={...status,state:'stopped'};
 return {tokenPresent:cloudflareVault.has(),state:status.state,at:status.at??null,
  servicePaused:existsSync(path.join(data,'service-disabled')),tunnelPaused:existsSync(path.join(data,'permanent-disabled'))};
}

const webhookVault=new Vault(path.join(data,'webhook-secret.dpapi'));
let appSecret='';
try{appSecret=webhookVault.read()}catch{store.event('Секрет Webhook недоступен текущему пользователю Windows.','error')}
let verifyToken=store.get('webhookVerifyToken','');
if(!verifyToken){verifyToken=randomBytes(32).toString('hex');store.set('webhookVerifyToken',verifyToken)}
const webhookPort=Number(process.env.WEBHOOK_PORT??(port===8787?8788:0));
const webhookServer=createWebhookServer({store,config:()=>config,credentials:()=>({appSecret,verifyToken}),wake:()=>{if(config.transport==='webhook')void runner.tick(true).catch(()=>{})}});
function webhookState(){
 let temporaryUrl='';
 try{temporaryUrl=readFileSync(path.join(data,'webhook-url.txt'),'utf8').trim()}catch{}
 return {secretPresent:!!appSecret,verifyToken,permanent:permanentState(),callbackUrl:store.get('webhookCallback','')||temporaryUrl,temporaryUrl,port:webhookPort,
  verifiedAt:store.get('webhookVerifiedAt'),subscribedAt:store.get('webhookSubscribedAt'),lastDelivery:store.get('webhookLastDelivery'),lastComment:store.get('webhookLastComment'),
  inbox:store.db.prepare('SELECT status,count(*) count FROM webhook_inbox GROUP BY status').all()};
}

const publicConfig=()=>({...config,tokenPresent:!!token,tokenStorage:'Windows DPAPI'});
const send=(res,status,value,type='application/json; charset=utf-8')=>{
 res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
 res.end(type.startsWith('application/json')?JSON.stringify(value):value);
};
async function body(req){
 const chunks=[];let bytes=0;
 for await(const c of req){bytes+=c.length;if(bytes>300000)throw Error('Слишком большой запрос');chunks.push(c)}
 return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
}
function int(value,min,max){const n=Number(value);if(!Number.isInteger(n)||n<min||n>max)throw Error('Число должно быть от '+min+' до '+max);return n}
function validCsrf(value){return typeof value==='string'&&value.length===csrf.length&&timingSafeEqual(Buffer.from(value),Buffer.from(csrf))}
let connecting=false;
archive=new Archive({store,config:()=>config,api,isBusy:()=>runner.busy||runner.sending||connecting});
const manualReplies=new ManualReplies({store,archive,runner,api,config:()=>config});
const server=http.createServer(async(req,res)=>{
 try{
  if(req.headers.host!==host)return send(res,403,{error:'Откройте панель по адресу '+origin});
  const url=new URL(req.url,origin);
  if(req.method==='GET'&&url.pathname==='/api/health')return send(res,200,{ok:true,service:'Comment Assistant ES',version:'1.0.0'});
  if(req.method==='GET'&&url.pathname==='/'){
   res.setHeader('Set-Cookie','ca_session='+session+'; HttpOnly; SameSite=Strict; Path=/');
   return send(res,200,readFileSync(path.join(root,'public','index.html'),'utf8'),'text/html; charset=utf-8');
  }
  const staticTypes={'/app.js':'application/javascript; charset=utf-8','/style.css':'text/css; charset=utf-8'};
  if(req.method==='GET'&&staticTypes[url.pathname])return send(res,200,readFileSync(path.join(root,'public',url.pathname.slice(1)),'utf8'),staticTypes[url.pathname]);
  if(!(req.headers.cookie??'').split(';').map(s=>s.trim()).includes('ca_session='+session))return send(res,401,{error:'Обновите страницу панели'});
  if(req.headers['sec-fetch-site']==='cross-site')return send(res,403,{error:'Недопустимый источник запроса'});
  if(req.method==='GET'){
   if(url.pathname==='/api/state')return send(res,200,{csrf,config:publicConfig(),webhook:webhookState(),bank,archive:archive.state(),counts:store.counts(),comments:store.recent(),events:store.events(),busy:runner.busy,sending:runner.sending,calls:store.callCount(),lastSuccess:store.get('lastSuccess'),cooldown:store.get('cooldown'),catalogSize:store.get('media',[]).length});
   if(url.pathname==='/api/comments')return send(res,200,archive.query(Object.fromEntries(url.searchParams)));
   if(url.pathname==='/api/export'){
    res.setHeader('Content-Disposition','attachment; filename="responses-100.csv"');
    const esc=s=>'"'+String(s).replaceAll('"','""')+'"';
    const lines=[['ID','Категория','Примеры','Ответ','Включён'].map(esc).join(';'),...bank.categories.flatMap(c=>c.responses.map(r=>[r.id,c.label,[...c.emoji,...c.keywords].join(', '),r.text,r.enabled!==false?'да':'нет'].map(esc).join(';')))];
    return send(res,200,'\uFEFF'+lines.join('\r\n'),'text/csv; charset=utf-8');
   }
   return send(res,404,{error:'Не найдено'});
  }
  if(req.method!=='POST')return send(res,405,{error:'Метод не поддерживается'});
  if(req.headers.origin!==origin||!validCsrf(req.headers['x-csrf-token']))return send(res,403,{error:'Обновите страницу и повторите действие'});
  const p=await body(req);
  if(url.pathname==='/api/manual-reply')return send(res,200,await manualReplies.send(p));
  if(url.pathname==='/api/archive/start'){const result=archive.start(String(p.mediaId??''));void archive.tick();return send(res,200,result);}
  if(url.pathname==='/api/archive/pause')return send(res,200,archive.pause());


  if(url.pathname==='/api/cloudflare/config'){
   const current=validatePermanentSettings({token:p.tunnelToken,callbackUrl:p.callbackUrl});
   cloudflareVault.write(current.token);
   if(current.callbackUrl!==store.get('webhookCallback',''))store.set('webhookVerifiedAt',0);
   store.set('webhookCallback',current.callbackUrl);
   const flag=path.join(data,'permanent-disabled');
   if(existsSync(flag))unlinkSync(flag);
   store.event('Постоянный туннель сохранён. Автозапуск подключит его в течение минуты.');
   return send(res,200,{ok:true});
  }

  if(url.pathname==='/api/webhook/config'){
   if(runner.busy||runner.sending||connecting)throw Error('Дождитесь завершения текущей операции');
   const secret=String(p.appSecret??'').trim();
   if(secret){
    if(!/^[a-f0-9]{32}$/i.test(secret))throw Error('Секрет приложения Meta — 32 шестнадцатеричных символа. Проверьте поле App Secret.');
    webhookVault.write(secret);appSecret=secret;
   }
   const callback=String(p.callbackUrl??'').trim();
   if(callback){
    let u;try{u=new URL(callback)}catch{throw Error('Укажите полный HTTPS-адрес Webhook')}
    if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!==WEBHOOK_PATH)throw Error('Нужен HTTPS-адрес, заканчивающийся на '+WEBHOOK_PATH);
    if(callback!==store.get('webhookCallback',''))store.set('webhookVerifiedAt',0);
    store.set('webhookCallback',callback);
   }
   store.event('Настройки Webhook сохранены.');return send(res,200,{ok:true});
  }
  if(url.pathname==='/api/webhook/subscribe'){
   if(!config.connected)throw Error('Сначала подключите Instagram в настройках');
   if(!appSecret||!store.get('webhookVerifiedAt'))throw Error('Сначала сохраните секрет приложения и подтвердите URL в Meta');
   if(runner.busy||runner.sending||connecting)throw Error('Дождитесь завершения текущей операции');
   connecting=true;
   try{
    const result=await api().subscribe(config.accountId);
    if(result.success!==true)throw Error('Meta не подтвердила подписку');
    store.set('webhookSubscribedAt',Date.now());store.event('Meta подтвердила подписку аккаунта на comments.');
    return send(res,200,{ok:true});
   }finally{connecting=false}
  }
  if(url.pathname==='/api/webhook/transport'){
   if(runner.busy||runner.sending||connecting)throw Error('Дождитесь завершения текущей операции');
   if(!['poll','webhook'].includes(p.transport))throw Error('Неизвестный способ получения комментариев');
   if(p.transport==='webhook'&&(!appSecret||!store.get('webhookVerifiedAt')||!store.get('webhookSubscribedAt')))throw Error('Завершите сохранение секрета, подтверждение URL и подписку comments');
   if(config.transport!==p.transport){
    config.transport=p.transport;config.mode='preview';config.since=new Date().toISOString();saveCfg();
    store.db.prepare("UPDATE comments SET status='review',reason='Способ подключения изменён. Нужен просмотр.' WHERE status IN ('queued','preview')").run();
    store.event(p.transport==='webhook'?'Webhooks включены. Опрос Instagram выключен, работает предпросмотр.':'Проверка по времени включена, работает предпросмотр.');
   }
   return send(res,200,{ok:true});
  }

  if(url.pathname==='/api/preview'){
   const decision=classify(String(p.text??'').slice(0,2000),bank,{caption:String(p.caption??'').slice(0,2000)});
   const excluded=Array.isArray(p.used)?p.used.slice(0,100):[];
   const history=excluded.map(response_id=>({response_id,used_at:Date.now(),media_id:'demo',author_id:'demo'}));
   const result=decision.category?pickResponse(decision.category,bank,history,{...config,mediaId:'demo',authorId:'demo'}):null;
   return send(res,200,{...decision,reply:result,categoryLabel:bank.categories.find(c=>c.id===decision.category)?.label??'',note:!result&&decision.category?'Все варианты уже показаны. Нажмите «Сбросить примеры».':''});
  }
  if(url.pathname==='/api/connect'){
   if(connecting||runner.busy||runner.sending)throw Error('Дождитесь завершения текущей операции');
   connecting=true;
   try{
    const candidate=String(p.token??'').trim();
    if(candidate.length<20||candidate.length>4096||/\s/.test(candidate))throw Error('Проверьте маркер доступа');
    const identity=await api(candidate).identity();
    if(String(identity.user_id)!==defaults.accountId||identity.username?.toLowerCase()!==defaults.username)throw Error('Маркер должен принадлежать аккаунту eserv.kz');
    vault.write(candidate);token=candidate;
    config={...config,connected:true,username:identity.username,scopedId:String(identity.id??''),accountId:String(identity.user_id),mode:'preview',since:config.since??new Date().toISOString(),longLived:p.longLived===true,tokenExpiresAt:null};
    saveCfg();store.set('tokenCheckedAt',Date.now());store.set('mediaAt',0);
    store.event('Аккаунт eserv.kz подключён. Включён предпросмотр.');
    return send(res,200,{ok:true});
   }finally{connecting=false}
  }
  if(url.pathname==='/api/config'){
   if(p.mode==='paused' && (runner.busy||runner.sending)){
    config.mode='paused';saveCfg();
    store.db.prepare("UPDATE comments SET status='review',reason='Автоматическая отправка выключена' WHERE status='queued'").run();
    store.event('Пауза включена. Уже отправленный запрос Meta может завершиться.');
    return send(res,200,{ok:true});
   }
   if(runner.busy||runner.sending||connecting)throw Error('Дождитесь завершения проверки комментариев');
   const mode=p.mode??config.mode;
   if(!['preview','live','paused'].includes(mode))throw Error('Неизвестный режим');
   if(mode==='live'&&!token)throw Error('Сначала подключите Instagram');
   if(mode==='live'&&config.mode!=='live'&&p.confirmLive!==true)throw Error('Подтвердите включение публичных ответов');
   const ids=String(p.allowMediaIds??config.allowMediaIds.join(',')).split(/[\s,]+/).filter(Boolean);
   if(ids.some(x=>!/^\d{10,25}$/.test(x)))throw Error('Укажите числовые ID публикаций через запятую');
   const categories=Array.isArray(p.enabledCategories)?p.enabledCategories:config.enabledCategories;
   if(categories.some(id=>!bank.categories.some(c=>c.id===id&&!c.review)))throw Error('Недопустимая категория для автоответов');
   if(mode==='live'&&config.mode!=='live'){
    config.since=new Date().toISOString();
    store.db.prepare("UPDATE comments SET status='review',reason='Комментарий получен до включения автоответов' WHERE status IN ('queued','preview')").run();
   }
   if(mode!=='live')store.db.prepare("UPDATE comments SET status='review',reason='Автоматическая отправка выключена' WHERE status='queued'").run();
   config={...config,mode,pollSeconds:int(p.pollSeconds??config.pollSeconds,60,3600),maxMedia:int(p.maxMedia??config.maxMedia,1,200),maxRepliesHour:int(p.maxRepliesHour??config.maxRepliesHour,1,30),maxRepliesDay:int(p.maxRepliesDay??config.maxRepliesDay,1,200),minRepeatHours:int(p.minRepeatHours??config.minRepeatHours,1,720),allowMediaIds:ids,enabledCategories:categories};
   saveCfg();store.set('mediaAt',0);store.event('Настройки сохранены. Режим: '+mode);
   return send(res,200,{ok:true});
  }
  if(url.pathname==='/api/bank'){
   const changes=p.responses;
   if(!Array.isArray(changes)||changes.length!==100)throw Error('Ожидается 100 ответов');
   const next=structuredClone(bank);
   for(const c of next.categories)for(const r of c.responses){
    const v=changes.find(x=>x.id===r.id);
    if(!v)throw Error('Не найден ответ '+r.id);
    r.text=String(v.text??'').trim();r.enabled=v.enabled!==false;
   }
   validateBank(next);
   writeFileSync(bankPath+'.tmp',JSON.stringify(next,null,2));renameSync(bankPath+'.tmp',bankPath);bank=next;
   store.event('База ответов обновлена');return send(res,200,{ok:true});
  }
  if(url.pathname==='/api/poll'){
   if(!config.connected)throw Error('Сначала подключите Instagram');
   if(config.transport==='webhook')throw Error('Опрос выключен: комментарии приходят через Webhooks');
   if(runner.busy)return send(res,200,{ok:true,busy:true});
   void runner.tick(true).catch(()=>{});
   return send(res,200,{ok:true});
  }
  if(url.pathname==='/api/send'){
   if(p.confirm!==true)throw Error('Подтвердите публикацию ответа');
   await runner.send(String(p.id),true);return send(res,200,{ok:true});
  }
  if(url.pathname==='/api/skip'){
   const c=store.comment(String(p.id));
   if(!c||!['review','preview','queued'].includes(c.status))throw Error('Эта запись уже обработана');
   store.change(c.id,{status:'skipped',reason:'Пропущено владельцем'});return send(res,200,{ok:true});
  }
  if(url.pathname==='/api/forget'){
   if(config.mode!=='paused'||runner.busy||runner.sending)throw Error('Сначала включите паузу и дождитесь завершения операции');
   const username=String(p.username??'').replace(/^@/,'').toLowerCase().trim();
   if(!username)throw Error('Укажите имя пользователя');
   if(archive.busy||archive.active())throw Error('Сначала остановите загрузку архива');
   manualReplies.forget(username);
   const archiveDeleted=archive.forget(username);
   const records=store.db.prepare('SELECT id,author_id FROM comments WHERE lower(username)=?').all(username);
   for(const r of records){
    store.db.prepare('DELETE FROM usage WHERE comment_id=?').run(r.id);
    // ID комментария остаётся как техническая отметка от повтора; текст и автор удаляются.
    store.db.prepare("UPDATE comments SET username='',author_id='',text='',response='',response_id='',status='skipped',reason='Данные удалены по запросу' WHERE id=?").run(r.id);
   }
   return send(res,200,{ok:true,deleted:records.length+archiveDeleted});
  }
  return send(res,404,{error:'Не найдено'});
 }catch(e){return send(res,400,{error:e.message})}
});
webhookServer.listen(webhookPort,'127.0.0.1');
webhookServer.on('error',()=>{console.error('Не удалось открыть порт Webhook');process.exit(1)});
server.listen(port,'127.0.0.1',()=>{console.log('Comment Assistant ES: '+origin);runner.start();archive.startTimer()});
server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'Порт уже занят. Возможно, сервер запущен.':'Не удалось запустить сервер');process.exit(1)});
function stop(){archive.stop();runner.stop();webhookServer.close();server.close(()=>{store.close();process.exit(0)});setTimeout(()=>process.exit(0),5000).unref()}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
