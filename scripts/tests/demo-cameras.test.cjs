const { test } = require("node:test");
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const api = require("../../src/spyder_cctv/assets/demo-cameras.js");
const dir = path.join(__dirname, "../../src/spyder_cctv/assets");
test("browser and installed catalogs match and contain eight verified licensed clips", () => {
  const json = JSON.parse(fs.readFileSync(path.join(dir, "demo-cameras.json")));
  assert.deepEqual(api.cameras, json.cameras);
  assert.equal(api.cameras.length, 8);
  for (const c of api.cameras) {
    assert.equal(api.find("demo://" + c.id), c);
    assert.match(c.filename, /^demo-[\w-]+\.mp4$/);
    const data = fs.readFileSync(path.join(dir, c.filename));
    assert.equal(
      crypto.createHash("sha256").update(data).digest("hex"),
      c.sha256,
    );
    assert.equal(c.license, "CC BY 3.0");
    assert.ok(c.author && c.context && c.changes);
  }
  for (const bad of [
    "demo://../private",
    "https://example.com/a.mp4",
    "file:///private",
    null,
    "demo://unknown",
  ])
    assert.equal(api.find(bad), undefined);
});
test("software camera tuning is neutral by default and bounds digital crop", () => {
  const t = api.tuning();
  assert.equal(t.zoom, 1);
  assert.equal(t.pan, 0.5);
  assert.equal(t.tilt, 0.5);
  assert.match(t.filter, /brightness\(1\) contrast\(1\) saturate\(1\)/);
  assert.equal(api.tuning({ zoom: 100, fov: 0 }).zoom, 4);
  assert.equal(api.tuning({ pan: 0 }).pan, 0);
  assert.equal(api.tuning({ tilt: 100 }).tilt, 1);
});
