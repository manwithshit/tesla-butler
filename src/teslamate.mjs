import { config, projectPath } from "./config.mjs";
import { runFile } from "./lib/process.mjs";
import { groupDriveSegments } from "./trip-sessions.mjs";

const composeArgs = [
  "compose",
  "--env-file", projectPath("infra", "teslamate", ".env"),
  "-f", projectPath("infra", "teslamate", "compose.yaml")
];

async function sqlJson(sql, timeout = 30_000) {
  const { stdout } = await runFile(config.dockerCli, [
    ...composeArgs,
    "exec", "-T", "database",
    "psql", "-X", "-q", "-t", "-A",
    "-U", "teslamate", "-d", "teslamate",
    "-c", sql
  ], { cwd: config.root, timeout });

  const value = stdout.trim();
  return value ? JSON.parse(value) : null;
}

export async function getLatestChargingProcess() {
  return sqlJson(`
    SELECT COALESCE((
      SELECT json_build_object(
        'id', cp.id,
        'car_id', cp.car_id,
        'start_at', cp.start_date,
        'end_at', cp.end_date,
        'start_battery_level', cp.start_battery_level,
        'end_battery_level', cp.end_battery_level,
        'charge_energy_added', cp.charge_energy_added,
        'duration_min', cp.duration_min,
        'latest_battery_level', latest.battery_level,
        'latest_charger_power', latest.charger_power,
        'latest_charge_energy_added', latest.charge_energy_added,
        'latest_sample_at', latest.date
      )
      FROM charging_processes cp
      LEFT JOIN LATERAL (
        SELECT c.date, c.battery_level, c.charger_power, c.charge_energy_added
        FROM charges c
        WHERE c.charging_process_id = cp.id
        ORDER BY c.date DESC, c.id DESC
        LIMIT 1
      ) latest ON true
      ORDER BY cp.id DESC
      LIMIT 1
    ), 'null'::json);
  `, 3_000);
}

export async function getRecentChargingProcesses({ before = new Date(), days = 7, limit = 20 } = {}) {
  const safeBefore = new Date(before);
  if (!Number.isFinite(safeBefore.getTime())) throw new Error("invalid charging lookup time");
  const safeDays = Math.max(1, Math.min(31, Math.trunc(Number(days) || 7)));
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(Number(limit) || 20)));
  const beforeIso = safeBefore.toISOString();
  const beforeUtc = teslaMateUtcNaiveSqlExpression(beforeIso, "invalid charging lookup time");
  return sqlJson(`
    SELECT COALESCE(json_agg(row_to_json(recent) ORDER BY recent.end_at DESC), '[]'::json)
    FROM (
      SELECT
        cp.id,
        cp.start_date AS start_at,
        cp.end_date AS end_at,
        cp.start_battery_level,
        cp.end_battery_level,
        COALESCE(cp.charge_energy_added, latest.charge_energy_added) AS charge_energy_added
      FROM charging_processes cp
      LEFT JOIN LATERAL (
        SELECT c.charge_energy_added
        FROM charges c
        WHERE c.charging_process_id = cp.id
        ORDER BY c.date DESC, c.id DESC
        LIMIT 1
      ) latest ON true
      WHERE cp.end_date IS NOT NULL
        AND cp.end_date <= ${beforeUtc} + interval '10 minutes'
        AND cp.end_date >= ${beforeUtc} - interval '${safeDays} days'
      ORDER BY cp.end_date DESC
      LIMIT ${safeLimit}
    ) recent;
  `, 3_000);
}

export async function ensureTeslaMate() {
  await runFile(config.dockerCli, [...composeArgs, "up", "-d"], {
    cwd: config.root,
    timeout: 120_000
  });
}

export async function getCollectionStatus() {
  return sqlJson(`
    SELECT json_build_object(
      'cars', (SELECT count(*) FROM cars),
      'drives', (SELECT count(*) FROM drives),
      'positions', (SELECT count(*) FROM positions),
      'charging_processes', (SELECT count(*) FROM charging_processes),
      'latest_drive_at', (SELECT max(end_date) FROM drives),
      'latest_position_at', (SELECT max(date) FROM positions)
    );
  `);
}

export async function getLatestTrip() {
  return sqlJson(`
    SELECT COALESCE((
      SELECT json_build_object(
        'id', d.id,
        'start_at', d.start_date,
        'end_at', d.end_date,
        'distance_km', round(d.distance::numeric, 1),
        'duration_min', d.duration_min,
        'start_road', NULLIF(sa.road, ''),
        'end_road', NULLIF(ea.road, ''),
        'start_area', NULLIF(sa.city, ''),
        'end_area', NULLIF(ea.city, ''),
        'estimated_kwh', CASE
          WHEN e.valid_segments > 0 THEN round(greatest(e.net_kwh, 0)::numeric, 2)
          WHEN c.efficiency IS NOT NULL
            AND d.start_ideal_range_km IS NOT NULL
            AND d.end_ideal_range_km IS NOT NULL
          THEN round((greatest(d.start_ideal_range_km - d.end_ideal_range_km, 0) * c.efficiency / 1000)::numeric, 2)
          ELSE NULL
        END,
        'drawn_kwh', CASE WHEN e.valid_segments > 0 THEN round(e.drawn_kwh::numeric, 2) ELSE NULL END,
        'regenerated_kwh', CASE WHEN e.valid_segments > 0 THEN round(e.regenerated_kwh::numeric, 2) ELSE NULL END,
        'energy_source', CASE
          WHEN e.valid_segments > 0 THEN 'power_integration'
          WHEN c.efficiency IS NOT NULL
            AND d.start_ideal_range_km IS NOT NULL
            AND d.end_ideal_range_km IS NOT NULL
          THEN 'range_efficiency'
          ELSE 'unavailable'
        END
      )
      FROM drives d
      JOIN cars c ON c.id = d.car_id
      LEFT JOIN addresses sa ON sa.id = d.start_address_id
      LEFT JOIN addresses ea ON ea.id = d.end_address_id
      LEFT JOIN LATERAL (
        SELECT
          count(*) AS valid_segments,
          sum(average_power * seconds / 3600) AS net_kwh,
          sum(greatest(average_power, 0) * seconds / 3600) AS drawn_kwh,
          sum(greatest(-average_power, 0) * seconds / 3600) AS regenerated_kwh
        FROM (
          SELECT
            EXTRACT(EPOCH FROM (lead(p.date) OVER (ORDER BY p.date) - p.date)) AS seconds,
            (p.power::float8 + lead(p.power::float8) OVER (ORDER BY p.date)) / 2 AS average_power
          FROM positions p
          WHERE p.drive_id = d.id AND p.power IS NOT NULL
        ) segments
        WHERE seconds > 0 AND seconds <= 10 AND average_power IS NOT NULL
      ) e ON true
      WHERE d.end_date IS NOT NULL
      ORDER BY d.end_date DESC
      LIMIT 1
    ), 'null'::json);
  `);
}

function teslaMateUtcNaiveSqlExpression(value, errorMessage) {
  const raw = String(value ?? "").trim();
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`;
  const timestamp = new Date(normalized);
  if (!raw || !Number.isFinite(timestamp.getTime())) {
    throw new Error(errorMessage);
  }
  return `('${timestamp.toISOString()}'::timestamptz AT TIME ZONE 'UTC')`;
}

export function driveEnergyTimelineSincePredicate(value) {
  return `d.start_date >= ${teslaMateUtcNaiveSqlExpression(value, "invalid drive energy timeline start")}`;
}

export async function getDriveEnergyTimeline({ since = null, driveIds = null } = {}) {
  const selection = [];
  if (since !== null && since !== undefined) {
    selection.push(driveEnergyTimelineSincePredicate(since));
  }
  if (driveIds !== null && driveIds !== undefined) {
    const values = Array.isArray(driveIds) ? driveIds : [driveIds];
    selection.push(values.length > 0 ? `d.id IN (${driveIdsSql(values)})` : "false");
  }
  const selectionClause = selection.length > 0 ? `AND (${selection.join(" OR ")})` : "";
  return sqlJson(`
    WITH selected_drives AS (
      SELECT d.*, c.efficiency
      FROM drives d
      JOIN cars c ON c.id = d.car_id
      WHERE d.end_date IS NOT NULL ${selectionClause}
    ), ordered_power AS (
      SELECT
        p.drive_id,
        EXTRACT(EPOCH FROM (
          lead(p.date) OVER (PARTITION BY p.drive_id ORDER BY p.date, p.id) - p.date
        )) AS seconds,
        (p.power::float8 + lead(p.power::float8) OVER (
          PARTITION BY p.drive_id ORDER BY p.date, p.id
        )) / 2 AS average_power
      FROM positions p
      JOIN selected_drives d ON d.id = p.drive_id
      WHERE p.power IS NOT NULL
    ), drive_power AS (
      SELECT
        drive_id,
        count(*) FILTER (WHERE seconds > 0 AND seconds <= 10 AND average_power IS NOT NULL) AS valid_segments,
        sum(average_power * seconds / 3600) FILTER (
          WHERE seconds > 0 AND seconds <= 10 AND average_power IS NOT NULL
        ) AS net_kwh
      FROM ordered_power
      GROUP BY drive_id
    ), timeline AS (
      SELECT
        d.id AS drive_id,
        d.car_id,
        d.start_date AS start_at,
        d.end_date AS end_at,
        CASE
          WHEN p.valid_segments > 0 THEN round(greatest(p.net_kwh, 0)::numeric, 3)
          WHEN d.efficiency IS NOT NULL
            AND d.start_ideal_range_km IS NOT NULL
            AND d.end_ideal_range_km IS NOT NULL
          THEN round((greatest(d.start_ideal_range_km - d.end_ideal_range_km, 0) * d.efficiency / 1000)::numeric, 3)
          ELSE NULL
        END AS estimated_kwh,
        CASE
          WHEN p.valid_segments > 0 THEN 'power_integration'
          WHEN d.efficiency IS NOT NULL
            AND d.start_ideal_range_km IS NOT NULL
            AND d.end_ideal_range_km IS NOT NULL
          THEN 'range_efficiency'
          ELSE 'unavailable'
        END AS energy_source
      FROM selected_drives d
      LEFT JOIN drive_power p ON p.drive_id = d.id
    )
    SELECT COALESCE(json_agg(row_to_json(timeline) ORDER BY start_at, drive_id), '[]'::json)
    FROM timeline;
  `, 30_000);
}

export async function getTeslaMateCarCount() {
  return Number(await sqlJson("SELECT count(*) FROM cars;", 3_000));
}

function driveIdsSql(driveIds) {
  const ids = [...new Set((driveIds || []).map(Number))];
  if (ids.length === 0 || ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error("invalid drive ids");
  }
  return ids.join(",");
}

export async function getDriveMonitorSnapshot() {
  return sqlJson(`
    WITH recent AS (
      SELECT d.*
      FROM drives d
      WHERE d.end_date IS NOT NULL
      ORDER BY d.id DESC
      LIMIT 50
    ), ordered AS (
      SELECT r.*, lag(r.end_date) OVER (PARTITION BY r.car_id ORDER BY r.start_date) AS previous_end
      FROM recent r
    ), completed AS (
      SELECT
        d.id, d.car_id, d.start_date AS start_at, d.end_date AS end_at,
        round(d.distance::numeric, 2) AS distance_km, d.duration_min,
        NULLIF(sa.road, '') AS start_road, NULLIF(ea.road, '') AS end_road,
        sp.latitude::float8 AS start_lat, sp.longitude::float8 AS start_lng,
        ep.latitude::float8 AS end_lat, ep.longitude::float8 AS end_lng,
        EXISTS (
          SELECT 1 FROM charging_processes cp
          WHERE d.previous_end IS NOT NULL
            AND cp.car_id = d.car_id
            AND cp.start_date >= d.previous_end
            AND cp.start_date <= d.start_date
        ) AS charging_between
      FROM ordered d
      LEFT JOIN addresses sa ON sa.id = d.start_address_id
      LEFT JOIN addresses ea ON ea.id = d.end_address_id
      LEFT JOIN positions sp ON sp.id = d.start_position_id
      LEFT JOIN positions ep ON ep.id = d.end_position_id
    ), active AS (
      SELECT d.id, d.car_id, d.start_date AS start_at,
             p.latitude::float8 AS start_lat, p.longitude::float8 AS start_lng,
             EXISTS (
               SELECT 1 FROM charging_processes cp
               WHERE cp.car_id = d.car_id
                 AND cp.start_date >= COALESCE((
                   SELECT max(previous.end_date) FROM drives previous
                   WHERE previous.car_id = d.car_id
                     AND previous.end_date IS NOT NULL
                     AND previous.end_date <= d.start_date
                 ), d.start_date)
                 AND cp.start_date <= d.start_date
             ) AS charging_between
      FROM drives d
      LEFT JOIN positions p ON p.id = d.start_position_id
      WHERE d.end_date IS NULL
      ORDER BY d.id DESC
      LIMIT 1
    )
    SELECT json_build_object(
      'completed', COALESCE((SELECT json_agg(row_to_json(c) ORDER BY c.start_at) FROM completed c), '[]'::json),
      'active', (SELECT row_to_json(a) FROM active a)
    );
  `, 3_000);
}

export async function getTripInsightHistory(limit = 50) {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 50)));
  return sqlJson(`
    WITH recent AS (
      SELECT d.*
      FROM drives d
      WHERE d.end_date IS NOT NULL
      ORDER BY d.end_date DESC
      LIMIT ${safeLimit}
    ), drives_ordered AS (
      SELECT r.*, lag(r.end_date) OVER (PARTITION BY r.car_id ORDER BY r.start_date) AS previous_end
      FROM recent r
    ), position_intervals AS (
      SELECT
        p.drive_id,
        p.date AS sample_at,
        p.id AS sample_id,
        p.speed::float8 AS speed,
        lead(p.speed::float8) OVER (PARTITION BY p.drive_id ORDER BY p.date, p.id) AS next_speed,
        EXTRACT(EPOCH FROM (
          lead(p.date) OVER (PARTITION BY p.drive_id ORDER BY p.date, p.id) - p.date
        )) AS seconds,
        (p.power::float8 + lead(p.power::float8) OVER (
          PARTITION BY p.drive_id ORDER BY p.date, p.id
        )) / 2 AS average_power
      FROM positions p
      JOIN recent d ON d.id = p.drive_id
    ), interval_flags AS (
      SELECT *,
        CASE WHEN seconds > 0 AND seconds <= 3 AND speed IS NOT NULL AND next_speed IS NOT NULL
          THEN ((next_speed - speed) / 3.6) / seconds >= 2.0 ELSE false END AS accel_hit,
        CASE WHEN seconds > 0 AND seconds <= 3 AND speed IS NOT NULL AND next_speed IS NOT NULL
          THEN ((next_speed - speed) / 3.6) / seconds <= -2.5 ELSE false END AS decel_hit
      FROM position_intervals
    ), event_edges AS (
      SELECT *,
        lag(accel_hit, 1, false) OVER (PARTITION BY drive_id ORDER BY sample_at, sample_id) AS previous_accel_hit,
        lead(accel_hit, 1, false) OVER (PARTITION BY drive_id ORDER BY sample_at, sample_id) AS next_accel_hit,
        lag(decel_hit, 1, false) OVER (PARTITION BY drive_id ORDER BY sample_at, sample_id) AS previous_decel_hit,
        lead(decel_hit, 1, false) OVER (PARTITION BY drive_id ORDER BY sample_at, sample_id) AS next_decel_hit
      FROM interval_flags
    ), metrics AS (
      SELECT
        drive_id,
        COALESCE(sum(seconds) FILTER (WHERE seconds > 0 AND seconds <= 3), 0) AS observed_seconds,
        COALESCE(sum(seconds) FILTER (
          WHERE seconds > 0 AND seconds <= 3 AND speed = 0 AND next_speed = 0
        ), 0) AS stopped_seconds,
        count(*) FILTER (WHERE accel_hit AND next_accel_hit AND NOT previous_accel_hit) AS strong_accel_count,
        count(*) FILTER (WHERE decel_hit AND next_decel_hit AND NOT previous_decel_hit) AS strong_decel_count,
        sum(greatest(average_power, 0) * seconds / 3600) FILTER (
          WHERE seconds > 0 AND seconds <= 10 AND average_power IS NOT NULL
        ) AS drawn_kwh,
        sum(greatest(-average_power, 0) * seconds / 3600) FILTER (
          WHERE seconds > 0 AND seconds <= 10 AND average_power IS NOT NULL
        ) AS regenerated_kwh
      FROM event_edges
      GROUP BY drive_id
    ), result AS (
      SELECT
        d.id, d.car_id, d.start_date AS start_at, d.end_date AS end_at,
        round(d.distance::numeric, 2) AS distance_km,
        d.duration_min,
        EXTRACT(EPOCH FROM (d.end_date - d.start_date)) AS duration_seconds,
        sp.latitude::float8 AS start_lat, sp.longitude::float8 AS start_lng,
        ep.latitude::float8 AS end_lat, ep.longitude::float8 AS end_lng,
        EXISTS (
          SELECT 1 FROM charging_processes cp
          WHERE d.previous_end IS NOT NULL
            AND cp.car_id = d.car_id
            AND cp.start_date >= d.previous_end
            AND cp.start_date <= d.start_date
        ) AS charging_between,
        COALESCE(m.observed_seconds, 0) AS observed_seconds,
        COALESCE(m.stopped_seconds, 0) AS stopped_seconds,
        COALESCE(m.strong_accel_count, 0) AS strong_accel_count,
        COALESCE(m.strong_decel_count, 0) AS strong_decel_count,
        m.drawn_kwh,
        m.regenerated_kwh,
        d.ascent::float8 AS ascent_m
      FROM drives_ordered d
      LEFT JOIN positions sp ON sp.id = d.start_position_id
      LEFT JOIN positions ep ON ep.id = d.end_position_id
      LEFT JOIN metrics m ON m.drive_id = d.id
    )
    SELECT COALESCE(json_agg(row_to_json(result) ORDER BY start_at), '[]'::json)
    FROM result;
  `, 15_000);
}

export async function getDriveGroup(driveIds, options = {}) {
  const ids = driveIdsSql(driveIds);
  const segments = await sqlJson(`
    SELECT COALESCE(json_agg(row_to_json(x) ORDER BY x.start_at), '[]'::json)
    FROM (
      SELECT
        d.id, d.car_id, d.start_date AS start_at, d.end_date AS end_at,
        round(d.distance::numeric, 2) AS distance_km, d.duration_min,
        NULLIF(sa.road, '') AS start_road, NULLIF(ea.road, '') AS end_road,
        sp.latitude::float8 AS start_lat, sp.longitude::float8 AS start_lng,
        ep.latitude::float8 AS end_lat, ep.longitude::float8 AS end_lng,
        CASE
          WHEN e.valid_segments > 0 THEN round(greatest(e.net_kwh, 0)::numeric, 2)
          WHEN c.efficiency IS NOT NULL
            AND d.start_ideal_range_km IS NOT NULL
            AND d.end_ideal_range_km IS NOT NULL
          THEN round((greatest(d.start_ideal_range_km - d.end_ideal_range_km, 0) * c.efficiency / 1000)::numeric, 2)
          ELSE NULL
        END AS estimated_kwh,
        CASE WHEN e.valid_segments > 0 THEN round(e.drawn_kwh::numeric, 2) ELSE NULL END AS drawn_kwh,
        CASE WHEN e.valid_segments > 0 THEN round(e.regenerated_kwh::numeric, 2) ELSE NULL END AS regenerated_kwh,
        CASE
          WHEN e.valid_segments > 0 THEN 'power_integration'
          WHEN c.efficiency IS NOT NULL
            AND d.start_ideal_range_km IS NOT NULL
            AND d.end_ideal_range_km IS NOT NULL
          THEN 'range_efficiency'
          ELSE 'unavailable'
        END AS energy_source
      FROM drives d
      JOIN cars c ON c.id = d.car_id
      LEFT JOIN addresses sa ON sa.id = d.start_address_id
      LEFT JOIN addresses ea ON ea.id = d.end_address_id
      LEFT JOIN positions sp ON sp.id = d.start_position_id
      LEFT JOIN positions ep ON ep.id = d.end_position_id
      LEFT JOIN LATERAL (
        SELECT count(*) AS valid_segments,
               sum(average_power * seconds / 3600) AS net_kwh,
               sum(greatest(average_power, 0) * seconds / 3600) AS drawn_kwh,
               sum(greatest(-average_power, 0) * seconds / 3600) AS regenerated_kwh
        FROM (
          SELECT EXTRACT(EPOCH FROM (lead(p.date) OVER (ORDER BY p.date) - p.date)) AS seconds,
                 (p.power::float8 + lead(p.power::float8) OVER (ORDER BY p.date)) / 2 AS average_power
          FROM positions p
          WHERE p.drive_id = d.id AND p.power IS NOT NULL
        ) samples
        WHERE seconds > 0 AND seconds <= 10 AND average_power IS NOT NULL
      ) e ON true
      WHERE d.id IN (${ids}) AND d.end_date IS NOT NULL
    ) x;
  `);
  const expectedIds = ids.split(",").map(Number);
  if (segments.length !== expectedIds.length) throw new Error("one or more drive segments are unavailable");
  const groups = groupDriveSegments(segments, options);
  if (groups.length !== 1) throw new Error("drive segments do not form one trip");
  return groups[0];
}

export async function getLatestTripGroup() {
  const snapshot = await getDriveMonitorSnapshot();
  const group = groupDriveSegments(snapshot.completed).at(-1);
  return group ? getDriveGroup(group.segment_ids) : null;
}

export async function getDriveGroupRoute(driveIds) {
  const ids = driveIdsSql(driveIds);
  return sqlJson(`
    WITH sampled AS (
      SELECT p.latitude::float8 AS lat, p.longitude::float8 AS lng, p.drive_id,
             p.date AS at, p.power::float8 AS power_kw,
             row_number() OVER (PARTITION BY p.drive_id ORDER BY p.date) AS point_no
      FROM positions p
      WHERE p.drive_id IN (${ids})
    )
    SELECT COALESCE(json_agg(json_build_object(
      'lat', lat, 'lng', lng, 'drive_id', drive_id, 'at', at, 'power_kw', power_kw
    ) ORDER BY at) FILTER (WHERE point_no = 1 OR point_no % 3 = 0), '[]'::json)
    FROM sampled;
  `);
}

export async function getLatestTripRoute() {
  return sqlJson(`
    WITH latest_drive AS (
      SELECT id FROM drives WHERE end_date IS NOT NULL ORDER BY end_date DESC LIMIT 1
    ), sampled AS (
      SELECT p.latitude::float8 AS lat, p.longitude::float8 AS lng, p.drive_id,
             p.date AS at, p.power::float8 AS power_kw,
             row_number() OVER (ORDER BY p.date) AS point_no
      FROM positions p
      JOIN latest_drive d ON d.id = p.drive_id
    )
    SELECT COALESCE(json_agg(json_build_object(
      'lat', lat, 'lng', lng, 'drive_id', drive_id, 'at', at, 'power_kw', power_kw
    ) ORDER BY point_no) FILTER (WHERE point_no = 1 OR point_no % 3 = 0), '[]'::json)
    FROM sampled;
  `);
}

export async function getDriveRoute(driveId) {
  const id = Number(driveId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("invalid drive id");
  return sqlJson(`
    WITH sampled AS (
      SELECT p.latitude::float8 AS lat, p.longitude::float8 AS lng, p.drive_id,
             p.date AS at, p.power::float8 AS power_kw,
             row_number() OVER (ORDER BY p.date) AS point_no
      FROM positions p
      WHERE p.drive_id = ${id}
    )
    SELECT COALESCE(json_agg(json_build_object(
      'lat', lat, 'lng', lng, 'drive_id', drive_id, 'at', at, 'power_kw', power_kw
    ) ORDER BY point_no) FILTER (WHERE point_no = 1 OR point_no % 3 = 0), '[]'::json)
    FROM sampled;
  `);
}

export async function getVehicleOverview() {
  return sqlJson(`
    SELECT json_build_object(
      'model', COALESCE(NULLIF(c.marketing_name, ''), NULLIF(c.model, ''), '特斯拉'),
      'trim', NULLIF(c.trim_badging, ''),
      'state', (
        SELECT s.state::text FROM states s
        WHERE s.car_id = c.id ORDER BY s.start_date DESC LIMIT 1
      ),
      'battery_level', p.battery_level,
      'usable_battery_level', p.usable_battery_level,
      'rated_range_km', round(p.rated_battery_range_km::numeric, 0),
      'ideal_range_km', round(p.ideal_battery_range_km::numeric, 0),
      'odometer_km', round(p.odometer::numeric, 0),
      'inside_temp_c', p.inside_temp,
      'outside_temp_c', p.outside_temp,
      'is_climate_on', p.is_climate_on,
      'updated_at', p.date
    )
    FROM cars c
    LEFT JOIN LATERAL (
      SELECT * FROM positions p0
      WHERE p0.car_id = c.id ORDER BY p0.date DESC LIMIT 1
    ) p ON true
    ORDER BY c.display_priority, c.id
    LIMIT 1;
  `);
}

function periodBounds(period) {
  if (!new Set(["week", "month", "previous_week", "previous_month"]).has(period)) {
    throw new Error(`unsupported period: ${period}`);
  }
  const unit = period === "week" || period === "previous_week" ? "week" : "month";
  const lowerOffset = period === "previous_month" ? " - interval '1 month'" : period === "previous_week" ? " - interval '1 week'" : "";
  const upperClause = period === "previous_month" || period === "previous_week"
    ? "AND d.start_date < b.until_utc"
    : "";
  return { unit, lowerOffset, upperClause };
}

export async function getPeriodTrips(period) {
  const { unit, lowerOffset, upperClause } = periodBounds(period);
  return sqlJson(`
    WITH bounds AS (
      SELECT
        ((((date_trunc('${unit}', now() AT TIME ZONE 'Asia/Shanghai'))${lowerOffset}) AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'UTC') AS since_utc,
        (((date_trunc('${unit}', now() AT TIME ZONE 'Asia/Shanghai')) AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'UTC') AS until_utc
    ), selected_drives AS (
      SELECT d.*, c.efficiency
      FROM drives d
      JOIN cars c ON c.id = d.car_id
      CROSS JOIN bounds b
      WHERE d.end_date IS NOT NULL AND d.start_date >= b.since_utc ${upperClause}
    ), ordered_power AS (
      SELECT
        p.drive_id,
        EXTRACT(EPOCH FROM (lead(p.date) OVER (PARTITION BY p.drive_id ORDER BY p.date) - p.date)) AS seconds,
        (p.power::float8 + lead(p.power::float8) OVER (PARTITION BY p.drive_id ORDER BY p.date)) / 2 AS average_power
      FROM positions p
      JOIN selected_drives d ON d.id = p.drive_id
      WHERE p.power IS NOT NULL
    ), drive_power AS (
      SELECT
        drive_id,
        count(*) AS valid_segments,
        sum(average_power * seconds / 3600) AS net_kwh,
        sum(greatest(average_power, 0) * seconds / 3600) AS drawn_kwh,
        sum(greatest(-average_power, 0) * seconds / 3600) AS regenerated_kwh
      FROM ordered_power
      WHERE seconds > 0 AND seconds <= 10 AND average_power IS NOT NULL
      GROUP BY drive_id
    ), drive_energy AS (
      SELECT
        d.id,
        CASE
          WHEN p.valid_segments > 0 THEN greatest(p.net_kwh, 0)
          WHEN d.efficiency IS NOT NULL
            AND d.start_ideal_range_km IS NOT NULL
            AND d.end_ideal_range_km IS NOT NULL
          THEN greatest(d.start_ideal_range_km - d.end_ideal_range_km, 0) * d.efficiency / 1000
          ELSE NULL
        END AS estimated_kwh,
        CASE WHEN p.valid_segments > 0 THEN p.drawn_kwh ELSE NULL END AS drawn_kwh,
        CASE WHEN p.valid_segments > 0 THEN p.regenerated_kwh ELSE NULL END AS regenerated_kwh,
        CASE
          WHEN p.valid_segments > 0 THEN 'power_integration'
          WHEN d.efficiency IS NOT NULL
            AND d.start_ideal_range_km IS NOT NULL
            AND d.end_ideal_range_km IS NOT NULL
          THEN 'range_efficiency'
          ELSE 'unavailable'
        END AS energy_source
      FROM selected_drives d
      LEFT JOIN drive_power p ON p.drive_id = d.id
    )
    SELECT json_build_object(
      'trip_count', count(d.id),
      'drive_ids', COALESCE(
        json_agg(d.id ORDER BY d.start_date) FILTER (WHERE d.id IS NOT NULL),
        '[]'::json
      ),
      'distance_km', round(COALESCE(sum(d.distance), 0)::numeric, 1),
      'duration_min', COALESCE(sum(d.duration_min), 0),
      'average_distance_km', round(COALESCE(avg(d.distance), 0)::numeric, 1),
      'max_speed_kmh', COALESCE(max(d.speed_max), 0),
      'estimated_kwh', CASE
        WHEN count(d.id) > 0 AND bool_and(e.estimated_kwh IS NOT NULL)
        THEN round(COALESCE(sum(e.estimated_kwh), 0)::numeric, 2)
        ELSE NULL
      END,
      'drawn_kwh', CASE
        WHEN count(d.id) > 0 AND bool_and(e.drawn_kwh IS NOT NULL)
        THEN round(COALESCE(sum(e.drawn_kwh), 0)::numeric, 2)
        ELSE NULL
      END,
      'regenerated_kwh', CASE
        WHEN count(d.id) > 0 AND bool_and(e.regenerated_kwh IS NOT NULL)
        THEN round(COALESCE(sum(e.regenerated_kwh), 0)::numeric, 2)
        ELSE NULL
      END,
      'energy_source', CASE
        WHEN count(d.id) = 0 THEN 'unavailable'
        WHEN bool_and(e.energy_source = 'power_integration') THEN 'power_integration'
        WHEN bool_and(e.energy_source <> 'unavailable') THEN 'mixed'
        ELSE 'unavailable'
      END
    )
    FROM selected_drives d
    LEFT JOIN drive_energy e ON e.id = d.id;
  `);
}

export async function getPeriodRouteCandidates(period) {
  const { unit, lowerOffset, upperClause } = periodBounds(period);
  return sqlJson(`
    WITH bounds AS (
      SELECT
        ((((date_trunc('${unit}', now() AT TIME ZONE 'Asia/Shanghai'))${lowerOffset}) AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'UTC') AS since_utc,
        (((date_trunc('${unit}', now() AT TIME ZONE 'Asia/Shanghai')) AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'UTC') AS until_utc
    )
    SELECT COALESCE(json_agg(json_build_object(
      'id', d.id,
      'start_at', d.start_date,
      'end_at', d.end_date,
      'distance_km', round(d.distance::numeric, 1),
      'start_lat', sp.latitude::float8,
      'start_lng', sp.longitude::float8,
      'end_lat', ep.latitude::float8,
      'end_lng', ep.longitude::float8,
      'start_road', NULLIF(sa.road, ''),
      'end_road', NULLIF(ea.road, '')
    ) ORDER BY d.end_date) FILTER (WHERE d.id IS NOT NULL), '[]'::json)
    FROM drives d
    CROSS JOIN bounds b
    LEFT JOIN positions sp ON sp.id = d.start_position_id
    LEFT JOIN positions ep ON ep.id = d.end_position_id
    LEFT JOIN addresses sa ON sa.id = d.start_address_id
    LEFT JOIN addresses ea ON ea.id = d.end_address_id
    WHERE d.end_date IS NOT NULL AND d.start_date >= b.since_utc ${upperClause};
  `);
}

export async function getPeriodRoute(period) {
  const { unit, lowerOffset, upperClause } = periodBounds(period);
  return sqlJson(`
    WITH bounds AS (
      SELECT
        ((((date_trunc('${unit}', now() AT TIME ZONE 'Asia/Shanghai'))${lowerOffset}) AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'UTC') AS since_utc,
        (((date_trunc('${unit}', now() AT TIME ZONE 'Asia/Shanghai')) AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'UTC') AS until_utc
    ), sampled AS (
      SELECT p.latitude::float8 AS lat, p.longitude::float8 AS lng, p.drive_id,
             row_number() OVER (PARTITION BY p.drive_id ORDER BY p.date) AS point_no
      FROM positions p
      JOIN drives d ON d.id = p.drive_id
      CROSS JOIN bounds b
      WHERE d.end_date IS NOT NULL AND d.start_date >= b.since_utc ${upperClause}
    )
    SELECT COALESCE(json_agg(json_build_object(
      'lat', lat, 'lng', lng, 'drive_id', drive_id
    ) ORDER BY drive_id, point_no) FILTER (WHERE point_no = 1 OR point_no % 5 = 0), '[]'::json)
    FROM sampled;
  `);
}
