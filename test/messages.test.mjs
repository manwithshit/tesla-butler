import test from "node:test";
import assert from "node:assert/strict";
import { handleImage, isImageLikeMessage } from "../src/bot.mjs";

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
    savePendingReceipt: async () => ({ id: "receipt", fields }),
    buildReceiptCard: () => ({ schema: "2.0" }),
    replyText: async (_messageId, text) => feedback.push({ type: "text", text }),
    replyCard: async () => feedback.push({ type: "card" })
  });
  assert.equal(result.status, "success");
  assert.match(feedback[0].text, /已收到/);
  assert.equal(feedback[1].type, "card");
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
