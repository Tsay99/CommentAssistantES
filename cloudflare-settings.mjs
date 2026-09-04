
export function validatePermanentSettings({token='',callbackUrl=''}){
 token=String(token).trim();callbackUrl=String(callbackUrl).trim();
 if(!/^[A-Za-z0-9+/_=-]{80,4096}$/.test(token))throw Error('Вставьте только токен туннеля Cloudflare из команды установки, без самой команды.');
 let u;try{u=new URL(callbackUrl)}catch{throw Error('Укажите полный постоянный HTTPS-адрес Webhook')}
 if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash||u.pathname!=='/webhooks/instagram'||!u.hostname.includes('.')||u.hostname.endsWith('.trycloudflare.com')||u.hostname==='localhost'||/^[\d.]+$/.test(u.hostname))throw Error('Укажите постоянный адрес на вашем домене, заканчивающийся на /webhooks/instagram.');
 return {token,callbackUrl:u.href};
}
