const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  renderGraph,
  renderMedia,
} = require("../src/spyder_cctv/assets/workflow-run-view.js");

test("archived graph shows branches and node outcomes without injecting data", () => {
  const html = renderGraph({
    graph: {
      nodes: [
        { id: "a", type: "detections" },
        { id: "b", type: "filter" },
        { id: "c", type: "event<script>" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
      ],
    },
    nodes: [
      { id: "a", state: "completed", input_count: 2, output_count: 2 },
      { id: "b", state: "filtered", input_count: 2, output_count: 0 },
      { id: "c", state: "error", input_count: "<script>", output_count: 0 },
    ],
  });
  assert.equal((html.match(/class="wt-trace-node /g) || []).length, 3);
  assert.equal((html.match(/class="wt-trace-edge /g) || []).length, 2);
  assert.ok(html.includes("wt-trace-bad"));
  assert.ok(html.includes("wt-trace-quiet"));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("event&lt;script&gt;"));
});

test("archived graph remains bounded for oversized histories and broken edges", () => {
  const nodes = Array.from({ length: 300 }, (_, i) => ({
    id: String(i),
    type: "filter",
  }));
  const html = renderGraph({
    graph: { nodes, edges: [{ from: "missing", to: "0" }] },
    nodes: [],
  });
  assert.equal((html.match(/class="wt-trace-node /g) || []).length, 256);
  assert.ok(!html.includes('class="wt-trace-edge '));
  assert.equal(renderGraph({}), "");
});

test("media preview trusts catalog IDs rather than supplied URLs", () => {
  const id = "a".repeat(32);
  const video = renderMedia({
    id,
    kind: "recording",
    filename: "<unsafe>",
    url: "javascript:alert(1)",
  });
  assert.ok(video.includes('<video controls preload="none"'));
  assert.ok(video.includes(`/api/media/${id}`));
  assert.ok(!video.includes("javascript:"));
  assert.ok(!video.includes("<unsafe>"));
  assert.ok(
    renderMedia({ id, kind: "capture" }).includes('<img loading="lazy"'),
  );
  assert.equal(renderMedia({ id: "../bad", kind: "recording" }), "");
});
