
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {once} from 'node:events';
import {readFileSync,mkdtempSync,rmSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {Store} from '../store.mjs';
import {Runner} from '../runner.mjs';
import {Instagram} from '../instagram.mjs';
import {createWebhookServer,WEBHOOK_PATH} from '../webhook.mjs';
const bank=JSON.parse(readFileSync(new URL('../bank.json',import.meta.url),'utf8'));
const defaults=JSON.parse(readFileSync(new URL('../config.example.json',import.meta.url),'utf8'));
const accountId=defaults.accountId,commentId='18350137990218356',mediaId='17872952679535079';
const secret='a'.repeat(32),verifyToken='test-verification-token';
const value={id:commentId,text:'😂😂',from:{id:'123456789',username:'visitor'},media:{id:mediaId}};
const event=(v=value,field='comments',account=accountId)=>({object:'instagram',entry:[{id:account,changes:[{field,value:v}]}]});
function fixture(){
 const store=new Store(':memory:'),cfg={...defaults,connected:true,transport:'webhook',mode:'preview',since:new Date(Date.now()-60000).toISOString()},calls=[];
 const api={comment:async id=>{calls.push('comment');return{id,text:'😂',from:{id:'123456789',username:'visitor'},timestamp:new Date().toISOString(),media:{id:mediaId}}},
  mediaInfo:async()=>{calls.push('mediaInfo');return{id:mediaId,caption:'Рабочие будни'}},
  media:async()=>{throw Error('Periodic media poll forbidden')},comments:async()=>{throw Error('Periodic comments poll forbidden')},
  replies:async()=>({data:[]}),reply:async()=>{calls.push('POST');return{id:'987654321'}}};
 const runner=new Runner({store,config:()=>cfg,bank:()=>bank,api:()=>api});
 return {store,cfg,calls,api,runner};
}
async function withServer(fn){
 const f=fixture();let wakes=0;
 const server=createWebhookServer({store:f.store,config:()=>f.cfg,credentials:()=>({appSecret:secret,verifyToken}),wake:()=>wakes++});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const base='http://127.0.0.1:'+server.address().port;
 const post=(payload,signature)=>{
  const raw=typeof payload==='string'?payload:JSON.stringify(payload);
  return fetch(base+WEBHOOK_PATH,{method:'POST',headers:{'Content-Type':'application/json','X-Hub-Signature-256':signature??'sha256='+createHmac('sha256',secret).update(raw).digest('hex')},body:raw});
 };
 try{await fn({...f,post,base,wakes:()=>wakes})}finally{await new Promise(r=>server.close(r));f.store.close()}
}
test('Webhook verification, exact challenge, signed raw bytes and admin isolation',()=>withServer(async f=>{
 let r=await fetch(f.base+WEBHOOK_PATH+'?hub.mode=subscribe&hub.verify_token='+verifyToken+'&hub.challenge=0042');
 assert.equal(r.status,200);assert.equal(await r.text(),'0042');
 assert.ok(f.store.get('webhookVerifiedAt'));
 assert.equal((await fetch(f.base+WEBHOOK_PATH+'?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42')).status,403);
 for(const route of ['/','/api/state','/data/instagram.dpapi'])assert.equal((await fetch(f.base+route)).status,404);
 assert.equal((await f.post(event(),'sha256='+'0'.repeat(64))).status,403);
 assert.equal((await f.post(event(),'')).status,403);
 assert.equal((await f.post('{bad json')).status,400);
 assert.equal(f.store.inbox().length,0);
}));
test('Only comments for this account are durably stored; duplicated batch delivers once',()=>withServer(async f=>{
 const batch=event();batch.entry.push(...event(value,'messages').entry,...event(value,'comments','9999999').entry);
 let r=await f.post(batch);assert.equal(r.status,200);assert.equal(await r.text(),'EVENT_RECEIVED');
 assert.equal(f.store.inbox().length,1);
 await Promise.all([f.post(batch),f.post(batch)]);
 assert.equal(f.store.inbox().length,1);
 const row=f.store.inbox()[0];assert.equal(row.id,commentId);assert.equal(row.mode,'preview');assert.equal(row.text,undefined);
 assert.ok(f.store.get('webhookLastDelivery'));
}));
test('Flattened change payload supported; paused delivery is acknowledged and ignored',()=>withServer(async f=>{
 f.cfg.mode='paused';
 assert.equal((await f.post({object:'instagram',entry:[{id:accountId,field:'comments',value}]})).status,200);
 assert.equal(f.store.inbox().length,0);
 assert.equal(f.store.db.prepare('SELECT status FROM webhook_inbox').get().status,'ignored');
}));
test('No periodic Instagram requests in webhook mode; event reads only its comment',async()=>{
 const f=fixture();await f.runner.tick(true);await f.runner.tick(true);assert.deepEqual(f.calls,[]);
 f.store.db.prepare('INSERT INTO webhook_inbox(id,media_id,received_at,mode,status) VALUES(?,?,?,?,?)').run(commentId,mediaId,Date.now(),'preview','pending');
 await f.runner.tick(true);assert.deepEqual(f.calls,['comment','mediaInfo']);
 assert.equal(f.store.comment(commentId).status,'preview');
 assert.equal(f.store.inbox().length,0);
 await f.runner.tick(true);assert.deepEqual(f.calls,['comment','mediaInfo']);f.store.close();
});
test('Live webhook publishes once through existing duplicate protection',async()=>{
 const f=fixture();f.cfg.mode='live';
 f.store.db.prepare('INSERT INTO webhook_inbox(id,media_id,received_at,mode,status) VALUES(?,?,?,?,?)').run(commentId,mediaId,Date.now(),'live','pending');
 await f.runner.tick(true);await f.runner.tick(true);
 assert.equal(f.calls.filter(x=>x==='POST').length,1);assert.equal(f.store.comment(commentId).status,'sent');f.store.close();
});
test('Events received in preview never become automatic replies after mode switch',async()=>{
 const f=fixture();f.cfg.mode='live';
 f.store.db.prepare('INSERT INTO webhook_inbox(id,media_id,received_at,mode,status) VALUES(?,?,?,?,?)').run(commentId,mediaId,Date.now(),'preview','pending');
 await f.runner.tick(true);assert.equal(f.store.comment(commentId).status,'preview');assert.ok(!f.calls.includes('POST'));f.store.close();
});
test('Self comments, nested replies and old comments never trigger a reply',async()=>{
 for(const overrides of [{parent_id:'987654321'},{from:{id:accountId,username:'eserv.kz'}},{timestamp:'2020-01-01T00:00:00Z'}]){
  const f=fixture();f.cfg.mode='live';const original=f.api.comment;
  f.api.comment=async id=>({...await original(id),...overrides});
  f.store.db.prepare('INSERT INTO webhook_inbox(id,media_id,received_at,mode,status) VALUES(?,?,?,?,?)').run(commentId,mediaId,Date.now(),'live','pending');
  await f.runner.tick(true);assert.ok(!f.calls.includes('POST'));assert.equal(f.store.comment(commentId),undefined);f.store.close();
 }
});
test('Failed event reads are retained with backoff; no polling fallback',async()=>{
 const f=fixture();f.api.comment=async()=>{f.calls.push('failed-read');throw Object.assign(Error('network'),{kind:'network'})};
 f.store.db.prepare('INSERT INTO webhook_inbox(id,media_id,received_at,mode,status) VALUES(?,?,?,?,?)').run(commentId,mediaId,Date.now(),'preview','pending');
 await f.runner.tick(true);await f.runner.tick(true);assert.deepEqual(f.calls,['failed-read']);
 const row=f.store.db.prepare('SELECT * FROM webhook_inbox').get();assert.equal(row.status,'pending');assert.ok(row.next_attempt>Date.now());f.store.close();
});
test('Inbox and deduplication survive reopening SQLite',()=>{
 const parent=realpathSync(new URL('.',import.meta.url)),dir=mkdtempSync(path.join(parent,'inbox-')),file=path.join(dir,'history.sqlite');
 try{
  let store=new Store(file);store.db.prepare('INSERT INTO webhook_inbox(id,media_id,received_at,mode,status) VALUES(?,?,?,?,?)').run(commentId,mediaId,Date.now(),'live','pending');store.close();
  store=new Store(file);assert.equal(store.inbox()[0].id,commentId);
  assert.equal(store.db.prepare('INSERT OR IGNORE INTO webhook_inbox(id,media_id,received_at,mode,status) VALUES(?,?,?,?,?)').run(commentId,mediaId,Date.now(),'live','pending').changes,0);store.close();
 }finally{const resolved=realpathSync(dir);assert.ok(resolved.startsWith(parent+path.sep));rmSync(resolved,{recursive:true,force:true})}
});
test('Subscription sends comments only to graph.instagram.com',async()=>{
 const store=new Store(':memory:'),requests=[];
 const api=new Instagram({token:'synthetic',store,fetcher:async(url,opts)=>{requests.push({url:String(url),...opts});return new Response(JSON.stringify({success:true}))}});
 assert.deepEqual(await api.subscribe(accountId),{success:true});
 assert.equal(requests[0].url,'https://graph.instagram.com/v26.0/'+accountId+'/subscribed_apps');
 assert.equal(requests[0].body,'subscribed_fields=comments');assert.equal(requests[0].method,'POST');store.close();
});
