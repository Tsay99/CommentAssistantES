import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync,renameSync} from 'node:fs';
import path from 'node:path';
export class Vault {
 constructor(path){this.path=path}
 has(){return existsSync(this.path)}
 transform(mode,value){
  if(process.platform!=='win32')throw Error('Хранилище ключа настроено для Windows');
  const prefix="$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; [void][Reflection.Assembly]::LoadWithPartialName('System.Security'); ";
  const script=prefix+(mode==='encrypt'
   ? "$v=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); $b=[Security.Cryptography.ProtectedData]::Protect($v,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($b))"
   : "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $v=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($v))");
  const exe=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const r=spawnSync(exe,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{input:value,encoding:'utf8',windowsHide:true,timeout:15000});
  if(r.status!==0||!r.stdout.trim())throw Error('Не удалось открыть защищённое хранилище Windows');
  return r.stdout.trim();
 }
 write(token){writeFileSync(this.path+'.tmp',this.transform('encrypt',token),'utf8');renameSync(this.path+'.tmp',this.path)}
 read(){return this.has()?this.transform('decrypt',readFileSync(this.path,'utf8')):''}
}
