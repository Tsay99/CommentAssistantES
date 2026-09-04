import {readFileSync,writeFileSync} from 'node:fs';
const bank=JSON.parse(readFileSync(new URL('../bank.json',import.meta.url),'utf8'));
const esc=s=>'"'+String(s).replaceAll('"','""')+'"';
const rows=[['ID','Категория','Триггеры','Ответ','Подтверждение'],...bank.categories.flatMap(c=>c.responses.map(r=>[r.id,c.label,[...c.emoji,...c.keywords].join(', '),r.text,c.review?'вручную':'автоматически для простых реакций']))];
writeFileSync(new URL('../RESPONSES-100.csv',import.meta.url),'\uFEFF'+rows.map(r=>r.map(esc).join(';')).join('\r\n'));
