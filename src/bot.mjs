import fs from "node:fs/promises";
import path from "node:path";
import { config, projectPath } from "./config.mjs";
import { runFile } from "./lib/process.mjs";
import { analyzeChargingReceipt, validateReceipt } from "./receipt-recognizer.mjs";
import {
  assertCard,
  buildChargingStatusCard,
  buildLatestTripCard,
  buildMenuCard,
  buildPeriodReportCard,
  buildReceiptCard,
  buildUploadHelpCard,
  buildVehicleOverviewCard
} from "./cards.mjs";
import { calculateFuelComparisons, calculateTripElectricCost } from "./comparisons.mjs";
import { refreshReferenceFuelPrices } from "./fuel-prices.mjs";
import { renderRoutePreview } from "./map.mjs";
import { resolveRouteImage } from "./route-image.mjs";
import {
  getDriveRoute,
  getDriveGroup,
  getDriveGroupRoute,
  getLatestTrip,
  getLatestTripGroup,
  getLatestTripRoute,
  getPeriodRouteCandidates,
  getPeriodTrips,
  getVehicleOverview
} from "./teslamate.mjs";
import {
  getReceiptTotals,
  getRouteImageCache,
  opaqueId,
  registerChat,
  savePendingReceipt,
  setReceiptStatus,
  setRouteImageCacheEntry
} from "./store.mjs";
import { selectMainRoute } from "./routes.mjs";

const textActions = new Map([
  ["菜单", "menu"], ["帮助", "menu"],
  ["最近一程", "latest_trip"], ["最近", "latest_trip"], ["行程小结", "latest_trip"],
  ["本周", "weekly_report"], ["本周账单", "weekly_report"], ["本周小结", "weekly_report"],
  ["本月", "monthly_report"], ["本月账单", "monthly_report"], ["本月小结", "monthly_report"], ["省了多少", "monthly_report"],
  ["上传充电账单", "upload_receipt_help"],
  ["车辆概览", "vehicle_overview"], ["概览", "vehicle_overview"]
]);

function cliArgs() {
  return ["--profile", config.larkProfile];
}

function idempotency(prefix, value) {
  return `${prefix}-${opaqueId(value)}`.slice(0, 50);
}

async function replyText(messageId, text, key = messageId) {
  await runFile(config.larkCli, [
    ...cliArgs(), "im", "+messages-reply",
    "--message-id", messageId,
    "--text", text,
    "--as", "bot",
    "--idempotency-key", idempotency("reply", key)
  ], { cwd: config.root });
}

async function replyCard(messageId, card, key = messageId) {
  assertCard(card);
  await runFile(config.larkCli, [
    ...cliArgs(), "im", "+messages-reply",
    "--message-id", messageId,
    "--msg-type", "interactive",
    "--content", JSON.stringify(card),
    "--as", "bot",
    "--idempotency-key", idempotency("card", key)
  ], { cwd: config.root });
}

async function sendCard(chatId, card, key) {
  assertCard(card);
  await runFile(config.larkCli, [
    ...cliArgs(), "im", "+messages-send",
    "--chat-id", chatId,
    "--msg-type", "interactive",
    "--content", JSON.stringify(card),
    "--as", "bot",
    "--idempotency-key", idempotency("card", key)
  ], { cwd: config.root });
}

async function sendText(chatId, text, key) {
  await runFile(config.larkCli, [
    ...cliArgs(), "im", "+messages-send",
    "--chat-id", chatId,
    "--text", text,
    "--as", "bot",
    "--idempotency-key", idempotency("send", key)
  ], { cwd: config.root });
}

async function uploadCardImage(imagePath) {
  const relativeImagePath = path.relative(config.root, imagePath);
  const { stdout } = await runFile(config.larkCli, [
    ...cliArgs(), "im", "images", "create",
    "--data", JSON.stringify({ image_type: "message" }),
    "--file", `image=${relativeImagePath}`,
    "--as", "bot"
  ], { cwd: config.root, timeout: 60_000 });
  const parsed = JSON.parse(stdout);
  const imageKey = parsed.image_key || parsed.data?.image_key || parsed.result?.image_key;
  if (!imageKey) throw new Error("Feishu image upload returned no image_key");
  return imageKey;
}

async function makePeriodCard(period) {
  refreshReferenceFuelPrices().catch(() => null);
  const isMonthly = period === "month" || period === "previous_month";
  const [trips, receipts, routeCandidates] = await Promise.all([
    getPeriodTrips(period),
    getReceiptTotals(period),
    isMonthly ? getPeriodRouteCandidates(period) : Promise.resolve(null)
  ]);
  const tripElectricCost = calculateTripElectricCost(trips.estimated_kwh, receipts.all_in_unit_price_cny_per_kwh);
  const comparisons = calculateFuelComparisons(trips.distance_km, tripElectricCost);
  let mainRoute;
  if (isMonthly) {
    mainRoute = selectMainRoute(routeCandidates);
    if (mainRoute) {
      try {
        const route = await getDriveRoute(mainRoute.representative_drive_id);
        const cacheKey = `period-v2-${opaqueId(JSON.stringify({
          period,
          drive: mainRoute.representative_drive_id,
          count: mainRoute.trip_count,
          distance: mainRoute.distance_km
        }))}`;
        const image = await resolveRouteImage({
          cacheKey,
          route,
          labels: {
            start: mainRoute.representative_start_road,
            end: mainRoute.representative_end_road
          }
        }, {
          readCache: getRouteImageCache,
          writeCache: setRouteImageCacheEntry,
          render: renderRoutePreview,
          upload: uploadCardImage,
          log: logRouteImage
        });
        if (image.status !== "success") throw new Error(`period map ${image.failureStage || "failed"}`);
        mainRoute.image_key = image.imageKey;
      } catch {
        mainRoute = null;
      }
    }
  }
  return buildPeriodReportCard({ period, trips, receipts, comparisons, tripElectricCost, mainRoute });
}

async function makeMenuCard() {
  return buildMenuCard(await getVehicleOverview());
}

async function makeLatestTripCard() {
  const trip = await getLatestTripGroup();
  return makeTripGroupCard(trip);
}

function logRouteImage(event) {
  const fields = [
    `status=${event.status}`,
    `stage=${event.stage}`,
    `cache_hit=${Boolean(event.cacheHit)}`,
    ...(Number.isFinite(event.durationMs) ? [`duration_ms=${event.durationMs}`] : []),
    ...(event.code ? [`code=${event.code}`] : [])
  ];
  process.stdout.write(`[${new Date().toISOString()}] route_image ${fields.join(" ")}\n`);
}

async function makeTripGroupCard(trip) {
  const [route, receipts] = await Promise.all([
    trip?.segment_ids?.length ? getDriveGroupRoute(trip.segment_ids) : Promise.resolve([]),
    getReceiptTotals("month")
  ]);
  if (trip) {
    trip.estimated_cost_cny = calculateTripElectricCost(
      trip.estimated_kwh,
      receipts.all_in_unit_price_cny_per_kwh
    );
  }
  if (!trip) return buildLatestTripCard(null);
  const cacheKey = `trip-v2-${opaqueId(JSON.stringify({
    segments: trip.segment_ids || [trip.id],
    endAt: trip.end_at || null
  }))}`;
  const image = await resolveRouteImage({
    cacheKey,
    route,
    labels: {
      start: trip?.start_road,
      end: trip?.end_road
    }
  }, {
    readCache: getRouteImageCache,
    writeCache: setRouteImageCacheEntry,
    render: renderRoutePreview,
    upload: uploadCardImage,
    log: logRouteImage
  });
  return buildLatestTripCard(trip, image.imageKey || null, image.hasRoute, {
    ...image.mapMeta,
    failureStage: image.failureStage
  });
}

function makeSimulatedPeriodCard(period, mainRoute = undefined) {
  const simulations = {
    week: {
      trips: {
        trip_count: 12, distance_km: 186.4, duration_min: 322, average_distance_km: 15.5,
        max_speed_kmh: 94, estimated_kwh: 31.2, drawn_kwh: 36.8,
        regenerated_kwh: 5.6, energy_source: "power_integration"
      },
      receipts: {
        count: 2, amount_cny: 67.42, energy_kwh: 48.5, electricity_fee_cny: 41.64,
        service_fee_cny: 25.78, all_in_unit_price_cny_per_kwh: 1.39
      }
    },
    month: {
      trips: {
        trip_count: 45, distance_km: 842.6, duration_min: 1398, average_distance_km: 18.7,
        max_speed_kmh: 108, estimated_kwh: 142.8, drawn_kwh: 166.5,
        regenerated_kwh: 23.7, energy_source: "power_integration"
      },
      receipts: {
        count: 5, amount_cny: 231.30, energy_kwh: 166.4, electricity_fee_cny: 141.44,
        service_fee_cny: 89.86, all_in_unit_price_cny_per_kwh: 1.39
      }
    }
  };
  const sample = simulations[period];
  if (!sample) throw new Error(`unsupported simulation period: ${period}`);
  const tripElectricCost = calculateTripElectricCost(
    sample.trips.estimated_kwh,
    sample.receipts.all_in_unit_price_cny_per_kwh
  );
  const comparisons = calculateFuelComparisons(sample.trips.distance_km, tripElectricCost);
  return buildPeriodReportCard({
    period,
    ...sample,
    comparisons,
    tripElectricCost,
    isSimulation: true,
    mainRoute
  });
}

async function makeSimulatedMonthlyMainRoute() {
  try {
    const [trip, route] = await Promise.all([getLatestTrip(), getLatestTripRoute()]);
    const preview = await renderRoutePreview(route, "simulated-month-main-route", {
      start: trip?.start_road,
      end: trip?.end_road
    });
    const imageKey = await uploadCardImage(preview.path);
    return {
      label: `${trip?.start_road || "起点道路"} ↔ ${trip?.end_road || "终点道路"}`,
      trip_count: 8,
      distance_km: 86.2,
      image_key: imageKey,
      visual_note: "地图沿用最近真实行程，仅作版式预览；次数和里程为模拟数据。"
    };
  } catch {
    return null;
  }
}

async function deliverCard(context, card, suffix) {
  if (context.messageId) await replyCard(context.messageId, card, `${context.messageId}:${suffix}`);
  else await sendCard(context.chatId, card, `${context.eventId}:${suffix}`);
}

async function runAction(action, context) {
  const started = Date.now();
  let status = "success";
  try {
    if (action === "menu") {
      await deliverCard(context, await makeMenuCard(), "menu");
      return;
    }
    if (action === "latest_trip") {
      await deliverCard(context, await makeLatestTripCard(), "latest");
      return;
    }
    if (action === "weekly_report" || action === "monthly_report") {
      const period = action === "weekly_report" ? "week" : "month";
      await deliverCard(context, await makePeriodCard(period), period);
      return;
    }
    if (action === "upload_receipt_help") {
      await deliverCard(context, buildUploadHelpCard(), "upload");
      return;
    }
    if (action === "vehicle_overview") {
      const [vehicle, stats] = await Promise.all([getVehicleOverview(), getPeriodTrips("month")]);
      await deliverCard(context, buildVehicleOverviewCard(vehicle, stats), "overview");
    }
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    process.stdout.write(`[${new Date().toISOString()}] action name=${action} status=${status} duration_ms=${Date.now() - started}\n`);
  }
}

async function downloadMessageImage(messageId, content) {
  const imageKey = String(content).match(/img_[A-Za-z0-9_-]+/)?.[0];
  if (!imageKey) throw new Error("image key missing from event content");
  const dir = projectPath("data", "raw", "feishu");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stem = opaqueId(messageId);
  for (const file of await fs.readdir(dir)) {
    if (file.startsWith(stem)) return path.join(dir, file);
  }
  await runFile(config.larkCli, [
    ...cliArgs(), "im", "+messages-resources-download",
    "--message-id", messageId,
    "--file-key", imageKey,
    "--type", "image",
    "--output", `data/raw/feishu/${stem}`,
    "--as", "bot"
  ], { cwd: config.root, timeout: 120_000 });
  const downloaded = (await fs.readdir(dir)).find((file) => file.startsWith(stem));
  if (!downloaded) throw new Error("image download completed without output file");
  return path.join(dir, downloaded);
}

async function retryFeedback(operation, attempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastError;
}

function logReceiptFailure(event, phase, error) {
  const code = error?.code || error?.name || "UNKNOWN";
  process.stdout.write(`[${new Date().toISOString()}] receipt failed message=${opaqueId(event.message_id)} phase=${phase} code=${code}\n`);
}

export async function handleImage(event, dependencies = {}) {
  const ops = {
    downloadMessageImage,
    analyzeChargingReceipt,
    validateReceipt,
    savePendingReceipt,
    buildReceiptCard,
    replyText,
    replyCard,
    ...dependencies
  };
  const feedbackAttempts = Math.max(1, dependencies.feedbackAttempts ?? 2);
  let phase = "acknowledgement";

  try {
    await retryFeedback(
      () => ops.replyText(event.message_id, "已收到充电账单，正在识别。识别成功会返回确认卡片，失败也会明确告知。", `${event.message_id}:received`),
      feedbackAttempts
    );
  } catch (error) {
    logReceiptFailure(event, phase, error);
  }

  try {
    phase = "download";
    const imagePath = await ops.downloadMessageImage(event.message_id, event.content);
    phase = "recognition";
    const fields = await ops.analyzeChargingReceipt(imagePath);
    const validationError = ops.validateReceipt(fields);
    if (validationError) {
      phase = "invalid-feedback";
      await retryFeedback(
        () => ops.replyText(event.message_id, `识别失败：${validationError}。本次不会入账，请换一张能看清“实付金额”的充电账单截图。`, `${event.message_id}:invalid-image`),
        feedbackAttempts
      );
      return { status: "invalid" };
    }
    phase = "save";
    const receipt = await ops.savePendingReceipt({
      messageId: event.message_id,
      imagePath: path.relative(config.root, imagePath),
      fields
    });
    phase = "success-feedback";
    await retryFeedback(
      () => ops.replyCard(event.message_id, ops.buildReceiptCard(receipt), `${event.message_id}:receipt`),
      feedbackAttempts
    );
    return { status: "success" };
  } catch (error) {
    logReceiptFailure(event, phase, error);
    const text = phase === "success-feedback"
      ? "识别成功，但确认卡片发送失败。本次不会计入周结或月结，请重新发送这张图片。"
      : "识别失败：这次没有成功读取充电账单。本次不会入账，请稍后重新发送图片。";
    try {
      await retryFeedback(
        () => ops.replyText(event.message_id, text, `${event.message_id}:processing-failed`),
        feedbackAttempts
      );
      return { status: "failed", phase };
    } catch (feedbackError) {
      logReceiptFailure(event, "failure-feedback", feedbackError);
      const terminal = new Error("Receipt processing and failure feedback both failed");
      terminal.code = "RECEIPT_FEEDBACK_FAILED";
      throw terminal;
    }
  }
}

export async function handleMessageEvent(event) {
  if (event.sender_type === "bot" || event.chat_type !== "p2p") return;
  await registerChat(event.chat_id);
  if (isImageLikeMessage(event)) {
    await handleImage(event);
    return;
  }
  if (event.message_type !== "text") {
    await replyText(event.message_id, "目前只接收文字指令和充电账单图片。发送“菜单”查看入口。", `${event.message_id}:unsupported`);
    return;
  }
  const normalized = String(event.content || "").trim().replace(/[？?。！!]/g, "");
  const action = textActions.get(normalized);
  if (!action) {
    await replyText(event.message_id, "可用指令：菜单、行程小结、本周小结、本月小结、车辆概览。也可以直接发送充电账单图片。", `${event.message_id}:unknown`);
    return;
  }
  await runAction(action, { messageId: event.message_id });
}

export async function handleReceiptAction(event, dependencies = {}) {
  const ops = { setReceiptStatus, sendText, ...dependencies };
  const status = event.action === "confirm_receipt" ? "confirmed" : "ignored";
  let receipt;
  try {
    receipt = await ops.setReceiptStatus(event.receipt_id, status);
  } catch (error) {
    await retryFeedback(
      () => ops.sendText(event.chat_id, "记账失败：账单没有写入本地账本，请稍后重新点击。", `${event.event_id}:ledger-failed`),
      2
    );
    return { status: "failed" };
  }
  const text = !receipt
    ? "这条账单不存在或已被清理。"
    : status === "confirmed"
      ? `已记账：¥${Number(receipt.fields.amount_cny).toFixed(2)}${receipt.fields.energy_kwh ? ` / ${receipt.fields.energy_kwh} kWh` : ""}。`
      : "已忽略这张充电账单。";
  await retryFeedback(
    () => ops.sendText(event.chat_id, text, `${event.event_id}:${status}`),
    2
  );
  return { status: receipt ? status : "missing" };
}

export async function handleCardEvent(event) {
  await registerChat(event.chat_id);
  let value = {};
  try {
    value = typeof event.action_value === "string" ? JSON.parse(event.action_value) : (event.action_value || {});
  } catch {
    return;
  }
  const action = value.action;
  if (["menu", "latest_trip", "weekly_report", "monthly_report", "upload_receipt_help", "vehicle_overview"].includes(action)) {
    await runAction(action, { chatId: event.chat_id, eventId: event.event_id });
    return;
  }
  if (action === "confirm_receipt" || action === "ignore_receipt") {
    await handleReceiptAction({
      chat_id: event.chat_id,
      event_id: event.event_id,
      action,
      receipt_id: value.receipt_id
    });
  }
}

export async function sendScheduledReport(chatId, period, key) {
  await sendCard(chatId, await makePeriodCard(period), key);
}

export async function pushPreviewCards(chatId, key = Date.now()) {
  await sendCard(chatId, await makeMenuCard(), `${key}:menu`);
  await sendCard(chatId, await makeLatestTripCard(), `${key}:latest`);
  await sendCard(chatId, await makePeriodCard("week"), `${key}:week`);
  await sendCard(chatId, await makePeriodCard("month"), `${key}:month`);
}

export async function pushReportCards(chatId, key = Date.now()) {
  await sendCard(chatId, await makePeriodCard("week"), `${key}:week`);
  await sendCard(chatId, await makePeriodCard("month"), `${key}:month`);
}

export async function pushRequestedReviewCards(chatId, key = Date.now()) {
  await sendCard(chatId, await makeLatestTripCard(), `${key}:trip-summary`);
  await sendCard(chatId, makeSimulatedPeriodCard("week"), `${key}:simulated-week`);
  await sendCard(chatId, makeSimulatedPeriodCard("month"), `${key}:simulated-month`);
}

export async function pushTechnicalReviewCards(chatId, key = Date.now()) {
  await sendCard(chatId, await makeLatestTripCard(), `${key}:trip-map-energy`);
  await sendCard(chatId, makeSimulatedPeriodCard("week"), `${key}:simulated-week-chart`);
}

export async function pushLatestTripReviewCard(chatId, key = Date.now()) {
  await sendCard(chatId, await makeLatestTripCard(), `${key}:latest-trip-review`);
}

export async function pushWeeklyDarkModeReviewCard(chatId, key = Date.now()) {
  await sendCard(chatId, makeSimulatedPeriodCard("week"), `${key}:weekly-dark-mode-review`);
}

export async function pushMenuReviewCard(chatId, key = Date.now()) {
  await sendCard(chatId, await makeMenuCard(), `${key}:menu-review`);
}

export async function pushVehicleOverviewReviewCard(chatId, key = Date.now()) {
  const [vehicle, stats] = await Promise.all([getVehicleOverview(), getPeriodTrips("month")]);
  await sendCard(chatId, buildVehicleOverviewCard(vehicle, stats), `${key}:overview-review`);
}

export async function sendChargingEvent(chatId, event, key = Date.now(), options = {}) {
  await sendCard(chatId, buildChargingStatusCard(event.type, event.snapshot, options), `${key}:${event.type}`);
}

export async function sendCompletedTrip(chatId, event, key = Date.now()) {
  const trip = await getDriveGroup(event.trip.segment_ids);
  await sendCard(chatId, await makeTripGroupCard(trip), `${key}:trip`);
}

export async function pushApprovedSimulationCards(chatId, key = Date.now()) {
  const mainRoute = await makeSimulatedMonthlyMainRoute();
  await sendCard(chatId, await makeMenuCard(), `${key}:menu-battery`);
  await sendCard(chatId, makeSimulatedPeriodCard("month", mainRoute), `${key}:month-main-route`);
  await sendCard(chatId, buildChargingStatusCard("started", {
    battery_level: 42,
    charge_limit_soc: 80,
    charger_power: 48.9,
    charge_energy_added: 2.8,
    time_to_full_charge: 0.6
  }, { isSimulation: true }), `${key}:charging-started`);
  await sendCard(chatId, buildChargingStatusCard("near_limit", {
    battery_level: 77,
    charge_limit_soc: 80,
    charger_power: 11,
    charge_energy_added: 28.4,
    time_to_full_charge: 0.2
  }, { isSimulation: true }), `${key}:charging-near-limit`);
}

export function isImageLikeMessage(event) {
  if (event.message_type === "image") return true;
  if (event.message_type !== "post") return false;
  return /img_[A-Za-z0-9_-]+/.test(String(event.content || ""));
}
