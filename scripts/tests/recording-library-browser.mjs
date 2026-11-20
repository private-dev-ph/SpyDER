// Static browser regression. Run: node scripts/tests/recording-library-browser.mjs <showcase-dir>
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
assert.ok(
  policy?.includes("connect-src 'none'"),
  "Showcase CSP must block network requests",
);
const paths = [];
const profile = await mkdtemp(
  path.join(os.tmpdir(), "spyder-recording-library-"),
);
const server = http.createServer(async (req, res) => {
  paths.push(req.url);
  const name =
    new URL(req.url, "http://localhost").pathname.slice(1) || "index.html";
  if (!/^[\w.-]+$/.test(name)) return res.writeHead(404).end();
  try {
    res.setHeader("Content-Security-Policy", policy);
    res.setHeader(
      "Content-Type",
      path.extname(name) === ".js"
        ? "text/javascript"
        : path.extname(name) === ".css"
          ? "text/css"
          : path.extname(name) === ".svg"
            ? "image/svg+xml"
            : "text/html",
    );
    res.end(await readFile(path.join(assets, name)));
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
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    message.error
      ? entry.reject(new Error(JSON.stringify(message.error)))
      : entry.resolve(message.result);
  };
  function command(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out: ${method}`));
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
  async function until(expression) {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await delay(100);
    }
    throw new Error("Timed out: " + expression);
  }
  await until("!!window.spyderRecordingLibrary && !!window.spyderEventLibrary");
  await evaluate("window.spyderShowcase=true;location.hash='recordings'");
  await until(
    "document.querySelector('#media-library .recording-library-controls')",
  );
  await evaluate(
    `window.spyder.request=()=>Promise.reject(new Error('Unexpected API request'));const host=document.createElement('div');host.id='recording-test';document.querySelector('#media-library').append(host);window.recordingTest=spyderRecordingLibrary.mount(host,[]);window.recordingItems=Array.from({length:53},(_,i)=>({id:'item-'+i,kind:i%4===0?'capture':'recording',filename:(i%4===0?'capture-':'recording-')+String(i).padStart(2,'0')+(i%4===0?'.jpg':'.mp4'),created_at:new Date(Date.UTC(2026,9,1,0,i)).toISOString(),size_bytes:(i+1)*1024,duration_seconds:i,url:'blob:local/item-'+i,thumbnail_url:'blob:local/thumb-'+i}));recordingTest.setItems(recordingItems);`,
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('#recording-test .recording-library-item').length",
    ),
    20,
  );
  assert.equal(
    await evaluate("document.querySelectorAll('#recording-test img').length"),
    20,
    "Only current page thumbnails render",
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('#recording-test .recording-thumbnail:not(:disabled)').length",
    ),
    20,
    "Existing media viewer buttons stay available",
  );
  await evaluate(
    "document.querySelector('#recording-test input[type=search]').value='recording-';document.querySelector('#recording-test input[type=search]').dispatchEvent(new Event('input',{bubbles:true}))",
  );
  assert.ok(
    await evaluate(
      "[...document.querySelectorAll('#recording-test .recording-library-item')].every(row=>row.textContent.includes('recording-'))",
    ),
  );
  await evaluate(
    "(() => {const selects=document.querySelectorAll('#recording-test select');selects[0].value='recording';selects[0].dispatchEvent(new Event('change',{bubbles:true}));selects[2].value='name';selects[2].dispatchEvent(new Event('change',{bubbles:true}))})()",
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('#recording-test .recording-library-item').length",
    ),
    20,
  );
  await evaluate(
    "(() => {const selects=document.querySelectorAll('#recording-test select');selects[4].value='day';selects[4].dispatchEvent(new Event('change',{bubbles:true}))})()",
  );
  assert.ok(
    await evaluate(
      "document.querySelectorAll('#recording-test .recording-library-group').length>0",
    ),
    "Date grouping must render headings",
  );
  await evaluate(
    "(() => {const selects=document.querySelectorAll('#recording-test select');selects[4].value='';selects[4].dispatchEvent(new Event('change',{bubbles:true}))})()",
  );
  await evaluate(
    "document.querySelector('#recording-test .recording-library-pagination button:last-child').click()",
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('#recording-test .recording-library-item').length",
    ),
    19,
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#recording-test .recording-library-pagination span').textContent",
    ),
    "Page 2 of 2 · 20 per page",
  );
  await evaluate(
    "(() => {const search=document.querySelector('#recording-test input[type=search]');search.value='';search.dispatchEvent(new Event('input',{bubbles:true}));const selects=document.querySelectorAll('#recording-test select');selects[0].value='';selects[0].dispatchEvent(new Event('change',{bubbles:true}));search.focus();window.recordingTest.setItems(window.recordingItems.slice(0,10))})()",
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('#recording-test .recording-library-item').length",
    ),
    10,
    "Changed item set clamps page and refreshes rows",
  );
  assert.equal(
    await evaluate(
      "document.activeElement===document.querySelector('#recording-test input[type=search]')",
    ),
    true,
    "Periodic item refresh must preserve search focus",
  );
  assert.equal(
    paths.some((url) => url.startsWith("/api/")),
    false,
    "Static library must make no API requests",
  );
  await evaluate(
    "window.previewTrigger=document.querySelector('#recording-test [data-media-id=\"item-1\"] .recording-thumbnail');previewTrigger.focus();previewTrigger.click()",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.media-viewer[open] video')?.controls",
    ),
    true,
    "Recording thumbnail opens the shared video player",
  );
  await evaluate(
    "document.querySelector('.media-viewer [aria-label=\"Close media viewer\"]').click()",
  );
  assert.equal(
    await evaluate("document.activeElement===previewTrigger"),
    true,
    "Closing media returns focus to its thumbnail",
  );
  await evaluate(
    `(() => {window.spyderShowcase=false;const root=document.createElement('div');root.id='mock-native-library';document.querySelector('#media-library').append(root);window.mockMedia={id:'mock',kind:'recording',filename:'mock.mp4',created_at:new Date().toISOString(),size_bytes:100,duration_seconds:5,keep_forever:false,url:'blob:local/mock'};window.mockDelete={...mockMedia,id:'delete-check',filename:'delete-check.mp4'};window.mockCalls=0;window.mockReads=0;window.mockStatus=null;window.mockLibrary=spyderRecordingLibrary.mount(root,[mockMedia,mockDelete],{request:async(path)=>{mockCalls++;if(mockCalls===1)throw new Error('Mock keep failed');mockMedia={...mockMedia,keep_forever:true};return mockMedia},readStatus:async()=>{mockReads++;if(mockReads===1)throw new Error('Mock status failed');return{items:[mockMedia,mockDelete]}},onUpdate:(data)=>mockStatus=data});})()`,
  );
  await evaluate(
    "document.querySelector('#mock-native-library button[aria-pressed=false]').click();new Promise(resolve=>setTimeout(resolve,0))",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#mock-native-library .recording-library + p')?.textContent==='Mock keep failed' || [...document.querySelectorAll('#mock-native-library p')].some(p=>p.textContent==='Mock keep failed')",
    ),
    true,
    "Failed protection request must be visible",
  );
  await evaluate(
    "document.querySelector('#mock-native-library button[aria-pressed=false]').click();new Promise(resolve=>setTimeout(resolve,0))",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#mock-native-library button[aria-pressed=true]')!==null && mockCalls===2 && [...document.querySelectorAll('#mock-native-library p')].some(p=>p.textContent==='Mock status failed')",
    ),
    true,
    "A failed status refresh must remain visible after successful protection",
  );
  await evaluate(
    "mockLibrary.refresh();new Promise(resolve=>setTimeout(resolve,0))",
  );
  assert.equal(
    await evaluate(
      "mockCalls===2 && mockReads===2 && mockStatus.items.length===2 && [...document.querySelectorAll('#mock-native-library p')].every(p=>p.textContent!=='Mock status failed')",
    ),
    true,
    "Retry refresh updates workspace state and clears error",
  );
  for (const width of [320, 390, 960]) {
    await command(
      "Emulation.setDeviceMetricsOverride",
      { width, height: 720, deviceScaleFactor: 1, mobile: width < 500 },
      sessionId,
    );
    const overflow = await evaluate(
      "(() => {const list=document.querySelector('#mock-native-library .recording-library-list');return list.scrollWidth>list.clientWidth+1})()",
    );
    assert.equal(
      overflow,
      false,
      `${width}px native protection/delete actions stay within library`,
    );
  }
  await evaluate(
    "document.querySelector('#mock-native-library [data-media-id=delete-check] button.recording-delete').click()",
  );
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('#mock-native-library button')].some(button=>button.textContent==='Delete permanently') && mockCalls===2",
    ),
    true,
    "Delete must require explicit confirmation",
  );
  await evaluate(
    "[...document.querySelectorAll('#mock-native-library button')].find(button=>button.textContent==='Cancel').click()",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#mock-native-library [data-media-id=delete-check] button.recording-delete').hidden===false",
    ),
    true,
    "Cancel restores delete control",
  );
  assert.equal(
    await evaluate(
      "document.activeElement===document.querySelector('#mock-native-library [data-media-id=delete-check] button.recording-delete')",
    ),
    true,
    "Cancel returns keyboard focus",
  );
  await evaluate(`mockLibrary.unmount();window.deleteAttempts=0;window.deleteLibrary=spyderRecordingLibrary.mount(document.querySelector('#mock-native-library'),[mockDelete],{
    request:async(path)=>{if(!path.endsWith('/delete'))throw new Error('Unexpected action');if(++deleteAttempts===1)throw new Error('Mock delete failed');return{}},
    readStatus:async()=>({items:[]})
  });document.querySelector('#mock-native-library button.recording-delete').click();[...document.querySelectorAll('#mock-native-library button')].find(b=>b.textContent==='Delete permanently').click();new Promise(resolve=>setTimeout(resolve,0))`);
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('#mock-native-library p')].some(p=>!p.hidden&&p.textContent==='Mock delete failed')",
    ),
    true,
    "Failed deletion remains visible",
  );
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('#mock-native-library button')].find(b=>b.textContent==='Delete permanently').disabled",
    ),
    false,
    "Failed deletion permits retry",
  );
  await evaluate(
    "[...document.querySelectorAll('#mock-native-library button')].find(b=>b.textContent==='Delete permanently').click();new Promise(resolve=>setTimeout(resolve,0))",
  );
  assert.equal(
    await evaluate(
      "deleteAttempts===2 && document.querySelectorAll('#mock-native-library .recording-library-item').length===0",
    ),
    true,
    "Confirmed deletion removes only mocked clip",
  );
  await evaluate(
    "deleteLibrary.unmount();window.spyderShowcase=true;window.recordingTest=spyderRecordingLibrary.mount(document.querySelector('#recording-test'),window.recordingItems.slice(0,10))",
  );
  for (const [width, height] of [
    [1280, 960],
    [1280, 320],
    [960, 720],
    [390, 844],
    [320, 320],
  ]) {
    await command(
      "Emulation.setDeviceMetricsOverride",
      { width, height, deviceScaleFactor: 1, mobile: width <= 500 },
      sessionId,
    );
    for (const theme of ["light", "dark"]) {
      const layout = await evaluate(
        `(() => {document.documentElement.dataset.theme=${JSON.stringify(theme)};const page=document.querySelector('#workspace-page');const list=document.querySelector('#recording-test .recording-library-list');return {overflow:document.documentElement.scrollWidth>innerWidth+1||page.scrollWidth>page.clientWidth+1||list.scrollWidth>list.clientWidth+1,rows:[...list.querySelectorAll('.recording-library-item')].every(row=>row.getBoundingClientRect().right<=list.getBoundingClientRect().right+1)}})()`,
      );
      assert.equal(
        layout.overflow,
        false,
        `${width}px ${theme} recordings page must not overflow`,
      );
      assert.equal(
        layout.rows,
        true,
        `${width}px ${theme} recording rows must stay within library`,
      );
      if (
        (width === 1280 && height === 960 && theme === "light") ||
        (width === 390 && theme === "dark")
      ) {
        await evaluate(
          "document.querySelector('#media-library').scrollIntoView({block:'start'});window.scrollBy(0,-90)",
        );
        await delay(100);
        const shot = await command(
          "Page.captureScreenshot",
          { format: "png" },
          sessionId,
        );
        await writeFile(
          path.join(assets, "..", `recording-library-${width}.png`),
          Buffer.from(shot.data, "base64"),
        );
      }
    }
  }
  console.log(
    "PASS: static CSP, 53-item paging, current-page thumbnails, search, filters, sort, refresh clamp, no API requests.",
  );
} finally {
  socket?.close();
  chrome.kill();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await delay(200);
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
