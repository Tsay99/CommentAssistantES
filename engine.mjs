import {randomInt} from 'node:crypto';
export const norm = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/ё/g,'е').replace(/[\uFE0E\uFE0F\u{1F3FB}-\u{1F3FF}]/gu,'').trim();
const ambiguous = /[😭😢😿💔😡😠🤬👎🤡🙄😒😑😐🙃🤔😱🤯💀☠🥲🥹🥺😏😅😬🖕💩]/u;
const sensitive = /(?:умер|смерт|погиб|трагеди|похорон|соболезн|авари|травм|убил|убит|войн|суицид|болезн|рак(?:а|ом)?(?:\s|$)|обман|мошенн|жалоб|претензи|некачеств|сломал|сломано|возврат|верните|плох|ужас|кошмар|стыд|позор|отстой|дерьм|говн|пизд|бляд|хуй|сук[аи]|нахер|идиот|дурак|дебил|ненавиж|несмешно|бред|фигня|фигню|ерунда|безопасност|несчастн)/iu;
const promo = /(?:https?:\/\/|www\.|t\.me\/|заработ(?:ок|ать)|подпишись|подписывай|розыгрыш|промокод|инвестиц|крипт|добро пожаловать на|приглашаем на|международн.*выставк)/iu;
const tokens = s => norm(s).match(/[\p{L}\p{N}]+/gu) ?? [];
function phrase(text, keyword) {
 const words=tokens(text), key=tokens(keyword);
 return key.length>0 && words.some((_,i)=>key.every((v,j)=>words[i+j]===v));
}
const skip=reason=>({category:null,action:'skip',reason});
export function classify(text, bank, {caption='', own=false}={}) {
 const raw=String(text??''), clean=norm(raw);
 if(own) return skip('Комментарий вашего аккаунта');
 if(!clean) return skip('Пустой комментарий');
 if(raw.length>700) return skip('Длинный комментарий требует чтения');
 if(/@[\p{L}\p{N}_.]+/u.test(raw)) return skip('Обращение к другому пользователю');
 if(promo.test(raw)) return skip('Ссылка или рекламный текст');
 if(sensitive.test(raw)||sensitive.test(caption)) return skip('Жалоба, негатив или чувствительная тема');
 if(ambiguous.test(clean)) return skip('Неоднозначная эмоция — нужен человек');
 const cats=bank.categories, words=tokens(raw);
 const business=cats.find(c=>c.review && c.keywords.some(k=>phrase(clean,k)));
 if(business) return {category:business.id,action:'review',reason:'Вопрос требует уточнения и проверки владельцем'};
 const matched=cats.filter(c=>!c.review && c.keywords.some(k=>phrase(clean,k)));
 const stopWords=new Set(['очень','просто','вообще','это','как','же','ну','вы','вам','вас','за','все','всем','большое','огромное','видео','ролик','пост','информацию','инфу','контент','реально','прям','так','такой','такая','ребята']);
 const allowed=new Set([...stopWords,...cats.filter(c=>!c.review).flatMap(c=>c.keywords.flatMap(tokens))]);
 const hasOtherWords=words.some(w=>!allowed.has(w)&&!/^(?:ха){2,6}$/.test(w)&&!/^а?(?:ха){2,6}х?$/.test(w));
 if(words.includes('не')||words.includes('нет')||words.includes('но')||words.includes('зато')) return skip('Отрицание или неоднозначный контекст');
 if(raw.includes('?') && !matched.some(c=>c.id==='greeting')) return skip('Вопрос требует ответа человека');
 if(hasOtherWords) return skip('Текст выходит за пределы простых правил');
 let stripped=clean;
 const scores=[];
 for(const c of cats) {
  let score=0;
  for(const em of [...c.emoji].sort((a,b)=>b.length-a.length)) {
   const e=norm(em);
   const count=stripped.split(e).length-1;
   if(count){ score+=count; stripped=stripped.split(e).join(''); }
  }
  if(score) scores.push({category:c.id,score,review:!!c.review});
 }
 const residue=stripped.replace(/[\p{L}\p{N}\p{P}\p{Z}\s]/gu,'');
 if(residue) return skip('Есть нераспознанный символ или эмодзи');
 if(words.length && !matched.length && !/^(?:а?ха?)+$/u.test(words.join(''))) return skip('Нет однозначного ключевого слова');
 const chosen=matched.find(c=>c.id==='thanks') ?? matched.find(c=>c.id==='greeting') ?? matched[0];
 if(chosen) return {category:chosen.id,action:'auto',reason:'Простая реакция по ключевым словам'};
 if(/^(?:а?ха?){2,}$/u.test(words.join(''))) return {category:'laugh',action:'auto',reason:'Текстовый смех'};
 scores.sort((a,b)=>b.score-a.score);
 const winner=scores[0];
 if(!winner)return skip('Подходящего правила нет');
 if(winner.category==='thanks')return {category:'thanks',action:'review',reason:'Один 🙏 может быть просьбой или молитвой'};
 if(winner.review)return {category:winner.category,action:'review',reason:'Нужен ответ владельца'};
 return {category:winner.category,action:'auto',reason:'Реакция по смайликам'};
}
export function pickResponse(category, bank, history=[], cfg={}, now=Date.now()) {
 const items=bank.categories.find(c=>c.id===category)?.responses??[];
 const recentMs=(cfg.minRepeatHours??24)*3600000;
 const mediaId=cfg.mediaId, authorId=cfg.authorId;
 const candidate=items.filter(r=>{
  if(r.enabled===false)return false;
  return !history.some(h=>(h.response_id===r.id || (h.response_text && norm(h.response_text)===norm(r.text))) && (
   now-h.used_at<recentMs ||
   (mediaId && h.media_id===mediaId) ||
   (authorId && h.author_id===authorId && now-h.used_at<30*86400000)
  ));
 });
 if(!candidate.length)return null;
 const counts=new Map();
 for(const h of history) counts.set(h.response_id,(counts.get(h.response_id)??0)+1);
 const min=Math.min(...candidate.map(r=>counts.get(r.id)??0));
 const least=candidate.filter(r=>(counts.get(r.id)??0)===min);
 return least[randomInt(least.length)];
}
export function validateBank(bank) {
 if(!bank || !Array.isArray(bank.categories))throw Error('Нет категорий');
 const all=bank.categories.flatMap(c=>c.responses);
 if(all.length!==100)throw Error('В базе должно быть ровно 100 ответов');
 if(new Set(all.map(r=>r.id)).size!==100)throw Error('Повторяются ID ответов');
 if(new Set(all.map(r=>norm(r.text))).size!==100)throw Error('Повторяются тексты ответов');
 for(const r of all)if(typeof r.text!=='string'||!r.text.trim()||r.text.length>350)throw Error('Ответ должен содержать от 1 до 350 символов');
 return true;
}
