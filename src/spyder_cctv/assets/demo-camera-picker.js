/* One picker for installed and static camera sources. All clips are bundled. */
(() => {
  "use strict";
  const catalog = window.spyderDemoCameraCatalog;
  const type = document.querySelector("#source-type"),
    input = document.querySelector("#camera-source");
  if (!catalog || !type || !input) return;
  type.append(
    new Option(
      "Home security demo clip",
      "sample",
      !!window.spyderShowcase,
      !!window.spyderShowcase,
    ),
  );
  const section = document.createElement("section");
  section.className = "demo-camera-picker";
  section.hidden = true;
  const label = document.createElement("label");
  label.htmlFor = "demo-clip-source";
  label.textContent = "Home camera scene";
  const select = document.createElement("select");
  select.id = "demo-clip-source";
  for (const clip of catalog.cameras)
    select.append(new Option(clip.name, clip.id));
  const video = document.createElement("video");
  video.controls = true;
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = "none";
  video.setAttribute("aria-label", "Selected demo footage preview");
  const note = document.createElement("p");
  note.className = "field-help";
  const credit = document.createElement("p");
  credit.className = "field-help";
  const link = document.createElement("a");
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "Original source and CC BY 3.0 credit";
  const abilities = document.createElement("p");
  abilities.className = "field-help";
  abilities.textContent = window.spyderShowcase
    ? "Looping clip, software camera tuning, browser motion, captures and recording. Browser-compatible workflows run in this tab. Native InsightFace/YOLO, Python code and face enrollment need the installed app; this demo does not simulate model results."
    : "A looping camera source for camera tuning, motion, workflows, automations, captures, recording and face enrollment with your locally installed models. Pan/tilt/zoom and image controls are software effects, not physical hardware.";
  section.append(label, select, video, note, credit, link, abilities);
  const sourceField = input.closest("label");
  sourceField.after(section);
  let previousName = "";
  function update() {
    const clip =
      catalog.cameras.find((c) => c.id === select.value) || catalog.cameras[0];
    video.pause();
    video.src = "/" + clip.filename;
    video.load();
    note.textContent = clip.notes + (window.spyderShowcase ? (clip.motion_preset
      ? " Approach motion is preset for this scene. Enable its Approach workflow in Vision Lab to log events and captures."
      : " No person approach preset: this scene contains no visible person.") : "");
    credit.textContent = `${clip.original_title} — ${clip.author}. ${clip.license}. Excerpt resized, frame rate changed and audio removed. ${clip.context}`;
    link.href = clip.source_url;
    const name = document.querySelector("#camera-name");
    if (name && (!name.value.trim() || name.value === previousName))
      name.value = clip.name;
    previousName = clip.name;
  }
  window.spyderDemoCameraPicker = {
    source: () => "demo://" + select.value,
    configure() {
      sourceField.hidden = true;
      input.required = false;
      input.hidden = true;
      section.hidden = false;
      document.querySelector("#source-label").textContent =
        "Bundled demo footage";
      document.querySelector("#source-help").textContent =
        "Eight-second archival home-camera loops. No camera permission, upload or remote stream required.";
      update();
    },
    hide() {
      section.hidden = true;
      sourceField.hidden = false;
      video.pause();
      video.removeAttribute("src");
      video.load();
    },
  };
  select.addEventListener("change", update);
  type.addEventListener("change", () => {
    if (type.value !== "sample") window.spyderDemoCameraPicker.hide();
  });
  document
    .querySelector("#add-dialog")
    ?.addEventListener("close", () => window.spyderDemoCameraPicker.hide());
})();
