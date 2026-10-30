/* Measured, session-only degradation. No hardware fingerprinting or remote inference. */
(() => {
  "use strict";
  const levels = [
    { engine: "mog2", tracking: true, inference_fps: 5, name: "MIL + MOG2" },
    { engine: "mog2", tracking: false, inference_fps: 3, name: "MOG2" },
    {
      engine: "mog2",
      tracking: false,
      inference_fps: 1,
      name: "Low-rate MOG2",
    },
    {
      engine: "frame-difference",
      tracking: false,
      inference_fps: 1,
      name: "Frame difference",
    },
  ];
  function create() {
    let level = 0,
      slowSince = null,
      lastTime = null,
      lastFrame = null,
      reason = "Starting with MIL + MOG2";
    function state() {
      return { ...levels[level], level, reason };
    }
    function observe(sample, now, visible = true) {
      if (!visible) {
        slowSince = null;
        lastTime = null;
        return null;
      }
      if (level === 3) return null;
      const error = sample.state === "error",
        trackerError = level === 0 && !!sample.tracking_error;
      if (
        !error &&
        !trackerError &&
        (sample.state !== "ready" || sample.processed_frames === lastFrame)
      )
        return null;
      lastFrame = sample.processed_frames;
      const gap = lastTime === null ? 0 : now - lastTime;
      lastTime = now;
      if (gap > 2500) slowSince = null; // Pauses/background throttling must not look like device overload.
      const budget = level === 0 ? 180 : level === 1 ? 250 : 500;
      const slow =
        (sample.processing_ms || 0) > budget ||
        (sample.roundtrip_ms || 0) > 1500 / levels[level].inference_fps ||
        (level === 0 && (sample.tracking_ms || 0) > 180) ||
        (sample.lag_ms || 0) > (level === 0 ? 500 : 1000);
      if (!error && !trackerError && !slow) {
        slowSince = null;
        return null;
      }
      if (slowSince === null) slowSince = now;
      const severe =
        (sample.processing_ms || 0) > 1500 || (sample.lag_ms || 0) > 3000;
      if (!error && !trackerError && !severe && now - slowSince < 6000)
        return null;
      level = error ? 3 : Math.min(3, level + 1);
      reason = error
        ? "OpenCV unavailable: using frame difference"
        : trackerError
          ? "MIL failed: continuing with MOG2"
          : "Sustained device load: reduced motion analysis";
      slowSince = null;
      lastTime = null;
      lastFrame = null;
      return state();
    }
    return { state, observe };
  }
  const api = { create };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.spyderMotionPolicy = api;
})();
