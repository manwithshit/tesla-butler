const EARTH_RADIUS_M = 6_371_000;

function radians(value) {
  return Number(value) * Math.PI / 180;
}

export function haversineMeters(a, b) {
  const lat1 = radians(a.lat);
  const lat2 = radians(b.lat);
  const deltaLat = lat2 - lat1;
  const deltaLng = radians(b.lng) - radians(a.lng);
  const value = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(value));
}

function validPoint(lat, lng) {
  return Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));
}

function mode(values, fallback = "道路未知") {
  const counts = new Map();
  for (const value of values.map((item) => String(item || "").trim()).filter(Boolean)) {
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))[0]?.[0] || fallback;
}

function addPoint(centroid, point) {
  const count = centroid.count + 1;
  return {
    lat: (centroid.lat * centroid.count + point.lat) / count,
    lng: (centroid.lng * centroid.count + point.lng) / count,
    count
  };
}

function routeMatch(cluster, start, end, thresholdMeters) {
  const forward = haversineMeters(start, cluster.a) + haversineMeters(end, cluster.b);
  const reverse = haversineMeters(start, cluster.b) + haversineMeters(end, cluster.a);
  const forwardFits = haversineMeters(start, cluster.a) <= thresholdMeters
    && haversineMeters(end, cluster.b) <= thresholdMeters;
  const reverseFits = haversineMeters(start, cluster.b) <= thresholdMeters
    && haversineMeters(end, cluster.a) <= thresholdMeters;
  if (!forwardFits && !reverseFits) return null;
  return reverseFits && (!forwardFits || reverse < forward)
    ? { reversed: true, score: reverse }
    : { reversed: false, score: forward };
}

export function selectMainRoute(drives, options = {}) {
  const thresholdMeters = options.thresholdMeters ?? 750;
  const minimumTrips = options.minimumTrips ?? 3;
  const candidates = (Array.isArray(drives) ? drives : []).filter((drive) =>
    validPoint(drive.start_lat, drive.start_lng)
    && validPoint(drive.end_lat, drive.end_lng)
    && Number.isFinite(Number(drive.distance_km))
  ).sort((a, b) => new Date(a.end_at || 0) - new Date(b.end_at || 0));
  const clusters = [];

  for (const drive of candidates) {
    const start = { lat: Number(drive.start_lat), lng: Number(drive.start_lng) };
    const end = { lat: Number(drive.end_lat), lng: Number(drive.end_lng) };
    let best = null;
    for (const cluster of clusters) {
      const match = routeMatch(cluster, start, end, thresholdMeters);
      if (match && (!best || match.score < best.match.score)) best = { cluster, match };
    }
    if (!best) {
      clusters.push({
        a: { ...start, count: 1 },
        b: { ...end, count: 1 },
        roadsA: [drive.start_road],
        roadsB: [drive.end_road],
        drives: [drive],
        distanceKm: Number(drive.distance_km)
      });
      continue;
    }
    const { cluster, match } = best;
    const pointA = match.reversed ? end : start;
    const pointB = match.reversed ? start : end;
    cluster.a = addPoint(cluster.a, pointA);
    cluster.b = addPoint(cluster.b, pointB);
    cluster.roadsA.push(match.reversed ? drive.end_road : drive.start_road);
    cluster.roadsB.push(match.reversed ? drive.start_road : drive.end_road);
    cluster.drives.push(drive);
    cluster.distanceKm += Number(drive.distance_km);
  }

  const winner = clusters
    .filter((cluster) => cluster.drives.length >= minimumTrips)
    .sort((a, b) => b.drives.length - a.drives.length || b.distanceKm - a.distanceKm)[0];
  if (!winner) return null;
  const representative = [...winner.drives].sort((a, b) => new Date(b.end_at || 0) - new Date(a.end_at || 0))[0];
  return {
    label: `${mode(winner.roadsA)} ↔ ${mode(winner.roadsB)}`,
    trip_count: winner.drives.length,
    distance_km: Number(winner.distanceKm.toFixed(1)),
    representative_drive_id: representative.id,
    representative_start_road: representative.start_road || "起点未知",
    representative_end_road: representative.end_road || "终点未知"
  };
}

