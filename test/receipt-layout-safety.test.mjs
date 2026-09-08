import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVisionReceipt, analyzeChargingReceipt, validateReceipt } from '../src/receipt-recognizer.mjs';

const box = (text, x = 0.1, y = 0.6, width = 0.3) => ({text,x,y,width,height:0.025,confidence:0.99});

test('multiple orders and unpaid screens cannot bypass safety through fallback', async () => {
  for (const marker of ['订单中心', '待支付', '立即支付']) {
    let fallbackCalls = 0;
    await assert.rejects(analyzeChargingReceipt('fixture', {
      recognizeText: async () => [box(marker), box('实付20元'), box('充电电量10度')],
      k3FallbackEnabled: true,
      analyzeWithK3: async () => { fallbackCalls++; return {amount_cny:20, energy_kwh:10}; }
    }), {code:'RECEIPT_IMAGE_UNSAFE'});
    assert.equal(fallbackCalls, 0);
  }
});

test('public receipt aliases extract totals and fee breakdown without guessing prices', () => {
  const result = parseVisionReceipt([
    box('充电电量：66.030度'), box('充电费用：42.9200元',0.1,0.5),
    box('服务费用：56.1300元',0.6,0.5), box('总费用：99.0500元',0.6,0.4),
    box('结束时间：2023-07-14 10:50:49',0.1,0.3)
  ]);
  assert.equal(result.amount_cny,99.05); assert.equal(result.energy_kwh,66.03);
  assert.equal(result.electricity_fee_cny,42.92); assert.equal(result.service_fee_cny,56.13);
  assert.equal(result.charged_at,'2023-07-14 10:50:49');
  assert.equal(result.all_in_unit_price_cny_per_kwh,null);
  assert.equal(validateReceipt(result),null);
});

test('split paid receipt keeps explicit energy and does not invent a date or unit price', () => {
  const result = parseVisionReceipt([
    box('实付',0.1,0.8), box('68.95元',0.7,0.8),
    box('已充电量',0.1,0.7), box('54.310度',0.7,0.7),
    box('电费：36.36元',0.1,0.5), box('服务费：32.59元',0.1,0.4)
  ]);
  assert.equal(result.amount_cny,68.95); assert.equal(result.energy_kwh,54.31);
  assert.equal(result.electricity_unit_price_cny_per_kwh,null);
  assert.equal(result.service_unit_price_cny_per_kwh,null);
  assert.equal(result.charged_at,null); assert.equal(validateReceipt(result),null);
});

test('a neighboring order label or ambiguous row cannot become energy', () => {
  for (const values of [[box('订单1',0.7,0.5)], [box('10',0.5,0.5),box('20',0.8,0.5)]]) {
    const result=parseVisionReceipt([box('实付20元',0.1,0.8),box('充电电量',0.1,0.5),...values]);
    assert.equal(result.energy_kwh,null);
    assert.notEqual(validateReceipt(result),null);
  }
});

test('explicit paid amount takes precedence over a pre-discount total', () => {
  const result=parseVisionReceipt([box('总费用：30元'),box('实付：20元'),box('充电电量：10度')]);
  assert.equal(result.amount_cny,20);
});
