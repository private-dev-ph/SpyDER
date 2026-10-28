/* Static showcase: no network API, uploads, remote streams, or analytics. */
(() => {
  "use strict";
  const cameras = new Map();
  const catalog = window.spyderDemoCameraCatalog;
  const listeners = new Set();
  const sampleStorageKey = "spyder-demo-camera-feeds-v1";
  let restoring = true;
  function persistSamples() {
    if (restoring || !catalog) return;
    try {
      localStorage.setItem(
        sampleStorageKey,
        JSON.stringify(
          [...cameras.values()]
            .filter((c) => c.kind === "sample")
            .map((c) => ({
              id: c.id,
              name: c.name,
              source: "demo://" + c.clip.id,
              fps: c.fps,
              pipeline: c.pipeline,
              autostart: !!c.wantsRunning,
              settings: c.settings,
              profile_id: c.profile_id,
            })),
        ),
      );
    } catch {
      /* Playback works even when browser persistence is unavailable. */
    }
  }

  const sleeping = new Set();
  const recording = new Set();
  let away = false;
  let idleTimer;

  async function reconcileActivity() {
    if (away) {
      for (const camera of cameras.values()) {
        if (
          recording.has(camera.id) ||
          !["running", "starting", "reconnecting"].includes(camera.state)
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
    if (camera.kind === "sample")
      return Object.fromEntries(
        Object.entries(labels).map(([key, label]) => [
          key,
          {
            label,
            supported: true,
            minimum: 0,
            maximum: 100,
            step: 1,
            value: desired(camera)[key] ?? catalog.defaults[key],
            native_value: desired(camera)[key] ?? catalog.defaults[key],
            mode: "Software · demo clip",
            default_percent: catalog.defaults[key],
          },
        ]),
      );
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
      recording: recording.has(camera.id),
      idle_suspended: sleeping.has(camera.id),
    };
  }
  function status(camera) {
    return {
      id: camera.id,
      name: camera.name,
      source_label: camera.source_label,
      source_kind: camera.kind,
      demo_clip_id: camera.clip?.id || null,
      footage_credit: camera.clip
        ? {
            author: camera.clip.author,
            title: camera.clip.original_title,
            source_url: camera.clip.source_url,
            license: camera.clip.license,
            license_url: camera.clip.license_url,
          }
        : null,
      fps: camera.fps,
      pipeline: camera.pipeline,
      state: camera.state,
      recording: recording.has(camera.id),
      error: camera.error,
      frames: camera.frames,
      capture_session: camera.capture_session,
      metadata: { motion_fraction: camera.motion || 0 },
      reconnection: {
        ...camera.reconnection,
        retry_in_seconds:
          camera.retryDeadline === null
            ? camera.reconnection.retry_in_seconds
            : Math.max(
                0,
                Math.ceil((camera.retryDeadline - performance.now()) / 1000),
              ),
      },
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
    if (camera.kind === "sample") {
      camera.results = Object.fromEntries(
        Object.keys(desired(camera)).map((key) => [
          key,
          {
            status: "applied",
            message: "Software tuning on the demo camera frame",
          },
        ]),
      );
      camera.settings_state = "applied";
      camera.blob = null;
      camera.previous = null;
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
  function stop(camera, { preserveReconnect = false } = {}) {
    clearTimeout(camera.retryTimer);
    camera.retryTimer = null;
    camera.retryDeadline = null;
    camera.epoch++;
    camera.framePromise = null;
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
    camera.capture_session = null;
    camera.state = "stopped";
    camera.motion = 0;
    if (!preserveReconnect) {
      camera.reconnection.enabled = false;
      camera.reconnection.retry_in_seconds = null;
      camera.reconnection.attempt = 0;
      camera.reconnectStableSince = 0;
    }
    camera.settings_state = Object.keys(desired(camera)).length
      ? "scheduled"
      : "applied";
  }
  const retryDelays = [1, 2, 4, 8, 16, 30];
  function reconnectFailure(camera, error) {
    if (error?.name === "NotAllowedError") {
      camera.reconnection.enabled = false;
      camera.reconnection.retry_in_seconds = null;
      camera.retryDeadline = null;
      camera.state = "error";
      camera.error = "Camera permission unavailable. Allow access, then Retry.";
      return;
    }
    scheduleReconnect(camera);
  }
  function scheduleReconnect(camera) {
    if (
      !cameras.has(camera.id) ||
      (away && !recording.has(camera.id)) ||
      camera.retryTimer !== null ||
      camera.state !== "reconnecting"
    )
      return;
    const delay =
      retryDelays[
        Math.min(camera.reconnection.attempt, retryDelays.length - 1)
      ];
    camera.reconnection.attempt++;
    camera.reconnection.retry_in_seconds = delay;
    camera.retryDeadline = performance.now() + delay * 1000;
    camera.retryTimer = setTimeout(async () => {
      camera.retryTimer = null;
      camera.retryDeadline = null;
      camera.reconnection.retry_in_seconds = 0;
      if (!cameras.has(camera.id) || (away && !recording.has(camera.id)))
        return;
      try {
        await start(camera, { reconnect: true });
      } catch (error) {
        reconnectFailure(camera, error);
      }
    }, delay * 1000);
  }
  async function cameraPermissionGranted(camera) {
    if (!navigator.permissions?.query) return false;
    try {
      return (
        (
          await navigator.permissions.query({
            name: "camera",
            ...(camera.ptz ? { panTiltZoom: true } : {}),
          })
        ).state === "granted"
      );
    } catch {
      return false;
    }
  }
  async function cameraEnded(camera, epoch) {
    if (camera.epoch !== epoch || camera.state !== "running") return;
    stop(camera, { preserveReconnect: true });
    camera.state = "reconnecting";
    const reconnectEpoch = camera.epoch;
    camera.error = null;
    camera.reconnection.enabled = true;
    camera.reconnection.retry_in_seconds = null;
    camera.reconnectStableSince = 0;
    const granted = await cameraPermissionGranted(camera);
    if (
      camera.epoch !== reconnectEpoch ||
      camera.state !== "reconnecting" ||
      !cameras.has(camera.id)
    )
      return;
    if (!granted) {
      camera.reconnection.enabled = false;
      camera.state = "error";
      camera.error = "Camera disconnected. Allow camera access, then Retry.";
      return;
    }
    if (!cameras.has(camera.id) || (away && !recording.has(camera.id))) return;
    scheduleReconnect(camera);
  }
  async function start(camera, { reconnect = false } = {}) {
    if (camera.state === "running" || camera.state === "starting") return;
    if (camera.openEpoch === camera.epoch) return;
    if (!reconnect) {
      clearTimeout(camera.retryTimer);
      camera.retryTimer = null;
      camera.retryDeadline = null;
      camera.reconnection.retry_in_seconds = null;
      camera.reconnection.attempt = 0;
      camera.reconnectStableSince = 0;
    }
    const epoch = ++camera.epoch;
    camera.openEpoch = epoch;
    camera.state = reconnect ? "reconnecting" : "starting";
    camera.error = null;
    let stream;
    try {
      if (camera.kind !== "demo") {
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.loop = camera.kind === "sample";
        if (camera.kind === "webcam") {
          if (!navigator.mediaDevices?.getUserMedia)
            throw new Error(
              "Webcams require HTTPS or localhost and a supported browser.",
            );
          if (reconnect) {
            const granted = await cameraPermissionGranted(camera);
            if (
              epoch !== camera.epoch ||
              camera.state !== "reconnecting" ||
              !cameras.has(camera.id) ||
              (away && !recording.has(camera.id))
            )
              return;
            if (!granted)
              throw new DOMException(
                "Camera permission unavailable.",
                "NotAllowedError",
              );
          }
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
            cameraEnded(camera, epoch);
          });
        } else if (camera.kind === "sample") {
          video.preload = "auto";
          video.src = "/" + camera.clip.filename;
          video.addEventListener("seeking", () => {
            camera.previous = null;
            camera.motion = 0;
            camera.blob = null;
          });
          video.addEventListener("error", () => {
            if (camera.epoch === epoch) {
              stop(camera);
              camera.state = "error";
              camera.error =
                "Demo clip could not load. Retry or choose another scene.";
            }
          });
        } else {
          camera.fileUrl = URL.createObjectURL(camera.file);
          video.src = camera.fileUrl;
        }
        camera.video = video;
        video.addEventListener("ended", () => {
          if (camera.epoch === epoch && camera.kind !== "sample") stop(camera);
        });
        await video.play();
        if (
          ["file", "sample"].includes(camera.kind) &&
          camera.resumeTime &&
          camera.resumeTime < video.duration
        )
          video.currentTime = camera.resumeTime;
      }
      if (epoch !== camera.epoch) return;
      camera.capture_session = crypto.randomUUID();
      camera.state = "running";
      await apply(camera);
      if (reconnect && camera.epoch === epoch) {
        camera.reconnection.recoveries++;
        camera.reconnection.enabled = true;
        camera.reconnection.retry_in_seconds = null;
        camera.retryDeadline = null;
        camera.reconnectStableSince = performance.now();
      }
    } catch (error) {
      stream?.getTracks().forEach((t) => t.stop());
      if (epoch !== camera.epoch) return;
      stop(camera, { preserveReconnect: reconnect });
      camera.state =
        reconnect && error.name !== "NotAllowedError"
          ? "reconnecting"
          : "error";
      camera.error =
        error.name === "NotAllowedError"
          ? "Camera permission denied. Allow this site in browser settings, then Retry."
          : error.name === "NotReadableError"
            ? "Camera busy or unavailable. Close other camera apps, then Retry."
            : error.message;
      if (reconnect) reconnectFailure(camera, error);
    } finally {
      if (camera.openEpoch === epoch) camera.openEpoch = null;
    }
  }
  async function add(data, fixedId = null) {
    const source = data.source;
    const clip = catalog?.find(source);
    if (typeof source === "string" && source.startsWith("demo://") && !clip)
      throw new Error("Unknown bundled demo camera scene.");
    const kind = clip
      ? "sample"
      : source instanceof File
        ? "file"
        : source === "demo"
          ? "demo"
          : "webcam";
    if (cameras.size >= 24)
      throw new Error(
        "Use up to 24 browser cameras; pause unused feeds to reduce load.",
      );
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
      id: fixedId || "cam-" + crypto.randomUUID(),
      name: data.name.trim(),
      kind,
      clip,
      wantsRunning: !!data.autostart,
      deviceId,
      file: kind === "file" ? source : null,
      source_label:
        kind === "sample"
          ? "Demo clip · " + clip.name
          : kind === "demo"
            ? "Generated demo · browser only"
            : kind === "file"
              ? "Local file · " + source.name
              : "Browser webcam",
      fps: data.fps,
      pipeline: data.pipeline,
      state: "stopped",
      settings: kind === "sample" ? { ...catalog.defaults } : {},
      profile_id: null,
      settings_state: "applied",
      results: {},
      frames: 0,
      epoch: 0,
      retryTimer: null,
      retryDeadline: null,
      openEpoch: null,
      reconnection: {
        enabled: kind === "webcam",
        attempt: 0,
        retry_in_seconds: null,
        recoveries: 0,
      },
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
    persistSamples();
    return status(camera);
  }
  async function frame(camera) {
    if (camera.state !== "running") throw new Error("No fresh frame.");
    const epoch = camera.epoch;
    if (camera.blob && performance.now() - camera.frameTime < 1000 / camera.fps)
      return camera.blob;
    if (camera.framePromise) return camera.framePromise;
    const pending = encodeFrame(camera, epoch).finally(() => {
      if (camera.framePromise === pending) camera.framePromise = null;
    });
    camera.framePromise = pending;
    return pending;
  }
  async function encodeFrame(camera, epoch) {
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
      if (
        camera.kind === "sample" &&
        camera.video.currentTime < (camera.sourceTime || 0)
      ) {
        camera.previous = null;
        camera.motion = 0;
      }
      camera.sourceTime = camera.video.currentTime;
      const w = camera.video.videoWidth,
        h = camera.video.videoHeight;
      if (w && h && canvas.height !== Math.round((640 * h) / w))
        canvas.height = Math.round((640 * h) / w);
      if (camera.kind === "sample") {
        const tune = catalog.tuning(desired(camera)),
          cw = w / tune.zoom,
          ch = h / tune.zoom;
        ctx.filter = tune.filter;
        ctx.drawImage(
          camera.video,
          (w - cw) * tune.pan,
          (h - ch) * tune.tilt,
          cw,
          ch,
          0,
          0,
          canvas.width,
          canvas.height,
        );
        ctx.filter = "none";
      } else ctx.drawImage(camera.video, 0, 0, canvas.width, canvas.height);
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
    for (const listener of listeners) {
      try {
        Promise.resolve(
          listener({
            camera: status(camera),
            canvas,
            motion_fraction: camera.motion || 0,
            frameId: camera.frames,
            timestamp: camera.frameTime,
          }),
        ).catch(() => {});
      } catch {
        /* One consumer cannot interrupt the camera. */
      }
    }
    if (
      camera.reconnectStableSince &&
      camera.frameTime - camera.reconnectStableSince >= 30000
    ) {
      camera.reconnection.attempt = 0;
      camera.reconnectStableSince = 0;
    }
    return blob;
  }
  async function request(path, data = {}) {
    if (
      [
        "/api/captures",
        "/api/recordings/start",
        "/api/recordings/stop",
        "/api/recordings/cameras",
        "/api/recordings/settings",
      ].includes(path) &&
      window.spyderBrowserMedia
    )
      return window.spyderBrowserMedia.request(path, data);
    const owned = await window.spyderDemoWorkflowRuntime?.request?.(path, data);
    if (owned !== undefined) return owned;
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
      if (parts[3] === "stop" && recording.has(camera.id))
        throw new Error("Remove this camera from recording before pausing it.");
      sleeping.delete(camera.id);
      camera.wantsRunning = false;
      stop(camera);
      if (parts[3] === "remove") {
        cameras.delete(camera.id);
        recording.delete(camera.id);
      }
      persistSamples();
      return status(camera);
    }
    const queuedEpoch = camera.epoch;
    const operation = async () => {
      if (!cameras.has(camera.id)) throw new Error("Camera removed.");
      if (camera.epoch !== queuedEpoch)
        throw new Error("Camera state changed. Retry this action.");
      if (parts[3] === "start") {
        camera.wantsRunning = true;
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
      persistSamples();
      return snapshot(camera);
    };
    const result = (camera.mutation || Promise.resolve()).then(operation);
    camera.mutation = result.catch(() => {});
    return result;
  }
  async function localFetch(path, options = {}) {
    if (options.signal?.aborted)
      throw new DOMException("Aborted", "AbortError");
    if (path === "/api/recordings" && window.spyderBrowserMedia)
      return Response.json(await window.spyderBrowserMedia.status());
    const owned = await window.spyderDemoWorkflowRuntime?.fetch?.(
      path,
      options,
    );
    if (owned !== undefined) return owned;
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
    if (kind === "sample") {
      deviceSelect.hidden = true;
      ptzLabel.hidden = true;
      return window.spyderDemoCameraPicker.configure();
    }
    window.spyderDemoCameraPicker?.hide();
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
    subscribeFrames(listener) {
      if (typeof listener !== "function")
        throw new Error("Frame listener must be a function");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    capabilities: {
      camera_tuning: "software",
      motion: "browser-frame-difference",
      face_enrollment: false,
      native_inference: false,
    },
    getFrameSource: async (id) => {
      const camera = get(id);
      if (camera.state !== "running") throw new Error("Camera is offline.");
      await frame(camera);
      return camera.canvas;
    },
    setRecording: async (id, active) => {
      const camera = get(id);
      if (typeof active !== "boolean")
        throw new Error("Recording state must be boolean");
      if (active) {
        recording.add(id);
        sleeping.delete(id);
        try {
          await start(camera);
          if (camera.state !== "running")
            throw new Error(
              camera.error || "Camera could not start for recording.",
            );
        } catch (error) {
          recording.delete(id);
          throw error;
        }
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
      sourceType.value === "sample"
        ? window.spyderDemoCameraPicker.source()
        : sourceType.value === "file"
          ? document.querySelector("#camera-source").files[0]
          : sourceType.value === "demo"
            ? "demo"
            : "device:" + deviceSelect.value,
  };
  document.querySelector(".rail-footer small").textContent =
    "No video uploads · no cloud processing";
  document.querySelector("#empty p").textContent =
    "Add a generated feed, your webcam, or a local video. For RTSP and native driver controls, install the local Python app.";
  document.querySelector("#remove-dialog .field-help").textContent =
    "This tab’s feed will stop and leave the wall. Saved browser profiles remain on this device.";
  window.addEventListener("pagehide", () => {
    clearTimeout(idleTimer);
    for (const c of cameras.values()) {
      if (["running", "starting", "reconnecting"].includes(c.state))
        sleeping.add(c.id);
      stop(c);
    }
  });
  let pump = null;
  function startPump() {
    if (catalog && pump === null)
      pump = setInterval(() => {
        for (const camera of cameras.values())
          if (camera.state === "running" && (!away || recording.has(camera.id)))
            frame(camera).catch(() => {});
      }, 100);
  }
  startPump();
  window.addEventListener("pagehide", () => {
    if (pump !== null) clearInterval(pump);
    pump = null;
  });
  window.addEventListener("pageshow", (event) => {
    startPump();
    if (event.persisted) {
      away = false;
      reconcileActivity().catch(() => {});
    }
  });
  if (catalog) {
    (async () => {
      let saved = null;
      try {
        const value = localStorage.getItem(sampleStorageKey);
        if (value !== null) {
          saved = JSON.parse(value);
          if (!Array.isArray(saved) || saved.length > 24)
            throw Error("Invalid sample list");
        }
      } catch {
        saved = null;
      }
      const seeds =
        saved ??
        catalog.cameras
          .slice(0, 2)
          .map((clip, i) => ({
            id: i ? "cam-demo-south" : "cam-demo-north",
            name: clip.name,
            source: "demo://" + clip.id,
            fps: 10,
            pipeline: "motion",
            autostart: true,
          }));
      for (const seed of seeds) {
        try {
          if (!catalog.find(seed.source) || !/^cam-[\w-]{1,80}$/.test(seed.id))
            continue;
          const safeSettings = validate(seed.settings || {});
          await add({ ...seed, autostart: false }, seed.id);
          const camera = get(seed.id);
          camera.settings = { ...catalog.defaults, ...safeSettings };
          camera.profile_id = profiles.some((p) => p.id === seed.profile_id)
            ? seed.profile_id
            : null;
          camera.wantsRunning = seed.autostart === true;
          if (camera.wantsRunning) await start(camera);
        } catch {
          /* Skip corrupt saved sample entries without touching other data. */
        }
      }
      restoring = false;
      persistSamples();
    })();
  } else {
    add(
      {
        name: "Demo / North",
        source: "demo",
        fps: 10,
        pipeline: "motion",
        autostart: true,
      },
      "cam-demo-north",
    );
    add(
      {
        name: "Demo / South",
        source: "demo",
        fps: 10,
        pipeline: "motion",
        autostart: true,
      },
      "cam-demo-south",
    );
    restoring = false;
  }
})();
