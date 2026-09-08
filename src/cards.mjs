import {validateReceipt} from './receipt-values.mjs';

function callback(action, extra = {}) {
  return [{ type: "callback", value: { action, ...extra } }];
}

function button(text, action, { primary = false, extra = {} } = {}) {
  return {
    tag: "button",
    text: { tag: "plain_text", content: text },
    type: primary ? "primary_filled" : "default",
    width: "fill",
    behaviors: callback(action, extra)
  };
}

function header(title, subtitle, tag = null, template = "blue") {
  return {
    title: { tag: "plain_text", content: title },
    subtitle: { tag: "plain_text", content: subtitle },
    template,
    icon: { tag: "standard_icon", token: "ai-common_colorful" },
    ...(tag ? { text_tag_list: [{ tag: "text_tag", text: { tag: "plain_text", content: tag }, color: "blue" }] } : {})
  };
}

function cardShell(title, subtitle, summary, elements, { width = "fill", tag = null, template = "blue" } = {}) {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: width,
      summary: { content: summary },
      style: {
        text_size: {
          metric: { default: "heading-3", pc: "heading-2", mobile: "heading-4" }
        }
      }
    },
    header: header(title, subtitle, tag, template),
    body: { direction: "vertical", padding: "12px 12px 20px 12px", vertical_spacing: "12px", elements }
  };
}

function buttonRow(left, right) {
  return {
    tag: "column_set", flex_mode: "bisect", horizontal_spacing: "10px",
    columns: [{ tag: "column", elements: [left] }, { tag: "column", elements: [right] }]
  };
}

function singleButtonRow(item) {
  return buttonRow(item, { tag: "markdown", content: " " });
}

function menuButton() {
  return button("返回菜单", "menu", { primary: true });
}

function formatValue(value, suffix = "") {
  return value === null || value === undefined ? "暂无" : `${value}${suffix}`;
}

function formatInteger(value, suffix = "") {
  if (value === null || value === undefined) return "暂无";
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Number(value))}${suffix}`;
}

function field(label, value, isShort = true) {
  return { is_short: isShort, text: { tag: "lark_md", content: `**${label}**\n${value}` } };
}

function formatDuration(minutes) {
  const total = Math.max(0, Number(minutes) || 0);
  const hours = Math.floor(total / 60);
  const remainder = total % 60;
  return hours > 0 ? `${hours} 小时 ${remainder} 分` : `${remainder} 分钟`;
}

function tripTimeParts(value) {
  if (!value) return "暂无";
  const date = teslaMateDate(value);
  if (!date) return "暂无";
  return Object.fromEntries(new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).map(({ type, value: part }) => [type, part]));
}

function formatTripTimeRange(startValue, endValue) {
  const start = tripTimeParts(startValue);
  const end = tripTimeParts(endValue);
  if (start === "暂无" || end === "暂无") return "暂无";
  const startLabel = `${start.month}月${start.day}日 ${start.hour}:${start.minute}`;
  const sameDay = start.year === end.year && start.month === end.month && start.day === end.day;
  const endLabel = sameDay
    ? `${end.hour}:${end.minute}`
    : `${end.month}月${end.day}日 ${end.hour}:${end.minute}`;
  return `${startLabel} → ${endLabel}`;
}

function teslaMateDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatClock(value) {
  const date = teslaMateDate(value);
  if (!date) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(date);
}

function metricColumn(label, value, { accent = false, compact = false } = {}) {
  return {
    tag: "column",
    background_style: accent ? "blue-50" : "grey-50",
    padding: compact ? "8px 4px" : "12px 6px",
    vertical_spacing: "2px",
    elements: [
      { tag: "markdown", content: `**${accent ? `<font color='blue'>${value}</font>` : value}**`, text_align: "center", text_size: "metric" },
      { tag: "markdown", content: `<font color='grey'>${label}</font>`, text_align: "center", text_size: "notation" }
    ]
  };
}

function metricRow(columns, flexMode, horizontalSpacing = "8px") {
  return {
    tag: "column_set",
    flex_mode: flexMode,
    horizontal_spacing: horizontalSpacing,
    columns: flexMode === "none"
      ? columns.map((column) => ({ ...column, width: "weighted", weight: 1 }))
      : columns
  };
}

function chartAxisMaximum(values) {
  const maximum = Math.max(0, ...values.map((item) => Number(item.cost) || 0));
  if (maximum <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(maximum));
  const step = magnitude / 10;
  return Number((Math.ceil((maximum * 1.35) / step) * step).toPrecision(12));
}

function periodDateParts(value) {
  const date = value instanceof Date ? value : teslaMateDate(value);
  if (!date) return null;
  return Object.fromEntries(new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "numeric",
    day: "numeric"
  }).formatToParts(date).map(({ type, value: part }) => [type, part]));
}

function formatPeriodRange(startValue, endValue) {
  const startDate = teslaMateDate(startValue);
  const endDate = teslaMateDate(endValue);
  if (!startDate || !endDate || endDate <= startDate) return null;
  const start = periodDateParts(startDate);
  const end = periodDateParts(new Date(endDate.getTime() - 1));
  if (!start || !end) return null;
  const startLabel = start.year === end.year
    ? `${start.month}月${start.day}日`
    : `${start.year}年${start.month}月${start.day}日`;
  const endLabel = start.year === end.year
    ? `${end.month}月${end.day}日`
    : `${end.year}年${end.month}月${end.day}日`;
  return `${startLabel}—${endLabel}`;
}

function formatKwh(value) {
  const energy = Number(value);
  if (!Number.isFinite(energy) || energy < 0) return null;
  return energy.toFixed(3).replace(/(?:\.0+|(\.\d*?[1-9])0+)$/, "$1");
}

export function buildMenuCard(vehicle = null, options = {}) {
  const now = options.now || new Date();
  const updatedAt = teslaMateDate(vehicle?.updated_at);
  const fresh = updatedAt && now.getTime() - updatedAt.getTime() <= 10 * 60 * 1000;
  const stateNames = { online: "在线", asleep: "休眠", offline: "离线", driving: "行驶中", charging: "充电中" };
  const battery = vehicle?.battery_level === null || vehicle?.battery_level === undefined ? "等待同步" : `${vehicle.battery_level}%`;
  const range = vehicle?.rated_range_km === null || vehicle?.rated_range_km === undefined ? null : `${vehicle.rated_range_km} km`;
  const status = updatedAt
    ? `车辆${stateNames[vehicle?.state] || vehicle?.state || "状态未知"} · ${fresh ? "更新于" : "最后记录"} ${formatClock(vehicle.updated_at)}`
    : options.vehicleUnavailable ? "车辆状态暂时未取到，菜单功能仍可使用" : "等待 TeslaMate 首次同步";
  return cardShell("特斯拉小管家", "行程、车辆与充电账单", "特斯拉小管家功能菜单", [
    {
      tag: "column_set", flex_mode: "none",
      columns: [{
        tag: "column", width: "weighted", weight: 1, background_style: "blue-50", padding: "12px", vertical_spacing: "4px",
        elements: [
          { tag: "markdown", content: `**电量 ${battery}${range ? ` · 预计续航 ${range}` : ""}**` },
          { tag: "markdown", content: `<font color='grey'>${status}</font>`, text_size: "notation" }
        ]
      }]
    },
    buttonRow(button("上次行程", "latest_trip", { primary: true }), button("车辆概览", "vehicle_overview")),
    buttonRow(button("本周账单", "weekly_report"), button("本月账单", "monthly_report")),
    singleButtonRow(button("设置默认电价", "default_electricity_price")),
    { tag: "markdown", content: "<font color='grey'>充电完成后直接发账单图片，无需先点按钮。</font>", text_size: "notation" }
  ], { width: "default", tag: "本机运行" });
}

export function buildDefaultElectricityPriceCard({ currentRate = null } = {}) {
  const hasCurrentRate = currentRate !== null
    && currentRate !== undefined
    && Number.isFinite(Number(currentRate));
  const formattedRate = hasCurrentRate
    ? new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(Number(currentRate))
    : null;
  const currentRateLabel = formattedRate ? `¥${formattedRate}/度` : "尚未设置";
  return {
    config: { wide_screen_mode: true },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "默认电价设置" }
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: `**当前默认电价**\n${currentRateLabel}` }
      },
      {
        tag: "form",
        name: "default_electricity_price_form",
        elements: [
          {
            tag: "input",
            name: "default_rate",
            label: { tag: "plain_text", content: "默认电价（元/度）" },
            label_position: "top",
            placeholder: { tag: "plain_text", content: "例如 0.60" },
            max_length: 8
          },
          {
            tag: "button",
            name: "default_electricity_rate_submit",
            action_type: "form_submit",
            text: { tag: "plain_text", content: "确认设置" },
            type: "primary"
          }
        ]
      },
      {
        tag: "note",
        elements: [{
          tag: "plain_text",
          content: "首次设置会补算既有未定价行程；后续修改只影响新行程。"
        }]
      }
    ]
  };
}

function actualDefaultRates(pricing) {
  const seen = new Set();
  return (Array.isArray(pricing?.default_rates_cny_per_kwh)
    ? pricing.default_rates_cny_per_kwh
    : []).flatMap((value) => {
      const rate = Number(value);
      if (!Number.isFinite(rate) || rate < 0 || seen.has(rate)) return [];
      seen.add(rate);
      return [rate];
    });
}

function formatElectricityRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0) return null;
  return rate.toFixed(4).replace(/(?:\.0+|(\.\d*?[1-9])0+)$/, "$1");
}

function latestTripPricingBasis(pricing) {
  if (!pricing) return "费用分摊估算";
  if (pricing.unsupported_multi_car) return "多车辆费用分摊暂不支持";
  if (pricing.cost_cny === null || pricing.cost_cny === undefined) {
    const mayNeedDefaultRate = pricing.unpriced_kwh === undefined || Number(pricing.unpriced_kwh) > 0;
    return pricing.current_default_rate_cny_per_kwh === null && mayNeedDefaultRate
      ? "默认电价未设置"
      : "能耗或价格数据不完整";
  }

  const specialKwh = Number(pricing.special_kwh) || 0;
  const defaultKwh = Number(pricing.default_kwh) || 0;
  const rates = actualDefaultRates(pricing);
  const singleRate = rates.length === 1 ? formatElectricityRate(rates[0]) : null;
  if (specialKwh > 0 && defaultKwh > 0) {
    const defaultDetail = singleRate !== null
      ? `当时 ¥${singleRate}/度`
      : rates.length > 1
        ? "按各段行程当时生效的电价"
        : "按行程当时生效的电价";
    return `账单价 ${specialKwh} 度 + 默认价 ${defaultKwh} 度（${defaultDetail}）`;
  }
  if (specialKwh > 0) return `已关联账单实际价 · ${specialKwh} 度`;
  if (defaultKwh > 0) {
    if (singleRate !== null) return `当时默认电价 ¥${singleRate}/度`;
    if (rates.length > 1) return "按各段行程当时生效的默认电价";
    return "按行程当时生效的默认电价";
  }
  return "暂无可计价电量";
}

export function buildLatestTripCard(trip, imageKey = null, hasRoute = false, mapMeta = {}) {
  const hasTrip = Boolean(trip);
  const energy = trip?.estimated_kwh === null || trip?.estimated_kwh === undefined ? "暂不可算" : `${trip.estimated_kwh} 度`;
  const cost = trip?.estimated_cost_cny === null || trip?.estimated_cost_cny === undefined
    ? "暂不可算"
    : `¥${Number(trip.estimated_cost_cny).toFixed(2)}`;
  const routeName = `${trip?.start_road || "起点未知"} → ${trip?.end_road || "终点未知"}`;
  const pricing = trip?.pricing_summary;
  const pricingBasis = !hasTrip ? "--"
    : latestTripPricingBasis(pricing);
  const routeFailure = Boolean(hasTrip && mapMeta.failureStage);
  const advice = mapMeta.advice?.title && mapMeta.advice?.detail
    ? [{
        tag: "markdown",
        content: `**本次驾驶建议**\n${mapMeta.advice.title}\n<font color='grey'>${mapMeta.advice.detail}</font>`
      }]
    : [];
  const routeElement = imageKey ? {
    tag: "img", img_key: imageKey,
    alt: { tag: "plain_text", content: hasRoute ? "最近行程路线轨迹" : "暂无完整行程轨迹" },
    title: { tag: "plain_text", content: hasRoute ? "本次路线轨迹" : "路线轨迹 · 待首次行程" },
    scale_type: "fit_horizontal", corner_radius: "10px", preview: true
  } : {
    tag: "column_set", flex_mode: "none",
    columns: [{ tag: "column", background_style: "grey-50", padding: "14px", elements: [
      { tag: "markdown", content: routeFailure ? "**地图生成失败**" : "**路线轨迹待生成**", text_align: "center" },
      { tag: "markdown", content: `<font color='grey'>${routeFailure ? "地图生成失败，可重新点击" : "完成第一段行程后自动出现"}</font>`, text_align: "center", text_size: "notation" }
    ] }]
  };
  return cardShell("行程小结", hasTrip ? "最近一段完整行程" : "等待第一段完整行程", "行程小结", [
    metricRow([
      metricColumn("估算花销", hasTrip ? cost : "--", { accent: true, compact: true }),
      metricColumn("估算电耗", hasTrip ? energy : "--", { compact: true }),
      metricColumn("行驶里程", hasTrip ? `${trip.distance_km} km` : "--", { compact: true }),
      metricColumn("行驶时长", hasTrip ? formatValue(trip.duration_min, " 分钟") : "--", { compact: true })
    ], "none"),
    routeElement,
    ...(imageKey && hasRoute && mapMeta.hasBasemap === false ? [{
      tag: "markdown", text_size: "notation",
      content: "<font color='grey'>底图暂不可用，已保留真实轨迹</font>"
    }] : []),
    { tag: "div", fields: [
      field("路线概览", hasTrip ? routeName : "--"),
      field("行程时间", hasTrip ? formatTripTimeRange(trip.start_at, trip.end_at) : "--"),
      ...(pricing ? [field("计价依据", pricingBasis, false)] : [])
    ] },
    ...advice
  ]);
}

const periodTitles = {
  week: ["本周小结", "本周截至当前"],
  month: ["本月小结", "本月截至当前"],
  previous_week: ["上周小结", "上周完整周期"],
  previous_month: ["上月小结", "上月完整周期"]
};

export function buildPeriodReportCard({ period, trips, receipts, comparisons, tripElectricCost = null, isSimulation = false, mainRoute = undefined, pricingSummary = null }) {
  const [title, subtitle] = periodTitles[period] || periodTitles.month;
  const costValue = tripElectricCost === null ? "暂不可算" : `¥${tripElectricCost.toFixed(2)}`;
  const chartValues = [
    ...[...comparisons.items].reverse().map((item) => ({
      vehicle: item.name,
      cost: Number(item.cost_cny.toFixed(2)),
      kind: "油车"
    })),
    ...(tripElectricCost === null ? [] : [{ vehicle: "Tesla", cost: Number(tripElectricCost.toFixed(2)), kind: "Tesla" }])
  ];
  const chartMaximum = chartAxisMaximum(chartValues);
  const isMonthly = period === "month" || period === "previous_month";
  const routeTitle = period === "previous_month" ? "上月主跑路线" : "本月主跑路线";
  const routeElements = mainRoute === undefined ? [] : mainRoute?.image_key ? [
    {
      tag: "img",
      img_key: mainRoute.image_key,
      alt: { tag: "plain_text", content: `${routeTitle}代表轨迹` },
      title: { tag: "plain_text", content: routeTitle },
      scale_type: "fit_horizontal",
      corner_radius: "10px",
      preview: true
    },
    {
      tag: "column_set", flex_mode: "none",
      columns: [{
        tag: "column", width: "weighted", weight: 1, background_style: "blue-50", padding: "12px", vertical_spacing: "4px",
        elements: [
          { tag: "markdown", content: `**${routeTitle}**\n${mainRoute.label} · 共 ${mainRoute.trip_count} 次 · 累计 ${mainRoute.distance_km} km` },
          ...(mainRoute.visual_note ? [{ tag: "markdown", content: `<font color='grey'>${mainRoute.visual_note}</font>`, text_size: "notation" }] : [])
        ]
      }]
    }
  ] : [{
    tag: "column_set", flex_mode: "none",
    columns: [{
      tag: "column", width: "weighted", weight: 1, background_style: "grey-50", padding: "12px", vertical_spacing: "4px",
      elements: [
        { tag: "markdown", content: `**${routeTitle}**` },
        { tag: "markdown", content: "<font color='grey'>本周期路线较分散，暂无重复 3 次以上的路线。</font>", text_size: "notation" }
      ]
    }]
  }];
  const chartElement = {
    tag: "chart",
    height: "285px",
    preview: false,
    color_theme: "primary",
    chart_spec: {
      type: "bar",
      direction: "horizontal",
      data: { values: chartValues },
      xField: "cost",
      yField: "vehicle",
      seriesField: "kind",
      color: ["#A8B1C4", "#3370FF"],
      title: { visible: true, text: `同样跑 ${trips.distance_km} km，各车型预计花费（元）` },
      legends: { visible: false },
      padding: { top: 8, right: 32, bottom: 4, left: 4 },
      label: {
        visible: true,
        position: "outside",
        overlap: false,
        style: {
          fontWeight: 500,
          stroke: "transparent",
          lineWidth: 0,
          strokeOpacity: 0
        }
      },
      axes: [
        { orient: "bottom", min: 0, max: chartMaximum, nice: false, title: { visible: false }, grid: { visible: false } },
        { orient: "left", title: { visible: false } }
      ],
      media: []
    }
  };
  const note = comparisons.is_current_day === false
    ? "*油价根据最近一次统一参考价预估；受地区、油站及优惠影响，结果可能存在偏差。*"
    : "*油价根据今日统一参考价预估；受地区、油站及优惠影响，结果可能存在偏差。*";
  const pricingRates = actualDefaultRates(pricingSummary);
  const singlePricingRate = pricingRates.length === 1 ? formatElectricityRate(pricingRates[0]) : null;
  const defaultEnergy = formatKwh(pricingSummary?.default_kwh);
  const pricingNote = !pricingSummary ? null
    : pricingSummary.unsupported_multi_car
      ? "电费暂不可算：当前版本暂不支持多辆车共用特殊价格批次。"
      : pricingSummary.requested_complete === false
      ? "电费暂不可算：本周期存在缺失的行程能耗或价格数据。"
      : pricingSummary.drive_count === 0
      ? "本周期暂无可计价行程。"
      : pricingSummary.cost_cny === null
        ? pricingSummary.current_default_rate_cny_per_kwh === null
          && (pricingSummary.unpriced_kwh === undefined || Number(pricingSummary.unpriced_kwh) > 0)
          ? "电费暂不可算：请先在菜单设置默认电价；已可靠关联的账单电量仍会保留。"
          : "电费暂不可算：本周期存在缺失的能耗或价格数据。"
        : Number(pricingSummary.special_kwh) > 0 && Number(pricingSummary.default_kwh) > 0
          ? singlePricingRate !== null
            ? `电费按已关联账单实际价和行程当时的默认电价 ¥${singlePricingRate}/度分摊，其中 ${pricingSummary.special_kwh} 度使用账单实际价。`
            : pricingRates.length > 1
              ? `电费按已关联账单实际价和每趟行程当时生效的默认电价分摊，其中 ${pricingSummary.special_kwh} 度使用账单实际价。`
              : `电费按已关联账单实际价和行程当时生效的默认电价分摊，其中 ${pricingSummary.special_kwh} 度使用账单实际价。`
          : Number(pricingSummary.special_kwh) > 0
            ? `电费全部按已关联账单实际价分摊，共 ${pricingSummary.special_kwh} 度。`
          : Number(pricingSummary.default_kwh) > 0
              ? singlePricingRate !== null
                ? `${defaultEnergy} 度全部按行程当时生效的默认电价 ¥${singlePricingRate}/度估算。`
                : pricingRates.length > 1
                  ? "电费按每趟行程当时生效的默认电价估算（本周期包含多档电价）。"
                  : "电费按行程当时生效的默认电价估算。"
              : "本周期暂无可计价电量。";
  const periodRange = isMonthly ? formatPeriodRange(trips.period_start_at, trips.period_end_at) : null;
  const periodNote = periodRange
    ? `统计周期：${periodRange} · ${Number(trips.trip_count) || 0} 段 TeslaMate 驾驶记录。`
    : null;
  return cardShell(title, subtitle, title, [
    metricRow([
      metricColumn("累计行程", `${trips.distance_km} km`, { compact: true }),
      metricColumn("累计耗电", trips.estimated_kwh === null ? "暂无" : `${trips.estimated_kwh} 度`, { compact: true }),
      metricColumn("花费金额", costValue, { accent: true, compact: true })
    ], "trisect"),
    ...(!isMonthly ? [{ tag: "div", fields: [
      field("完整行程", `${trips.trip_count} 次`),
      field("行驶时长", formatDuration(trips.duration_min))
    ] }] : []),
    ...(isMonthly ? routeElements : []),
    chartElement,
    { tag: "markdown", content: `<font color='grey'>${periodNote ? `${periodNote}\n` : ""}${pricingNote ? `${pricingNote}\n` : ""}${note}</font>`, text_size: "notation" }
  ], { tag: isSimulation ? "模拟数据" : null });
}

function chargeMinutes(value) {
  const hours = Number(value);
  return Number.isFinite(hours) && hours > 0 ? Math.max(1, Math.round(hours * 60)) : null;
}

function formatChargingEstimate(value) {
  const minutes = chargeMinutes(value);
  if (minutes === null) return "时间估算中";
  if (minutes < 60) return `约 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0
    ? `约 ${hours} 小时`
    : `约 ${hours} 小时 ${remainder} 分钟`;
}

export function buildChargingStatusCard(type, snapshot = {}, options = {}) {
  if (type === "completed") {
    const energy = snapshot.charge_energy_added === null || snapshot.charge_energy_added === undefined
      ? "暂无"
      : `${Number(snapshot.charge_energy_added).toFixed(2)} kWh`;
    const duration = snapshot.duration_min === null || snapshot.duration_min === undefined
      ? "暂无"
      : formatDuration(snapshot.duration_min);
    const batteryChange = snapshot.start_battery_level === null || snapshot.start_battery_level === undefined
      || snapshot.end_battery_level === null || snapshot.end_battery_level === undefined
      ? "暂无"
      : `${snapshot.start_battery_level}% → ${snapshot.end_battery_level}%`;
    const timeRange = snapshot.start_at && snapshot.end_at
      ? `${formatClock(snapshot.start_at)} → ${formatClock(snapshot.end_at)}`
      : "暂无";
    return cardShell("充电已结束", `本次充入 ${energy}`, "充电已结束", [
      metricRow([
        metricColumn("充入电量", energy, { accent: true }),
        metricColumn("充电时长", duration)
      ], "bisect", "10px"),
      { tag: "div", fields: [
        field("电量变化", batteryChange),
        field("充电时间", timeRange)
      ] },
      {
        tag: "column_set", flex_mode: "none",
        columns: [{ tag: "column", width: "weighted", weight: 1, background_style: "blue-50", padding: "12px", elements: [
          { tag: "markdown", content: "**充电记录已保存。发送充电账单截图，可补全本次实际支出。**" }
        ] }]
      }
    ], { width: "default", tag: options.isSimulation ? "模拟数据" : null });
  }
  const nearLimit = type === "near_limit";
  const limit = snapshot.charge_limit_soc === null || snapshot.charge_limit_soc === undefined
    ? "设置上限"
    : `${snapshot.charge_limit_soc}%`;
  const batteryValue = nearLimit
    ? snapshot.battery_level
    : snapshot.start_battery_level ?? snapshot.battery_level;
  const battery = batteryValue === null || batteryValue === undefined ? "--" : `${batteryValue}%`;
  const power = snapshot.charger_power === null || snapshot.charger_power === undefined ? "暂无" : `${snapshot.charger_power} kW`;
  const remaining = formatChargingEstimate(snapshot.time_to_full_charge);
  const title = nearLimit ? "即将完成充电" : "正在充电";
  const subtitle = nearLimit ? `即将达到 ${limit} 充电上限` : `已开始充电 · 目标 ${limit}`;
  return cardShell(title, subtitle, title, [
    {
      tag: "column_set", flex_mode: "bisect", horizontal_spacing: "10px",
      columns: nearLimit
        ? [metricColumn("Tesla 当前预估", remaining, { accent: true }), metricColumn("当前电量", battery)]
        : [metricColumn("开始电量", battery, { accent: true }), metricColumn("Tesla 当前预估", remaining)]
    },
    { tag: "div", fields: [
      field("充电上限", limit),
      field("当前功率", power),
      ...(snapshot.charge_energy_added === null || snapshot.charge_energy_added === undefined
        ? []
        : [field("本次已充入", `${snapshot.charge_energy_added} kWh`, false)])
    ] },
    {
      tag: "column_set", flex_mode: "none",
      columns: [{ tag: "column", width: "weighted", weight: 1, background_style: "blue-50", padding: "12px", elements: [
        { tag: "markdown", content: nearLimit
          ? `**Tesla 当前预估还有 ${remaining}达到 ${limit} 充电上限。**\n<font color='grey'>高电量阶段会随充电功率变化。</font>`
          : `**车辆已开始充电，Tesla 当前预估还有 ${remaining}达到 ${limit} 充电上限。**` }
      ] }]
    }
  ], { width: "default", tag: options.isSimulation ? "模拟数据" : null });
}

export function buildVehicleOverviewCard(vehicle, stats) {
  const stateNames = { online: "在线", asleep: "休眠", offline: "离线", driving: "行驶中", charging: "充电中" };
  return cardShell("车辆与行程概览", "最新车辆状态", "车辆与行程概览", [
    metricRow([
      metricColumn("电量", formatValue(vehicle?.battery_level, "%"), { accent: true }),
      metricColumn("预估续航", formatValue(vehicle?.rated_range_km, " km"))
    ], "bisect", "10px"),
    { tag: "div", fields: [
      field("车辆状态", stateNames[vehicle?.state] || vehicle?.state || "未知"),
      field("总里程", formatInteger(vehicle?.odometer_km, " km")),
      field("车内温度", formatValue(vehicle?.inside_temp_c, " °C")),
      field("车外温度", formatValue(vehicle?.outside_temp_c, " °C"))
    ] },
    { tag: "column_set", flex_mode: "trisect", horizontal_spacing: "8px", columns: [
      { tag: "column", background_style: "grey-50", padding: "10px", elements: [
        { tag: "markdown", content: `**${stats?.trip_count || 0} 次**`, text_align: "center" },
        { tag: "markdown", content: "<font color='grey'>本月行程</font>", text_align: "center", text_size: "notation" }
      ] },
      { tag: "column", background_style: "grey-50", padding: "10px", elements: [
        { tag: "markdown", content: `**${stats?.distance_km || 0} km**`, text_align: "center" },
        { tag: "markdown", content: "<font color='grey'>本月里程</font>", text_align: "center", text_size: "notation" }
      ] },
      { tag: "column", background_style: "grey-50", padding: "10px", elements: [
        { tag: "markdown", content: `**${stats?.duration_min || 0} 分钟**`, text_align: "center" },
        { tag: "markdown", content: "<font color='grey'>驾驶时长</font>", text_align: "center", text_size: "notation" }
      ] }
    ] },
    { tag: "markdown", content: "<font color='grey'>仅展示 TeslaMate 最后一次已采集状态，不向车辆发送控制指令。</font>" }
  ]);
}

export function buildUploadHelpCard() {
  return cardShell("上传充电账单", "截图发给当前机器人即可", "上传充电账单说明", [
    { tag: "markdown", content: "**需要看清两个数：**\n1. 实付金额\n2. 充电电量" },
    { tag: "column_set", flex_mode: "none", columns: [{ tag: "column", background_style: "blue-50", padding: "12px", elements: [
      { tag: "markdown", content: "发送后优先在这台 Mac 上本地识别；遇到未知版式时可使用 K3 增强识别。你点确认后才计入周结和月结。" }
    ] }] },
    { tag: "markdown", content: "<font color='grey'>地址、车牌、订单号和身份信息不入账。</font>" },
    menuButton()
  ]);
}

export function buildReceiptCard(receipt) {
  const fields = receipt.fields;
  const issue=receipt.draft_issue || validateReceipt(fields);
  const actionValue={receipt_id:receipt.id,...(receipt.revision ? {revision:receipt.revision}: {})};
  const confidence = fields.confidence === null ? "未知" : `${Math.round(fields.confidence * 100)}%`;
  const confidenceLabel = fields.recognition_source === "apple_vision" ? "字段完整度" : "识别置信度";
  const money = (value) => value === null || value === undefined ? "暂无" : `¥${Number(value).toFixed(2)}`;
  const unitPrice = (value) => value === null || value === undefined ? "暂无" : `¥${Number(value).toFixed(2)}/kWh`;
  const serviceShare = fields.service_fee_cny !== null && fields.service_fee_cny !== undefined && Number(fields.amount_cny) > 0
    ? `${Math.round(Number(fields.service_fee_cny) / Number(fields.amount_cny) * 100)}%`
    : "暂无";
  const energySource = {
    explicit: "账单直接显示",
    derived_all_in_price: "按综合单价换算",
    derived_electricity_price: "按电费单价换算"
  }[fields.energy_source] || "识别结果";
  const recognitionTag = fields.recognition_source === "apple_vision"
    ? "本地识别"
    : fields.recognition_source === "k3_fallback" ? "K3 增强识别"
      : fields.recognition_source === "user_text" ? "用户文字补充" : "识别结果";
  const match = receipt.charging_match;
  const formatCandidateTime = (value) => {
    const found = String(value || "").match(/^\d{4}-(\d{2})-(\d{2}) (\d{2}:\d{2})$/);
    return found ? `${Number(found[1])}月${Number(found[2])}日 ${found[3]}` : "时间未知";
  };
  const candidateLabel = (candidate) => {
    const energy = candidate.energy_kwh === null || candidate.energy_kwh === undefined
      ? "电量未知"
      : `${Number(candidate.energy_kwh).toFixed(1)} kWh`;
    return `${formatCandidateTime(candidate.display_at)} · ${energy}`;
  };
  let matchElement = null;
  if (match?.status === "matched") {
    const selected = (match.candidates || []).find(
      (candidate) => String(candidate.process_id) === String(match.selected_process_id)
    ) || match.candidates?.[0];
    matchElement = {
      tag: "column_set", flex_mode: "none", columns: [{
        tag: "column", background_style: "blue-50", padding: "10px", elements: [{
          tag: "markdown",
          content: `**已匹配车辆充电记录**\n${selected ? candidateLabel(selected) : "已确认对应记录"}`
        }]
      }]
    };
  } else if (match?.status === "needs_confirmation") {
    const candidates = (match.candidates || []).slice(0, 2);
    matchElement = {
      tag: "column_set", flex_mode: "bisect", horizontal_spacing: "10px",
      columns: candidates.map((candidate) => ({
        tag: "column", background_style: "grey-50", padding: "8px", vertical_spacing: "6px",
        elements: [
          { tag: "markdown", content: "**请选择对应的车辆充电记录**", text_size: "notation" },
          button(candidateLabel(candidate), "select_receipt_match", {
            extra: { ...actionValue, process_id: String(candidate.process_id) }
          })
        ]
      }))
    };
  } else if (match?.status === "unlinked") {
    matchElement = {
      tag: "markdown",
      content: "**暂未找到可靠的车辆充电记录**\n<font color='grey'>仍可直接记账；账单只有时间时暂按收到日期归账。</font>"
    };
  }
  const confirmLabel = match?.status === "needs_confirmation" ? "不关联，直接记账" : "确认记账";
  return cardShell(issue ? "充电账单待补充" : "充电账单待确认", "草稿不会入账，核对后再确认", "充电账单草稿", [
    {
      tag: "column_set", flex_mode: "bisect", horizontal_spacing: "12px",
      columns: [
        { tag: "column", width: "weighted", weight: 2, background_style: "blue-50", padding: "12px", vertical_spacing: "2px", elements: [
          { tag: "markdown", content: `## <font color='blue'>¥${formatValue(fields.amount_cny)}</font>`, text_align: "center" },
          { tag: "markdown", content: "<font color='grey'>实付金额</font>", text_align: "center", text_size: "notation" }
        ] },
        { tag: "column", width: "weighted", weight: 1, background_style: "grey-50", padding: "12px", vertical_spacing: "2px", elements: [
          { tag: "markdown", content: `**${formatValue(fields.energy_kwh, " kWh")}**`, text_align: "center" },
          { tag: "markdown", content: "<font color='grey'>充电电量</font>", text_align: "center", text_size: "notation" }
        ] }
      ]
    },
    { tag: "column_set", flex_mode: "none", columns: [{
      tag: "column", background_style: "grey-50", padding: "12px", vertical_spacing: "4px", elements: [
        { tag: "markdown", content: `**费用拆分**\n电费  ${money(fields.electricity_fee_cny)} · ${unitPrice(fields.electricity_unit_price_cny_per_kwh)}\n服务费  ${money(fields.service_fee_cny)} · ${unitPrice(fields.service_unit_price_cny_per_kwh)} · 占总支出 ${serviceShare}\n综合单价  ${unitPrice(fields.all_in_unit_price_cny_per_kwh)}` },
        { tag: "markdown", content: `<font color='grey'>电量来源：${energySource}</font>`, text_size: "notation" }
      ]
    }] },
    { tag: "div", fields: [field("充电时间", formatValue(fields.charged_at)), field(confidenceLabel, confidence), field("运营商", formatValue(fields.provider), false),
      field("补充或纠正", `${issue ? `${issue}\n` : "请核对识别结果。\n"}可直接回复“充了30度”“金额应该是24元”，也可说“昨天充了30度，花了24元”。时间未提供时不会猜测具体充电时间。`,false)] },
    ...(matchElement ? [matchElement] : []),
    buttonRow(...(!issue ? [button(confirmLabel, "confirm_receipt", { primary: true, extra: actionValue })] : []), button("忽略", "ignore_receipt", { extra: actionValue }))
  ], { width: "default", tag: recognitionTag });
}

export function assertCard(card) {
  if (card?.schema !== "2.0") throw new Error("Card 2.0 schema missing");
  const elements = card?.body?.elements;
  if (!Array.isArray(elements) || elements.length < 2 || elements.length > 5) throw new Error("card visual block count out of range");
  const primaryButtons = JSON.stringify(card).match(/"primary_filled"/g)?.length || 0;
  if (primaryButtons > 1) throw new Error("card must have at most one primary action");
  return card;
}

export function assertFormCard(card) {
  if (card?.schema !== undefined) throw new Error("legacy form card must not declare a schema");
  if (!card?.header?.title?.content) throw new Error("form card title missing");
  if (!Array.isArray(card?.elements) || card.elements.length < 2) throw new Error("form card root elements missing");
  const form = card.elements.find((element) => element?.tag === "form");
  if (!form?.name || !Array.isArray(form.elements)) throw new Error("form card form missing");
  const input = form.elements.find((element) => element?.tag === "input");
  if (!input?.name || !input?.label?.content || !input?.placeholder?.content) throw new Error("form card input missing");
  const submit = form.elements.find((element) => element?.tag === "button" && element?.action_type === "form_submit");
  if (!submit?.name || !submit?.text?.content) throw new Error("form card submit button missing");
  return card;
}
