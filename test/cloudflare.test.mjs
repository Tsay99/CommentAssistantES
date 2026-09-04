
import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePermanentSettings} from '../cloudflare-settings.mjs';
const token='a'.repeat(120);
test('Permanent setup rejects ephemeral and unsafe URLs without changing credentials',()=>{
 for(const callbackUrl of ['https://example.trycloudflare.com/webhooks/instagram','http://hooks.example.com/webhooks/instagram','https://hooks.example.com/api/state','https://user:pass@hooks.example.com/webhooks/instagram','https://hooks.example.com/webhooks/instagram?secret=1','https://127.0.0.1/webhooks/instagram']){
  assert.throws(()=>validatePermanentSettings({token,callbackUrl}));
 }
 assert.throws(()=>validatePermanentSettings({token:'cloudflared.exe service install '+token,callbackUrl:'https://hooks.example.com/webhooks/instagram'}));
 const good=validatePermanentSettings({token,callbackUrl:'https://hooks.example.com/webhooks/instagram'});
 assert.equal(good.callbackUrl,'https://hooks.example.com/webhooks/instagram');assert.equal(good.token,token);
});
