import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {Store} from '../store.mjs';
import {Archive} from '../archive.mjs';
import {Runner} from '../runner.mjs';
import {Instagram} from '../instagram.mjs';
import {ManualReplies} from '../manual-replies.mjs';
const C='18350137990218356',M='17872952679535079',R='18020612384876043',T='request-000000000001';
function fixture(db=':memory:'){
 const store=new Store(db),cfg={...JSON.parse(readFileSync(new URL('../config.example.json',import.meta.url))),connected:true,mode:'preview'},posts=[];
 const api={comment:async id=>({id,media:{id:M},from:{id:'99',username:'visitor'},text:'😂',timestamp:'2020-01-01T00:00:00Z'}),reply:async(id,text)=>{posts.push({id,text});return{id:R}}};
 const archive=new Archive({store,config:()=>cfg,api:()=>api});
 archive.media({id:M,caption:'Пост'});archive.record({id:C,text:'😂',timestamp:'2020-01-01T00:00:00Z',from:{id:'99',username:'visitor'}},M);
 const runner=new Runner({store,config:()=>cfg,bank:()=>({categories:[]}),api:()=>api,onChange:()=>{cfg.mode='paused'}});
 const manual=new ManualReplies({store,archive,runner,api:()=>api,config:()=>cfg});
 return {store,cfg,api,archive,runner,manual,posts};
}
const payload=(extra={})=>({id:C,text:'Спасибо! Рады вашей реакции 😊',requestId:T,confirm:true,...extra});
test('Свой текст публикуется под старым комментарием в предпросмотре и сразу виден как ответ',async()=>{
 const f=fixture();const r=await f.manual.send(payload());
 assert.equal(r.status,'sent');assert.deepEqual(f.posts,[{id:C,text:payload().text}]);assert.equal(f.cfg.mode,'preview');
 assert.equal(f.archive.query({reply:'answered'}).total,1);assert.equal(f.archive.query().items[0].replies[0].text,payload().text);assert.equal(f.store.comment(C).status,'sent');assert.equal(f.store.queue().length,0);assert.equal(f.store.sentSince(3600000),1);f.store.close();
});
test('Повтор запроса после потери HTTP-ответа и тот же текст с новым ID не дублируют публикацию',async()=>{
 const f=fixture();const a=await f.manual.send(payload());const b=await f.manual.send(payload());const c=await f.manual.send(payload({requestId:'request-000000000002'}));
 assert.equal(a.replyId,b.replyId);assert.equal(b.replyId,c.replyId);assert.equal(f.posts.length,1);
 await assert.rejects(f.manual.send(payload({text:'Подменённый текст'})));f.store.close();
});
test('Неопределённый POST блокирует новый запрос для того же комментария и автоответ',async()=>{
 const f=fixture();f.api.reply=async()=>{f.posts.push('post');throw Object.assign(Error('timeout'),{kind:'uncertain'})};
 const r=await f.manual.send(payload());assert.equal(r.status,'uncertain');assert.equal((await f.manual.send(payload())).status,'uncertain');
 await assert.rejects(f.manual.send(payload({requestId:'request-000000000003'})));assert.equal(f.posts.length,1);
 await assert.rejects(f.runner.send(C,true));assert.equal(f.store.comment(C).status,'uncertain');f.store.close();
});
test('Отказ Instagram сохраняет текст и допускает отдельную ручную попытку позже',async()=>{
 const f=fixture();f.api.reply=async()=>{throw Object.assign(Error('Ошибка Instagram: 100'),{kind:'api'})};
 const r=await f.manual.send(payload());assert.equal(r.status,'failed');assert.equal(f.manual.attempt(T).text,payload().text);assert.equal(f.runner.sending,false);f.store.close();
});
test('Проверки подтверждения, текста, неизвестного комментария, собственного автора и паузы выполняются до POST',async()=>{
 const f=fixture();
 for(const p of [payload({confirm:false}),payload({text:'  '}),payload({text:'a'.repeat(2001)}),payload({id:'999999999999'}),payload({requestId:'bad'})])await assert.rejects(f.manual.send(p));
 f.cfg.mode='paused';await assert.rejects(f.manual.send(payload()));f.cfg.mode='preview';
 f.store.db.prepare('UPDATE library_comments SET own=1').run();await assert.rejects(f.manual.send(payload()));assert.equal(f.posts.length,0);f.store.close();
});
test('Чужая публикация и пауза во время чтения предотвращают POST',async()=>{
 const f=fixture();f.api.comment=async()=>({id:C,media:{id:'99999999999'},from:{id:'99'}});
 assert.equal((await f.manual.send(payload())).status,'failed');assert.equal(f.posts.length,0);
 f.api.comment=async()=>{f.cfg.mode='paused';return{id:C,media:{id:M},from:{id:'99'}}};
 assert.equal((await f.manual.send(payload({requestId:'request-000000000004'}))).status,'failed');assert.equal(f.posts.length,0);f.store.close();
});
test('Общий замок отправки предотвращает одновременный ручной и автоматический POST',async()=>{
 const f=fixture();let resolve;f.api.comment=()=>new Promise(r=>resolve=r);const first=f.manual.send(payload());
 assert.equal(f.runner.sending,true);await assert.rejects(f.manual.send(payload({requestId:'request-000000000005'})));await assert.rejects(f.runner.send(C,true));
 resolve({id:C,media:{id:M},from:{id:'99'}});await first;assert.equal(f.posts.length,1);assert.equal(f.runner.sending,false);f.store.close();
});
test('После перезапуска отправка с неизвестным исходом не повторяется',()=>{
 const testRoot=path.dirname(fileURLToPath(import.meta.url)),dir=mkdtempSync(path.join(testRoot,'manual-'));
 let store;
 try{
  store=new Store(path.join(dir,'history.sqlite'));store.db.prepare("INSERT INTO manual_replies(request_id,comment_id,media_id,text,status,created_at,updated_at) VALUES(?,?,?,?,'sending',?,?)").run(T,C,M,'Текст',Date.now(),Date.now());store.close();
  store=new Store(path.join(dir,'history.sqlite'));assert.equal(store.db.prepare('SELECT status FROM manual_replies').get().status,'uncertain');
 }finally{store?.close();const safe=realpathSync(dir);if(!safe.startsWith(realpathSync(testRoot)+path.sep))throw Error('Unsafe temp path');rmSync(safe,{recursive:true,force:true});}
});
test('HTTP запрос Instagram получает точный текст в message и правильный комментарий',async()=>{
 const f=fixture();let got;
 const api=new Instagram({store:f.store,token:'test-token',fetcher:async(url,opts)=>{got={url:String(url),method:opts.method,body:opts.body};return new Response(JSON.stringify({id:R}))}});
 await api.reply(C,'Добрый день!\nСпасибо 💚 & +');assert.equal(got.method,'POST');assert.ok(got.url.endsWith('/'+C+'/replies'));
 assert.equal(new URLSearchParams(got.body).get('message'),'Добрый день!\nСпасибо 💚 & +');f.store.close();
});

