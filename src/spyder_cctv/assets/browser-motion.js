/* Small, shared ROI motion measurements and bundled approach presets. No inference or network. */
(() => {
  "use strict";
  const catalog =
    typeof module === "object" && module.exports
      ? require("./demo-cameras.js")
      : window.spyderDemoCameraCatalog;
  const SEED_KEY = "spyder.demo.approach-presets.v1";
  function validRoi(roi) {
    return (
      Array.isArray(roi) &&
      roi.length === 4 &&
      roi.every(Number.isFinite) &&
      roi[0] >= 0 &&
      roi[1] >= 0 &&
      roi[2] <= 1 &&
      roi[3] <= 1 &&
      roi[0] < roi[2] &&
      roi[1] < roi[3]
    );
  }
  function fraction(sample, roi = null) {
    if (
      !sample ||
      !sample.mask ||
      !Number.isInteger(sample.width) ||
      !Number.isInteger(sample.height) ||
      sample.width < 1 ||
      sample.height < 1 ||
      sample.mask.length !== sample.width * sample.height ||
      (roi !== null && !validRoi(roi))
    )
      return 0;
    const [x1, y1, x2, y2] = roi || [0, 0, 1, 1];
    const left = Math.floor(x1 * sample.width),
      top = Math.floor(y1 * sample.height),
      right = Math.min(sample.width, Math.ceil(x2 * sample.width)),
      bottom = Math.min(sample.height, Math.ceil(y2 * sample.height));
    let changed = 0;
    for (let y = top; y < bottom; y++)
      for (let x = left; x < right; x++)
        changed += sample.mask[y * sample.width + x] ? 1 : 0;
    return changed / ((right - left) * (bottom - top));
  }
  function measure(current, previous, width = 80, height = 45) {
    const mask = new Uint8Array(width * height);
    let changed = 0;
    if (
      previous &&
      current.length === previous.length &&
      current.length === mask.length * 4
    )
      for (let pixel = 0; pixel < mask.length; pixel++) {
        const i = pixel * 4;
        if (
          Math.abs(current[i] - previous[i]) +
            Math.abs(current[i + 1] - previous[i + 1]) +
            Math.abs(current[i + 2] - previous[i + 2]) >
          75
        ) {
          mask[pixel] = 1;
          changed++;
        }
      }
    // Scene edits or major exposure changes should not impersonate an arrival.
    if (changed / mask.length > 0.65) mask.fill(0);
    return { mask, width, height };
  }
  const clips = () => catalog.cameras.filter((clip) => clip.motion_preset);
  function workflow(clip, cameraId = "") {
    const preset = clip.motion_preset;
    if (!preset || !validRoi(preset.roi))
      throw Error("Clip has no valid approach preset.");
    return {
      id: "demo-approach-" + clip.id,
      name: "Approach · " + preset.name,
      enabled: false,
      preset_clip_id: clip.id,
      camera_ids: cameraId ? [cameraId] : [],
      nodes: [
        {
          id: "camera",
          type: "camera",
          x: 40,
          y: 90,
          params: { camera_id: cameraId },
        },
        {
          id: "motion",
          type: "browser_motion",
          x: 280,
          y: 90,
          params: { threshold: preset.threshold, roi: [...preset.roi] },
        },
        {
          id: "cooldown",
          type: "cooldown",
          x: 520,
          y: 90,
          params: { seconds: preset.cooldown_seconds },
        },
        {
          id: "event",
          type: "event",
          x: 760,
          y: 90,
          params: {
            duration_seconds: 10,
            pre_event_seconds: 0,
            message: preset.description,
            name_pattern: "Approach motion · {camera} · {date} {time}",
            attachment: "capture",
          },
        },
      ],
      edges: [
        { from: "camera", to: "motion", input: "camera" },
        { from: "motion", to: "cooldown" },
        { from: "cooldown", to: "event" },
      ],
    };
  }
  async function seed(store, cameras, storage) {
    if (storage.getItem(SEED_KEY) === "1") return;
    for (const clip of clips()) {
      const graph = workflow(
        clip,
        cameras.find((c) => c.demo_clip_id === clip.id)?.id || "",
      );
      if (!(await store.get(graph.id))) await store.save(graph);
    }
    storage.setItem(SEED_KEY, "1");
  }
  function renderRegion(stage, camera) {
    const region = camera.metadata?.motion_region;
    let svg = stage.querySelector(".demo-motion-region");
    if (
      !region ||
      !validRoi(region.roi) ||
      camera.state !== "running" ||
      stage.querySelector(".camera-image")?.hidden
    ) {
      svg?.remove();
      return;
    }
    if (!svg) {
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.classList.add("demo-motion-region");
      svg.setAttribute("aria-hidden", "true");
      const rect = document.createElementNS(svg.namespaceURI, "rect");
      svg.append(rect);
      stage.append(svg);
    }
    const [w, h] = region.frame_size,
      [x1, y1, x2, y2] = region.roi;
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute(
      "preserveAspectRatio",
      stage.closest(".camera-card")?.dataset.fit === "fill"
        ? "xMidYMid slice"
        : "xMidYMid meet",
    );
    svg.dataset.active = region.active ? "true" : "false";
    const rect = svg.firstElementChild;
    for (const [key, value] of Object.entries({
      x: x1 * w,
      y: y1 * h,
      width: (x2 - x1) * w,
      height: (y2 - y1) * h,
    }))
      rect.setAttribute(key, value);
  }
  const api = {
    validRoi,
    fraction,
    measure,
    clips,
    workflow,
    seed,
    renderRegion,
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.spyderBrowserMotion = api;
})();
