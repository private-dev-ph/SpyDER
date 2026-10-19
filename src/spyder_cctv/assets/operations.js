"use strict";
(() => {
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  function scheduleSummary(rule) {
    return `${rule.days.map((day) => DAYS[day]).join(", ")} · ${rule.start}–${rule.end}${rule.end < rule.start ? " (next day)" : ""}`;
  }
  function validateSchedule(rule) {
    if (!rule.name.trim()) throw Error("Give the schedule a name.");
    if (!rule.camera_ids.length) throw Error("Choose at least one camera.");
    if (!rule.days.length) throw Error("Choose at least one weekday.");
    if (!rule.start || !rule.end || rule.start === rule.end)
      throw Error("Choose different start and end times.");
    return rule;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { scheduleSummary, validateSchedule };
    return;
  }
  const app = window.spyder;
  let dispose = () => {};
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const button = (text, action) => {
    const element = node("button", text, "button secondary");
    element.type = "button";
    element.addEventListener("click", action);
    return element;
  };
  function download(data, filename) {
    const url = URL.createObjectURL(
      new Blob([data], { type: "application/json" }),
    );
    const link = node("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function mount() {
    dispose();
    const workspace = location.hash.slice(1);
    const content = document.querySelector("#workspace-content");
    if (!content || !["system", "recordings"].includes(workspace)) return;
    const controller = new AbortController();
    let timer;
    let disposed = false;
    dispose = () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
    };
    const get = async (path) => {
      if (window.spyderShowcase)
        throw Error("This feature requires the installed local application.");
      const response = await fetch(path, {
        signal: controller.signal,
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || "Local service unavailable.");
      return data;
    };
    const submit = async (path, data) => {
      if (window.spyderShowcase)
        throw Error("This feature requires the installed local application.");
      return app.request(path, data);
    };
    const panel = (title, description) => {
      const section = node("section", "", "workspace-panel operations-panel");
      section.append(node("h2", title), node("p", description, "field-help"));
      return section;
    };
    if (workspace === "system") {
      const health = panel(
        "System health",
        "Current capture, processing, recording, and storage status. Paused cameras are not outages.",
      );
      health.id = "system-health";
      const summary = node("strong", "Checking health…", "health-summary"),
        issues = node("ul", "", "health-issues"),
        stamp = node("small");
      health.append(summary, issues, stamp);
      content.prepend(health);
      const backup = panel(
        "Configuration backup & restore",
        "Back up camera settings, profiles, workflows, focus preference, and recording quality. Excludes models, media, events, schedules, output paths, and browser layouts.",
      );
      backup.id = "configuration-backup";
      backup.append(
        node(
          "p",
          "Backups may contain camera addresses, credentials, and workflow code. Keep the downloaded file private.",
          "field-help",
        ),
      );
      const result = node("p", "", "field-help");
      result.setAttribute("role", "status");
      const actions = node("div", "", "recording-actions");
      const exportButton = button("Download configuration", async () => {
        exportButton.disabled = true;
        try {
          const data = await get("/api/system/backup");
          download(JSON.stringify(data, null, 2), "spyder-configuration.json");
          result.textContent =
            "Configuration downloaded. Models and recordings were not included.";
        } catch (error) {
          result.textContent = error.message;
        } finally {
          exportButton.disabled = false;
        }
      });
      const label = node(
        "label",
        "Import configuration JSON",
        "backup-file-label",
      );
      const file = node("input");
      file.type = "file";
      file.accept = ".json,application/json";
      label.append(file);
      actions.append(exportButton, label);
      const review = node("div", "", "backup-review");
      review.hidden = true;
      const reviewText = node("p"),
        acknowledgment = node("label", "", "operation-check");
      const confirmed = node("input");
      confirmed.type = "checkbox";
      acknowledgment.append(
        confirmed,
        document.createTextNode(
          "Replace saved settings on restart. I have backed up the current configuration.",
        ),
      );
      let imported = null;
      const restoreButton = button("Stage restore for restart", async () => {
        restoreButton.disabled = true;
        try {
          const restored = await submit("/api/system/backup/restore", {
            backup: imported,
          });
          result.textContent = restored.pending
            ? "Restore staged. Stop SpyDER and restart it to apply settings. Imported cameras and workflows will stay disabled."
            : "Restore could not be staged.";
          file.disabled = confirmed.disabled = true;
        } catch (error) {
          result.textContent = error.message;
          restoreButton.disabled = !confirmed.checked;
        }
      });
      restoreButton.disabled = true;
      confirmed.addEventListener("change", () => {
        restoreButton.disabled = !confirmed.checked;
      });
      review.append(reviewText, acknowledgment, restoreButton);
      backup.append(actions, review, result);
      content.append(backup);
      file.addEventListener("change", async () => {
        imported = null;
        review.hidden = true;
        confirmed.checked = false;
        restoreButton.disabled = true;
        try {
          const selected = file.files[0];
          if (!selected) return;
          if (selected.size > 2 * 1024 * 1024)
            throw Error("Configuration backup must be at most 2 MiB.");
          imported = JSON.parse(await selected.text());
          const preview = await submit("/api/system/backup/preview", {
            backup: imported,
          });
          reviewText.textContent = `${preview.counts.cameras} cameras, ${preview.counts.profiles} profiles, ${preview.counts.workflows} workflows. ${(preview.warnings || []).join(" ")} Stop all cameras and recordings and disable workflows and schedules before restoring. Existing settings are replaced; models and media are untouched.`;
          review.hidden = false;
          result.textContent = "Review the backup before staging the restore.";
        } catch (error) {
          result.textContent = error.message;
          imported = null;
        }
      });
      if (window.spyderShowcase) {
        summary.textContent = "Browser-local showcase";
        for (const camera of app.cameras())
          if (camera.error)
            issues.append(node("li", `${camera.name}: ${camera.error}`));
        stamp.textContent =
          "Native health and persistent backup are available in the installed application.";
        actions.hidden = true;
        result.textContent =
          "Use layout and workflow export for browser-owned drafts. Native configuration backup requires the installed app.";
        return;
      }
      let lastSignature = "";
      async function poll() {
        if (disposed) return;
        if (!document.hidden) {
          try {
            const data = await get("/api/system/health");
            if (disposed) return;
            const signature = JSON.stringify([
              data.state,
              data.issues,
              data.running_cameras,
              data.recording_state,
            ]);
            if (signature !== lastSignature) {
              lastSignature = signature;
              summary.textContent = `${data.state === "healthy" ? "All systems clear" : "Needs attention"} · ${data.running_cameras}/${data.camera_count} cameras running · Recording ${data.recording_state}`;
              health.dataset.state = data.state;
              issues.replaceChildren(
                ...data.issues.map((issue) =>
                  node(
                    "li",
                    `${issue.area}: ${issue.message}`,
                    `health-${issue.severity}`,
                  ),
                ),
              );
            }
            stamp.textContent = `Last checked ${new Date(data.checked_at).toLocaleTimeString()}`;
            if (data.restore_pending) {
              result.textContent =
                "Configuration restore pending. Restart SpyDER to apply it; configuration changes are locked until restart.";
              file.disabled = true;
            }
          } catch (error) {
            if (!disposed) summary.textContent = error.message;
          }
        }
        if (!disposed) timer = setTimeout(poll, 5000);
      }
      poll();
    } else {
      const schedules = panel(
        "Recording schedules",
        "Daily and weekly recording on this computer. Overlapping rules share one tiled recording; manual and workflow controls take priority.",
      );
      schedules.id = "recording-schedules";
      content.insertBefore(schedules, content.children[1] || null);
      if (window.spyderShowcase) {
        schedules.append(
          node(
            "p",
            "Persistent schedules require the installed Python app. Browser demo recording stops when the tab is hidden.",
            "field-help",
          ),
        );
        return;
      }
      const status = node("p", "Loading schedules…", "field-help");
      status.setAttribute("role", "status");
      const list = node("div", "", "schedule-list");
      const details = node("details");
      details.append(node("summary", "Add or edit a schedule"));
      const form = node("form", "", "schedule-form");
      form.innerHTML =
        '<div class="operation-fields"><label>Name<input name="name" maxlength="120" required placeholder="Weekday monitoring"></label><label>Start<input name="start" type="time" required value="09:00"></label><label>End<input name="end" type="time" required value="17:00"></label></div><fieldset class="schedule-days"><legend>Days (start day for overnight rules)</legend></fieldset><fieldset class="schedule-cameras"><legend>Cameras</legend></fieldset><label class="operation-check"><input name="enabled" type="checkbox">Enable schedule</label><div class="recording-actions"><button class="button primary" type="submit">Save schedule</button></div>';
      for (let day = 0; day < 7; day++) {
        const label = node("label", "", "operation-check"),
          input = node("input");
        input.type = "checkbox";
        input.value = day;
        input.name = "day";
        input.checked = day < 5;
        label.append(input, document.createTextNode(DAYS[day]));
        form.querySelector(".schedule-days").append(label);
      }
      const cameras = form.querySelector(".schedule-cameras");
      for (const camera of app.cameras()) {
        const label = node("label", "", "operation-check"),
          input = node("input");
        input.type = "checkbox";
        input.name = "camera";
        input.value = camera.id;
        label.append(input, document.createTextNode(camera.name || camera.id));
        cameras.append(label);
      }
      let rules = [],
        editId = null,
        signature = "";
      const reset = button("New schedule", () => {
        editId = null;
        form.reset();
        form.elements.name.focus();
      });
      form.querySelector(".recording-actions").append(reset);
      details.append(form);
      schedules.append(status, list, details);
      function render(data) {
        rules = data.schedules;
        status.textContent = `${data.timezone} · ${(data.active_ids || []).length} active rule(s). ${(data.warnings || []).join(" ")}${data.owned ? " · Schedule owns the current recording." : ""}`;
        const next = JSON.stringify([rules, data.active_ids]);
        if (next === signature) return;
        signature = next;
        list.replaceChildren();
        if (!rules.length)
          list.append(node("p", "No recording schedules yet.", "field-help"));
        for (const rule of rules) {
          const row = node("div", "", "schedule-row"),
            text = node("div");
          text.append(
            node("strong", rule.name),
            node(
              "small",
              `${rule.enabled ? "Enabled" : "Disabled"} · ${scheduleSummary(rule)} · ${rule.camera_ids.length} camera(s)`,
            ),
          );
          const controls = node("div", "", "recording-actions");
          controls.append(
            button("Edit", () => {
              editId = rule.id;
              form.elements.name.value = rule.name;
              form.elements.start.value = rule.start;
              form.elements.end.value = rule.end;
              form.elements.enabled.checked = rule.enabled;
              for (const input of form.querySelectorAll('[name="day"]'))
                input.checked = rule.days.includes(Number(input.value));
              for (const input of form.querySelectorAll('[name="camera"]'))
                input.checked = rule.camera_ids.includes(input.value);
              details.open = true;
              form.elements.name.focus();
            }),
            button(rule.enabled ? "Disable" : "Enable", async () => {
              try {
                render(
                  await submit("/api/recordings/schedules", {
                    schedules: rules.map((item) =>
                      item.id === rule.id
                        ? { ...item, enabled: !item.enabled }
                        : item,
                    ),
                  }),
                );
              } catch (error) {
                status.textContent = error.message;
              }
            }),
            button("Delete", async () => {
              if (!window.confirm(`Delete schedule “${rule.name}”?`)) return;
              try {
                render(
                  await submit(
                    `/api/recordings/schedules/${encodeURIComponent(rule.id)}/remove`,
                    {},
                  ),
                );
              } catch (error) {
                status.textContent = error.message;
              }
            }),
          );
          row.append(text, controls);
          list.append(row);
        }
      }
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const save = form.querySelector('[type="submit"]');
        save.disabled = true;
        try {
          const rule = validateSchedule({
            id: editId || `schedule-${crypto.randomUUID()}`,
            name: form.elements.name.value,
            start: form.elements.start.value,
            end: form.elements.end.value,
            enabled: form.elements.enabled.checked,
            days: [...form.querySelectorAll('[name="day"]:checked')].map(
              (input) => Number(input.value),
            ),
            camera_ids: [
              ...form.querySelectorAll('[name="camera"]:checked'),
            ].map((input) => input.value),
          });
          render(
            await submit("/api/recordings/schedules", {
              schedules: [...rules.filter((item) => item.id !== rule.id), rule],
            }),
          );
          editId = null;
          form.reset();
          status.textContent += " Saved.";
        } catch (error) {
          status.textContent = error.message;
        } finally {
          save.disabled = false;
        }
      });
      async function poll() {
        if (disposed) return;
        if (!document.hidden) {
          try {
            const data = await get("/api/recordings/schedules");
            if (!disposed) render(data);
          } catch (error) {
            if (!disposed) status.textContent = error.message;
          }
        }
        if (!disposed) timer = setTimeout(poll, 5000);
      }
      poll();
    }
  }
  window.addEventListener("hashchange", mount);
  mount();
})();
