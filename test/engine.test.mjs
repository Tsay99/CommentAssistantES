import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {classify,pickResponse,validateBank,norm} from '../engine.mjs';
const bank=JSON.parse(readFileSync(new URL('../bank.json',import.meta.url),'utf8'));
test('Ровно 100 уникальных реплик в 14 категориях',()=>{assert.equal(validateBank(bank),true);assert.equal(bank.categories.length,14)});
test('Эмодзи пользователя, оттенки кожи и селекторы Unicode',()=>{
 for(const [input,category] of [['😹😹😹','laugh'],['😂😂😂😂😂','laugh'],['👍🏽👍🏿','approval'],['❤️❤️','heart'],['🔥🔥','fire'],['👏🏻','applause'],['💪🏽','strength']]){
  assert.deepEqual(classify(input,bank).category,category,input);assert.equal(classify(input,bank).action,'auto',input);
 }
});
test('Ключевые слова и границы слов',()=>{
 assert.equal(classify('КЛАССНО!!!',bank).category,'approval');
 assert.equal(classify('Огромное спасибо 😊',bank).category,'thanks');
 assert.equal(classify('добрый день',bank).category,'greeting');
 assert.equal(classify('рахмет',bank).category,'thanks');
 assert.equal(classify('супермаркет',bank).action,'skip');
 assert.equal(classify('не смешно 😂',bank).action,'skip');
 assert.equal(classify('супер, но не работает',bank).action,'skip');
});
test('Реальные длинные, рекламные, адресные комментарии не получают шаблон',()=>{
 const samples=['@k1s.0 уже перешло. В нормальных компаниях есть компьютеризированная система управления техническим обслуживанием.','Добро пожаловать на Международную выставку строительной техники!','А ещё тб...там ваще пиздец...сил','Он просто не вел все это😂','Ужасно 😂','https://example.org 🔥','Мне плохо 😭','😭','😂😭','💀','🤡','Почему? 😂'];
 for(const input of samples)assert.equal(classify(input,bank).action,'skip',input);
 assert.equal(classify('😂',bank,{caption:'Трагедия на стройке: погиб рабочий'}).action,'skip');
 assert.equal(classify('😂',bank,{own:true}).action,'skip');
});
test('Не обещаем цену, наличие и доставку без владельца',()=>{
 for(const [input,category] of [['цена?','price'],['где находитесь?','location'],['хочу заказать','availability'],['какой телефон','contact']]){
  const r=classify(input,bank);assert.equal(r.action,'review');assert.equal(r.category,category);
 }
 assert.equal(classify('🙏',bank).action,'review');
});
test('25 ответов на смех без повторов; после исчерпания пропуск',()=>{
 const history=[],texts=new Set(),now=Date.now();
 for(let i=0;i<25;i++){
  const r=pickResponse('laugh',bank,history,{mediaId:'m',authorId:'a'},now);assert.ok(r);
  assert.ok(!texts.has(norm(r.text)));texts.add(norm(r.text));
  history.push({response_id:r.id,media_id:'m',author_id:'a',used_at:now});
 }
 assert.equal(pickResponse('laugh',bank,history,{mediaId:'m',authorId:'a'},now),null);
 assert.equal(pickResponse('laugh',bank,history,{mediaId:'m',authorId:'other'},now+40*86400000),null);
 assert.ok(pickResponse('laugh',bank,history,{mediaId:'other',authorId:'other'},now+40*86400000));
});
test('Глобальная и персональная пауза; отключённый ответ',()=>{
 const c=structuredClone(bank),r=c.categories[0].responses[0];
 for(const row of c.categories[0].responses)row.enabled=row.id===r.id;
 const old={response_id:r.id,media_id:'other',author_id:'a',used_at:Date.now()-48*3600000};
 assert.equal(pickResponse('laugh',c,[old],{mediaId:'m',authorId:'a'}),null);
 assert.ok(pickResponse('laugh',c,[old],{mediaId:'m',authorId:'b'}));
});

test('Отредактированная база не повторяет тот же текст с другим ID',()=>{
 const now=Date.now(),c=structuredClone(bank);
 for(const r of c.categories[0].responses)r.enabled=false;
 c.categories[0].responses[1].enabled=true;
 const r=c.categories[0].responses[1];
 assert.equal(pickResponse('laugh',c,[{response_id:'changed-id',response_text:r.text,media_id:'m',author_id:'a',used_at:now}],{mediaId:'m',authorId:'b'},now),null);
});
