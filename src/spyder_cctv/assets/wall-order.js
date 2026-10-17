/* Pure camera ordering policy shared by local and static camera walls. */
(() => {
  "use strict";
  const MAX_CAMERAS = 256;
  function baseOrder(config, cameras) {
    const map = new Map(cameras.map((camera) => [camera.id, camera]));
    const pins = new Set(config.pinned || []),
      hidden = new Set(config.hidden || []);
    return [...new Set([...config.order, ...map.keys()])]
      .filter((id) => map.has(id) && (!hidden.has(id) || pins.has(id)))
      .map((id) => map.get(id));
  }
  function order(config, cameras, ranks = new Map(), rotation = null) {
    let result = baseOrder(config, cameras);
    const pins = new Set(config.pinned || []);
    if (config.mode === "featured" && !pins.size && config.featured) {
      const index = result.findIndex((camera) => camera.id === config.featured);
      if (index > 0) result.unshift(...result.splice(index, 1));
    }
    if (config.autoPriority) {
      const movable = result.filter((camera) => !pins.has(camera.id));
      const position = new Map(
        movable.map((camera, index) => [camera.id, index]),
      );
      movable.sort(
        (a, b) =>
          (ranks.get(b.id) || 0) - (ranks.get(a.id) || 0) ||
          position.get(a.id) - position.get(b.id),
      );
      let index = 0;
      result = result.map((camera) =>
        pins.has(camera.id) ? camera : movable[index++],
      );
    }
    if (config.mode === "sequence" && rotation !== null) {
      const fixed = result.filter((camera) => pins.has(camera.id));
      const cycling = result.filter((camera) => !pins.has(camera.id));
      return cycling.length
        ? [
            ...fixed,
            cycling[
              ((rotation % cycling.length) + cycling.length) % cycling.length
            ],
          ]
        : fixed;
    }
    return result;
  }
  function moveAndPin(config, id, targetId, after = false) {
    if (id === targetId) return structuredClone(config);
    if (!config.order.includes(id) || !config.order.includes(targetId))
      throw new Error("Choose cameras in this wall.");
    const next = structuredClone(config);
    next.order = next.order.filter((value) => value !== id);
    next.order.splice(next.order.indexOf(targetId) + (after ? 1 : 0), 0, id);
    next.pinned = [...new Set([...(next.pinned || []), id])];
    next.hidden = next.hidden.filter((value) => value !== id);
    return next;
  }
  function hasActivity(camera, sources) {
    if (camera.state !== "running" || camera.dummy) return false;
    if (
      camera.frame_age_seconds !== undefined &&
      (!Number.isFinite(camera.frame_age_seconds) ||
        camera.frame_age_seconds < 0 ||
        camera.frame_age_seconds > 2)
    )
      return false;
    const metadata = camera.metadata || {};
    if (sources.includes("motion") && Number(metadata.motion_fraction) > 0.02)
      return true;
    const analysis = metadata.analysis || {};
    if (
      sources.includes("motion") &&
      analysis.state === "ready" &&
      Number.isFinite(analysis.result_age_seconds) &&
      analysis.result_age_seconds >= 0 &&
      analysis.result_age_seconds <= 2 &&
      Number(analysis.region_count) > 0
    )
      return true;
    const cv = metadata.cv || {};
    return (
      sources.includes("cv") &&
      cv.state === "ready" &&
      Number.isFinite(cv.result_age_seconds) &&
      cv.result_age_seconds >= 0 &&
      cv.result_age_seconds <= 2 &&
      Array.isArray(cv.detections) &&
      cv.detections.length > 0
    );
  }
  class ActivityRanks {
    constructor() {
      this.entries = new Map();
      this.events = new Map();
      this.serial = 0;
    }
    clear() {
      this.entries.clear();
      this.events.clear();
      this.serial = 0;
    }
    event(id, now) {
      this.events.set(id, now);
    }
    update(cameras, config, now) {
      const sources = config.activitySources || ["motion", "cv", "events"];
      const hold = (config.activityHold || 10) * 1000;
      const present = new Set(cameras.map((camera) => camera.id));
      for (const [id, time] of this.events)
        if (!present.has(id) || now - time > hold) this.events.delete(id);
      for (const id of this.entries.keys())
        if (!present.has(id)) this.entries.delete(id);
      const result = new Map();
      const batchRank = ++this.serial;
      for (const camera of cameras) {
        const signal = hasActivity(camera, sources);
        const eventTime =
          sources.includes("events") && camera.state === "running"
            ? this.events.get(camera.id)
            : undefined;
        let entry = this.entries.get(camera.id) || {
          active: false,
          until: 0,
          rank: 0,
          event: undefined,
        };
        if (
          (signal && !entry.active && entry.until <= now) ||
          (eventTime !== undefined && eventTime !== entry.event)
        )
          entry.rank = batchRank;
        if (signal) entry.until = now + hold;
        if (eventTime !== undefined && eventTime !== entry.event)
          entry.until = Math.max(entry.until, eventTime + hold);
        entry.active = signal;
        entry.event = eventTime;
        this.entries.set(camera.id, entry);
        if (camera.state === "running" && entry.until > now && entry.rank > 0)
          result.set(camera.id, entry.rank);
      }
      return result;
    }
  }
  class ActivityFeed {
    constructor() {
      this.session = null;
      this.seen = new Set();
    }
    accept(snapshot, now, hold = 10000) {
      if (
        !snapshot ||
        typeof snapshot.session_id !== "string" ||
        !Array.isArray(snapshot.activities)
      )
        return [];
      const items = snapshot.activities
        .slice(-100)
        .filter(
          (item) =>
            item &&
            typeof item.id === "string" &&
            item.id.length <= 300 &&
            typeof item.camera_id === "string" &&
            Number.isFinite(item.created_at),
        );
      if (this.session !== snapshot.session_id) {
        this.session = snapshot.session_id;
        this.seen = new Set(items.map((item) => item.id));
        return [];
      }
      const fresh = [];
      for (const item of items) {
        if (this.seen.has(item.id)) continue;
        this.seen.add(item.id);
        const age = now - item.created_at * 1000;
        if (age >= -1000 && age <= hold) fresh.push(item);
      }
      while (this.seen.size > 256)
        this.seen.delete(this.seen.values().next().value);
      return fresh;
    }
  }
  const api = {
    MAX_CAMERAS,
    baseOrder,
    order,
    moveAndPin,
    hasActivity,
    ActivityRanks,
    ActivityFeed,
  };
  if (typeof module !== "undefined") module.exports = api;
  if (typeof window !== "undefined") window.spyderWallOrder = api;
})();
