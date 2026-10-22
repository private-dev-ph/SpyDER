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
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/workflow-manager.css"><style>:root{--accent:#be1a1a;--focus:#830000;--danger:#bc0202;--control-border:#8c8274;--ink:#201d1a;--muted:#726d64;--border:#e4dfd4;--surface:#fffefa}*{box-sizing:border-box}body{font:14px Arial;margin:0;padding:12px;background:#f3f5f6}button{cursor:pointer}</style><button data-workflow id="open">Workflows</button><script src="/workflow-manager.js"></script><script>let dirty=false;window.calls=[];const summaries=Array.from({length:80},(_,i)=>({id:'wf-'+i,name:'Workflow '+i,enabled:i%2===0,camera_ids:['front'],engines:['yolo'],node_count:4,edge_count:3}));function launch(initialDelete=false){window.manager=spyderWorkflowManager.open({demo:!!window.demo,opener:document.querySelector('#open'),isDirty:()=>dirty,currentId:()=> 'wf-0',cameras:()=>[{id:'front',name:'Front door'}],engines:['yolo'],initialDelete:initialDelete?summaries[0]:undefined,loadPage:async(params,{signal})=>{window.loadCalls=(window.loadCalls||0)+1;const wait=params.query==='old'?500:10;await new Promise(r=>setTimeout(r,wait));if(signal.aborted)throw new DOMException('Aborted','AbortError');const filtered=summaries.filter(x=>x.name.toLowerCase().includes(params.query.toLowerCase()));const pages=Math.max(1,Math.ceil(filtered.length/params.size));const page=Math.min(params.page,pages);return{items:filtered.slice((page-1)*params.size,page*params.size),total:filtered.length,pages,page,size:params.size,counts:{total:summaries.length,enabled:summaries.filter(item=>item.enabled).length,disabled:summaries.filter(item=>!item.enabled).length}}},onToggle:async(id,enabled,confirm)=>{window.toggleCalls=(window.toggleCalls||0)+1;if(window.needMotion&&!await confirm({name:'Workflow',cameras:[{id:'front',name:'Front door',disable_motion:true,target_engine:'insightface'}]}))return false;await new Promise(resolve=>setTimeout(resolve,50));if(window.toggleFailure)throw Error('Model conflict');summaries.find(item=>item.id===id).enabled=enabled;return true},onOpen:async id=>{window.calls.push('open:'+id);return true},onCreate:async()=>{window.calls.push('create');return true},onDuplicate:async id=>{window.calls.push('duplicate:'+id);return true},onRename:async(id,name)=>{if(name==='retry')throw Error('Rename retry');window.calls.push('rename:'+name);return true},onDelete:async id=>{if(!window.allowDelete)throw Error('Delete retry');window.calls.push('delete:'+id);return true},onExport:async id=>{window.calls.push('export:'+id);return true},onKeepEditing:()=>document.querySelector('#save').focus(),onClose:()=>window.calls.push('close')})}</script><button id="save">Save workflow</button>`;
const server = http.createServer(async (req, res) => {
  const name = new URL(req.url, "http://localhost").pathname;
  if (name === "/")
    return res.writeHead(200, { "Content-Type": "text/html" }).end(html);
  const asset = name.slice(1);
  if (!["workflow-manager.js", "workflow-manager.css"].includes(asset))
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
  await wait("typeof spyderWorkflowManager === 'object'");
  await evaluate("launch()");
  await wait("document.querySelectorAll('.wm-row').length===25");
  assert.equal(
    await evaluate("document.querySelector('.wm-summary').textContent"),
    "80 workflows · 40 enabled · 40 disabled",
  );
  await evaluate(
    "(async()=>{window.loadCountBeforeClose=window.loadCalls;document.querySelector('[name=query]').value='closed';document.querySelector('[name=query]').dispatchEvent(new Event('input',{bubbles:true}));manager.close();await new Promise(r=>setTimeout(r,260))})()",
  );
  assert.equal(
    await evaluate("window.loadCalls===window.loadCountBeforeClose"),
    true,
  );
  await evaluate("launch()");
  await wait("document.querySelectorAll('.wm-row').length===25");
  await evaluate(
    "document.querySelector('[name=query]').value='old';document.querySelector('[name=query]').dispatchEvent(new Event('input',{bubbles:true}));setTimeout(()=>{document.querySelector('[name=query]').value='Workflow 7';document.querySelector('[name=query]').dispatchEvent(new Event('input',{bubbles:true}))},220)",
  );
  await wait(
    "document.querySelector('.wm-row strong')?.textContent==='Workflow 7'",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.wm-rows').textContent.includes('Workflow 7')",
    ),
    true,
  );
  await evaluate(
    "document.querySelector('[name=status]').value='enabled';document.querySelector('[name=status]').dispatchEvent(new Event('change',{bubbles:true}))",
  );
  await wait(
    "document.querySelector('.wm-row')===null || document.querySelector('.wm-row .wm-status.is-enabled')",
  );
  await evaluate(
    "document.querySelector('[name=query]').value='';document.querySelector('[name=query]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[name=status]').value='';document.querySelector('[name=status]').dispatchEvent(new Event('change',{bubbles:true}))",
  );
  await wait("document.querySelectorAll('.wm-row').length===25");
  await evaluate("document.querySelector('[data-next]').click()");
  await wait("document.querySelector('.wm-page').textContent==='Page 2 of 4'");
  await evaluate(
    "dirty=true;document.querySelector('[data-action=open]').click()",
  );
  assert.equal(
    await evaluate("document.querySelector('.wm-guard').hidden"),
    false,
  );
  await evaluate("document.querySelector('[data-keep]').click()");
  assert.equal(await evaluate("document.activeElement.id"), "save");
  await evaluate("launch()");
  await wait("document.querySelectorAll('.wm-row').length===25");
  await evaluate(
    "document.querySelector('[data-action=open]').click();document.querySelector('[data-discard]').click()",
  );
  await wait("window.calls.includes('open:wf-0')");
  assert.equal(await evaluate("!document.querySelector('dialog')"), true);
  assert.equal(await evaluate("document.activeElement.id"), "open");
  await evaluate("launch()");
  await wait("document.querySelectorAll('.wm-row').length===25");
  await evaluate(
    "document.querySelector('[data-action=rename]').click();document.querySelector('.wm-rename input').value='retry';document.querySelector('.wm-rename').requestSubmit()",
  );
  await wait(
    "document.querySelector('.wm-error').textContent==='Rename retry'",
  );
  await evaluate(
    "document.querySelector('.wm-rename input').value='Renamed';document.querySelector('.wm-rename').requestSubmit()",
  );
  await wait(
    "document.querySelector('[data-action=rename]') && !document.querySelector('.wm-rename')",
  );
  await evaluate("document.querySelector('[data-action=delete]').click()");
  assert.equal(
    await evaluate("document.querySelector('.wm-delete-confirm').hidden"),
    false,
  );
  await evaluate("document.querySelector('[data-confirm-delete]').click()");
  await wait(
    "document.querySelector('.wm-error').textContent==='Delete retry'",
  );
  await evaluate(
    "window.allowDelete=true;document.querySelector('[data-action=delete]').click();document.querySelector('[data-confirm-delete]').click()",
  );
  await wait("window.calls.includes('delete:wf-0')");
  await evaluate("manager.close()");
  assert.equal(await evaluate("document.activeElement.id"), "open");
  await evaluate("launch();document.querySelector('.wm-close').click()");
  await wait("!document.querySelector('dialog')");
  for (const size of [
    { width: 320, height: 480 },
    { width: 640, height: 340 },
  ]) {
    await command(
      "Emulation.setDeviceMetricsOverride",
      { ...size, deviceScaleFactor: 1, mobile: true },
      sessionId,
    );
    await evaluate("launch()");
    await wait("document.querySelector('.wm-row')");
    assert.equal(
      await evaluate("document.documentElement.scrollWidth<=innerWidth"),
      true,
    );
    assert.equal(
      await evaluate(
        "document.querySelector('dialog').getBoundingClientRect().height<=innerHeight",
      ),
      true,
    );
    assert.ok(
      await evaluate(
        "document.querySelector('.wm-list').getBoundingClientRect().height>35",
      ),
    );
    await evaluate("manager.close()");
  }
  await command("Emulation.clearDeviceMetricsOverride", {}, sessionId);
  await evaluate(
    "document.documentElement.style.setProperty('--surface','#202830');document.documentElement.style.setProperty('--ink','#f5f7f8');document.documentElement.style.setProperty('--muted','#bbc4cc');document.documentElement.style.setProperty('--border','#53616c');launch(true)",
  );
  await wait("document.querySelector('.wm-row')");
  assert.equal(
    await evaluate("getComputedStyle(document.querySelector('.wm-row')).color"),
    "rgb(245, 247, 248)",
  );
  assert.equal(
    await evaluate("document.querySelector('.wm-delete-confirm').hidden"),
    false,
  );
  assert.equal(
    await evaluate("document.querySelector('#wm-delete-title').textContent"),
    "Delete Workflow 0?",
  );
  await evaluate("manager.close()");
  await evaluate("dirty=false;launch()");
  await wait("document.querySelector('.wm-row')");
  await evaluate(
    "document.querySelector('[data-action=toggle]').click();document.querySelector('[data-action=toggle]').click()",
  );
  await wait(
    "document.querySelector('[data-action=toggle]').textContent==='Enable'",
  );
  assert.equal(await evaluate("toggleCalls"), 1);
  assert.match(
    await evaluate("document.querySelector('.wm-summary').textContent"),
    /39 enabled/,
  );
  await evaluate(
    "window.toggleFailure=true;document.querySelector('[data-action=toggle]').click()",
  );
  await wait(
    "document.querySelector('.wm-error').textContent==='Model conflict'",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('[data-action=toggle]').textContent",
    ),
    "Enable",
  );
  await evaluate(
    "window.toggleFailure=false;window.needMotion=true;document.querySelector('[data-action=toggle]').click()",
  );
  await wait("!document.querySelector('.wm-toggle-confirm').hidden");
  assert.match(
    await evaluate(
      "document.querySelector('.wm-toggle-confirm ul').textContent",
    ),
    /motion analysis will be disabled/,
  );
  await evaluate("document.querySelector('[data-cancel-toggle]').click()");
  await wait(
    "document.querySelector('.wm-shell').getAttribute('aria-busy')==='false'",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('[data-action=toggle]').textContent",
    ),
    "Enable",
  );
  await evaluate("document.querySelector('[data-action=toggle]').click()");
  await wait("!document.querySelector('.wm-toggle-confirm').hidden");
  await evaluate("document.querySelector('[data-confirm-toggle]').click()");
  await wait(
    "document.querySelector('[data-action=toggle]').textContent==='Disable'",
  );
  await evaluate("manager.close();window.demo=true;launch()");
  await wait("document.querySelector('.wm-row')");
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('[data-action=toggle]')].every(button=>button.disabled)",
    ),
    true,
  );
  await evaluate("manager.close();window.demo=false");
  console.log("Workflow manager browser checks passed.");
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
