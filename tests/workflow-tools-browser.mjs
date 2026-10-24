// Subflow authoring and history UI regression. Run: node tests/workflow-tools-browser.mjs <showcase-dir>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const assets = path.resolve(process.argv[2]);
const nestedDemoBundle = await readFile(
  new URL(
    "../examples/workflows/three-level-nested-subflows.json",
    import.meta.url,
  ),
  "utf8",
);
const headers = await readFile(path.join(assets, "_headers"), "utf8");
const policy = headers
  .split("\n")
  .find((line) => line.trim().startsWith("Content-Security-Policy:"))
  ?.trim()
  .slice("Content-Security-Policy:".length)
  .trim();
assert.ok(policy, "Export needs a content security policy");
const networkPaths = [];
const profile = await mkdtemp(
  path.join(os.tmpdir(), "spyder-workflow-tools-browser-"),
);
const server = http.createServer(async (req, res) => {
  networkPaths.push(req.url);
  const name =
    new URL(req.url, "http://localhost").pathname.slice(1) || "index.html";
  if (!/^[\w.-]+$/.test(name)) return res.writeHead(404).end();
  try {
    const body = await readFile(path.join(assets, name));
    const mime = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".png": "image/png",
    };
    res.setHeader("Content-Security-Policy", policy);
    res.setHeader(
      "Content-Type",
      mime[path.extname(name)] || "application/octet-stream",
    );
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
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
  { windowsHide: true, stdio: "ignore" },
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
    const message = JSON.parse(data);
    if (!message.id) return;
    const result = pending.get(message.id);
    if (!result) return;
    pending.delete(message.id);
    clearTimeout(result.timer);
    if (message.error) result.reject(new Error(JSON.stringify(message.error)));
    else result.resolve(message.result);
  };
  function command(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(
            `Timed out: ${method} ${(params.expression || "").slice(0, 180)}`,
          ),
        );
      }, 30000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  const { targetId } = await command("Target.createTarget", {
    url: `http://127.0.0.1:${server.address().port}/#control-room`,
  });
  const { sessionId } = await command("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  async function evaluate(expression) {
    const result = await command(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }

  async function until(expression, attempts = 100) {
    for (let i = 0; i < attempts; i++) {
      if (await evaluate(expression)) return;
      await delay(100);
    }
    const state = await evaluate(
      "({ready:document.readyState,workflow:!!window.spyderWorkflows,app:!!window.spyder,cameras:window.spyder?.cameras?.().length,issues:document.querySelector('.we-issues')?.textContent,text:document.body.innerText.slice(0,500)})",
    );
    throw new Error(
      "Timed out: " +
        expression +
        "; state=" +
        JSON.stringify(state) +
        "; requests=" +
        JSON.stringify(networkPaths),
    );
  }
  const click = (text) =>
    evaluate(
      `(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)});if(!b)throw new Error('Missing button');b.click();})()`,
    );
  const change = (id, value) =>
    evaluate(
      `(() => {const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
  const visible = () =>
    evaluate(
      "[...document.querySelectorAll('#cameras > .camera-card:not([hidden])')].map(c=>c.dataset.id)",
    );
  await command(
    "Emulation.setDeviceMetricsOverride",
    { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  await until("!!window.spyderWorkflows && spyder.cameras().length===2", 300);
  await evaluate(
    "window.templateErrors=[];window.addEventListener('error',e=>templateErrors.push(e.message));navigator.mediaDevices.getUserMedia=()=>{throw new Error('Unexpected camera access')};location.hash='vision-lab'",
  );
  await until("!!document.querySelector('#vision-workflow-tab')");
  await evaluate("document.querySelector('#vision-workflow-tab').click()");
  await until("!!document.querySelector('[data-open-templates]')");

  await evaluate(
    "window.confirm=()=>true;window.workflowToolErrors=[];window.addEventListener('error',e=>workflowToolErrors.push(e.message));document.querySelector('[data-name]').value='Saved parent';document.querySelector('[data-name]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-save]').click()",
  );
  await until(
    "document.querySelector('[data-workflow-count]').textContent.includes('1 saved')",
  );
  await evaluate(
    "document.querySelector('[data-open-workflow-manager]').click()",
  );
  await until(
    "!!document.querySelector('.workflow-manager[open] [data-create-callable]')",
  );
  await evaluate("document.querySelector('[data-create-callable]').click()");
  await until(
    "document.querySelector('[data-workflow-mode]').value==='callable'",
  );
  assert.equal(
    await evaluate("document.querySelector('[data-activate]').disabled"),
    true,
  );
  await evaluate(`(()=>{
    document.querySelector('[data-add=filter]').click();
    const input=document.querySelector('.we-node-subflow_input').dataset.node,output=document.querySelector('.we-node-subflow_output').dataset.node,filter=document.querySelector('.we-node-filter').dataset.node;
    document.querySelector('.we-inspector [data-delete-edge="'+input+'|'+output+'"]').click();
    for(const [from,to] of [[input,filter],[filter,output]]){document.querySelector('[data-from]').value=from;document.querySelector('[data-to]').value=to;document.querySelector('[data-connect]').click();}
    document.querySelector('[data-name]').value='Unified reusable';document.querySelector('[data-name]').dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('[data-publish-subflow]').click();
  })()`);
  await until("!!document.querySelector('[data-pub-submit]')");
  await evaluate(
    `(()=>{const row=[...document.querySelectorAll('.wt-parameter-row')].find(row=>row.textContent.includes('filter · confidence'));row.querySelector('[data-pub-param]').checked=true;row.querySelector('[data-pub-param-name]').value='minConfidence';document.querySelector('[data-pub-submit]').click()})()`,
  );
  await until(
    "JSON.parse(localStorage.getItem('spyder.workflow.subflows.v1')||'[]').length===1",
  );
  const identifier = await evaluate(
    "JSON.parse(localStorage.getItem('spyder.workflow.subflows.v1'))[0].id",
  );
  await evaluate(
    "document.querySelector('[data-wt-close]').click();document.querySelector('[data-open-workflow-manager]').click()",
  );
  await until("document.querySelectorAll('.wm-row').length===2");
  assert.ok(
    await evaluate(
      `document.querySelector('.wm-row[data-id="${identifier}"]').textContent.includes('Callable only')`,
    ),
  );
  assert.equal(
    await evaluate(
      `document.querySelector('.wm-row[data-id="${identifier}"] [data-action=toggle]')`,
    ),
    null,
  );
  await evaluate(
    "[...document.querySelectorAll('.wm-row')].find(row=>row.textContent.includes('Saved parent')).querySelector('[data-action=open]').click()",
  );
  await until("document.querySelector('[data-name]').value==='Saved parent'");
  await evaluate("document.querySelector('[data-open-subflows]').click()");
  await until("!!document.querySelector('.workflow-manager[open]')");
  assert.equal(
    await evaluate(
      "document.querySelector('.workflow-manager [name=mode]').value",
    ),
    "callable",
  );
  await until("document.querySelectorAll('.wm-row').length===1");
  await evaluate("document.querySelector('[data-action=call]').click()");
  await until("!!document.querySelector('[data-subflow-arg=minConfidence]')");
  assert.equal(
    await evaluate(
      "Number(document.querySelector('[data-subflow-arg=minConfidence]').value)",
    ),
    0.5,
  );
  await evaluate(
    "const field=document.querySelector('[data-subflow-arg=minConfidence]');field.value='.85';field.dispatchEvent(new Event('change',{bubbles:true}))",
  );
  assert.ok(
    await evaluate(
      "document.querySelector('[data-subflow-inheritance]').textContent.includes('Override')",
    ),
  );
  await evaluate(
    "document.querySelector('[data-reset-subflow-arg=minConfidence]').click()",
  );
  assert.equal(
    await evaluate(
      "Number(document.querySelector('[data-subflow-arg=minConfidence]').value)",
    ),
    0.5,
  );
  await evaluate(
    "document.querySelector('[data-open-subflow-definition]').click()",
  );
  await until(
    "document.querySelector('[data-name]').value==='Unified reusable'",
  );
  assert.equal(
    await evaluate("document.querySelector('[data-save]').disabled"),
    false,
  );
  await evaluate(
    "const mode=document.querySelector('[data-workflow-mode]');mode.value='both';mode.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-publish-subflow]').click()",
  );
  await until("!!document.querySelector('[data-pub-submit]')");
  await evaluate(
    "document.querySelector('[data-pub-name]').value='Unified reusable renamed';document.querySelector('[data-pub-submit]').click()",
  );
  await until(
    "JSON.parse(localStorage.getItem('spyder.workflow.subflows.v1')).length===2",
  );
  assert.equal(
    await evaluate(
      "new Set(JSON.parse(localStorage.getItem('spyder.workflow.subflows.v1')).map(item=>item.id)).size",
    ),
    1,
  );
  await evaluate(
    "document.querySelector('[data-wt-close]').click();document.querySelector('[data-subflow-back]').click()",
  );
  assert.equal(
    await evaluate("document.querySelector('[data-name]').value"),
    "Saved parent",
  );
  await evaluate(
    "document.querySelector('.we-node-subflow').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))",
  );
  assert.equal(
    await evaluate("document.querySelector('[data-subflow-version]').value"),
    "1",
  );
  await evaluate(
    "document.querySelector('[data-close-settings]').click();document.querySelector('[data-save]').click()",
  );
  await until(
    "document.querySelector('.we-issues').textContent.includes('saved')",
  );
  const exported = await evaluate(
    "spyderWorkflowTools.exportBundle(JSON.parse(localStorage.getItem('spyder.workflow-editor.draft')))",
  );
  assert.equal(exported.subflows[0].version, 1);
  await evaluate(
    "document.querySelector('[data-open-workflow-manager]').click()",
  );
  await until("document.querySelectorAll('.wm-row').length===2");
  assert.ok(
    await evaluate(
      `document.querySelector('.wm-row[data-id="${identifier}"]').textContent.includes('Independent + callable')`,
    ),
  );
  assert.ok(
    await evaluate(
      `document.querySelector('.wm-row[data-id="${identifier}"]').textContent.includes('1 callers')`,
    ),
  );
  await evaluate("document.querySelector('.wm-close').click()");
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 700 },
    { width: 1100, height: 450 },
  ]) {
    await command(
      "Emulation.setDeviceMetricsOverride",
      { ...viewport, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
    for (const theme of ["light", "dark"]) {
      await evaluate(
        `document.documentElement.dataset.theme=${JSON.stringify(theme)};document.querySelector('[data-open-workflow-manager]').click()`,
      );
      await until("document.querySelectorAll('.wm-row').length===2");
      const fits = await evaluate(
        "(()=>{const dialog=document.querySelector('.workflow-manager'),r=dialog.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1&&dialog.scrollWidth<=dialog.clientWidth+1})()",
      );
      assert.ok(fits, `${viewport.width}/${theme}: unified manager fits`);
      await command(
        "Page.captureScreenshot",
        { format: "png", captureBeyondViewport: false },
        sessionId,
      ).then((shot) =>
        writeFile(
          path.join(assets, `unified-manager-${viewport.width}-${theme}.png`),
          Buffer.from(shot.data, "base64"),
        ),
      );
      await evaluate("document.querySelector('.wm-close').click()");
    }
  }
  await evaluate(
    "document.querySelector('[data-open-workflow-manager]').click()",
  );
  await until("!!document.querySelector('.workflow-manager[open]')");
  await evaluate("document.querySelector('[data-create]').click()");
  await until("document.querySelector('[data-name]').value==='New workflow'");
  await evaluate(`(()=>{
    for(const type of ['camera','detections','filter','event']) document.querySelector('[data-add='+type+']').click();
    const ids=Object.fromEntries(['camera','detections','filter','event'].map(type=>[type,document.querySelector('.we-node-'+type).dataset.node]));
    for(const [from,to] of [[ids.camera,ids.detections],[ids.detections,ids.filter],[ids.filter,ids.event]]){document.querySelector('[data-from]').value=from;document.querySelector('[data-to]').value=to;document.querySelector('[data-connect]').click();}
    const mode=document.querySelector('[data-workflow-mode]');mode.value='both';mode.dispatchEvent(new Event('change',{bubbles:true}));
    document.querySelector('[data-prepare-callable]').click();
    document.querySelector('[data-name]').value='Converted ordinary workflow';document.querySelector('[data-name]').dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('[data-publish-subflow]').click();
  })()`);
  await until("!!document.querySelector('[data-pub-submit]')");
  await evaluate("document.querySelector('[data-pub-submit]').click()");
  await until(
    "JSON.parse(localStorage.getItem('spyder.workflow.subflows.v1')).length===3",
  );
  const converted = await evaluate(
    "JSON.parse(localStorage.getItem('spyder.workflow.subflows.v1')).at(-1)",
  );
  assert.deepEqual(converted.graph.nodes.map((node) => node.type).sort(), [
    "event",
    "filter",
    "subflow_input",
    "subflow_output",
  ]);
  assert.equal(converted.graph.execution, undefined);
  await evaluate("document.querySelector('[data-wt-close]').click()");
  assert.equal(
    await evaluate("document.querySelectorAll('.we-node-camera').length"),
    1,
    "independent camera trigger remains in editable workflow",
  );
  await evaluate(
    "(()=>{const mode=document.querySelector('[data-workflow-mode]');mode.value='independent';mode.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-save]').click()})()",
  );
  await until(
    "document.querySelector('.we-issues').textContent.includes('saved')",
  );
  const eligible = await evaluate("spyderWorkflowTools.listSubflows()");
  assert.equal(
    eligible.some((item) => item.id === converted.id),
    false,
    "turning off call permission hides historical versions from new call choices",
  );
  assert.equal(
    await evaluate(
      `(async()=>{await spyderWorkflowStore.migrateCallables();return (await spyderWorkflowStore.get(${JSON.stringify(converted.id)})).execution.allow_calls})()`,
    ),
    false,
    "migration preserves an intentionally independent workflow with published history",
  );

  await evaluate(
    `(()=>{const picker=document.querySelector('[data-import-file]'),files=new DataTransfer();files.items.add(new File([${JSON.stringify(nestedDemoBundle)}],'three-level-nested-subflows.json',{type:'application/json'}));Object.defineProperty(picker,'files',{configurable:true,value:files.files});picker.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await until(
    "document.querySelector('[data-name]').value==='DEMO · Three-level nested face event'",
  );
  for (const name of [
    "DEMO · Level 1 · Face gate",
    "DEMO · Level 2 · Minimum count",
    "DEMO · Level 3 · Cooldown",
  ]) {
    await evaluate(
      "document.querySelector('.we-node-subflow').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))",
    );
    await until("!!document.querySelector('[data-open-subflow-definition]')");
    await evaluate(
      "document.querySelector('[data-open-subflow-definition]').click()",
    );
    await until(
      `document.querySelector('[data-name]').value===${JSON.stringify(name)}`,
    );
    assert.equal(
      await evaluate("document.querySelector('[data-workflow-mode]').value"),
      "callable",
    );
  }
  assert.equal(
    await evaluate("document.querySelectorAll('.we-node-cooldown').length"),
    1,
  );
  for (const name of [
    "DEMO · Level 2 · Minimum count",
    "DEMO · Level 1 · Face gate",
    "DEMO · Three-level nested face event",
  ]) {
    await evaluate("document.querySelector('[data-subflow-back]').click()");
    assert.equal(
      await evaluate("document.querySelector('[data-name]').value"),
      name,
    );
  }
  assert.deepEqual(await evaluate("workflowToolErrors"), []);
  assert.equal(
    networkPaths.some((url) => url.startsWith("/api/")),
    false,
  );
  console.log(
    "PASS: one manager for independent/callable/both workflows, creation/publish/call/version pins, draft defaults, dependency migration, three-level nested editing, responsive themes, no API requests or runtime errors",
  );
} finally {
  socket?.close();
  chrome.kill();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await delay(200);
  assert.equal(path.dirname(path.resolve(profile)), path.resolve(os.tmpdir()));
  assert.ok(
    path.basename(profile).startsWith("spyder-workflow-tools-browser-"),
  );
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
