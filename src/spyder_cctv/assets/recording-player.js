/* One local player shared by timeline playback and compatibility decoding. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.spyderRecordingPlayer = api;
})(typeof window === "undefined" ? globalThis : window, function () {
  "use strict";
  function playableUrl(item) {
    const value = String(item?.url || "");
    return /^\/api\/media\/[0-9a-f]{32}$/.test(value) || /^blob:/.test(value)
      ? value
      : null;
  }
  function position(value, duration) {
    const length = Number(duration);
    return Number.isFinite(length) && length > 0
      ? Math.max(
          0,
          Math.min(
            Math.max(0, length - 0.001),
            Number.isFinite(Number(value)) ? Number(value) : 0,
          ),
        )
      : 0;
  }
  function create(container, options = {}) {
    let disposed = false,
      generation = 0,
      cleanup = () => {},
      current = null,
      video = null;
    let seconds = 0,
      duration = 0,
      rate = 1,
      playing = false,
      fallback = false;
    let timer,
      request,
      objectUrl,
      image,
      anchorTime = 0,
      anchorClock = 0,
      frameSerial = 0,
      loopSerial = 0,
      wantsPlay = false;
    const demo = options.demo ?? !!window.spyderShowcase;
    const player = document.createElement("div");
    player.className = "recording-player";
    const surface = document.createElement("div");
    surface.className = "recording-player-surface";
    const status = document.createElement("p");
    status.className = "field-help recording-player-status";
    status.setAttribute("role", "status");
    player.append(surface, status);
    container.append(player);
    const notifyTime = () => options.onTime?.(seconds);
    function state(value) {
      if (playing !== value) {
        playing = value;
        options.onState?.(playing);
      }
    }
    function fail(message) {
      pause();
      status.textContent = message;
      options.onError?.(message);
    }
    function cancelFrame() {
      clearTimeout(timer);
      request?.abort();
      request = null;
      frameSerial++;
      loopSerial++;
    }
    function releaseImage() {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      }
    }
    function pause() {
      wantsPlay = false;
      if (fallback && playing)
        seconds = position(
          anchorTime + ((performance.now() - anchorClock) / 1000) * rate,
          duration,
        );
      state(false);
      cancelFrame();
      video?.pause();
    }
    function frameTime() {
      return position(
        anchorTime + ((performance.now() - anchorClock) / 1000) * rate,
        duration,
      );
    }
    async function frame(token) {
      if (disposed || token !== generation || !current) return;
      request?.abort();
      request = new AbortController();
      const active = request,
        serial = ++frameSerial;
      const timeout = setTimeout(() => active.abort(), 10000);
      try {
        const offset = position(seconds, duration);
        const response = await fetch(
          `/api/media/${encodeURIComponent(current.id)}/frame?time=${offset.toFixed(3)}`,
          { signal: active.signal, cache: "no-store" },
        );
        if (!response.ok)
          throw Error(
            response.status === 404
              ? "Recording was removed or its drive is unavailable."
              : "Recording frame could not be decoded.",
          );
        const blob = await response.blob();
        if (
          disposed ||
          token !== generation ||
          active.signal.aborted ||
          serial !== frameSerial
        )
          return;
        const next = URL.createObjectURL(blob);
        image.src = next;
        releaseImage();
        objectUrl = next;
        notifyTime();
      } catch (error) {
        if (!disposed && token === generation && serial === frameSerial) {
          if (error.name !== "AbortError" || !active.signal.aborted)
            fail(error.message);
          else if (request === active && playing)
            fail(
              "Local playback timed out. Try seeking again or download the original.",
            );
        }
      } finally {
        clearTimeout(timeout);
        if (request === active) request = null;
      }
    }
    async function tick(token, loop = loopSerial) {
      if (
        disposed ||
        token !== generation ||
        loop !== loopSerial ||
        !playing ||
        document.hidden
      )
        return;
      seconds = frameTime();
      await frame(token);
      if (disposed || token !== generation || loop !== loopSerial || !playing)
        return;
      if (
        anchorTime + ((performance.now() - anchorClock) / 1000) * rate >=
        duration
      ) {
        seconds = duration;
        state(false);
        notifyTime();
        options.onEnded?.();
        return;
      }
      timer = setTimeout(() => tick(token, loop), 200);
    }
    function compatibility(token) {
      if (disposed || token !== generation || fallback) return;
      if (
        demo ||
        !/^\/api\/media\/[0-9a-f]{32}$/.test(playableUrl(current) || "")
      ) {
        fail(
          "This browser cannot play this recording. Download it to use another player.",
        );
        return;
      }
      const resume = wantsPlay;
      seconds = position(video.currentTime || seconds, duration);
      cleanup();
      cleanup = () => {};
      video.pause();
      video.removeAttribute("src");
      video.load();
      video.hidden = true;
      fallback = true;
      state(false);
      image = document.createElement("img");
      image.alt = "Recorded video frame";
      surface.append(image);
      status.textContent =
        "Compatibility playback · local decoded frames, up to 5 frames/s. The original retains its full frame rate. No audio.";
      if (resume) play();
      else void frame(token);
    }
    function load(
      item,
      { offset = 0, autoplay = false, rate: nextRate = 1 } = {},
    ) {
      if (disposed) return Promise.resolve();
      pause();
      generation++;
      const token = generation;
      cleanup();
      cleanup = () => {};
      releaseImage();
      surface.replaceChildren();
      current = item;
      duration = Number(item?.duration_seconds);
      seconds = position(offset, duration);
      rate = [0.5, 1, 2, 4].includes(Number(nextRate)) ? Number(nextRate) : 1;
      fallback = false;
      wantsPlay = autoplay;
      const url = playableUrl(item);
      if (!url || !Number.isFinite(duration) || duration <= 0) {
        fail("This recording has no playable duration or local media URL.");
        return Promise.resolve();
      }
      status.textContent = "";
      video = document.createElement("video");
      video.controls = true;
      video.preload = "metadata";
      video.playsInline = true;
      video.setAttribute(
        "aria-label",
        item.name || item.filename || "Recorded footage",
      );
      surface.append(video);
      const listeners = [];
      const listen = (name, fn) => {
        const guarded = () => {
          if (!disposed && generation === token) fn();
        };
        video.addEventListener(name, guarded);
        listeners.push([name, guarded]);
      };
      let ready = false;
      const metadataTimeout = setTimeout(() => compatibility(token), 12000);
      listen("loadedmetadata", () => {
        ready = true;
        clearTimeout(metadataTimeout);
        if (Number.isFinite(video.duration) && video.duration > 0)
          duration = Math.min(duration, video.duration);
        seconds = position(seconds, duration);
        video.currentTime = seconds;
        video.playbackRate = rate;
        notifyTime();
        if (autoplay) play();
      });
      listen("timeupdate", () => {
        if (ready) {
          seconds = Math.max(0, Math.min(duration, video.currentTime || 0));
          notifyTime();
        }
      });
      listen("play", () => state(true));
      listen("pause", () => state(false));
      listen("ended", () => {
        seconds = duration;
        state(false);
        notifyTime();
        options.onEnded?.();
      });
      listen("error", () => compatibility(token));
      const boundVideo = video;
      cleanup = () => {
        clearTimeout(metadataTimeout);
        for (const [name, fn] of listeners)
          boundVideo.removeEventListener(name, fn);
      };
      video.src = url;
      video.load();
      notifyTime();
      return Promise.resolve();
    }
    function seek(value) {
      if (!current || disposed) return;
      cancelFrame();
      seconds = position(value, duration);
      if (fallback) {
        anchorTime = seconds;
        anchorClock = performance.now();
        if (playing) void tick(generation);
        else void frame(generation);
      } else if (video?.readyState >= 1) video.currentTime = seconds;
      notifyTime();
    }
    function play() {
      if (disposed || !current) return;
      wantsPlay = true;
      if (fallback) {
        if (playing) return;
        if (seconds >= duration - 0.001) seconds = 0;
        anchorTime = seconds;
        anchorClock = performance.now();
        state(true);
        void tick(generation);
      } else if (video) {
        const token = generation;
        video.playbackRate = rate;
        const result = video.play();
        result?.catch((error) => {
          if (!disposed && generation === token) {
            if (error.name === "NotAllowedError")
              fail("Press Play to allow playback in this browser.");
            else if (error.name !== "AbortError") compatibility(token);
          }
        });
      }
    }
    function setRate(value) {
      const next = Number(value);
      if (![0.5, 1, 2, 4].includes(next)) return;
      if (fallback && playing) {
        seconds = frameTime();
        anchorTime = seconds;
        anchorClock = performance.now();
      }
      rate = next;
      if (video) video.playbackRate = rate;
    }
    const visibility = () => {
      if (document.hidden) pause();
    };
    document.addEventListener("visibilitychange", visibility);
    return {
      load,
      seek,
      play,
      pause,
      setRate,
      destroy() {
        if (disposed) return;
        pause();
        disposed = true;
        generation++;
        cleanup();
        if (video) {
          video.removeAttribute("src");
          video.load();
        }
        releaseImage();
        document.removeEventListener("visibilitychange", visibility);
        player.remove();
      },
    };
  }
  return { create, playableUrl, position };
});
