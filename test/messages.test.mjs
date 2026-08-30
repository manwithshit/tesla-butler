import test from "node:test";
import assert from "node:assert/strict";
import { handleImage, handleReceiptAction, handleReceiptMatchAction, isImageLikeMessage } from "../src/bot.mjs";

test("direct image messages are recognized", () => {
  assert.equal(isImageLikeMessage({ message_type: "image", content: "{}" }), true);
});

test("Feishu rich post containing an image is recognized as a bill image", () => {
  assert.equal(isImageLikeMessage({ message_type: "post", content: "![Image](img_v3_example)" }), true);
});

test("text-only rich posts are not treated as bill images", () => {
  assert.equal(isImageLikeMessage({ message_type: "post", content: "{\"title\":\"note\"}" }), false);
});

test("receipt image always gets acknowledgement and success feedback", async () => {
  const feedback = [];
  const fields = { energy_kwh: 20, amount_cny: 30, charged_at: null, provider: null, confidence: 0.9 };
  const result = await handleImage({ message_id: "om_success", content: "img_success" }, {
    feedbackAttempts: 1,
    downloadMessageImage: async () => "/tmp/receipt.png",
    analyzeChargingReceipt: async () => fields,
    validateReceipt: () => null,
    getRecentChargingProcesses: async () => [],
    savePendingReceipt: async () => ({ id: "receipt", fields }),
    buildReceiptCard: () => ({ schema: "2.0" }),
    replyText: async (_messageId, text) => feedback.push({ type: "text", text }),
    replyCard: async () => feedback.push({ type: "card" })
  });
  assert.equal(result.status, "success");
  assert.match(feedback[0].text, /已收到/);
  assert.equal(feedback[1].type, "card");
});

test("receipt image looks up recent charging sessions before saving", async () => {
  let savedMatch;
  const fields = { energy_kwh: 20, amount_cny: 30, charged_at: "19:30", confidence: 0.9 };
  const chargingMatch = { status: "matched", selected_process_id: "10", candidates: [] };
  const result = await handleImage({ message_id: "om_match", content: "img_match" }, {
    feedbackAttempts: 1,
    downloadMessageImage: async () => "/tmp/receipt.png",
    analyzeChargingReceipt: async () => fields,
    validateReceipt: () => null,
    getRecentChargingProcesses: async () => [{ id: 10 }],
    matchReceiptToChargingProcesses: (actualFields, processes) => {
      assert.equal(actualFields, fields);
      assert.equal(processes.length, 1);
      return chargingMatch;
    },
    savePendingReceipt: async ({ chargingMatch: actual }) => {
      savedMatch = actual;
      return { id: "receipt", fields, charging_match: actual };
    },
    buildReceiptCard: () => ({ schema: "2.0" }),
    replyText: async () => {},
    replyCard: async () => {}
  });
  assert.equal(result.status, "success");
  assert.equal(savedMatch, chargingMatch);
});

test("choosing a charging-session candidate persists it and refreshes the card", async () => {
  const sent = [];
  const receipt = { id: "receipt", fields: {}, charging_match: { status: "matched" } };
  const result = await handleReceiptMatchAction({
    chat_id: "chat",
    event_id: "event",
    receipt_id: "receipt",
    process_id: "10"
  }, {
    selectReceiptChargingMatch: async (receiptId, processId) => {
      assert.equal(receiptId, "receipt");
      assert.equal(processId, "10");
      return receipt;
    },
    buildReceiptCard: () => ({ schema: "2.0" }),
    sendCard: async (_chatId, card) => sent.push(card),
    sendText: async () => {}
  });
  assert.equal(result.status, "matched");
  assert.equal(sent.length, 1);
});

test("receipt image gets explicit failure feedback when recognition throws", async () => {
  const feedback = [];
  const result = await handleImage({ message_id: "om_failure", content: "img_failure" }, {
    feedbackAttempts: 1,
    downloadMessageImage: async () => "/tmp/receipt.png",
    analyzeChargingReceipt: async () => {
      const error = new Error("invalid JSON");
      error.code = "KIMI_HTTP_JSON";
      throw error;
    },
    replyText: async (_messageId, text) => feedback.push(text)
  });
  assert.equal(result.status, "failed");
  assert.equal(result.phase, "recognition");
  assert.match(feedback[0], /已收到/);
  assert.match(feedback[1], /识别失败/);
  assert.match(feedback[1], /不会入账/);
});

test("receipt confirmation retries user feedback after the ledger is updated", async () => {
  let feedbackAttempts = 0;
  const result = await handleReceiptAction({
    chat_id: "chat",
    event_id: "event",
    action: "confirm_receipt",
    receipt_id: "receipt"
  }, {
    setReceiptStatus: async () => ({ fields: { amount_cny: 21.85, energy_kwh: 15.72 } }),
    sendText: async () => {
      feedbackAttempts += 1;
      if (feedbackAttempts === 1) throw new Error("temporary Feishu failure");
    }
  });

  assert.equal(result.status, "confirmed");
  assert.equal(feedbackAttempts, 2);
});

test("receipt confirmation reports a ledger failure without claiming success", async () => {
  const feedback = [];
  const result = await handleReceiptAction({
    chat_id: "chat",
    event_id: "event",
    action: "confirm_receipt",
    receipt_id: "receipt"
  }, {
    setReceiptStatus: async () => { throw new Error("disk full"); },
    sendText: async (_chatId, text) => feedback.push(text)
  });

  assert.equal(result.status, "failed");
  assert.match(feedback[0], /记账失败/);
  assert.doesNotMatch(feedback[0], /已记账/);
});
