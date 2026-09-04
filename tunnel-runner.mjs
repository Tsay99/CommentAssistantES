
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,renameSync,existsSync,statSync,appendFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Vault} from './vault.mjs';
const root=path.dirname(fileURLToPath(import.meta.url)),data=path.join(root,'data');
const tokenPath=path.join(data,'cloudflare.dpapi'),vault=new Vault(tokenPath),statusPath=path.join(data,'permanent-status.json');
let child=null,secret='',stamp=0,busy=false,stopping=false,childStarted=0,nextAttempt=0;
const disabled=()=>existsSync(path.join(data,'service-disabled'))||existsSync(path.join(data,'permanent-disabled'));
const status=(state)=>{writeFileSync(statusPath+'.tmp',JSON.stringify({state,at:Date.now(),pid:process.pid,childPid:child?.pid??null}));renameSync(statusPath+'.tmp',statusPath)};
const log=(text)=>{const file=path.join(root,'logs','permanent-tunnel.log');if(existsSync(file)&&statSync(file).size>1000000)writeFileSync(file,'');appendFileSync(file,new Date().toISOString()+' '+text+'\n')};
function startChild(){
 secret=vault.read();stamp=statSync(tokenPath).mtimeMs;
 if(!secret)throw Error('Missing token');
 child=spawn(path.join(root,'bin','cloudflared.exe'),['tunnel','--no-autoupdate','--protocol','auto','--metrics','127.0.0.1:8790','--loglevel','warn','run'],{
  cwd:root,windowsHide:true,stdio:['ignore','ignore','ignore'],env:{...process.env,TUNNEL_TOKEN:secret}});
 const current=child;childStarted=Date.now();
 // Raw output is deliberately not stored: it may contain a tunnel token.
 child.on('error',()=>{log('Не удалось запустить cloudflared');status('error')});
 child.on('exit',(code)=>{if(child===current)child=null;log('Соединение завершилось, код '+code);nextAttempt=Date.now()+30000;if(!stopping)status('reconnecting')});
 status('connecting');log('Запущено постоянное соединение Cloudflare');
}
async function cycle(){
 if(busy||stopping)return;busy=true;
 try{
  if(disabled()){if(child)child.kill();status('paused');return}
  if(!vault.has()){status('needs-token');return}
  const changed=stamp&&statSync(tokenPath).mtimeMs!==stamp;
  if(changed&&child){child.kill();status('reconnecting');return}
  if(!child&&Date.now()>=nextAttempt)startChild();
  if(child){
   let ready=false;
   try{ready=(await fetch('http://127.0.0.1:8790/ready',{signal:AbortSignal.timeout(3000)})).ok}catch{}
   status(ready?'connected':'connecting');
   if(!ready&&Date.now()-childStarted>300000){log('Соединение не восстановилось за пять минут; перезапуск');child.kill()}
  }
 }catch{status('error');nextAttempt=Date.now()+60000;log('Проверьте токен туннеля и доступ к Cloudflare')}
 finally{busy=false}
}
const timer=setInterval(cycle,15000);void cycle();
function stop(){stopping=true;clearInterval(timer);if(child)child.kill();status('stopped');setTimeout(()=>process.exit(0),1000).unref()}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
