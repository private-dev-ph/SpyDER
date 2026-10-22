// Real-browser regression. Run: node tests/workflow-manager-browser.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/spyder_cctv/assets",
);
const profile = await mkdtemp(
  path.join(os.tmpdir(), "spyder-workflow-manager-"),
);
const html = `<!doctype html><script src="/workflow-manager.js"></script><script src="/workflow-store.js"></script>`;
const server = http.createServer(async (req, res) => {
  const name = new URL(req.url, "http://localhost").pathname;
  if (name === "/")
    return res.writeHead(200, { "Content-Type": "text/html" }).end(html);
  const asset = name.slice(1);
  if (
    ![
      "workflow-manager.js",
      "workflow-manager.css",
      "workflow-store.js",
    ].includes(asset)
  )
    return res.writeHead(404).end();
  res
    .writeHead(200, {
      "Content-Type": asset.endsWith(".js") ? "text/javascript" : "text/css",
    })
    .end(await readFile(path.join(root, asset)));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const chrome = spawn(
  process.env.CHROME_PATH ||
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--disable-background-networking",
    "about:blank",
  ],
  { windowsHide: true, stdio: ["ignore", "ignore", "inherit"] },
);
let socket;
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try {
      port = (
        await readFile(path.join(profile, "DevToolsActivePort"), "utf8")
      ).split("\n")[0];
      break;
    } catch {
      await delay(100);
    }
  }
  assert.ok(port, "Chrome debugging endpoint did not start");
  const info = await (
    await fetch(`http://127.0.0.1:${port}/json/version`)
  ).json();
  socket = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let serial = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (!msg.id) return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    msg.error
      ? p.reject(Error(JSON.stringify(msg.error)))
      : p.resolve(msg.result);
  };
  function command(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(`Timed out: ${method}`));
      }, 20000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  const { targetId } = await command("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId } = await command("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await command("Page.enable", {}, sessionId);
  await command("Runtime.enable", {}, sessionId);
  await command(
    "Page.navigate",
    { url: `http://127.0.0.1:${server.address().port}/` },
    sessionId,
  );
  async function evaluate(expression) {
    const result = await command(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (result.exceptionDetails) throw Error(result.exceptionDetails.text);
    return result.result.value;
  }
  const wait = async (condition) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(condition)) return;
      await delay(30);
    }
    assert.fail(`Timed out waiting for ${condition}`);
  };
  await wait("typeof spyderWorkflowStore === 'object'");
  const result = await evaluate(`(async()=>{
    const store=spyderWorkflowStore;
    const graph={id:'front',name:'Front door',enabled:true,camera_ids:['front'],nodes:[{id:'detector',type:'detections',params:{engine:'insightface'}}],edges:[]};
    await store.save(graph);
    const saved=await store.get('front');
    const page=await store.page({query:'front',size:25});
    await store.save({...graph,name:'Renamed'});
    const renamed=await store.page({query:'Renamed'});
    try{await store.save({...graph,name:' '.repeat(129)})}catch{}
    const retained=await store.get('front');
    await store.save({...graph,id:'second',name:'Second'});
    await store.remove('front');
    const removed=await store.get('front');
    const counts=(await store.page({})).counts;
    const abort=new AbortController();abort.abort();let aborted=false;
    try{await store.get('second',{signal:abort.signal})}catch(e){aborted=e.name==='AbortError'}
    return{saved,page,renamed,retained,removed:removed||null,counts,aborted};
  })()`);
  assert.equal(result.saved.enabled, false);
  assert.equal(result.page.total, 1);
  assert.equal(result.page.items[0].nodes, undefined);
  assert.deepEqual(result.page.counts, { total: 1, enabled: 0, disabled: 1 });
  assert.equal(result.renamed.items[0].name, "Renamed");
  assert.equal(result.retained.name, "Renamed");
  assert.equal(result.removed, null);
  assert.deepEqual(result.counts, { total: 1, enabled: 0, disabled: 1 });
  assert.equal(result.aborted, true);
  await command("Page.reload", {}, sessionId);
  await wait("typeof spyderWorkflowStore === 'object'");
  assert.equal(
    await evaluate("spyderWorkflowStore.get('second').then(g=>g.name)"),
    "Second",
  );
  const capacity = await evaluate(`(async()=>{
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('spyder-workflow-library',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
    await new Promise((resolve,reject)=>{const tx=db.transaction(['graphs','summaries','meta'],'readwrite');for(let i=0;i<4999;i++){const g={id:'bulk-'+i,name:'Workflow '+String(i).padStart(4,'0'),enabled:false,camera_ids:[],nodes:[],edges:[]};tx.objectStore('graphs').put(g);tx.objectStore('summaries').put({...spyderWorkflowManager.summarizeWorkflow(g),stored_bytes:100});}tx.objectStore('meta').put({count:5000,bytes:500000},'usage');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});
    let rejected=false;try{await spyderWorkflowStore.save({id:'overflow',name:'Overflow',nodes:[],edges:[]})}catch{rejected=true}
    const page=await spyderWorkflowStore.page({page:100,size:50});
    db.close();return{rejected,page,count:page.counts.total,missing:!(await spyderWorkflowStore.get('overflow'))};
  })()`);
  assert.equal(capacity.rejected, true);
  assert.equal(capacity.missing, true);
  assert.equal(capacity.count, 5000);
  assert.equal(capacity.page.items.length, 50);
  console.log(
    "Workflow IndexedDB checks passed: persistence, summaries, disabled demo graphs, rollback, cancellation, 5000 entries.",
  );
} finally {
  socket?.close();
  chrome.kill();
  await Promise.race([once(chrome, "exit").catch(() => {}), delay(2000)]);
  server.close();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(profile, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
      break;
    } catch {
      await delay(150);
    }
  }
}
