const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  vm = require("node:vm"),
  fs = require("node:fs");
function harness() {
  let now = 0,
    deletes = 0,
    updates = 0,
    fail = false;
  class Mat {
    delete() {}
  }
  class TrackerMIL {
    init() {}
    update() {
      updates++;
      if (fail) throw Error("tracker lost");
      return [true, { x: 12, y: 13, width: 20, height: 25 }];
    }
    delete() {
      deletes++;
    }
  }
  const cv = {
    TrackerMIL,
    Mat,
    Rect: class {
      constructor(...box) {
        this.box = box;
      }
    },
    Size: class {},
    BackgroundSubtractorMOG2: Mat,
    connectedComponentsWithStats() {},
    getStructuringElement: () => new Mat(),
    cvtColor() {},
    HEAP8: new Uint8Array(8),
    getBuildInformation: () => "test",
  };
  const context = vm.createContext({
    self: { cv, postMessage() {} },
    importScripts() {},
    performance: { now: () => now },
  });
  vm.runInContext(
    fs.readFileSync(
      require.resolve("../src/spyder_cctv/assets/mog2-worker.js"),
      "utf8",
    ),
    context,
  );
  return {
    run: (code) => vm.runInContext(code, context),
    advance: (v) => (now += v),
    fail: () => (fail = true),
    get deletes() {
      return deletes;
    },
    get updates() {
      return updates;
    },
  };
}
test("worker enforces porch ownership and releases it on destruction", () => {
  const h = harness();
  assert.throws(
    () => h.run('create("bad",320,180,{tracking:true},1,"driveway")'),
    /restricted/,
  );
  h.run('create("porch",320,180,{tracking:true},1,"porch-parcel")');
  assert.throws(
    () => h.run('create("duplicate",320,180,{tracking:true},1,"porch-parcel")'),
    /Only one/,
  );
  h.run(
    'destroy("porch");create("duplicate",320,180,{tracking:true},1,"porch-parcel")',
  );
});
test("MIL tuple updates are capped, reset deletes tracker, and tracker failures stay isolated", () => {
  const h = harness();
  h.run(
    'globalThis.m=create("porch",320,180,{tracking:true},1,"porch-parcel");globalThis.regions=[{bbox:[10,10,20,25]}];updateTrack(m,regions,null,0)',
  );
  assert.equal(h.run("m.track.id"), 1);
  h.advance(100);
  h.run("updateTrack(m,regions,null,0)");
  assert.equal(h.updates, 0);
  h.advance(500);
  h.run("updateTrack(m,regions,null,0)");
  assert.equal(h.updates, 1);
  assert.equal(h.run("m.track.bbox[0]"), 12);
  h.advance(600);
  h.fail();
  assert.equal(h.run("updateTrack(m,regions,null,0).length"), 0);
  assert.equal(h.run("m.trackingState"), "error");
  assert.equal(h.deletes, 1);
  assert.equal(
    h.run('models.has("porch")'),
    true,
    "MOG2 model must remain available",
  );
  h.run(
    'destroy("porch");m=create("porch",320,180,{tracking:true},2,"porch-parcel");updateTrack(m,regions,null,0)',
  );
  assert.equal(h.run("m.track.id"), 2);
  h.run('destroy("porch")');
  assert.equal(h.deletes, 2);
});
