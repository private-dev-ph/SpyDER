// Isolated native-runtime fixture: no user cameras or saved configuration.
window.motionErrors = [];
window.addEventListener("error", (event) => motionErrors.push(event.message));
window.motionRequests = [];
const motionFrame = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#303b3d"/><rect x="160" y="90" width="320" height="180" fill="#60716a"/></svg>';
const motionMask = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAoAAAAFoCAAAAADiWRWNAAAA9klEQVR4nO3BMQEAAADCoPVPbQsvoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADgZ4WVAAGyfPfPAAAAAElFTkSuQmCC"), c=>c.charCodeAt(0));
const motionRuntime = {state: "running", processing_ms: 8, regions: [{area_percent: 4, bbox: [20, 20, 60, 60]}], tracks: [{id: 1, bbox: [20, 20, 60, 60]}]};
const motionCapacity = {state: "ready", report: {hardware: {logical_cpus: 8, memory_bytes: 8589934592}, active_analysis: 1, message: "Fixture estimates", profiles: [{name: "Balanced", cost_ms: 8, suggested_instances: 3, inference_fps: 4, input_width: 320}]}};
const motionFetch = window.fetch.bind(window);
window.fetch = async (path, options = {}) => {
  if (!String(path).startsWith("/api/")) return motionFetch(path, options);
  motionRequests.push({path, method: options.method || "GET", body: options.body && JSON.parse(options.body)});
  if (String(path).endsWith("/mask") && window.motionMaskResponse === "warming") return new Response("{}", {status:503});
  if (String(path).endsWith("/mask") && window.motionMaskResponse === "invalid") return new Response(new Blob(["invalid mask"], {type:"image/jpeg"}));
  if (String(path).endsWith("/mask")) return new Response(new Blob([motionMask], {type:"image/png"}));
  if (/\/(frame|mask)$/.test(path)) return new Response(new Blob([motionFrame], {type: "image/svg+xml"}));
  const data = path === "/api/analysis/capacity" ? motionCapacity
    : /\/cameras\/.*\/analysis$/.test(path) ? {settings: {threshold: 16}, pipeline: "vision", runtime: motionRuntime}
    : {runtime: motionRuntime, pipeline: "vision"};
  return new Response(JSON.stringify(data), {headers: {"Content-Type": "application/json"}});
};
window.spyder = {
  cameras: () => [{id: "fixture-north", name: "North entrance", state: "running", pipeline: "vision"}, {id: "fixture-south", name: "South entrance", state: "running", pipeline: "motion"}],
  request: async (path, body) => {
    motionRequests.push({path, method: "POST", body});
    return path === "/api/analysis/assess" ? motionCapacity : {};
  },
};
window.addEventListener("spyder:vision-lab-ready", () => spyderVisionLab.mount(document.getElementById("workspace-content")));
