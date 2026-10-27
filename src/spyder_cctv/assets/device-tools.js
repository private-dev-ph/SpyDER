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
  let dialogSequence = 0;
  const closeIcon =
    '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>';
  function showDialog(dialog, opener) {
    dialog._opener = opener;
    const heading = dialog.querySelector("h3");
    heading.id = "dt-dialog-title-" + ++dialogSequence;
    dialog.setAttribute("aria-labelledby", heading.id);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "dt-icon-button dt-dialog-close";
    close.setAttribute(
      "aria-label",
      "Close " + heading.textContent.toLowerCase(),
    );
    close.innerHTML = closeIcon;
    close.addEventListener("click", () => dialog.close("cancel"));
    dialog.append(close);
    dialog
      .querySelector('[value="cancel"]')
      .addEventListener("click", () => dialog.close("cancel"));
    dialog.addEventListener(
      "close",
      () => {
        if (opener?.isConnected) opener.focus();
      },
      { once: true },
    );
    dialog.showModal();
  }
  function requestDialog({
    title,
    message,
    initial,
    submit,
    destructive,
    opener,
  }) {
    return new Promise((resolve) => {
      const dialog = document.createElement("dialog");
      dialog.className = "dt-dialog";
      dialog.innerHTML =
        '<form method="dialog"><h3>' +
        esc(title) +
        "</h3><p>" +
        esc(message) +
        "</p>" +
        (initial !== undefined
          ? '<label>Name<input name="name" required maxlength="128" value="' +
            esc(initial) +
            '" autofocus></label>'
          : "") +
        '<footer class="dt-dialog-actions"><button class="dt-button" type="button" value="cancel" formnovalidate>Cancel</button><button class="dt-button ' +
        (destructive ? "dt-destructive" : "dt-primary") +
        '" value="confirm">' +
        esc(submit) +
        "</button></footer></form>";
      document.body.append(dialog);
      dialog.addEventListener(
        "close",
        () => {
          const accepted = dialog.returnValue === "confirm";
          const result = accepted
            ? initial === undefined
              ? true
              : dialog.querySelector('[name="name"]').value.trim()
            : null;
          dialog.remove();
          resolve(result);
        },
        { once: true },
      );
      showDialog(dialog, opener);
      if (initial !== undefined) dialog.querySelector('[name="name"]').select();
    });
  }
  function watch() {
    const scan = () => {
      document.querySelectorAll(".dt-dialog[open]").forEach((dialog) => {
        if (dialog._opener && !dialog._opener.isConnected)
          dialog.close("cancel");
      });
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
      q = "",
      identityQuery = "",
      detailLoading = false,
      galleryLoading = !blocked,
      selectionVersion = 0,
      detailVersion = 0,
      galleryGeneration = 0;
    const openSamples = new Set();
    h.classList.add("dt-host");
    h.innerHTML =
      '<section class="dt-card dt-gallery-workspace"><header class="dt-head"><div><h1>Face galleries</h1><p>Create a collection, enroll people, and review their samples.</p></div><button class="dt-button dt-primary" data-create>Create gallery</button></header>' +
      (blocked
        ? '<p class="dt-notice">Native enrollment unavailable in showcase. No network calls run.</p>'
        : "") +
      '<p class="dt-local-note">Face data stays on this computer.</p><p class="dt-status" role="status" aria-live="polite"></p><details class="dt-gallery-browser" open><summary><span>Choose gallery</span><span data-current-gallery>None selected</span><small data-gallery-count></small></summary><div class="dt-gallery-browser-body"><div class="dt-tools"><label>Search galleries<input type="search" data-search placeholder="Gallery name or ID"></label><button class="dt-button" data-refresh>Refresh</button></div><div data-list class="dt-gallery-list"></div></div></details><div data-detail class="dt-detail"></div><details class="dt-gallery-help"><summary>Storage &amp; workflow help</summary><p>Enrollment stays on this computer. Galleries store face vectors and small portrait crops, never full source photos or videos. Gallery matches stay separate from closed-set classifiers.</p><p>Use a gallery through a Classifier node connected to InsightFace Detections. Gallery exports contain identity names and face vectors; they are recognition data, not a full sample backup.</p></details></section>';
    if (blocked)
      h.querySelectorAll("button").forEach((b) => (b.disabled = true));
    async function refresh() {
      if (blocked) return;
      galleryLoading = true;
      const version = ++selectionVersion;
      try {
        const d = await api("/api/faces/galleries");
        if (version !== selectionVersion) return;
        list = d.galleries || [];
        galleryLoading = false;
        if (gid && !list.some((g) => g.id === gid)) {
          gid = "";
          galleryGeneration++;
          desc = null;
          detailLoading = false;
          detailVersion++;
          delete h._pending;
        }
        paint();
        say(h, "");
        if (d.error) say(h, d.error, true);
      } catch (e) {
        galleryLoading = false;
        paint();
        say(h, e.message, true);
      }
    }
    async function load() {
      const selected = gid,
        version = ++detailVersion;
      desc = null;
      detailLoading = !!selected;
      paint();
      if (!selected || blocked) return;
      try {
        const result = await api(
          "/api/faces/galleries/" + encodeURIComponent(selected),
        );
        if (version !== detailVersion || selected !== gid) return;
        desc = result;
        detailLoading = false;
        paint();
      } catch (e) {
        if (version === detailVersion && selected === gid) {
          detailLoading = false;
          paint();
          say(h, e.message, true);
        }
      }
    }
    function hasPortrait(value) {
      return (
        typeof value === "string" &&
        value.length <= 48 * 1024 &&
        value.startsWith("data:image/jpeg;base64,")
      );
    }
    function portrait(value, label) {
      if (hasPortrait(value))
        return `<img class="dt-portrait" src="${esc(value)}" alt="${esc(label)}" loading="lazy" decoding="async" draggable="false">`;
      return '<span class="dt-portrait dt-portrait-empty" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/></svg></span>';
    }
    function identitiesMarkup() {
      return (
        (desc.identities || [])
          .filter((identity) =>
            (identity.name + " " + identity.id).toLowerCase().includes(identityQuery),
          )
          .map((identity) => {
            const image =
              identity.thumbnail ||
              (identity.samples || []).find((sample) =>
                hasPortrait(sample.thumbnail),
              )?.thumbnail;
            return `<article class="dt-identity"><div class="dt-identity-heading">${portrait(image, "Portrait of " + identity.name)}<div class="dt-identity-copy"><b>${esc(identity.name)}</b><span>${(identity.samples || []).length} samples</span>${hasPortrait(image) ? "" : '<span class="dt-portrait-note">No portrait yet. Add a face sample to create one.</span>'}</div></div><div class="dt-actions"><button type="button" class="dt-button" data-enroll-identity="${esc(identity.id)}" aria-haspopup="dialog">Add sample</button><details class="dt-action-menu"><summary aria-label="Manage ${esc(identity.name)}">Manage</summary><div><button class="dt-button" data-ri="${esc(identity.id)}">Rename</button><button class="dt-button dt-danger" data-xi="${esc(identity.id)}">Remove</button></div></details></div><details class="dt-samples" data-sample-list="${esc(identity.id)}" ${openSamples.has(identity.id) ? "open" : ""}><summary>Saved samples (${(identity.samples || []).length})</summary><div class="dt-sample-list">${(identity.samples || []).map((sample, index) => `<div class="dt-sample"><div class="dt-sample-preview">${portrait(sample.thumbnail, "Face sample " + (index + 1) + " of " + identity.name)}<span class="dt-sample-name">Sample ${index + 1}</span></div><button class="dt-button dt-danger" data-xi="${esc(identity.id)}" data-xs="${esc(sample.id)}">Remove sample</button></div>`).join("") || '<p class="dt-empty">No saved samples.</p>'}</div></details></article>`;
          })
          .join("") || `<p class="dt-empty">${identityQuery ? "No matching identities. Try another name or ID." : "No identities yet. Choose Enroll someone to add your first person."}</p>`
      );
    }
    function paint() {
      const current = list.find((gallery) => gallery.id === gid);
      h.querySelector("[data-current-gallery]").textContent = current?.name || "None selected";
      h.querySelector("[data-gallery-count]").textContent = `${list.length} ${list.length === 1 ? "gallery" : "galleries"}`;
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
              '">' +
              portrait(g.thumbnail, "Gallery portrait") +
              '<span class="dt-gallery-copy"><b>' +
              esc(g.name) +
              "</b><span>" +
              (g.identity_count || 0) +
              " identities · " +
              (g.sample_count || 0) +
              " samples</span></span></button>",
          )
          .join("") ||
        `<p class="dt-empty">${galleryLoading ? "Loading galleries…" : blocked ? "Galleries are stored by the local Python app." : list.length ? "No matching galleries. Try another name or ID." : "No galleries yet. Create one to begin."}</p>`;
      const p = h.querySelector("[data-detail]");
      if (!desc || desc.id !== gid) {
        p.innerHTML = `<p class="dt-empty" ${detailLoading ? 'role="status"' : ""}>${detailLoading ? "Loading gallery…" : gid ? "Gallery details unavailable. Choose Refresh to try again." : blocked ? "Gallery management and enrollment require the local Python app." : "Choose a gallery above to view its people, or create a new collection."}</p>`;
        delete p.dataset.renderedGid;
        p._renderedDesc = null;
        return;
      }
      if (p.dataset.renderedGid === gid && p._renderedDesc === desc) {
        p.querySelector(".dt-identities").innerHTML = identitiesMarkup();
        return;
      }
      p.innerHTML =
        '<header class="dt-detail-head"><h2>' +
        esc(desc.name) +
        '</h2><div class="dt-actions"><button type="button" class="dt-button dt-primary" data-enroll-open aria-haspopup="dialog">Enroll someone</button><details class="dt-action-menu"><summary>Gallery actions</summary><div><button class="dt-button" data-rg>Rename</button><button class="dt-button" data-export>Export</button><button class="dt-button dt-danger" data-xg>Remove gallery</button></div></details></div></header><div class="dt-identity-tools"><label>Search identities<input type="search" data-identity-search placeholder="Person name or ID" value="' + esc(identityQuery) + '"></label><span>' + (desc.identities || []).length + ' identities</span></div><section class="dt-identities" aria-label="Enrolled identities"></section>';
      p.querySelector(".dt-identities").innerHTML = identitiesMarkup();
      p.dataset.renderedGid = gid;
      p._renderedDesc = desc;
    }
    h.addEventListener("input", (e) => {
      if (e.target.matches("[data-search]")) {
        q = e.target.value.trim().toLowerCase();
        paint();
      } else if (e.target.matches("[data-identity-search]")) {
        identityQuery = e.target.value.trim().toLowerCase();
        paint();
      }
    });
    h.addEventListener("click", async (e) => {
      let b = e.target.closest("button");
      if (!b || blocked) return;
      if (b.dataset.actionBusy === "1") return;
      b.dataset.actionBusy = "1";
      try {
        if (b.hasAttribute("data-refresh")) return await refresh();
        if (b.dataset.gid) {
          if (gid !== b.dataset.gid) {
            galleryGeneration++;
            delete h._pending;
            identityQuery = "";
            openSamples.clear();
          }
          gid = b.dataset.gid;
          h.querySelector(".dt-gallery-browser").open = false;
          h.querySelector(".dt-gallery-browser > summary")?.focus?.();
          paint();
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
            ((!detectors.length || !recognizers.length) ? '<p class="dt-dialog-note" role="status">Missing ' + (!detectors.length ? 'a face detector' : '') + (!detectors.length && !recognizers.length ? ' and ' : '') + (!recognizers.length ? 'an ArcFace recognizer' : '') + '. Add the missing models in Models &amp; Workflows before creating a gallery.</p>' : '') +
            '<p class="dt-dialog-note">Connect this gallery’s Classifier node to InsightFace Detections to recognize enrolled identities.</p><footer class="dt-dialog-actions"><button class="dt-button" type="button" value="cancel" formnovalidate>Cancel</button><button class="dt-button dt-primary" value="create" ' + ((!detectors.length || !recognizers.length) ? 'disabled' : '') + '>Create gallery</button></footer></form>';
          document.body.append(d);
          showDialog(d, b);
          d.addEventListener(
            "close",
            async () => {
              try {
                if (d.returnValue === "create") {
                  let r = await api(
                    "/api/faces/galleries",
                    Object.fromEntries(new FormData(d.querySelector("form"))),
                  );
                  galleryGeneration++;
                  gid = r.id;
                  identityQuery = "";
                  openSamples.clear();
                  h.querySelector(".dt-gallery-browser").open = false;
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
              if (b.isConnected) b.focus();
            },
            { once: true },
          );
          return;
        }
        let id = b.dataset.xi;
        if (b.hasAttribute("data-rg")) {
          const name = await requestDialog({
            title: "Rename gallery",
            message:
              "Choose a name that helps you find this identity collection.",
            initial: desc.name,
            submit: "Save name",
            opener: b,
          });
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
          if (
            await requestDialog({
              title: "Remove gallery?",
              message:
                "This permanently removes this gallery and all its enrolled face samples.",
              submit: "Remove gallery",
              destructive: true,
              opener: b,
            })
          ) {
            await api(
              "/api/faces/galleries/" + encodeURIComponent(gid) + "/remove",
              {},
            );
            gid = "";
            h.querySelector(".dt-gallery-browser").open = true;
            galleryGeneration++;
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
            name = await requestDialog({
              title: "Rename identity",
              message: "The new name will also appear in recognition results.",
              initial: old.name,
              submit: "Save name",
              opener: b,
            });
          if (!name) return;
          await api(
            "/api/faces/galleries/" +
              encodeURIComponent(gid) +
              "/identities/" +
              encodeURIComponent(old.id) +
              "/rename",
            { name },
          );
          await load();
          await refresh();
          window.dispatchEvent(
            new CustomEvent("spyder:face-galleries-changed"),
          );
          return;
        }
        if (id && !b.dataset.xs && b.hasAttribute("data-xi")) {
          if (
            !(await requestDialog({
              title: "Remove identity?",
              message:
                "This permanently removes this identity and its enrolled samples from the gallery.",
              submit: "Remove identity",
              destructive: true,
              opener: b,
            }))
          )
            return;
          await api(
            "/api/faces/galleries/" +
              encodeURIComponent(gid) +
              "/identities/" +
              encodeURIComponent(id) +
              "/remove",
            {},
          );
          await load();
          await refresh();
          window.dispatchEvent(
            new CustomEvent("spyder:face-galleries-changed"),
          );
          return;
        }
        if (id && b.dataset.xs) {
          if (
            !(await requestDialog({
              title: "Remove sample?",
              message:
                "This permanently removes this face sample. Removing the final sample also removes the identity.",
              submit: "Remove sample",
              destructive: true,
              opener: b,
            }))
          )
            return;
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
          await refresh();
          window.dispatchEvent(
            new CustomEvent("spyder:face-galleries-changed"),
          );
        }
      } catch (x) {
        h._creatingGallery = false;
        const create = h.querySelector("[data-create]");
        if (create) create.disabled = blocked;
        say(h, x.message, true);
      } finally {
        delete b.dataset.actionBusy;
      }
    });
    h.addEventListener("click", async (e) => {
      const opener = e.target.closest(
        "[data-enroll-open], [data-enroll-identity]",
      );
      if (!opener || blocked) return;
      const enrollmentGallery = gid,
        enrollmentGeneration = galleryGeneration;
      try {
        if (!window.spyderFaceEnrollment)
          throw Error(
            "Enrollment viewer did not load. Reload the page and try again.",
          );
        await window.spyderFaceEnrollment.open({
          galleryId: enrollmentGallery,
          galleryName: desc.name,
          identityName: opener.dataset.enrollIdentity
            ? desc.identities.find(
                (identity) => identity.id === opener.dataset.enrollIdentity,
              )?.name
            : undefined,
          opener,
          onSaved: async () => {
            if (
              enrollmentGeneration !== galleryGeneration ||
              enrollmentGallery !== gid
            )
              return;
            await load();
            await refresh();
            say(
              h,
              "Face enrolled. Portraits saved locally; full source media was not retained.",
            );
            window.dispatchEvent(
              new CustomEvent("spyder:face-galleries-changed"),
            );
          },
        });
      } catch (error) {
        say(h, error.message, true);
      }
    });
    h.addEventListener("toggle", (event) => {
      if (event.target.matches?.("[data-sample-list]")) {
        const id = event.target.dataset.sampleList;
        if (event.target.open) openSamples.add(id);
        else openSamples.delete(id);
      }
    }, true);
    paint();
    if (!blocked) refresh();
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
