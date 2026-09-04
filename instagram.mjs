export class Instagram {
 constructor({token,store,maxCalls=160,fetcher=fetch}){this.token=token;this.store=store;this.maxCalls=maxCalls;this.fetcher=fetcher}
 async request(path,{method='GET',params={},refresh=false}={}){
  if(this.store.get('cooldown',0)>Date.now())throw Object.assign(Error('Пауза после ограничения Meta. Время показано в панели.'),{kind:'rate'});
  this.store.chargeCall(this.maxCalls);
  if(!this.token)throw Error('Добавьте маркер доступа Instagram');
  if(!refresh && !/^(?:me|[0-9]+)(?:\/(?:media|comments|replies|subscribed_apps))?$/.test(path))throw Error('Запрос вне разрешённых функций комментариев');
  const url=new URL(refresh?'https://graph.instagram.com/refresh_access_token':'https://graph.instagram.com/v26.0/'+path);
  const opts={method,headers:{Authorization:'Bearer '+this.token},signal:AbortSignal.timeout(20000)};
  if(refresh){url.searchParams.set('grant_type','ig_refresh_token');url.searchParams.set('access_token',this.token)}
  else if(method==='GET')for(const [k,v] of Object.entries(params))url.searchParams.set(k,String(v));
  else {opts.headers['Content-Type']='application/x-www-form-urlencoded';opts.body=new URLSearchParams(params).toString()}
  let response;
  try{response=await this.fetcher(url,opts)}
  catch{throw Object.assign(Error(method==='POST'?'Meta не подтвердила отправку. Проверьте комментарий вручную.':'Не удалось связаться с Instagram. Повторим чтение позже.'),{kind:method==='POST'?'uncertain':'network'})}
  for(const key of ['x-app-usage','x-business-use-case-usage']){
   try{
    const raw=JSON.parse(response.headers.get(key)||'{}');
    const findUsage=x=>typeof x==='object'&&x!==null&&Object.entries(x).some(([k,v])=>(['call_count','total_cputime','total_time'].includes(k)&&Number(v)>=85)||findUsage(v));
    if(findUsage(raw))this.store.set('cooldown',Date.now()+3600000);
   }catch{}
  }
  let body;
  try{body=await response.json()}catch{throw Object.assign(Error('Некорректный ответ Instagram'),{kind:method==='POST'?'uncertain':'network'})}
  if(!response.ok||body.error){
   const code=body.error?.code;
   if(response.status===429||[4,17,32,613,80002].includes(code))this.store.set('cooldown',Date.now()+3600000);
   // Не сохраняем исходную ошибку: в ней могут оказаться токены или персональные данные.
   const kind=code===190?'auth':response.status>=500&&method==='POST'?'uncertain':'api';
   throw Object.assign(Error(code===190?'Маркер доступа истёк или отозван. Подключите Instagram заново.':'Ошибка Instagram: '+(code??response.status)),{kind});
  }
  return body;
 }
 async identity(){return this.request('me',{params:{fields:'user_id,username'}})}
 async media(accountId,max=25){
  let after='',list=[];
  while(list.length<max){
   const r=await this.request(accountId+'/media',{params:{fields:'id,caption,permalink',limit:Math.min(50,max-list.length),...(after?{after}:{})}});
   list.push(...(r.data??[]));
   if(!r.paging?.next||!r.paging?.cursors?.after)break;
   const next=r.paging.cursors.after;if(next===after)break;after=next;
  }return list.slice(0,max);
 }
 mediaPage(accountId,after=''){return this.request(accountId+'/media',{params:{fields:'id,caption,permalink,timestamp,comments_count',limit:50,...(after?{after}:{})}})}
 archiveComments(mediaId,after=''){return this.request(mediaId+'/comments',{params:{fields:'id,text,timestamp,from,parent_id,replies.limit(50){id,text,timestamp,from}',limit:50,...(after?{after}:{})}})}
 comments(mediaId,after=''){return this.request(mediaId+'/comments',{params:{fields:'id,text,timestamp,from,parent_id',limit:50,...(after?{after}:{})}})}
 replies(commentId,after=''){return this.request(commentId+'/replies',{params:{fields:'id,text,from',limit:50,...(after?{after}:{})}})}
 reply(commentId,text){return this.request(commentId+'/replies',{method:'POST',params:{message:text}})}
 comment(id){return this.request(id,{params:{fields:'id,text,timestamp,from,parent_id,media'}})}
 mediaInfo(id){return this.request(id,{params:{fields:'id,caption,permalink'}})}
 subscribe(accountId){return this.request(accountId+'/subscribed_apps',{method:'POST',params:{subscribed_fields:'comments'}})}
 subscriptions(accountId){return this.request(accountId+'/subscribed_apps')}
 refresh(){return this.request('refresh_access_token',{refresh:true})}
}
