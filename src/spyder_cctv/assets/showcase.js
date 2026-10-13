/* Static showcase: no network API, uploads, remote streams, or analytics. */
(() => {
  "use strict";
  const cameras = new Map();
  const sleeping = new Set();
  const recording = new Set();
  let away = false;
  let idleTimer;

  async function reconcileActivity() {
    if (away) {
      for (const camera of cameras.values()) {
        if (
          recording.has(camera.id) ||
          !["running", "starting"].includes(camera.state)
        )
          continue;
        sleeping.add(camera.id);
        camera.resumeTime = camera.video?.currentTime || 0;
        stop(camera);
      }
    } else {
      await Promise.allSettled(
        [...sleeping].map(async (id) => {
          sleeping.delete(id);
          const camera = cameras.get(id);
          if (camera) await start(camera);
        }),
      );
    }
  }

  function presence(data) {
    if (
      typeof data.active !== "boolean" ||
      typeof data.release_when_idle !== "boolean"
    )
      throw new Error("Invalid presence");
    clearTimeout(idleTimer);
    if (data.active || !data.release_when_idle) {
      away = false;
      return reconcileActivity();
    }
    if (away) return Promise.resolve();
    idleTimer = setTimeout(() => {
      away = true;
      reconcileActivity();
    }, 2000);
    return Promise.resolve();
  }
  const labels = {
    zoom: "Zoom",
    fov: "Field of view",
    pan: "Pan",
    tilt: "Tilt",
    brightness: "Brightness",
    contrast: "Contrast",
    saturation: "Saturation",
  };
  const storageKey = "spyder-showcase-profiles-v1";
  let profiles = [];
  function validate(settings) {
    if (!settings || typeof settings !== "object" || Array.isArray(settings))
      throw new Error("Invalid settings.");
    for (const [key, value] of Object.entries(settings))
      if (
        !Object.hasOwn(labels, key) ||
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > 100
      )
        throw new Error("Settings must be between 0 and 100%.");
    return { ...settings };
  }
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "[]");
    if (Array.isArray(saved) && saved.length <= 100) {
      const names = new Set();
      const ids = new Set();
      profiles = saved.map((p) => {
        if (
          !/^profile-[\w-]+$/.test(p.id) ||
          typeof p.name !== "string" ||
          !p.name.trim() ||
          p.name.length > 80 ||
          names.has(p.name.toLowerCase()) ||
          ids.has(p.id)
        )
          throw new Error("Invalid saved profiles");
        names.add(p.name.toLowerCase());
        ids.add(p.id);
        return { id: p.id, name: p.name, settings: validate(p.settings) };
      });
    }
  } catch {
    profiles = [];
  }
  function save(next) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      throw new Error(
        "Browser storage unavailable. Allow site storage to save profiles.",
      );
    }
    profiles = next;
  }
  function get(id) {
    const camera = cameras.get(id);
    if (!camera) throw new Error("Unknown camera.");
    return camera;
  }
  function desired(camera) {
    return (
      profiles.find((p) => p.id === camera.profile_id)?.settings ||
      camera.settings
    );
  }
  function capabilities(camera) {
    const ranges = camera.track?.getCapabilities?.() || {};
    const actual = camera.track?.getSettings?.() || {};
    return Object.fromEntries(
      Object.entries(labels).map(([key, label]) => {
        const range = ranges[key];
        if (!range || typeof range.min !== "number" || !(range.max > range.min))
          return [
            key,
            {
              label,
              supported: false,
              reason:
                camera.kind === "webcam"
                  ? "Not exposed by this browser / camera; PTZ may need separate permission."
                  : "Generated feeds and local files have no hardware controls.",
            },
          ];
        const value = actual[key];
        return [
          key,
          {
            label,
            supported: true,
            minimum: range.min,
            maximum: range.max,
            step: range.step || 1,
            native_value: value,
            value:
              typeof value === "number"
                ? ((value - range.min) / (range.max - range.min)) * 100
                : null,
            mode: "Browser",
            default_percent: null,
          },
        ];
      }),
    );
  }
  function snapshot(camera) {
    return {
      id: camera.id,
      name: camera.name,
      state: camera.state,
      available: camera.state === "running",
      profile_id: camera.profile_id,
      capabilities: capabilities(camera),
      desired: desired(camera),
      results: camera.results,
      settings_state: camera.settings_state,
      idle_suspended: sleeping.has(camera.id),
    };
  }
  function status(camera) {
    return {
      id: camera.id,
      name: camera.name,
      source_label: camera.source_label,
      fps: camera.fps,
      pipeline: camera.pipeline,
      state: camera.state,
      error: camera.error,
      frames: camera.frames,
      metadata: { motion_fraction: camera.motion || 0 },
      profile_id: camera.profile_id,
      profile_name:
        profiles.find((p) => p.id === camera.profile_id)?.name || null,
      idle_suspended: sleeping.has(camera.id),
      settings_state: camera.settings_state,
    };
  }
  async function apply(camera) {
    if (camera.state !== "running") {
      camera.settings_state = "scheduled";
      return;
    }
    const track = camera.track;
    const epoch = camera.epoch;
    const results = {};
    for (const [key, percent] of Object.entries(desired(camera))) {
      const cap = capabilities(camera)[key];
      if (!cap.supported || !track) {
        results[key] = { status: "unsupported", message: cap.reason };
        continue;
      }
      const raw = cap.minimum + (percent / 100) * (cap.maximum - cap.minimum);
      const native = Math.min(
        cap.maximum,
        Math.max(
          cap.minimum,
          cap.minimum + Math.round((raw - cap.minimum) / cap.step) * cap.step,
        ),
      );
      try {
        await track.applyConstraints({ advanced: [{ [key]: native }] });
        const actual = track.getSettings()[key];
        results[key] = {
          status:
            typeof actual === "number" &&
            Math.abs(actual - native) <= cap.step / 2
              ? "applied"
              : "rejected",
          message: "Browser hardware readback",
        };
      } catch (error) {
        results[key] = { status: "failed", message: error.message };
      }
      if (camera.epoch !== epoch) return;
    }
    camera.results = results;
    camera.settings_state = Object.values(results).some(
      (r) => r.status !== "applied",
    )
      ? "partial"
      : "applied";
  }
  function stop(camera) {
    camera.epoch++;
    camera.track = null;
    camera.stream?.getTracks().forEach((track) => track.stop());
    camera.stream = null;
    if (camera.video) {
      camera.video.pause();
      camera.video.srcObject = null;
      camera.video.removeAttribute("src");
      camera.video.load();
    }
    camera.video = null;
    if (camera.fileUrl) URL.revokeObjectURL(camera.fileUrl);
    camera.fileUrl = null;
    camera.previous = null;
    camera.blob = null;
    camera.frameTime = 0;
    camera.state = "stopped";
    camera.motion = 0;
    camera.settings_state = Object.keys(desired(camera)).length
      ? "scheduled"
      : "applied";
  }
  async function start(camera) {
    if (camera.state === "running" || camera.state === "starting") return;
    const epoch = ++camera.epoch;
    camera.state = "starting";
    camera.error = null;
    let stream;
    try {
      if (camera.kind !== "demo") {
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.loop = false;
        if (camera.kind === "webcam") {
          if (!navigator.mediaDevices?.getUserMedia)
            throw new Error(
              "Webcams require HTTPS or localhost and a supported browser.",
            );
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              ...(camera.deviceId
                ? { deviceId: { exact: camera.deviceId } }
                : {}),
              ...(camera.ptz ? { pan: true, tilt: true, zoom: true } : {}),
              width: { ideal: 640 },
              height: { ideal: 480 },
              frameRate: { ideal: camera.fps, max: camera.fps },
            },
          });
          if (epoch !== camera.epoch) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          camera.stream = stream;
          camera.track = stream.getVideoTracks()[0];
          video.srcObject = stream;
          camera.deviceId = camera.track.getSettings().deviceId;
          if (
            camera.deviceId &&
            [...cameras.values()].some(
              (other) =>
                other !== camera &&
                other.kind === "webcam" &&
                other.deviceId === camera.deviceId,
            )
          )
            throw new Error(
              "This webcam is already in the wall. Choose another device.",
            );
          camera.track.addEventListener("ended", () => {
            if (camera.epoch === epoch) {
              stop(camera);
              camera.state = "error";
              camera.error = "Camera disconnected or permission revoked.";
            }
          });
        } else {
          camera.fileUrl = URL.createObjectURL(camera.file);
          video.src = camera.fileUrl;
        }
        camera.video = video;
        video.addEventListener("ended", () => {
          if (camera.epoch === epoch) stop(camera);
        });
        await video.play();
        if (
          camera.kind === "file" &&
          camera.resumeTime &&
          camera.resumeTime < video.duration
        )
          video.currentTime = camera.resumeTime;
      }
      if (epoch !== camera.epoch) return;
      camera.state = "running";
      await apply(camera);
    } catch (error) {
      stream?.getTracks().forEach((t) => t.stop());
      if (epoch !== camera.epoch) return;
      stop(camera);
      camera.state = "error";
      camera.error =
        error.name === "NotAllowedError"
          ? "Camera permission denied. Allow this site in browser settings, then Retry."
          : error.name === "NotReadableError"
            ? "Camera busy or unavailable. Close other camera apps, then Retry."
            : error.message;
    }
  }
  async function add(data) {
    const source = data.source;
    const kind =
      source instanceof File ? "file" : source === "demo" ? "demo" : "webcam";
    if (
      kind === "webcam" &&
      (typeof source !== "string" || !source.startsWith("device:"))
    )
      throw new Error(
        "Choose a browser webcam or local file. Remote URLs are unavailable in the showcase.",
      );
    const deviceId = kind === "webcam" ? source.slice(7) : null;
    if (
      kind === "webcam" &&
      deviceId &&
      [...cameras.values()].some(
        (c) => c.kind === "webcam" && c.deviceId === deviceId,
      )
    )
      throw new Error("This webcam is already in the wall.");
    if (
      typeof data.name !== "string" ||
      !data.name.trim() ||
      data.name.length > 80 ||
      !Number.isFinite(data.fps) ||
      data.fps < 1 ||
      data.fps > 30 ||
      !["none", "motion"].includes(data.pipeline)
    )
      throw new Error("Invalid camera details.");
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const camera = {
      id: "cam-" + crypto.randomUUID(),
      name: data.name.trim(),
      kind,
      deviceId,
      file: kind === "file" ? source : null,
      source_label:
        kind === "demo"
          ? "Generated demo · browser only"
          : kind === "file"
            ? "Local file · " + source.name
            : "Browser webcam",
      fps: data.fps,
      pipeline: data.pipeline,
      state: "stopped",
      settings: {},
      profile_id: null,
      settings_state: "applied",
      results: {},
      frames: 0,
      epoch: 0,
      canvas,
      context: canvas.getContext("2d", { willReadFrequently: true }),
      sample: document.createElement("canvas"),
    };
    camera.sample.width = 80;
    camera.sample.height = 45;
    cameras.set(camera.id, camera);
    camera.ptz = document.querySelector("#browser-ptz").checked;
    if (data.autostart) {
      if (away) sleeping.add(camera.id);
      else await start(camera);
    }
    return status(camera);
  }
  async function frame(camera) {
    if (camera.state !== "running") throw new Error("No fresh frame.");
    const epoch = camera.epoch;
    if (camera.blob && performance.now() - camera.frameTime < 1000 / camera.fps)
      return camera.blob;
    const { context: ctx, canvas } = camera;
    if (camera.kind === "demo") {
      const t = performance.now() / 1000;
      ctx.fillStyle = "#171b23";
      ctx.fillRect(0, 0, 640, 360);
      ctx.strokeStyle = "#39404e";
      for (let x = 0; x < 640; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, 360);
        ctx.stroke();
      }
      for (let y = 0; y < 360; y += 40) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(640, y);
        ctx.stroke();
      }
      ctx.fillStyle = "#f7d87f";
      ctx.fillRect(
        220 + Math.sin(t + camera.id.length) * 160,
        150 + Math.cos(t * 0.7) * 70,
        90,
        60,
      );
      ctx.fillStyle = "#ff5c4d";
      ctx.beginPath();
      ctx.arc(320 + Math.cos(t * 0.5) * 200, 160, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#f8ebab";
      ctx.font = "18px sans-serif";
      ctx.fillText("GENERATED DEMO / NO CAMERA FOOTAGE", 24, 32);
    } else {
      if (!camera.video || camera.video.readyState < 2)
        throw new Error("Video warming up.");
      const w = camera.video.videoWidth,
        h = camera.video.videoHeight;
      if (w && h && canvas.height !== Math.round((640 * h) / w))
        canvas.height = Math.round((640 * h) / w);
      ctx.drawImage(camera.video, 0, 0, canvas.width, canvas.height);
    }
    if (camera.pipeline === "motion") {
      const sample = camera.sample.getContext("2d", {
        willReadFrequently: true,
      });
      sample.drawImage(canvas, 0, 0, 80, 45);
      const pixels = sample.getImageData(0, 0, 80, 45).data;
      let changed = 0;
      if (camera.previous)
        for (let i = 0; i < pixels.length; i += 4)
          if (
            Math.abs(pixels[i] - camera.previous[i]) +
              Math.abs(pixels[i + 1] - camera.previous[i + 1]) +
              Math.abs(pixels[i + 2] - camera.previous[i + 2]) >
            75
          )
            changed++;
      camera.motion = changed / (80 * 45);
      camera.previous = pixels;
    }
    camera.frames++;
    const blob = await new Promise((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob ? resolve(blob) : reject(new Error("Frame encoding failed")),
        "image/jpeg",
        0.75,
      ),
    );
    if (camera.epoch !== epoch || camera.state !== "running")
      throw new Error("Camera stopped while encoding.");
    camera.blob = blob;
    camera.frameTime = performance.now();
    return blob;
  }
  async function request(path, data = {}) {
    if (path === "/api/presence") {
      await presence(data);
      return { accepted: true };
    }
    const parts = path.split("/").filter(Boolean);
    if (path === "/api/cameras") return add(data);
    if (path === "/api/profiles") {
      const name = data.name?.trim();
      const settings = validate(data.settings);
      if (!name || name.length > 80 || !Object.keys(settings).length)
        throw new Error("Give the profile a name and settings.");
      if (profiles.some((p) => p.name.toLowerCase() === name.toLowerCase()))
        throw new Error("A profile with this name exists.");
      const profile = { id: "profile-" + crypto.randomUUID(), name, settings };
      save([...profiles, profile]);
      return profile;
    }
    if (parts[1] === "profiles" && parts[3] === "remove") {
      if ([...cameras.values()].some((c) => c.profile_id === parts[2]))
        throw new Error("Detach the profile before deleting it.");
      save(profiles.filter((p) => p.id !== parts[2]));
      return {};
    }
    const camera = get(parts[2]);
    // Serialize mutations per camera; stop/remove remain immediate to cancel permission prompts.
    if (parts[3] === "stop" || parts[3] === "remove") {
      sleeping.delete(camera.id);
      stop(camera);
      if (parts[3] === "remove") {
        cameras.delete(camera.id);
        recording.delete(camera.id);
      }
      return status(camera);
    }
    const queuedEpoch = camera.epoch;
    const operation = async () => {
      if (!cameras.has(camera.id)) throw new Error("Camera removed.");
      if (camera.epoch !== queuedEpoch)
        throw new Error("Camera state changed. Retry this action.");
      if (parts[3] === "start") {
        if (away && !recording.has(camera.id)) sleeping.add(camera.id);
        else {
          sleeping.delete(camera.id);
          await start(camera);
        }
      } else if (parts[3] === "settings") {
        camera.settings = validate(data.settings);
        camera.profile_id = null;
        await apply(camera);
      } else if (parts[3] === "profile") {
        if (
          data.profile_id !== null &&
          !profiles.some((p) => p.id === data.profile_id)
        )
          throw new Error("Unknown profile.");
        camera.settings = { ...desired(camera) };
        camera.profile_id = data.profile_id;
        await apply(camera);
      } else throw new Error("Unknown action.");
      return snapshot(camera);
    };
    const result = (camera.mutation || Promise.resolve()).then(operation);
    camera.mutation = result.catch(() => {});
    return result;
  }
  async function localFetch(path, options = {}) {
    if (options.signal?.aborted)
      throw new DOMException("Aborted", "AbortError");
    let data;
    if (path === "/api/cameras") data = [...cameras.values()].map(status);
    else if (path === "/api/profiles")
      data = profiles.map((p) => ({
        ...p,
        assigned_to: [...cameras.values()]
          .filter((c) => c.profile_id === p.id)
          .map((c) => c.id),
      }));
    else {
      const parts = path.split("/").filter(Boolean);
      const camera = get(parts[2]);
      if (parts[3] === "frame")
        return new Response(await frame(camera), {
          headers: { "Content-Type": "image/jpeg" },
        });
      if (parts[3] !== "settings") throw new Error("Unknown browser route.");
      data = snapshot(camera);
    }
    return Response.json(data);
  }
  const sourceType = document.querySelector("#source-type");
  document.querySelector('#camera-pipeline option[value="vision"]')?.remove();
  sourceType.replaceChildren(
    new Option("Generated demo feed", "demo"),
    new Option("Webcam on this computer", "webcam"),
    new Option("Video file on this computer", "file"),
  );
  const deviceSelect = document.createElement("select");
  deviceSelect.id = "browser-device";
  deviceSelect.setAttribute("aria-label", "Webcam device");
  deviceSelect.append(new Option("Default webcam (permission required)", ""));
  document.querySelector("#camera-source").after(deviceSelect);
  const ptzLabel = document.createElement("label");
  ptzLabel.className = "checkbox-label";
  const ptzInput = document.createElement("input");
  ptzInput.type = "checkbox";
  ptzInput.id = "browser-ptz";
  ptzLabel.append(
    ptzInput,
    document.createTextNode(
      "Request hardware pan / tilt / zoom permission (optional)",
    ),
  );
  document.querySelector("#source-help").after(ptzLabel);
  async function enumerate() {
    const selected = deviceSelect.value;
    const devices = (await navigator.mediaDevices?.enumerateDevices?.()) || [];
    deviceSelect.replaceChildren(
      new Option("Default webcam (permission required)", ""),
    );
    for (const device of devices.filter(
      (d) => d.kind === "videoinput" && d.deviceId,
    ))
      deviceSelect.append(
        new Option(
          device.label || "Webcam " + deviceSelect.options.length,
          device.deviceId,
        ),
      );
    if ([...deviceSelect.options].some((o) => o.value === selected))
      deviceSelect.value = selected;
  }
  function configureSource() {
    const kind = sourceType.value;
    const input = document.querySelector("#camera-source");
    input.value = "";
    input.type = kind === "file" ? "file" : "text";
    input.accept = "video/*";
    input.hidden = kind !== "file";
    input.required = kind === "file";
    deviceSelect.hidden = kind !== "webcam";
    ptzLabel.hidden = kind !== "webcam";
    document.querySelector("#source-label").textContent =
      kind === "file"
        ? "Choose a local video"
        : kind === "webcam"
          ? "Browser webcam"
          : "Generated on this computer";
    document.querySelector("#source-help").textContent =
      kind === "webcam"
        ? "Permission requested only when you start. After allowing access, available devices appear here. Hardware controls depend on browser support."
        : kind === "file"
          ? "The file stays in this tab. Nothing is uploaded. Choose it again after reloading."
          : "Animated sample with real browser-side motion analysis. No camera access.";
    document.querySelector("#camera-autostart").nextElementSibling.textContent =
      "Start now (camera workspace lasts for this tab)";
    enumerate().catch(() => {});
  }
  navigator.mediaDevices?.addEventListener?.("devicechange", () =>
    enumerate().catch(() => {}),
  );
  window.spyderShowcase = {
    setRecording: async (id, active) => {
      const camera = get(id);
      if (typeof active !== "boolean")
        throw new Error("Recording state must be boolean");
      if (active) {
        recording.add(id);
        sleeping.delete(id);
        await start(camera);
      } else {
        recording.delete(id);
        await reconcileActivity();
      }
    },
    request: async (...args) => {
      const result = await request(...args);
      enumerate().catch(() => {});
      return result;
    },
    fetch: localFetch,
    configureSource,
    readSource: () =>
      sourceType.value === "file"
        ? document.querySelector("#camera-source").files[0]
        : sourceType.value === "demo"
          ? "demo"
          : "device:" + deviceSelect.value,
  };
  document.querySelector(".room-label").textContent = "BROWSER SHOWCASE";
  document.querySelector(".intro").textContent =
    "Try the wall. Camera access, files, and motion analysis stay on your computer. The cloud serves only this interface.";
  document.querySelector(".rail-footer small").textContent =
    "No video uploads · no cloud processing";
  document.querySelector("#empty p").textContent =
    "Add a generated feed, your webcam, or a local video. For RTSP and native driver controls, install the local Python app.";
  document.querySelector("#remove-dialog .field-help").textContent =
    "This tab’s feed will stop and leave the wall. Saved browser profiles remain on this device.";
  window.addEventListener("pagehide", () => {
    clearTimeout(idleTimer);
    for (const c of cameras.values()) {
      if (["running", "starting"].includes(c.state)) sleeping.add(c.id);
      stop(c);
    }
  });
  add({
    name: "Demo / North",
    source: "demo",
    fps: 10,
    pipeline: "motion",
    autostart: true,
  });
  add({
    name: "Demo / South",
    source: "demo",
    fps: 10,
    pipeline: "motion",
    autostart: true,
  });
})();
