import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../store.mjs';
import {Archive} from '../archive.mjs';
import {Runner} from '../runner.mjs';
import {readFileSync} from 'node:fs';
const owner={id:'17841450147778141',username:'eserv.kz'},visitor={id:'99',username:'visitor'},old='2020-01-01T00:00:00Z';
const M='17872952679535079',M2='18203706148364924';
function fixture(){
 const store=new Store(':memory:'),config={accountId:owner.id,username:owner.username,connected:true};
 const api={mediaPage:async()=>({data:[{id:M,caption:'Пост',timestamp:old}]}),archiveComments:async()=>({data:[]}),replies:async()=>({data:[]}),comment:async id=>({id,from:visitor,text:'Ответ',timestamp:old})};
 const archive=new Archive({store,config:()=>config,api:()=>api});
 return {store,config,api,archive};
}
async function complete(a,max=30){for(let i=0;i<max&&a.active();i++)await a.tick();assert.equal(a.state().status,'done',a.state().error);}
test('Все страницы публикаций, старых комментариев и веток; загрузка не создаёт очередь отправки',async()=>{
 const f=fixture(),hits=[];
 f.api.mediaPage=async(id,after)=>{hits.push('media:'+after);return after?{data:[{id:M2,timestamp:old}]}:{data:[{id:M,timestamp:old}],paging:{next:'ignore',cursors:{after:'m2'}}}};
 f.api.archiveComments=async(id,after)=>{hits.push(id+':'+after);if(id===M2)return{data:[]};return after?{data:[{id:'c2',text:'👍',timestamp:old,from:visitor}]}:{data:[{id:'c1',text:'😂',timestamp:old,from:visitor,replies:{data:[{id:'r1',text:'Другой ответ'}],paging:{next:'ignore',cursors:{after:'r2'}}}}],paging:{next:'ignore',cursors:{after:'c2'}}}};
 f.api.replies=async(id,after)=>{assert.equal(after,'r2');return{data:[{id:'r2',text:'Наш ответ',from:owner}]}};
 f.archive.start();await complete(f.archive);
 assert.equal(f.archive.state().mediaCount,2);assert.equal(f.archive.state().commentCount,2);assert.equal(f.archive.state().replyCount,2);
 assert.equal(f.archive.query({reply:'answered'}).items[0].id,'c1');assert.equal(f.archive.query({reply:'unanswered'}).items[0].id,'c2');
 assert.deepEqual(f.store.queue(),[]);assert.equal(f.store.recent().length,0);assert.ok(hits.includes(M+':c2'));f.store.close();
});
test('Ответ из общей выдачи связывается с родителем и подтверждает ручной ответ eserv.kz',async()=>{
 const f=fixture();f.api.archiveComments=async()=>({data:[{id:'r',parent_id:'c',text:'Спасибо',from:owner,timestamp:old},{id:'c',text:'😂',from:visitor,timestamp:old,replies:{data:[{id:'r',text:'Спасибо'}]}},{id:'other',text:'Привет',from:visitor,timestamp:old,replies:{data:[{id:'external',text:'Тоже привет',from:visitor}]}}]});
 f.archive.start();await complete(f.archive);const r=f.archive.query();assert.equal(r.total,2);assert.equal(r.items.find(x=>x.id==='c').reply_state,'answered');assert.equal(r.items.find(x=>x.id==='other').reply_state,'unanswered');assert.equal(r.items.find(x=>x.id==='c').replies[0].own,1);f.store.close();
});
test('Неизвестного автора ответа нельзя считать отсутствием нашего ответа',async()=>{
 const f=fixture();f.api.archiveComments=async()=>({data:[{id:'c',text:'😂',from:visitor,timestamp:old,replies:{data:[{id:'r',text:'Ответ'}]}}]});f.api.comment=async id=>({id,text:'Ответ'});
 f.archive.start();await complete(f.archive);assert.equal(f.archive.query({reply:'unknown'}).total,1);assert.equal(f.archive.query({reply:'unanswered'}).total,0);f.store.close();
});
test('Лимит запросов сохраняет страницу и продолжение; пауза переживает выполняющийся запрос',async()=>{
 const f=fixture();let first=true;
 f.api.mediaPage=async()=>{if(first){first=false;throw Object.assign(Error('limit'),{kind:'local_rate'})}return{data:[{id:M}]}};
 f.archive.start();await f.archive.tick();assert.equal(f.archive.state().status,'waiting');
 f.store.set('archiveJob',{...f.store.get('archiveJob'),nextAt:0});await f.archive.tick();
 let release;f.api.archiveComments=()=>new Promise(r=>release=r);const pending=f.archive.tick();f.archive.pause();release({data:[{id:'c',timestamp:old,text:'😂',from:visitor}]});await pending;
 assert.equal(f.archive.state().status,'paused');assert.equal(f.archive.query().total,1);f.archive.start();await complete(f.archive);f.store.close();
});
test('Фильтры, страницы по 50 и сортировка не ограничены последними 150 записями',()=>{
 const f=fixture();f.archive.media({id:M,caption:'A',timestamp:'2020'});f.archive.media({id:M2,caption:'B',timestamp:'2021'});
 for(let i=0;i<155;i++){f.archive.record({id:String(1000+i),text:'Comment '+i,from:{id:'99',username:i===100?'target':'visitor'},timestamp:new Date(i*1000).toISOString()},i<100?M:M2);f.store.db.prepare('UPDATE library_comments SET replies_complete=1 WHERE id=?').run(String(1000+i));}
 assert.equal(f.archive.query().pages,4);assert.equal(f.archive.query({page:4}).items.length,5);
 assert.equal(f.archive.query({mediaId:M2}).total,55);assert.equal(f.archive.query({q:'target'}).total,1);assert.equal(f.archive.query({sort:'oldest'}).items[0].id,'1000');
 assert.equal(f.archive.query({sort:'publication'}).items[0].media_id,M2);assert.throws(()=>f.archive.query({reply:"' OR 1=1"}));f.store.close();
});
test('Повторная загрузка убирает удалённые ответы, а забытые данные не возвращаются',async()=>{
 const f=fixture();f.api.archiveComments=async()=>({data:[{id:'c',text:'Привет',from:visitor,timestamp:old},{id:'r',parent_id:'c',text:'Спасибо',from:owner,timestamp:old}]});
 f.archive.start();await complete(f.archive);assert.equal(f.archive.query({reply:'answered'}).total,1);
 f.store.db.prepare('UPDATE library_comments SET checked_at=1').run();
 f.api.archiveComments=async()=>({data:[{id:'c',text:'Привет',from:visitor,timestamp:old}]});f.archive.start(M);await complete(f.archive);assert.equal(f.archive.query({reply:'unanswered'}).total,1);
 f.archive.forget('visitor');f.archive.start(M);await complete(f.archive);assert.equal(f.archive.query().total,0);f.store.close();
});
test('Ответы в ветке и архив не превращаются в новые автоответы',async()=>{
 const f=fixture();const bank=JSON.parse(readFileSync(new URL('../bank.json',import.meta.url)));const cfg={...JSON.parse(readFileSync(new URL('../config.example.json',import.meta.url))),connected:true,mode:'live',since:new Date().toISOString()};
 const r=new Runner({store:f.store,config:()=>cfg,bank:()=>bank,api:()=>f.api,observe:(c,m)=>f.archive.observe(c,m)});
 f.api.comments=async()=>({data:[{id:'reply',parent_id:'root',text:'😂',timestamp:new Date().toISOString(),from:visitor},{id:'historic',text:'😂',timestamp:old,from:visitor}]});
 await r.scan(f.api,{id:M},cfg);assert.equal(f.store.recent().length,0);assert.equal(f.archive.query().total,1);f.store.close();
});
test('Перезапуск продолжает импорт по сохранённому курсору',async()=>{
 const f=fixture();f.api.mediaPage=async(id,after)=>after?{data:[{id:M2}]}:{data:[{id:M}],paging:{next:'ignore',cursors:{after:'next'}}};
 f.archive.start();await f.archive.tick();const resumed=new Archive({store:f.store,config:()=>f.config,api:()=>f.api});await complete(resumed);assert.equal(resumed.state().mediaCount,2);f.store.close();
});


test('Пауза при загрузке каталога сохраняется, поиск понимает регистр кириллицы',async()=>{
 const f=fixture();let resolve;f.api.mediaPage=()=>new Promise(r=>resolve=r);f.archive.start();const pending=f.archive.tick();f.archive.pause();resolve({data:[{id:M}]});await pending;assert.equal(f.archive.state().status,'paused');
 f.archive.record({id:'c',text:'ОТЛИЧНО',from:visitor,timestamp:old},M);assert.equal(f.archive.query({q:'отлично'}).total,1);f.store.close();
});
