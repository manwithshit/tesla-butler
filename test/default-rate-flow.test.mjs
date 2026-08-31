import test from "node:test";
import assert from "node:assert/strict";
import {
  handleCardEvent,
  handleDefaultRateSubmission,
  handleMessageEvent,
  maybeShowDefaultRateOnboarding
} from "../src/bot.mjs";

test("the first menu onboarding sends the form before marking it as shown", async () => {
  const calls = [];
  const result = await maybeShowDefaultRateOnboarding({ chatId: "chat" }, {
    getPricingSettings: async () => ({ default_rate_history: [] }),
    getDefaultRatePromptedAt: async () => null,
    buildDefaultElectricityPriceCard: () => ({ kind: "form" }),
    sendFormCard: async () => calls.push("send"),
    markDefaultRatePrompted: async () => calls.push("mark")
  });

  assert.equal(result.status, "prompted");
  assert.deepEqual(calls, ["send", "mark"]);
});

test("onboarding does not repeat after a rate exists or the one-time prompt was shown", async () => {
  let sends = 0;
  const dependencies = {
    buildDefaultElectricityPriceCard: () => ({}),
    sendFormCard: async () => { sends += 1; },
    markDefaultRatePrompted: async () => {}
  };
  const set = await maybeShowDefaultRateOnboarding({ chatId: "chat" }, {
    ...dependencies,
    getPricingSettings: async () => ({ default_rate_history: [{ price_cny_per_kwh: 0.6 }] }),
    getDefaultRatePromptedAt: async () => null
  });
  const prompted = await maybeShowDefaultRateOnboarding({ chatId: "chat" }, {
    ...dependencies,
    getPricingSettings: async () => ({ default_rate_history: [] }),
    getDefaultRatePromptedAt: async () => "2026-08-31T00:00:00.000Z"
  });

  assert.equal(set.status, "already_set");
  assert.equal(prompted.status, "already_prompted");
  assert.equal(sends, 0);
});

test("a failed onboarding card send is not marked as shown", async () => {
  let marked = false;
  await assert.rejects(() => maybeShowDefaultRateOnboarding({ chatId: "chat" }, {
    getPricingSettings: async () => ({ default_rate_history: [] }),
    getDefaultRatePromptedAt: async () => null,
    buildDefaultElectricityPriceCard: () => ({}),
    sendFormCard: async () => { throw new Error("temporary send failure"); },
    markDefaultRatePrompted: async () => { marked = true; }
  }));
  assert.equal(marked, false);
});

test("concurrent menu onboarding calls send and mark at most once", async () => {
  let promptedAt = null;
  let sends = 0;
  let marks = 0;
  let releaseSend;
  const sendStarted = new Promise((resolve) => { releaseSend = resolve; });
  let unblockSend;
  const sendBlocked = new Promise((resolve) => { unblockSend = resolve; });
  const dependencies = {
    getPricingSettings: async () => ({ default_rate_history: [] }),
    getDefaultRatePromptedAt: async () => promptedAt,
    buildDefaultElectricityPriceCard: () => ({ kind: "form" }),
    sendFormCard: async () => {
      sends += 1;
      releaseSend();
      await sendBlocked;
    },
    markDefaultRatePrompted: async () => {
      marks += 1;
      promptedAt = "2026-08-31T00:00:00.000Z";
    }
  };

  const first = maybeShowDefaultRateOnboarding({ chatId: "chat" }, dependencies);
  await sendStarted;
  const second = maybeShowDefaultRateOnboarding({ chatId: "chat" }, dependencies);
  unblockSend();

  assert.deepEqual(await Promise.all([first, second]), [
    { status: "prompted" },
    { status: "already_prompted" }
  ]);
  assert.equal(sends, 1);
  assert.equal(marks, 1);
});

test("onboarding remains retryable after a serialized send failure", async () => {
  let promptedAt = null;
  let sends = 0;
  const dependencies = {
    getPricingSettings: async () => ({ default_rate_history: [] }),
    getDefaultRatePromptedAt: async () => promptedAt,
    buildDefaultElectricityPriceCard: () => ({ kind: "form" }),
    sendFormCard: async () => {
      sends += 1;
      if (sends === 1) throw new Error("temporary send failure");
    },
    markDefaultRatePrompted: async () => {
      promptedAt = "2026-08-31T00:00:00.000Z";
    }
  };

  await assert.rejects(
    maybeShowDefaultRateOnboarding({ chatId: "chat" }, dependencies),
    /temporary send failure/
  );
  assert.deepEqual(
    await maybeShowDefaultRateOnboarding({ chatId: "chat" }, dependencies),
    { status: "prompted" }
  );
  assert.equal(sends, 2);
});

test("a valid form submission saves one rate and gives explicit feedback", async () => {
  const feedback = [];
  const result = await handleDefaultRateSubmission({
    chat_id: "chat",
    event_id: "event",
    form_value: '{"default_rate":"0.6088"}'
  }, {
    getPricingSettings: async () => ({ default_rate_history: [] }),
    setDefaultElectricityRate: async (rate, options) => {
      assert.equal(rate, 0.6088);
      assert.equal(options.source, "user_feishu_form");
      return { default_rate_history: [{ price_cny_per_kwh: rate }] };
    },
    sendText: async (_chatId, text) => feedback.push(text)
  });

  assert.equal(result.status, "saved");
  assert.match(feedback[0], /¥0\.6088\/度/);
  assert.match(feedback[0], /首次设置会补算/);
});

test("a later rate change says it affects only future trips", async () => {
  const feedback = [];
  const result = await handleDefaultRateSubmission({
    chat_id: "chat",
    event_id: "event",
    rate: 0.8
  }, {
    getPricingSettings: async () => ({
      default_rate_history: [{ price_cny_per_kwh: 0.6 }]
    }),
    setDefaultElectricityRate: async () => ({
      default_rate_history: [
        { price_cny_per_kwh: 0.6 },
        { price_cny_per_kwh: 0.8 }
      ]
    }),
    sendText: async (_chatId, text) => feedback.push(text)
  });

  assert.equal(result.status, "saved");
  assert.match(feedback[0], /只影响之后开始的新行程/);
  assert.doesNotMatch(feedback[0], /首次设置会补算/);
});

test("an invalid form value never writes and clearly says it was not saved", async () => {
  let writes = 0;
  const feedback = [];
  const result = await handleDefaultRateSubmission({
    chat_id: "chat",
    event_id: "event",
    form_value: '{"default_rate":"1e-2"}'
  }, {
    setDefaultElectricityRate: async () => { writes += 1; },
    sendText: async (_chatId, text) => feedback.push(text)
  });

  assert.equal(result.status, "invalid");
  assert.equal(writes, 0);
  assert.match(feedback[0], /未保存/);
  assert.match(feedback[0], /0 到 10/);
});

test("feedback failure after a successful save never falsely claims the rate was not updated", async () => {
  const attempted = [];
  await assert.rejects(() => handleDefaultRateSubmission({
    chat_id: "chat",
    event_id: "event",
    form_value: '{"default_rate":"0.60"}'
  }, {
    getPricingSettings: async () => ({ default_rate_history: [] }),
    setDefaultElectricityRate: async () => ({ default_rate_history: [{ price_cny_per_kwh: 0.6 }] }),
    sendText: async (_chatId, text) => {
      attempted.push(text);
      throw new Error("temporary Feishu failure");
    }
  }));

  assert.equal(attempted.length, 2);
  assert.ok(attempted.every((text) => /已保存/.test(text)));
  assert.ok(attempted.every((text) => !/没有更新/.test(text)));
});

test("only the exact form submit action is routed to the rate handler", async () => {
  const submissions = [];
  await handleCardEvent({
    chat_id: "chat",
    event_id: "event",
    action_name: "default_electricity_rate_submit",
    form_value: '{"default_rate":"0.60"}',
    action_value: ""
  }, {
    registerChat: async () => {},
    handleDefaultRateSubmission: async (event) => submissions.push(event),
    runAction: async () => assert.fail("form submit must not run a menu action")
  });

  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].form_value, '{"default_rate":"0.60"}');
});

test("plain numbers remain ordinary unknown messages while explicit price text is accepted", async () => {
  const replies = [];
  const submissions = [];
  const common = {
    sender_type: "user",
    chat_type: "p2p",
    message_type: "text",
    chat_id: "chat"
  };
  const dependencies = {
    registerChat: async () => {},
    replyText: async (_messageId, text) => replies.push(text),
    handleDefaultRateSubmission: async (event) => submissions.push(event),
    runAction: async () => {}
  };

  await handleMessageEvent({ ...common, message_id: "plain", content: "0.60" }, dependencies);
  await handleMessageEvent({ ...common, message_id: "price", content: "设置默认电价 0.60 元/度" }, dependencies);

  assert.equal(replies.length, 1);
  assert.match(replies[0], /可用指令/);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].rate, 0.6);
});

test("a question containing a possible default rate never mutates settings", async () => {
  const replies = [];
  const submissions = [];

  await handleMessageEvent({
    sender_type: "user",
    chat_type: "p2p",
    message_type: "text",
    chat_id: "chat",
    message_id: "question",
    content: "默认电价 0.60？"
  }, {
    registerChat: async () => {},
    replyText: async (_messageId, text) => replies.push(text),
    handleDefaultRateSubmission: async (event) => submissions.push(event),
    runAction: async () => {}
  });

  assert.equal(submissions.length, 0);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /可用指令/);
});

test("menu messages carry the registered chat into the onboarding-capable action", async () => {
  const actions = [];
  await handleMessageEvent({
    sender_type: "user",
    chat_type: "p2p",
    message_type: "text",
    chat_id: "chat",
    message_id: "message",
    content: "菜单"
  }, {
    registerChat: async () => {},
    runAction: async (action, context) => actions.push({ action, context })
  });

  assert.deepEqual(actions, [{
    action: "menu",
    context: { messageId: "message", chatId: "chat" }
  }]);
});

test("typing default electricity price opens the same settings entry", async () => {
  const actions = [];
  await handleMessageEvent({
    sender_type: "user",
    chat_type: "p2p",
    message_type: "text",
    chat_id: "chat",
    message_id: "message",
    content: "默认电价"
  }, {
    registerChat: async () => {},
    runAction: async (action, context) => actions.push({ action, context })
  });

  assert.deepEqual(actions, [{
    action: "default_electricity_price",
    context: { messageId: "message", chatId: "chat" }
  }]);
});

test("typing 设置默认电价 opens the same settings entry", async () => {
  const actions = [];
  await handleMessageEvent({
    sender_type: "user",
    chat_type: "p2p",
    message_type: "text",
    chat_id: "chat",
    message_id: "message",
    content: "设置默认电价"
  }, {
    registerChat: async () => {},
    replyText: async () => assert.fail("the visible menu label must also work as a text command"),
    runAction: async (action, context) => actions.push({ action, context })
  });

  assert.deepEqual(actions, [{
    action: "default_electricity_price",
    context: { messageId: "message", chatId: "chat" }
  }]);
});
