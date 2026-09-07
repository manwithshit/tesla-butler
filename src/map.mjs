import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config, projectPath } from "./config.mjs";
import { runFile } from "./lib/process.mjs";
import { safeErrorCode } from './worker-runtime.mjs';

const WIDTH = 1200;
const HEIGHT = 560;
const TILE_SIZE = 256;
const ENERGY_COLORS = Object.freeze({
  low: "#20A464",
  medium: "#F59E0B",
  high: "#E5484D"
});

function outsideChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
  let value = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  value += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  value += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
  value += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
  return value;
}

function transformLng(x, y) {
  let value = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  value += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  value += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
  value += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x * Math.PI / 30)) * 2 / 3;
  return value;
}

export function wgs84ToGcj02(lat, lng) {
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || outsideChina(latitude, longitude)) {
    return { lat: latitude, lng: longitude };
  }
  const a = 6378245.0;
  const ee = 0.00669342162296594323;
  let deltaLat = transformLat(longitude - 105, latitude - 35);
  let deltaLng = transformLng(longitude - 105, latitude - 35);
  const radLat = latitude / 180 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  deltaLat = deltaLat * 180 / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
  deltaLng = deltaLng * 180 / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
  return { lat: latitude + deltaLat, lng: longitude + deltaLng };
}

function quantile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function smoothedPowers(route, radius = 4) {
  return route.map((_, index) => {
    const values = route
      .slice(Math.max(0, index - radius), Math.min(route.length, index + radius + 1))
      .map((point) => Number(point.power_kw))
      .filter(Number.isFinite);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  });
}

export function buildEnergySegments(route) {
  if (!Array.isArray(route) || route.length < 2) return [];
  const powers = smoothedPowers(route);
  const rawSegments = [];
  for (let index = 1; index < route.length; index += 1) {
    const a = route[index - 1];
    const b = route[index];
    if (String(a.drive_id) !== String(b.drive_id)) continue;
    rawSegments.push({ a, b, power_kw: (powers[index - 1] + powers[index]) / 2 });
  }
  const bucketSize = Math.max(1, Math.min(20, Math.floor(route.length / 12)));
  const bucketPowers = [];
  for (let index = 0; index < rawSegments.length; index += bucketSize) {
    const bucket = rawSegments.slice(index, index + bucketSize);
    bucketPowers.push(bucket.reduce((sum, segment) => sum + segment.power_kw, 0) / bucket.length);
  }
  const positivePowers = bucketPowers.filter((value) => value > 0);
  const lowThreshold = quantile(positivePowers, 0.33);
  const highThreshold = quantile(positivePowers, 0.67);
  const segments = [];
  for (let index = 0; index < rawSegments.length; index += 1) {
    const raw = rawSegments[index];
    const power = bucketPowers[Math.floor(index / bucketSize)];
    const level = power <= lowThreshold ? "low" : power <= highThreshold ? "medium" : "high";
    segments.push({ ...raw, power_kw: power, level, color: ENERGY_COLORS[level] });
  }
  return segments;
}

function worldPixel(point, zoom) {
  const scale = TILE_SIZE * 2 ** zoom;
  const sine = Math.min(0.9999, Math.max(-0.9999, Math.sin(point.lat * Math.PI / 180)));
  return {
    ...point,
    x: (point.lng + 180) / 360 * scale,
    y: (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * scale
  };
}

function fitMap(points) {
  for (let zoom = 17; zoom >= 3; zoom -= 1) {
    const projected = points.map((point) => worldPixel(point, zoom));
    const xs = projected.map((point) => point.x);
    const ys = projected.map((point) => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    if (maxX - minX <= WIDTH - 180 && maxY - minY <= HEIGHT - 150) {
      return {
        zoom,
        originX: (minX + maxX) / 2 - WIDTH / 2,
        originY: (minY + maxY) / 2 - HEIGHT / 2
      };
    }
  }
  throw new Error("route bounds are too large to render");
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character]);
}

function tileUrl(x, y, zoom) {
  return `https://wprd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x=${x}&y=${y}&z=${zoom}`;
}

function tileElements(fit) {
  const startX = Math.floor(fit.originX / TILE_SIZE);
  const endX = Math.floor((fit.originX + WIDTH) / TILE_SIZE);
  const startY = Math.floor(fit.originY / TILE_SIZE);
  const endY = Math.floor((fit.originY + HEIGHT) / TILE_SIZE);
  const tiles = [];
  for (let y = startY; y <= endY; y += 1) {
    for (let x = startX; x <= endX; x += 1) {
      tiles.push(`<img class="tile" src="${tileUrl(x, y, fit.zoom)}" style="left:${Math.round(x * TILE_SIZE - fit.originX)}px;top:${Math.round(y * TILE_SIZE - fit.originY)}px">`);
    }
  }
  return tiles.join("");
}

function screenPoint(point, fit) {
  const projected = worldPixel(point, fit.zoom);
  return { ...point, x: projected.x - fit.originX, y: projected.y - fit.originY };
}

function routeSvg(points, fit) {
  const screenPoints = points.map((point) => screenPoint(point, fit));
  const segments = buildEnergySegments(screenPoints);
  const routePath = screenPoints.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const segmentLines = segments.map((segment) => (
    `<line x1="${segment.a.x.toFixed(1)}" y1="${segment.a.y.toFixed(1)}" x2="${segment.b.x.toFixed(1)}" y2="${segment.b.y.toFixed(1)}" stroke="${segment.color}" stroke-width="9" stroke-linecap="round"/>`
  )).join("");
  const start = screenPoints[0];
  const end = screenPoints.at(-1);
  return `<svg class="route" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <polyline points="${routePath}" fill="none" stroke="rgba(255,255,255,.92)" stroke-width="15" stroke-linecap="round" stroke-linejoin="round"/>
    ${segmentLines}
    <circle cx="${start.x}" cy="${start.y}" r="12" fill="#20A464" stroke="white" stroke-width="5"/>
    <circle cx="${end.x}" cy="${end.y}" r="12" fill="#FF7A45" stroke="white" stroke-width="5"/>
  </svg>`;
}

function annotation(point, fit, text, kind) {
  const screen = screenPoint(point, fit);
  return `<div class="annotation ${kind}" style="left:${Math.round(screen.x)}px;top:${Math.round(screen.y)}px">${escapeHtml(text)}</div>`;
}

function energyAnnotations(points, fit) {
  const segments = buildEnergySegments(points);
  if (!segments.length) return "";
  const highest = segments.reduce((best, segment) => segment.power_kw > best.power_kw ? segment : best);
  const highScreen = screenPoint(highest.b, fit);
  const lowCandidates = [...segments].sort((a, b) => a.power_kw - b.power_kw);
  const lowest = lowCandidates.find((segment) => {
    const point = screenPoint(segment.b, fit);
    return Math.hypot(point.x - highScreen.x, point.y - highScreen.y) >= 150;
  }) || lowCandidates[0];
  return [annotation(highest.b, fit, "高耗段", "high"), annotation(lowest.b, fit, "低耗段", "low")].join("");
}

function mapHtml(points, fit, labels) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:#eef2f7;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
    #map{position:relative;width:100%;height:100%;overflow:hidden}.tile{position:absolute;width:256px;height:256px;user-select:none}.wash{position:absolute;inset:0;background:rgba(255,255,255,.12)}
    .route{position:absolute;inset:0;width:100%;height:100%}.legend{position:absolute;left:24px;top:22px;padding:12px 14px;border-radius:12px;background:rgba(255,255,255,.94);box-shadow:0 4px 18px rgba(31,35,41,.16);font-size:16px;font-weight:650;color:#1f2329}
    .legend-row{display:flex;gap:14px;align-items:center}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px}.low-dot{background:${ENERGY_COLORS.low}}.medium-dot{background:${ENERGY_COLORS.medium}}.high-dot{background:${ENERGY_COLORS.high}}.legend small{display:block;margin-top:5px;color:#646a73;font-size:12px;font-weight:450}
    .annotation{position:absolute;transform:translate(-50%,-130%);padding:5px 9px;border-radius:8px;background:rgba(255,255,255,.96);box-shadow:0 2px 10px rgba(31,35,41,.18);font-size:13px;font-weight:650;white-space:nowrap}.annotation.start{color:#177d52}.annotation.end{color:#c84b31}.annotation.high{color:#c92a2a;transform:translate(-50%,25%)}.annotation.low{color:#13795b;transform:translate(-50%,25%)}
    .attribution{position:absolute;right:12px;bottom:8px;padding:3px 6px;border-radius:5px;background:rgba(255,255,255,.82);font-size:11px;color:#646a73}
  </style></head><body><div id="map">${tileElements(fit)}<div class="wash"></div>${routeSvg(points, fit)}
    ${energyAnnotations(points, fit)}
    ${annotation(points[0], fit, labels.start || "起点", "start")}
    ${annotation(points.at(-1), fit, labels.end || "终点", "end")}
    <div class="legend"><div class="legend-row"><span><i class="dot low-dot"></i>低耗</span><span><i class="dot medium-dot"></i>中耗</span><span><i class="dot high-dot"></i>高耗</span></div><small>按本次行程功率分位着色</small></div>
    <div class="attribution">© 高德地图 · 轨迹 TeslaMate</div>
  </div></body></html>`;
}

function imageBuffer() {
  return Buffer.alloc(WIDTH * HEIGHT * 3, 244);
}

function blend(pixels, x, y, color, alpha = 1) {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= WIDTH || py >= HEIGHT) return;
  const index = (py * WIDTH + px) * 3;
  for (let channel = 0; channel < 3; channel += 1) {
    pixels[index + channel] = Math.round(pixels[index + channel] * (1 - alpha) + color[channel] * alpha);
  }
}

function circle(pixels, cx, cy, radius, color, alpha = 1) {
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y += 1) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x += 1) {
      const distance = Math.hypot(x - cx, y - cy);
      if (distance <= radius + 0.5) blend(pixels, x, y, color, alpha * Math.min(1, radius + 0.5 - distance));
    }
  }
}

function line(pixels, a, b, width, color, alpha = 1) {
  const distance = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
  const steps = Math.ceil(distance * 1.5);
  for (let index = 0; index <= steps; index += 1) {
    const fraction = index / steps;
    circle(pixels, a.x + (b.x - a.x) * fraction, a.y + (b.y - a.y) * fraction, width / 2, color, alpha);
  }
}

function fallbackProjected(points) {
  const minLng = Math.min(...points.map((point) => point.lng));
  const maxLng = Math.max(...points.map((point) => point.lng));
  const minLat = Math.min(...points.map((point) => point.lat));
  const maxLat = Math.max(...points.map((point) => point.lat));
  const rangeX = Math.max(maxLng - minLng, 0.0001);
  const rangeY = Math.max(maxLat - minLat, 0.0001);
  const scale = Math.min((WIDTH - 180) / rangeX, (HEIGHT - 140) / rangeY);
  return points.map((point) => ({
    ...point,
    x: (WIDTH - rangeX * scale) / 2 + (point.lng - minLng) * scale,
    y: HEIGHT - ((HEIGHT - rangeY * scale) / 2 + (point.lat - minLat) * scale)
  }));
}

function drawFallback(pixels, route) {
  for (let x = -200; x < WIDTH + 200; x += 150) line(pixels, { x, y: 0 }, { x: x + 280, y: HEIGHT }, 2, [210, 220, 233], 0.58);
  for (let y = 70; y < HEIGHT; y += 120) line(pixels, { x: 0, y }, { x: WIDTH, y: y - 45 }, 2, [210, 220, 233], 0.5);
  if (!Array.isArray(route) || route.length < 2) {
    circle(pixels, WIDTH / 2, HEIGHT / 2, 46, [76, 132, 255], 0.4);
    return;
  }
  const points = fallbackProjected(route);
  const segments = buildEnergySegments(points);
  for (const segment of segments) line(pixels, segment.a, segment.b, 15, [255, 255, 255], 0.8);
  for (const segment of segments) {
    const hex = segment.color.slice(1);
    const color = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
    line(pixels, segment.a, segment.b, 8, color, 0.98);
  }
  circle(pixels, points[0].x, points[0].y, 12, [32, 164, 100], 1);
  circle(pixels, points.at(-1).x, points.at(-1).y, 12, [255, 122, 69], 1);
}

async function writeFallbackPng(route, pngPath, safeKey) {
  const pixels = imageBuffer();
  drawFallback(pixels, route);
  const ppmPath = path.join(path.dirname(pngPath), `${safeKey}.ppm`);
  await fs.writeFile(ppmPath, Buffer.concat([Buffer.from(`P6\n${WIDTH} ${HEIGHT}\n255\n`, "ascii"), pixels]), { mode: 0o600 });
  try {
    await runFile("/usr/bin/sips", ["-s", "format", "png", ppmPath, "--out", pngPath], { timeout: 30_000 });
  } finally {
    await fs.rm(ppmPath, { force: true });
  }
}

async function renderMapPng(points, pngPath, safeKey, labels, io) {
  let stage = 'bounds';
  try {
  const fit = fitMap(points);
  const centerTileX = Math.floor((fit.originX + WIDTH / 2) / TILE_SIZE);
  const centerTileY = Math.floor((fit.originY + HEIGHT / 2) / TILE_SIZE);
  stage = 'tile_fetch';
  const response = await io.fetch(tileUrl(centerTileX, centerTileY, fit.zoom), { signal: AbortSignal.timeout(6_000) });
  if (!response.ok || !String(response.headers.get("content-type")).startsWith("image/")) throw new Error("map tile unavailable");
  await response.arrayBuffer();
  stage = 'local_file';
  const htmlPath = path.join(path.dirname(pngPath), `${safeKey}.html`);
  await fs.writeFile(htmlPath, mapHtml(points, fit, labels), { mode: 0o600 });
  await fs.rm(pngPath, { force: true });
  try {
    stage = 'browser_render';
    await io.runFile(config.chromeCli, [
      "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
      "--force-device-scale-factor=1", `--window-size=${WIDTH},${HEIGHT}`,
      "--virtual-time-budget=8000", `--screenshot=${pngPath}`,
      pathToFileURL(htmlPath).href
    ], { timeout: 30_000 });
  } finally {
    await fs.rm(htmlPath, { force: true });
  }
  stage = 'image_check';
  const stats = await fs.stat(pngPath);
  if (stats.size < 10_000) throw new Error("rendered map image is unexpectedly small");
  } catch (cause) {
    const error = new Error('Basemap unavailable');
    error.stage = stage;
    error.code = cause?.killed ? 'RENDER_TIMEOUT' : safeErrorCode(cause);
    throw error;
  }
}

export async function renderRoutePreview(route, key = "current", labels = {}, dependencies = {}) {
  const io = { fetch, runFile, ...dependencies };
  const cleanRoute = Array.isArray(route)
    ? route.filter((point) => Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng)))
    : [];
  const converted = cleanRoute.map((point) => ({ ...point, ...wgs84ToGcj02(point.lat, point.lng) }));
  const dir = projectPath("data", "processed", "maps");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const safeKey = String(key).replace(/[^a-zA-Z0-9_-]/g, "-");
  const pngPath = path.join(dir, `${safeKey}.png`);
  if (converted.length >= 2) {
    try {
      await renderMapPng(converted, pngPath, safeKey, labels, io);
      return { path: pngPath, hasRoute: true, hasBasemap: true, hasEnergyOverlay: true };
    } catch (error) {
      const event = { status: 'failed', stage: error.stage || 'unknown', code: safeErrorCode(error) };
      if (io.log) io.log(event);
      else process.stdout.write(`[${new Date().toISOString()}] map_basemap status=failed stage=${event.stage} code=${event.code}\n`);
      await writeFallbackPng(converted, pngPath, safeKey);
      return { path: pngPath, hasRoute: true, hasBasemap: false, hasEnergyOverlay: true };
    }
  }
  await writeFallbackPng(converted, pngPath, safeKey);
  return { path: pngPath, hasRoute: false, hasBasemap: false, hasEnergyOverlay: false };
}
