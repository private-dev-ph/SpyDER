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
    module.exports = {
      scheduleSummary,
      validateSchedule,
      collectBrowserBackup,
      validateBrowserBackup,
    };
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
  function collectBrowserBackup(storage) {
    const local_storage = {};
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key?.startsWith("spyder.") || key?.startsWith("spyder-"))
        local_storage[key] = storage.getItem(key);
    }
    const result = { version: 1, local_storage };
    validateBrowserBackup(result);
    return result;
  }
  function validateBrowserBackup(data) {
    if (
      !data ||
      data.version !== 1 ||
      Object.keys(data).sort().join() !== "local_storage,version" ||
      !data.local_storage ||
      typeof data.local_storage !== "object" ||
      Array.isArray(data.local_storage) ||
      Object.entries(data.local_storage).length > 1000 ||
      Object.entries(data.local_storage).some(
        ([key, value]) =>
          !(key.startsWith("spyder.") || key.startsWith("spyder-")) ||
          key.length > 256 ||
          typeof value !== "string",
      ) ||
      new TextEncoder().encode(JSON.stringify(data)).length > 8 * 1024 * 1024
    )
      throw Error(
        "Invalid browser settings backup (SpyDER keys only, maximum 8 MiB).",
      );
    return data;
  }
  function mount() {
    dispose();
    const workspace = location.hash.slice(1);
    const content = document.querySelector("#workspace-content");
    if (!content || !["system", "recordings"].includes(workspace)) return;
    const controller = new AbortController();
    let timer, backupTimer;
    let disposed = false;
    dispose = () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
      clearTimeout(backupTimer);
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
      summary.setAttribute("role", "status");
      health.append(summary, issues, stamp);
      (content.querySelector("#system-overview") || content).prepend(health);
      const complete = panel(
        "Complete backup & restore",
        "Create a complete local ZIP archive, or verify and restore a separate copy. Footage is optional.",
      );
      complete.id = "complete-backup";
      const fields = node("div", "", "complete-backup-grid");
      function pathField(caption, placeholder, kind, browseText) {
        const container = node("div", "", "backup-path-field");
        const label = node("label", caption),
          input = node("input"),
          row = node("div", "", "backup-path-control");
        input.id = `backup-path-${kind}`;
        label.htmlFor = input.id;
        input.type = "text";
        input.readOnly = true;
        input.placeholder = placeholder;
        input.autocomplete = "off";
        input.dataset.backupPath = kind;
        const help = node("small", "", "field-help");
        help.id = `${input.id}-help`;
        help.setAttribute("role", "status");
        input.setAttribute("aria-describedby", help.id);
        const field = { label: container, input, help };
        field.choose = button(browseText, () => chooseLocation(field, kind));
        field.choose.dataset.backupPick = kind;
        const icon = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "svg",
        );
        icon.setAttribute("class", "icon");
        icon.setAttribute("viewBox", "0 0 24 24");
        icon.setAttribute("aria-hidden", "true");
        const use = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "use",
        );
        use.setAttribute(
          "href",
          kind === "open_archive"
            ? "/icons.svg#file-archive"
            : "/icons.svg#folder-open",
        );
        icon.append(use);
        field.choose.prepend(icon);
        row.append(input, field.choose);
        container.append(label, row, help);
        return field;
      }
      const output = pathField(
        "Backup file",
        "Choose a save location",
        "save_archive",
        "Choose save location",
      );
      const source = pathField(
        "Backup archive",
        "Choose an existing ZIP backup",
        "open_archive",
        "Choose backup file",
      );
      const destination = pathField(
        "Restore location",
        "Choose a parent folder",
        "restore_parent",
        "Choose parent folder",
      );
      destination.help.textContent =
        "SpyDER will suggest a new restore folder inside your selection. Existing folders are kept.";
      const advanced = node("details", "", "backup-advanced");
      advanced.dataset.backupAdvanced = "";
      advanced.append(
        node("summary", "Advanced: enter paths manually"),
        node(
          "p",
          "The location fields above become editable in this mode. Use full paths on the computer running SpyDER; the restore folder must not already exist.",
          "field-help",
        ),
      );
      advanced.addEventListener("toggle", () => {
        for (const field of [output, source, destination])
          field.input.readOnly = !advanced.open;
      });
      const mediaLabel = node("label", "", "operation-check"),
        mediaCheck = node("input");
      mediaCheck.type = "checkbox";
      mediaLabel.append(
        mediaCheck,
        document.createTextNode(
          "Include recordings and captures (can be very large)",
        ),
      );
      const browserLabel = node("label", "", "operation-check"),
        browserCheck = node("input");
      browserCheck.type = "checkbox";
      browserCheck.checked = true;
      browserLabel.append(
        browserCheck,
        document.createTextNode(
          "Include this browser’s SpyDER layouts, preferences, and drafts",
        ),
      );
      const status = node(
        "p",
        "Ready. Archive paths refer to the computer running SpyDER.",
        "field-help",
      );
      status.setAttribute("role", "status");
      const progress = node("progress");
      progress.removeAttribute("value");
      progress.hidden = true;
      progress.setAttribute("aria-label", "Backup operation in progress");
      const report = node("div", "", "complete-backup-report");
      report.hidden = true;
      const ackLabel = node("label", "", "operation-check"),
        ack = node("input");
      ack.type = "checkbox";
      ackLabel.append(
        ack,
        document.createTextNode(
          "Restore a separate copy into a new folder. The running installation stays in place.",
        ),
      );
      let jobGeneration = 0;
      let choosing = false;
      let active = false,
        validatedPath = "",
        submittedPath = "";
      const create = button("Create complete backup", () => start("create"));
      const inspect = button("Inspect archive", () => start("inspect"));
      const restore = button("Restore to new folder", () => start("restore"));
      create.className = restore.className = "button primary";
      const cancel = button("Cancel current operation", async () => {
        try {
          await showJob(await submit("/api/system/backup/jobs/cancel", {}));
          status.textContent =
            "Cancellation requested. A completed archive may already exist; current application data stays in place.";
        } catch (error) {
          status.textContent = error.message;
        }
      });
      cancel.disabled = true;
      function refreshButtons() {
        const unavailable = active || choosing || !!window.spyderShowcase;
        for (const field of [output, source, destination]) {
          field.choose.disabled = unavailable;
          field.input.disabled = active || choosing;
        }
        create.disabled = unavailable || !output.input.value.trim();
        inspect.disabled = unavailable || !source.input.value.trim();
        complete.setAttribute("aria-busy", String(active || choosing));
        cancel.hidden = !active;
        cancel.disabled = !active || !!window.spyderShowcase;
        inspect.textContent = validatedPath ? "Verify again" : "Verify archive";
        restore.disabled =
          unavailable ||
          !destination.input.value.trim() ||
          !ack.checked ||
          validatedPath !== source.input.value.trim() ||
          !validatedPath;
      }
      for (const input of [output.input, source.input, destination.input])
        input.addEventListener("input", () => {
          if (input === source.input) validatedPath = "";
          if (input === source.input || input === destination.input)
            ack.checked = false;
          refreshButtons();
        });
      ack.addEventListener("change", refreshButtons);
      async function chooseLocation(field, kind) {
        if (active || choosing || window.spyderShowcase) return;
        choosing = true;
        refreshButtons();
        field.help.textContent = "Opening the file chooser on this computer…";
        try {
          const selection = await submit("/api/system/backup/picker", { kind });
          if (disposed) return;
          if (selection.cancelled || !selection.path) {
            field.help.textContent =
              "Selection cancelled. Your previous choice is kept.";
            return;
          }
          field.input.value = selection.path;
          field.input.title = selection.path;
          field.input.dispatchEvent(new Event("input", { bubbles: true }));
          field.help.textContent =
            kind === "restore_parent"
              ? "A new folder will be created here when you restore."
              : kind === "open_archive"
                ? "Archive selected. Verifying its contents…"
                : "Save location selected. Existing archives will not be overwritten.";
          choosing = false;
          refreshButtons();
          if (kind === "open_archive") await start("inspect");
        } catch (error) {
          if (!disposed) {
            field.help.textContent = error.message;
            status.textContent =
              "The selection could not be used. Retry the chooser, or use Advanced to enter a path.";
          }
        } finally {
          choosing = false;
          if (!disposed) {
            refreshButtons();
            if (!field.choose.disabled)
              field.choose.focus({ preventScroll: true });
          }
        }
      }

      async function showJob(job) {
        if (disposed) return;
        clearTimeout(backupTimer);
        active = job.state === "running";
        progress.hidden = !active;
        refreshButtons();
        status.textContent =
          job.state === "idle"
            ? "Ready."
            : job.state === "error"
              ? `Operation failed: ${job.error}`
              : job.state === "completed"
                ? "Operation completed."
                : job.progress?.message ||
                  `${job.operation || "Backup"} in progress…`;
        if (job.state === "completed") {
          const result = job.result || {};
          report.hidden = false;
          const details = node("dl");
          const pairs = [
            ["Archive", result.path],
            ["Restored folder", result.destination],
            ["Configuration path", result.config_path],
            ["Browser settings file", result.browser_state_path],
            ["Files", result.files ?? result.file_count],
            [
              "Uncompressed size",
              result.total_bytes == null
                ? null
                : `${(result.total_bytes / 1048576).toLocaleString(undefined, { maximumFractionDigits: 2 })} MiB`,
            ],
            ["SpyDER version", result.application_version],
            [
              "Created",
              result.created_at
                ? new Date(result.created_at).toLocaleString()
                : null,
            ],
            [
              "Footage",
              result.include_media == null
                ? null
                : result.include_media
                  ? "Included"
                  : "Excluded",
            ],
          ];
          for (const [label, value] of pairs)
            if (value != null) {
              details.append(node("dt", label), node("dd", String(value)));
            }
          report.replaceChildren(details);
          if (result.warnings?.length) {
            report.append(node("h3", "Review before restoring"));
            const warnings = node("ul");
            for (const warning of result.warnings)
              warnings.append(node("li", warning));
            report.append(warnings);
          }

          if (job.operation === "create") {
            source.input.value =
              submittedPath || result.path || output.input.value.trim();
            validatedPath = "";
            ack.checked = false;
            source.help.textContent =
              "Backup created. Verify this archive before restoring.";
          }
          if (
            job.operation === "inspect" &&
            submittedPath &&
            submittedPath === source.input.value.trim()
          ) {
            validatedPath = submittedPath;
            source.help.textContent =
              "Archive verified. Choose a restore location, then review and restore.";
            refreshButtons();
          }
          if (job.operation === "restore") {
            ack.checked = false;
            status.textContent =
              "Restore complete. Stop SpyDER before starting a new instance with the restored config path shown below. Import browser-state.json after switching to that restored instance.";
          }
        }
        refreshButtons();
        if (active && !disposed) backupTimer = setTimeout(pollJob, 1500);
      }
      async function pollJob() {
        try {
          const generation = jobGeneration;
          const job = await get("/api/system/backup/jobs");
          if (generation === jobGeneration) await showJob(job);
        } catch (error) {
          if (!disposed) {
            status.textContent = error.message;
            backupTimer = setTimeout(pollJob, 3000);
          }
        }
      }
      async function start(operation) {
        if (active || choosing || window.spyderShowcase) return;
        if (
          operation === "restore" &&
          (!ack.checked || validatedPath !== source.input.value.trim())
        )
          return;
        ++jobGeneration;
        active = true;
        refreshButtons();
        report.hidden = true;
        status.textContent = "Starting local operation…";
        submittedPath =
          operation === "create"
            ? output.input.value.trim()
            : source.input.value.trim();
        try {
          const body = { operation, path: submittedPath };
          if (operation === "create") {
            body.include_media = mediaCheck.checked;
            if (browserCheck.checked)
              body.browser_data = collectBrowserBackup(localStorage);
          }
          if (operation === "restore")
            body.destination = destination.input.value.trim();
          await showJob(await submit("/api/system/backup/jobs", body));
        } catch (error) {
          active = false;
          refreshButtons();
          status.textContent = error.message;
        }
      }
      const createCard = node("details", "", "backup-task-card");
      createCard.name = "spyder-complete-backup-task";
      createCard.open = true;
      createCard.dataset.backupTask = "create";
      const createHeader = node("summary", "Create a backup", "backup-task-header");
      const createBody = node("div", "", "backup-task-body");
      createBody.append(
        node(
          "p",
          "Save a portable copy of your application data.",
          "field-help",
        ),
        output.label,
        mediaLabel,
        browserLabel,
        create,
      );
      createCard.append(createHeader, createBody);
      const restoreCard = node("details", "", "backup-task-card");
      restoreCard.name = "spyder-complete-backup-task";
      restoreCard.dataset.backupTask = "restore";
      const restoreHeader = node("summary", "Verify & restore", "backup-task-header");
      const restoreBody = node("div", "", "backup-task-body");
      restoreBody.append(
        node(
          "p",
          "Choose an archive to verify it before creating a separate restored copy.",
          "field-help",
        ),
        source.label,
        inspect,
        destination.label,
        ackLabel,
        restore,
      );
      restoreCard.append(restoreHeader, restoreBody);
      create.dataset.backupCreate = "";
      inspect.dataset.backupInspect = "";
      restore.dataset.backupRestore = "";
      fields.append(createCard, restoreCard);
      const included = node("details", "", "system-disclosure backup-scope");
      included.append(node("summary", "What's included?"), node("p", "Application settings, workflows and published versions, models, face galleries, events, schedules, and execution history. Recordings and captures are included only when selected. Browser layouts, preferences and drafts are optional.", "field-help"));
      complete.append(
        node("p", "Before archiving or restoring, stop cameras and recordings, disable workflows and schedules, and wait for finalization. Archives include models and sensitive face profiles; keep them private. Restored automation starts disabled.", "field-help backup-safety"),
        included,
        fields,
        advanced,
        cancel,
        progress,
        status,
        report,
      );
      const browserImport = node(
          "label",
          "Import browser-state.json after switching to restored data",
          "backup-file-label",
        ),
        browserFile = node("input");
      browserFile.type = "file";
      browserFile.accept = ".json,application/json";
      browserImport.append(browserFile);
      const browserSettings = node("details", "", "system-disclosure browser-settings-tools");
      browserSettings.id = "browser-settings-tools";
      const browserStatus = node("p", "", "field-help");
      browserStatus.setAttribute("role", "status");
      browserSettings.append(
        node("summary", "Browser layouts & preferences"),
        node("p", "Export or import SpyDER layouts, preferences and drafts for this browser origin. This JSON file is separate from the installation archive; import only after switching to restored data.", "field-help"),
        browserImport,
        button("Export browser settings", () => {
          try {
            download(
              JSON.stringify(collectBrowserBackup(localStorage), null, 2),
              "browser-state.json",
            );
            browserStatus.textContent =
              "Browser layouts, preferences, and drafts exported locally.";
          } catch (error) {
            browserStatus.textContent = error.message;
          }
        }),
      );
      browserSettings.append(browserStatus);
      complete.append(browserSettings);
      browserFile.addEventListener("change", async () => {
        try {
          const file = browserFile.files[0];
          if (!file) return;
          if (file.size > 8 * 1024 * 1024)
            throw Error("Browser settings exceed 8 MiB.");
          const data = validateBrowserBackup(JSON.parse(await file.text()));
          if (
            !window.confirm(
              "Replace matching SpyDER browser preferences, layouts, and drafts on this origin? Do this only after switching to the restored installation.",
            )
          )
            return;
          const old = new Map(
            Object.keys(data.local_storage).map((key) => [
              key,
              localStorage.getItem(key),
            ]),
          );
          try {
            for (const [key, value] of Object.entries(data.local_storage))
              localStorage.setItem(key, value);
          } catch (error) {
            for (const key of old.keys()) localStorage.removeItem(key);
            for (const [key, value] of old)
              if (value !== null) localStorage.setItem(key, value);
            throw error;
          }
          browserStatus.textContent =
            "Browser settings imported. Reload to apply the layouts and preferences.";
        } catch (error) {
          browserStatus.textContent = error.message;
        }
      });
      (content.querySelector("#system-backups") || content).append(complete);
      refreshButtons();
      if (window.spyderShowcase) {
        status.textContent =
          "Complete archives require the installed app. This static showcase sends no native backup requests.";
        browserFile.disabled = true;
      } else pollJob();
      const backup = node("details", "", "workspace-panel operations-panel system-disclosure");
      backup.append(node("summary", "Configuration JSON backup & restore"), node("p", "Back up camera settings, profiles, workflows, focus preference, and recording quality. Excludes models, media, events, schedules, output paths, and browser layouts.", "field-help"));
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
      (content.querySelector("#system-backups") || content).append(backup);
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
        healthLabel("Browser showcase", "showcase");
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
      function healthLabel(text, state) {
        const label = content.querySelector("[data-system-health-label]");
        if (label) { label.textContent = text; label.dataset.state = state; }
      }
      async function poll() {
        if (disposed) return;
        if (!document.hidden) {
          try {
            const data = await get("/api/system/health");
            if (disposed) return;
            healthLabel(data.state === "healthy" ? "All systems clear" : "Needs attention", data.state);
            const pendingRestore = content.querySelector("#system-pending-restore");
            if (pendingRestore) {
              pendingRestore.hidden = !data.restore_pending;
              pendingRestore.textContent = data.restore_pending ? "Configuration restore pending. Restart SpyDER to apply it; configuration changes are locked until restart." : "";
            }
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
                ...data.issues.map((issue) => {
                  const item = node(
                    "li",
                    `${issue.area}: ${issue.message}`,
                    `health-${issue.severity}`,
                  );
                  if (issue.area === "storage" || issue.area === "recovery") {
                    const link = node("a", issue.area === "storage" ? "Review storage" : "Review recordings", "health-review-link");
                    link.href = issue.area === "storage" ? "#system" : "#recordings";
                    if (issue.area === "storage") link.addEventListener("click", (event) => {
                      event.preventDefault();
                      content.querySelector("[data-system-tab=storage]")?.click();
                      content.querySelector("[data-system-tab=storage]")?.focus();
                    });
                    item.append(document.createTextNode(" "), link);
                  }
                  return item;
                }),
              );
            }
            stamp.textContent = `Last checked ${new Date(data.checked_at).toLocaleTimeString()}`;
            if (data.restore_pending) {
              result.textContent =
                "Configuration restore pending. Restart SpyDER to apply it; configuration changes are locked until restart.";
              file.disabled = true;
            }
          } catch (error) {
            if (!disposed) {
              lastSignature = "";
              summary.textContent = error.message;
              healthLabel("Health unavailable", "unavailable");
            }
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
