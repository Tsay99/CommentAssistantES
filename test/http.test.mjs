import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('Панель: подключение, предпросмотр, CSV, CSRF и запрет публикации без маркера',async()=>{
 const dir=mkdtempSync(path.join(root,'test','http-'));
 const child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,env:{...process.env,PORT:'8799',CA_DATA_DIR:dir},windowsHide:true,stdio:'ignore'});
 const base='http://127.0.0.1:8799';let ready=false;
 try{
  for(let i=0;i<40;i++){
   try{if((await fetch(base+'/api/health')).ok){ready=true;break}}catch{}
   await new Promise(r=>setTimeout(r,100));
  }
  assert.ok(ready,'Сервер должен запуститься');
  const page=await fetch(base);assert.equal(page.status,200);
  const cookie=page.headers.get('set-cookie').split(';')[0];
  const state=await (await fetch(base+'/api/state',{headers:{cookie}})).json();
  assert.equal(state.config.connected,false);assert.equal(state.bank.categories.flatMap(c=>c.responses).length,100);
  assert.equal(JSON.stringify(state).includes('access_token'),false);
  const post=(url,data,extra={})=>fetch(base+url,{method:'POST',headers:{cookie,Origin:base,'Content-Type':'application/json','X-CSRF-Token':state.csrf,...extra},body:JSON.stringify(data)});
  const example=await post('/api/preview',{text:'😹😹😹'});const r=await example.json();assert.equal(r.action,'auto');assert.ok(r.reply.text);
  const example2=await post('/api/preview',{text:'😹😹😹',used:[r.reply.id]});assert.notEqual((await example2.json()).reply.id,r.reply.id);
  const fake=await post('/api/config',{mode:'live',confirmLive:true});assert.equal(fake.status,400);
  const csrf=await post('/api/config',{mode:'paused'},{Origin:'http://evil.example'});assert.equal(csrf.status,403);
  const noCsrf=await post('/api/config',{mode:'paused'},{'X-CSRF-Token':''});assert.equal(noCsrf.status,403);
  const manualCsrf=await post('/api/manual-reply',{id:'18350137990218356',text:'Текст',requestId:'http-test-request-001',confirm:true},{'X-CSRF-Token':''});assert.equal(manualCsrf.status,403);
  const manualConfirm=await post('/api/manual-reply',{id:'18350137990218356',text:'Текст',requestId:'http-test-request-001'});assert.equal(manualConfirm.status,400);
  const exported=await fetch(base+'/api/export',{headers:{cookie}});assert.equal((await exported.text()).trim().split(/\r?\n/).length,101);
  const anon=await fetch(base+'/api/state');assert.equal(anon.status,401);
  const files=await fetch(base+'/data/instagram.dpapi',{headers:{cookie}});assert.equal(files.status,404);
 }finally{
  const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;
  const resolved=realpathSync(dir);
  if(!resolved.toLowerCase().startsWith(realpathSync(path.join(root,'test')).toLowerCase()+path.sep))throw Error('Unexpected test directory');
  rmSync(resolved,{recursive:true,force:true});
 }
});
