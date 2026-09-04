import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from '../store.mjs';
import {Runner} from '../runner.mjs';
import {Instagram} from '../instagram.mjs';
import {Vault} from '../vault.mjs';
const bank=JSON.parse(readFileSync(new URL('../bank.json',import.meta.url),'utf8'));
const defaults=JSON.parse(readFileSync(new URL('../config.example.json',import.meta.url),'utf8'));
function fixture(){
 const store=new Store(':memory:'),cfg={...defaults,connected:true,mode:'live',since:new Date(Date.now()-60000).toISOString()},calls=[];
 const api={comments:async()=>({data:[]}),replies:async()=>({data:[]}),reply:async(id,text)=>{calls.push([id,text]);return{id:'reply1'}},media:async()=>[]};
 const runner=new Runner({store,bank:()=>bank,config:()=>cfg,api:()=>api});
 const c={id:'c1',media_id:'m1',author_id:'a1',username:'visitor',text:'😂',timestamp:new Date().toISOString(),category:'laugh',status:'queued'};
 store.add(c);return{store,cfg,api,runner,calls};
}
test('Один POST на комментарий, включая повторное действие',async()=>{
 const f=fixture();await f.runner.send('c1');assert.equal(f.calls.length,1);assert.equal(f.store.comment('c1').status,'sent');
 await assert.rejects(f.runner.send('c1'));assert.equal(f.calls.length,1);f.store.close();
});
test('Потерянное подтверждение не вызывает автоматический повтор',async()=>{
 const f=fixture();f.api.reply=async()=>{f.calls.push('post');throw Object.assign(Error('timeout'),{kind:'uncertain'})};
 await assert.rejects(f.runner.send('c1'));assert.equal(f.store.comment('c1').status,'uncertain');
 await assert.rejects(f.runner.send('c1'));assert.equal(f.calls.length,1);assert.equal(f.store.history().length,1);f.store.close();
});
test('Существующий ручной ответ, свой автор и неизвестный автор блокируют POST',async()=>{
 const f=fixture();f.api.replies=async()=>({data:[{id:'old',from:{id:f.cfg.accountId,username:'eserv.kz'}}]});
 await f.runner.send('c1');assert.equal(f.calls.length,0);assert.equal(f.store.comment('c1').status,'skipped');f.store.close();
 const g=fixture();g.store.db.prepare('UPDATE comments SET author_id=?').run(g.cfg.accountId);
 await assert.rejects(g.runner.send('c1'));assert.equal(g.calls.length,0);g.store.close();
});
test('Новая страница, старые записи, дубликаты и отсутствующий автор',async()=>{
 const f=fixture();let hits=0;
 f.api.comments=async(id,after)=>{hits++;return after?{data:[{id:'new2',text:'👍',timestamp:new Date().toISOString(),from:{id:'a2',username:'other'}}]}:{data:[{id:'new1',text:'😂',timestamp:new Date().toISOString(),from:{id:'a2',username:'other'}},{id:'missing',text:'😂',timestamp:new Date().toISOString()}],paging:{next:'ignored',cursors:{after:'cursor'}}}};
 await f.runner.scan(f.api,{id:'m2'},f.cfg);assert.equal(hits,2);
 assert.equal(f.store.comment('missing').status,'skipped');assert.ok(f.store.comment('new2'));
 await f.runner.scan(f.api,{id:'m2'},f.cfg);assert.equal(f.store.recent().length,4);
 f.api.comments=async()=>({data:[{id:'ancient',text:'😂',timestamp:'2020-01-01T00:00:00Z',from:{id:'a'}}]});
 await f.runner.scan(f.api,{id:'m3'},f.cfg);assert.equal(f.store.comment('ancient'),undefined);f.store.close();
});
test('Предпросмотр не выполняет публикацию',async()=>{
 const f=fixture();f.cfg.mode='preview';f.api.media=async()=>[{id:'m2'}];
 f.api.comments=async()=>({data:[{id:'new',text:'😂',timestamp:new Date().toISOString(),from:{id:'visitor'}}]});
 await f.runner.tick(true);assert.equal(f.calls.length,0);assert.equal(f.store.comment('new').status,'preview');f.store.close();
});
test('Пауза во время проверки ответов предотвращает POST',async()=>{
 const f=fixture();f.api.replies=async()=>{f.cfg.mode='paused';return{data:[]}};
 await f.runner.send('c1');assert.equal(f.calls.length,0);f.store.close();
});
test('Локальный предел учитывает каждый запрос, включая ошибочные',async()=>{
 const s=new Store(':memory:');let hits=0;
 const a=new Instagram({token:'fake',store:s,maxCalls:1,fetcher:async()=>{hits++;return new Response(JSON.stringify({data:[]}))}});
 await a.comments('123456789');await assert.rejects(a.comments('123456789'));assert.equal(hits,1);s.close();
});
test('Поддерживаются только API комментариев; 190 и лимиты обрабатываются',async()=>{
 const s=new Store(':memory:');
 const a=new Instagram({token:'fake',store:s,fetcher:async()=>new Response(JSON.stringify({error:{code:190,message:'SECRET'}}),{status:400})});
 await assert.rejects(a.identity(),e=>e.kind==='auth'&&!e.message.includes('SECRET'));
 await assert.rejects(a.request('me/messages'));
 const b=new Instagram({token:'fake',store:s,fetcher:async()=>new Response(JSON.stringify({error:{code:4}}),{status:400})});
 await assert.rejects(b.identity());assert.ok(s.get('cooldown')>Date.now());s.close();
});
test('Восстановление после остановки сохраняет защиту от повторов',()=>{
 const dir=mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)),'state-')),p=path.join(dir,'db.sqlite');
 let s=new Store(p);s.add({id:'c',media_id:'m',author_id:'a',text:'😂',timestamp:new Date().toISOString(),category:'laugh',status:'sending'});
 s.close();s=new Store(p);assert.equal(s.comment('c').status,'uncertain');s.close();rmSync(dir,{recursive:true,force:true});
});
test('Windows DPAPI шифрует маркер и восстанавливает его без открытого хранения',()=>{
 const dir=mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)),'vault-')),p=path.join(dir,'secret.dpapi'),v=new Vault(p);
 v.write('test-token-not-a-real-credential');assert.ok(!readFileSync(p,'utf8').includes('test-token'));assert.equal(v.read(),'test-token-not-a-real-credential');
 rmSync(dir,{recursive:true,force:true});
});
