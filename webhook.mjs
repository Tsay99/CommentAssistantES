
import http from 'node:http';
import {createHmac,timingSafeEqual} from 'node:crypto';
export const WEBHOOK_PATH='/webhooks/instagram';
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function validSignature(raw,signature,secret){
 if(!secret||typeof signature!=='string'||!/^sha256=[a-f0-9]{64}$/i.test(signature))return false;
 return equal(signature.toLowerCase(),'sha256='+createHmac('sha256',secret).update(raw).digest('hex'));
}
export function createWebhookServer({store,config,credentials,wake=()=>{}}){
 const reply=(res,status,text)=>{res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(text)};
 const server=http.createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,'http://localhost');
   if(url.pathname!==WEBHOOK_PATH)return reply(res,404,'Not found');
   const cfg=config(),keys=credentials();
   if(req.method==='GET'){
    const challenge=url.searchParams.get('hub.challenge');
    if(!keys.verifyToken||url.searchParams.get('hub.mode')!=='subscribe'||!equal(url.searchParams.get('hub.verify_token'),keys.verifyToken)||!challenge||challenge.length>1024)return reply(res,403,'Verification failed');
    store.set('webhookVerifiedAt',Date.now());
    store.event('Адрес Webhook проверен. Подписка на comments настраивается отдельно.');
    return reply(res,200,challenge);
   }
   if(req.method!=='POST')return reply(res,405,'Method not allowed');
   if(!keys.appSecret)return reply(res,503,'Webhook is not configured');
   if(!/^sha256=[a-f0-9]{64}$/i.test(req.headers['x-hub-signature-256']??''))return reply(res,403,'Invalid signature');
   if(Number(req.headers['content-length'])>2097152)return reply(res,413,'Payload too large');
   const chunks=[];let bytes=0;
   for await(const c of req){bytes+=c.length;if(bytes>2097152)return reply(res,413,'Payload too large');chunks.push(c)}
   const raw=Buffer.concat(chunks);
   if(!validSignature(raw,req.headers['x-hub-signature-256'],keys.appSecret))return reply(res,403,'Invalid signature');
   let payload;try{payload=JSON.parse(raw.toString('utf8'))}catch{return reply(res,400,'Invalid JSON')}
   if(payload?.object!=='instagram'||!Array.isArray(payload.entry))return reply(res,200,'EVENT_RECEIVED');
   let added=0;
   store.db.exec('BEGIN IMMEDIATE');
   try{
    for(const entry of payload.entry){
     if(String(entry?.id)!==cfg.accountId)continue;
     const changes=Array.isArray(entry.changes)?entry.changes:entry.field?[entry]:[];
     for(const change of changes){
      if(change?.field!=='comments')continue;
      const v=change.value;
      if(!v||typeof v.id!=='string'||!/^\d{5,30}$/.test(v.id))continue;
      const mediaId=String(v.media?.id??'');
      if(mediaId&&!/^\d{5,30}$/.test(mediaId))continue;
      const status=cfg.mode==='paused'?'ignored':'pending';
      added+=store.db.prepare('INSERT OR IGNORE INTO webhook_inbox(id,media_id,received_at,mode,status) VALUES(?,?,?,?,?)').run(v.id,mediaId,Date.now(),cfg.mode,status).changes;
     }
    }
    store.set('webhookLastDelivery',Date.now());
    if(added)store.set('webhookLastComment',Date.now());
    store.db.exec('COMMIT');
   }catch(e){store.db.exec('ROLLBACK');throw e}
   // Acknowledge after SQLite commit, before any Graph API request.
   reply(res,200,'EVENT_RECEIVED');
   if(added){store.event('Webhook: принято новых комментариев — '+added);setImmediate(wake)}
  }catch{if(!res.headersSent)reply(res,500,'Retry later');else res.end()}
 });
 server.requestTimeout=15000;server.headersTimeout=10000;
 return server;
}
