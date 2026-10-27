// Complete backup controls regression. Run: node tests/complete-backup-browser.mjs <showcase-dir>
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
  path.join(os.tmpdir(), "spyder-complete-backup-browser-"),
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

  await command("Page.enable", {}, sessionId);
  await command(
    "Page.navigate",
    { url: `http://127.0.0.1:${server.address().port}/#system` },
    sessionId,
  );
  await until("!!document.querySelector('#complete-backup')", 300);
  assert.equal(await evaluate("document.querySelector('[data-system-tab=overview]').getAttribute('aria-selected')"), "true", "System starts with health overview");
  assert.equal(await evaluate("document.querySelector('[data-backup-task=restore]').open"), false, "Restore starts collapsed");
  await evaluate("document.querySelector('[data-system-tab=overview]').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))");
  assert.equal(await evaluate("document.activeElement.dataset.systemTab"), "diagnostics", "End selects and focuses the last System tab");
  await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))");
  assert.equal(await evaluate("document.activeElement.dataset.systemTab"), "overview", "Home returns to overview");
  assert.equal(
    await evaluate(
      "document.querySelector('#complete-backup input[type=checkbox]').checked",
    ),
    false,
  );
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('#complete-backup button')].find(b=>b.textContent==='Create complete backup').disabled",
    ),
    true,
  );
  assert.equal(
    networkPaths.some((p) => p.startsWith("/api/")),
    false,
    "showcase never calls native backup APIs",
  );
  await evaluate(`(()=>{
    window.backupErrors=[];window.addEventListener('error',e=>backupErrors.push(e.message));
    window.backupRequests=[];window.pickerRequests=[];window.cancelNextPick=false;window.mockBackupJob={state:'idle'};window.spyderShowcase=false;
    const original=window.fetch;window.fetch=async(url,options={})=>{
      if(String(url).startsWith('/api/system/backup/jobs')){
        if(options.method==='POST'){
          const body=JSON.parse(options.body);backupRequests.push({path:String(url),body});
          if(String(url).endsWith('/cancel'))mockBackupJob={state:'error',operation:'create',error:'Cancelled'};
          else mockBackupJob={id:'one',operation:body.operation,state:'completed',result:body.operation==='restore'?{config_path:'C:/Restored/appdata/config.json'}:{path:body.path,files:5,total_bytes:100,warnings:[]}};
        }
        return new Response(JSON.stringify(mockBackupJob),{headers:{'Content-Type':'application/json'}});
      }
      if(String(url)==='/api/system/backup/picker'){
        const body=JSON.parse(options.body);pickerRequests.push(body.kind);
        if(cancelNextPick){cancelNextPick=false;return new Response(JSON.stringify({path:null,cancelled:true}));}
        return new Response(JSON.stringify({path:body.kind==='restore_parent'?'C:/Restores/SpyDER-Restored':'C:/Backups/full.zip',cancelled:false}));
      }
      if(String(url)==='/api/system/health')return new Response(JSON.stringify({state:'healthy',issues:[],running_cameras:0,camera_count:0,recording_state:'idle',checked_at:new Date().toISOString()}));
      return original(url,options);
    };
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  })()`);
  await until(
    "!!document.querySelector('[data-backup-pick=save_archive]:not(:disabled)')",
  );
  await evaluate("document.querySelector('[data-system-tab=storage]').click(); document.querySelector('#allowance-limit').value='7.5';document.querySelector('#allowance-action').value='delete';document.querySelector('#allowance-action').dispatchEvent(new Event('change'));document.querySelector('[data-system-tab=diagnostics]').click();document.querySelector('[data-system-tab=storage]').click()");
  assert.equal(await evaluate("document.querySelector('#allowance-limit').value"), "7.5", "Section switching preserves allowance drafts");
  assert.match(await evaluate("document.querySelector('#allowance-policy-help').textContent"), /Permanently deletes.*event attachments/, "Deletion consequences appear beside policy selection");
  assert.equal(
    await evaluate(
      "document.querySelector('[data-backup-path=save_archive]').readOnly",
    ),
    true,
  );
  await evaluate("document.querySelector('[data-system-tab=backups]').click()");
  await evaluate(
    "document.querySelector('[data-backup-pick=save_archive]').click()",
  );
  await until(
    "document.querySelector('[data-backup-path=save_archive]').value==='C:/Backups/full.zip'",
  );
  await evaluate(
    "window.cancelNextPick=true;document.querySelector('[data-backup-pick=save_archive]').click()",
  );
  await until("pickerRequests.length===2");
  await until(
    "document.querySelector('#backup-path-save_archive-help').textContent.includes('cancelled')",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('[data-backup-path=save_archive]').value",
    ),
    "C:/Backups/full.zip",
  );
  await evaluate("document.querySelector('[data-backup-create]').click()");
  await until("backupRequests.length===1");
  assert.equal(await evaluate("backupRequests[0].body.include_media"), false);
  assert.equal(
    await evaluate("backupRequests[0].body.browser_data.version"),
    1,
  );
  await evaluate("document.querySelector('[data-backup-task=restore]').open=true");
  await evaluate(
    "document.querySelector('[data-backup-pick=open_archive]').click()",
  );
  await until(
    "backupRequests.length===2 && document.querySelector('#backup-path-open_archive-help').textContent.includes('verified')",
  );
  await evaluate(
    "document.querySelector('[data-backup-pick=restore_parent]').click()",
  );
  await until(
    "document.querySelector('[data-backup-path=restore_parent]').value==='C:/Restores/SpyDER-Restored'",
  );
  await evaluate(
    "document.querySelectorAll('#complete-backup input[type=checkbox]')[2].click()",
  );
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('#complete-backup button')].find(b=>b.textContent==='Restore to new folder').disabled",
    ),
    false,
  );
  await evaluate(
    "[...document.querySelectorAll('#complete-backup button')].find(b=>b.textContent==='Restore to new folder').click()",
  );
  await until("backupRequests.length===3");
  assert.equal(
    await evaluate("backupRequests[2].body.destination"),
    "C:/Restores/SpyDER-Restored",
  );
  assert.match(
    await evaluate("document.querySelector('#complete-backup').textContent"),
    /Stop SpyDER before starting/,
  );
  await command("Page.bringToFront", {}, sessionId);
  await evaluate("document.querySelector('.backup-advanced summary').focus()");
  await command(
    "Input.dispatchKeyEvent",
    {
      type: "keyDown",
      text: "\r",
      unmodifiedText: "\r",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    },
    sessionId,
  );
  await command(
    "Input.dispatchKeyEvent",
    { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    sessionId,
  );

  await until(
    "!document.querySelector('[data-backup-path=save_archive]').readOnly",
  );
  await evaluate("document.querySelector('[data-backup-advanced]').open=false");
  await until(
    "document.querySelector('[data-backup-path=save_archive]').readOnly",
  );
  for (const theme of ["light", "dark"]) {
    await evaluate(
      `document.documentElement.dataset.theme=${JSON.stringify(theme)}`,
    );
    for (const [width, height] of [
      [320, 640],
      [390, 700],
      [768, 1024],
      [1024, 768],
      [1280, 480],
    ]) {
      await command(
        "Emulation.setDeviceMetricsOverride",
        { width, height, deviceScaleFactor: 1, mobile: false },
        sessionId,
      );
      assert.equal(
        await evaluate(
          "document.querySelector('#complete-backup').scrollWidth<=document.querySelector('#complete-backup').clientWidth+1",
        ),
        true,
        `${theme} ${width}x${height} backup overflow`,
      );
      assert.equal(await evaluate(`(() => {
        const tabs=[...document.querySelectorAll('[data-system-tab]')];
        const fits=tabs.every(tab=>{tab.click();return document.documentElement.scrollWidth<=innerWidth+1 && tab.getBoundingClientRect().height>=44});
        document.querySelector('[data-system-tab=backups]').click();
        return fits;
      })()`), true, `${theme} ${width} all System sections fit and tabs meet touch sizes`);
      assert.equal(
        await evaluate(
          "[...document.querySelectorAll('[data-backup-pick]')].filter(b=>b.checkVisibility()).every(b=>b.getBoundingClientRect().height>=44)",
        ),
        true,
        "browse touch targets",
      );
      assert.equal(
        await evaluate(
          "[...document.querySelectorAll('[data-backup-path]')].every(input=>input.labels.length>0)",
        ),
        true,
        "associated field labels",
      );
      assert.equal(
        await evaluate(`(()=>{
        const rgb=value=>value.match(/[0-9.]+/g).slice(0,3).map(Number);
        const lum=c=>c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
        const card=document.querySelector('.backup-task-card'), label=card.querySelector('.backup-path-field > label');
        const values=[lum(rgb(getComputedStyle(label).color)),lum(rgb(getComputedStyle(card).backgroundColor))].sort((a,b)=>b-a);
        return (values[0]+.05)/(values[1]+.05)>=4.5;
      })()`),
        true,
        "label contrast",
      );
    }
  }
  for (const theme of ["light", "dark"]) {
    await command(
      "Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
    await evaluate(
      `document.documentElement.dataset.theme=${JSON.stringify(theme)};document.querySelector('#complete-backup').scrollIntoView({block:'start'})`,
    );
    const shot = await command(
      "Page.captureScreenshot",
      { format: "png" },
      sessionId,
    );
    await writeFile(
      path.join(assets, `backup-picker-${theme}.png`),
      Buffer.from(shot.data, "base64"),
    );
  }
  assert.deepEqual(await evaluate("backupErrors"), []);
  console.log(
    "PASS: browse-first backup flow, cancellation preserves selection, automatic verification, new restore folder, responsive layout, showcase isolation",
  );
} finally {
  socket?.close();
  chrome.kill();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await delay(200);
  assert.equal(path.dirname(path.resolve(profile)), path.resolve(os.tmpdir()));
  assert.ok(
    path.basename(profile).startsWith("spyder-complete-backup-browser-"),
  );
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
