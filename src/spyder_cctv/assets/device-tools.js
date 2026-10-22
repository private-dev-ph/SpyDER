"use strict";
(() => {
  "use strict";
  const esc = (x) =>
    String(x ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const demo = () => !!window.spyderShowcase;
  async function api(path, body) {
    const r = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "X-Spyder-Control": "1" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const d = r.headers.get("Content-Type")?.includes("json")
      ? await r.json()
      : {};
    if (!r.ok) throw Error(d.error || "Request failed (" + r.status + ").");
    return d;
  }
  const say = (h, m, bad) => {
    let e = h.querySelector(".dt-status");
    e.textContent = m;
    e.dataset.error = String(!!bad);
  };
  function watch() {
    const scan = () => {
      for (const [id, k] of [
        ["face-gallery-tools", "face"],
        ["onvif-camera-tools", "onvif"],
      ]) {
        const h = document.getElementById(id);
        if (h && !h.dataset.dtMounted) {
          h.dataset.dtMounted = "1";
          k === "face" ? face(h) : onvif(h);
        }
      }
    };
    scan();
    new MutationObserver(scan).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
  function face(h) {
    let blocked = demo(),
      list = [],
      gid = "",
      desc = null,
      q = "";
    h.classList.add("dt-host");
    h.innerHTML =
      '<section class="dt-card"><header class="dt-head"><div><p class="dt-eyebrow">LOCAL IDENTITY GALLERY</p><h2>Face enrollment</h2><p>Gallery matches stay separate from closed-set classifiers.</p></div><button class="dt-button dt-primary" data-create>Create gallery</button></header>' +
      (blocked
        ? '<p class="dt-notice">Native enrollment unavailable in showcase. No network calls run.</p>'
        : "") +
      '<p class="dt-privacy">Images process locally and are not retained. Only face samples are stored in gallery.</p><div class="dt-tools"><label>Search<input type="search" data-search></label><button class="dt-button" data-refresh>Refresh</button></div><p class="dt-status" role="status" aria-live="polite"></p><div data-list class="dt-gallery-list"></div><div data-detail></div></section>';
    if (blocked)
      h.querySelectorAll("button").forEach((b) => (b.disabled = true));
    async function refresh() {
      if (blocked) return;
      try {
        const d = await api("/api/faces/galleries");
        list = d.galleries || [];
        paint();
        if (d.error) say(h, d.error, true);
      } catch (e) {
        say(h, e.message, true);
      }
    }
    async function load() {
      desc = gid
        ? await api("/api/faces/galleries/" + encodeURIComponent(gid))
        : null;
      paint();
    }
    function paint() {
      h.querySelector("[data-list]").innerHTML =
        list
          .filter((g) => (g.name + " " + g.id).toLowerCase().includes(q))
          .map(
            (g) =>
              '<button class="dt-gallery ' +
              (gid === g.id ? "is-selected" : "") +
              '" data-gid="' +
              esc(g.id) +
              '" aria-pressed="' +
              (gid === g.id) +
              '"><b>' +
              esc(g.name) +
              "</b><span>" +
              (g.identity_count || 0) +
              " identities · " +
              (g.sample_count || 0) +
              " samples</span></button>",
          )
          .join("") ||
        '<p class="dt-empty">No galleries. Create one to begin.</p>';
      const p = h.querySelector("[data-detail]");
      if (!desc || desc.id !== gid) {
        p.replaceChildren();
        return;
      }
      p.innerHTML =
        '<header class="dt-detail-head"><h3>' +
        esc(desc.name) +
        '</h3><div class="dt-actions"><button class="dt-button" data-rg>Rename</button><button class="dt-button dt-danger" data-xg>Remove gallery</button><button class="dt-button" data-export>Export</button></div></header><form class="dt-enroll" data-enroll><h4>Enroll face</h4><label>Identity name<input name="identity_name" required maxlength="128"></label><label>Camera frame<select name="camera_id"><option value="">Choose camera</option>' +
        (window.spyder?.cameras?.() || [])
          .map(
            (c) =>
              '<option value="' +
              esc(c.id) +
              '">' +
              esc(c.name || c.id) +
              "</option>",
          )
          .join("") +
        '</select></label><label>Or upload image<input name="image" type="file" accept="image/*"></label><button class="dt-button dt-primary">Process enrollment</button><p>Image used for this request only.</p><div data-choice></div></form><section class="dt-identities"><h4>Identities</h4>' +
        ((desc.identities || [])
          .filter((i) => (i.name + " " + i.id).toLowerCase().includes(q))
          .map(
            (i) =>
              '<article class="dt-identity"><div><b>' +
              esc(i.name) +
              "</b><span>" +
              (i.samples || []).length +
              ' samples</span></div><div class="dt-actions"><button class="dt-button" data-ri="' +
              esc(i.id) +
              '">Rename</button><button class="dt-button dt-danger" data-xi="' +
              esc(i.id) +
              '">Remove</button></div>' +
              (i.samples || [])
                .map(
                  (s) =>
                    '<div class="dt-sample">Sample ' +
                    esc(s.id) +
                    ' <button class="dt-button dt-danger" data-xi="' +
                    esc(i.id) +
                    '" data-xs="' +
                    esc(s.id) +
                    '">Remove sample</button></div>',
                )
                .join("") +
              "</article>",
          )
          .join("") || '<p class="dt-empty">No identities found.</p>') +
        "</section>";
    }
    h.addEventListener("input", (e) => {
      if (e.target.matches("[data-search]")) {
        q = e.target.value.trim().toLowerCase();
        paint();
      }
    });
    h.addEventListener("click", async (e) => {
      let b = e.target.closest("button");
      if (!b || blocked) return;
      try {
        if (b.hasAttribute("data-refresh")) return refresh();
        if (b.dataset.gid) {
          gid = b.dataset.gid;
          return await load();
        }
        if (b.hasAttribute("data-create")) {
          if (h._creatingGallery || document.querySelector(".dt-dialog"))
            return;
          h._creatingGallery = true;
          b.disabled = true;
          const ms = (await api("/api/models")).models || [];
          const role = (m) =>
            String(m.metadata?.model_type || m.model_type || "")
              .toLowerCase()
              .replace(/[^a-z]/g, "");
          const classifiers = new Set([
            "faceclassifier",
            "faceidentityclassifier",
            "classifier",
            "classification",
          ]);
          const detectors = ms.filter(
            (m) =>
              m.engine === "insightface" &&
              !classifiers.has(role(m)) &&
              !["facerecognition", "recognition", "arcface"].includes(role(m)),
          );
          const recognizers = ms.filter(
            (m) =>
              m.engine === "insightface" &&
              !classifiers.has(role(m)) &&
              !["facedetection", "detection", "scrfd", "retinaface"].includes(
                role(m),
              ),
          );
          try {
            const catalog = await api("/api/vision/detectors");
            for (const item of catalog.detectors || []) {
              const id = {
                "scrfd-500mf": "builtin-scrfd-500mf",
                "scrfd-2.5gf": "builtin-scrfd-2-5gf",
                "scrfd-10gf": "builtin-scrfd-10gf",
              }[item.id];
              if (id && item.available)
                detectors.unshift({ id, name: item.name || item.id });
            }
          } catch {
            /* Registered detectors remain available without the built-in catalog. */
          }
          let d = document.createElement("dialog");
          d.className = "dt-dialog";
          d.innerHTML =
            '<form method="dialog"><h3>Create gallery</h3><label>Name<input name="name" required maxlength="128"></label>' +
            ["detector_model_id", "recognition_model_id"]
              .map(
                (k, i) =>
                  "<label>" +
                  (i ? "Face recognizer" : "Face detector") +
                  '<select name="' +
                  k +
                  '" required><option value="">Choose model</option>' +
                  (i ? recognizers : detectors)
                    .map(
                      (m) =>
                        '<option value="' +
                        esc(m.id) +
                        '">' +
                        esc(m.name || m.id) +
                        "</option>",
                    )
                    .join("") +
                  "</select></label>",
              )
              .join("") +
            '<p>Workflow use: connect gallery Classifier to InsightFace Detections CLASSIFIER IN.</p><button value="cancel">Cancel</button><button value="create">Create</button></form>';
          document.body.append(d);
          d.showModal();
          d.addEventListener(
            "close",
            async () => {
              try {
                if (d.returnValue === "create") {
                  let r = await api(
                    "/api/faces/galleries",
                    Object.fromEntries(new FormData(d.querySelector("form"))),
                  );
                  gid = r.id;
                  await refresh();
                  await load();
                  window.dispatchEvent(
                    new CustomEvent("spyder:face-galleries-changed"),
                  );
                }
              } catch (x) {
                say(h, x.message, true);
              }
              d.remove();
              h._creatingGallery = false;
              b.disabled = false;
            },
            { once: true },
          );
          return;
        }
        let id = b.dataset.xi;
        if (b.hasAttribute("data-rg")) {
          let name = prompt("Gallery name", desc.name)?.trim();
          if (name) {
            await api(
              "/api/faces/galleries/" + encodeURIComponent(gid) + "/rename",
              { name },
            );
            await load();
            await refresh();
            window.dispatchEvent(
              new CustomEvent("spyder:face-galleries-changed"),
            );
          }
          return;
        }
        if (b.hasAttribute("data-xg")) {
          if (confirm("Remove gallery and samples?")) {
            await api(
              "/api/faces/galleries/" + encodeURIComponent(gid) + "/remove",
              {},
            );
            gid = "";
            desc = null;
            await refresh();
            window.dispatchEvent(
              new CustomEvent("spyder:face-galleries-changed"),
            );
          }
          return;
        }
        if (b.hasAttribute("data-export")) {
          let x = await api(
              "/api/faces/galleries/" + encodeURIComponent(gid) + "/export",
            ),
            u = URL.createObjectURL(
              new Blob([JSON.stringify(x, null, 2)], {
                type: "application/json",
              }),
            ),
            a = document.createElement("a");
          a.href = u;
          a.download = "face-gallery.json";
          a.click();
          URL.revokeObjectURL(u);
          return;
        }
        if (b.dataset.ri) {
          let old = desc.identities.find((x) => x.id === b.dataset.ri),
            name = prompt("Identity name", old.name)?.trim();
          if (name)
            await api(
              "/api/faces/galleries/" +
                encodeURIComponent(gid) +
                "/identities/" +
                encodeURIComponent(old.id) +
                "/rename",
              { name },
            );
          await load();
          window.dispatchEvent(
            new CustomEvent("spyder:face-galleries-changed"),
          );
          return;
        }
        if (id && !b.dataset.xs && b.hasAttribute("data-xi")) {
          if (confirm("Remove identity and samples?"))
            await api(
              "/api/faces/galleries/" +
                encodeURIComponent(gid) +
                "/identities/" +
                encodeURIComponent(id) +
                "/remove",
              {},
            );
          await load();
          window.dispatchEvent(
            new CustomEvent("spyder:face-galleries-changed"),
          );
          return;
        }
        if (id && b.dataset.xs) {
          if (confirm("Remove sample?"))
            await api(
              "/api/faces/galleries/" +
                encodeURIComponent(gid) +
                "/identities/" +
                encodeURIComponent(id) +
                "/samples/" +
                encodeURIComponent(b.dataset.xs) +
                "/remove",
              {},
            );
          await load();
          window.dispatchEvent(
            new CustomEvent("spyder:face-galleries-changed"),
          );
        }
      } catch (x) {
        h._creatingGallery = false;
        const create = h.querySelector("[data-create]");
        if (create) create.disabled = blocked;
        say(h, x.message, true);
      }
    });
    h.addEventListener("submit", async (e) => {
      if (!e.target.matches("[data-enroll]") || blocked) return;
      e.preventDefault();
      let f = e.target,
        b = { identity_name: f.elements.identity_name.value.trim() };
      try {
        let file = f.elements.image.files[0];
        if (file) {
          if (file.size > 8 * 1024 * 1024)
            throw Error("Choose an image smaller than 8 MiB.");
          let u = await new Promise((ok, no) => {
            let r = new FileReader();
            r.onload = () => ok(r.result);
            r.onerror = no;
            r.readAsDataURL(file);
          });
          b.image_base64 = String(u).split(",")[1];
        } else if (f.elements.camera_id.value) {
          b.camera_id = f.elements.camera_id.value;
        } else throw Error("Choose camera frame or image.");
        let d = await api(
          "/api/faces/galleries/" + encodeURIComponent(gid) + "/enroll",
          b,
        );
        if (d.requires_selection) {
          f.querySelector("[data-choice]").innerHTML =
            (d.preview?.startsWith("data:image/jpeg;base64,")
              ? '<img class="dt-face-selection" alt="Captured faces with numbered selection boxes" src="' +
                esc(d.preview) +
                '">'
              : "") +
            "<label>Select face<select data-face-index>" +
            d.faces
              .map(
                (x) =>
                  '<option value="' +
                  esc(x.index) +
                  '">Face ' +
                  (Number(x.index) + 1) +
                  (x.bbox
                    ? " · " +
                      x.bbox.map((v) => Math.round(Number(v))).join(", ")
                    : "") +
                  (Number.isFinite(x.confidence)
                    ? " · " + Math.round(x.confidence * 100) + "%"
                    : "") +
                  "</option>",
              )
              .join("") +
            '</select></label><button type="button" data-confirm-face>Enroll selected face</button>';
          h._pending = {
            identity_name: b.identity_name,
            enrollment_token: d.enrollment_token,
          };
          say(h, "Select one detected face.");
          return;
        }
        f.reset();
        await load();
        await refresh();
        say(h, "Face enrolled. Image not retained.");
        window.dispatchEvent(new CustomEvent("spyder:face-galleries-changed"));
      } catch (x) {
        say(h, x.message, true);
      }
    });
    h.addEventListener("click", async (e) => {
      if (!e.target.closest("[data-confirm-face]") || blocked) return;
      try {
        let b = h._pending;
        b.face_index = Number(h.querySelector("[data-face-index]").value);
        await api(
          "/api/faces/galleries/" + encodeURIComponent(gid) + "/enroll",
          b,
        );
        delete h._pending;
        await load();
        await refresh();
        say(h, "Face enrolled. Image not retained.");
        window.dispatchEvent(new CustomEvent("spyder:face-galleries-changed"));
      } catch (x) {
        say(h, x.message, true);
      }
    });
  }
  function onvif(h) {
    let blocked = demo(),
      session = "",
      profile = "",
      conn = null;
    h.classList.add("dt-host");
    h.innerHTML =
      '<section class="dt-card"><header class="dt-head"><div><p class="dt-eyebrow">CAMERA DISCOVERY</p><h2>ONVIF discovery and PTZ</h2><p>Credentials stay in local server memory. Discovery starts only on click.</p></div></header>' +
      (blocked
        ? '<p class="dt-notice">Installed local app required. Showcase makes no network calls.</p>'
        : "") +
      '<div class="dt-onvif-form"><label>Device endpoint<input type="url" data-endpoint placeholder="http://192.168.1.20/onvif/device_service"></label><label>Username<input data-user autocomplete="username"></label><label>Password<input type="password" data-pass autocomplete="current-password"></label><button class="dt-button" data-refresh-sessions>Refresh connections</button><button class="dt-button" data-discover>Discover devices</button><button class="dt-button dt-primary" data-connect>Connect</button></div><label>Active connection<select data-sessions><option value="">No saved sessions loaded</option></select></label><label>Discovered devices<select data-devices><option value="">Choose device</option></select></label><p class="dt-status" role="status" aria-live="polite"></p><div data-connected></div></section>';
    if (blocked)
      h.querySelectorAll("button").forEach((b) => (b.disabled = true));
    function paint() {
      let p = h.querySelector("[data-connected]");
      if (!conn) {
        p.replaceChildren();
        return;
      }
      let cap = { ...(conn.ptz || {}) },
        active = (conn.profiles || []).find((x) => x.token === profile);
      if (active?.ptz === false || active?.ptz_caps === false) cap = {};
      else if (active?.ptz_caps && typeof active.ptz_caps === "object")
        cap = { ...cap, ...active.ptz_caps };
      else if (active?.ptz && typeof active.ptz === "object")
        cap = { ...cap, ...active.ptz };
      p.innerHTML =
        '<div class="dt-connected"><header class="dt-detail-head"><h3>' +
        esc(conn.device?.name || conn.device?.endpoint || "Connected camera") +
        '</h3><button class="dt-button dt-danger" data-disconnect>Disconnect</button></header><label>Media profile<select data-profile>' +
        (conn.profiles || [])
          .map(
            (x) =>
              '<option value="' +
              esc(x.token) +
              '" ' +
              (profile === x.token ? "selected" : "") +
              ">" +
              esc(x.name || x.token) +
              "</option>",
          )
          .join("") +
        '</select></label><label>Camera name<input data-name maxlength="80"></label><button class="dt-button dt-primary" data-add ' +
        (!profile ? "disabled" : "") +
        ' >Add to Camera Setup</button><div class="dt-ptz"><button data-move="0,1,0" ' +
        (!cap.pan_tilt ? "disabled" : "") +
        ' aria-label="Tilt up"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3 4 13h5v8h6v-8h5z"/></svg></button><button data-move="-1,0,0" ' +
        (!cap.pan_tilt ? "disabled" : "") +
        ' aria-label="Pan left"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 12 13 4v5h8v6h-8v5z"/></svg></button><button data-stop aria-label="Stop" ' +
        (!cap.pan_tilt && !cap.zoom ? "disabled" : "") +
        ' ><svg aria-hidden="true" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2"/></svg></button><button data-move="1,0,0" ' +
        (!cap.pan_tilt ? "disabled" : "") +
        ' aria-label="Pan right"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m21 12-10 8V5z"/></svg></button><button data-move="0,-1,0" ' +
        (!cap.pan_tilt ? "disabled" : "") +
        ' aria-label="Tilt down"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m12 21-8-10h5V3h6v8h5z"/></svg></button><button data-move="0,0,1" ' +
        (!cap.zoom ? "disabled" : "") +
        ' aria-label="Zoom in"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z"/></svg></button><button data-move="0,0,-1" ' +
        (!cap.zoom ? "disabled" : "") +
        ' aria-label="Zoom out"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 11h16v2H4z"/></svg></button></div><p>Each direction sends a short 250 ms pulse. Unsupported controls remain disabled.</p></div>';
    }
    h.addEventListener("change", (e) => {
      if (e.target.matches("[data-devices]"))
        h.querySelector("[data-endpoint]").value = e.target.value;
      if (e.target.matches("[data-profile]")) {
        profile = e.target.value;
        paint();
      }
      if (e.target.matches("[data-sessions]")) {
        const active = (h._sessions || []).find(
          (x) => x.session_id === e.target.value,
        );
        if (active) {
          conn = active;
          session = active.session_id;
          profile = active.profiles?.[0]?.token || "";
          paint();
          say(h, "Active ONVIF session restored without credentials.");
        }
      }
    });
    h.addEventListener("click", async (e) => {
      let b = e.target.closest("button");
      if (!b || blocked) return;
      try {
        if (b.hasAttribute("data-refresh-sessions")) {
          const d = await api("/api/onvif/sessions");
          h._sessions = d.sessions || [];
          h.querySelector("[data-sessions]").innerHTML =
            '<option value="">Choose active connection</option>' +
            h._sessions
              .map(
                (x) =>
                  '<option value="' +
                  esc(x.session_id) +
                  '">' +
                  esc(x.device?.name || x.device?.endpoint || x.session_id) +
                  "</option>",
              )
              .join("");
          say(h, h._sessions.length + " active connection(s).");
          return;
        }
        if (b.hasAttribute("data-discover")) {
          let d = await api("/api/onvif/discover", {});
          h.querySelector("[data-devices]").innerHTML =
            '<option value="">Choose device</option>' +
            d.devices
              .map(
                (x) =>
                  '<option value="' +
                  esc(x.endpoint) +
                  '">' +
                  esc(x.name || x.endpoint) +
                  "</option>",
              )
              .join("");
          say(h, d.devices.length + " ONVIF devices found.");
          return;
        }
        if (b.hasAttribute("data-connect")) {
          let endpoint = h.querySelector("[data-endpoint]").value.trim();
          if (!endpoint) throw Error("Enter endpoint.");
          conn = await api("/api/onvif/connect", {
            endpoint,
            username: h.querySelector("[data-user]").value,
            password: h.querySelector("[data-pass]").value,
          });
          session = conn.session_id;
          profile = conn.profiles?.[0]?.token || "";
          h.querySelector("[data-pass]").value = "";
          paint();
          say(h, "Connected. Credentials cleared from form.");
          return;
        }
        if (b.dataset.move) {
          let v = b.dataset.move.split(",").map(Number);
          await api("/api/onvif/move", {
            session_id: session,
            profile_token: profile,
            pan: v[0],
            tilt: v[1],
            zoom: v[2],
            duration_ms: 250,
          });
          say(h, "PTZ pulse sent.");
          return;
        }
        if (b.hasAttribute("data-stop")) {
          await api("/api/onvif/stop", { session_id: session });
          say(h, "PTZ stopped.");
          return;
        }
        if (b.hasAttribute("data-add")) {
          let d = await api("/api/onvif/add", {
            session_id: session,
            profile_token: profile,
            name: h.querySelector("[data-name]").value.trim() || undefined,
          });
          say(h, d.message || "Camera added.");
          return;
        }
        if (b.hasAttribute("data-disconnect")) {
          await api("/api/onvif/disconnect", { session_id: session });
          session = "";
          conn = null;
          paint();
          say(h, "Disconnected.");
        }
      } catch (x) {
        say(h, x.message, true);
      }
    });
    // Keep active ONVIF session available when navigating between panels.
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", watch, { once: true });
  else watch();
})();
