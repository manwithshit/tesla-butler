import test from "node:test";
import assert from "node:assert/strict";
import { resolveRouteImage } from "../src/route-image.mjs";

test("a transient Feishu image upload is retried before showing a trip without a map", async () => {
  let uploads = 0;
  const result = await resolveRouteImage({
    cacheKey: "trip-a",
    route: [{ lat: 30, lng: 120 }, { lat: 30.1, lng: 120.1 }],
    labels: {}
  }, {
    readCache: async () => ({}),
    writeCache: async () => {},
    render: async () => ({
      path: "/tmp/trip-a.png",
      hasRoute: true,
      hasBasemap: true,
      hasEnergyOverlay: true
    }),
    upload: async () => {
      uploads += 1;
      if (uploads === 1) throw new Error("temporary upload failure");
      return "img_trip_a";
    },
    log: () => {}
  });

  assert.equal(result.status, "success");
  assert.equal(result.imageKey, "img_trip_a");
  assert.equal(uploads, 2);
});

test("the same completed trip reuses its uploaded Feishu map", async () => {
  let renders = 0;
  let uploads = 0;
  const result = await resolveRouteImage({
    cacheKey: "trip-a",
    route: [{ lat: 30, lng: 120 }, { lat: 30.1, lng: 120.1 }],
    labels: {}
  }, {
    readCache: async () => ({
      "trip-a": {
        image_key: "img_cached",
        has_route: true,
        has_basemap: true,
        has_energy_overlay: true
      }
    }),
    writeCache: async () => {},
    render: async () => { renders += 1; },
    upload: async () => { uploads += 1; },
    log: () => {}
  });

  assert.equal(result.status, "success");
  assert.equal(result.imageKey, "img_cached");
  assert.equal(result.cacheHit, true);
  assert.equal(renders, 0);
  assert.equal(uploads, 0);
});

test("a repeated image upload failure returns an explicit upload-stage result", async () => {
  const diagnostics = [];
  const result = await resolveRouteImage({
    cacheKey: "trip-b",
    route: [{ lat: 30, lng: 120 }, { lat: 30.1, lng: 120.1 }],
    labels: {}
  }, {
    readCache: async () => ({}),
    writeCache: async () => {},
    render: async () => ({
      path: "/tmp/trip-b.png",
      hasRoute: true,
      hasBasemap: true,
      hasEnergyOverlay: true
    }),
    upload: async () => { throw new Error("upload unavailable"); },
    log: (event) => diagnostics.push(event)
  });

  assert.equal(result.status, "failed");
  assert.equal(result.failureStage, "upload");
  assert.equal(result.hasRoute, true);
  const failure = diagnostics.find((item) => item.status === "failed");
  assert.equal(failure.stage, "upload");
  assert.equal(typeof failure.durationMs, "number");
});

test("a cache write failure does not hide an otherwise valid map", async () => {
  const diagnostics = [];
  const result = await resolveRouteImage({
    cacheKey: "trip-c",
    route: [{ lat: 30, lng: 120 }, { lat: 30.1, lng: 120.1 }],
    labels: {}
  }, {
    readCache: async () => ({}),
    writeCache: async () => { throw new Error("disk unavailable"); },
    render: async () => ({
      path: "/tmp/trip-c.png",
      hasRoute: true,
      hasBasemap: true,
      hasEnergyOverlay: true
    }),
    upload: async () => "img_trip_c",
    log: (event) => diagnostics.push(event)
  });

  assert.equal(result.status, "success");
  assert.equal(result.imageKey, "img_trip_c");
  assert.equal(diagnostics.some((item) => item.stage === "cache_write" && item.status === "failed"), true);
});
