import test from "node:test";
import assert from "node:assert/strict";
import {
  assertCard,
  buildChargingStatusCard,
  buildLatestTripCard,
  buildMenuCard,
  buildPeriodReportCard,
  buildReceiptCard,
  buildUploadHelpCard,
  buildVehicleOverviewCard
} from "../src/cards.mjs";
import { calculateFuelComparisons } from "../src/comparisons.mjs";

test("menu card passes Card 2.0 structural gates", () => {
  const card = assertCard(buildMenuCard({
    battery_level: 70,
    rated_range_km: 356,
    state: "offline",
    updated_at: "2026-08-25T01:15:00.000"
  }, { now: new Date("2026-08-25T01:20:00.000Z") }));
  assert.equal(card.config.width_mode, "default");
  assert.match(JSON.stringify(card), /latest_trip/);
  assert.match(JSON.stringify(card), /weekly_report/);
  assert.match(JSON.stringify(card), /monthly_report/);
  assert.match(JSON.stringify(card), /vehicle_overview/);
  assert.match(JSON.stringify(card), /上次行程/);
  assert.doesNotMatch(JSON.stringify(card), /最近行程/);
  assert.match(JSON.stringify(card), /本周账单/);
  assert.match(JSON.stringify(card), /本月账单/);
  assert.doesNotMatch(JSON.stringify(card), /本周小结|本月小结/);
  assert.doesNotMatch(JSON.stringify(card), /upload_receipt_help/);
  assert.doesNotMatch(JSON.stringify(card), /trip_statistics/);
  assert.match(JSON.stringify(card), /电量 70%.*356 km/);
  assert.match(JSON.stringify(card), /车辆离线.*更新于 09:15/);
});

test("menu marks stale battery data as last recorded", () => {
  const card = buildMenuCard({
    battery_level: 70,
    state: "asleep",
    updated_at: "2026-08-25T00:00:00.000"
  }, { now: new Date("2026-08-25T01:20:00.000Z") });
  assert.match(JSON.stringify(card), /最后记录.*08:00/);
});

test("all read-only result cards pass Card 2.0 structural gates", () => {
  const stats = {
    trip_count: 3, distance_km: 42.1, duration_min: 61,
    average_distance_km: 14, max_speed_kmh: 88, estimated_kwh: 6.4
  };
  const cards = [
    buildLatestTripCard(null),
    buildLatestTripCard({ distance_km: 12.3, duration_min: 21, estimated_kwh: 2.2 }),
    buildPeriodReportCard({ period: "week", trips: stats, receipts: { count: 0, amount_cny: 0, energy_kwh: 0 }, comparisons: calculateFuelComparisons(stats.distance_km) }),
    buildVehicleOverviewCard({ battery_level: 80, rated_range_km: 400, odometer_km: 1000, state: "online" }, stats),
    buildUploadHelpCard()
  ];
  for (const card of cards) assertCard(card);
});

test("latest trip card names coarse start and end roads without exposing coordinates", () => {
  const card = assertCard(buildLatestTripCard({
    distance_km: 4.6,
    duration_min: 15,
    estimated_kwh: 0.98,
    estimated_cost_cny: 1.36,
    energy_source: "power_integration",
    start_at: "2026-08-24T10:00:00.000Z",
    end_at: "2026-08-24T10:15:00.000Z",
    start_road: "金鸡路",
    end_road: "新宁路",
    start_area: "Xiaoshan District",
    end_area: "Xiaoshan District"
  }, "img_route", true, { hasBasemap: true, hasEnergyOverlay: true }));
  const text = JSON.stringify(card);
  assert.match(text, /金鸡路.*新宁路/);
  assert.doesNotMatch(text, /所在区域|萧山区/);
  assert.match(text, /估算花销/);
  assert.match(text, /¥1\.36/);
  assert.match(text, /估算电耗/);
  assert.match(text, /0\.98 度/);
  assert.match(text, /行程时间.*8月24日 18:00.*18:15/);
  assert.doesNotMatch(text, /出发时间|结束时间/);
  assert.doesNotMatch(text, /本次驾驶建议|少急加速|提前松电门/);
  assert.doesNotMatch(text, /先积累|单次路况|单次路程/);
  assert.doesNotMatch(text, /耗电口径|WGS-84|GCJ-02|高德地图|地图底图/);
  assert.doesNotMatch(text, /返回菜单/);
  assert.doesNotMatch(text, /"(?:latitude|longitude|lat|lng)"\s*:/);
});

test("latest trip card keeps both dates when a trip crosses midnight", () => {
  const card = assertCard(buildLatestTripCard({
    distance_km: 8.2,
    duration_min: 25,
    start_at: "2026-08-24T15:50:00.000Z",
    end_at: "2026-08-24T16:15:00.000Z",
    start_road: "金鸡路",
    end_road: "新宁路"
  }));
  assert.match(JSON.stringify(card), /行程时间.*8月24日 23:50.*8月25日 00:15/);
});

test("latest trip card treats TeslaMate timestamps without an offset as UTC and displays Shanghai time", () => {
  const card = assertCard(buildLatestTripCard({
    distance_km: 12.2,
    duration_min: 38,
    start_at: "2026-08-25T08:15:25.478",
    end_at: "2026-08-25T08:53:48.000",
    start_road: "起点道路",
    end_road: "终点道路"
  }));

  assert.match(JSON.stringify(card), /行程时间.*8月25日 16:15.*16:53/);
});

test("latest trip card hides driving advice when no reliable insight is available", () => {
  const card = buildLatestTripCard({
    distance_km: 12.3,
    duration_min: 28,
    start_at: "2026-08-27T00:00:00Z",
    end_at: "2026-08-27T00:28:00Z"
  }, "img_route", true, { hasEnergyOverlay: true });

  assert.doesNotMatch(JSON.stringify(card), /本次驾驶建议/);
});

test("latest trip card shows one short fact-backed driving template", () => {
  const card = buildLatestTripCard({
    distance_km: 12.3,
    duration_min: 28,
    start_at: "2026-08-27T00:00:00Z",
    end_at: "2026-08-27T00:28:00Z"
  }, "img_route", true, {
    advice: {
      title: "🛣️ 一路丝滑",
      detail: "这趟开车过程中，车停住的时间一共 2 分钟，平时类似行程约 6 分钟。今天少停了 4 分钟，一路更顺。"
    }
  });
  const text = JSON.stringify(card);

  assert.match(text, /本次驾驶建议/);
  assert.match(text, /一路丝滑/);
  assert.match(text, /车停住的时间一共 2 分钟/);
  assert.match(text, /平时类似行程约 6 分钟/);
  assert.match(text, /今天少停了 4 分钟/);
});

test("latest trip card distinguishes a map-generation failure from having no trip", () => {
  const card = assertCard(buildLatestTripCard({
    distance_km: 12.2,
    duration_min: 38,
    start_at: "2026-08-25T08:15:25.478",
    end_at: "2026-08-25T08:53:48.000",
    start_road: "起点道路",
    end_road: "终点道路"
  }, null, true, { failureStage: "upload" }));
  const text = JSON.stringify(card);

  assert.match(text, /地图生成失败，可重新点击/);
  assert.doesNotMatch(text, /完成第一段行程后自动出现/);
});

test("trip and period KPI groups stay compact on mobile", () => {
  const trip = assertCard(buildLatestTripCard({
    distance_km: 8.2,
    duration_min: 25,
    estimated_kwh: 1.6,
    estimated_cost_cny: 2.22
  }));
  assert.equal(trip.body.elements[0].tag, "column_set");
  assert.equal(trip.body.elements[0].flex_mode, "none");
  assert.equal(trip.body.elements[0].columns.length, 4);
  for (const column of trip.body.elements[0].columns) {
    assert.equal(column.width, "weighted");
    assert.equal(column.weight, 1);
    assert.equal(column.padding, "8px 4px");
  }
  assert.equal(trip.body.elements[2].tag, "div");
  assert.equal(trip.body.elements[2].fields.length, 2);
  assert.equal(trip.body.elements[2].fields.every((item) => item.is_short), true);

  const stats = { trip_count: 4, distance_km: 9.4, duration_min: 39, estimated_kwh: 2.27 };
  for (const period of ["week", "month"]) {
    const card = assertCard(buildPeriodReportCard({
      period,
      trips: stats,
      tripElectricCost: 3.16,
      receipts: {},
      comparisons: calculateFuelComparisons(stats.distance_km, 3.16)
    }));
    assert.equal(card.body.elements[0].tag, "column_set");
    assert.equal(card.body.elements[0].flex_mode, "trisect");
    assert.equal(card.body.elements[0].columns.length, 3);
    assert.equal(card.body.elements[0].columns.every((column) => column.padding === "8px 4px"), true);
  }
});

test("vehicle overview has no return-menu button and formats odometer", () => {
  const card = buildVehicleOverviewCard({
    battery_level: 70,
    rated_range_km: 286,
    odometer_km: 77096,
    state: "offline",
    inside_temp_c: 32.1,
    outside_temp_c: 29
  }, { trip_count: 4, distance_km: 9.4, duration_min: 39 });
  const text = JSON.stringify(card);
  assert.doesNotMatch(text, /返回菜单|"action":"menu"/);
  assert.match(text, /77,096 km/);
  const metrics = card.body.elements[0];
  assert.equal(metrics.flex_mode, "bisect");
  assert.equal(metrics.columns.length, 2);
  assert.equal(metrics.columns[0].padding, metrics.columns[1].padding);
  assert.equal(metrics.columns[0].vertical_spacing, metrics.columns[1].vertical_spacing);
  assert.equal(metrics.columns[0].elements[0].text_size, metrics.columns[1].elements[0].text_size);
});

test("monthly main route is shown before the oil-cost chart", () => {
  const stats = { trip_count: 12, distance_km: 186.4, duration_min: 322, estimated_kwh: 31.2 };
  const card = buildPeriodReportCard({
    period: "month",
    trips: stats,
    tripElectricCost: 43.37,
    receipts: {},
    comparisons: calculateFuelComparisons(stats.distance_km, 43.37),
    mainRoute: { image_key: "img_route", label: "金鸡路 ↔ 新宁路", trip_count: 8, distance_km: 86.2 }
  });
  const tags = card.body.elements.map((element) => element.tag);
  assert.ok(tags.indexOf("img") < tags.indexOf("chart"));
});

test("receipt confirmation card has one primary action", () => {
  const card = assertCard(buildReceiptCard({
    id: "abc123",
    fields: { amount_cny: 12.34, energy_kwh: 8, charged_at: "2026-08-24 09:30", provider: "测试充电", confidence: 0.98 }
  }));
  assert.match(JSON.stringify(card), /confirm_receipt/);
  assert.match(JSON.stringify(card), /ignore_receipt/);
});

test("receipt confirmation card separates electricity fee and service fee", () => {
  const card = assertCard(buildReceiptCard({
    id: "fee-breakdown",
    fields: {
      amount_cny: 21.85,
      energy_kwh: 15.72,
      energy_source: "derived_all_in_price",
      electricity_fee_cny: 13.36,
      service_fee_cny: 8.49,
      electricity_unit_price_cny_per_kwh: 0.85,
      service_unit_price_cny_per_kwh: 0.54,
      all_in_unit_price_cny_per_kwh: 1.39,
      charged_at: "2026-08-24 19:29",
      provider: null,
      confidence: 0.9
    }
  }));
  const text = JSON.stringify(card);
  assert.match(text, /电费.*13\.36/);
  assert.match(text, /服务费.*8\.49/);
  assert.match(text, /综合单价.*1\.39/);
  assert.match(text, /39%/);
  assert.match(text, /按综合单价换算/);
});

test("receipt card identifies local OCR and K3 fallback sources", () => {
  const base = {
    id: "receipt-source",
    fields: {
      amount_cny: 21.85,
      energy_kwh: 15.72,
      electricity_fee_cny: 13.36,
      service_fee_cny: 8.49,
      electricity_unit_price_cny_per_kwh: 0.85,
      service_unit_price_cny_per_kwh: 0.54,
      all_in_unit_price_cny_per_kwh: 1.39,
      charged_at: "19:29",
      provider: null,
      confidence: 1,
      recognition_source: "apple_vision"
    }
  };
  const local = JSON.stringify(buildReceiptCard(base));
  assert.match(local, /本地识别/);
  assert.match(local, /字段完整度/);
  const fallback = JSON.stringify(buildReceiptCard({ ...base, fields: { ...base.fields, recognition_source: "k3_fallback" } }));
  assert.match(fallback, /K3 增强识别/);
  assert.match(fallback, /识别置信度/);
});

test("period report highlights distance, energy and trip cost above an oil-cost chart", () => {
  const trips = {
    trip_count: 4,
    distance_km: 9.4,
    duration_min: 39,
    average_distance_km: 2.3,
    max_speed_kmh: 69,
    estimated_kwh: 2.27,
    energy_source: "power_integration"
  };
  const card = assertCard(buildPeriodReportCard({
    period: "week",
    trips,
    tripElectricCost: 3.16,
    receipts: {
      count: 1,
      amount_cny: 21.85,
      energy_kwh: 15.72,
      electricity_fee_cny: 13.36,
      service_fee_cny: 8.49,
      all_in_unit_price_cny_per_kwh: 1.39
    },
    comparisons: calculateFuelComparisons(trips.distance_km, 3.16)
  }));
  const text = JSON.stringify(card);
  assert.match(text, /9\.4 km/);
  assert.match(text, /累计行程/);
  assert.match(text, /2\.27 度/);
  assert.match(text, /累计耗电/);
  assert.match(text, /¥3\.16/);
  assert.match(text, /花费金额/);
  assert.match(text, /"tag":"chart"/);
  assert.match(text, /本周截至当前/);
  assert.match(text, /同样跑 9\.4 km.*预计花费/);
  assert.doesNotMatch(text, /服务费|综合电价|实际充电支出/);
  assert.doesNotMatch(text, /返回菜单/);
  assert.doesNotMatch(text, /¥-/);
  assert.doesNotMatch(text, /\d+\.\d+ L/);

  const chart = card.body.elements.find((element) => element.tag === "chart");
  const maximumCost = Math.max(...chart.chart_spec.data.values.map((item) => item.cost));
  const valueAxis = chart.chart_spec.axes.find((axis) => axis.orient === "bottom");
  assert.ok(valueAxis.max >= maximumCost * 1.12);
  const note = card.body.elements.at(-1).content;
  assert.match(note, /^<font color='grey'>\*油价根据今日统一参考价预估；受地区、油站及优惠影响，结果可能存在偏差。\*<\/font>$/);
  assert.doesNotMatch(note, /日产轩逸|多花|2026-|演示油价/);
});

test("current month subtitle is explicit about month-to-date", () => {
  const trips = { trip_count: 1, distance_km: 4.6, duration_min: 15, estimated_kwh: 0.98 };
  const card = assertCard(buildPeriodReportCard({
    period: "month",
    trips,
    tripElectricCost: 1.36,
    receipts: {},
    comparisons: calculateFuelComparisons(trips.distance_km, 1.36)
  }));
  assert.equal(card.header.subtitle.content, "本月截至当前");
});

test("period chart labels keep theme-adaptive fill without dark-mode glow", () => {
  const trips = {
    trip_count: 12,
    distance_km: 186.4,
    duration_min: 322,
    estimated_kwh: 31.2
  };
  const card = assertCard(buildPeriodReportCard({
    period: "week",
    trips,
    tripElectricCost: 43.37,
    receipts: {},
    comparisons: calculateFuelComparisons(trips.distance_km, 43.37)
  }));
  const chart = card.body.elements.find((element) => element.tag === "chart");
  assert.deepEqual(chart.chart_spec.label.style, {
    fontWeight: 500,
    stroke: "transparent",
    lineWidth: 0,
    strokeOpacity: 0
  });
  assert.equal("fill" in chart.chart_spec.label.style, false);
});

test("simulated period report is visibly labelled", () => {
  const trips = {
    trip_count: 12,
    distance_km: 186.4,
    duration_min: 322,
    estimated_kwh: 31.2,
    energy_source: "power_integration"
  };
  const card = assertCard(buildPeriodReportCard({
    period: "week",
    trips,
    tripElectricCost: 43.37,
    receipts: {
      count: 2,
      amount_cny: 67.42,
      energy_kwh: 48.5,
      service_fee_cny: 25.78,
      all_in_unit_price_cny_per_kwh: 1.39
    },
    comparisons: calculateFuelComparisons(trips.distance_km, 43.37),
    isSimulation: true
  }));
  assert.match(JSON.stringify(card), /模拟数据/);
});

test("monthly report labels a repeated corridor as 本月主跑路线", () => {
  const trips = { trip_count: 12, distance_km: 186.4, duration_min: 322, estimated_kwh: 31.2 };
  const card = assertCard(buildPeriodReportCard({
    period: "month",
    trips,
    tripElectricCost: 43.37,
    receipts: {},
    comparisons: calculateFuelComparisons(trips.distance_km, 43.37),
    mainRoute: {
      label: "金鸡路 ↔ 新宁路",
      trip_count: 8,
      distance_km: 86.2,
      image_key: "img_main_route"
    }
  }));
  const text = JSON.stringify(card);
  assert.match(text, /本月主跑路线/);
  assert.match(text, /金鸡路.*新宁路.*8 次.*86\.2 km/);
  assert.match(text, /img_main_route/);
});

test("vehicle overview hides raw TeslaMate model and trim badges", () => {
  const card = assertCard(buildVehicleOverviewCard({
    model: "SR",
    trim: "50",
    battery_level: 70,
    rated_range_km: 286,
    state: "online"
  }, { trip_count: 4, distance_km: 9.4, duration_min: 39 }));
  assert.equal(card.header.subtitle.content, "最新车辆状态");
  assert.doesNotMatch(JSON.stringify(card), /SR 50/);
});

test("charging cards clearly describe configured limit and simulation", () => {
  const started = assertCard(buildChargingStatusCard("started", {
    battery_level: 42,
    charge_limit_soc: 80,
    charger_power: 48.9,
    time_to_full_charge: 0.6
  }, { isSimulation: true }));
  const near = assertCard(buildChargingStatusCard("near_limit", {
    battery_level: 77,
    charge_limit_soc: 80,
    charger_power: 11,
    time_to_full_charge: 0.2
  }, { isSimulation: true }));
  const startedText = JSON.stringify(started);
  const nearText = JSON.stringify(near);
  for (const pattern of [/正在充电/, /42%/, /80%/, /48\.9 kW/, /36 分钟/, /模拟数据/]) {
    assert.match(startedText, pattern);
  }
  for (const pattern of [/即将完成充电/, /12 分钟/, /80% 充电上限/, /模拟数据/]) {
    assert.match(nearText, pattern);
  }
  assert.doesNotMatch(JSON.stringify(near), /即将充满/);
});

test("completed charging card reports the actual session and asks for the bill", () => {
  const card = assertCard(buildChargingStatusCard("completed", {
    start_at: "2026-08-25T06:35:49Z",
    end_at: "2026-08-25T06:56:39Z",
    start_battery_level: 64,
    end_battery_level: 97,
    charge_energy_added: 17,
    duration_min: 21
  }, { isSimulation: true }));
  const text = JSON.stringify(card);
  for (const pattern of [/充电已结束/, /17(?:\.0+)? kWh/, /64% → 97%/, /21 分钟/, /14:35 → 14:56/, /发送充电账单截图/]) {
    assert.match(text, pattern);
  }
  assert.doesNotMatch(text, /返回菜单/);
  assert.match(text, /模拟数据/);
});
