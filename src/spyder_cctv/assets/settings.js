/* Device controls and profile workflows use the dashboard's small public interface. */
(() => {
  "use strict";
  const app = window.spyder;
  const find = (selector, root = document) => root.querySelector(selector);
  const dialog = find("#settings-dialog");
  const library = find("#profiles-dialog");
  const labels = {
    zoom: "Zoom",
    fov: "Field of view",
    pan: "Pan",
    tilt: "Tilt",
    brightness: "Brightness",
    contrast: "Contrast",
    saturation: "Saturation",
  };
  let active = null;
  let generation = 0;
  let snapshot = null;
  let profiles = [];
  let draft = {};
  let dirty = false;
  let busy = false;
  let pollTimer = null;
  let pollController = null;
  const rows = new Map();
  function current(id, token) {
    return active === id && generation === token && dialog.open;
  }

  async function get(path, controller = new AbortController()) {
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await (window.spyderShowcase?.fetch || fetch)(path, {
        cache: "no-store",
        signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Camera settings unavailable.");
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }
  function result(element, text, error = false) {
    element.textContent = text;
    element.classList.toggle("error", error);
  }
  function settingsMessage(text, error = false) {
    result(find("#settings-result"), text, error);
  }
  function libraryMessage(text, error = false) {
    result(find("#profiles-result"), text, error);
  }
  function percent(value) {
    return Number(value).toFixed(1) + "%";
  }
  function selectedSettings() {
    const values = {};
    for (const [name, row] of rows)
      if (row.include.checked) values[name] = Number(row.slider.value);
    return values;
  }
  function availability() {
    for (const [name, row] of rows) {
      const capability = snapshot?.capabilities[name];
      row.slider.disabled =
        !snapshot?.available ||
        !capability?.supported ||
        !row.include.checked ||
        busy;
      row.include.disabled =
        busy || (!capability?.supported && !(name in draft));
    }
    find("#apply-settings").disabled = busy || !snapshot?.available;
    find("#control-defaults").disabled =
      busy ||
      !snapshot?.available ||
      !Object.values(snapshot.capabilities).some(
        (c) => c.supported && typeof c.default_percent === "number",
      );
    find("#control-defaults").title = window.spyderShowcase
      ? "Browsers do not report driver defaults"
      : "Stage defaults for selected controls";
    find("#save-profile").disabled =
      busy || !Object.keys(selectedSettings()).length;
    find("#assign-profile").disabled = busy || !snapshot;
    find("#profile-choice").disabled = busy || !snapshot;
  }
  function profileOptions(selected = "") {
    const select = find("#profile-choice");
    select.replaceChildren(new Option("Custom settings", ""));
    for (const profile of profiles)
      select.append(new Option(profile.name, profile.id));
    select.value = selected || "";
  }
  function drawControls() {
    const container = find("#camera-controls");
    container.replaceChildren();
    rows.clear();
    for (const [name, labelText] of Object.entries(labels)) {
      const capability = snapshot.capabilities[name] || {
        supported: false,
        reason: "Not reported by this camera",
      };
      const row = document.createElement("div");
      row.className =
        "control-row" + (capability.supported ? "" : " unsupported");
      const heading = document.createElement("div");
      heading.className = "control-heading";
      const label = document.createElement("label");
      const include = document.createElement("input");
      include.type = "checkbox";
      include.setAttribute("aria-label", "Include " + labelText);
      include.checked = name in draft;
      label.append(include, document.createTextNode(labelText));
      const output = document.createElement("output");
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "0";
      slider.max = "100";
      slider.step = "0.1";
      slider.id = "control-" + name;
      slider.setAttribute("aria-label", labelText);
      slider.value = draft[name] ?? capability.value ?? 0;
      output.htmlFor = slider.id;
      output.textContent =
        capability.supported || name in draft
          ? percent(slider.value)
          : "Unavailable";
      const native = document.createElement("p");
      native.className = "control-native";
      native.id = "control-info-" + name;
      slider.setAttribute("aria-describedby", native.id);
      include.addEventListener("change", () => {
        if (include.checked) draft[name] = Number(slider.value);
        else delete draft[name];
        dirty = true;
        availability();
      });
      slider.addEventListener("input", () => {
        draft[name] = Number(slider.value);
        output.textContent = percent(slider.value);
        dirty = true;
      });
      heading.append(label, output);
      row.append(heading, slider, native);
      container.append(row);
      rows.set(name, { element: row, include, output, slider, native });
    }
    updateReadbacks();
  }
  function updateReadbacks() {
    if (!snapshot.available) {
      find("#settings-preview").hidden = true;
      find("#settings-preview").removeAttribute("src");
      find("#settings-preview-note").hidden = false;
    }
    for (const [name, row] of rows) {
      const capability = snapshot.capabilities[name];
      const outcome = snapshot.results[name];
      row.native.textContent = capability?.supported
        ? "Current " +
          capability.native_value +
          " device units · " +
          percent(capability.value) +
          " · Range " +
          capability.minimum +
          "–" +
          capability.maximum +
          " · Step " +
          capability.step +
          (capability.mode === "auto"
            ? " · Auto (applying switches to manual)"
            : "")
        : capability?.reason || "Not reported by this camera";
      if (outcome) {
        const state = document.createElement("span");
        state.className = "control-result";
        state.textContent =
          " · " +
          ({
            applied: "Applied",
            adjusted: "Driver adjusted",
            unsupported: "Skipped: unavailable",
            rejected: "Driver rejected",
            failed: "Control failed",
          }[outcome.status] || outcome.status) +
          (outcome.value != null ? " at " + percent(outcome.value) : "");
        row.native.append(state);
      }
    }
    availability();
  }
  function chooseDraft() {
    draft = { ...snapshot.desired };
    if (!Object.keys(draft).length)
      for (const [name, capability] of Object.entries(snapshot.capabilities)) {
        if (capability.supported) draft[name] = capability.value;
      }
    dirty = false;
    profileOptions(snapshot.profile_id);
    drawControls();
  }
  async function settingsPoll() {
    if (!dialog.open || !active || !snapshot) return;
    const id = active;
    const token = generation;
    pollController = new AbortController();
    try {
      const next = await get(
        "/api/cameras/" + id + "/settings",
        pollController,
      );
      if (!current(id, token)) return;
      const changed = snapshot.available !== next.available;
      snapshot = next;
      if (changed && !dirty) chooseDraft();
      else updateReadbacks();
      if (!busy && !dirty)
        settingsMessage(
          !snapshot.available
            ? "Camera paused or offline. Assign a profile now; it applies on the next start."
            : snapshot.settings_state === "pending"
              ? "Applying saved settings…"
              : snapshot.settings_state === "partial"
                ? "Some controls were skipped, adjusted, or rejected. Readbacks below show what applied."
                : Object.keys(snapshot.desired).length
                  ? "Settings are saved. Current values are confirmed by the driver."
                  : "Current values are read from the camera. Apply or save a profile to remember changes.",
        );
    } catch (error) {
      if (current(id, token) && error.name !== "AbortError") {
        settingsMessage(error.message, true);
        snapshot.available = false;
        availability();
      }
    } finally {
      if (generation === token) pollController = null;
      if (current(id, token)) pollTimer = setTimeout(settingsPoll, 900);
    }
  }
  async function openSettings(id) {
    const token = ++generation;
    active = id;
    snapshot = null;
    draft = {};
    dirty = false;
    busy = true;
    rows.clear();
    find("#camera-controls").replaceChildren();
    find("#settings-camera-label").textContent =
      app.cameras().find((camera) => camera.id === id)?.name || "Camera";
    settingsMessage("Reading camera capabilities…");
    dialog.showModal();
    availability();
    try {
      const [camera, saved] = await Promise.all([
        get("/api/cameras/" + id + "/settings"),
        get("/api/profiles"),
      ]);
      if (!current(id, token)) return;
      snapshot = camera;
      profiles = saved;
      chooseDraft();
      const frame = app.frame(id);
      find("#settings-preview").hidden = !frame || !camera.available;
      find("#settings-preview-note").hidden = !!frame && camera.available;
      if (frame && camera.available) find("#settings-preview").src = frame;
      settingsMessage(
        camera.available
          ? "Select the controls you want to apply or include in a profile."
          : "Start the camera to discover its controls. Profiles can be assigned while paused.",
      );
    } catch (error) {
      if (current(id, token)) settingsMessage(error.message, true);
    } finally {
      if (current(id, token)) {
        busy = false;
        availability();
        if (snapshot) settingsPoll();
      }
    }
  }
  document.addEventListener("spyder:camera-settings", (event) =>
    openSettings(event.detail.id),
  );
  document.addEventListener("spyder:frame", (event) => {
    if (dialog.open && active === event.detail.id && snapshot?.available) {
      find("#settings-preview").src = event.detail.url;
      find("#settings-preview").hidden = false;
      find("#settings-preview-note").hidden = true;
    }
  });
  for (const button of document.querySelectorAll(".close-settings"))
    button.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    generation++;
    active = null;
    clearTimeout(pollTimer);
    pollController?.abort();
    find("#settings-preview").removeAttribute("src");
    find("#profile-name").value = "";
  });
  find("#control-defaults").addEventListener("click", () => {
    for (const [name, row] of rows)
      if (
        snapshot.capabilities[name]?.supported &&
        row.include.checked &&
        typeof snapshot.capabilities[name].default_percent === "number"
      ) {
        row.slider.value = snapshot.capabilities[name].default_percent;
        row.output.textContent = percent(row.slider.value);
        if (row.include.checked) draft[name] = Number(row.slider.value);
      }
    dirty = true;
    settingsMessage("Defaults are staged. Apply to this camera to save them.");
  });
  find("#apply-settings").addEventListener("click", async () => {
    if (busy || !active) return;
    const id = active;
    const token = generation;
    busy = true;
    availability();
    try {
      const updated = await app.request("/api/cameras/" + id + "/settings", {
        settings: selectedSettings(),
      });
      if (!current(id, token)) {
        await app.refresh();
        return;
      }
      snapshot = updated;
      dirty = false;
      profileOptions("");
      settingsMessage("Settings saved. The camera worker is applying them…");
      await app.refresh();
    } catch (error) {
      if (current(id, token)) settingsMessage(error.message, true);
    } finally {
      if (current(id, token)) {
        busy = false;
        availability();
      }
    }
  });
  find("#profile-choice").addEventListener("change", () => {
    const profile = profiles.find(
      (item) => item.id === find("#profile-choice").value,
    );
    if (profile) {
      draft = { ...profile.settings };
      dirty = true;
      drawControls();
      settingsMessage(
        "Profile preview staged. Assign profile to save it to this camera.",
      );
    } else
      settingsMessage(
        "Assign Custom settings to detach the current profile while keeping its values.",
      );
  });
  find("#assign-profile").addEventListener("click", async () => {
    if (busy || !active) return;
    const id = active;
    const token = generation;
    busy = true;
    availability();
    try {
      const updated = await app.request("/api/cameras/" + id + "/profile", {
        profile_id: find("#profile-choice").value || null,
      });
      if (!current(id, token)) {
        await app.refresh();
        return;
      }
      snapshot = updated;
      chooseDraft();
      settingsMessage(
        snapshot.available
          ? "Profile assignment saved. Applying supported controls…"
          : "Profile assignment saved for the next camera start.",
      );
      await app.refresh();
    } catch (error) {
      if (current(id, token)) settingsMessage(error.message, true);
    } finally {
      if (current(id, token)) {
        busy = false;
        availability();
      }
    }
  });
  find("#save-profile-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !active) return;
    const id = active;
    const token = generation;
    const name = find("#profile-name").value.trim();
    const settings = selectedSettings();
    if (!name || !Object.keys(settings).length) {
      settingsMessage(
        "Name your profile and select at least one control.",
        true,
      );
      return;
    }
    busy = true;
    availability();
    try {
      const profile = await app.request("/api/profiles", { name, settings });
      // Saving a profile and assigning it are separate durable operations.
      profiles = await get("/api/profiles");
      if (!current(id, token)) {
        app.notify("Profile saved. Use Profiles to assign it.");
        return;
      }
      profileOptions(profile.id);
      try {
        const updated = await app.request("/api/cameras/" + id + "/profile", {
          profile_id: profile.id,
        });
        if (!current(id, token)) {
          await app.refresh();
          return;
        }
        snapshot = updated;
        chooseDraft();
        settingsMessage(
          "“" +
            profile.name +
            "” saved and assigned. Use Profiles to share it with other cameras.",
        );
      } catch (error) {
        if (current(id, token))
          settingsMessage(
            "Profile saved, but assignment failed. " + error.message,
            true,
          );
      }
      find("#profile-name").value = "";
      await app.refresh();
    } catch (error) {
      if (current(id, token)) settingsMessage(error.message, true);
    } finally {
      if (current(id, token)) {
        busy = false;
        availability();
      }
    }
  });

  function drawLibrary(selected = "") {
    find("#profiles-empty").hidden = profiles.length > 0;
    find("#profiles-content").hidden = profiles.length === 0;
    const select = find("#library-profile");
    select.replaceChildren();
    for (const profile of profiles)
      select.append(new Option(profile.name, profile.id));
    if (profiles.some((profile) => profile.id === selected))
      select.value = selected;
    drawTargets();
  }
  function drawTargets() {
    const profile = profiles.find(
      (item) => item.id === find("#library-profile").value,
    );
    const targets = find("#profile-targets");
    targets.replaceChildren();
    const legend = document.createElement("legend");
    legend.textContent = "Assign to cameras";
    targets.append(legend);
    if (!profile) return;
    find("#library-details").textContent = Object.entries(profile.settings)
      .map(([name, value]) => labels[name] + " " + percent(value))
      .join(" · ");
    for (const camera of app.cameras()) {
      const label = document.createElement("label");
      label.className = "profile-target";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = camera.id;
      checkbox.checked = camera.profile_id === profile.id;
      const text = document.createElement("span");
      text.textContent = camera.name;
      const hint = document.createElement("small");
      hint.textContent =
        camera.state === "running"
          ? "Live · applies now"
          : "Paused / offline · applies on start";
      text.append(hint);
      label.append(checkbox, text);
      targets.append(label);
    }
    const inUse = profile.assigned_to.length > 0;
    find("#delete-profile").disabled = inUse;
    find("#delete-profile").title = inUse
      ? "Unassign this profile in camera Settings before deleting it"
      : "Delete unused profile";
    find("#apply-profile-many").disabled = !app.cameras().length;
  }
  find("#library-profile").addEventListener("change", drawTargets);
  find("#open-profiles").addEventListener("click", async () => {
    library.showModal();
    find("#profiles-content").hidden = true;
    libraryMessage("Loading saved profiles…");
    try {
      profiles = await get("/api/profiles");
      drawLibrary();
      libraryMessage("");
    } catch (error) {
      libraryMessage(error.message, true);
    }
  });
  for (const button of document.querySelectorAll(".close-profiles"))
    button.addEventListener("click", () => library.close());
  find("#apply-profile-many").addEventListener("click", async () => {
    const profileId = find("#library-profile").value;
    const cameras = [
      ...document.querySelectorAll("#profile-targets input:checked"),
    ].map((input) => input.value);
    if (!cameras.length) {
      libraryMessage("Select at least one camera.", true);
      return;
    }
    const button = find("#apply-profile-many");
    button.disabled = true;
    const outcomes = await Promise.allSettled(
      cameras.map((id) =>
        app.request("/api/cameras/" + id + "/profile", {
          profile_id: profileId,
        }),
      ),
    );
    const failed = outcomes.filter((outcome) => outcome.status === "rejected");
    libraryMessage(
      "Profile assigned to " +
        (cameras.length - failed.length) +
        " of " +
        cameras.length +
        " camera(s). Supported controls apply now or on the next start." +
        (failed.length ? " " + failed[0].reason.message : ""),
      !!failed.length,
    );
    await app.refresh();
    try {
      profiles = await get("/api/profiles");
      drawLibrary(profileId);
    } catch (error) {
      libraryMessage(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
  find("#delete-profile").addEventListener("click", async () => {
    const profile = profiles.find(
      (item) => item.id === find("#library-profile").value,
    );
    if (!profile || !confirm("Delete unused profile “" + profile.name + "”?"))
      return;
    try {
      await app.request("/api/profiles/" + profile.id + "/remove");
      profiles = await get("/api/profiles");
      drawLibrary();
      libraryMessage("Profile deleted.");
    } catch (error) {
      libraryMessage(error.message, true);
    }
  });
})();
