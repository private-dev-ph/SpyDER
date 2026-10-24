const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
function harness(definitions = []) {
  const storage = new Map([
    ["spyder.workflow.subflows.v1", JSON.stringify(definitions)],
  ]);
  const context = {
    window: { spyderShowcase: true },
    TextEncoder,
    URLSearchParams,
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
    },
    fetch: () => {
      throw Error("Unexpected network request");
    },
  };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, "../src/spyder_cctv/assets/workflow-tools.js"),
      "utf8",
    ),
    context,
  );
  context.window.spyderWorkflowTools.mount({
    validateGraph: (graph) =>
      require("../src/spyder_cctv/assets/workflow-editor.js").decodeWorkflow(
        JSON.stringify(graph),
      ),
  });
  return { tools: context.window.spyderWorkflowTools, storage };
}
function definition(version = 1) {
  const { tools } = harness();
  return {
    id: "reusable",
    name: "Reusable",
    description: "A reusable branch",
    version,
    graph: tools.createSubflowDraft("confidence"),
    parameters: [],
  };
}
test("library pagination searches and sorts 500 definitions without changing source order", () => {
  const { tools } = harness();
  const entries = Array.from({ length: 500 }, (_, index) => ({
    id: String(index),
    name: "Branch " + String(index).padStart(3, "0"),
    description: index % 2 ? "faces" : "motion",
    version: (index % 10) + 1,
  }));
  const result = tools.libraryPage(entries, { query: "motion", page: 999 });
  assert.equal(result.total, 250);
  assert.equal(result.rows.length, 2);
  assert.equal(result.page, 31);
  assert.equal(tools.libraryPage(entries, { query: "missing" }).pages, 1);
  assert.equal(
    tools.libraryPage(entries, { sort: "name-desc" }).rows[0].name,
    "Branch 499",
  );
  assert.equal(entries[0].name, "Branch 000");
});
test("starter branches have connected input/output and stay disabled with no cameras", () => {
  const { tools } = harness();
  for (const kind of ["blank", "confidence", "event"]) {
    const graph = tools.createSubflowDraft(kind);
    assert.equal(graph.enabled, false);
    assert.equal(graph.camera_ids.length, 0);
    assert.equal(graph.nodes[0].type, "subflow_input");
    assert.equal(graph.nodes.at(-1).type, "subflow_output");
    assert.equal(graph.edges.length, graph.nodes.length - 1);
    for (let index = 0; index < graph.edges.length; index++) {
      assert.equal(graph.edges[index].from, graph.nodes[index].id);
      assert.equal(graph.edges[index].to, graph.nodes[index + 1].id);
    }
  }
});
test("demo exports exact pinned versions after newer releases and resolves nested dependencies", async () => {
  const old = definition(1),
    latest = definition(2),
    parent = { ...definition(1), id: "parent" };
  parent.graph.nodes.splice(1, 0, {
    id: "nested",
    type: "subflow",
    x: 300,
    y: 140,
    params: { subflow_id: "reusable", version: 1, arguments: {} },
  });
  parent.graph.edges = [
    { from: "input", to: "nested" },
    { from: "nested", to: "filter" },
    { from: "filter", to: "cooldown" },
    { from: "cooldown", to: "output" },
  ];
  const { tools } = harness([old, latest, parent]);
  const bundle = await tools.exportBundle({
    nodes: [{ type: "subflow", params: { subflow_id: "parent", version: 1 } }],
  });
  assert.equal(bundle.subflows.length, 2);
  assert.equal(
    bundle.subflows.find((item) => item.id === "reusable").version,
    1,
  );
  assert.equal(
    (await tools.listSubflows()).find((item) => item.id === "reusable").version,
    2,
  );
});
test("demo import rejects disconnected bridges and invalid parameter mappings atomically", async () => {
  const original = definition(),
    { tools, storage } = harness([original]);
  const malformed = { ...definition(), id: "broken" };
  malformed.graph.edges = [];
  const bundle = {
    format: "spyder-workflow-bundle",
    version: 1,
    workflow: {
      id: "root",
      name: "Root",
      enabled: false,
      camera_ids: [],
      nodes: [],
      edges: [],
    },
    subflows: [malformed],
  };
  const before = storage.get("spyder.workflow.subflows.v1");
  await assert.rejects(
    tools.importBundle(JSON.stringify(bundle)),
    /Connect every/,
  );
  assert.equal(storage.get("spyder.workflow.subflows.v1"), before);
  malformed.graph = definition().graph;
  malformed.parameters = [
    {
      name: "invalid",
      type: "number",
      default: 1,
      node_id: "input",
      field: "version",
    },
  ];
  await assert.rejects(
    tools.importBundle(JSON.stringify(bundle)),
    /Exposed settings/,
  );
  assert.equal(storage.get("spyder.workflow.subflows.v1"), before);
});
test("demo import enforces library budget and preserves every older version", async () => {
  const { tools, storage } = harness([definition(1)]);
  const bundle = {
    format: "spyder-workflow-bundle",
    version: 1,
    workflow: {
      id: "root",
      name: "Root",
      enabled: false,
      camera_ids: [],
      nodes: [],
      edges: [],
    },
    subflows: [definition(2)],
  };
  await tools.importBundle(JSON.stringify(bundle));
  assert.equal(
    JSON.parse(storage.get("spyder.workflow.subflows.v1")).length,
    2,
  );
  const large = definition(3);
  large.graph.nodes[1].params.large = "x".repeat(8 * 1024 * 1024);
  bundle.subflows = [large];
  await assert.rejects(tools.importBundle(JSON.stringify(bundle)), /MiB/);
  assert.equal(
    JSON.parse(storage.get("spyder.workflow.subflows.v1")).length,
    2,
  );
});

test("demo rejects malformed node schemas before modifying browser storage", async () => {
  const { tools, storage } = harness([definition()]);
  const invalid = definition(2);
  invalid.graph.nodes[1].type = "not-a-real-node";
  const bundle = {
    format: "spyder-workflow-bundle",
    version: 1,
    workflow: {
      id: "root",
      name: "Root",
      enabled: false,
      camera_ids: [],
      nodes: [],
      edges: [],
    },
    subflows: [invalid],
  };
  await assert.rejects(
    tools.importBundle(JSON.stringify(bundle)),
    /Invalid workflow node/,
  );
  assert.equal(
    JSON.parse(storage.get("spyder.workflow.subflows.v1")).length,
    1,
  );
});

test("three-level demonstration imports and exports all pinned dependencies in the static demo", async () => {
  const bundle = JSON.parse(
    fs.readFileSync(
      path.join(
        __dirname,
        "../examples/workflows/three-level-nested-subflows.json",
      ),
      "utf8",
    ),
  );
  const { tools } = harness();
  const graph = await tools.importBundle(JSON.stringify(bundle));
  assert.equal(graph.enabled, false);
  assert.equal((await tools.listSubflows()).length, 3);
  const exported = await tools.exportBundle(graph);
  assert.equal(exported.subflows.length, 3);
  assert.ok(exported.subflows.every((item) => item.version === 1));
});
