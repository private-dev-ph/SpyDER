// Subflow authoring and history UI regression. Run: node tests/workflow-tools-browser.mjs <showcase-dir>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const assets = path.resolve(process.argv[2]);
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
      "({ready:document.readyState,workflow:!!window.spyderWorkflows,app:!!window.spyder,cameras:window.spyder?.cameras?.().length,text:document.body.innerText.slice(0,500)})",
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
    "window.confirm=()=>true;window.workflowToolErrors=[];window.addEventListener('error',e=>workflowToolErrors.push(e.message));document.querySelector('[data-name]').value='Unfinished parent';document.querySelector('[data-name]').dispatchEvent(new Event('input',{bubbles:true}));",
  );
  await evaluate("document.querySelector('[data-open-subflows]').click()");
  await until("!!document.querySelector('[data-wt-new]')");
  await evaluate("document.querySelector('[data-wt-new]').click()");
  await until("!!document.querySelector('[data-subflow-back]')");
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.we-node-subflow_input').length",
    ),
    1,
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.we-node-subflow_output').length",
    ),
    1,
  );
  await evaluate(`(() => {
    document.querySelector('[data-add=filter]').click();
    const input=document.querySelector('.we-node-subflow_input').dataset.node,
      output=document.querySelector('.we-node-subflow_output').dataset.node,
      filter=document.querySelector('.we-node-filter').dataset.node;
    document.querySelector('.we-inspector [data-delete-edge="'+input+'|'+output+'"]').click();
    for(const [from,to] of [[input,filter],[filter,output]]) {
      document.querySelector('[data-from]').value=from;
      document.querySelector('[data-to]').value=to;
      document.querySelector('[data-connect]').click();
    }
  })()`);
  await evaluate("document.querySelector('[data-publish-subflow]').click()");
  await until("!!document.querySelector('[data-pub-submit]')");
  await evaluate(`(() => {
    const row=[...document.querySelectorAll('.wt-parameter-row')].find(r=>r.textContent.includes('filter · confidence'));
    if(!row) throw new Error('Confidence parameter missing');
    row.querySelector('[data-pub-param]').checked=true;
    row.querySelector('[data-pub-param-name]').value='minConfidence';
  })()`);

  await evaluate(
    "document.querySelector('[data-pub-name]').value='Reusable passthrough';document.querySelector('[data-pub-description]').value='A reusable test';document.querySelector('[data-pub-submit]').click()",
  );
  await until(
    "JSON.parse(localStorage.getItem('spyder.workflow.subflows.v1')||'[]').length===1",
  );
  await evaluate(
    "document.querySelector('[data-wt-close]').click();document.querySelector('[data-subflow-back]').click()",
  );
  assert.equal(
    await evaluate("document.querySelector('[data-name]').value"),
    "Unfinished parent",
  );
  assert.equal(
    await evaluate("!!document.querySelector('[data-add=subflow_input]')"),
    false,
  );
  await evaluate("document.querySelector('[data-open-subflows]').click()");
  await until("!!document.querySelector('[data-wt-insert]')");
  await evaluate("document.querySelector('[data-wt-insert]').click()");
  await until("!!document.querySelector('[data-subflow-id]')");
  const identifier = await evaluate(
    "JSON.parse(localStorage.getItem('spyder.workflow.subflows.v1'))[0].id",
  );
  await evaluate(
    `const select=document.querySelector('[data-subflow-id]');select.value=${JSON.stringify(identifier)};select.dispatchEvent(new Event('change',{bubbles:true}));`,
  );
  await until("!!document.querySelector('[data-subflow-version]')");
  assert.equal(
    await evaluate("document.querySelector('[data-subflow-version]').value"),
    "1",
  );
  await until("!!document.querySelector('[data-subflow-arg=minConfidence]')");
  await evaluate(
    "const a=document.querySelector('[data-subflow-arg=minConfidence]');a.value='.85';a.dispatchEvent(new Event('change',{bubbles:true}))",
  );
  await evaluate(
    "document.querySelector('[data-open-subflow-definition]').click()",
  );
  await until("!!document.querySelector('[data-subflow-back]')");
  await evaluate("document.querySelector('[data-subflow-back]').click()");
  assert.equal(
    await evaluate("document.querySelector('[data-name]').value"),
    "Unfinished parent",
  );
  await evaluate(
    "document.querySelector('.we-node-subflow').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))",
  );
  await until("!!document.querySelector('[data-subflow-arg=minConfidence]')");
  assert.equal(
    await evaluate(
      "Number(document.querySelector('[data-subflow-arg=minConfidence]').value)",
    ),
    0.85,
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
  assert.ok(
    await evaluate(
      "document.querySelector('[data-subflow-inheritance]').textContent.includes('Inherited')",
    ),
  );
  await evaluate(
    "document.querySelector('[data-open-subflow-definition]').click()",
  );
  await until("!!document.querySelector('[data-publish-subflow]')");
  await evaluate("document.querySelector('[data-publish-subflow]').click()");
  await until("!!document.querySelector('[data-pub-name]')");
  await evaluate(
    "document.querySelector('[data-pub-name]').value='Renamed reusable branch';document.querySelector('[data-pub-submit]').click()",
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
  await evaluate(
    "document.querySelector('.we-node-subflow').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))",
  );
  assert.equal(
    await evaluate("document.querySelector('[data-subflow-version]').value"),
    "1",
  );
  const exported = await evaluate(
    "spyderWorkflowTools.exportBundle(JSON.parse(localStorage.getItem('spyder.workflow-editor.draft')))",
  );
  assert.equal(exported.subflows.length, 1);
  assert.equal(exported.subflows[0].version, 1);
  await evaluate("document.querySelector('[data-close-settings]').click()");
  await evaluate(`(async()=>{
    const graph=JSON.parse(localStorage.getItem('spyder.workflow-editor.draft'));
    await spyderWorkflowStore.save({...graph,id:'protected-subflow-test',name:'Protected reusable branch'});
    window.hasSavedReference=await spyderWorkflowStore.referencesSubflow(${JSON.stringify(identifier)});
    window.originalSubflows=JSON.parse(localStorage.getItem('spyder.workflow.subflows.v1'));
    const source=originalSubflows[0];
    const extra=Array.from({length:55},(_,index)=>({...structuredClone(source),id:'subflow-fixture-'+index,name:'Fixture '+String(index).padStart(3,'0')}));
    localStorage.setItem('spyder.workflow.subflows.v1',JSON.stringify([...originalSubflows,...extra]));
    document.querySelector('[data-open-subflows]').click();
  })()`);
  assert.ok(await evaluate("window.hasSavedReference"));
  await until("document.querySelectorAll('.wt-subflow-row').length===8");
  assert.ok(
    await evaluate(
      "document.querySelector('[data-wt-page]').textContent.includes('56 subflows')",
    ),
  );
  await evaluate("document.querySelector('[data-wt-next]').click()");
  assert.ok(
    await evaluate(
      "document.querySelector('[data-wt-page]').textContent.includes('Page 2')",
    ),
  );
  await evaluate(
    "const search=document.querySelector('[data-wt-search]');search.value='Fixture 054';search.dispatchEvent(new Event('input',{bubbles:true}))",
  );
  assert.equal(
    await evaluate("document.querySelectorAll('.wt-subflow-row').length"),
    1,
  );
  await evaluate("document.querySelector('[data-wt-close]').click()");
  await evaluate(
    `spyderWorkflowTools.openDefinition(${JSON.stringify(identifier)},1)`,
  );
  await until("!!document.querySelector('[data-subflow-back]')");
  await evaluate("document.querySelector('[data-open-subflows]').click()");
  await until("!!document.querySelector('[data-wt-new]')");
  await evaluate("document.querySelector('[data-wt-new]').click()");
  assert.equal(
    await evaluate("document.querySelector('[data-subflow-back]').textContent"),
    "Return to parent subflow",
  );
  await evaluate("document.querySelector('[data-subflow-back]').click()");
  assert.equal(
    await evaluate("document.querySelector('[data-name]').value"),
    "Reusable passthrough",
  );
  await evaluate("document.querySelector('[data-publish-subflow]').click()");
  await until("!!document.querySelector('[data-pub-submit]')");
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('[data-pub-param-name]')].some(input=>input.value==='minConfidence')",
    ),
    true,
    "return from nested draft preserves exposed setting names",
  );
  await evaluate("document.querySelector('[data-wt-close]').click()");
  await evaluate(
    "document.querySelector('[data-name]').value='Unpublished test';document.querySelector('[data-name]').dispatchEvent(new Event('input',{bubbles:true}));window.confirm=()=>false;document.querySelector('[data-subflow-back]').click()",
  );
  assert.ok(await evaluate("!!document.querySelector('[data-subflow-back]')"));
  await evaluate(
    "window.confirm=()=>true;document.querySelector('[data-subflow-back]').click()",
  );
  assert.equal(
    await evaluate("document.querySelector('[data-name]').value"),
    "Unfinished parent",
  );
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
        `document.documentElement.dataset.theme=${JSON.stringify(theme)};document.querySelector('[data-open-history]').click()`,
      );
      await until("!!document.querySelector('.wt-history')");
      await until(
        "document.querySelector('.wt-history').textContent.includes('showcase')",
      );
      const result = await evaluate(
        `(() => {const dialog=document.querySelector('.wt-history'),r=dialog.getBoundingClientRect(), b=dialog.querySelector('[data-wt-close]').getBoundingClientRect(),i=dialog.querySelector('[data-wt-close] svg').getBoundingClientRect();return {fits:r.left>=-1&&r.right<=innerWidth+1&&r.top>=-1&&r.bottom<=innerHeight+1,iconCentered:Math.abs(b.x+b.width/2-i.x-i.width/2)<1&&Math.abs(b.y+b.height/2-i.y-i.height/2)<1};})()`,
      );
      assert.ok(
        result.fits && result.iconCentered,
        `${JSON.stringify(viewport)}/${theme}: history dialog layout`,
      );
      await evaluate(
        "document.querySelector('.wt-history [data-wt-close]').click()",
      );
      await evaluate("document.querySelector('[data-open-subflows]').click()");
      await until("!!document.querySelector('.wt-subflows')");
      const libraryFits = await evaluate(
        "(()=>{const d=document.querySelector('.wt-subflows'),r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1&&d.scrollWidth<=d.clientWidth+1})()",
      );
      assert.ok(
        libraryFits,
        `${JSON.stringify(viewport)}/${theme}: subflow library fits`,
      );
      await command(
        "Page.captureScreenshot",
        { format: "png", captureBeyondViewport: false },
        sessionId,
      ).then(async (shot) =>
        writeFile(
          path.join(assets, `subflow-library-${viewport.width}-${theme}.png`),
          Buffer.from(shot.data, "base64"),
        ),
      );
      await evaluate(
        "document.querySelector('.wt-subflows [data-wt-close]').click()",
      );
      await evaluate(
        `spyderWorkflowTools.openDefinition(${JSON.stringify(identifier)},1)`,
      );
      await until("!!document.querySelector('[data-publish-subflow]')");
      await evaluate(
        "document.querySelector('[data-publish-subflow]').click()",
      );
      await until("!!document.querySelector('.wt-publish')");
      assert.ok(
        await evaluate(
          "(()=>{const d=document.querySelector('.wt-publish'),r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1&&d.scrollWidth<=d.clientWidth+1})()",
        ),
        `${JSON.stringify(viewport)}/${theme}: publisher fits`,
      );
      await evaluate(
        "document.querySelector('.wt-publish').scrollTop=document.querySelector('.wt-publish').scrollHeight",
      );
      assert.ok(
        await evaluate(
          "(()=>{const d=document.querySelector('.wt-publish').getBoundingClientRect(),b=document.querySelector('[data-pub-submit]').getBoundingClientRect();return b.top>=d.top&&b.bottom<=d.bottom+1})()",
        ),
        "publish action remains reachable",
      );
      await evaluate(
        "document.querySelector('.wt-publish [data-wt-close]').click();document.querySelector('[data-subflow-back]').click()",
      );
    }
  }
  assert.deepEqual(await evaluate("workflowToolErrors"), []);
  assert.equal(
    networkPaths.some((url) => url.startsWith("/api/")),
    false,
  );
  console.log(
    "PASS: subflow library insertion/search/pagination, version pins/rename/export, inherited settings/reset, saved reference checks, nested draft restoration/discard guard, library/publisher/history responsive themes, zero API requests or runtime errors",
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
