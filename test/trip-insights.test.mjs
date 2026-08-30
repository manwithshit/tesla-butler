import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTripInsightSessions,
  selectTripAdvice,
  selectTripAdviceForTrip
} from "../src/trip-insights.mjs";

function session(overrides = {}) {
  return {
    segment_ids: [1],
    start_lat: 30,
    start_lng: 120,
    end_lat: 30.1,
    end_lng: 120.1,
    distance_km: 20,
    duration_min: 30,
    observed_seconds: 1_800,
    stopped_seconds: 360,
    strong_accel_count: 2,
    strong_decel_count: 2,
    drawn_kwh: 4,
    regenerated_kwh: 1,
    ascent_m: 40,
    sample_coverage: 0.98,
    ...overrides
  };
}

test("driving advice stays hidden without enough comparable trips", () => {
  const current = session({ stopped_seconds: 120 });
  const history = [session({ segment_ids: [2] }), session({ segment_ids: [3] })];

  assert.equal(selectTripAdvice(current, history), null);
});

test("driving advice stays hidden when the current samples are incomplete", () => {
  const current = session({ stopped_seconds: 120, sample_coverage: 0.72 });
  const history = [2, 3, 4].map((id) => session({ segment_ids: [id] }));

  assert.equal(selectTripAdvice(current, history), null);
});

test("driving advice never compares unrelated routes", () => {
  const current = session({ stopped_seconds: 120 });
  const history = [2, 3, 4].map((id) => session({
    segment_ids: [id],
    start_lat: 31,
    start_lng: 121,
    end_lat: 31.1,
    end_lng: 121.1
  }));

  assert.equal(selectTripAdvice(current, history), null);
});

test("missing energy samples never manufacture an energy-based verdict", () => {
  const current = session({ drawn_kwh: null, regenerated_kwh: null, ascent_m: 400 });
  const history = [2, 3, 4].map((id) => session({
    segment_ids: [id], drawn_kwh: null, regenerated_kwh: null
  }));

  assert.equal(selectTripAdvice(current, history), null);
});

test("multi-segment metrics are aggregated into one user-visible trip", () => {
  const [trip] = buildTripInsightSessions([
    session({
      id: 10,
      segment_ids: undefined,
      car_id: 1,
      start_at: "2026-08-27T00:00:00Z",
      end_at: "2026-08-27T00:10:00Z",
      duration_min: 10,
      distance_km: 5,
      observed_seconds: 590,
      stopped_seconds: 60,
      strong_accel_count: 1,
      strong_decel_count: 0,
      drawn_kwh: 1,
      regenerated_kwh: 0.2,
      ascent_m: 10,
      end_lat: 30.05,
      end_lng: 120.05
    }),
    session({
      id: 11,
      segment_ids: undefined,
      car_id: 1,
      start_at: "2026-08-27T00:12:00Z",
      end_at: "2026-08-27T00:32:00Z",
      duration_min: 20,
      distance_km: 15,
      observed_seconds: 1_180,
      stopped_seconds: 120,
      strong_accel_count: 2,
      strong_decel_count: 1,
      drawn_kwh: 3,
      regenerated_kwh: 0.8,
      ascent_m: 30,
      start_lat: 30.05,
      start_lng: 120.05
    })
  ]);

  assert.deepEqual(trip.segment_ids, [10, 11]);
  assert.equal(trip.distance_km, 20);
  assert.equal(trip.observed_seconds, 1_770);
  assert.equal(trip.stopped_seconds, 180);
  assert.equal(trip.strong_accel_count, 3);
  assert.equal(trip.strong_decel_count, 1);
  assert.equal(trip.drawn_kwh, 4);
  assert.equal(trip.regenerated_kwh, 1);
  assert.equal(trip.ascent_m, 40);
  assert.equal(trip.sample_coverage, 0.98);
});

test("card advice selects the exact grouped trip instead of whichever trip is latest", () => {
  const drives = [1, 2, 3, 4].map((id) => session({
    id,
    segment_ids: undefined,
    car_id: 1,
    start_at: `2026-08-${20 + id}T00:00:00Z`,
    end_at: `2026-08-${20 + id}T00:30:00Z`,
    stopped_seconds: id === 4 ? 120 : 360
  }));

  assert.equal(selectTripAdviceForTrip({ segment_ids: [1] }, drives), null);
  assert.equal(selectTripAdviceForTrip({ segment_ids: [4] }, drives)?.code, "smooth_trip");
});

test("smooth-trip advice states stopped minutes without asking the reader to calculate", () => {
  const current = session({ stopped_seconds: 120 });
  const history = [2, 3, 4].map((id) => session({ segment_ids: [id], stopped_seconds: 360 }));

  assert.deepEqual(selectTripAdvice(current, history), {
    code: "smooth_trip",
    title: "🛣️ 一路丝滑",
    detail: "这趟开车过程中，车停住的时间一共 2 分钟，平时类似行程约 6 分钟。今天少停了 4 分钟，一路更顺。",
    baseline_count: 3
  });
});

test("veteran advice compares event counts in plain language", () => {
  const current = session({ strong_accel_count: 1, strong_decel_count: 0 });
  const history = [2, 3, 4].map((id) => session({
    segment_ids: [id], strong_accel_count: 2, strong_decel_count: 1
  }));

  assert.deepEqual(selectTripAdvice(current, history), {
    code: "veteran",
    title: "🚘 老司机模式",
    detail: "这趟系统记录了 1 个明显的车速变化片段，没有出现明显急减速。按同样行驶时长看，近期 3 次同路线通常约 3 个；今天少了约 2 个，整体更稳。",
    baseline_count: 3
  });
});

test("regeneration advice translates recovered energy into personal equivalent distance", () => {
  const current = session({ regenerated_kwh: 1.6 });
  const history = [2, 3, 4].map((id) => session({ segment_ids: [id], regenerated_kwh: 0.8 }));

  assert.deepEqual(selectTripAdvice(current, history), {
    code: "regen_expert",
    title: "♻️ 回收高手",
    detail: "这趟一共回收了 1.60 度电。按你近期每公里平均耗电 0.16 度算，差不多够跑 10.0 公里。",
    baseline_count: 3
  });
});

test("strong acceleration advice compares counts instead of abstract percentages", () => {
  const current = session({ strong_accel_count: 5, strong_decel_count: 1 });
  const history = [2, 3, 4].map((id) => session({
    segment_ids: [id], strong_accel_count: 1, strong_decel_count: 1
  }));

  assert.deepEqual(selectTripAdvice(current, history), {
    code: "strong_acceleration",
    title: "🔥 有点热血",
    detail: "这趟明显加速 5 次，平时类似行程通常只有 1 次。起步可以再渐进一点。",
    baseline_count: 3
  });
});

test("strong deceleration advice uses the honest observed-event label", () => {
  const current = session({ strong_accel_count: 1, strong_decel_count: 4 });
  const history = [2, 3, 4].map((id) => session({
    segment_ids: [id], strong_accel_count: 1, strong_decel_count: 1
  }));

  assert.deepEqual(selectTripAdvice(current, history), {
    code: "strong_deceleration",
    title: "🧘 收尾再从容点",
    detail: "这趟明显减速 4 次，平时类似行程通常只有 1 次。提前一点松电门会更从容。",
    baseline_count: 3
  });
});

test("stop-heavy advice explains the extra stopped minutes directly", () => {
  const current = session({ stopped_seconds: 720 });
  const history = [2, 3, 4].map((id) => session({ segment_ids: [id], stopped_seconds: 360 }));

  assert.deepEqual(selectTripAdvice(current, history), {
    code: "stop_heavy",
    title: "🚦 城市闯关局",
    detail: "这趟开车过程中，车停住的时间一共 12 分钟，平时类似行程约 6 分钟。今天多停了 6 分钟，能耗高一些主要是因为路上不够顺。",
    baseline_count: 3
  });
});

test("uphill advice reports climb and energy without blaming driving style", () => {
  const current = session({ ascent_m: 400, drawn_kwh: 6, regenerated_kwh: 1 });
  const history = [2, 3, 4].map((id) => session({
    segment_ids: [id], ascent_m: 40, drawn_kwh: 4, regenerated_kwh: 1
  }));

  assert.deepEqual(selectTripAdvice(current, history), {
    code: "uphill",
    title: "⛰️ 上坡挑战局",
    detail: "这趟累计爬升 400 米，单位里程耗电 250 Wh/km。主要是上坡更费电，驾驶节奏本身没有明显问题。",
    baseline_count: 3
  });
});

test("the same advice template is hidden when it already described a recent comparable trip", () => {
  const history = [1, 2, 3, 4].map((id) => session({
    segment_ids: [id],
    start_at: `2026-08-${20 + id}T00:00:00Z`,
    end_at: `2026-08-${20 + id}T00:30:00Z`,
    stopped_seconds: id === 4 ? 120 : 360
  }));
  const current = session({
    segment_ids: [5],
    start_at: "2026-08-25T00:00:00Z",
    end_at: "2026-08-25T00:30:00Z",
    stopped_seconds: 120
  });

  assert.equal(selectTripAdvice(current, history), null);
});
