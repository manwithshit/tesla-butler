import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeChargingReceipt} from '../src/receipt-recognizer.mjs';
import {parseReceiptText} from '../src/receipt-text.mjs';
import {savePendingReceipt,updateReceiptFromText,setReceiptStatus} from '../src/store.mjs';
import {normalizeReceiptResult} from '../src/receipt-values.mjs';
import {buildReceiptCard,assertCard} from '../src/cards.mjs';
import {handleImage,handleMessageEvent,handleReceiptText,handleCardEvent} from '../src/bot.mjs';

function memoryStore(){let data={receipts:{}};return {readStore:async()=>structuredClone(data),writeStore:async value=>{data=structuredClone(value);}};}

test('partial image persists draft, text corrects it, stale cards fail and confirm is idempotent',async()=>{
 const options=memoryStore();const event={message_id:'fixture-image',chat_id:'fixture-chat',content:'fixture'};let card;
 await handleImage(event,{downloadMessageImage:async()=>'/fixture.png',
  analyzeChargingReceipt:async()=>({...normalizeReceiptResult({amount_cny:20},'apple_vision'),draft_issue:'电量待补充'}),
  getRecentChargingProcesses:async()=>{throw new Error('must not query for incomplete draft');},
  savePendingReceipt:args=>savePendingReceipt(args,options),replyText:async()=>{},replyCard:async(_,value)=>{card=value;}});
 assertCard(card);assert.ok(!JSON.stringify(card).includes('confirm_receipt'));
 let r=await updateReceiptFromText({chatId:event.chat_id,messageId:'fixture-correction',patch:parseReceiptText('充了30度')},options);
 assert.equal(r.status,'pending');assert.equal(r.fields.amount_cny,20);assert.equal(r.fields.energy_kwh,30);
 assertCard(buildReceiptCard(r));assert.ok(JSON.stringify(buildReceiptCard(r)).includes('confirm_receipt'));
 const revision=r.revision;
 r=await updateReceiptFromText({chatId:event.chat_id,messageId:'fixture-correction',patch:{energy_kwh:30}},options);
 assert.equal(r.revision,revision);
 await assert.rejects(setReceiptStatus(r.id,'confirmed',{...options,chatId:event.chat_id,revision:1}),{code:'RECEIPT_DRAFT_STALE'});
 await assert.rejects(setReceiptStatus(r.id,'confirmed',{...options,chatId:'other',revision}),{code:'RECEIPT_DRAFT_STALE'});
 await setReceiptStatus(r.id,'confirmed',{...options,chatId:event.chat_id,revision});
 const again=await setReceiptStatus(r.id,'confirmed',{...options,chatId:event.chat_id,revision});
 assert.equal(again.status,'confirmed');assert.equal(Object.keys((await options.readStore()).receipts).length,1);
});

test('multiple drafts cannot be silently chosen; malformed or incomplete drafts cannot confirm',async()=>{
 const options=memoryStore();let r;
 for(const messageId of ['one','two'])r=await savePendingReceipt({messageId,chatId:'owner',fields:normalizeReceiptResult({amount_cny:5})},options);
 await assert.rejects(updateReceiptFromText({chatId:'owner',messageId:'correction',patch:{energy_kwh:5}},options),{code:'RECEIPT_DRAFT_AMBIGUOUS'});
 await assert.rejects(setReceiptStatus(r.id,'confirmed',{...options,chatId:'owner',revision:1}),{code:'RECEIPT_DRAFT_INCOMPLETE'});
 await assert.rejects(updateReceiptFromText({chatId:'other',messageId:'correction',patch:{energy_kwh:5}},options),{code:'RECEIPT_DRAFT_MISSING'});
});

test('text-only new receipt stays pending, changing totals clears stale fees and match',async()=>{
 const options=memoryStore();
 let r=await updateReceiptFromText({chatId:'owner',messageId:'new',patch:parseReceiptText('昨天充了30度，花了24元')},options);
 assert.equal(r.status,'pending');assert.equal(r.fields.recognition_source,'user_text');
 r=await updateReceiptFromText({chatId:'owner',messageId:'edit',patch:{amount_cny:18}},options);
 assert.equal(r.fields.amount_cny,18);assert.equal(r.fields.energy_kwh,30);
 assert.equal(r.fields.all_in_unit_price_cny_per_kwh,null);assert.equal(r.charging_match.status,'unlinked');
});

test('menu and default-rate routing stay ahead of receipt text',async()=>{
 let count=0;
 const dependencies={registerChat:async()=>{},runAction:async()=>{},handleDefaultRateSubmission:async()=>{},handleReceiptText:async()=>{count++;return true;}};
 for(const content of ['菜单','默认电价1元/度','充了30度'])await handleMessageEvent({sender_type:'user',chat_type:'p2p',chat_id:'fixture',message_id:content,message_type:'text',content},dependencies);
 assert.equal(count,1);
});

test('OCR outage and unsafe images return empty editable drafts rather than invented values',async()=>{
 for(const recognizeText of [async()=>{throw new Error('unavailable');},async()=>[{text:'待支付'}]]){
  const r=await analyzeChargingReceipt('fixture',{allowPartial:true,k3FallbackEnabled:true,recognizeText,analyzeWithK3:async()=>{throw new Error('should not call');}});
  assert.equal(r.amount_cny,null);assert.equal(r.energy_kwh,null);assert.ok(r.draft_issue);
 }
});

test('receipt text accepts corrections and relative UTC+8 dates without taking menu/rates',()=>{
  assert.deepEqual(parseReceiptText('昨天充了30度，花了24元',new Date('2026-09-08T01:00:00Z')),{amount_cny:24,energy_kwh:30,charged_at:'2026-09-07'});
  assert.deepEqual(parseReceiptText('金额应该是18元'),{amount_cny:18});
  for(const text of ['菜单','1','默认电价1元','金额是多少？'])assert.equal(parseReceiptText(text),null);
  assert.throws(()=>parseReceiptText('花了20元，花了30元'));
  assert.throws(()=>parseReceiptText('充了-10度'));
});

test('draft mode returns partial fields and an explicit issue without cloud calls', async () => {
  const r=await analyzeChargingReceipt('fixture',{allowPartial:true,k3FallbackEnabled:false,
    recognizeText:async()=>[{text:'实付：20元',confidence:1}]});
  assert.equal(r.amount_cny,20);
  assert.equal(r.energy_kwh,null);
  assert.ok(r.draft_issue);
});

test('failed card delivery can retry same message without duplicate receipts',async()=>{
 const options=memoryStore();let attempts=0;const event={chat_id:'owner',message_id:'replay',content:'充了30度，实付24元'};
 const ops={updateReceiptFromText:args=>updateReceiptFromText(args,options),replyText:async()=>{},replyCard:async()=>{attempts++;throw new Error('offline');}};
 await handleReceiptText(event,ops);
 await handleReceiptText(event,{...ops,replyCard:async()=>{}});
 const receipts=Object.values((await options.readStore()).receipts);
 assert.equal(receipts.length,1);assert.equal(receipts[0].revision,1);assert.equal(receipts[0].status,'pending');assert.equal(attempts,2);
});

test('card callback preserves revision for server-side stale checks',async()=>{
 let received;
 await handleCardEvent({chat_id:'fixture',event_id:'event',action_value:{action:'confirm_receipt',receipt_id:'draft',revision:3}},
 {registerChat:async()=>{},handleReceiptAction:async value=>{received=value;}});
 assert.equal(received.revision,3);
});

test('relative date is persisted without inventing a time; new messages cannot overwrite confirmed receipt',async()=>{
 const options=memoryStore();
 const r=await updateReceiptFromText({chatId:'owner',messageId:'one',patch:parseReceiptText('昨天充了30度，实付24元',new Date('2026-09-08T01:00:00Z'))},options);
 assert.equal(r.fields.accounting_at,'2026-09-07');assert.equal(r.fields.charged_at,'2026-09-07');
 await setReceiptStatus(r.id,'confirmed',{...options,chatId:'owner',revision:r.revision});
 await assert.rejects(updateReceiptFromText({chatId:'owner',messageId:'two',patch:{amount_cny:18}},options),{code:'RECEIPT_DRAFT_MISSING'});
 assert.equal((await options.readStore()).receipts[r.id].fields.amount_cny,24);
});
