async function retry(operation, attempts) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

const inFlight = new WeakMap();
const degradedRetryMs = 5 * 60_000;

export function resolveRouteImage(request, dependencies) {
  let entries = inFlight.get(dependencies.readCache);
  if (!entries) { entries = new Map(); inFlight.set(dependencies.readCache, entries); }
  if (entries.has(request.cacheKey)) return entries.get(request.cacheKey);
  const operation = resolveImage(request, dependencies).finally(() => entries.delete(request.cacheKey));
  entries.set(request.cacheKey, operation);
  return operation;
}

async function resolveImage(request, dependencies) {
  const log = dependencies.log || (() => {});
  const now = dependencies.now || Date.now;
  let cache = {};
  try {
    cache = await dependencies.readCache();
  } catch (error) {
    log({ status: "failed", stage: "cache_read", code: error?.code || error?.name || "UNKNOWN" });
  }
  const cached = cache?.[request.cacheKey];
  const fromCache = () => ({
    status: 'success', cacheHit: true, imageKey: cached.image_key,
    hasRoute: Boolean(cached.has_route),
    mapMeta: { hasBasemap: Boolean(cached.has_basemap), hasEnergyOverlay: Boolean(cached.has_energy_overlay) }
  });
  const retryAt = Date.parse(cached?.retry_after || '') || (Date.parse(cached?.cached_at || '') + degradedRetryMs);
  if (cached?.image_key && (cached.has_basemap || now() < retryAt)) {
    log({ status: "success", stage: "cache", cacheHit: true, durationMs: 0 });
    return {
      status: "success",
      cacheHit: true,
      imageKey: cached.image_key,
      hasRoute: Boolean(cached.has_route),
      mapMeta: {
        hasBasemap: Boolean(cached.has_basemap),
        hasEnergyOverlay: Boolean(cached.has_energy_overlay)
      }
    };
  }
  let preview;
  let route = request.route;
  const renderStarted = now();
  try {
    if (request.getRoute) {
      const started = now();
      route = await request.getRoute();
      log({ status: 'success', stage: 'route_query', durationMs: now() - started });
    }
    preview = await retry(
      () => dependencies.render(route, request.cacheKey, request.labels),
      2
    );
  } catch (error) {
    log({ status: "failed", stage: "render", code: error?.code || error?.name || "UNKNOWN", durationMs: now() - renderStarted });
    if (cached?.image_key) {
      await dependencies.writeCache(request.cacheKey, { ...cached, retry_after: new Date(now() + degradedRetryMs).toISOString() }).catch(() => {});
      return fromCache();
    }
    return {
      status: "failed",
      failureStage: "render",
      hasRoute: Array.isArray(route) && route.length >= 2,
      mapMeta: { hasBasemap: false, hasEnergyOverlay: false }
    };
  }
  log({ status: "success", stage: "render", cacheHit: false, durationMs: now() - renderStarted });
  let imageKey;
  const uploadStarted = now();
  try {
    imageKey = await retry(() => dependencies.upload(preview.path), 2);
  } catch (error) {
    log({ status: "failed", stage: "upload", code: error?.code || error?.name || "UNKNOWN", durationMs: now() - uploadStarted });
    if (cached?.image_key) {
      await dependencies.writeCache(request.cacheKey, { ...cached, retry_after: new Date(now() + degradedRetryMs).toISOString() }).catch(() => {});
      return fromCache();
    }
    return {
      status: "failed",
      failureStage: "upload",
      hasRoute: Boolean(preview.hasRoute),
      mapMeta: {
        hasBasemap: Boolean(preview.hasBasemap),
        hasEnergyOverlay: Boolean(preview.hasEnergyOverlay)
      }
    };
  }
  log({ status: "success", stage: "upload", cacheHit: false, durationMs: now() - uploadStarted });
  try {
    await dependencies.writeCache(request.cacheKey, {
      image_key: imageKey,
      has_route: preview.hasRoute,
      has_basemap: preview.hasBasemap,
      has_energy_overlay: preview.hasEnergyOverlay,
      cached_at: new Date(now()).toISOString()
    });
  } catch (error) {
    log({ status: "failed", stage: "cache_write", code: error?.code || error?.name || "UNKNOWN" });
  }
  return {
    status: "success",
    imageKey,
    hasRoute: preview.hasRoute,
    mapMeta: {
      hasBasemap: preview.hasBasemap,
      hasEnergyOverlay: preview.hasEnergyOverlay
    }
  };
}
