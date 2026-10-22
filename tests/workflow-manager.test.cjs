const { test } = require("node:test");
const assert = require("node:assert/strict");
const { workflowPage, summarizeWorkflow } = require("../src/spyder_cctv/assets/workflow-manager.js");

function fixtures(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `workflow-${i}`, name: `Workflow ${i}`, enabled: i % 3 === 0,
    camera_ids: [`camera-${i % 8}`], engines: [i % 2 ? "yolo" : "insightface"],
    node_count: i % 64, edge_count: i % 128,
  }));
}

for (const count of [1000, 5000]) test(`workflow summary paging supports ${count} records`, () => {
  const source = fixtures(count), before = JSON.stringify(source);
  const result = workflowPage(source, { page: 999, size: 50, status: "enabled", camera: "camera-1", engine: "yolo", sort: "name_desc" });
  assert.equal(result.items.length, result.total % 50 || 50);
  assert.equal(result.page, result.pages);
  const page = workflowPage(source, { page: 1, size: 50 });
  assert.equal(page.items.length, 50);
  assert.equal(page.total, count);
  assert.equal(page.items[0].id, "workflow-0");
  assert.equal(JSON.stringify(source), before);
});

test("workflow filters combine query, status, camera and engine, then clamp page", () => {
  const result = workflowPage(fixtures(1000), { query: "workflow 9", status: "disabled", camera: "camera-1", engine: "yolo", size: 25, page: 80 });
  assert.ok(result.total > 0);
  assert.equal(result.page, result.pages);
  assert.ok(result.items.every((item) => !item.enabled && item.camera_ids.includes("camera-1") && item.engines.includes("yolo") && item.name.toLowerCase().includes("workflow 9")));
});

test("workflow metadata summary matches manager row schema", () => {
  assert.deepEqual(summarizeWorkflow({ id: "door", name: "Front door", enabled: true, camera_ids: ["front"], nodes: [{ type: "camera", params: { camera_id: "side" } }, { type: "detections", params: { engine: "yolo" } }, { type: "detections", params: { engine: "any" } }], edges: [{}, {}] }), {
    id: "door", name: "Front door", enabled: true, camera_ids: ["front", "side"], engines: ["yolo"], node_count: 3, edge_count: 2,
  });
});
